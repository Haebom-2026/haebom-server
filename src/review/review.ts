/**
 * 끝난 명령 하나를 Opus 로 검토하고 서버가 다시 확인한다 (docs/jev-routing-plan.md 7·8장, R3).
 *
 * R3 에서는 **판정만 남기고 지도에 반영하지 않는다**. 결과(outcome)는 사람이 표본을 보고
 * Opus 판정을 믿을 수 있는지 재는 데 쓴다 (10장: success:yes 중 진짜 성공 ≥ 98%).
 *   accept: R5 에서 자동 반영할 후보 (기존 목표의 이동·끝 단계)
 *   human : 사람 확인이 필요 (새 목표, 민감한 끝 단계·목표, 페이지를 못 맞춘 이동)
 *   reject: 학습하지 않음 (실패·불확실, 기록 빠짐, 민감 행동이 이동에 섞임, 화면 속 지시 흔적 …)
 *   error : 모델이 거절·형식 오류 (통신 오류·시간 초과는 예외로 던져 Stream 이 다시 시도)
 * 검토는 명령 세대(gen)마다 한 번만 저장한다.
 */
import type { CommandLog, StepRecord } from "../route/command-log.js";
import type { CommandRecord, CommandStore, ScreenRef } from "../route/command-store.js";
import { REVIEWABLE_RESULTS } from "../route/command-end.js";
import { normalizeName, type IndexedMap } from "../route/map.js";
import type { ScreenDocument } from "../debug/store.js";
import type { Logger } from "../shared/logger.js";
import { maskText } from "../shared/sensitive.js";
import type { ReviewModel } from "./model.js";
import { REVIEW_PROMPT_VERSION, type ReviewOutput } from "./prompt.js";
import {
  hasInjectionMarker,
  isExcludedPackage,
  isSensitiveLabel,
  isSensitiveScreen,
} from "./safety-words.js";

export type ReviewOutcome = "accept" | "human" | "reject" | "error";

/** 지도에 더할 후보 연결선 (R5 에서 쓰고, 지금은 기록만) */
export interface CandidateEdge {
  from: string;
  to: string;
  action: string;
  text: string;
  pkg: string;
}

export interface ReviewRecord {
  version: string;
  model: string;
  reviewedAt: string;
  commandId: number;
  gen: string;
  outcome: ReviewOutcome;
  /** 막는 이유 (reject) 와 사람 확인 이유 (human) */
  reasons: string[];
  appId?: string;
  goal?: { kind: string; id?: string; proposal?: { name: string; desc: string; slots: string[] } };
  edges: CandidateEdge[];
  finish: ReviewOutput["finish"];
  opus?: ReviewOutput;
  stats: {
    screens: number;
    actions: number;
    inputTokens?: number;
    outputTokens?: number;
    ms: number;
  };
}

export interface ReviewDeps {
  commands: CommandStore;
  commandLog: CommandLog;
  getScreen: (ref: ScreenRef) => Promise<ScreenDocument | undefined>;
  model: ReviewModel;
  modelName: string;
  map: IndexedMap;
  log: Logger;
  now?: () => Date;
}

/** 행동 하나: on = 그 행동을 한 화면 번호 (steps 의 순서) */
export interface ReviewAction {
  seq: number;
  on: number;
  action: string;
  text: string;
  guided: boolean;
}

/** 성공 판정에 필요한 노드 상태 (체크·선택·채워짐 등) */
const STATE_KEYS = [
  "checked",
  "selected",
  "focused",
  "filled",
  "editable",
  "disabled",
  "password",
  "secret",
];

interface PromptNode {
  i: number;
  t?: string;
  d?: string;
  c?: string;
  s?: string[];
}

function compactNodes(doc: ScreenDocument | undefined): PromptNode[] {
  return (doc?.screen.nodes ?? []).slice(0, 80).map((n) => {
    const node = n as Record<string, unknown>;
    const state = STATE_KEYS.filter((k) => node[k] === true);
    return {
      i: n.i,
      ...(n.t ? { t: n.t } : {}),
      ...(n.d ? { d: n.d } : {}),
      ...(n.c ? { c: n.c.split(".").at(-1) ?? n.c } : {}),
      ...(state.length > 0 ? { s: state } : {}),
    };
  });
}

const textsOf = (doc: ScreenDocument | undefined): string[] =>
  (doc?.screen.nodes ?? []).flatMap((n) => [n.t ?? "", n.d ?? ""]).filter(Boolean);

const same = (a: string, b: string) => normalizeName(a) === normalizeName(b);

/** 홈 화면(런처)은 어느 앱으로 가든 지나가는 곳이라 다른 앱으로 보지 않는다 */
const isLauncher = (pkg: string) => /launcher|home/i.test(pkg);

/** 단계 기록 → 실제 행동 줄 (각 화면 다음 단계의 lastAction, 마지막은 끝 신호의 행동) */
export function actionsOf(steps: readonly StepRecord[], command: CommandRecord): ReviewAction[] {
  const index = new Map(steps.map((s, n) => [s.stepId, n]));
  const out: ReviewAction[] = [];
  steps.forEach((s, n) => {
    if (n === 0 || !s.lastAction) return;
    out.push({
      seq: s.lastAction.seq,
      on: n - 1,
      action: s.lastAction.action,
      text: s.lastAction.text,
      guided: s.lastAction.stepId !== undefined && index.get(s.lastAction.stepId) === n - 1,
    });
  });
  const fin = command.finalAction;
  if (fin && steps.length > 0) {
    const last = steps.length - 1;
    out.push({
      seq: fin.seq,
      on: last,
      action: fin.action,
      text: fin.text,
      guided: fin.stepId !== undefined && index.get(fin.stepId) === last,
    });
  }
  return out;
}

/**
 * 명령 하나 검토. 이미 그 세대를 검토했으면 건너뛴다 (Stream 재전달·재시도에 안전).
 * @param expectedGen Stream 이벤트가 가리킨 명령 세대. 지금 명령과 다르면 (지난 이벤트) 건너뜀
 */
export async function reviewCommand(
  uid: string,
  commandId: number,
  deps: ReviewDeps,
  expectedGen?: string,
): Promise<ReviewRecord | undefined> {
  const started = Date.now();
  const now = (deps.now ?? (() => new Date()))();

  const command = await deps.commands.get(uid, commandId);
  if (!command?.endResult || !REVIEWABLE_RESULTS.includes(command.endResult)) return undefined;
  if (expectedGen !== undefined && command.gen !== expectedGen) return undefined;
  if ((await deps.commandLog.getReview(uid, commandId, command.gen)) !== undefined) {
    return undefined;
  }

  // 이 명령 세대의 단계만 (같은 번호의 지난 명령 단계가 섞이지 않게)
  const steps = (await deps.commandLog.listSteps(uid, commandId))
    .filter(
      (s) =>
        s.receivedAt >= command.createdAt &&
        (command.endedAt === undefined || s.receivedAt <= command.endedAt),
    )
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const docs = await Promise.all(steps.map((s) => deps.getScreen(s.screen)));
  const finalDoc = command.finalScreen ? await deps.getScreen(command.finalScreen) : undefined;
  // 가리키는 화면이 아직 안 읽히면(방금 저장) 판정을 남기지 않고 다시 시도
  if (docs.some((d) => d === undefined) || (command.finalScreen && !finalDoc)) {
    throw new Error("screen not readable yet");
  }
  const actions = actionsOf(steps, command);

  const make = (
    outcome: ReviewOutcome,
    reasons: string[],
    extra: Partial<ReviewRecord> = {},
  ): ReviewRecord => ({
    version: REVIEW_PROMPT_VERSION,
    model: deps.modelName,
    reviewedAt: now.toISOString(),
    commandId,
    gen: command.gen,
    outcome,
    reasons,
    ...(command.chosenApp ? { appId: command.chosenApp } : {}),
    edges: [],
    finish: [],
    ...extra,
    stats: {
      screens: steps.length,
      actions: actions.length,
      ...(extra.stats ?? {}),
      ms: Date.now() - started,
    },
  });

  // 모델을 부르기 전에 걸러낼 것 (Opus 비용을 쓰지 않음)
  const pre = preChecks(command, steps, docs, finalDoc, actions, deps.map);
  if (pre.length > 0) return save(uid, commandId, command.gen, make("reject", pre), deps);

  const appId = command.chosenApp ?? "";
  const goals = (deps.map.goalsByApp.get(appId) ?? []).map((g) => ({
    id: g.id,
    name: g.name,
    desc: g.desc,
  }));
  const record = {
    utterance: command.maskedUtterance,
    app: appId,
    goalCandidates: goals,
    endResult: command.endResult,
    screens: steps.map((s, n) => ({
      n,
      pkg: s.pkg,
      ...(s.page?.pageId ? { page: s.page.pageId } : {}),
      guide: s.guide,
      nodes: compactNodes(docs[n]),
    })),
    actions,
    ...(finalDoc ? { final: { pkg: finalDoc.pkg, nodes: compactNodes(finalDoc) } } : {}),
  };

  const result = await deps.model(record);
  if (result.status === "error") {
    // 통신 오류·시간 초과는 다시 시도하도록 던진다 (판정을 남기면 재전달이 건너뛰게 됨)
    throw new Error("review model call failed", { cause: result.error });
  }
  if (result.status !== "ok") {
    deps.log.warn("review model refused or invalid", { commandId, status: result.status });
    return save(uid, commandId, command.gen, make("error", [`model_${result.status}`]), deps);
  }
  // 검토하는 동안 명령이 바뀌었으면(재시도가 사기 의심·L3 로 올림 등) 다시 확인
  const latest = await deps.commands.get(uid, commandId);
  if (!latest || latest.gen !== command.gen) return undefined;
  if (latest.rev !== command.rev) {
    const again = preChecks(latest, steps, docs, finalDoc, actions, deps.map);
    if (again.length > 0) {
      return save(
        uid,
        commandId,
        command.gen,
        make("reject", [...again, "changed_during_review"]),
        deps,
      );
    }
  }
  const opus = result.output;
  const { outcome, reasons, edges } = postChecks(
    opus,
    steps,
    docs,
    actions,
    goals,
    latest,
    deps.map,
    finalDoc?.pkg,
  );
  return save(
    uid,
    commandId,
    command.gen,
    make(outcome, reasons, {
      goal: {
        kind: opus.goal.kind,
        ...(opus.goal.id ? { id: opus.goal.id } : {}),
        ...(opus.goal.proposal
          ? {
              proposal: {
                name: maskText(opus.goal.proposal.name).text,
                desc: maskText(opus.goal.proposal.desc).text,
                slots: opus.goal.proposal.slots,
              },
            }
          : {}),
      },
      edges,
      finish: opus.finish,
      opus,
      stats: {
        screens: steps.length,
        actions: actions.length,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        ms: 0,
      },
    }),
    deps,
  );
}

async function save(
  uid: string,
  commandId: number,
  gen: string,
  review: ReviewRecord,
  deps: ReviewDeps,
): Promise<ReviewRecord> {
  const saved = await deps.commandLog.saveReview(uid, commandId, gen, review);
  deps.log.info("command reviewed", {
    commandId,
    saved,
    outcome: review.outcome,
    reasons: review.reasons,
    edges: review.edges.length,
    goal: review.goal?.kind,
    inputTokens: review.stats.inputTokens,
    outputTokens: review.stats.outputTokens,
    ms: review.stats.ms,
  });
  return review;
}

/** 모델 전에 막는 것 (6·7.3·8.2) */
export function preChecks(
  command: CommandRecord,
  steps: readonly StepRecord[],
  docs: readonly (ScreenDocument | undefined)[],
  finalDoc: ScreenDocument | undefined,
  actions: readonly ReviewAction[],
  map: IndexedMap,
): string[] {
  const reasons: string[] = [];
  if (command.degraded || command.category === "scam" || command.level === "L3") {
    reasons.push("sensitive_command");
  }
  const app = command.chosenApp ? map.apps.get(command.chosenApp) : undefined;
  if (!app) reasons.push("no_chosen_app");
  if (app?.roles.some((r) => map.roles.get(r)?.sensitive)) reasons.push("sensitive_role");
  // 대화·메일·메모·금융·건강 앱 화면을 지났으면 학습하지 않음 (선택한 앱만이 아니라 모든 화면)
  const pkgs = [...steps.map((s) => s.pkg), ...(finalDoc ? [finalDoc.pkg] : [])];
  if (pkgs.some((p) => isExcludedPackage(p, map))) reasons.push("excluded_app");
  // 성공 근거: done·stopped_safe 모두 마지막 화면이 있어야 함
  if (!finalDoc) reasons.push("no_final_screen");
  if (steps.length === 0) reasons.push("no_steps");
  if (docs.some((d) => d === undefined)) reasons.push("screen_missing");

  // 행동이 기록 순서대로 0, 1, 2 … 이고 각 화면 다음 단계마다 하나씩 있어야 함
  const expected = steps.length - 1 + (command.finalAction ? 1 : 0);
  if (actions.length !== expected || actions.some((a, k) => a.seq !== k || a.on !== k)) {
    reasons.push("missing_steps");
  }

  // 화면 속 지시·검토 조작·링크 흔적 (지도로 들어가는 길을 막음)
  if ([...docs, finalDoc].some((d) => textsOf(d).some(hasInjectionMarker))) {
    reasons.push("injection_marker");
  }
  return [...new Set(reasons)];
}

/** Opus 결과를 서버가 다시 확인 (Opus 를 그대로 믿지 않음, 7.3) */
export function postChecks(
  opus: ReviewOutput,
  steps: readonly StepRecord[],
  docs: readonly (ScreenDocument | undefined)[],
  actions: readonly ReviewAction[],
  goals: readonly { id: string }[],
  command: CommandRecord,
  map: IndexedMap,
  /** 마지막 화면의 앱 (다른 앱 검사에 포함) */
  finalPkg?: string,
): { outcome: ReviewOutcome; reasons: string[]; edges: CandidateEdge[] } {
  const block: string[] = [];
  const human: string[] = [];
  if (opus.success !== "yes") block.push(`success_${opus.success}`);
  if (opus.personalText) block.push("personal_text");

  const bySeq = new Map(actions.map((a) => [a.seq, a]));
  const matches = (x: { seq: number; action: string; text: string }) => {
    const a = bySeq.get(x.seq);
    return a !== undefined && a.action === x.action && same(a.text, x.text);
  };
  if (![...opus.moves, ...opus.finish].every(matches)) block.push("seq_mismatch");
  // 이동·끝 단계는 행동 순서대로, 겹치지 않게, 끝 단계는 모든 이동 뒤에 (뒤집히거나 반복되면 안 됨)
  const increasing = (xs: readonly { seq: number }[]) =>
    xs.every((x, i) => i === 0 || x.seq > (xs[i - 1]?.seq ?? -1));
  const lastMove = Math.max(-1, ...opus.moves.map((m) => m.seq));
  if (
    !increasing(opus.moves) ||
    !increasing(opus.finish) ||
    opus.finish.some((f) => f.seq <= lastMove)
  ) {
    block.push("output_order");
  }
  // 고른 앱이 아닌 앱 화면을 지남 (홈 화면 제외) → 사람 확인
  const appPkgs = new Set(map.apps.get(command.chosenApp ?? "")?.packages ?? []);
  const seen = [...steps.map((s) => s.pkg), ...(finalPkg ? [finalPkg] : [])];
  if (seen.some((p) => !appPkgs.has(p) && !isLauncher(p))) human.push("other_app");

  const flagged = new Set(opus.sensitiveSeqs);
  /** 민감한 행동: Opus 표시, 민감한 글자, 또는 민감한 화면(권한·설치 창, 비밀번호 칸, 금액)에서 한 행동 */
  const sensitive = (x: { seq: number; text: string }) => {
    const a = bySeq.get(x.seq);
    return flagged.has(x.seq) || isSensitiveLabel(x.text) || isSensitiveScreen(docs[a?.on ?? -1]);
  };
  // 민감한 행동이 이동(공유 연결선)에 섞이면 그 명령은 학습하지 않음 (14장 2)
  if (opus.moves.some(sensitive)) block.push("sensitive_in_moves");
  // 끝 단계의 민감 행동은 Opus 가 표시했어야 하고, 사람 승인이 필요 (8.2)
  const sensitiveFinish = opus.finish.filter(sensitive);
  if (sensitiveFinish.some((f) => !flagged.has(f.seq))) block.push("sensitive_unflagged");
  if (sensitiveFinish.length > 0) human.push("sensitive_finish");
  // 민감한 실제 행동을 이동·끝 단계에서 빼고 내면(예: 권한 허용을 건너뛴 길) 사람 확인
  const listed = new Set([...opus.moves, ...opus.finish].map((x) => x.seq));
  if (actions.some((a) => !listed.has(a.seq) && sensitive(a))) human.push("sensitive_omitted");

  if (opus.goal.kind === "existing") {
    if (!opus.goal.id || !goals.some((g) => g.id === opus.goal.id)) block.push("unknown_goal");
    const goal = opus.goal.id ? map.goals.get(opus.goal.id) : undefined;
    if (goal && (goal.level === "L2" || goal.level === "L3")) human.push("sensitive_goal");
  } else if (opus.goal.kind === "new") {
    human.push("new_goal");
  } else {
    block.push("no_goal");
  }
  if (command.level === "L2") human.push("sensitive_command_level");

  // 후보 연결선: 이동 앞뒤 화면이 둘 다 페이지로 맞춰졌고 서로 다른 페이지일 때만
  const edges: CandidateEdge[] = [];
  let unknownPage = false;
  const ok = (p: StepRecord["page"]) =>
    p?.pageId !== undefined && (p.kind === "exact" || p.kind === "similar");
  for (const m of opus.moves) {
    const a = bySeq.get(m.seq);
    if (!a) continue;
    const fromStep = steps[a.on];
    const toStep = steps[a.on + 1];
    // 다음 화면이 없는 행동(마지막 행동)이나 같은 페이지 안의 행동은 이동이 아님 (3.3)
    if (!toStep || (fromStep?.page?.pageId && fromStep.page.pageId === toStep.page?.pageId)) {
      block.push("move_not_navigation");
      continue;
    }
    if (!fromStep || !ok(fromStep.page) || !ok(toStep.page)) {
      unknownPage = true;
      continue;
    }
    edges.push({
      from: fromStep.page?.pageId ?? "",
      to: toStep.page?.pageId ?? "",
      action: a.action,
      text: a.text,
      pkg: fromStep.pkg,
    });
  }
  if (unknownPage) human.push("page_unknown");

  const reasons = [...new Set([...block, ...human])];
  const outcome: ReviewOutcome =
    block.length > 0 ? "reject" : human.length > 0 ? "human" : "accept";
  return { outcome, reasons, edges: block.length > 0 ? [] : edges };
}
