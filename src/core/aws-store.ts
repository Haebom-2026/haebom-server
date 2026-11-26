/**
 * CoreStore 의 DynamoDB 구현 (haebom-<env>-main, docs/server-plan.md 3.2).
 *
 *   USER#<uid>          / PROFILE             role, name
 *   USER#<uid>          / DEVICE#<deviceId>   fcmToken, platform
 *   DEVICE#<deviceId>   / OWNER               uid  (재설치로 uid 가 바뀌면 이전 uid 의 토큰을 지우기 위함)
 *   ELDER#<eid>         / LINK#<gid>          연결 1쌍 (GSI1: GUARDIAN#<gid> / LINK#<eid>)
 *   ELDER#<eid>         / ACTIVECODE          지금 유효한 연결 코드 번호
 *   CODE#<6자리>        / CODE                elderId, expiresAt, used
 *   CODEFAIL#GUARDIAN#<gid> / <구간>          10분 구간 실패 횟수
 *   CODEFAIL#GLOBAL     / <구간>              1분 구간 전체 실패 횟수
 */
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  GLOBAL_FAILURE_WINDOW_MS,
  GUARDIAN_FAILURE_WINDOW_MS,
  type ConnectCode,
  type DeviceRecord,
  type LinkRecord,
  type Platform,
  type Role,
  type UserProfile,
} from "./model.js";
import type { CodeLookup, CoreStore, RedeemResult } from "./store.js";

type Item = Record<string, unknown>;

const userPk = (uid: string) => `USER#${uid}`;
const elderPk = (eid: string) => `ELDER#${eid}`;
const guardianPk = (gid: string) => `GUARDIAN#${gid}`;
const linkSk = (id: string) => `LINK#${id}`;
const deviceSk = (deviceId: string) => `DEVICE#${deviceId}`;
const codePk = (code: string) => `CODE#${code}`;
const DAY_SECONDS = 24 * 3600;

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const epochSeconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function toUser(item: Item): UserProfile {
  return {
    uid: str(item.uid),
    role: str(item.role) as Role,
    name: str(item.name),
    createdAt: str(item.createdAt),
    updatedAt: str(item.updatedAt),
  };
}

function toDevice(item: Item): DeviceRecord {
  return {
    uid: str(item.uid),
    deviceId: str(item.deviceId),
    fcmToken: str(item.fcmToken),
    platform: str(item.platform) as Platform,
    updatedAt: str(item.updatedAt),
  };
}

export function toLink(item: Item): LinkRecord {
  return {
    elderId: str(item.elderId),
    guardianId: str(item.guardianId),
    elderName: str(item.elderName),
    guardianName: str(item.guardianName),
    elderLabel: str(item.elderLabel),
    guardianLabel: str(item.guardianLabel),
    connectedAt: str(item.connectedAt),
  };
}

function linkItem(link: LinkRecord): Item {
  return {
    PK: elderPk(link.elderId),
    SK: linkSk(link.guardianId),
    GSI1PK: guardianPk(link.guardianId),
    GSI1SK: linkSk(link.elderId),
    type: "link",
    ...link,
  };
}

/** TransactWrite 가 취소됐을 때 각 항목이 조건에서 실패했는지 */
function failedConditions(error: unknown): boolean[] | undefined {
  if (!(error instanceof TransactionCanceledException)) return undefined;
  return (error.CancellationReasons ?? []).map((r) => r.Code === "ConditionalCheckFailed");
}

export function createAwsCoreStore(
  table: string,
  client: DynamoDBClient = new DynamoDBClient({}),
): CoreStore {
  const doc = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });

  async function queryAll(input: Omit<QueryCommandInput, "TableName">): Promise<Item[]> {
    const items: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out = await doc.send(
        new QueryCommand({ TableName: table, ...input, ExclusiveStartKey: start }),
      );
      items.push(...(out.Items ?? []));
      start = out.LastEvaluatedKey;
    } while (start !== undefined);
    return items;
  }

  async function get(PK: string, SK: string): Promise<Item | undefined> {
    const out = await doc.send(
      new GetCommand({ TableName: table, Key: { PK, SK }, ConsistentRead: true }),
    );
    return out.Item;
  }

  const failureKeys = (guardianId: string, now: Date) => ({
    guardian: {
      PK: `CODEFAIL#GUARDIAN#${guardianId}`,
      SK: String(Math.floor(now.getTime() / GUARDIAN_FAILURE_WINDOW_MS)),
    },
    global: {
      PK: "CODEFAIL#GLOBAL",
      SK: String(Math.floor(now.getTime() / GLOBAL_FAILURE_WINDOW_MS)),
    },
  });

  return {
    async getUser(uid) {
      const item = await get(userPk(uid), "PROFILE");
      return item === undefined ? undefined : toUser(item);
    },

    async createUser(user) {
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: { PK: userPk(user.uid), SK: "PROFILE", type: "user", ...user },
            ConditionExpression: "attribute_not_exists(PK)",
          }),
        );
        return true;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return false;
        throw error;
      }
    },

    async updateUserName(uid, name, now) {
      try {
        const out = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { PK: userPk(uid), SK: "PROFILE" },
            UpdateExpression: "SET #n = :name, updatedAt = :now",
            ConditionExpression: "attribute_exists(PK)",
            ExpressionAttributeNames: { "#n": "name" },
            ExpressionAttributeValues: { ":name": name, ":now": now },
            ReturnValues: "ALL_NEW",
          }),
        );
        return out.Attributes === undefined ? undefined : toUser(out.Attributes);
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return undefined;
        throw error;
      }
    },

    async putDevice(device) {
      const owner = await get(`DEVICE#${device.deviceId}`, "OWNER");
      const previousUid = str(owner?.uid);
      await doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: table,
                Item: {
                  PK: userPk(device.uid),
                  SK: deviceSk(device.deviceId),
                  type: "device",
                  ...device,
                },
              },
            },
            {
              Put: {
                TableName: table,
                Item: { PK: `DEVICE#${device.deviceId}`, SK: "OWNER", uid: device.uid },
              },
            },
            ...(previousUid !== "" && previousUid !== device.uid
              ? [
                  {
                    Delete: {
                      TableName: table,
                      Key: { PK: userPk(previousUid), SK: deviceSk(device.deviceId) },
                    },
                  },
                ]
              : []),
          ],
        }),
      );
    },

    async deleteDevice(uid, deviceId) {
      await doc.send(
        new DeleteCommand({ TableName: table, Key: { PK: userPk(uid), SK: deviceSk(deviceId) } }),
      );
      try {
        await doc.send(
          new DeleteCommand({
            TableName: table,
            Key: { PK: `DEVICE#${deviceId}`, SK: "OWNER" },
            ConditionExpression: "uid = :uid",
            ExpressionAttributeValues: { ":uid": uid },
          }),
        );
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
      }
    },

    async listDevices(uid) {
      const items = await queryAll({
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": userPk(uid), ":sk": "DEVICE#" },
      });
      return items.map(toDevice);
    },

    async listLinksByElder(elderId) {
      const items = await queryAll({
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": elderPk(elderId), ":sk": "LINK#" },
      });
      return items.map(toLink);
    },

    async listLinksByGuardian(guardianId) {
      const items = await queryAll({
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :sk)",
        ExpressionAttributeValues: { ":pk": guardianPk(guardianId), ":sk": "LINK#" },
      });
      return items.map(toLink);
    },

    async setLinkNames(links, names) {
      const sets: string[] = [];
      const values: Item = {};
      if (names.elderName !== undefined) {
        sets.push("elderName = :en");
        values[":en"] = names.elderName;
      }
      if (names.guardianName !== undefined) {
        sets.push("guardianName = :gn");
        values[":gn"] = names.guardianName;
      }
      if (names.elderLabel !== undefined) {
        sets.push("elderLabel = :el");
        values[":el"] = names.elderLabel;
      }
      if (names.guardianLabel !== undefined) {
        sets.push("guardianLabel = :gl");
        values[":gl"] = names.guardianLabel;
      }
      if (sets.length === 0) return;
      for (const link of links) {
        try {
          await doc.send(
            new UpdateCommand({
              TableName: table,
              Key: { PK: elderPk(link.elderId), SK: linkSk(link.guardianId) },
              UpdateExpression: `SET ${sets.join(", ")}`,
              ConditionExpression: "attribute_exists(PK)",
              ExpressionAttributeValues: values,
            }),
          );
        } catch (error) {
          // 그 사이 해제된 연결은 건너뛴다.
          if (!(error instanceof ConditionalCheckFailedException)) throw error;
        }
      }
    },

    async deleteLink(elderId, guardianId) {
      try {
        await doc.send(
          new DeleteCommand({
            TableName: table,
            Key: { PK: elderPk(elderId), SK: linkSk(guardianId) },
            ConditionExpression: "attribute_exists(PK)",
          }),
        );
        return true;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return false;
        throw error;
      }
    },

    async issueCode(code: ConnectCode, now) {
      const ttl = epochSeconds(code.expiresAt) + DAY_SECONDS;
      try {
        await doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                // TTL 삭제는 늦을 수 있으므로 "없거나 이미 만료"면 같은 번호를 다시 쓴다.
                Put: {
                  TableName: table,
                  Item: { PK: codePk(code.code), SK: "CODE", type: "code", ...code, ttl },
                  ConditionExpression: "attribute_not_exists(PK) OR expiresAt < :now",
                  ExpressionAttributeValues: { ":now": now },
                },
              },
              {
                // 이 어르신의 유효 코드는 항상 하나: 이전 코드는 연결할 때 이 값과 달라 거부된다.
                Put: {
                  TableName: table,
                  Item: { PK: elderPk(code.elderId), SK: "ACTIVECODE", code: code.code, ttl },
                },
              },
            ],
          }),
        );
        return true;
      } catch (error) {
        if (failedConditions(error)?.[0] === true) return false;
        throw error;
      }
    },

    async getCode(code): Promise<CodeLookup | undefined> {
      const item = await get(codePk(code), "CODE");
      if (item === undefined) return undefined;
      const elderId = str(item.elderId);
      const active = await get(elderPk(elderId), "ACTIVECODE");
      return {
        code,
        elderId,
        createdAt: str(item.createdAt),
        expiresAt: str(item.expiresAt),
        used: item.used === true,
        active: str(active?.code) === code,
      };
    },

    async redeemCode(code, link, now): Promise<RedeemResult> {
      try {
        await doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: table,
                  Key: { PK: codePk(code), SK: "CODE" },
                  UpdateExpression: "SET used = :true, usedBy = :gid, usedAt = :now",
                  ConditionExpression: "used = :false AND expiresAt > :now AND elderId = :eid",
                  ExpressionAttributeValues: {
                    ":true": true,
                    ":false": false,
                    ":gid": link.guardianId,
                    ":now": now,
                    ":eid": link.elderId,
                  },
                },
              },
              {
                ConditionCheck: {
                  TableName: table,
                  Key: { PK: elderPk(link.elderId), SK: "ACTIVECODE" },
                  ConditionExpression: "code = :code",
                  ExpressionAttributeValues: { ":code": code },
                },
              },
              {
                Put: {
                  TableName: table,
                  Item: linkItem(link),
                  ConditionExpression: "attribute_not_exists(PK)",
                },
              },
            ],
          }),
        );
        return "ok";
      } catch (error) {
        const failed = failedConditions(error);
        if (failed === undefined) throw error;
        if (failed[0] !== true && failed[1] !== true && failed[2] === true) return "already-linked";
        return "code-unavailable";
      }
    },

    async codeFailures(guardianId, now) {
      const keys = failureKeys(guardianId, now);
      const out = await doc.send(
        new BatchGetCommand({
          RequestItems: { [table]: { Keys: [keys.guardian, keys.global], ConsistentRead: true } },
        }),
      );
      const items: Item[] = out.Responses?.[table] ?? [];
      const count = (pk: string) => {
        const value: unknown = items.find((item) => item.PK === pk)?.count;
        return typeof value === "number" ? value : 0;
      };
      return { guardian: count(keys.guardian.PK), global: count(keys.global.PK) };
    },

    async recordCodeFailure(guardianId, now) {
      const keys = failureKeys(guardianId, now);
      const ttl = Math.floor(now.getTime() / 1000) + DAY_SECONDS;
      await Promise.all(
        [keys.guardian, keys.global].map((Key) =>
          doc.send(
            new UpdateCommand({
              TableName: table,
              Key,
              UpdateExpression: "ADD #c :one SET #t = :ttl",
              ExpressionAttributeNames: { "#c": "count", "#t": "ttl" },
              ExpressionAttributeValues: { ":one": 1, ":ttl": ttl },
            }),
          ),
        ),
      );
    },
  };
}
