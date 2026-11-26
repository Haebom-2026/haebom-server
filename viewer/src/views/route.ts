/**
 * 5. 고르기 — jev 앱·목표 고르기 판정 보기 (docs/jev-routing-plan.md 9.1, R1.2).
 *
 * scripts/route-eval.ts --out 으로 만든 결과 파일을 브라우저에서 연다 (서버에 올리지 않음).
 * 말마다 1단계 확률·역할 합계·탄 규칙, 후보, 2단계 목표 확률을 보여 주고,
 * 두 번째 파일을 열면 같은 말의 결과가 달라진 것만 거를 수 있다.
 */
import { h } from "../dom.ts";
import {
  parseReport,
  type EvalItem,
  type EvalReport,
  type EvalRun,
  type RouteSelection,
} from "../route-types.ts";
import {
  namesFrom,
  resultLine,
  routeJudgement,
  RULE_LABEL,
  shortResult,
  type Names,
} from "./route-detail.ts";

type Filter = "all" | "wrong" | "unrouted" | "ask" | "changed";

const STORE_KEY = "haebom-viewer:route-eval";

/** 탭을 옮겨 다녀도 연 파일을 유지한다 (새로고침은 localStorage 에서) */
const state: {
  report?: { name: string; data: EvalReport };
  compare?: { name: string; data: EvalReport } | undefined;
  run: number;
  filter: Filter;
  query: string;
  selected?: string | undefined;
} = { run: 0, filter: "all", query: "" };

function restore() {
  if (state.report) return;
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (!saved) return;
    const { name, text } = JSON.parse(saved) as { name: string; text: string };
    state.report = { name, data: parseReport(text) };
  } catch {
    // 저장소를 못 쓰거나 내용이 깨졌으면 그냥 빈 화면
  }
}

function remember(name: string, text: string) {
  try {
    if (text.length < 3_000_000) localStorage.setItem(STORE_KEY, JSON.stringify({ name, text }));
  } catch {
    // 저장소가 꽉 찼거나 막혀 있으면 이번 탭에서만 유지
  }
}

// ---------- 이름표 ----------

const APP_GRADE: Record<string, { text: string; tone: Tone }> = {
  hit: { text: "맞음", tone: "ok" },
  none_ok: { text: "해당 없음 맞춤", tone: "ok" },
  miss: { text: "후보에 정답 없음", tone: "bad" },
  false_positive: { text: "해당 없음인데 후보", tone: "bad" },
  no_route: { text: "못 고름", tone: "warn" },
  ask: { text: "하려는 일 물음", tone: "info" },
};

const GOAL_GRADE: Record<string, { text: string; tone: Tone }> = {
  right: { text: "목표 맞음", tone: "ok" },
  wrong: { text: "목표 틀림", tone: "bad" },
  ask: { text: "목표 물음", tone: "info" },
  no_goal: { text: "목표 못 정함", tone: "warn" },
};

type Tone = "ok" | "bad" | "warn" | "info";

// ---------- 계산 ----------

const pct = (a: number, b: number) => (b === 0 ? "–" : `${((a / b) * 100).toFixed(1)}%`);

function isWrong(item: EvalItem) {
  return (
    item.grade.app === "miss" || item.grade.app === "false_positive" || item.grade.goal === "wrong"
  );
}
function isUnrouted(item: EvalItem) {
  return item.grade.app === "no_route" || item.grade.goal === "no_goal";
}
function isAsk(item: EvalItem) {
  return item.grade.app === "ask" || item.grade.goal === "ask";
}

/** 결과를 한 줄 문자열로 (두 파일 비교용) */
function signature(sel: RouteSelection): string {
  if (sel.kind === "fail") return `fail:${sel.reason}`;
  if (sel.kind === "ask_intent") return `ask:${sel.clarify.options.map((o) => o.id).join("/")}`;
  return `route:${sel.candidates
    .map((c) => `${c.appId}${c.goal ? `>${c.goal.id}` : c.clarify ? ">?" : ""}`)
    .join(",")}`;
}

function quantile(sorted: number[], q: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

// ---------- 화면 ----------

export function routeView(root: HTMLElement): () => void {
  restore();

  const fileInput = h("input", { type: "file", accept: ".json,application/json", hidden: true });
  const compareInput = h("input", { type: "file", accept: ".json,application/json", hidden: true });
  const head = h("div", { class: "rt-files" });
  const stats = h("div", { class: "rt-stats" });
  const filters = h("div", { class: "toolbar rt-filters" });
  const list = h("ul", { class: "rt-list" });
  const panel = h("section", { class: "rt-panel" });
  const body = h("div", { class: "rt-body" });

  root.append(
    h(
      "section",
      { class: "page" },
      h(
        "header",
        { class: "page-head" },
        h("h1", {}, "고르기"),
        h(
          "p",
          { class: "muted" },
          "jev 앱·목표 고르기 판정. route-eval 결과 파일을 열어요 (브라우저 안에서만 읽음).",
        ),
      ),
      fileInput,
      compareInput,
      head,
      body,
    ),
  );

  const readFile = (file: File, into: "report" | "compare") => {
    file
      .text()
      .then((text) => {
        const data = parseReport(text);
        if (into === "report") {
          state.report = { name: file.name, data };
          state.run = 0;
          state.selected = undefined;
          remember(file.name, text);
        } else {
          state.compare = { name: file.name, data };
          state.filter = "changed";
        }
        render();
      })
      .catch((error: unknown) => {
        head.append(h("p", { class: "error" }, `파일을 못 열었어요: ${(error as Error).message}`));
      });
  };

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) readFile(file, "report");
    fileInput.value = "";
  });
  compareInput.addEventListener("change", () => {
    const file = compareInput.files?.[0];
    if (file) readFile(file, "compare");
    compareInput.value = "";
  });

  const onDragOver = (event: DragEvent) => {
    event.preventDefault();
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const files = [...(event.dataTransfer?.files ?? [])];
    const [first, second] = files;
    if (!first) return;
    // 이미 연 파일이 있으면 끌어 놓은 파일은 비교용
    if (second) {
      readFile(first, "report");
      readFile(second, "compare");
    } else readFile(first, state.report ? "compare" : "report");
  };
  root.addEventListener("dragover", onDragOver);
  root.addEventListener("drop", onDrop);

  function render() {
    const report = state.report;
    renderHead();
    if (!report) {
      body.replaceChildren(emptyState());
      return;
    }
    const run = report.data.runs[state.run] ?? report.data.runs[0];
    if (!run) {
      body.replaceChildren(h("p", { class: "muted" }, "결과 파일에 지도 실행이 없어요."));
      return;
    }
    const before = compareRun(run);
    renderStats(run);
    renderFilters(run, before);
    renderList(run, before);
    body.replaceChildren(
      stats,
      filters,
      h("div", { class: "rt-split" }, h("div", { class: "rt-list-col" }, list), panel),
    );
    const item = run.items.find((x) => x.utterance === state.selected);
    if (item) renderDetail(run, item, before?.get(item.utterance));
    else
      panel.replaceChildren(
        h("p", { class: "muted" }, "왼쪽에서 말을 고르면 판정 과정이 여기에 나와요."),
      );
  }

  function compareRun(run: EvalRun): Map<string, EvalItem> | undefined {
    const other = state.compare?.data.runs.find((r) => r.map.name === run.map.name);
    if (!other) return undefined;
    return new Map(other.items.map((x) => [x.utterance, x]));
  }

  function renderHead() {
    const report = state.report;
    const runs = report?.data.runs ?? [];
    head.replaceChildren(
      h(
        "div",
        { class: "toolbar" },
        h("button", { class: "primary", onclick: () => fileInput.click() }, "결과 파일 열기"),
        report
          ? h(
              "span",
              { class: "small" },
              h("strong", {}, report.name),
              h(
                "span",
                { class: "muted" },
                ` · ${new Date(report.data.createdAt).toLocaleString()} · ${report.data.jevModel}`,
              ),
            )
          : null,
        runs.length > 1
          ? h(
              "div",
              { class: "seg" },
              runs.map((r, i) =>
                h(
                  "button",
                  {
                    class: i === state.run ? "on" : undefined,
                    title: `${r.map.version} · 앱 ${r.map.apps.length}개 · 목표 ${r.map.goals.length}개`,
                    onclick: () => {
                      state.run = i;
                      render();
                    },
                  },
                  `지도 ${r.map.name}`,
                ),
              ),
            )
          : null,
        report
          ? h(
              "button",
              { onclick: () => compareInput.click(), title: "기준값을 바꾸기 전 결과 등" },
              state.compare ? "비교 파일 바꾸기" : "비교할 파일 열기",
            )
          : null,
        state.compare
          ? h(
              "span",
              { class: "small" },
              h("span", { class: "muted" }, "비교: "),
              state.compare.name,
              h(
                "button",
                {
                  class: "link small",
                  onclick: () => {
                    state.compare = undefined;
                    if (state.filter === "changed") state.filter = "all";
                    render();
                  },
                },
                "닫기",
              ),
            )
          : null,
      ),
    );
  }

  function renderStats(run: EvalRun) {
    const items = run.items;
    const routed = items.filter((x) => x.selection.kind === "route");
    const hit = items.filter((x) => x.grade.app === "hit").length;
    const expected = items.filter((x) => x.expect.apps.length > 0).length;
    const goals = items.filter((x) => x.grade.goal);
    const goalTaken = goals.filter((x) => x.grade.goal === "right" || x.grade.goal === "wrong");
    const goalRight = goals.filter((x) => x.grade.goal === "right").length;
    const ms = items.map((x) => x.selection.ms).sort((a, b) => a - b);
    const cost = items.reduce((s, x) => s + x.selection.cost, 0);
    const stat = (label: string, value: string, title?: string) =>
      h("span", { title }, h("b", {}, value), ` ${label}`);
    stats.replaceChildren(
      stat("말", String(items.length)),
      stat(
        "후보 중 정답",
        pct(hit, routed.length),
        "후보를 낸 말 중 정답 앱이 후보 안에 있는 비율",
      ),
      stat("후보를 냄", pct(hit, expected), "정답 앱이 있는 말 중 정답이 든 후보를 낸 비율"),
      stat("목표 맞음", pct(goalRight, goalTaken.length), "목표를 정한 것 중 맞은 비율"),
      stat("중앙값", `${quantile(ms, 0.5)}ms`),
      stat("90%", `${quantile(ms, 0.9)}ms`),
      stat("비용", `$${cost.toFixed(4)}`),
    );
  }

  function renderFilters(run: EvalRun, before: Map<string, EvalItem> | undefined) {
    const count = (f: Filter) => run.items.filter((x) => matches(x, f, before)).length;
    const options: [Filter, string][] = [
      ["all", "전체"],
      ["wrong", "틀림"],
      ["unrouted", "못 고름"],
      ["ask", "물음"],
    ];
    if (before) options.push(["changed", "바뀜"]);
    const search = h("input", {
      type: "search",
      class: "rt-search",
      placeholder: "말·앱 id 찾기",
      value: state.query,
    });
    search.addEventListener("input", () => {
      state.query = search.value;
      renderList(run, before);
    });
    filters.replaceChildren(
      h(
        "div",
        { class: "seg" },
        options.map(([f, label]) =>
          h(
            "button",
            {
              class: state.filter === f ? "on" : undefined,
              onclick: () => {
                state.filter = f;
                render();
              },
            },
            `${label} ${count(f)}`,
          ),
        ),
      ),
      search,
    );
  }

  function matches(item: EvalItem, f: Filter, before: Map<string, EvalItem> | undefined) {
    switch (f) {
      case "all":
        return true;
      case "wrong":
        return isWrong(item);
      case "unrouted":
        return isUnrouted(item);
      case "ask":
        return isAsk(item);
      case "changed": {
        const old = before?.get(item.utterance);
        return old !== undefined && signature(old.selection) !== signature(item.selection);
      }
    }
  }

  function renderList(run: EvalRun, before: Map<string, EvalItem> | undefined) {
    const q = state.query.trim().toLowerCase();
    const items = run.items.filter(
      (x) =>
        matches(x, state.filter, before) &&
        (!q ||
          x.utterance.toLowerCase().includes(q) ||
          signature(x.selection).includes(q) ||
          x.expect.apps.some((a) => a.includes(q))),
    );
    const names = nameIndex(run);
    list.replaceChildren(
      ...(items.length
        ? items.map((item) => {
            const g = APP_GRADE[item.grade.app];
            const goal = item.grade.goal ? GOAL_GRADE[item.grade.goal] : undefined;
            const tone = goal && goal.tone !== "ok" && g?.tone === "ok" ? goal.tone : g?.tone;
            const old = before?.get(item.utterance);
            const changed = old && signature(old.selection) !== signature(item.selection);
            return h(
              "li",
              {
                class: item.utterance === state.selected ? "on" : undefined,
                onclick: () => {
                  state.selected = item.utterance;
                  for (const li of list.children) li.classList.remove("on");
                  list
                    .querySelector(`li[data-u="${CSS.escape(item.utterance)}"]`)
                    ?.classList.add("on");
                  renderDetail(run, item, old);
                },
                "data-u": item.utterance,
              },
              h("span", { class: `rt-mark ${tone ?? ""}`, title: g?.text }),
              h(
                "span",
                { class: "rt-utter" },
                item.utterance,
                changed ? h("span", { class: "tag warn" }, "바뀜") : null,
              ),
              h("span", { class: "rt-result muted small" }, shortResult(item.selection, names)),
            );
          })
        : [h("li", { class: "muted rt-empty" }, "해당하는 말이 없어요.")]),
    );
  }

  function renderDetail(run: EvalRun, item: EvalItem, old: EvalItem | undefined) {
    const names = nameIndex(run);
    const sel = item.selection;
    const tr = item.trace;
    const g = APP_GRADE[item.grade.app];
    const goalGrade = item.grade.goal ? GOAL_GRADE[item.grade.goal] : undefined;

    panel.replaceChildren(detail());
    function detail() {
      return h(
        "div",
        {},
        h(
          "header",
          { class: "rt-detail-head" },
          h("h2", {}, item.utterance),
          tr.masked !== item.utterance
            ? h("p", { class: "muted small" }, `jev 에 보낸 말: ${tr.masked}`)
            : null,
          h(
            "div",
            {},
            g ? h("span", { class: `rt-grade ${g.tone}` }, g.text) : null,
            goalGrade ? h("span", { class: `rt-grade ${goalGrade.tone}` }, goalGrade.text) : null,
            h("span", { class: "tag" }, item.source === "real" ? "실제 말" : "만든 말"),
          ),
        ),
        h(
          "dl",
          { class: "rt-facts" },
          h("dt", {}, "정답"),
          h(
            "dd",
            {},
            item.expect.apps.length
              ? item.expect.apps.map((a) => names.app(a)).join(", ")
              : "해당 없음",
            item.expect.goals
              ? h("span", { class: "muted" }, ` · ${item.expect.goals.map(names.goal).join(", ")}`)
              : null,
          ),
          h("dt", {}, "결과"),
          h("dd", {}, resultLine(sel, names)),
          h("dt", {}, "시간·비용"),
          h(
            "dd",
            { class: "muted" },
            `${sel.ms}ms · $${sel.cost.toFixed(6)} · jev ${(tr.app ? 1 : 0) + tr.goals.length}번`,
          ),
        ),
        old ? compareBox(old, item, names) : null,
        routeJudgement({
          selection: sel,
          trace: tr,
          names,
          expectGoals: item.expect.goals,
          before: old?.trace.app ? new Map(old.trace.app.probs) : undefined,
        }),
      );
    }
  }

  render();
  return () => {
    root.removeEventListener("dragover", onDragOver);
    root.removeEventListener("drop", onDrop);
  };
}

// ---------- 조각 ----------

function nameIndex(run: EvalRun): Names {
  return namesFrom({
    apps: run.map.apps.map((a) => [a.id, a.name]),
    roles: run.map.roles.map((r) => [r.id, r.name]),
    goals: run.map.goals.map((g) => [g.id, g.name]),
  });
}

function compareBox(old: EvalItem, now: EvalItem, names: Names) {
  const same = signature(old.selection) === signature(now.selection);
  return h(
    "div",
    { class: `rt-compare ${same ? "" : "changed"}` },
    h("strong", {}, same ? "비교 파일과 같음" : "비교 파일에서는 달랐음"),
    same
      ? null
      : h(
          "div",
          { class: "small" },
          h("div", {}, "이전: ", shortResult(old.selection, names)),
          h("div", {}, "지금: ", shortResult(now.selection, names)),
          old.trace.app?.rule !== now.trace.app?.rule
            ? h(
                "div",
                { class: "muted" },
                `규칙: ${RULE_LABEL[old.trace.app?.rule ?? ""] ?? "–"} → ${RULE_LABEL[now.trace.app?.rule ?? ""] ?? "–"}`,
              )
            : null,
        ),
  );
}

function emptyState() {
  return h(
    "div",
    { class: "rt-empty-state" },
    h("p", {}, "결과 파일을 열거나 이 화면에 끌어 놓으세요."),
    h("p", { class: "muted small" }, "만드는 법 (돈이 드는 jev 호출, 말 98개 × 지도 둘 ≈ $0.02):"),
    h("pre", { class: "mono small" }, "npx tsx scripts/route-eval.ts --out route-eval.json"),
    h(
      "p",
      { class: "muted small" },
      "기준값을 바꾸기 전·후 파일 두 개를 열면 결과가 달라진 말만 볼 수 있어요.",
    ),
  );
}
