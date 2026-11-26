/**
 * GuideCacheStore 의 DynamoDB 구현.
 *
 * 테이블 haebom-<env>-ai-cache (key, ttl)
 *   key       guideCacheKey() 결과 (SHA-256)
 *   response  저장한 응답 (requestId 제외)
 *   savedAt   저장 시각 (ISO)
 *   ttl       만료 시각 (epoch 초, DynamoDB TTL)
 * 화면 요소 원문은 저장하지 않는다 (키는 해시, 응답의 say·targetText 는 이미 마스킹됨).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { CachedGuide, CachedGuideResponse, GuideCacheStore } from "./guide-cache.js";

export interface AwsGuideCacheOptions {
  table: string;
  dynamo?: DynamoDBClient;
  now?: () => number;
}

export function createAwsGuideCache(options: AwsGuideCacheOptions): GuideCacheStore {
  const doc = DynamoDBDocumentClient.from(options.dynamo ?? new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const now = options.now ?? Date.now;

  return {
    async get(key) {
      const { Item } = await doc.send(new GetCommand({ TableName: options.table, Key: { key } }));
      if (!Item) return undefined;
      // TTL 삭제는 늦을 수 있어서 만료를 직접 확인
      if (typeof Item.ttl === "number" && Item.ttl * 1000 <= now()) return undefined;
      return {
        response: Item.response as CachedGuideResponse,
        savedAt: String(Item.savedAt ?? ""),
      };
    },
    async put(key, value: CachedGuide, ttlSeconds) {
      await doc.send(
        new PutCommand({
          TableName: options.table,
          Item: {
            key,
            response: value.response,
            savedAt: value.savedAt,
            ttl: Math.floor(now() / 1000) + ttlSeconds,
          },
        }),
      );
    },
  };
}
