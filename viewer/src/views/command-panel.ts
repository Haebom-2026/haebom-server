/**
 * 명령 기록 상세 — classify(안전 분류 + jev 고르기)·앱 선택 (src/debug/command-trace.ts).
 * jev 판정 과정은 고르기 탭과 같은 그림(route-detail.ts)을 쓴다.
 */
import { h, time } from "../dom.ts";
import type {
  ChooseEntryDetail,
  ClassifyEntryDetail,
  CommandBrief,
  CommandEntryDocument,
  MapNames,
} from "../types.ts";
import { FAIL_LABEL, namesFrom, resultLine, routeJudgement, type Names } from "./route-detail.ts";

const LEVELS = ["L0", "L1", "L2", "L3"];
const rank = (level: string | undefined) => LEVELS.indexOf(level ?? "L0");

const namesOf = (names: MapNames | undefined): Names =>
  namesFrom({
    apps: Object.entries(names?.apps ?? {}),
    roles: Object.entries(names?.roles ?? {}),
    goals: Object.entries(names?.goals ?? {}),
  });

/** 목록 한 줄의 결과 글자 */
export function commandSummary(command: CommandBrief): string {
  if (command.kind === "choose") {
    return `앱 선택: ${command.appName ?? command.appId ?? "–"}${command.goal ? ` › ${command.goal}` : ""}`;
  }
  const said = command.utterance ? `"${command.utterance}" ` : "";
  switch (command.route) {
    case "route":
      return `${said}→ ${(command.candidates ?? []).join(", ")}${command.goal ? ` › ${command.goal}` : ""}`;
    case "ask_intent":
      return `${said}→ ? 하려는 일 물음`;
    case "fail":
      return `${said}→ ✕ ${FAIL_LABEL[command.routeReason ?? ""] ?? command.routeReason ?? "실패"}`;
    default:
      return `${said}→ jev 꺼짐`;
  }
}

export function renderCommand(doc: CommandEntryDocument): HTMLElement {
  const detail = doc.detail;
  const head = h(
    "header",
    { class: "cmd-head" },
    h(
      "div",
      { class: "muted small" },
      `명령 #${doc.command.commandId} · ${detail.kind === "classify" ? "classify (#17)" : "앱 선택"} · ${time(doc.receivedAt)}`,
    ),
  );
  const body = detail.kind === "classify" ? classifyBody(detail) : chooseBody(detail);
  return h(
    "div",
    { class: "cmd-panel" },
    head,
    body,
    h(
      "details",
      { class: "cmd-raw" },
      h("summary", { class: "muted small" }, "원본 기록 (JSON)"),
      h("pre", { class: "json mono small" }, JSON.stringify(detail, null, 2)),
    ),
  );
}

function classifyBody(d: ClassifyEntryDetail): HTMLElement {
  const names = namesOf(d.names);
  const out = d.safety.output;
  const rule = d.request.ruleLevel;
  const base = rank(out?.level) > rank(rule) ? (out?.level ?? rule) : rule;
  const final = d.response.sensitivity.level;
  const sel = d.selection;
  const goalLevels =
    sel?.kind === "route"
      ? sel.candidates.flatMap((c) => (c.goal?.verified ? [`${c.goal.name} ${c.goal.level}`] : []))
      : [];
  const raised =
    rank(final) > rank(base)
      ? d.response.sensitivity.category === "scam"
        ? "사기 의심 → L3"
        : d.request.signals.length
          ? `상황 신호(${d.request.signals.join(", ")})로 한 단계`
          : goalLevels.length
            ? `검증된 목표(${goalLevels.join(", ")})로 올림`
            : "올림"
      : "";
  const sent = d.response.route
    ? `후보 ${d.response.route.candidates.map((c) => c.name).join(", ")}`
    : d.response.clarify
      ? `질문 "${d.response.clarify.say}"`
      : sel
        ? "후보 없음 (Claude 안내)"
        : "jev 꺼짐";

  return h(
    "div",
    {},
    h("h2", { class: "cmd-utter" }, d.request.utterance),
    h(
      "dl",
      { class: "rt-facts" },
      h("dt", {}, "안전 분류"),
      h(
        "dd",
        {},
        d.safety.status === "ok" && out
          ? [
              `${out.level} · ${out.category} · ${out.intent}`,
              h("span", { class: "muted" }, ` · "${out.reason}"`),
            ]
          : h("span", { class: "warn-text" }, `실패 (${d.safety.status}) → 규칙만 (degraded)`),
        h(
          "span",
          { class: "muted small" },
          ` · ${d.safety.promptVersion}${d.safety.inputTokens ? ` · 토큰 ${d.safety.inputTokens}/${d.safety.outputTokens ?? 0}` : ""}`,
        ),
      ),
      h("dt", {}, "단계"),
      h(
        "dd",
        {},
        `규칙 ${rule}${d.request.ruleApp ? ` (${d.request.ruleApp})` : ""} · 안전 분류 ${out?.level ?? "–"} → `,
        h("strong", {}, final),
        raised ? h("span", { class: "tag warn" }, raised) : null,
      ),
      h("dt", {}, "jev"),
      h("dd", {}, sel ? resultLine(sel, names) : "꺼짐 (ROUTE_ENABLED)"),
      h("dt", {}, "앱에 보냄"),
      h(
        "dd",
        {},
        sent,
        !d.response.route && sel?.kind === "route"
          ? h("span", { class: "muted small" }, " (사기 의심·L3·degraded 라 후보를 빼고 보냄)")
          : null,
      ),
      h("dt", {}, "시간"),
      h(
        "dd",
        { class: "muted" },
        `${d.ms}ms${sel ? ` (jev ${sel.ms}ms · $${sel.cost.toFixed(6)})` : ""} · 저장 ${d.saved}`,
      ),
    ),
    sel && d.trace
      ? routeJudgement({ selection: sel, trace: d.trace, names })
      : sel?.kind === "fail" && sel.reason.startsWith("jev_")
        ? h("p", { class: "error" }, `jev 호출 실패: ${FAIL_LABEL[sel.reason] ?? sel.reason}`)
        : null,
  );
}

function chooseBody(d: ChooseEntryDetail): HTMLElement {
  const names = namesOf(d.names);
  const answer = d.body.answer;
  return h(
    "div",
    {},
    h(
      "h2",
      { class: "cmd-utter" },
      answer
        ? `질문 답: ${answer.questionId === "intent" ? names.role(answer.option) : names.goal(answer.option)}`
        : `앱 선택: ${names.app(d.body.appId ?? "–")}`,
    ),
    h(
      "dl",
      { class: "rt-facts" },
      d.body.appId ? [h("dt", {}, "폰이 고른 앱"), h("dd", {}, names.app(d.body.appId))] : null,
      d.body.installState
        ? [
            h("dt", {}, "설치 확인"),
            h(
              "dd",
              {},
              d.body.installState,
              d.body.askedUser ? h("span", { class: "muted" }, " · 어르신께 물어봄") : null,
            ),
          ]
        : null,
      answer ? [h("dt", {}, "질문"), h("dd", {}, `${answer.questionId} → ${answer.option}`)] : null,
      h("dt", {}, "목표"),
      h("dd", {}, d.response.goal ? names.goal(d.response.goal.id) : "–"),
      h("dt", {}, "단계"),
      h("dd", {}, d.response.sensitivity.level),
      d.response.route
        ? [
            h("dt", {}, "다시 매긴 후보"),
            h("dd", {}, d.response.route.candidates.map((c) => c.name).join(", ")),
          ]
        : null,
    ),
  );
}
