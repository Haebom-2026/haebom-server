/**
 * 명령 하나의 단계·끝·Opus 검토·지도 반영 (R3~R5, 서버 src/debug/insight.ts).
 * 명령 기록 패널 아래에 붙어서 열 때 불러온다. 검토는 끝난 뒤 Stream 으로 오므로 다시 불러오기가 있다.
 */
import { api } from "../api.ts";
import { h, time } from "../dom.ts";
import type {
  AppliedView,
  CommandInsightView,
  PendingView,
  ReviewView,
  StepView,
} from "../learn-types.ts";
import { END_LABEL, OUTCOME_LABEL, PENDING_REASON, mapReason, short } from "./learn-labels.ts";

export function commandInsightSection(deviceId: string, commandId: number): HTMLElement {
  const body = h("div", { class: "ci-body" }, h("p", { class: "muted small" }, "불러오는 중…"));
  let token = 0;
  const load = () => {
    const mine = ++token;
    body.classList.add("loading");
    api
      .commandInsight(deviceId, commandId)
      .then((data) => {
        if (mine === token) body.replaceChildren(renderInsight(data));
      })
      .catch((error: unknown) => {
        if (mine !== token) return;
        body.replaceChildren(
          h("p", { class: "error" }, `단계·검토를 못 불러왔어요: ${(error as Error).message}`),
        );
      })
      .finally(() => body.classList.remove("loading"));
  };
  load();
  return h(
    "section",
    { class: "ci" },
    h(
      "header",
      { class: "ci-head" },
      h("h3", {}, "단계 · 끝 · 검토"),
      h(
        "button",
        { class: "link small", onclick: load, title: "검토는 끝난 뒤 조금 있다 와요" },
        "다시 불러오기",
      ),
    ),
    body,
  );
}

const goalName = (data: CommandInsightView, id: string | undefined | null) =>
  id ? (data.names?.goals[id] ? `${data.names.goals[id]} (${id})` : id) : "–";

export function renderInsight(data: CommandInsightView): HTMLElement {
  const c = data.command;
  const progress = c?.mapProgress;
  const facts = h(
    "dl",
    { class: "rt-facts" },
    h("dt", {}, "끝"),
    h(
      "dd",
      {},
      c?.endResult
        ? [
            h("strong", {}, END_LABEL[c.endResult] ?? c.endResult),
            c.endedAt ? h("span", { class: "muted" }, ` · ${time(c.endedAt)}`) : null,
            c.finalAction
              ? h(
                  "span",
                  { class: "muted small" },
                  ` · 마지막 행동 ${c.finalAction.action} "${c.finalAction.text}"`,
                )
              : null,
          ]
        : c
          ? h("span", { class: "muted" }, "아직 끝 신호 없음")
          : h("span", { class: "muted" }, "명령 기록 없음 (24시간 지나 지워졌거나 다른 uid)"),
    ),
    c
      ? [
          h("dt", {}, "고른 것"),
          h(
            "dd",
            {},
            `${c.chosenApp ? (data.names?.apps[c.chosenApp] ?? c.chosenApp) : "–"} › ${goalName(data, c.chosenGoal)}`,
            c.level ? h("span", { class: "tag" }, c.level) : null,
          ),
          h("dt", {}, "지도 안내"),
          h(
            "dd",
            {},
            !progress
              ? h("span", { class: "muted" }, "지도 안 씀 (처음부터 Claude)")
              : progress.mode === "ai"
                ? [h("span", { class: "tag" }, "Claude 로 넘김"), ` ${mapReason(progress.reason)}`]
                : [
                    h("span", { class: "tag map" }, "지도"),
                    ` 마지막 ${progress.kind === "finish" ? `끝 단계 ${Number(progress.ref) + 1}` : `연결선 ${short(progress.ref)}`}`,
                    progress.resends ? ` · 다시 줌 ${progress.resends}` : "",
                  ],
          ),
        ]
      : null,
  );
  return h(
    "div",
    {},
    facts,
    stepsTable(data.steps),
    data.reviews.length
      ? data.reviews.map(({ review }) => reviewBlock(data, review))
      : h(
          "p",
          { class: "muted small" },
          c?.endResult
            ? "검토 없음: 검토 대상이 아닌 끝(포기·멈춤)이거나 아직 Stream 이 처리 중"
            : "검토는 끝 신호(done·stopped_safe) 뒤에 와요",
        ),
    applyBlock(data, data.applied, data.pending),
  );
}

function stepsTable(steps: StepView[]): HTMLElement {
  if (!steps.length)
    return h("p", { class: "muted small" }, "단계 기록 없음 (3일 지나 지워졌거나 guide 요청 없음)");
  return h(
    "table",
    { class: "ci-steps small" },
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", {}, "#"),
        h("th", {}, "시각"),
        h("th", {}, "앞 행동"),
        h("th", {}, "안내"),
        h("th", {}, "화면"),
      ),
    ),
    h(
      "tbody",
      {},
      steps.map((s, i) =>
        h(
          "tr",
          {},
          h("td", {}, String(i + 1)),
          h("td", { class: "mono" }, time(s.receivedAt)),
          h(
            "td",
            {},
            s.lastAction
              ? `${s.lastAction.seq}. ${s.lastAction.action}${s.lastAction.text ? ` "${s.lastAction.text}"` : ""}`
              : h("span", { class: "muted" }, "–"),
          ),
          h(
            "td",
            {},
            h(
              "span",
              { class: `tag ${s.guide.source === "map" ? "map" : ""}` },
              s.guide.source === "map" ? "지도" : "Claude",
            ),
            ` ${s.guide.type}`,
            s.guide.targetText ? ` "${s.guide.targetText}"` : "",
            s.guide.status ? h("span", { class: "muted" }, ` (${s.guide.status})`) : null,
          ),
          h(
            "td",
            { class: "mono muted" },
            s.pkg.split(".").pop() ?? s.pkg,
            s.page?.pageId ? ` · ${s.page.kind} ${short(s.page.pageId)}` : "",
          ),
        ),
      ),
    ),
  );
}

function reviewBlock(data: CommandInsightView, r: ReviewView): HTMLElement {
  const opus = r.opus;
  const outcomeClass = r.outcome === "accept" ? "ok" : r.outcome === "human" ? "warn" : "bad";
  const goal =
    r.goal?.kind === "existing"
      ? goalName(data, r.goal.id)
      : r.goal?.kind === "new"
        ? `새 목표 제안: ${r.goal.proposal?.name ?? "?"} — ${r.goal.proposal?.desc ?? ""}`
        : "없음";
  return h(
    "div",
    { class: "ci-review" },
    h(
      "h4",
      {},
      "Opus 검토 ",
      h("span", { class: `tag ${outcomeClass}` }, OUTCOME_LABEL[r.outcome] ?? r.outcome),
      r.invalidated
        ? h(
            "span",
            { class: "tag bad", title: "끝난 뒤 명령이 바뀌어 낮춤" },
            `무효: ${r.invalidated}`,
          )
        : null,
    ),
    h(
      "dl",
      { class: "rt-facts" },
      r.reasons.length ? [h("dt", {}, "이유"), h("dd", {}, r.reasons.join(", "))] : null,
      h("dt", {}, "성공"),
      h(
        "dd",
        {},
        opus ? h("strong", {}, opus.success) : "–",
        opus?.evidence ? h("span", { class: "muted" }, ` · ${opus.evidence}`) : null,
      ),
      h("dt", {}, "목표"),
      h("dd", {}, goal),
      opus?.moves.length
        ? [
            h("dt", {}, "이동"),
            h("dd", {}, opus.moves.map((m) => `${m.seq}. ${m.action} "${m.text}"`).join(" → ")),
          ]
        : null,
      opus?.finish.length
        ? [
            h("dt", {}, "끝 단계"),
            h(
              "dd",
              {},
              opus.finish.map((f) => `${f.seq}. ${f.action} "${f.text}" (${f.verify})`).join(" → "),
            ),
          ]
        : null,
      opus && (opus.sensitiveSeqs.length || opus.personalText)
        ? [
            h("dt", {}, "주의"),
            h(
              "dd",
              { class: "warn-text" },
              [
                opus.sensitiveSeqs.length ? `민감한 행동 seq ${opus.sensitiveSeqs.join(", ")}` : "",
                opus.personalText ? "개인 글자 남음" : "",
              ]
                .filter(Boolean)
                .join(" · "),
            ),
          ]
        : null,
      h("dt", {}, "후보 연결선"),
      h("dd", {}, `${r.edges.length}개`),
      h("dt", {}, "모델"),
      h(
        "dd",
        { class: "muted small" },
        `${r.model} · ${r.version} · ${time(r.reviewedAt)} · 화면 ${r.stats.screens} · 행동 ${r.stats.actions} · ${Math.round(r.stats.ms / 100) / 10}초${r.stats.inputTokens ? ` · 토큰 ${r.stats.inputTokens}/${r.stats.outputTokens ?? 0}` : ""}`,
      ),
    ),
    h(
      "details",
      { class: "cmd-raw" },
      h("summary", { class: "muted small" }, "검토 원본 (JSON)"),
      h("pre", { class: "json mono small" }, JSON.stringify(r, null, 2)),
    ),
  );
}

function applyBlock(
  data: CommandInsightView,
  applied: AppliedView[],
  pending: PendingView[],
): HTMLElement | null {
  if (!applied.length && !pending.length) {
    return data.reviews.length
      ? h("p", { class: "muted small" }, "지도 반영 없음 (reject·error·성공 아님·가상 기기 등)")
      : null;
  }
  return h(
    "div",
    { class: "ci-apply" },
    h("h4", {}, "지도 반영 (R5)"),
    applied.map((a) =>
      h(
        "p",
        {},
        h("span", { class: "tag ok" }, "증거 넣음"),
        ` 목표 ${goalName(data, a.goalId)} · 연결선 `,
        a.edgeIds.length
          ? a.edgeIds.flatMap((id, i) => [
              i ? ", " : "",
              h("a", { href: `#/learn?focus=${encodeURIComponent(id)}`, class: "mono" }, short(id)),
            ])
          : "없음",
        ` · 도착 화면 `,
        h("span", { class: "mono" }, short(a.arriveFp, 12)),
        h(
          "span",
          { class: "muted small" },
          ` · 기기 ${a.entry.slice(a.entry.lastIndexOf("@") + 1)}`,
        ),
      ),
    ),
    pending.map((p) =>
      h(
        "p",
        {},
        h("span", { class: "tag warn" }, "사람 확인 대기"),
        ` ${p.reasons.map((x) => PENDING_REASON[x] ?? x).join(", ")}`,
        p.proposal ? h("span", { class: "muted" }, ` · 제안 "${p.proposal.name}"`) : null,
        h(
          "div",
          { class: "muted small mono" },
          `넣기: npx tsx scripts/map-seed.ts --uid ${p.uid} --command ${p.commandId} --force --apply`,
        ),
      ),
    ),
  );
}
