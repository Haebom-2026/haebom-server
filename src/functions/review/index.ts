/**
 * review-fn: 끝난 명령을 Opus 로 검토 (docs/jev-routing-plan.md 7장, R3, dev 전용).
 *
 * main 테이블 DynamoDB Stream 에서, 명령 항목에 끝 신호(done·stopped_safe)가 처음 붙은 변경만
 * 받는다 (이벤트 필터는 infra/modules/review). 검토 결과는 판정만 저장하고 지도에 반영하지 않는다.
 * 실패한 레코드만 다시 받도록 batchItemFailures 를 돌려준다.
 */
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from "aws-lambda";
import { createAwsDebugStore } from "../../debug/aws-store.js";
import { createAwsCommandLog } from "../../route/command-log.js";
import { REVIEWABLE_RESULTS } from "../../route/command-end.js";
import { createAwsCommandStore, type EndResult } from "../../route/command-store.js";
import { parseMap } from "../../route/map.js";
import { SEED_MAP } from "../../route/seed-map.js";
import { requireEnv } from "../../shared/config.js";
import { createLogger } from "../../shared/logger.js";
import { createClaudeReviewModel, DEFAULT_REVIEW_MODEL } from "../../review/model.js";
import { reviewCommand, type ReviewDeps } from "../../review/review.js";

const log = createLogger({ service: "review" });

let deps: ReviewDeps | undefined;
function getDeps(): ReviewDeps {
  if (deps) return deps;
  const table = requireEnv("TABLE_MAIN");
  const debug = createAwsDebugStore({
    table: requireEnv("DEBUG_TABLE"),
    bucket: requireEnv("DEBUG_BUCKET"),
  });
  const modelName = process.env.REVIEW_MODEL ?? DEFAULT_REVIEW_MODEL;
  deps = {
    commands: createAwsCommandStore(table),
    commandLog: createAwsCommandLog(table),
    // 디버그 저장소에는 화면 말고 명령 기록 문서도 있다 → 화면(screen 이 있는 것)만
    getScreen: async (ref) => {
      const doc = await debug.getScreen(ref.deviceId, ref.screenId);
      return doc && "screen" in doc ? doc : undefined;
    },
    model: createClaudeReviewModel(modelName),
    modelName,
    map: parseMap(SEED_MAP),
    log,
  };
  return deps;
}

/** 스트림 레코드 → 검토할 명령 (uid, commandId). 대상이 아니면 undefined */
export function commandOf(
  newImage: Record<string, unknown> | undefined,
  oldImage: Record<string, unknown> | undefined,
): { uid: string; commandId: number; gen?: string } | undefined {
  if (!newImage || newImage.type !== "command") return undefined;
  const result = newImage.endResult as EndResult | undefined;
  if (!result || !REVIEWABLE_RESULTS.includes(result)) return undefined;
  if (oldImage?.endResult !== undefined) return undefined; // 이미 끝난 명령의 다른 변경
  const pk = typeof newImage.PK === "string" ? newImage.PK : "";
  const sk = typeof newImage.SK === "string" ? newImage.SK : "";
  const uid = pk.startsWith("ELDER#") ? pk.slice("ELDER#".length) : "";
  const match = /^CMD#(\d+)$/.exec(sk);
  if (!uid || !match?.[1]) return undefined;
  const gen = typeof newImage.gen === "string" ? newImage.gen : undefined;
  return { uid, commandId: Number(match[1]), ...(gen ? { gen } : {}) };
}

const toPlain = (image: unknown) =>
  image
    ? (unmarshall(image as Record<string, AttributeValue>) as Record<string, unknown>)
    : undefined;

/** 이미 끝난 명령이 나중에(classify 재시도) 사기 의심·L3·degraded(→ reject) 또는 L2(→ human) 로 바뀐 변경 */
export function becameUnsafe(
  newImage: Record<string, unknown> | undefined,
  oldImage: Record<string, unknown> | undefined,
): { uid: string; commandId: number; gen: string; outcome: "reject" | "human" } | undefined {
  if (!newImage || !oldImage || newImage.type !== "command") return undefined;
  if (oldImage.endResult === undefined || newImage.gen !== oldImage.gen) return undefined;
  const unsafe = (img: Record<string, unknown>) =>
    img.category === "scam" || img.level === "L3" || img.degraded === true;
  const l2 = (img: Record<string, unknown>) => img.level === "L2";
  let outcome: "reject" | "human";
  if (unsafe(newImage) && !unsafe(oldImage)) outcome = "reject";
  else if (l2(newImage) && !l2(oldImage) && !unsafe(oldImage)) outcome = "human";
  else return undefined;
  const target = commandOf(newImage, { ...oldImage, endResult: undefined });
  return target?.gen
    ? { uid: target.uid, commandId: target.commandId, gen: target.gen, outcome }
    : undefined;
}

export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    const target = commandOf(
      toPlain(record.dynamodb?.NewImage),
      toPlain(record.dynamodb?.OldImage),
    );
    const turned = becameUnsafe(
      toPlain(record.dynamodb?.NewImage),
      toPlain(record.dynamodb?.OldImage),
    );
    if (turned) {
      try {
        await getDeps().commandLog.invalidateReview(
          turned.uid,
          turned.commandId,
          turned.gen,
          turned.outcome === "reject" ? "became_sensitive_after_end" : "became_l2_after_end",
          turned.outcome,
        );
        log.info("review invalidated", { commandId: turned.commandId });
      } catch (error) {
        log.error("review invalidate failed", { commandId: turned.commandId, error });
        if (record.dynamodb?.SequenceNumber) {
          failures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
        }
      }
      continue;
    }
    if (!target) continue;
    try {
      await reviewCommand(target.uid, target.commandId, getDeps(), target.gen);
    } catch (error) {
      log.error("review failed", { commandId: target.commandId, error });
      if (record.dynamodb?.SequenceNumber) {
        failures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
      }
    }
  }
  return { batchItemFailures: failures };
};
