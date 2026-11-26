/**
 * 4. 화면 지도 — 화면 하나 = 점, 같은 화면(고른 규칙에서 같은 키)끼리 선으로 잇는다.
 * 점에 마우스를 올리면 어떤 화면인지 미리 보기, 누르면 오른쪽에 화면 전체.
 * 앱(pkg)마다 색이 다르고, 혼자인 점(같은 화면이 하나뿐)은 속이 빈 원.
 * 규칙을 바꾸면 묶음이 다시 계산된다 → 지문이 얼마나 갈리는지 한눈에 본다.
 * "묶어 보기"(기본)에서는 같은 화면 묶음 하나 = 점 하나(크기 ∝ 화면 수), 누르면 묶음 안 화면 목록.
 * "실시간"으로 기기를 고르면 그 기기에 새 화면이 들어올 때마다 매칭된 점을 깜빡이고,
 * 최근 이동을 화살표로 잇고, 오른쪽에 그 화면과 서버 매칭 결과를 보여 준다.
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
import { fpHue, h, matchLine, s, time } from "../dom.ts";
import { RULES, isActionable, ruleKey, type RuleId } from "../fp-rules.ts";
import { every, subscribeScreens, type Subscription } from "../subscribe.ts";
import type { CommandEntryDocument, Device, ScreenDocument, ScreenSummary } from "../types.ts";
import { commandSummary, renderCommand } from "./command-panel.ts";
import { renderScreen } from "./screen-panel.ts";

const REFRESH_MS = 10_000;
/** 실시간: 지도에 화살표로 이어 보여 줄 최근 화면 수 */
const TRAIL = 6;
const MAX_PER_DEVICE = 500;
const CONCURRENCY = 8;
const R = 5;

/** 화면 원본은 바뀌지 않으므로 페이지를 옮겨 다녀도 다시 받지 않는다 */
const docCache = new Map<string, ScreenDocument>();

interface Dot extends SimulationNodeDatum {
  id: string;
  /** 낱개: 그 화면, 묶음: 가장 최근 화면 */
  doc: ScreenDocument;
  key: string;
  /** 같은 키의 점들 (묶어 보기에서는 자기 하나) */
  group: Dot[];
  /** 같은 키의 화면들, 오래된 순 */
  members: ScreenDocument[];
  r: number;
}
type Mode = "group" | "single";

/** 묶음 점 반지름: 화면 수의 제곱근에 비례, 너무 커지지 않게 */
const radiusOf = (n: number) => Math.min(26, R + 2.2 * Math.sqrt(n - 1));
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
  let rule: RuleId = "page";
  let mode: Mode = "group";
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
  let lastGroups = new Map<string, ScreenDocument[]>();
  let lastPkgs: string[] = [];
  let view = { x: 0, y: 0, w: 800, h: 600 };
  // 실시간
  let liveDevice = "";
  let liveSub: Subscription | undefined;
  /** 새 화면이 오면 오른쪽 패널을 그 화면으로 바꾼다 (점을 눌러 다른 걸 보면 멈춤) */
  let following = true;
  /** 그 기기의 최근 화면들, 오래된 순 */
  let trail: ScreenDocument[] = [];
  /** 기기별 명령 기록 요약 (classify·앱 선택, 오래된 순). 지도 점에는 안 들어간다 */
  let commandsByDevice = new Map<string, ScreenSummary[]>();
  /** 실시간 기기의 지금 명령: classify 원본 + 그 뒤 앱 선택 */
  let liveCommand: { classify: CommandEntryDocument; choose?: CommandEntryDocument } | undefined;

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
  const modeSeg = h(
    "div",
    { class: "seg", role: "group", "aria-label": "보기" },
    (
      [
        ["group", "묶어 보기", "같은 화면 묶음 하나를 점 하나로 (크기 = 화면 수)"],
        ["single", "낱개", "화면 한 번 = 점 하나, 같은 화면끼리 선으로"],
      ] as const
    ).map(([id, label, hint]) =>
      h(
        "button",
        {
          class: id === mode ? "on" : "",
          title: hint,
          onclick: (e: MouseEvent) => {
            mode = id;
            for (const b of modeSeg.querySelectorAll("button"))
              b.classList.toggle("on", b === e.currentTarget);
            selected = undefined;
            rebuild(true);
          },
        },
        label,
      ),
    ),
  );
  const liveSelect = h("select", {
    class: "live-select",
    title: "고른 기기에 새 화면이 들어오면 지도에서 어디인지 바로 보여 줘요",
    onchange: (e: Event) => startLive((e.target as HTMLSelectElement).value),
  });
  const deviceSelect = h("select", {
    onchange: (e: Event) => {
      deviceFilter = (e.target as HTMLSelectElement).value;
      rebuild(true);
    },
  });

  const linkLayer = s("g", { class: "links" });
  const dotLayer = s("g", { class: "dots" });
  const countLayer = s("g", { class: "counts" });
  const trailLayer = s("g", { class: "trail" });
  const pulseLayer = s("g", { class: "pulse" });
  const defs = s(
    "defs",
    {},
    s(
      "marker",
      {
        id: "trail-arrow",
        viewBox: "0 0 10 10",
        refX: 9,
        refY: 5,
        markerWidth: 7,
        markerHeight: 7,
        orient: "auto-start-reverse",
      },
      s("path", { d: "M0,0 L10,5 L0,10 z" }),
    ),
  );
  const labelLayer = s("g", { class: "labels" });
  const svg = s(
    "svg",
    { class: "map" },
    defs,
    linkLayer,
    trailLayer,
    dotLayer,
    pulseLayer,
    countLayer,
    labelLayer,
  );
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
        modeSeg,
        deviceSelect,
        liveSelect,
        stats,
      ),
      h(
        "p",
        { class: "muted small hint" },
        "묶어 보기: 점 하나 = 같은 화면 묶음, 크기와 숫자 = 화면 수, 누르면 안의 화면 목록. 낱개: 점 하나 = 화면 한 번, 같은 화면끼리 선. 속이 빈 점은 같은 화면이 하나뿐인 것(갈렸을 수 있음), 점선 테두리는 서버가 판단을 보류한 화면이 들어 있는 것. 휠로 확대, 끌어서 이동.",
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
      const listed = (await Promise.all(devices.map((d) => listAll(d.deviceId)))).flat();
      // 명령 기록(classify·앱 선택)은 화면이 아니라 점으로 그리지 않는다
      summaries = listed.filter((x) => !x.entry);
      commandsByDevice = new Map();
      for (const x of listed
        .filter((y) => y.entry)
        .sort((a, b) => a.screenId.localeCompare(b.screenId))) {
        commandsByDevice.set(x.deviceId, [...(commandsByDevice.get(x.deviceId) ?? []), x]);
      }
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
    liveSelect.replaceChildren(
      h("option", { value: "" }, "실시간 끔"),
      ...devices.map((d) =>
        h(
          "option",
          { value: d.deviceId, selected: d.deviceId === liveDevice },
          `● 실시간: ${d.label ?? d.deviceId.slice(0, 8)}`,
        ),
      ),
    );
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

    const groups = new Map<string, ScreenDocument[]>();
    for (const doc of docs) {
      const key = ruleKey(doc, rule);
      const members = groups.get(key) ?? [];
      members.push(doc);
      groups.set(key, members);
    }

    const next = new Map<string, Dot>();
    const reuse = (id: string, doc: ScreenDocument): Dot => {
      const fresh: Dot = { id, doc, key: "", group: [], members: [], r: R };
      return fit ? fresh : (dots.get(id) ?? fresh);
    };
    for (const [key, members] of groups) {
      if (mode === "group") {
        const latest = members[members.length - 1];
        if (!latest) continue;
        const dot = reuse(`g:${key}`, latest);
        Object.assign(dot, {
          doc: latest,
          key,
          members,
          group: [dot],
          r: radiusOf(members.length),
        });
        next.set(dot.id, dot);
      } else {
        const group: Dot[] = [];
        for (const doc of members) {
          const dot = reuse(doc.screenId, doc);
          Object.assign(dot, { doc, key, members, group, r: R });
          group.push(dot);
          next.set(dot.id, dot);
        }
      }
    }
    dots = next;
    links =
      mode === "group"
        ? []
        : [...dots.values()]
            .filter((d) => d.group[0] !== d)
            .map((dot) => ({ source: dot.group[dot.group.indexOf(dot) - 1] ?? dot, target: dot }));

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
      .force(
        "collide",
        forceCollide<Dot>((d) => d.r + 1.5),
      )
      .force("x", forceX<Dot>((d) => anchor.get(d.doc.pkg)?.x ?? 0).strength(0.07))
      .force("y", forceY<Dot>((d) => anchor.get(d.doc.pkg)?.y ?? 0).strength(0.07))
      .stop();
    sim.alpha(fit ? 1 : 0.3);
    for (let i = 0; i < (fit ? 300 : 120); i++) sim.tick();

    draw(pkgs);
    // 레이아웃이 끝난 뒤 크기를 재야 비율이 맞는다
    if (fit) requestAnimationFrame(fitView);
    lastGroups = groups;
    lastPkgs = pkgs;
    renderStats(groups, pkgs);
    if (selected && !dots.has(selected.id)) selected = undefined;
    if (selected) selected = dots.get(selected.id);
    drawLive();
    if (!selected) {
      if (!liveDevice) renderOverview(groups, pkgs);
      else if (following) renderLive();
    }
  }

  /** 묶어 보기: 묶음 안 판단 보류 화면 수, 낱개: 그 화면이 판단 보류면 1 */
  const ambiguousCount = (d: Dot) =>
    (mode === "group" ? d.members : [d.doc]).filter((m) => m.match?.kind === "ambiguous").length;

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
          r: d.r,
          class: [
            d.members.length === 1 ? "alone" : "",
            d.doc.guideType ? "guide" : "",
            rule === "page" && ambiguousCount(d) > 0 ? "ambiguous" : "",
            selected?.id === d.id ? "selected" : "",
          ].join(" "),
          style: `--h:${fpHue(d.doc.pkg)}`,
          "data-id": d.id,
        }),
      ),
    );
    // 묶음 점 안의 화면 수
    countLayer.replaceChildren(
      ...[...dots.values()]
        .filter((d) => mode === "group" && d.members.length > 1)
        .map((d) => {
          // 작은 점에도 들어가도록 글자 크기를 반지름에 맞춘다
          const size = Math.min(10, d.r * (d.members.length >= 10 ? 0.95 : 1.25));
          return s(
            "text",
            {
              x: d.x ?? 0,
              y: (d.y ?? 0) + size * 0.35,
              class: "count",
              style: `font-size:${size}px`,
            },
            d.members.length,
          );
        }),
    );
    // 앱 이름: 그 앱 점들의 위쪽
    labelLayer.replaceChildren(
      ...pkgs.map((p) => {
        const mine = [...dots.values()].filter((d) => d.doc.pkg === p);
        const cx = mine.reduce((a, d) => a + (d.x ?? 0), 0) / mine.length;
        const top = Math.min(...mine.map((d) => (d.y ?? 0) - d.r));
        return s(
          "text",
          { x: cx, y: top - 12, style: `--h:${fpHue(p)}` },
          p.split(".").slice(-2).join("."),
        );
      }),
    );
  }

  function renderStats(groups: Map<string, ScreenDocument[]>, pkgs: string[]) {
    const alone = [...groups.values()].filter((g) => g.length === 1).length;
    const screens = [...groups.values()].reduce((a, g) => a + g.length, 0);
    stats.replaceChildren(
      h("span", {}, "화면 ", h("b", {}, screens)),
      h("span", {}, "같은 화면 묶음 ", h("b", {}, groups.size)),
      h("span", {}, "혼자인 점 ", h("b", {}, alone)),
      h("span", {}, "앱 ", h("b", {}, pkgs.length)),
    );
  }

  /** 아무 점도 고르지 않았을 때 오른쪽: 앱별 화면·묶음 수 */
  function renderOverview(groups: Map<string, ScreenDocument[]>, pkgs: string[]) {
    const byPkg = pkgs.map((p) => {
      const gs = [...groups.values()].filter((g) => g[0]?.pkg === p);
      return {
        pkg: p,
        screens: gs.reduce((a, g) => a + g.length, 0),
        groups: gs.length,
        alone: gs.filter((g) => g.length === 1).length,
      };
    });
    panel.replaceChildren(
      h("h2", { class: "small-title" }, "앱별"),
      h(
        "p",
        { class: "muted small" },
        mode === "group"
          ? "점을 누르면 그 묶음의 화면 목록을 여기서 봐요."
          : "점을 누르면 그 화면을 여기서 크게 봐요.",
      ),
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
        mode === "group" && dot.members.length > 1
          ? groupSpan(dot.members)
          : `${deviceName(doc.deviceId)} · ${time(doc.capturedAt)} · 노드 ${doc.screen.nodes.length}개`,
      ),
      h(
        "div",
        { class: "small" },
        dot.members.length > 1
          ? `같은 화면 ${dot.members.length}번 (이 규칙)${mode === "group" ? " · 미리 보기는 가장 최근" : ""}`
          : "같은 화면이 이것 하나뿐",
        doc.guideType ? h("span", { class: "tag" }, `guide ${doc.guideType}`) : null,
      ),
      ...(doc.match ? [h("div", { class: "small" }, matchLine(doc.match))] : []),
      ...(mode === "group" && rule === "page" && ambiguousCount(dot) > 0
        ? [h("div", { class: "small match-ambiguous" }, `판단 보류 ${ambiguousCount(dot)}개 포함`)]
        : []),
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

  const groupSpan = (members: ScreenDocument[]) => {
    const devs = new Set(members.map((m) => m.deviceId)).size;
    const first = members[0];
    const last = members[members.length - 1];
    return `기기 ${devs}대 · ${first ? time(first.capturedAt) : ""} ~ ${last ? time(last.capturedAt) : ""}`;
  };

  const closeButton = () =>
    h(
      "button",
      {
        class: "link small",
        onclick: () => {
          selected = undefined;
          for (const el of dotLayer.querySelectorAll("circle")) el.classList.remove("selected");
          if (liveDevice) {
            following = true;
            renderLive();
          } else renderOverview(lastGroups, lastPkgs);
        },
      },
      liveDevice ? "● 실시간으로 돌아가기" : "닫기",
    );

  // ---------------------------------------------------------------------------
  // 실시간
  // ---------------------------------------------------------------------------

  /** 지금 보기에서 그 화면이 들어간 점 */
  const dotOf = (doc: ScreenDocument) =>
    dots.get(mode === "group" ? `g:${ruleKey(doc, rule)}` : doc.screenId);

  function startLive(deviceId: string) {
    liveSub?.stop();
    liveSub = undefined;
    liveDevice = deviceId;
    following = true;
    selected = undefined;
    svg.classList.toggle("live", deviceId !== "");
    const mine = summaries
      .filter((x) => x.deviceId === deviceId)
      .sort((a, b) => a.screenId.localeCompare(b.screenId));
    trail = deviceId
      ? mine
          .slice(-TRAIL)
          .map((x) => docCache.get(x.screenId))
          .filter((d): d is ScreenDocument => d !== undefined)
      : [];
    if (deviceId) {
      liveSub = subscribeScreens(
        deviceId,
        mine[mine.length - 1]?.screenId,
        (items) => void onLive(items),
        (error) => {
          status.textContent = `실시간 수신 실패: ${(error as Error).message}`;
          status.className = "error small";
        },
      );
    }
    liveCommand = undefined;
    drawLive();
    if (deviceId) renderLive();
    else renderOverview(lastGroups, lastPkgs);
    const current = trail[trail.length - 1];
    if (current) reveal(current);
    if (deviceId) void loadCommand(deviceId, commandsByDevice.get(deviceId) ?? []);
  }

  /** 명령 기록 중 마지막 classify 와 그 뒤 앱 선택을 불러와 지금 명령으로 */
  async function loadCommand(deviceId: string, entries: ScreenSummary[]) {
    const lastClassify = [...entries].reverse().find((x) => x.command?.kind === "classify");
    if (!lastClassify) return;
    const choose = entries.find(
      (x) =>
        x.command?.kind === "choose" &&
        x.command.commandId === lastClassify.command?.commandId &&
        x.screenId > lastClassify.screenId,
    );
    try {
      const [c, chosen] = await Promise.all([
        api.entry(deviceId, lastClassify.screenId),
        choose ? api.entry(deviceId, choose.screenId) : Promise.resolve(undefined),
      ]);
      if (disposed || deviceId !== liveDevice) return;
      liveCommand = { classify: c, ...(chosen ? { choose: chosen } : {}) };
      drawLive();
      if (following && !selected) renderLive();
    } catch {
      // 수명 주기로 지워졌으면 표시하지 않음
    }
  }

  async function onLive(all: ScreenSummary[]) {
    const commands = all.filter((x) => x.entry);
    if (commands.length) {
      const deviceId = commands[0]?.deviceId ?? "";
      const prev = commandsByDevice.get(deviceId) ?? [];
      const seen = new Set(prev.map((x) => x.screenId));
      const list = [...prev, ...commands.filter((x) => !seen.has(x.screenId))];
      commandsByDevice.set(deviceId, list);
      if (deviceId === liveDevice) void loadCommand(deviceId, list);
    }
    const items = all.filter((x) => !x.entry);
    if (!items.length) return;
    const known = new Set(summaries.map((x) => x.screenId));
    for (const item of items) if (!known.has(item.screenId)) summaries.push(item);
    const docs: ScreenDocument[] = [];
    for (const item of items) {
      let doc = docCache.get(item.screenId);
      if (!doc) {
        try {
          doc = await api.screen(item.deviceId, item.screenId);
          docCache.set(item.screenId, doc);
        } catch {
          continue;
        }
      }
      docs.push(doc);
    }
    // 기다리는 사이 기기를 바꿨으면 이전 기기의 응답은 버린다
    if (disposed || items[0]?.deviceId !== liveDevice) return;
    trail = [...trail, ...docs].slice(-TRAIL);
    if (following) selected = undefined;
    // 새 점(새 페이지)이 생길 수 있으므로 다시 배치 (기존 점 자리는 유지)
    rebuild(false);
    const current = trail[trail.length - 1];
    if (current) reveal(current);
  }

  /** 지도 밖이면 그 점이 가운데 오도록 옮긴다 */
  function reveal(doc: ScreenDocument) {
    const dot = dotOf(doc);
    if (!dot || dot.x === undefined || dot.y === undefined) return;
    const m = Math.min(view.w, view.h) * 0.08;
    const inside =
      dot.x > view.x + m &&
      dot.x < view.x + view.w - m &&
      dot.y > view.y + m &&
      dot.y < view.y + view.h - m;
    if (inside) return;
    view = { ...view, x: dot.x - view.w / 2, y: dot.y - view.h / 2 };
    applyView();
  }

  /** 지도 위: 최근 이동 화살표, 지금 점 깜빡임, 판단 보류면 2등 점도 표시 */
  function drawLive() {
    for (const el of dotLayer.querySelectorAll("circle.live-runner, circle.live-target"))
      el.classList.remove("live-runner", "live-target");
    // 지금 명령이 고른 앱(앱 선택이 있으면 그 앱, 없으면 후보 전체)의 화면 점
    const targets = liveDevice ? targetPackages() : new Set<string>();
    if (targets.size) {
      for (const el of dotLayer.querySelectorAll<SVGCircleElement>("circle")) {
        const pkg = dots.get(el.dataset.id ?? "")?.doc.pkg;
        if (pkg && targets.has(pkg)) el.classList.add("live-target");
      }
    }
    const current = trail[trail.length - 1];
    if (!liveDevice || !current) {
      trailLayer.replaceChildren();
      pulseLayer.replaceChildren();
      return;
    }
    // 같은 점에 연달아 머문 것은 하나로
    const path: Dot[] = [];
    for (const doc of trail) {
      const dot = dotOf(doc);
      if (dot && path[path.length - 1] !== dot) path.push(dot);
    }
    trailLayer.replaceChildren(
      ...path.slice(1).map((to, i) => {
        const from = path[i] ?? to;
        const dx = (to.x ?? 0) - (from.x ?? 0);
        const dy = (to.y ?? 0) - (from.y ?? 0);
        const len = Math.hypot(dx, dy) || 1;
        const cut = (r: number) => (r + 2) / len;
        return s("line", {
          x1: (from.x ?? 0) + dx * cut(from.r),
          y1: (from.y ?? 0) + dy * cut(from.r),
          x2: (to.x ?? 0) - dx * cut(to.r),
          y2: (to.y ?? 0) - dy * cut(to.r),
          "marker-end": "url(#trail-arrow)",
          style: `opacity:${0.35 + (0.65 * (i + 1)) / Math.max(1, path.length - 1)}`,
        });
      }),
    );
    const dot = dotOf(current);
    pulseLayer.replaceChildren(
      ...(dot
        ? [
            s("circle", { class: "ring", cx: dot.x ?? 0, cy: dot.y ?? 0, r: dot.r + 3 }),
            s("circle", { class: "now", cx: dot.x ?? 0, cy: dot.y ?? 0, r: dot.r + 3 }),
          ]
        : []),
    );
    const runner = current.match?.kind === "ambiguous" ? current.match.runnerUp : undefined;
    if (runner && rule === "page") {
      const key = `${current.pkg}#page:${runner.pageId}`;
      for (const el of dotLayer.querySelectorAll<SVGCircleElement>("circle")) {
        if (dots.get(el.dataset.id ?? "")?.key === key) el.classList.add("live-runner");
      }
    }
  }

  function targetPackages(): Set<string> {
    const detail = liveCommand?.classify.detail;
    if (detail?.kind !== "classify" || detail.selection?.kind !== "route") return new Set();
    const chosen = liveCommand?.choose?.command.appId;
    return new Set(
      detail.selection.candidates
        .filter((c) => !chosen || c.appId === chosen)
        .flatMap((c) => c.packages),
    );
  }

  /** 실시간 패널 맨 위: 지금 명령 (누르면 자세히) */
  function commandCard(): HTMLElement | null {
    if (!liveCommand) return null;
    const { classify, choose } = liveCommand;
    return h(
      "button",
      {
        class: "live-command",
        title: "눌러서 판정 과정 보기",
        onclick: () => {
          following = false;
          panel.replaceChildren(
            h("div", { class: "map-panel-head" }, h("b", {}, "명령"), closeButton()),
            renderCommand(classify),
            choose ? renderCommand(choose) : "",
          );
        },
      },
      h(
        "div",
        { class: "small" },
        h("span", { class: "tag cmd-tag classify" }, "jev"),
        ` 명령 #${classify.command.commandId} · ${time(classify.receivedAt)}`,
        classify.command.level ? h("span", { class: "tag" }, classify.command.level) : "",
      ),
      h("div", { class: "live-command-text" }, commandSummary(classify.command)),
      choose?.command ? h("div", { class: "small muted" }, commandSummary(choose.command)) : "",
    );
  }

  /** 오른쪽: 지금 화면 + 서버 매칭 결과 + 최근 이동 */
  function renderLive() {
    const current = trail[trail.length - 1];
    const head = h(
      "div",
      { class: "map-panel-head" },
      h(
        "span",
        {},
        h("span", { class: "live-dot" }),
        h("b", {}, "실시간"),
        h("span", { class: "muted small" }, ` · ${deviceName(liveDevice)}`),
      ),
      h(
        "button",
        {
          class: "link small",
          onclick: () => {
            liveSelect.value = "";
            startLive("");
          },
        },
        "끄기",
      ),
    );
    if (!current) {
      panel.replaceChildren(
        head,
        commandCard() ?? "",
        h("p", { class: "muted small" }, "새 화면을 기다리는 중…"),
      );
      return;
    }
    const dot = dotOf(current);
    const kind = current.match?.kind;
    const verdict =
      kind === "exact"
        ? "이미 본 화면 (같은 지문)"
        : kind === "similar"
          ? "이미 본 페이지와 비슷함"
          : kind === "ambiguous"
            ? "판단 보류 — 비슷한 페이지가 둘"
            : kind === "new"
              ? "처음 보는 페이지"
              : "매칭 결과 없음";
    const recent = [...trail].reverse();
    panel.replaceChildren(
      head,
      commandCard() ?? "",
      h(
        "div",
        { class: `live-verdict live-${kind ?? "none"}` },
        h("div", { class: "live-verdict-title" }, verdict),
        current.match ? h("div", { class: "small" }, matchLine(current.match)) : "",
        h(
          "div",
          { class: "muted small" },
          `${current.pkg} · ${time(current.capturedAt)}`,
          dot && dot.members.length > 1 ? ` · 이 묶음 화면 ${dot.members.length}개` : "",
        ),
      ),
      h(
        "ol",
        { class: "live-recent" },
        recent.map((doc, i) =>
          h(
            "li",
            { class: i === 0 ? "now" : "" },
            h("span", { class: "swatch", style: `--h:${fpHue(doc.pkg)}` }),
            h("span", { class: "small" }, time(doc.capturedAt)),
            h(
              "span",
              { class: `small match-${doc.match?.kind ?? "none"}` },
              ` ${doc.match?.kind ?? "-"}`,
            ),
            h(
              "span",
              { class: "muted small ellipsis" },
              ` ${labelOf(doc).slice(0, 2).join(" · ")}`,
            ),
          ),
        ),
      ),
      renderScreen(current, {
        sameBefore: dot?.members[dot.members.indexOf(current) - 1],
        seenCount: (dot?.members.indexOf(current) ?? 0) + 1,
      }),
    );
  }

  /** 묶음 점을 눌렀을 때: 안의 화면 목록 (최근 순). 항목을 누르면 그 화면 */
  function renderGroupList(dot: Dot) {
    const { members } = dot;
    const kinds = new Map<string, number>();
    for (const m of members) {
      const k = m.match?.kind ?? "없음";
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    panel.replaceChildren(
      h(
        "div",
        { class: "map-panel-head" },
        h(
          "div",
          {},
          h("span", { class: "swatch", style: `--h:${fpHue(dot.doc.pkg)}` }),
          h("b", {}, `화면 ${members.length}개`),
          h("span", { class: "muted small" }, ` · ${dot.doc.pkg}`),
        ),
        closeButton(),
      ),
      h("div", { class: "muted small" }, groupSpan(members)),
      ...(rule === "page"
        ? [
            h(
              "div",
              { class: "muted small" },
              "서버 판정: ",
              [...kinds].map(([k, n]) => `${k} ${n}`).join(" · "),
            ),
          ]
        : []),
      h(
        "ul",
        { class: "group-list" },
        [...members].reverse().map((doc, i) =>
          h(
            "li",
            {},
            h(
              "button",
              {
                onclick: () => {
                  const idx = members.length - 1 - i;
                  panel.replaceChildren(
                    h(
                      "div",
                      { class: "map-panel-head" },
                      h(
                        "button",
                        { class: "link small", onclick: () => renderGroupList(dot) },
                        `← 목록 (${members.length})`,
                      ),
                      h(
                        "a",
                        { href: `#/d/${encodeURIComponent(doc.deviceId)}` },
                        deviceName(doc.deviceId),
                        " 기록 보기 →",
                      ),
                    ),
                    renderScreen(doc, { sameBefore: members[idx - 1], seenCount: idx + 1 }),
                  );
                },
              },
              wire(doc, 34),
              h(
                "span",
                { class: "group-item" },
                h(
                  "span",
                  { class: "small" },
                  `${time(doc.capturedAt)} · ${deviceName(doc.deviceId)}`,
                  doc.guideType ? h("span", { class: "tag" }, `guide ${doc.guideType}`) : null,
                  doc.match && rule === "page"
                    ? h("span", { class: `match-${doc.match.kind} small` }, ` ${doc.match.kind}`)
                    : null,
                ),
                h("span", { class: "muted small ellipsis" }, labelOf(doc).slice(0, 2).join(" · ")),
              ),
            ),
          ),
        ),
      ),
    );
  }

  function select(dot: Dot) {
    selected = dot;
    following = false;
    for (const el of dotLayer.querySelectorAll<SVGCircleElement>("circle")) {
      el.classList.toggle("selected", el.dataset.id === dot.id);
    }
    if (mode === "group") {
      renderGroupList(dot);
      return;
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
        closeButton(),
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
    // 크기를 아직 못 재면(숨김·레이아웃 전) 4:3, 너무 길쭉한 비율은 자른다
    const aspect =
      box.width > 50 && box.height > 50
        ? Math.min(3, Math.max(0.5, box.width / box.height))
        : 4 / 3;
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
    liveSub?.stop();
    sim?.stop();
  };
}
