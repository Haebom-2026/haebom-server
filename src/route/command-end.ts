/**
 * 끝 신호: POST /v1/elder/commands/{commandId}/end (docs/jev-routing-plan.md 6장, R3).
 *
 * 명령이 끝났음(done·gave_up·stopped_user·stopped_safe)과 마지막 화면을 받는다.
 * - 한 번 정한 결과는 바꾸지 않는다 (같은 결과 재전송은 200, 다른 결과는 409)
 * - 마지막 화면은 dev 디버그 저장소에 둔다 (prod 는 개인정보 정책 뒤)
 * - done·stopped_safe 이면 DynamoDB Stream 으로 Opus 검토가 돈다 (dev 의 review-fn, 판정만)
 */
import { z } from "zod";
import { deviceIdSchema, screenSchema } from "../debug/schema.js";
import type { GuideTraceRecorder } from "../debug/guide-trace.js";
import { LAST_ACTIONS } from "../ai/guide-schema.js";
import { ApiError } from "../shared/errors.js";
import { maskText } from "../shared/sensitive.js";
import type { Logger } from "../shared/logger.js";
import type { MapLearnStore } from "../map/learn.js";
import {
  END_RESULTS,
  type CommandRecord,
  type CommandStore,
  type EndResult,
  type ScreenRef,
} from "./command-store.js";

export const endCommandRequestSchema = z.object({
  result: z.enum(END_RESULTS),
  /** 끝났을 때의 화면. 성공 판정의 근거라 done 이면 보내는 것을 권함 */
  finalScreen: screenSchema.optional(),
  deviceId: deviceIdSchema.optional(),
  /** 마지막 guide 화면에서 한 마지막 행동 (예: 밝기 막대 밀기). 다음 guide 가 없으니 여기로 보낸다 */
  lastAction: z
    .object({
      stepId: z.string().max(40).optional(),
      seq: z.number().int().nonnegative(),
      action: z.enum(LAST_ACTIONS),
      text: z.string().max(100).default(""),
    })
    .optional(),
});

export type EndCommandRequest = z.output<typeof endCommandRequestSchema>;

export interface EndCommandResponse {
  commandId: number;
  result: EndResult;
  /** 마지막 화면을 저장했는지 (dev 만) */
  finalScreenSaved: boolean;
}

/** Opus 검토 대상 (gave_up·stopped_user 는 지도에 더하지 않음, 7.1) */
export const REVIEWABLE_RESULTS: readonly EndResult[] = ["done", "stopped_safe"];

export async function endCommand(
  uid: string,
  commandId: number,
  body: EndCommandRequest,
  deps: {
    commands: CommandStore;
    recorder?: GuideTraceRecorder | undefined;
    /** (R5, dev) 지도 안내 중 포기·중단으로 끝나면 마지막 지도 안내의 실패로 센다 (8.3) */
    learn?: MapLearnStore | undefined;
    log: Logger;
    now?: () => Date;
  },
  /** 충돌 뒤 한 번 다시 읽을 때: 처음 읽은 명령의 gen (다른 명령이면 409) */
  retryOf?: string,
): Promise<EndCommandResponse> {
  const record = await deps.commands.get(uid, commandId);
  if (!record) throw new ApiError("not-found", "명령이 없거나 지났습니다");
  if (retryOf !== undefined && record.gen !== retryOf) {
    throw new ApiError("conflict", "명령이 바뀌었습니다. 다시 시도해 주세요");
  }

  if (record.endResult !== undefined) {
    if (record.endResult !== body.result) {
      throw new ApiError("conflict", "이미 다른 결과로 끝났습니다");
    }
    return { commandId, result: record.endResult, finalScreenSaved: !!record.finalScreen };
  }

  const now = (deps.now ?? (() => new Date()))();
  let finalScreen: ScreenRef | undefined;
  if (body.finalScreen && deps.recorder) {
    try {
      const saved = await deps.recorder.recordFinal({
        uid,
        screen: body.finalScreen,
        receivedAt: now,
        deviceId: body.deviceId,
        commandId,
        result: body.result,
      });
      finalScreen = { deviceId: saved.deviceId, screenId: saved.screenId };
    } catch (error) {
      // 화면 저장 실패는 끝 신호를 막지 않는다 (검토에서 마지막 화면 없음으로 처리)
      deps.log.warn("final screen save failed", { error });
    }
  }

  const result = await deps.commands.update(uid, commandId, record, {
    endResult: body.result,
    endedAt: now.toISOString(),
    ...(finalScreen ? { finalScreen } : {}),
    // 마지막 행동 글자는 dev(기록기가 있을 때)에만 저장 (prod 는 개인정보 정책 뒤)
    ...(body.lastAction && deps.recorder
      ? {
          finalAction: {
            ...(body.lastAction.stepId === undefined ? {} : { stepId: body.lastAction.stepId }),
            seq: body.lastAction.seq,
            action: body.lastAction.action,
            // 글자 넣기는 넣은 값을 남기지 않는다 (인증번호·PIN 일 수 있음)
            text: body.lastAction.action === "type" ? "" : maskText(body.lastAction.text).text,
          },
        }
      : {}),
  });
  if (result === "missing") throw new ApiError("not-found", "명령이 없거나 지났습니다");
  if (result === "conflict") {
    // 다른 쓰기(앱 선택 등)와 겹침 → 같은 명령을 한 번 다시 읽어 처리
    if (retryOf !== undefined) {
      throw new ApiError("conflict", "명령이 바뀌었습니다. 다시 시도해 주세요");
    }
    return endCommand(uid, commandId, body, deps, record.gen);
  }

  await countMapFailure(record, body.result, deps, now);

  deps.log.info("command ended", {
    commandId,
    result: body.result,
    finalScreen: !!finalScreen,
    chosenApp: record.chosenApp,
    level: record.level,
    review: REVIEWABLE_RESULTS.includes(body.result),
  });
  return { commandId, result: body.result, finalScreenSaved: !!finalScreen };
}

/** 지도가 안내하던 중(mode map) 포기·중단으로 끝나면 마지막으로 쓴 연결선·끝 단계의 실패 (8.3). 실패는 기록만 */
async function countMapFailure(
  record: CommandRecord,
  result: EndResult,
  deps: { learn?: MapLearnStore | undefined; log: Logger },
  now: Date,
): Promise<void> {
  const progress = record.mapProgress;
  if (!deps.learn || (result !== "gave_up" && result !== "stopped_user")) return;
  if (progress?.mode !== "map" || progress.stepId === undefined || progress.ref === undefined)
    return;
  const target =
    progress.kind === "edge"
      ? { kind: "edge" as const, id: progress.ref }
      : record.chosenGoal
        ? { kind: "goal" as const, id: record.chosenGoal }
        : undefined;
  if (!target) return;
  try {
    const out = await deps.learn.recordResult(target, false, now);
    deps.log.info("map failure counted", { ...target, result, out });
  } catch (error) {
    deps.log.warn("map failure count failed", { error });
  }
}
