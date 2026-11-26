/**
 * ApprovalStore 의 DynamoDB 구현 (haebom-<env>-main).
 *
 *   APPROVAL#<id>  / META             원본 (type=approval)
 *                                      GSI1: ELDER#<eid> / APPROVAL#<id>   어르신의 승인
 *                                      GSI2: PENDING / <expiresAt>#<id>    pending 일 때만 (expire-fn)
 *   GUARDIAN#<gid> / APPROVAL#<id>    보호자별 항목 (type=guardian_approval) → INSERT 시 FCM
 *   ELDER#<eid>    / PENDING#<action> 같은 action 의 pending 잠금
 * id 는 시각으로 시작해 SK 정렬 = 시간순이다.
 */
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ApiError } from "../shared/errors.js";
import {
  APPROVAL_RETENTION_SECONDS,
  type ApprovalRecord,
  type ApprovalStatus,
  type ApprovalStore,
  type GuardianApproval,
  type TransitionGuard,
} from "./approvals.js";
import type { Category } from "./notifications.js";

type Item = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const optStr = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const approvalPk = (id: string) => `APPROVAL#${id}`;
const lockKey = (elderId: string, action: string) => ({
  PK: `ELDER#${elderId}`,
  SK: `PENDING#${action}`,
});

function common(item: Item) {
  const out = {
    id: str(item.id),
    elderId: str(item.elderId),
    elderName: str(item.elderName),
    packageName: str(item.packageName),
    appName: str(item.appName),
    action: str(item.action),
    status: str(item.status) as ApprovalStatus,
    createdAt: str(item.createdAt),
    expiresAt: str(item.expiresAt),
    updatedAt: str(item.updatedAt),
  };
  const extra: Partial<ApprovalRecord> = {};
  const category = optStr(item.category);
  if (category) extra.category = category as Category;
  const respondedAt = optStr(item.respondedAt);
  const respondedBy = optStr(item.respondedBy);
  const respondedByLabel = optStr(item.respondedByLabel);
  if (respondedAt) extra.respondedAt = respondedAt;
  if (respondedBy) extra.respondedBy = respondedBy;
  if (respondedByLabel) extra.respondedByLabel = respondedByLabel;
  return { ...out, ...extra };
}

export function toApproval(item: Item): ApprovalRecord {
  const ids = Array.isArray(item.guardianIds)
    ? item.guardianIds.filter((v) => typeof v === "string")
    : [];
  return { ...common(item), guardianIds: ids };
}

export function toGuardianApproval(item: Item): GuardianApproval {
  return { ...common(item), guardianId: str(item.guardianId), elderLabel: str(item.elderLabel) };
}

function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  return key === undefined ? undefined : Buffer.from(String(key.SK)).toString("base64url");
}

function decodeCursor(cursor: string): string {
  const sk = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^APPROVAL#a\d{8}T\d{9}Z-[0-9a-f]{6}$/.test(sk)) {
    throw new ApiError("invalid-argument", "invalid cursor");
  }
  return sk;
}

export function createAwsApprovalStore(
  table: string,
  client: DynamoDBClient = new DynamoDBClient({}),
): ApprovalStore {
  const doc = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });

  const ttlOf = (createdAt: string) =>
    Math.floor(Date.parse(createdAt) / 1000) + APPROVAL_RETENTION_SECONDS;

  async function getOriginal(id: string): Promise<ApprovalRecord | undefined> {
    const out = await doc.send(
      new GetCommand({
        TableName: table,
        Key: { PK: approvalPk(id), SK: "META" },
        ConsistentRead: true,
      }),
    );
    return out.Item === undefined ? undefined : toApproval(out.Item);
  }

  async function queryKeys(input: {
    pk: string;
    prefix: string;
    filter: string;
    values: Item;
  }): Promise<{ PK: string; SK: string }[]> {
    const keys: { PK: string; SK: string }[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out = await doc.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          FilterExpression: input.filter,
          ExpressionAttributeValues: { ":pk": input.pk, ":prefix": input.prefix, ...input.values },
          ProjectionExpression: "PK, SK",
          ExclusiveStartKey: start,
        }),
      );
      for (const item of out.Items ?? []) keys.push({ PK: str(item.PK), SK: str(item.SK) });
      start = out.LastEvaluatedKey;
    } while (start !== undefined);
    return keys;
  }

  return {
    async create(record, items, now) {
      const ttl = ttlOf(record.createdAt);
      try {
        await doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: table,
                  Item: {
                    ...lockKey(record.elderId, record.action),
                    approvalId: record.id,
                    expiresAt: record.expiresAt,
                    ttl: Math.floor(Date.parse(record.expiresAt) / 1000) + 3600,
                  },
                  // 잠금이 없거나, 이전 승인의 응답 시간이 이미 지났으면 새로 잡는다.
                  ConditionExpression: "attribute_not_exists(PK) OR expiresAt <= :now",
                  ExpressionAttributeValues: { ":now": now },
                },
              },
              {
                Put: {
                  TableName: table,
                  Item: {
                    PK: approvalPk(record.id),
                    SK: "META",
                    type: "approval",
                    GSI1PK: `ELDER#${record.elderId}`,
                    GSI1SK: `APPROVAL#${record.id}`,
                    GSI2PK: "PENDING",
                    GSI2SK: `${record.expiresAt}#${record.id}`,
                    ...record,
                    ttl,
                  },
                },
              },
              ...items.map((item) => ({
                Put: {
                  TableName: table,
                  Item: {
                    PK: `GUARDIAN#${item.guardianId}`,
                    SK: `APPROVAL#${item.id}`,
                    type: "guardian_approval",
                    ...item,
                    ttl,
                  },
                },
              })),
            ],
          }),
        );
        return "created";
      } catch (error) {
        if (
          error instanceof TransactionCanceledException &&
          error.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed"
        ) {
          return "locked";
        }
        throw error;
      }
    },

    get: getOriginal,

    async lockedApprovalId(elderId, action) {
      const out = await doc.send(
        new GetCommand({ TableName: table, Key: lockKey(elderId, action), ConsistentRead: true }),
      );
      return optStr(out.Item?.approvalId);
    },

    async transition(record, to, fields, guard: TransitionGuard, now) {
      const sets = ["#s = :to", "updatedAt = :updatedAt"];
      const values: Item = { ":to": to, ":updatedAt": fields.updatedAt, ":pending": "pending" };
      for (const key of ["respondedAt", "respondedBy", "respondedByLabel"] as const) {
        const value = fields[key];
        if (value !== undefined) {
          sets.push(`${key} = :${key}`);
          values[`:${key}`] = value;
        }
      }
      let condition = "#s = :pending";
      if (guard === "active") condition += " AND expiresAt > :now";
      if (guard === "expired") condition += " AND expiresAt <= :now";
      if (guard !== "pending") values[":now"] = now;

      // 그 사이 보호자가 해제돼 보호자 항목이 없어졌으면 원본을 다시 읽고 한 번 더 시도한다.
      let current = record;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await doc.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Update: {
                    TableName: table,
                    Key: { PK: approvalPk(current.id), SK: "META" },
                    UpdateExpression: `SET ${sets.join(", ")} REMOVE GSI2PK, GSI2SK`,
                    ConditionExpression: condition,
                    ExpressionAttributeNames: { "#s": "status" },
                    ExpressionAttributeValues: values,
                  },
                },
                ...current.guardianIds.map((gid) => ({
                  Update: {
                    TableName: table,
                    Key: { PK: `GUARDIAN#${gid}`, SK: `APPROVAL#${current.id}` },
                    UpdateExpression: `SET ${sets.join(", ")}`,
                    ConditionExpression: "attribute_exists(PK)",
                    ExpressionAttributeNames: { "#s": "status" },
                    ExpressionAttributeValues: Object.fromEntries(
                      Object.entries(values).filter(([k]) => k !== ":pending" && k !== ":now"),
                    ),
                  },
                })),
              ],
            }),
          );
          break;
        } catch (error) {
          if (!(error instanceof TransactionCanceledException)) throw error;
          const reasons = error.CancellationReasons ?? [];
          if (reasons[0]?.Code === "ConditionalCheckFailed") return false;
          const fresh = attempt === 0 ? await getOriginal(current.id) : undefined;
          if (fresh === undefined) throw error;
          current = fresh;
        }
      }

      // 잠금은 이 승인을 가리킬 때만 푼다 (새 승인이 이미 잡았으면 그대로).
      try {
        await doc.send(
          new DeleteCommand({
            TableName: table,
            Key: lockKey(current.elderId, current.action),
            ConditionExpression: "approvalId = :id",
            ExpressionAttributeValues: { ":id": current.id },
          }),
        );
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
      }
      return true;
    },

    async getForGuardian(guardianId, id) {
      const out = await doc.send(
        new GetCommand({
          TableName: table,
          Key: { PK: `GUARDIAN#${guardianId}`, SK: `APPROVAL#${id}` },
          ConsistentRead: true,
        }),
      );
      return out.Item === undefined ? undefined : toGuardianApproval(out.Item);
    },

    async listForGuardian(guardianId, { pendingOnly, now, cursor, since, limit }) {
      const filters: string[] = [];
      const values: Item = { ":pk": `GUARDIAN#${guardianId}`, ":prefix": "APPROVAL#" };
      if (pendingOnly) {
        filters.push("#s = :pending AND expiresAt > :now");
        values[":pending"] = "pending";
        values[":now"] = now;
      }
      if (since !== undefined) {
        filters.push("updatedAt > :since");
        values[":since"] = since;
      }
      const out = await doc.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ...(filters.length === 0
            ? {}
            : {
                FilterExpression: filters.join(" AND "),
                ExpressionAttributeNames: pendingOnly ? { "#s": "status" } : undefined,
              }),
          ExpressionAttributeValues: values,
          ScanIndexForward: false,
          Limit: limit,
          ...(cursor === undefined
            ? {}
            : { ExclusiveStartKey: { PK: `GUARDIAN#${guardianId}`, SK: decodeCursor(cursor) } }),
        }),
      );
      const items = (out.Items ?? []).map(toGuardianApproval);
      const nextCursor = encodeCursor(out.LastEvaluatedKey);
      return nextCursor === undefined ? { items } : { items, nextCursor };
    },

    async listExpiredPending(now, limit) {
      const out = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: "GSI2",
          KeyConditionExpression: "GSI2PK = :p AND GSI2SK < :now",
          ExpressionAttributeValues: { ":p": "PENDING", ":now": now },
          Limit: limit,
        }),
      );
      return (out.Items ?? [])
        .map((item) => str(item.PK))
        .filter((pk) => pk.startsWith("APPROVAL#"))
        .map((pk) => pk.slice("APPROVAL#".length));
    },

    async listPendingForElder(elderId) {
      const records: ApprovalRecord[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const out = await doc.send(
          new QueryCommand({
            TableName: table,
            IndexName: "GSI1",
            KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :prefix)",
            FilterExpression: "#s = :pending",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":pk": `ELDER#${elderId}`,
              ":prefix": "APPROVAL#",
              ":pending": "pending",
            },
            ExclusiveStartKey: start,
          }),
        );
        records.push(...(out.Items ?? []).map(toApproval));
        start = out.LastEvaluatedKey;
      } while (start !== undefined);
      return records;
    },

    async removeGuardian(record, guardianId) {
      const remaining = record.guardianIds.filter((gid) => gid !== guardianId);
      try {
        await doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: table,
                  Key: { PK: approvalPk(record.id), SK: "META" },
                  UpdateExpression: "SET guardianIds = :ids",
                  ConditionExpression: "#s = :pending AND contains(guardianIds, :gid)",
                  ExpressionAttributeNames: { "#s": "status" },
                  ExpressionAttributeValues: {
                    ":ids": remaining,
                    ":pending": "pending",
                    ":gid": guardianId,
                  },
                },
              },
              {
                Delete: {
                  TableName: table,
                  Key: { PK: `GUARDIAN#${guardianId}`, SK: `APPROVAL#${record.id}` },
                },
              },
            ],
          }),
        );
        return remaining;
      } catch (error) {
        if (error instanceof TransactionCanceledException) return undefined;
        throw error;
      }
    },

    async deleteForGuardianAndElder(guardianId, elderId) {
      const keys = await queryKeys({
        pk: `GUARDIAN#${guardianId}`,
        prefix: "APPROVAL#",
        filter: "elderId = :eid",
        values: { ":eid": elderId },
      });
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
