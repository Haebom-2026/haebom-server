/**
 * jev 고르기 판정 과정 그리기 — 고르기 탭(eval 결과)과 기기 화면(실시간 classify)이 같이 쓴다.
 * 1단계 규칙 8단계, 앱 확률·역할 합계 막대, 후보 표, 2단계 목표 확률.
 */
import { h } from "../dom.ts";
import type { RouteSelection, RouteTrace } from "../route-types.ts";

export interface Names {
  app: (id: string) => string;
  role: (id: string) => string;
  goal: (id: string) => string;
}

/** id → 이름 표에서 Names (없는 id 는 그대로) */
export function namesFrom(maps: {
  apps: Iterable<[string, string]>;
  roles: Iterable<[string, string]>;
  goals: Iterable<[string, string]>;
}): Names {
  const apps = new Map(maps.apps);
  const roles = new Map(maps.roles);
  const goals = new Map(maps.goals);
  return {
    app: (id) => apps.get(id) ?? id,
    role: (id) => roles.get(id) ?? id,
    goal: (id) => (goals.has(id) ? `${goals.get(id)} (${id})` : id),
  };
}

export const FAIL_LABEL: Record<string, string> = {
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

export const RULE_LABEL: Record<string, string> = {
  ...FAIL_LABEL,
  named: "말한 앱 = 1등",
  named_appstore: "깔기·지우기 → Play 스토어",
  ask_intent: "하려는 일 물음",
  exclusive: "그 앱만",
  top_app: "1등 앱 + 같은 역할",
  role_sum: "역할 합계",
  shared_roles: "같은 앱의 두 역할",
  role_answer: "질문 답(역할)으로 다시 매김",
};

export const p2 = (p: number) => p.toFixed(2);

export function shortResult(sel: RouteSelection, names: Names): string {
  if (sel.kind === "fail") return `✕ ${FAIL_LABEL[sel.reason] ?? sel.reason}`;
  if (sel.kind === "ask_intent") return `? ${sel.clarify.options.map((o) => o.name).join(" / ")}`;
  return sel.candidates
    .map((c) => {
      const goal = c.goal ? ` › ${c.goal.name}` : c.clarify ? " › ?" : "";
      return `${names.app(c.appId)}${goal}`;
    })
    .join(", ");
}

export function resultLine(sel: RouteSelection, names: Names): (Node | string)[] {
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
  return h(
    "div",
    {},
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
                    ` ${c.goal.id}${c.goal.confidence === undefined ? "" : ` · ${p2(c.goal.confidence)}`}${c.goal.verified ? "" : " · 후보"}`,
                  ),
                ]
              : c.clarify
                ? h("span", { class: "muted" }, `물음: "${c.clarify.say}"`)
                : h("span", { class: "muted" }, "앱만"),
          ),
        ),
      ),
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

function ruleSteps(trace: RouteTrace, names: Names) {
  const tr = trace.app;
  const rule = tr?.rule;
  if (tr?.ok && rule === "role_answer")
    return h(
      "p",
      { class: "small" },
      "어르신이 하려는 일 질문에 답한 역할로 후보를 다시 매겼어요 (1단계 규칙을 타지 않음).",
    );
  const firedAt = STEPS.findIndex((s) => rule !== undefined && s.rules.includes(rule));
  if (!tr?.ok || firedAt < 0)
    return h("p", { class: "muted small" }, "jev 가 답하지 않아 1단계 판정을 하지 않았어요.");
  const top = tr.probs.find(([id]) => id !== "none");
  const none = tr.probs.find(([id]) => id === "none")?.[1] ?? 0;
  const [r1, r2] = tr.roles;
  const t = trace.thresholds;
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

/** 1단계 규칙부터 2단계 목표 확률까지 (결과 한 줄·머리는 부르는 쪽이 그림) */
export function routeJudgement(opts: {
  selection: RouteSelection;
  trace: RouteTrace;
  names: Names;
  /** 정답 목표 (eval). 있으면 초록으로 */
  expectGoals?: string[] | undefined;
  /** 비교 파일의 1단계 확률 (eval 비교) */
  before?: Map<string, number> | undefined;
}): HTMLElement {
  const { selection: sel, trace: tr, names } = opts;
  const t = tr.thresholds;
  const candidates = sel.kind === "route" ? new Set(sel.candidates.map((c) => c.appId)) : null;
  return h(
    "div",
    { class: "rt-judgement" },
    h("h3", { class: "small-title" }, "1단계 규칙"),
    ruleSteps(tr, names),
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
                opts.before,
              )
            : h("p", { class: "error" }, `jev 실패: ${tr.app.reason ?? "?"}`),
          tr.app.roles.length
            ? h(
                "div",
                {},
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
              )
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
                      id === "none" ? "none" : opts.expectGoals?.includes(id) ? "expect" : "",
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
      opts.expectGoals ? [h("span", { class: "rt-key expect" }), " 정답 목표 "] : null,
      h("span", { class: "rt-key none" }),
      " 해당 없음 · 세로줄 = 기준값",
    ),
  );
}
