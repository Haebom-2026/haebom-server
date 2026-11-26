/**
 * Idempotency-Key 처리 (docs/server-plan.md 4.1, 3.2 haebom-<env>-idem).
 * 같은 사용자·같은 키로 다시 오면 첫 응답을 그대로 돌려준다.
 * 5xx·예상 못 한 오류는 기록을 지워 같은 키로 다시 시도할 수 있게 한다.
 */
import { createHash } from "node:crypto";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { requireAuth } from "./auth.js";
import { ApiError } from "./errors.js";
import { errorResult, type HttpEvent, type HttpResult } from "./http.js";
import type { RouteHandler } from "./router.js";

export const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export type BeginResult =
  | { state: "new" }
  | { state: "in-progress" }
  | { state: "done"; requestHash: string; statusCode: number; body: string };

export interface IdempotencyStore {
  begin(key: string, requestHash: string, now: Date): Promise<BeginResult>;
  complete(key: string, statusCode: number, body: string): Promise<void>;
  abort(key: string): Promise<void>;
}

function headerValue(event: HttpEvent, name: string): string | undefined {
  // HTTP API 는 헤더 이름을 소문자로 넘긴다.
  return event.headers[name] ?? event.headers[name.toLowerCase()];
}

function requestHash(event: HttpEvent): string {
  return createHash("sha256")
    .update(`${event.requestContext.http.method} ${event.rawPath}\n${event.body ?? ""}`)
    .digest("hex");
}

/** Idempotency-Key 헤더가 있을 때만 적용한다 (없으면 그대로 실행). */
export function idempotent(
  store: IdempotencyStore,
  handler: RouteHandler,
  now: () => Date = () => new Date(),
): RouteHandler {
  return async (ctx) => {
    const rawKey = headerValue(ctx.event, "Idempotency-Key");
    if (rawKey === undefined) return handler(ctx);
    if (!KEY_PATTERN.test(rawKey)) {
      throw new ApiError(
        "invalid-argument",
        "Idempotency-Key must be 8-128 chars of [A-Za-z0-9_-]",
      );
    }

    const { uid } = requireAuth(ctx.event);
    const key = `${uid}#${rawKey}`;
    const hash = requestHash(ctx.event);
    const begun = await store.begin(key, hash, now());

    if (begun.state === "in-progress") {
      throw new ApiError("conflict", "A request with this Idempotency-Key is in progress");
    }
    if (begun.state === "done") {
      if (begun.requestHash !== hash) {
        throw new ApiError("invalid-argument", "Idempotency-Key was used for a different request");
      }
      ctx.log.info("idempotent replay", { statusCode: begun.statusCode });
      return {
        statusCode: begun.statusCode,
        headers: { "content-type": "application/json; charset=utf-8", "idempotent-replay": "true" },
        body: begun.body,
      };
    }

    let result: HttpResult;
    try {
      result = await handler(ctx);
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) {
        result = errorResult(error);
      } else {
        await store.abort(key);
        throw error;
      }
    }

    const statusCode = result.statusCode ?? 200;
    if (statusCode >= 500) {
      await store.abort(key);
    } else {
      await store.complete(key, statusCode, result.body ?? "");
    }
    return result;
  };
}

export function createAwsIdempotencyStore(
  table: string,
  client: DynamoDBClient = new DynamoDBClient({}),
): IdempotencyStore {
  const doc = DynamoDBDocumentClient.from(client);
  return {
    async begin(key, hash, now) {
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: {
              key,
              state: "pending",
              requestHash: hash,
              createdAt: now.toISOString(),
              ttl: Math.floor(now.getTime() / 1000) + IDEMPOTENCY_TTL_SECONDS,
            },
            ConditionExpression: "attribute_not_exists(#k)",
            ExpressionAttributeNames: { "#k": "key" },
          }),
        );
        return { state: "new" };
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
      }
      const out = await doc.send(
        new GetCommand({ TableName: table, Key: { key }, ConsistentRead: true }),
      );
      const item = out.Item;
      if (item?.state !== "done") return { state: "in-progress" };
      return {
        state: "done",
        requestHash: String(item.requestHash),
        statusCode: Number(item.statusCode),
        body: String(item.body ?? ""),
      };
    },
    async complete(key, statusCode, body) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { key },
          UpdateExpression: "SET #s = :done, statusCode = :code, body = :body",
          ExpressionAttributeNames: { "#s": "state" },
          ExpressionAttributeValues: { ":done": "done", ":code": statusCode, ":body": body },
        }),
      );
    },
    async abort(key) {
      await doc.send(new DeleteCommand({ TableName: table, Key: { key } }));
    },
  };
}
