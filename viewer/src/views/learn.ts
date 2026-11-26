/**
 * 배운 지도 (R4·R5, 서버 GET /v1/dev/map): 지도 안내가 쓰는 연결선·목표와 자동 반영 상태.
 * 읽기만 한다. 승인·버리기·차단은 scripts/map-seed.ts·map-pending.ts·map-block.ts.
 */
import { api } from "../api.ts";
import { ago, h, time } from "../dom.ts";
import type {
  LearnedArrive,
  LearnedBase,
  LearnedEdge,
  LearnedGoal,
  LearnedMapView,
} from "../learn-types.ts";
import { PENDING_REASON, STATUS_LABEL, recentLine, short } from "./learn-labels.ts";

const REQUIRED_DEVICES = 2;
const REFRESH_MS = 15_000;

type Filter = "all" | "verified" | "candidate";

export function learnView(root: HTMLElement, focus?: string): () => void {
  let data: LearnedMapView | undefined;
  let filter: Filter = "all";
  let disposed = false;
  let focused = focus;

  const status = h("span", { class: "muted small" }, "불러오는 중…");
  const body = h("div", { class: "learn-body" });
  const filters = h(
    "span",
    { class: "learn-filters" },
    (["all", "verified", "candidate"] as const).map((f) =>
      h(
        "button",
        {
          class: `chip${f === filter ? " active" : ""}`,
          "data-filter": f,
          onclick: () => {
            filter = f;
            for (const b of filters.querySelectorAll("button"))
              b.classList.toggle("active", b.dataset.filter === f);
            render();
          },
        },
        f === "all" ? "모두" : f === "verified" ? "verified" : "후보",
      ),
    ),
  );

  root.append(
    h(
      "section",
      { class: "page learn" },
      h(
        "header",
        { class: "learn-head" },
        h("h1", {}, "배운 지도"),
        filters,
        h("button", { class: "link small", onclick: () => void load() }, "새로 고침"),
        status,
      ),
      h(
        "p",
        { class: "muted small" },
        `지도 안내는 verified 만 써요. 후보는 서로 다른 기기 ${REQUIRED_DEVICES}대의 성공이 모이면 verified, 최근 20번 중 실패가 30%를 넘으면 후보로 내려가요. 승인·차단은 scripts/map-*.ts.`,
      ),
      body,
    ),
  );

  async function load() {
    try {
      const next = await api.learnedMap();
      if (disposed) return;
      data = next;
      status.textContent = `${time(next.serverTime)} 기준 · ${REFRESH_MS / 1000}초마다`;
      render();
    } catch (error) {
      if (!disposed) status.textContent = `못 불러왔어요: ${(error as Error).message}`;
    }
  }

  function render() {
    if (!data) return;
    const d = data;
    const keep = (x: LearnedBase) => filter === "all" || x.status === filter;
    const goals = d.goals.filter(keep).sort(byStatusThenRecent);
    const edges = d.edges.filter(keep).sort(byStatusThenRecent);
    body.replaceChildren(
      summary(d),
      d.pending.length ? pendingSection(d) : "",
      h("h2", {}, `목표 ${goals.length}`),
      goals.length
        ? h(
            "div",
            { class: "learn-goals" },
            goals.map((g) => goalCard(d, g)),
          )
        : h("p", { class: "muted" }, "목표가 없어요."),
      h("h2", {}, `연결선 ${edges.length}`),
      edges.length ? edgeTable(d, edges) : h("p", { class: "muted" }, "연결선이 없어요."),
      d.applied.length
        ? h(
            "details",
            { class: "learn-applied" },
            h("summary", {}, `반영 기록 ${d.applied.length}개 (명령마다 어디에 증거를 넣었나)`),
            h(
              "ul",
              { class: "small mono" },
              d.applied.map((a) =>
                h(
                  "li",
                  {},
                  `${a.uid} #${a.commandId} → ${goalLabel(d, a.goalId)} · 연결선 ${a.edgeIds.map((e) => short(e)).join(", ") || "없음"} · 도착 ${short(a.arriveFp, 12)} · @${a.entry.slice(a.entry.lastIndexOf("@") + 1)}`,
                ),
              ),
            ),
          )
        : "",
    );
    if (focused) {
      const row = body.querySelector<HTMLElement>(`[data-id="${CSS.escape(focused)}"]`);
      if (row) {
        row.classList.add("focus");
        row.scrollIntoView({ block: "center" });
      }
      focused = undefined;
    }
  }

  void load();
  const timer = window.setInterval(() => {
    if (document.visibilityState === "visible") void load();
  }, REFRESH_MS);
  return () => {
    disposed = true;
    window.clearInterval(timer);
  };
}

const rank = (s: string | undefined) => (s === "verified" ? 0 : s === "candidate" ? 1 : 2);
const lastAt = (x: LearnedBase) => x.lastUsedAt ?? x.updatedAt ?? x.createdAt ?? "";
const byStatusThenRecent = (a: LearnedBase, b: LearnedBase) =>
  rank(a.status) - rank(b.status) || lastAt(b).localeCompare(lastAt(a));

const goalLabel = (d: LearnedMapView, id: string) => d.names?.goals[id] ?? id;

function summary(d: LearnedMapView): HTMLElement {
  const count = (xs: LearnedBase[], s: string) => xs.filter((x) => x.status === s).length;
  return h(
    "p",
    { class: "learn-summary" },
    `목표 verified ${count(d.goals, "verified")} · 후보 ${count(d.goals, "candidate")}`,
    ` │ 연결선 verified ${count(d.edges, "verified")} · 후보 ${count(d.edges, "candidate")}`,
    ` │ 대기 ${d.pending.length}`,
    d.block.edgeIds.length || d.block.goalIds.length
      ? h(
          "span",
          { class: "tag bad" },
          `긴급 차단: 연결선 ${d.block.edgeIds.length} · 목표 ${d.block.goalIds.length}`,
        )
      : null,
  );
}

function statusTags(
  x: LearnedBase & { stale?: boolean; cleanupArrivals?: string },
  blocked: boolean,
): (HTMLElement | null)[] {
  return [
    h(
      "span",
      { class: `tag ${x.status === "verified" ? "ok" : x.status === "candidate" ? "warn" : ""}` },
      STATUS_LABEL[x.status ?? ""] ?? x.status ?? "?",
    ),
    x.origin === "seed" ? h("span", { class: "tag", title: "사람이 승인해 넣음" }, "seed") : null,
    blocked ? h("span", { class: "tag bad" }, "차단") : null,
    x.stale ? h("span", { class: "tag", title: "90일 안 쓰여 안내에 안 씀" }, "90일") : null,
    x.demotedAt
      ? h(
          "span",
          { class: "tag bad", title: `내려간 때 ${x.demotedAt}` },
          `내려감 ${ago(x.demotedAt)}`,
        )
      : null,
    x.cleanupArrivals
      ? h("span", { class: "tag warn", title: "도착 화면 정리 중" }, "정리 중")
      : null,
  ];
}

/** 증거 기기 수 (verified 가 되려면 REQUIRED_DEVICES) */
function deviceCount(x: LearnedBase): HTMLElement {
  const n = x.devices?.length ?? 0;
  const seed = (x.evidence ?? []).some((e) => e.endsWith("@seed"));
  return h(
    "span",
    {
      class: n >= REQUIRED_DEVICES || seed ? "" : "warn-text",
      title: (x.devices ?? []).join(", "),
    },
    `${n}/${REQUIRED_DEVICES}`,
    seed ? " +seed" : "",
  );
}

function evidenceList(x: LearnedBase): HTMLElement | null {
  const now = x.evidence ?? [];
  const old = x.oldEvidence ?? [];
  if (!now.length && !old.length) return null;
  return h(
    "details",
    { class: "learn-evidence" },
    h(
      "summary",
      { class: "muted small" },
      `증거 ${now.length}${old.length ? ` · 옛 증거 ${old.length}` : ""}`,
    ),
    h(
      "ul",
      { class: "mono small" },
      now.map((e) => h("li", {}, e)),
      old.map((e) => h("li", { class: "muted" }, `(옛) ${e}`)),
    ),
  );
}

function goalCard(d: LearnedMapView, g: LearnedGoal): HTMLElement {
  const arrives = d.arrives.filter(
    (a) => a.goalId === g.goalId || a.SK.startsWith(`ARRIVE#${g.goalId}#`),
  );
  const used = new Set(g.arriveFps ?? []);
  return h(
    "article",
    { class: "learn-goal", "data-id": g.goalId },
    h(
      "header",
      {},
      h("strong", {}, goalLabel(d, g.goalId)),
      h("span", { class: "mono muted small" }, ` ${g.goalId}`),
      ...statusTags(g, d.block.goalIds.includes(g.goalId)),
    ),
    h(
      "dl",
      { class: "rt-facts small" },
      h("dt", {}, "도착 화면"),
      h(
        "dd",
        {},
        arrives.length || used.size
          ? h(
              "ul",
              { class: "plain" },
              arrives.map((a) => arriveRow(a, used)),
              [...used]
                .filter((fp) => !arrives.some((a) => arriveFp(a) === fp))
                .map((fp) =>
                  h("li", { class: "mono" }, fp, h("span", { class: "tag ok" }, "목표에 있음")),
                ),
            )
          : h("span", { class: "muted" }, "없음"),
      ),
      h("dt", {}, "끝 단계"),
      h(
        "dd",
        {},
        g.finish?.length
          ? h(
              "ol",
              { class: "plain-ol" },
              g.finish.map((f) =>
                h(
                  "li",
                  {},
                  `${f.action} "${f.targetText}"`,
                  h("span", { class: "muted" }, ` · ${f.verify}`),
                  f.sensitive ? h("span", { class: "tag bad" }, "민감") : null,
                ),
              ),
            )
          : h("span", { class: "muted" }, "없음"),
      ),
      h("dt", {}, "최근 결과"),
      h("dd", {}, recentLine(g.recent)),
      h("dt", {}, "바뀐 때"),
      h("dd", { class: "muted" }, g.updatedAt ? `${time(g.updatedAt)} (${ago(g.updatedAt)})` : "–"),
    ),
  );
}

const arriveFp = (a: LearnedArrive) => a.fp ?? a.SK.split("#").slice(2).join("#");

function arriveRow(a: LearnedArrive, used: Set<string>): HTMLElement {
  const fp = arriveFp(a);
  return h(
    "li",
    {},
    h("span", { class: "mono" }, fp),
    " ",
    ...statusTags(a, false),
    used.has(fp)
      ? h("span", { class: "tag ok", title: "목표 arriveFps 에 들어감" }, "목표에 있음")
      : null,
    " 기기 ",
    deviceCount(a),
    evidenceList(a),
  );
}

function edgeTable(d: LearnedMapView, edges: LearnedEdge[]): HTMLElement {
  return h(
    "table",
    { class: "learn-edges small" },
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", {}, "연결선"),
        h("th", {}, "앱"),
        h("th", {}, "이동"),
        h("th", {}, "누를 것"),
        h("th", {}, "상태"),
        h("th", {}, "기기"),
        h("th", {}, "최근"),
        h("th", {}, "마지막 성공"),
      ),
    ),
    h(
      "tbody",
      {},
      edges.map((e) =>
        h(
          "tr",
          { "data-id": e.edgeId },
          h("td", { class: "mono", title: e.edgeId }, short(e.edgeId)),
          h("td", { class: "mono muted", title: e.pkg }, e.pkg.split(".").pop() ?? e.pkg),
          h(
            "td",
            { class: "mono" },
            h("span", { title: e.fromFp }, short(e.fromFp, 10)),
            " → ",
            h("span", { title: e.toFp }, short(e.toFp, 10)),
          ),
          h(
            "td",
            {},
            `${e.action === "tap" ? "" : `${e.action} `}"${e.targetText}"`,
            e.targetClass ? h("span", { class: "muted" }, ` ${e.targetClass}`) : null,
          ),
          h("td", {}, ...statusTags(e, d.block.edgeIds.includes(e.edgeId))),
          h("td", {}, deviceCount(e), evidenceList(e)),
          h("td", {}, recentLine(e.recent)),
          h("td", { class: "muted" }, e.lastUsedAt ? ago(e.lastUsedAt) : "–"),
        ),
      ),
    ),
  );
}

function pendingSection(d: LearnedMapView): HTMLElement {
  return h(
    "section",
    { class: "learn-pending" },
    h("h2", {}, `사람 확인 대기 ${d.pending.length}`),
    h(
      "ul",
      { class: "plain" },
      d.pending.map((p) =>
        h(
          "li",
          { "data-id": `${p.uid}:${p.commandId}` },
          h("span", { class: "tag warn" }, p.reasons.map((r) => PENDING_REASON[r] ?? r).join(", ")),
          ` ${p.goalId ? goalLabel(d, p.goalId) : p.proposal ? `새 목표 "${p.proposal.name}" — ${p.proposal.desc}` : "목표 없음"}`,
          h(
            "span",
            { class: "muted small" },
            ` · ${p.uid} #${p.commandId}${p.createdAt ? ` · ${ago(p.createdAt)}` : ""}`,
          ),
          h(
            "div",
            { class: "mono small muted" },
            `넣기: npx tsx scripts/map-seed.ts --uid ${p.uid} --command ${p.commandId} --force --apply  │  버리기: npx tsx scripts/map-pending.ts --drop ${p.uid}:${p.commandId}:${p.gen}`,
          ),
        ),
      ),
    ),
  );
}
