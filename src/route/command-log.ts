/**
 * 명령 단계 기록과 Opus 검토 결과 (docs/jev-routing-plan.md 3.6·6·7장, R3).
 *
 * dev 전용: 화면 원본은 디버그 저장소에 있고, 여기에는 단계마다 그 화면을 가리키는 줄과
 * 안내·실제 행동만 둔다. prod 기록은 개인정보 정책(12장 3)이 정해진 뒤에 켠다.
 *
 * 키 (main 테이블)
 *   단계: ELDER#<uid> / CMD#<commandId>#STEP#<받은 시각 ISO>#<stepId>   (시간순으로 정렬됨)
 *   검토: ELDER#<uid> / CMD#<commandId>#REVIEW#<gen>   (명령 세대마다 한 번)
 */
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { ScreenRef } from "./command-store.js";

export const STEP_TTL_SECONDS = 3 * 24 * 3600;
/** 사람이 표본을 볼 시간 */
export const REVIEW_TTL_SECONDS = 30 * 24 * 3600;

export interface StepAction {
  stepId?: string;
  seq: number;
  action: string;
  /** 가린 글자 */
  text: string;
}

export interface StepRecord {
  uid: string;
  commandId: number;
  stepId: string;
  receivedAt: string;
  screen: ScreenRef;
  /** 화면 매칭 결과 (match@v1): 이미 본 어느 페이지인지 */
  page?: { kind: string; pageId?: string };
  pkg: string;
  /** 서버가 준 안내 요약 */
  guide: { type: string; targetText?: string; dir?: string; status?: string; source: "ai" | "map" };
  /** 이 화면에 오기 직전에 어르신이 한 행동 */
  lastAction?: StepAction;
}

export interface CommandLog {
  appendStep(step: StepRecord): Promise<void>;
  listSteps(uid: string, commandId: number): Promise<StepRecord[]>;
  /** 명령 세대(gen)마다 한 번만 저장. 이미 있으면 false (덮어쓰지 않음) */
  saveReview(uid: string, commandId: number, gen: string, review: unknown): Promise<boolean>;
  getReview(uid: string, commandId: number, gen: string): Promise<unknown>;
  /**
   * 검토 뒤 명령이 바뀌면 판정을 낮춘다 (판정이 없으면 아무것도 안 함).
   * reject: 사기 의심·L3 → 무조건 reject, 연결선 지움 / human: L2 로 올라감 → accept 였던 것만 human
   */
  invalidateReview(
    uid: string,
    commandId: number,
    gen: string,
    reason: string,
    outcome?: "reject" | "human",
  ): Promise<void>;
}

const pk = (uid: string) => `ELDER#${uid}`;
const stepPrefix = (commandId: number) => `CMD#${commandId}#STEP#`;
/** 검토는 명령 세대(gen)에 묶는다: 하루 뒤 같은 번호의 새 명령은 따로 검토 */
const reviewSk = (commandId: number, gen: string) => `CMD#${commandId}#REVIEW#${gen}`;

export function createAwsCommandLog(
  table: string,
  client: DynamoDBClient = new DynamoDBClient({}),
  now: () => Date = () => new Date(),
): CommandLog {
  const doc = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const nowSec = () => Math.floor(now().getTime() / 1000);

  return {
    async appendStep(step) {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            PK: pk(step.uid),
            SK: `${stepPrefix(step.commandId)}${step.receivedAt}#${step.stepId}`,
            type: "command-step",
            ...step,
            ttl: nowSec() + STEP_TTL_SECONDS,
          },
        }),
      );
    },

    async listSteps(uid, commandId) {
      const items: StepRecord[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const out = await doc.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
            ExpressionAttributeValues: { ":pk": pk(uid), ":sk": stepPrefix(commandId) },
            ConsistentRead: true,
            ExclusiveStartKey: start,
          }),
        );
        for (const item of out.Items ?? []) items.push(item as unknown as StepRecord);
        start = out.LastEvaluatedKey;
      } while (start !== undefined);
      return items;
    },

    async saveReview(uid, commandId, gen, review) {
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: {
              PK: pk(uid),
              SK: reviewSk(commandId, gen),
              type: "command-review",
              review,
              ttl: nowSec() + REVIEW_TTL_SECONDS,
            },
            ConditionExpression: "attribute_not_exists(PK)",
          }),
        );
        return true;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return false;
        throw error;
      }
    },

    async invalidateReview(uid, commandId, gen, reason, outcome = "reject") {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { PK: pk(uid), SK: reviewSk(commandId, gen) },
            ...(outcome === "reject"
              ? {
                  ConditionExpression: "attribute_exists(PK)",
                  UpdateExpression:
                    "SET review.outcome = :o, review.invalidated = :r, review.edges = :empty",
                  ExpressionAttributeValues: { ":o": "reject", ":r": reason, ":empty": [] },
                }
              : {
                  ConditionExpression: "attribute_exists(PK) AND review.outcome = :accept",
                  UpdateExpression: "SET review.outcome = :o, review.invalidated = :r",
                  ExpressionAttributeValues: { ":o": "human", ":r": reason, ":accept": "accept" },
                }),
          }),
        );
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
      }
    },

    async getReview(uid, commandId, gen) {
      const out = await doc.send(
        new GetCommand({
          TableName: table,
          Key: { PK: pk(uid), SK: reviewSk(commandId, gen) },
          ConsistentRead: true,
        }),
      );
      return (out.Item as { review?: unknown } | undefined)?.review;
    },
  };
}
