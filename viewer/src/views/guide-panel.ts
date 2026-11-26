/** guide 요청 상세 — 앱 요청, AI 입력·원래 출력, 최종 응답 (src/debug/guide-trace.ts) */
import { h } from "../dom.ts";
import type { GuideRecord } from "../types.ts";

const json = (value: unknown) =>
  h("pre", { class: "json mono small" }, JSON.stringify(value, null, 2));

function row(label: string, ...value: (Node | string | number | null | undefined)[]) {
  return [h("dt", {}, label), h("dd", {}, ...value)];
}

/** 모델 출력과 최종 응답이 다르면(서버 후처리로 낮춤 등) 무엇이 달라졌는지 */
function changes(guide: GuideRecord): string[] {
  const out = guide.ai?.output;
  const res = guide.response;
  if (!out || !res) return [];
  const diff: string[] = [];
  if (out.type !== res.type) diff.push(`type ${String(out.type)} → ${String(res.type)}`);
  if ((out.target ?? undefined) !== res.target)
    diff.push(`target ${String(out.target)} → ${String(res.target ?? "없음")}`);
  if (typeof out.say === "string" && out.say.trim() !== res.say) diff.push("say 고침/자름");
  return diff;
}

export function renderGuide(guide: GuideRecord): HTMLElement {
  const { request = {}, ai = {}, response = {} } = guide;
  const usage = ai.usage;
  const diff = changes(guide);
  const statusClass = ai.status === "ok" ? "" : " warn";

  return h(
    "section",
    { class: "guide-detail" },
    h(
      "div",
      { class: "guide-head" },
      h("strong", {}, "AI 안내 "),
      h("span", { class: "tag" }, String(response.type ?? guide.type ?? "")),
      response.target !== undefined
        ? h("span", { class: "mono" }, ` #${String(response.target)}`)
        : null,
      response.targetText ? h("span", {}, ` "${String(response.targetText)}"`) : null,
      h("span", {}, ` “${String(response.say ?? guide.say ?? "")}”`),
      diff.length ? h("span", { class: "tag warn", title: diff.join(", ") }, "서버가 고침") : null,
    ),
    h(
      "div",
      { class: "guide-grid" },
      h(
        "div",
        {},
        h("h4", {}, "앱 요청"),
        h(
          "dl",
          {},
          row("requestId", h("span", { class: "mono" }, String(request.requestId ?? ""))),
          row("goal", h("span", { class: "mono" }, request.goal ?? "")),
          row("한 말", request.utterance || h("span", { class: "muted" }, "(없음)")),
          row(
            "slots",
            request.slots && Object.keys(request.slots).length
              ? h("span", { class: "mono" }, JSON.stringify(request.slots))
              : h("span", { class: "muted" }, "(없음)"),
          ),
          row(
            "history",
            request.history?.length
              ? h(
                  "ol",
                  { class: "history" },
                  request.history.map((line) => h("li", {}, line)),
                )
              : h("span", { class: "muted" }, "(없음)"),
          ),
        ),
      ),
      h(
        "div",
        {},
        h("h4", {}, "AI 호출"),
        h(
          "dl",
          {},
          row(
            "모델",
            h("span", { class: "mono" }, `${ai.model ?? ""} · ${ai.promptVersion ?? ""}`),
          ),
          ai.skipped
            ? row("결과", h("span", { class: "tag warn" }, `모델 호출 안 함: ${ai.skipped}`))
            : row(
                "결과",
                h("span", { class: `tag${statusClass}` }, ai.status ?? ""),
                ai.stopReason ? h("span", { class: "muted small" }, ` ${ai.stopReason}`) : null,
                ai.error ? h("span", { class: "tag warn" }, ai.error) : null,
              ),
          row("지연", ai.latencyMs !== undefined ? `${ai.latencyMs}ms` : "-"),
          row(
            "토큰",
            usage
              ? h(
                  "span",
                  { class: "mono small" },
                  `입력 ${usage.inputTokens ?? 0} · 출력 ${usage.outputTokens ?? 0} · 캐시 읽기 ${usage.cacheReadTokens ?? 0} · 캐시 쓰기 ${usage.cacheWriteTokens ?? 0}`,
                )
              : "-",
          ),
          row("마스킹", String(ai.masked ?? 0)),
          diff.length
            ? row("서버 후처리", h("span", { class: "warn-text" }, diff.join(", ")))
            : null,
        ),
      ),
    ),
    h(
      "div",
      { class: "guide-grid" },
      h(
        "div",
        {},
        h("h4", {}, "모델 원래 출력"),
        ai.output ? json(ai.output) : h("p", { class: "muted" }, "(없음)"),
      ),
      h("div", {}, h("h4", {}, "앱에 보낸 응답"), json(response)),
    ),
    ai.input
      ? h(
          "details",
          { class: "guide-input" },
          h("summary", {}, "AI 에 보낸 입력 전체 (마스킹 후, 위치 %·상태 포함)"),
          json(ai.input),
        )
      : null,
  );
}
