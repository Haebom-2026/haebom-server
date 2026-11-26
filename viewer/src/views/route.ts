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

const FAIL_LABEL: Record<string, string> = {
  none: "해당 없음",
  low: "기준 미달",
  named_mismatch: "말한 앱 ≠ jev 1등",
  unknown_app: "지도 밖 앱 이름",
  named_ambiguous: "앱 이름이 둘",
  jev_timeout: "jev 시간 초과",
  jev_http: "jev HTTP 오류",
  jev_invalid: "jev 응답 형식 오류",
  jev_network: "jev 네트워크 오류",
};

const BY_LABEL: Record<string, string> = {
  named: "말한 앱",
  jev: "jev",
  pref: "평소 쓰던 앱",
  default: "기본 앱",
};

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

/** 1단계 판정 순서 (decide.ts judgeApp, 기획 4.2) */
const STEPS: { title: string; rules: string[] }[] = [
  { title: "'해당 없음' ≥ 1등 앱 → 실패", rules: ["none"] },
  {
    title: "말에 앱 이름 (별칭)",
    rules: ["named", "named_appstore", "named_mismatch", "unknown_app", "named_ambiguous"],
  },
  { title: "두 역할이 비슷 → 하려는 일 물음", rules: ["ask_intent"] },
  { title: "1등 앱 ≥ exclusive → 그 앱만", rules: ["exclusive"] },
  { title: "1등 앱 ≥ app → 그 앱 + 같은 역할 앱", rules: ["top_app"] },
  { title: "역할 합계 ≥ role", rules: ["role_sum"] },
  { title: "두 역할이 같은 1등 앱에서 나옴", rules: ["shared_roles"] },
  { title: "그 밖 → 실패", rules: ["low"] },
];

const RULE_LABEL: Record<string, string> = {
  ...FAIL_LABEL,
  named: "말한 앱 = 1등",
  named_appstore: "깔기·지우기 → Play 스토어",
  ask_intent: "하려는 일 물음",
  exclusive: "그 앱만",
  top_app: "1등 앱 + 같은 역할",
  role_sum: "역할 합계",
  shared_roles: "같은 앱의 두 역할",
};

// ---------- 계산 ----------

const pct = (a: number, b: number) => (b === 0 ? "–" : `${((a / b) * 100).toFixed(1)}%`);
const p2 = (p: number) => p.toFixed(2);

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
    const t = tr.thresholds;
    const candidates = sel.kind === "route" ? new Set(sel.candidates.map((c) => c.appId)) : null;

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
        h("h3", { class: "small-title" }, "1단계 규칙"),
        ruleSteps(item, names),
        tr.app
          ? h(
              "div",
              {},
              h("h3", { class: "small-title" }, "1단계 앱 확률"),
              tr.app.ok
                ? bars(
                    withNone(tr.app.probs, 8),
                    (id) => (id === "none" ? "해당 없음" : names.app(id)),
                    [
                      { at: t.app ?? 0.5, label: "app" },
                      { at: t.exclusive ?? 0.9, label: "exclusive" },
                    ],
                    (id) => (id === "none" ? "none" : candidates?.has(id) ? "pick" : ""),
                    old?.trace.app ? new Map(old.trace.app.probs) : undefined,
                  )
                : h("p", { class: "error" }, `jev 실패: ${tr.app.reason ?? "?"}`),
              tr.app.roles.length
                ? [
                    h("h3", { class: "small-title" }, "역할 합계"),
                    bars(
                      tr.app.roles.slice(0, 5),
                      (id) => names.role(id),
                      [
                        { at: t.intentMin ?? 0.25, label: "intentMin" },
                        { at: t.role ?? 0.5, label: "role" },
                      ],
                      (id) => (sel.kind === "route" && sel.role === id ? "pick" : ""),
                    ),
                  ]
                : null,
            )
          : null,
        sel.kind === "route" ? candidateTable(sel, names) : null,
        tr.goals.length
          ? h(
              "div",
              {},
              h("h3", { class: "small-title" }, "2단계 목표 확률"),
              tr.goals.map((stage) =>
                h(
                  "div",
                  { class: "rt-goal" },
                  h(
                    "div",
                    { class: "small" },
                    h("strong", {}, names.app(stage.appId)),
                    h(
                      "span",
                      { class: "muted" },
                      stage.ok
                        ? ` · ${stage.judged === "goal" ? "목표 정함" : stage.judged === "ask" ? "두 목표가 비슷 → 물음" : "목표 없음 → 앱만"}`
                        : ` · jev 실패 (${stage.reason ?? "?"}) → 앱만`,
                    ),
                  ),
                  stage.ok
                    ? bars(
                        withNone(stage.probs, 5),
                        (id) => (id === "none" ? "어느 것도 아님" : names.goal(id)),
                        [
                          { at: t.goalAskMin ?? 0.3, label: "goalAskMin" },
                          { at: t.goal ?? 0.7, label: "goal" },
                        ],
                        (id) =>
                          id === "none" ? "none" : item.expect.goals?.includes(id) ? "expect" : "",
                      )
                    : null,
                ),
              ),
            )
          : null,
        h(
          "p",
          { class: "muted small rt-legend" },
          h("span", { class: "rt-key pick" }),
          " 후보·고른 것 ",
          h("span", { class: "rt-key expect" }),
          " 정답 목표 ",
          h("span", { class: "rt-key none" }),
          " 해당 없음 · 세로줄 = 기준값",
        ),
      );
    }
  }

  function ruleSteps(item: EvalItem, names: Names) {
    const tr = item.trace.app;
    const rule = tr?.rule;
    const firedAt = STEPS.findIndex((s) => rule !== undefined && s.rules.includes(rule));
    if (!tr?.ok || firedAt < 0)
      return h("p", { class: "muted small" }, "jev 가 답하지 않아 1단계 판정을 하지 않았어요.");
    const top = tr.probs.find(([id]) => id !== "none");
    const none = tr.probs.find(([id]) => id === "none")?.[1] ?? 0;
    const [r1, r2] = tr.roles;
    const t = item.trace.thresholds;
    const detail = (i: number): string => {
      switch (i) {
        case 0:
          return `해당 없음 ${p2(none)} vs 1등 ${top ? `${names.app(top[0])} ${p2(top[1])}` : "–"}`;
        case 1:
          return tr.mention.kind === "none"
            ? "앱 이름 없음"
            : tr.mention.kind === "ambiguous"
              ? "같은 길이 이름이 둘"
              : `"${tr.mention.text}"${tr.mention.kind === "map" ? ` → ${names.app(tr.mention.appId)}` : " (지도 밖)"}`;
        case 2:
          return r1 && r2
            ? `${names.role(r1[0])} ${p2(r1[1])} / ${names.role(r2[0])} ${p2(r2[1])} (둘 다 ≥ ${t.intentMin ?? 0.25}, 차이 < ${t.intentGap ?? 0.2})`
            : "역할이 하나";
        case 3:
        case 4:
          return top
            ? `1등 ${p2(top[1])} (기준 ${i === 3 ? (t.exclusive ?? 0.9) : (t.app ?? 0.5)})`
            : "";
        case 5:
          return r1 ? `${names.role(r1[0])} ${p2(r1[1])} (기준 ${t.role ?? 0.5})` : "";
        default:
          return "";
      }
    };
    return h(
      "ol",
      { class: "rt-steps" },
      STEPS.map((step, i) =>
        h(
          "li",
          { class: i < firedAt ? "passed" : i === firedAt ? "fired" : "after" },
          h("span", {}, step.title),
          i <= firedAt ? h("span", { class: "muted small" }, detail(i)) : null,
          i === firedAt && rule ? h("span", { class: "rt-rule" }, RULE_LABEL[rule] ?? rule) : null,
        ),
      ),
    );
  }

  render();
  return () => {
    root.removeEventListener("dragover", onDragOver);
    root.removeEventListener("drop", onDrop);
  };
}

// ---------- 조각 ----------

interface Names {
  app: (id: string) => string;
  role: (id: string) => string;
  goal: (id: string) => string;
}

function nameIndex(run: EvalRun): Names {
  const apps = new Map(run.map.apps.map((a) => [a.id, a.name]));
  const roles = new Map(run.map.roles.map((r) => [r.id, r.name]));
  const goals = new Map(run.map.goals.map((g) => [g.id, g.name]));
  return {
    app: (id) => apps.get(id) ?? id,
    role: (id) => roles.get(id) ?? id,
    goal: (id) => (goals.has(id) ? `${goals.get(id)} (${id})` : id),
  };
}

function shortResult(sel: RouteSelection, names: Names): string {
  if (sel.kind === "fail") return `✕ ${FAIL_LABEL[sel.reason] ?? sel.reason}`;
  if (sel.kind === "ask_intent") return `? ${sel.clarify.options.map((o) => o.name).join(" / ")}`;
  return sel.candidates
    .map((c) => {
      const goal = c.goal ? ` › ${c.goal.name}` : c.clarify ? " › ?" : "";
      return `${names.app(c.appId)}${goal}`;
    })
    .join(", ");
}

function resultLine(sel: RouteSelection, names: Names): (Node | string)[] {
  if (sel.kind === "fail") return [`실패 — ${FAIL_LABEL[sel.reason] ?? sel.reason}`];
  if (sel.kind === "ask_intent") return [`하려는 일 물음: "${sel.clarify.say}"`];
  const flags = [
    sel.named ? "말한 앱" : "",
    sel.exclusive ? "그 앱만 (없으면 설치를 물음)" : "",
    sel.ask ? "민감한 역할 → 폰에서 물음" : "",
    sel.mentionedApp ? `말한 앱 이름: ${sel.mentionedApp}` : "",
  ].filter(Boolean);
  return [
    `후보 ${sel.candidates.length}개 · 역할 ${names.role(sel.role)}`,
    flags.length ? h("span", { class: "muted" }, ` · ${flags.join(" · ")}`) : "",
  ];
}

function candidateTable(sel: Extract<RouteSelection, { kind: "route" }>, names: Names) {
  return [
    h("h3", { class: "small-title" }, "후보 (폰이 깔린 첫 번째를 씀)"),
    h(
      "table",
      { class: "pkg-table" },
      h(
        "tr",
        {},
        h("th", {}, "#"),
        h("th", {}, "앱"),
        h("th", {}, "왜"),
        h("th", {}, "민감도"),
        h("th", {}, "목표"),
      ),
      sel.candidates.map((c, i) =>
        h(
          "tr",
          {},
          h("td", {}, String(i + 1)),
          h("td", {}, names.app(c.appId)),
          h("td", { class: "muted" }, BY_LABEL[c.by] ?? c.by),
          h("td", {}, c.level),
          h(
            "td",
            {},
            c.goal
              ? [
                  c.goal.name,
                  h(
                    "span",
                    { class: "muted small" },
                    ` ${c.goal.id} · ${p2(c.goal.confidence)}${c.goal.verified ? "" : " · 후보"}`,
                  ),
                ]
              : c.clarify
                ? h("span", { class: "muted" }, `물음: "${c.clarify.say}"`)
                : h("span", { class: "muted" }, "앱만"),
          ),
        ),
      ),
    ),
  ];
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

/** 위에서 n개 + '해당 없음'은 순위 밖이어도 늘 보임 */
function withNone(probs: [string, number][], n: number): [string, number][] {
  const top = probs.slice(0, n);
  const none = probs.find(([id]) => id === "none");
  if (none && !top.some(([id]) => id === "none")) top.push(none);
  return top;
}

function bars(
  rows: [string, number][],
  label: (id: string) => string,
  marks: { at: number; label: string }[],
  kind: (id: string) => string,
  before?: Map<string, number>,
) {
  return h(
    "div",
    { class: "rt-bars" },
    rows.map(([id, p]) => {
      const prev = before?.get(id);
      return h(
        "div",
        { class: `rt-bar ${kind(id)}` },
        h("span", { class: "rt-bar-label", title: id }, label(id)),
        h(
          "span",
          { class: "rt-bar-track" },
          h("span", { class: "rt-bar-fill", style: `width:${(p * 100).toFixed(1)}%` }),
          prev !== undefined
            ? h("span", {
                class: "rt-bar-prev",
                style: `left:${(prev * 100).toFixed(1)}%`,
                title: `비교 파일 ${p2(prev)}`,
              })
            : null,
          marks.map((m) =>
            h("span", {
              class: "rt-bar-mark",
              style: `left:${m.at * 100}%`,
              title: `${m.label} ${m.at}`,
            }),
          ),
        ),
        h("span", { class: "rt-bar-num" }, p2(p)),
      );
    }),
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
