/**
 * 지도 안내 (docs/jev-routing-plan.md 5장, R4, dev).
 *
 * 지도에 검증된 길이 있고 지금 화면이 학습한 화면과 **지문이 정확히 같을 때만** Claude 없이 한 단계를 준다.
 * 조금이라도 다르면 "ai" 를 돌려주고, 그 명령은 끝까지 Claude 가 안내한다 (지도 → Claude 한 방향).
 *
 * 순수 함수: 저장·호출은 guide 라우트가 한다.
 */
import type { GuideRequest, GuideResponse } from "../ai/guide-schema.js";
import type { CommandRecord, MapProgress } from "../route/command-store.js";
import type { IndexedMap } from "../route/map.js";
import { isLauncher, isSensitiveLabel, isSensitiveScreen } from "../review/safety-words.js";
import { maskText } from "../shared/sensitive.js";
import type { ScreenDocument } from "../debug/store.js";
import { isStale, type ResultTarget } from "./learn.js";
import type { MapEdge, MapFinishStep, MapSnapshot } from "./store.js";

export const MAP_PROMPT_VERSION = "map@v1";
const SAY_MAX = 80;
/** 같은 화면에서 같은 지도 안내를 다시 주는 최대 횟수. 넘으면 Claude (누를 수 없는 버튼에 갇히지 않게) */
export const MAX_RESENDS = 2;

/** 앞 지도 안내가 맞았나 (8.3 결과 세기). 다른 것을 누른 경우처럼 어르신 선택은 세지 않음 */
export type MapResult = ResultTarget & { ok: boolean };

export type MapDecision =
  /** 지도로 한 단계. progress 는 저장할 진행 상태 (stepId 는 라우트가 붙임) */
  (
    | {
        kind: "step";
        response: Omit<GuideResponse, "stepId">;
        progress: Omit<MapProgress, "stepId">;
      }
    /** 같은 화면 재요청: 같은 stepId 로 지금 화면 기준 다시 만든 안내. resends 는 저장할 다시 준 횟수 */
    | { kind: "resend"; response: GuideResponse; resends: number }
    /** Claude 로. persist 면 진행 상태를 ai 로 바꿔 저장 (Claude 가 안내를 시작한 명령에 지도가 끼어들지 않게) */
    | { kind: "ai"; reason: string; persist: boolean }
  ) & { result?: MapResult };

export interface MapDecideInput {
  request: GuideRequest;
  /** 가린 노드 (maskDeep 뒤). 지문·글자 비교는 모두 이것으로 */
  maskedNodes: GuideRequest["screen"]["nodes"];
  /** 지금 화면의 지도 지문 (mfp@v1, 가린 노드로) */
  fp: string;
  command: CommandRecord;
  snapshot: MapSnapshot;
  routeMap: IndexedMap;
  /** 90일 안 쓰인 연결선을 거르는 기준 시각 (기본 지금) */
  now?: Date;
}

/** 노드 클래스의 마지막 이름 (android.widget.TextView → TextView) */
export const classOf = (c: string | undefined): string => (c ?? "").split(".").pop() ?? "";
/**
 * 누를 노드의 글자 비교는 **그대로** (공백만 정리). 화면 지문은 숫자를 # 로 뭉개지만
 * 누를 버튼은 '30초'와 '10초'를 달리 봐야 한다
 */
export const exactLabel = (text: string): string => text.trim().replace(/\s+/g, " ");
/** 노드의 글자: 비어 있지 않은 t, 없으면 d (앱의 lastAction.text 와 같은 규칙) */
export const nodeLabel = (node: { t?: string | undefined; d?: string | undefined }): string =>
  [node.t, node.d].map((x) => exactLabel(x ?? "")).find((x) => x !== "") ?? "";
const labelOf = nodeLabel;
/** 앱이 보낸 행동 글자(가리기 전)와 지도의 글자(가린 뒤)가 같은가 */
const sameTarget = (actionText: string, targetText: string): boolean =>
  exactLabel(maskText(actionText).text) === exactLabel(targetText);

export function decideMapStep(input: MapDecideInput): MapDecision {
  let result: MapResult | undefined;
  const decision = decide(input, (r) => {
    result = r;
  });
  return result ? { ...decision, result } : decision;
}

function decide(input: MapDecideInput, report: (result: MapResult) => void): MapDecision {
  const { request, command, snapshot, routeMap, fp } = input;
  const now = input.now ?? new Date();
  const progress = command.mapProgress;
  // Claude 로 넘긴 것을 저장해 다음부터 지도를 보지 않는다 (Claude → 지도로는 돌아가지 않음)
  const ai = (reason: string): MapDecision => ({ kind: "ai", reason, persist: true });

  // 끝난 명령은 쓰지 않는다 (끝난 명령 갱신이 검토 Stream 을 다시 깨우지 않게)
  if (command.endResult !== undefined) return { kind: "ai", reason: "ended", persist: false };
  if (progress?.mode === "ai") return { kind: "ai", reason: "already-ai", persist: false };
  // 지도 진행 상태 없이 앞 안내가 있었던 명령(앞 요청에서 Claude 가 안내했는데 ai 저장이 안 된 경우)은
  // 지도가 끼어들지 않는다
  const last = request.lastAction;
  if (!progress && (last?.stepId !== undefined || request.history.length > 0)) {
    return ai("claude-started");
  }
  // 앞 지도 안내를 그대로 따랐는데 다른 화면(다른 앱·민감한 화면 포함)에 왔으면 그 실패를 먼저 센다
  // (아래의 앱·화면 검사가 먼저 돌려보내면 고장 난 연결선이 계속 verified 로 남음)
  const failed = followedButMissed(input);
  if (failed) report(failed);

  // ── 전제: 고른 목표가 지도에 검증되어 있고, 위험하지 않은 명령 ──
  if (command.chosenApp === undefined || command.chosenGoal === undefined) return ai("no-goal");
  if (command.category === "scam" || command.level === "L3" || command.degraded) {
    return ai("unsafe-command");
  }
  const routeGoal = routeMap.goals.get(command.chosenGoal);
  const app = routeMap.apps.get(command.chosenApp);
  if (!routeGoal || !app || routeGoal.app !== app.id) return ai("unknown-goal");
  // 값이 필요한 목표(검색어 등)는 Claude (4.5)
  if (routeGoal.slots.length > 0 || routeGoal.status !== "verified") return ai("goal-not-mappable");
  const goal = snapshot.goals.get(command.chosenGoal);
  if (!goal || goal.status !== "verified" || snapshot.block.goalIds.includes(goal.goalId)) {
    return ai("no-map");
  }
  const pkg = request.screen.pkg;
  if (!app.packages.includes(pkg) && !isLauncher(pkg)) return ai("other-app");
  const screenDoc = { pkg, screen: { ...request.screen, nodes: input.maskedNodes } };
  if (isSensitiveScreen(screenDoc as unknown as ScreenDocument)) return ai("sensitive-screen");

  const edges = snapshot.edges.filter(
    (e) =>
      e.status === "verified" && !snapshot.block.edgeIds.includes(e.edgeId) && !isStale(e, now),
  );

  // ── 앞 안내와의 관계 ──
  let finishFrom = 0;
  let inFinish = false;
  if (progress?.stepId !== undefined) {
    if (last?.stepId !== progress.stepId) {
      // 안내를 따르지 않았는데 화면이 그대로면 같은 안내를 다시 (네트워크 재시도·말 다시 하기).
      // 저장된 응답을 그대로 쓰지 않고 지금 지도·화면으로 다시 만든다: 그 사이 차단된 연결선은 멈추고,
      // 노드 번호가 바뀌었으면 지금 번호로 (지문은 노드 번호를 보지 않음). stepId 는 같게
      if (progress.fp !== fp) return ai("not-followed");
      const resends = (progress.resends ?? 0) + 1;
      if (resends > MAX_RESENDS) return ai("resend-limit");
      const again = sameStepAgain(input, progress, edges);
      if (again.kind !== "step") return again;
      return { kind: "resend", response: { ...again.response, stepId: progress.stepId }, resends };
    }
    if (progress.kind === "edge") {
      const edge = edges.find((e) => e.edgeId === progress.ref);
      if (!edge) return ai("edge-gone");
      if (last.action !== edge.action) return ai("different-action");
      // 다른 것을 눌렀으면 (같은 화면 다른 줄 등) 지도의 길이 아님
      if (edge.action === "tap" && !sameTarget(last.text, edge.targetText)) {
        return ai("different-target");
      }
      if (edge.toFp !== fp) {
        report({ kind: "edge", id: edge.edgeId, ok: false });
        return ai("unexpected-screen");
      }
      report({ kind: "edge", id: edge.edgeId, ok: true });
    } else {
      const index = Number(progress.ref);
      const step = goal.finish[index];
      if (!step) return ai("finish-gone");
      if (last.action !== step.action) return ai("different-action");
      if (step.action === "tap" && !sameTarget(last.text, step.targetText)) {
        return ai("different-target");
      }
      // page: 다음 화면으로 바뀜, node_state: 체크·선택이 바뀜 → 둘 다 지문이 달라져야 확인됨
      // 화면이 그대로인 것은 실패로 세지 않는다: 아직 덜 밀었을 수 있고, 막대 값(숫자)은 지문에서 # 로 같아짐
      if (fp === progress.fp) return ai("finish-not-verified");
      // 다음 끝 단계는 seed 때 본 그 화면에서만 (다른 것이 바뀌었거나 다른 화면이면 Claude)
      if (goal.finish[index + 1] && step.afterFp !== fp) {
        report({ kind: "goal", id: goal.goalId, ok: false });
        return ai("finish-unexpected-screen");
      }
      // 마지막 끝 단계는 seed 때 본 그 다음 화면과 같을 때만 성공으로 센다 (다르면 실패로도 안 셈:
      // 마지막 화면은 알림·안내 창으로 달라지기 쉬움. 다 됐는지는 Claude 가 화면을 보고 판단)
      if (goal.finish[index + 1] || step.afterFp === fp) {
        report({ kind: "goal", id: goal.goalId, ok: true });
      }
      finishFrom = index + 1;
      inFinish = true;
    }
  }

  // ── 끝 단계 ──
  if (inFinish || goal.arriveFps.includes(fp)) {
    const step = goal.finish[finishFrom];
    // 끝 단계를 다 했으면 "다 됐다" 판단은 Claude 에게 (화면 근거로)
    if (!step) return ai("finish-complete");
    if (step.sensitive || step.verify === "none") return ai("finish-needs-ai");
    if (step.action !== "tap" && !step.action.startsWith("swipe_")) return ai("finish-needs-ai");
    // 끝 단계 다음 화면은 지문을 모르므로, 그 화면이 지금과 같은지는 다음 요청에서 본다
    return toStep(input, step, { mode: "map", fp, kind: "finish", ref: String(finishFrom) });
  }

  // ── 연결선을 따라 도착 화면까지 (가장 짧은 길의 첫 걸음) ──
  const first = firstEdgeToward(fp, new Set(goal.arriveFps), edges);
  if (!first) return ai("no-path");
  return toStep(input, first, { mode: "map", fp, kind: "edge", ref: first.edgeId });
}

/**
 * 앞 지도 안내를 따랐는데(같은 stepId·같은 행동·같은 글자) 기대한 화면이 아닌가. 어르신이 다른 것을
 * 누른 경우는 세지 않는다. 덜 민 끝 단계(화면 그대로)와 마지막 끝 단계도 세지 않는다 (decide 와 같은 규칙)
 */
function followedButMissed(input: MapDecideInput): MapResult | undefined {
  const { command, snapshot, fp } = input;
  const progress = command.mapProgress;
  const last = input.request.lastAction;
  if (
    progress?.mode !== "map" ||
    progress.stepId === undefined ||
    last?.stepId !== progress.stepId
  ) {
    return undefined;
  }
  if (progress.kind === "edge") {
    const edge = snapshot.edges.find((e) => e.edgeId === progress.ref);
    if (!edge || last.action !== edge.action) return undefined;
    if (edge.action === "tap" && !sameTarget(last.text, edge.targetText)) return undefined;
    return edge.toFp === fp ? undefined : { kind: "edge", id: edge.edgeId, ok: false };
  }
  const goal = command.chosenGoal ? snapshot.goals.get(command.chosenGoal) : undefined;
  const index = Number(progress.ref);
  const step = goal?.finish[index];
  if (!goal || !step || last.action !== step.action) return undefined;
  if (step.action === "tap" && !sameTarget(last.text, step.targetText)) return undefined;
  if (fp === progress.fp || !goal.finish[index + 1]) return undefined;
  return step.afterFp === fp ? undefined : { kind: "goal", id: goal.goalId, ok: false };
}

/** 앞에 준 지도 안내를 지금 지도·화면 기준으로 다시 만든다 (같은 화면 재요청) */
function sameStepAgain(
  input: MapDecideInput,
  progress: MapProgress,
  edges: readonly MapEdge[],
): MapDecision {
  const ai = (reason: string): MapDecision => ({ kind: "ai", reason, persist: true });
  const previous = {
    mode: "map" as const,
    fp: input.fp,
    ...(progress.kind ? { kind: progress.kind } : {}),
    ...(progress.ref ? { ref: progress.ref } : {}),
  };
  if (progress.kind === "edge") {
    const edge = edges.find((e) => e.edgeId === progress.ref);
    if (!edge) return ai("edge-gone");
    return toStep(input, edge, previous);
  }
  const goal = input.command.chosenGoal
    ? input.snapshot.goals.get(input.command.chosenGoal)
    : undefined;
  const step = goal?.finish[Number(progress.ref)];
  if (!step) return ai("finish-gone");
  if (step.sensitive || step.verify === "none") return ai("finish-needs-ai");
  return toStep(input, step, previous);
}

/** 너비 우선: 지금 화면에서 도착 화면까지 가장 짧은 길의 첫 연결선 */
export function firstEdgeToward(
  from: string,
  targets: ReadonlySet<string>,
  edges: readonly MapEdge[],
): MapEdge | undefined {
  const out = new Map<string, MapEdge[]>();
  for (const e of edges) {
    if (e.fromFp === e.toFp) continue;
    const list = out.get(e.fromFp) ?? [];
    list.push(e);
    out.set(e.fromFp, list);
  }
  // 같은 출발 화면의 연결선은 id 순으로 (매번 같은 길)
  for (const list of out.values()) list.sort((a, b) => a.edgeId.localeCompare(b.edgeId));
  const firstStep = new Map<string, MapEdge>();
  const seen = new Set([from]);
  let frontier = [from];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const fp of frontier) {
      for (const e of out.get(fp) ?? []) {
        if (seen.has(e.toFp)) continue;
        seen.add(e.toFp);
        const head = fp === from ? e : firstStep.get(fp);
        if (!head) continue;
        if (targets.has(e.toFp)) return head;
        firstStep.set(e.toFp, head);
        next.push(e.toFp);
      }
    }
    frontier = next;
  }
  return undefined;
}

function toStep(
  input: MapDecideInput,
  step: Pick<MapFinishStep, "action" | "targetText" | "targetClass">,
  progress: Omit<MapProgress, "stepId">,
): MapDecision {
  const ai = (reason: string): MapDecision => ({ kind: "ai", reason, persist: true });
  const { requestId } = input.request;
  if (isSensitiveLabel(step.targetText)) return ai("sensitive-target");

  if (step.action === "tap") {
    const want = exactLabel(step.targetText);
    if (want === "") return ai("no-target-text");
    const matches = input.maskedNodes.filter(
      (n) => labelOf(n) === want && classOf(n.c) === step.targetClass,
    );
    // 같은 글자·종류가 둘 이상이면 어느 것인지 모름 → Claude
    if (matches.length !== 1 || !matches[0]) return ai("target-not-unique");
    const node = matches[0];
    if (node.editable === true || node.secret === true) return ai("target-is-input");
    // 꺼진 버튼은 지문이 같아도 누를 수 없다 → Claude 가 화면을 보고 판단
    if (node.enabled === false) return ai("target-disabled");
    const text = nodeLabel(node) || exactLabel(step.targetText);
    return {
      kind: "step",
      response: {
        requestId,
        type: "highlight",
        say: pressSay(text),
        status: "in_progress",
        target: node.i,
        targetText: text,
      },
      progress,
    };
  }

  const dir = SWIPE[step.action];
  // 밀 곳(막대 등)이 글자로 하나뿐이면 가리킨다. 막대 값이 바뀌어 글자가 달라지면 화살표 없이 방향만
  const want = exactLabel(step.targetText);
  const hits =
    want === ""
      ? []
      : input.maskedNodes.filter(
          (n) =>
            labelOf(n) === want && (step.targetClass === "" || classOf(n.c) === step.targetClass),
        );
  const node = hits.length === 1 ? hits[0] : undefined;
  return {
    kind: "step",
    response: {
      requestId,
      type: "swipe",
      say: `화면을 ${DIR_WORD[dir]} 밀어 주세요.`,
      status: "in_progress",
      dir,
      ...(node ? { target: node.i, targetText: nodeLabel(node) } : {}),
    },
    progress,
  };
}

const SWIPE = {
  swipe_up: "up",
  swipe_down: "down",
  swipe_left: "left",
  swipe_right: "right",
} as const;
const DIR_WORD = { up: "위로", down: "아래로", left: "왼쪽으로", right: "오른쪽으로" } as const;

/** 을/를: 마지막 글자가 받침 있는 한글이면 "을" */
export function objectParticle(text: string): "을" | "를" {
  const code = text.trim().slice(-1).charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? "를" : "을";
  return "를";
}

/** "'글자'을/를 눌러 주세요." 길면 끝을 자르지 않고 글자를 줄인다 ("눌러 주세요"가 남게) */
export function pressSay(text: string): string {
  const say = (label: string) => `'${label}'${objectParticle(label)} 눌러 주세요.`;
  if (say(text).length <= SAY_MAX) return say(text);
  const room = SAY_MAX - say("").length - 1;
  return say(`${text.slice(0, Math.max(1, room))}…`);
}
