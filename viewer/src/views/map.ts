/**
 * 4. 화면 지도 — 화면 하나 = 점, 같은 화면(고른 규칙에서 같은 키)끼리 선으로 잇는다.
 * 점에 마우스를 올리면 어떤 화면인지 미리 보기, 누르면 오른쪽에 화면 전체.
 * 앱(pkg)마다 색이 다르고, 혼자인 점(같은 화면이 하나뿐)은 속이 빈 원.
 * 규칙을 바꾸면 묶음이 다시 계산된다 → 지문이 얼마나 갈리는지 한눈에 본다.
 */
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { api } from "../api.ts";
import { fpHue, h, s, time } from "../dom.ts";
import { RULES, isActionable, ruleKey, type RuleId } from "../fp-rules.ts";
import { every } from "../subscribe.ts";
import type { Device, ScreenDocument, ScreenSummary } from "../types.ts";
import { renderScreen } from "./screen-panel.ts";

const REFRESH_MS = 10_000;
const MAX_PER_DEVICE = 500;
const CONCURRENCY = 8;
const R = 5;

/** 화면 원본은 바뀌지 않으므로 페이지를 옮겨 다녀도 다시 받지 않는다 */
const docCache = new Map<string, ScreenDocument>();

interface Dot extends SimulationNodeDatum {
  id: string;
  doc: ScreenDocument;
  key: string;
  group: Dot[];
}
type Link = SimulationLinkDatum<Dot> & { source: Dot; target: Dot };

const labelOf = (doc: ScreenDocument): string[] =>
  doc.screen.nodes
    .map((n) => n.t ?? n.d ?? "")
    .filter(Boolean)
    .slice(0, 4);

function wire(doc: ScreenDocument, width: number): SVGSVGElement {
  const { width: w, height: hgt, nodes } = doc.screen;
  const k = width / w;
  return s(
    "svg",
    { class: "wire", viewBox: `0 0 ${width} ${Math.round(hgt * k)}` },
    nodes
      .filter((n) => n.b)
      .map((n) => {
        const [l, t, r, b] = n.b ?? [0, 0, 0, 0];
        return s("rect", {
          x: l * k,
          y: t * k,
          width: Math.max(1, (r - l) * k),
          height: Math.max(1, (b - t) * k),
          class: isActionable(n) ? "act" : "",
        });
      }),
  );
}

export function mapView(root: HTMLElement): () => void {
  let rule: RuleId = "v1";
  let deviceFilter = "";
  let devices: Device[] = [];
  let summaries: ScreenSummary[] = [];
  let dots = new Map<string, Dot>();
  let links: Link[] = [];
  let sim: Simulation<Dot, Link> | undefined;
  let selected: Dot | undefined;
  let disposed = false;
  let loading = false;
  let loaded = false;
  let lastGroups = new Map<string, Dot[]>();
  let lastPkgs: string[] = [];
  let view = { x: 0, y: 0, w: 800, h: 600 };

  const status = h("span", { class: "muted small" }, "불러오는 중…");
  const stats = h("div", { class: "map-stats" });
  const ruleSeg = h(
    "div",
    { class: "seg", role: "group", "aria-label": "같은 화면 규칙" },
    RULES.map((r) =>
      h(
        "button",
        {
          class: r.id === rule ? "on" : "",
          title: r.hint,
          onclick: (e: MouseEvent) => {
            rule = r.id;
            for (const b of ruleSeg.querySelectorAll("button"))
              b.classList.toggle("on", b === e.currentTarget);
            rebuild(true);
          },
        },
        r.label,
      ),
    ),
  );
  const deviceSelect = h("select", {
    onchange: (e: Event) => {
      deviceFilter = (e.target as HTMLSelectElement).value;
      rebuild(true);
    },
  });

  const linkLayer = s("g", { class: "links" });
  const dotLayer = s("g", { class: "dots" });
  const labelLayer = s("g", { class: "labels" });
  const svg = s("svg", { class: "map" }, linkLayer, dotLayer, labelLayer);
  const tip = h("div", { class: "map-tip", hidden: true });
  const canvas = h("div", { class: "map-canvas" }, svg, tip);
  const panel = h("div", { class: "screen-panel map-panel" });

  root.append(
    h(
      "section",
      { class: "page map-page" },
      h("header", { class: "page-head" }, h("h1", {}, "화면 지도"), status),
      h(
        "div",
        { class: "toolbar map-toolbar" },
        h("span", { class: "muted small" }, "같은 화면 규칙"),
        ruleSeg,
        deviceSelect,
        stats,
      ),
      h(
        "p",
        { class: "muted small hint" },
        "점 하나 = 화면 한 번. 같은 화면끼리 선으로 이어요. 속이 빈 점은 같은 화면이 하나뿐인 것(갈렸을 수 있음). 휠로 확대, 끌어서 이동.",
      ),
      h("div", { class: "map-split" }, canvas, panel),
    ),
  );

  // ---------------------------------------------------------------------------
  // 데이터
  // ---------------------------------------------------------------------------

  async function listAll(deviceId: string): Promise<ScreenSummary[]> {
    const out: ScreenSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await api.screens(deviceId, {
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      out.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor && out.length < MAX_PER_DEVICE);
    return out;
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      devices = (await api.devices()).items;
      renderDeviceSelect();
      summaries = (await Promise.all(devices.map((d) => listAll(d.deviceId)))).flat();
      const missing = summaries.filter((x) => !docCache.has(x.screenId));
      let done = 0;
      const queue = [...missing];
      const worker = async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          try {
            docCache.set(next.screenId, await api.screen(next.deviceId, next.screenId));
          } catch {
            // 수명 주기로 지워진 화면 등: 건너뛴다
          }
          done += 1;
          if (done % 20 === 0) status.textContent = `화면 불러오는 중 ${done}/${missing.length}`;
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      if (disposed) return;
      status.textContent = `${summaries.length}개 화면 · ${REFRESH_MS / 1000}초마다 새 화면 확인`;
      status.className = "muted small";
      // 새 화면이 있을 때만 다시 배치 (기존 점 자리는 유지)
      if (!loaded || missing.length > 0) rebuild(!loaded);
      loaded = true;
    } catch (error) {
      status.textContent = `불러오기 실패: ${(error as Error).message}`;
      status.className = "error small";
    } finally {
      loading = false;
    }
  }

  function renderDeviceSelect() {
    deviceSelect.replaceChildren(
      h("option", { value: "" }, `기기 전체 (${devices.length}대)`),
      ...devices.map((d) =>
        h(
          "option",
          { value: d.deviceId, selected: d.deviceId === deviceFilter },
          d.label ?? d.deviceId.slice(0, 8),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // 그래프
  // ---------------------------------------------------------------------------

  /** fit: 배치를 처음부터 다시 하고 화면에 맞춘다 (규칙·기기를 바꿀 때) */
  function rebuild(fit: boolean) {
    const docs = summaries
      .filter((x) => !deviceFilter || x.deviceId === deviceFilter)
      .map((x) => docCache.get(x.screenId))
      .filter((d): d is ScreenDocument => d !== undefined)
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));

    const next = new Map<string, Dot>();
    const groups = new Map<string, Dot[]>();
    for (const doc of docs) {
      const old = dots.get(doc.screenId);
      const dot: Dot = fit
        ? { id: doc.screenId, doc, key: "", group: [] }
        : (old ?? { id: doc.screenId, doc, key: "", group: [] });
      dot.key = ruleKey(doc, rule);
      const group = groups.get(dot.key) ?? [];
      group.push(dot);
      groups.set(dot.key, group);
      dot.group = group;
      next.set(dot.id, dot);
    }
    dots = next;
    links = [...groups.values()].flatMap((g) =>
      g.slice(1).map((dot, i) => ({ source: g[i] ?? dot, target: dot })),
    );

    // 앱마다 자리: 화면이 많은 앱부터 해바라기 나선으로
    const pkgCount = new Map<string, number>();
    for (const d of dots.values()) pkgCount.set(d.doc.pkg, (pkgCount.get(d.doc.pkg) ?? 0) + 1);
    const pkgs = [...pkgCount.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
    const anchor = new Map<string, { x: number; y: number }>();
    pkgs.forEach((p, i) => {
      const r = 140 * Math.sqrt(i);
      const a = i * 2.39996;
      anchor.set(p, { x: r * Math.cos(a), y: r * Math.sin(a) });
    });
    for (const d of dots.values()) {
      if (d.x === undefined) {
        const a = anchor.get(d.doc.pkg) ?? { x: 0, y: 0 };
        d.x = a.x + (Math.random() - 0.5) * 40;
        d.y = a.y + (Math.random() - 0.5) * 40;
      }
    }

    sim?.stop();
    sim = forceSimulation<Dot, Link>([...dots.values()])
      .force("link", forceLink<Dot, Link>(links).distance(10).strength(0.9))
      .force("charge", forceManyBody<Dot>().strength(-14).distanceMax(160))
      .force("collide", forceCollide<Dot>(R + 1.5))
      .force("x", forceX<Dot>((d) => anchor.get(d.doc.pkg)?.x ?? 0).strength(0.07))
      .force("y", forceY<Dot>((d) => anchor.get(d.doc.pkg)?.y ?? 0).strength(0.07))
      .stop();
    sim.alpha(fit ? 1 : 0.3);
    for (let i = 0; i < (fit ? 300 : 120); i++) sim.tick();

    draw(pkgs);
    if (fit) fitView();
    lastGroups = groups;
    lastPkgs = pkgs;
    renderStats(groups, pkgs);
    if (selected && !dots.has(selected.id)) selected = undefined;
    if (selected) selected = dots.get(selected.id);
    if (!selected) renderOverview(groups, pkgs);
  }

  function draw(pkgs: string[]) {
    linkLayer.replaceChildren(
      ...links.map((l) =>
        s("line", {
          x1: l.source.x ?? 0,
          y1: l.source.y ?? 0,
          x2: l.target.x ?? 0,
          y2: l.target.y ?? 0,
          style: `--h:${fpHue(l.source.doc.pkg)}`,
          "data-key": l.source.key,
        }),
      ),
    );
    dotLayer.replaceChildren(
      ...[...dots.values()].map((d) =>
        s("circle", {
          cx: d.x ?? 0,
          cy: d.y ?? 0,
          r: R,
          class: [
            d.group.length === 1 ? "alone" : "",
            d.doc.guideType ? "guide" : "",
            selected?.id === d.id ? "selected" : "",
          ].join(" "),
          style: `--h:${fpHue(d.doc.pkg)}`,
          "data-id": d.id,
        }),
      ),
    );
    // 앱 이름: 그 앱 점들의 위쪽
    labelLayer.replaceChildren(
      ...pkgs.map((p) => {
        const mine = [...dots.values()].filter((d) => d.doc.pkg === p);
        const cx = mine.reduce((a, d) => a + (d.x ?? 0), 0) / mine.length;
        const top = Math.min(...mine.map((d) => d.y ?? 0));
        return s(
          "text",
          { x: cx, y: top - 12, style: `--h:${fpHue(p)}` },
          p.split(".").slice(-2).join("."),
        );
      }),
    );
  }

  function renderStats(groups: Map<string, Dot[]>, pkgs: string[]) {
    const alone = [...groups.values()].filter((g) => g.length === 1).length;
    stats.replaceChildren(
      h("span", {}, "화면 ", h("b", {}, dots.size)),
      h("span", {}, "같은 화면 묶음 ", h("b", {}, groups.size)),
      h("span", {}, "혼자인 점 ", h("b", {}, alone)),
      h("span", {}, "앱 ", h("b", {}, pkgs.length)),
    );
  }

  /** 아무 점도 고르지 않았을 때 오른쪽: 앱별 화면·묶음 수 */
  function renderOverview(groups: Map<string, Dot[]>, pkgs: string[]) {
    const byPkg = pkgs.map((p) => {
      const gs = [...groups.values()].filter((g) => g[0]?.doc.pkg === p);
      return {
        pkg: p,
        screens: gs.reduce((a, g) => a + g.length, 0),
        groups: gs.length,
        alone: gs.filter((g) => g.length === 1).length,
      };
    });
    panel.replaceChildren(
      h("h2", { class: "small-title" }, "앱별"),
      h("p", { class: "muted small" }, "점을 누르면 그 화면을 여기서 크게 봐요."),
      h(
        "table",
        { class: "pkg-table" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", {}, "앱"),
            h("th", { class: "num" }, "화면"),
            h("th", { class: "num" }, "묶음"),
            h("th", { class: "num" }, "혼자"),
          ),
        ),
        h(
          "tbody",
          {},
          byPkg.map((x) =>
            h(
              "tr",
              {
                onmouseenter: () => highlightPkg(x.pkg),
                onmouseleave: () => highlightPkg(undefined),
              },
              h(
                "td",
                { class: "pkg-cell" },
                h("span", { class: "swatch", style: `--h:${fpHue(x.pkg)}` }),
                x.pkg,
              ),
              h("td", { class: "num" }, x.screens),
              h("td", { class: "num" }, x.groups),
              h("td", { class: "num" }, x.alone),
            ),
          ),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // 상호작용
  // ---------------------------------------------------------------------------

  const deviceName = (id: string) => {
    const d = devices.find((x) => x.deviceId === id);
    return d?.label ?? id.slice(0, 8);
  };

  function highlight(key: string | undefined) {
    svg.classList.toggle("focus", key !== undefined);
    for (const el of dotLayer.querySelectorAll<SVGCircleElement>("circle")) {
      const d = dots.get(el.dataset.id ?? "");
      el.classList.toggle("hl", key !== undefined && d?.key === key);
    }
    for (const el of linkLayer.querySelectorAll<SVGLineElement>("line")) {
      el.classList.toggle("hl", key !== undefined && el.dataset.key === key);
    }
  }

  function highlightPkg(pkg: string | undefined) {
    svg.classList.toggle("focus", pkg !== undefined);
    for (const el of dotLayer.querySelectorAll<SVGCircleElement>("circle")) {
      el.classList.toggle(
        "hl",
        pkg !== undefined && dots.get(el.dataset.id ?? "")?.doc.pkg === pkg,
      );
    }
  }

  function showTip(dot: Dot, event: MouseEvent) {
    const { doc } = dot;
    tip.replaceChildren(
      h(
        "div",
        { class: "tip-head" },
        h("span", { class: "swatch", style: `--h:${fpHue(doc.pkg)}` }),
        h("b", {}, doc.pkg),
      ),
      h(
        "div",
        { class: "muted small" },
        `${deviceName(doc.deviceId)} · ${time(doc.capturedAt)} · 노드 ${doc.screen.nodes.length}개`,
      ),
      h(
        "div",
        { class: "small" },
        dot.group.length > 1
          ? `같은 화면 ${dot.group.length}번 (이 규칙)`
          : "같은 화면이 이것 하나뿐",
        doc.guideType ? h("span", { class: "tag" }, `guide ${doc.guideType}`) : null,
      ),
      h(
        "div",
        { class: "tip-body" },
        wire(doc, 90),
        h(
          "ul",
          { class: "tip-texts" },
          labelOf(doc).map((t) => h("li", {}, t)),
        ),
      ),
    );
    tip.hidden = false;
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    tip.style.left = `${Math.min(x + 14, box.width - 290)}px`;
    tip.style.top = `${Math.min(y + 14, box.height - tip.offsetHeight - 8)}px`;
  }

  function select(dot: Dot) {
    selected = dot;
    for (const el of dotLayer.querySelectorAll<SVGCircleElement>("circle")) {
      el.classList.toggle("selected", el.dataset.id === dot.id);
    }
    const older = dot.group.filter((d) => d.doc.screenId < dot.doc.screenId);
    panel.replaceChildren(
      h(
        "div",
        { class: "map-panel-head" },
        h(
          "a",
          { href: `#/d/${encodeURIComponent(dot.doc.deviceId)}` },
          deviceName(dot.doc.deviceId),
          " 기록 보기 →",
        ),
        h(
          "button",
          {
            class: "link small",
            onclick: () => {
              selected = undefined;
              for (const el of dotLayer.querySelectorAll("circle")) el.classList.remove("selected");
              renderOverview(lastGroups, lastPkgs);
            },
          },
          "닫기",
        ),
      ),
      renderScreen(dot.doc, {
        sameBefore: older[older.length - 1]?.doc,
        seenCount: older.length + 1,
      }),
    );
  }

  dotLayer.addEventListener("mouseover", (e) => {
    const id = (e.target as Element).getAttribute("data-id");
    const dot = id ? dots.get(id) : undefined;
    if (!dot) return;
    highlight(dot.key);
    showTip(dot, e);
  });
  dotLayer.addEventListener("mousemove", (e) => {
    const id = (e.target as Element).getAttribute("data-id");
    const dot = id ? dots.get(id) : undefined;
    if (dot) showTip(dot, e);
  });
  dotLayer.addEventListener("mouseout", () => {
    highlight(undefined);
    tip.hidden = true;
  });
  dotLayer.addEventListener("click", (e) => {
    const id = (e.target as Element).getAttribute("data-id");
    const dot = id ? dots.get(id) : undefined;
    if (dot) select(dot);
  });

  // 확대·이동 (viewBox 조절)
  const applyView = () => svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);

  function fitView() {
    const all = [...dots.values()];
    if (!all.length) return;
    const xs = all.map((d) => d.x ?? 0);
    const ys = all.map((d) => d.y ?? 0);
    const pad = 40;
    // 점이 적을 때 너무 크게 확대하지 않도록 최소 크기
    const MIN = 500;
    let minX = Math.min(...xs) - pad;
    let minY = Math.min(...ys) - pad;
    let w = Math.max(...xs) - minX + pad;
    let hh = Math.max(...ys) - minY + pad;
    if (w < MIN) {
      minX -= (MIN - w) / 2;
      w = MIN;
    }
    if (hh < MIN * 0.75) {
      minY -= (MIN * 0.75 - hh) / 2;
      hh = MIN * 0.75;
    }
    const box = svg.getBoundingClientRect();
    const aspect = box.width / Math.max(1, box.height) || 4 / 3;
    // 화면 비율에 맞춰 넓힌다
    if (w / hh > aspect) view = { x: minX, y: minY - (w / aspect - hh) / 2, w, h: w / aspect };
    else view = { x: minX - (hh * aspect - w) / 2, y: minY, w: hh * aspect, h: hh };
    applyView();
  }

  svg.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const box = svg.getBoundingClientRect();
      const px = view.x + ((e.clientX - box.left) / box.width) * view.w;
      const py = view.y + ((e.clientY - box.top) / box.height) * view.h;
      const k = Math.exp(e.deltaY * 0.0015);
      view = { x: px - (px - view.x) * k, y: py - (py - view.y) * k, w: view.w * k, h: view.h * k };
      applyView();
    },
    { passive: false },
  );
  let drag: { x: number; y: number; vx: number; vy: number } | undefined;
  svg.addEventListener("pointerdown", (e) => {
    if ((e.target as Element).tagName === "circle") return;
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add("dragging");
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const box = svg.getBoundingClientRect();
    view.x = drag.vx - ((e.clientX - drag.x) / box.width) * view.w;
    view.y = drag.vy - ((e.clientY - drag.y) / box.height) * view.h;
    applyView();
  });
  const endDrag = () => {
    drag = undefined;
    svg.classList.remove("dragging");
  };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);
  svg.addEventListener("dblclick", fitView);

  const sub = every(REFRESH_MS, load);
  return () => {
    disposed = true;
    sub.stop();
    sim?.stop();
  };
}
