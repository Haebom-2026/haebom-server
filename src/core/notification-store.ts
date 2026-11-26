/**
 * NotificationStore 의 DynamoDB 구현 (haebom-<env>-main).
 *
 *   ELDER#<eid>    / NOTI#<id>          원본 (type=notification)
 *   GUARDIAN#<gid> / NOTI#<id>          보호자 알림함 (type=inbox) → Streams INSERT 로 FCM
 *   ELDER#<eid>    / DEDUP#<package>    민감 알림 10분 중복 방지 표식
 * id 는 시각으로 시작해 SK 정렬 = 시간순이다.
 */
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ApiError } from "../shared/errors.js";
import {
  NOTIFICATION_TTL_SECONDS,
  compactTime,
  type InboxItem,
  type NotificationRecord,
  type NotificationStore,
} from "./notifications.js";

type Item = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const optStr = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

function toInbox(item: Item): InboxItem {
  const out: InboxItem = {
    id: str(item.id),
    elderId: str(item.elderId),
    guardianId: str(item.guardianId),
    elderName: str(item.elderName),
    elderLabel: str(item.elderLabel),
    type: str(item.notificationType) as InboxItem["type"],
    packageName: str(item.packageName),
    appName: str(item.appName),
    createdAt: str(item.createdAt),
  };
  const level = optStr(item.level);
  const category = optStr(item.category);
  const reason = optStr(item.reason);
  const readAt = optStr(item.readAt);
  if (level) out.level = level as NonNullable<InboxItem["level"]>;
  if (category) out.category = category as NonNullable<InboxItem["category"]>;
  if (reason) out.reason = reason;
  if (readAt) out.readAt = readAt;
  return out;
}

/** 알림 내용 필드 (type 은 항목 종류와 겹쳐 notificationType 으로 저장) */
function contentFields(record: NotificationRecord): Item {
  const { type, ...rest } = record;
  return { ...rest, notificationType: type };
}

function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  if (key === undefined) return undefined;
  return Buffer.from(String(key.SK)).toString("base64url");
}

function decodeCursor(cursor: string): string {
  const sk = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^NOTI#n\d{8}T\d{9}Z-[0-9a-f]{6}$/.test(sk)) {
    throw new ApiError("invalid-argument", "invalid cursor");
  }
  return sk;
}

export function createAwsNotificationStore(
  table: string,
  client: DynamoDBClient = new DynamoDBClient({}),
): NotificationStore {
  const doc = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });

  return {
    async create(record, inbox, { dedupUntil, now }) {
      const ttl = Math.floor(Date.parse(record.createdAt) / 1000) + NOTIFICATION_TTL_SECONDS;
      const sk = `NOTI#${record.id}`;
      const items = [
        ...(dedupUntil === undefined
          ? []
          : [
              {
                Put: {
                  TableName: table,
                  Item: {
                    PK: `ELDER#${record.elderId}`,
                    SK: `DEDUP#${record.packageName}`,
                    until: dedupUntil,
                    ttl: Math.floor(Date.parse(dedupUntil) / 1000) + 3600,
                  },
                  ConditionExpression: "attribute_not_exists(PK) OR #u < :now",
                  ExpressionAttributeNames: { "#u": "until" },
                  ExpressionAttributeValues: { ":now": now },
                },
              },
            ]),
        {
          Put: {
            TableName: table,
            Item: {
              PK: `ELDER#${record.elderId}`,
              SK: sk,
              type: "notification",
              ...contentFields(record),
              guardianIds: inbox.map((i) => i.guardianId),
              ttl,
            },
          },
        },
        ...inbox.map((entry) => ({
          Put: {
            TableName: table,
            Item: {
              PK: `GUARDIAN#${entry.guardianId}`,
              SK: sk,
              type: "inbox",
              ...contentFields(entry),
              ttl,
            },
          },
        })),
      ];
      try {
        await doc.send(new TransactWriteCommand({ TransactItems: items }));
        return "created";
      } catch (error) {
        if (
          dedupUntil !== undefined &&
          error instanceof TransactionCanceledException &&
          error.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed"
        ) {
          return "duplicate_suppressed";
        }
        throw error;
      }
    },

    async listInbox(guardianId, { cursor, since, limit }) {
      const values: Item = { ":pk": `GUARDIAN#${guardianId}`, ":sk": "NOTI#" };
      let condition = "PK = :pk AND begins_with(SK, :sk)";
      if (since !== undefined) {
        // since 시각 이후(id 가 시각으로 시작). "~" 는 숫자·문자보다 뒤라 같은 시각 안의 id 를 모두 포함하지 않는다.
        condition = "PK = :pk AND SK > :since";
        values[":since"] = `NOTI#n${compactTime(new Date(since))}-~`;
        delete values[":sk"];
      }
      const out = await doc.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: condition,
          ExpressionAttributeValues: values,
          ScanIndexForward: false,
          Limit: limit,
          ...(cursor === undefined
            ? {}
            : { ExclusiveStartKey: { PK: `GUARDIAN#${guardianId}`, SK: decodeCursor(cursor) } }),
        }),
      );
      // since 조건은 NOTI# 아닌 다른 SK(LINK# 등은 GSI 라 없음)와 섞이지 않도록 한 번 더 거른다.
      const items = (out.Items ?? []).filter((item) => item.type === "inbox").map(toInbox);
      const nextCursor = encodeCursor(out.LastEvaluatedKey);
      return nextCursor === undefined ? { items } : { items, nextCursor };
    },

    async markRead(guardianId, id, readAt) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { PK: `GUARDIAN#${guardianId}`, SK: `NOTI#${id}` },
            UpdateExpression: "SET readAt = if_not_exists(readAt, :at)",
            ConditionExpression: "attribute_exists(PK)",
            ExpressionAttributeValues: { ":at": readAt },
          }),
        );
        return true;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return false;
        throw error;
      }
    },

    async deleteInboxForElder(guardianId, elderId) {
      const keys: { PK: string; SK: string }[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const out = await doc.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
            FilterExpression: "elderId = :eid",
            ExpressionAttributeValues: {
              ":pk": `GUARDIAN#${guardianId}`,
              ":sk": "NOTI#",
              ":eid": elderId,
            },
            ProjectionExpression: "PK, SK",
            ExclusiveStartKey: start,
          }),
        );
        for (const item of out.Items ?? []) keys.push({ PK: str(item.PK), SK: str(item.SK) });
        start = out.LastEvaluatedKey;
      } while (start !== undefined);

      for (let i = 0; i < keys.length; i += 25) {
        let pending = keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
        for (let attempt = 0; pending.length > 0 && attempt < 5; attempt++) {
          const out = await doc.send(new BatchWriteCommand({ RequestItems: { [table]: pending } }));
          pending = (out.UnprocessedItems?.[table] ?? []) as typeof pending;
        }
      }
      return keys.length;
    },
  };
}
