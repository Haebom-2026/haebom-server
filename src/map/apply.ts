/**
 * 검토 결과 → 지도 자동 반영 (docs/jev-routing-plan.md 7.3·8장, R5, dev).
 *
 * - accept + 기존 목표 + 민감하지 않음 → 연결선·도착 화면에 증거를 더한다 (후보, 기기 2대면 verified)
 * - 새 목표·L2 이상·민감한 끝 단계·끝 단계 충돌·human 판정 → 사람 확인 대기 (PENDING)
 * - reject·error·성공 아님 → 아무것도 안 함
 * 무효가 된 검토(끝난 뒤 사기 의심·L3·L2)는 retractCommand 로 넣었던 증거를 거둬들인다.
 */
import { uidDeviceId } from "../debug/guide-trace.js";
import type { ScreenDocument } from "../debug/store.js";
import type { CommandLog } from "../route/command-log.js";
import type { CommandStore, ScreenRef } from "../route/command-store.js";
import type { IndexedMap } from "../route/map.js";
import { stepsOfCommand, type ReviewRecord } from "../review/review.js";
import type { Logger } from "../shared/logger.js";
import { evidenceEntry, type MapLearnStore, type PendingReason } from "./learn.js";
import { buildSeed } from "./seed.js";

export interface ApplyDeps {
  commands: CommandStore;
  commandLog: CommandLog;
  getScreen: (ref: ScreenRef) => Promise<ScreenDocument | undefined>;
  learn: MapLearnStore;
  map: IndexedMap;
  log: Logger;
  now?: () => Date;
}

export type ApplyOutcome =
  | { kind: "applied"; edges: number; promoted: number; arrive: string }
  | { kind: "pending"; reasons: string[] }
  | { kind: "skipped"; reason: string };

const LEVEL_RANK = { L0: 0, L1: 1, L2: 2, L3: 3 } as const;

export async function applyReview(
  uid: string,
  commandId: number,
  review: ReviewRecord,
  deps: ApplyDeps,
): Promise<ApplyOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const skip = (reason: string): ApplyOutcome => {
    deps.log.info("map apply skipped", { commandId, reason });
    return { kind: "skipped", reason };
  };
  const pending = async (reasons: string[]): Promise<ApplyOutcome> => {
    const goal = review.goal;
    await deps.learn.putPending({
      uid,
      commandId,
      gen: review.gen,
      reasons,
      ...(goal?.id ? { goalId: goal.id } : {}),
      ...(goal?.proposal ? { proposal: goal.proposal } : {}),
      createdAt: now.toISOString(),
    });
    deps.log.info("map apply pending", { commandId, reasons });
    return { kind: "pending", reasons };
  };

  if (review.outcome === "reject" || review.outcome === "error")
    return skip(`outcome-${review.outcome}`);
  if (review.opus?.success !== "yes") return skip("not-success");
  if (review.outcome === "human") return pending(["human_review", ...review.reasons]);
  // accept 인데도 새 목표면 사람 확인 (새 이름·설명은 jev 후보·프롬프트로 들어가므로, 8.2)
  if (review.goal?.kind !== "existing" || !review.goal.id) {
    return review.goal?.kind === "new" ? pending(["new_goal"]) : skip("no-goal");
  }

  const command = await deps.commands.get(uid, commandId);
  if (!command || command.gen !== review.gen) return skip("command-changed");
  const routeGoal = deps.map.goals.get(review.goal.id);
  if (!routeGoal) return skip("unknown-goal");
  const reasons: PendingReason[] = [];
  // L2 이상은 사람 승인 (8.2). 명령 단계와 목표 민감도 중 높은 것
  if (Math.max(LEVEL_RANK[routeGoal.level], LEVEL_RANK[command.level]) >= LEVEL_RANK.L2) {
    reasons.push("sensitive_goal");
  }

  const steps = stepsOfCommand(await deps.commandLog.listSteps(uid, commandId), command);
  const docs = await Promise.all(steps.map((s) => deps.getScreen(s.screen)));
  const finalDoc = command.finalScreen ? await deps.getScreen(command.finalScreen) : undefined;
  // 화면을 못 읽으면 (최종 일관성·잠깐의 오류) 지도를 쓰기 전에 던져서 다시 받는다: 빠진 화면으로 만든
  // 연결선·끝 단계는 나중의 온전한 길과 어긋난다 (Stream 재시도는 2번, 그 뒤 버림)
  if (docs.some((d) => d === undefined) || (command.finalScreen && !finalDoc)) {
    throw new Error(`map apply: screen missing (command ${commandId})`);
  }
  const device = steps.find((s) => s.screen.deviceId)?.screen.deviceId;
  if (!device) return skip("no-device");
  // 기기 id 없이 온 요청은 uid 기반 가상 기기에 기록된다. 같은 폰의 두 사람이 기기 2대로 세지 않게 뺀다
  if (device === uidDeviceId(uid)) return skip("virtual-device");

  const seed = buildSeed({ uid, command, review, steps, docs, finalDoc, now });
  if (!seed.ok) return skip(seed.error);
  if (seed.goal.finish.some((f) => f.sensitive)) reasons.push("sensitive_finish");
  if (reasons.length > 0) return pending(reasons);

  const goalId = seed.goal.goalId;
  if (
    (await deps.learn.ensureGoal({ goalId, pkg: seed.goal.pkg, finish: seed.goal.finish }, now)) ===
    "conflict"
  ) {
    return pending(["finish_conflict"]);
  }
  const entry = evidenceEntry(uid, commandId, review.gen, device);
  // 어디에 넣었는지 먼저 남긴다 (중간에 실패해도 나중에 무효가 되면 거둬들일 수 있게)
  await deps.learn.putApplied({
    uid,
    commandId,
    gen: review.gen,
    entry,
    edgeIds: seed.edges.map((e) => e.edgeId),
    goalId,
    arriveFp: seed.arriveFp,
  });
  let promoted = 0;
  for (const edge of seed.edges) {
    if ((await deps.learn.addEdgeEvidence(edge, entry, now)) === "promoted") promoted += 1;
  }
  if ((await deps.learn.addArriveEvidence(goalId, seed.arriveFp, entry, now)) === "promoted") {
    promoted += 1;
  }
  deps.log.info("map applied", {
    commandId,
    goalId,
    edges: seed.edges.length,
    promoted,
    warnings: seed.warnings,
  });
  return { kind: "applied", edges: seed.edges.length, promoted, arrive: seed.arriveFp };
}

/** 무효가 된 검토: 넣었던 증거를 거둬들이고 사람 확인 대기에서도 뺀다 */
export async function retractCommand(
  uid: string,
  commandId: number,
  gen: string,
  learn: MapLearnStore,
  now: Date,
): Promise<boolean> {
  await learn.deletePending(uid, commandId, gen);
  const applied = await learn.getApplied(uid, commandId, gen);
  if (!applied) return false;
  await learn.retract(applied, now);
  return true;
}
