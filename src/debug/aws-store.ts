/**
 * DebugStore 의 DynamoDB + S3 구현 (docs/server-plan.md 12.5).
 *
 * 테이블 haebom-dev-debug (PK, SK, ttl)
 *   DEV#<deviceId> / META                 기기 정보, 마지막 신호, 중복 판단용 lastKey
 *   DEV#<deviceId> / SCREEN#<screenId>    화면 요약 + s3Key
 *   PIN#<pinId>    / META                 보관 세션
 * 버킷
 *   screens/<deviceId>/<screenId>.json    3일 수명 주기
 *   pinned/<deviceId>/<screenId>.json     30일 수명 주기 (보관 시 복사)
 */
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  CopyObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { ApiError } from "../shared/errors.js";
import {
  DEVICE_TTL_SECONDS,
  MAX_PIN_SCREENS,
  PINNED_TTL_SECONDS,
  SCREEN_TTL_SECONDS,
  epochSeconds,
  summaryOf,
  type DebugStore,
  type DeviceRecord,
  type PinRecord,
  type ScreenDocument,
  type ScreenSummary,
} from "./store.js";

export interface AwsDebugStoreOptions {
  table: string;
  bucket: string;
  dynamo?: DynamoDBClient;
  s3?: S3Client;
}

type Item = Record<string, unknown>;

const devicePk = (deviceId: string) => `DEV#${deviceId}`;
const screenSk = (screenId: string) => `SCREEN#${screenId}`;
const screenKey = (deviceId: string, screenId: string) => `screens/${deviceId}/${screenId}.json`;
const pinnedKey = (deviceId: string, screenId: string) => `pinned/${deviceId}/${screenId}.json`;

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number => (typeof value === "number" ? value : 0);
const optStr = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

function toDevice(item: Item): DeviceRecord {
  const label = optStr(item.label);
  const lastScreenAt = optStr(item.lastScreenAt);
  return {
    deviceId: str(item.deviceId),
    uid: str(item.uid),
    model: str(item.model),
    os: str(item.os),
    appVersion: str(item.appVersion),
    lastSeenAt: str(item.lastSeenAt),
    screenCount: num(item.screenCount),
    ...(label === undefined ? {} : { label }),
    ...(lastScreenAt === undefined ? {} : { lastScreenAt }),
  };
}

function toSummary(item: Item): ScreenSummary {
  const appHash = optStr(item.appHash);
  return {
    screenId: str(item.screenId),
    deviceId: str(item.deviceId),
    receivedAt: str(item.receivedAt),
    capturedAt: str(item.capturedAt),
    pkg: str(item.pkg),
    fingerprint: str(item.fingerprint),
    fpVersion: str(item.fpVersion),
    nodeCount: num(item.nodeCount),
    maskedCount: num(item.maskedCount),
    pinned: item.pinned === true,
    ...(appHash === undefined ? {} : { appHash }),
  };
}

function toPin(item: Item): PinRecord {
  return {
    pinId: str(item.pinId),
    deviceId: str(item.deviceId),
    from: str(item.from),
    to: str(item.to),
    name: str(item.name),
    createdBy: str(item.createdBy),
    createdAt: str(item.createdAt),
    screenCount: num(item.screenCount),
  };
}

function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  return key ? Buffer.from(JSON.stringify(key)).toString("base64url") : undefined;
}

function decodeCursor(cursor: string, pk: string): Record<string, unknown> {
  try {
    const key = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (key !== null && typeof key === "object" && (key as Item).PK === pk) {
      return key as Record<string, unknown>;
    }
  } catch {
    // 아래에서 오류
  }
  throw new ApiError("invalid-argument", "invalid cursor");
}

async function scanAll(
  doc: DynamoDBDocumentClient,
  input: ConstructorParameters<typeof ScanCommand>[0],
): Promise<Item[]> {
  const items: Item[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(new ScanCommand({ ...input, ExclusiveStartKey: startKey }));
    items.push(...((page.Items ?? []) as Item[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

export function createAwsDebugStore(options: AwsDebugStoreOptions): DebugStore {
  const doc = DynamoDBDocumentClient.from(options.dynamo ?? new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const s3 = options.s3 ?? new S3Client({});
  const { table: TableName, bucket: Bucket } = options;

  return {
    async heartbeat({ deviceId, uid, model, os, appVersion, now }) {
      await doc.send(
        new UpdateCommand({
          TableName,
          Key: { PK: devicePk(deviceId), SK: "META" },
          UpdateExpression:
            "SET deviceId = :d, uid = :u, model = :m, os = :o, appVersion = :v, lastSeenAt = :now, #ttl = :ttl, screenCount = if_not_exists(screenCount, :zero)",
          ExpressionAttributeNames: { "#ttl": "ttl" },
          ExpressionAttributeValues: {
            ":d": deviceId,
            ":u": uid,
            ":m": model,
            ":o": os,
            ":v": appVersion,
            ":now": now.toISOString(),
            ":ttl": epochSeconds(now) + DEVICE_TTL_SECONDS,
            ":zero": 0,
          },
        }),
      );
    },

    async saveScreen({ uid, dedupeKey, ...document }) {
      const now = new Date(document.receivedAt);
      // 1) 직전 화면과 같으면 여기서 멈춘다 (조건부 갱신 = 동시 요청에도 한 번만 저장)
      try {
        await doc.send(
          new UpdateCommand({
            TableName,
            Key: { PK: devicePk(document.deviceId), SK: "META" },
            UpdateExpression:
              "SET deviceId = :d, uid = :u, lastKey = :k, lastScreenAt = :now, lastSeenAt = :now, #ttl = :ttl ADD screenCount :one",
            ConditionExpression: "attribute_not_exists(lastKey) OR lastKey <> :k",
            ExpressionAttributeNames: { "#ttl": "ttl" },
            ExpressionAttributeValues: {
              ":d": document.deviceId,
              ":u": uid,
              ":k": dedupeKey,
              ":now": document.receivedAt,
              ":ttl": epochSeconds(now) + DEVICE_TTL_SECONDS,
              ":one": 1,
            },
          }),
        );
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return false;
        throw error;
      }

      // 2) 원본 → S3, 3) 요약 → 테이블
      const s3Key = screenKey(document.deviceId, document.screenId);
      await s3.send(
        new PutObjectCommand({
          Bucket,
          Key: s3Key,
          Body: JSON.stringify(document),
          ContentType: "application/json",
        }),
      );
      await doc.send(
        new PutCommand({
          TableName,
          Item: {
            PK: devicePk(document.deviceId),
            SK: screenSk(document.screenId),
            ...summaryOf(document),
            s3Key,
            ttl: epochSeconds(now) + SCREEN_TTL_SECONDS,
          },
        }),
      );
      return true;
    },

    async listDevices() {
      const items = await scanAll(doc, {
        TableName,
        FilterExpression: "SK = :meta AND begins_with(PK, :dev)",
        ExpressionAttributeValues: { ":meta": "META", ":dev": "DEV#" },
      });
      return items.map(toDevice);
    },

    async setLabel(deviceId, label) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName,
            Key: { PK: devicePk(deviceId), SK: "META" },
            UpdateExpression: "SET label = :l",
            ConditionExpression: "attribute_exists(PK)",
            ExpressionAttributeValues: { ":l": label },
          }),
        );
        return true;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return false;
        throw error;
      }
    },

    async listScreens(deviceId, { since, from, to, cursor, limit }) {
      const pk = devicePk(deviceId);
      let input: QueryCommandInput;
      if (since !== undefined) {
        // 실시간 폴링: since 이후 새 화면만, 오래된 것부터.
        // META 는 "SCREEN#" 보다 앞에 정렬되므로 SK > 조건만으로 화면만 나온다
        input = {
          TableName,
          KeyConditionExpression: "PK = :pk AND SK > :since",
          ExpressionAttributeValues: { ":pk": pk, ":since": screenSk(since) },
          ScanIndexForward: true,
          Limit: limit,
        };
      } else if (from !== undefined && to !== undefined) {
        // 보관 세션 구간
        input = {
          TableName,
          KeyConditionExpression: "PK = :pk AND SK BETWEEN :from AND :to",
          ExpressionAttributeValues: { ":pk": pk, ":from": screenSk(from), ":to": screenSk(to) },
          ScanIndexForward: true,
          Limit: limit,
        };
      } else {
        // 최신순 페이지
        input = {
          TableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": pk, ":prefix": "SCREEN#" },
          ScanIndexForward: false,
          Limit: limit,
          ...(cursor === undefined ? {} : { ExclusiveStartKey: decodeCursor(cursor, pk) }),
        };
      }
      const page = await doc.send(new QueryCommand(input));
      const nextCursor = encodeCursor(page.LastEvaluatedKey);
      return {
        items: ((page.Items ?? []) as Item[]).map(toSummary),
        ...(nextCursor ? { nextCursor } : {}),
      };
    },

    async getScreen(deviceId, screenId) {
      const found = await doc.send(
        new GetCommand({ TableName, Key: { PK: devicePk(deviceId), SK: screenSk(screenId) } }),
      );
      const item = found.Item as Item | undefined;
      if (!item) return undefined;
      const object = await s3.send(new GetObjectCommand({ Bucket, Key: str(item.s3Key) }));
      const body = await object.Body?.transformToString("utf8");
      if (body === undefined) return undefined;
      // 원본에는 저장 시점의 pinned 가 들어 있으므로 요약 값으로 덮는다
      return { ...(JSON.parse(body) as ScreenDocument), ...toSummary(item) };
    },

    async createPin({ pinId, deviceId, from, to, name, createdBy, createdAt }) {
      const pk = devicePk(deviceId);
      const page = await doc.send(
        new QueryCommand({
          TableName,
          KeyConditionExpression: "PK = :pk AND SK BETWEEN :from AND :to",
          ExpressionAttributeValues: { ":pk": pk, ":from": screenSk(from), ":to": screenSk(to) },
          Limit: MAX_PIN_SCREENS + 1,
        }),
      );
      const items = (page.Items ?? []) as Item[];
      if (items.length > MAX_PIN_SCREENS) {
        throw new ApiError(
          "invalid-argument",
          `pin range has more than ${MAX_PIN_SCREENS} screens`,
        );
      }

      const ttl = epochSeconds(new Date(createdAt)) + PINNED_TTL_SECONDS;
      for (const item of items) {
        const screenId = str(item.screenId);
        const target = pinnedKey(deviceId, screenId);
        if (item.pinned !== true) {
          await s3.send(
            new CopyObjectCommand({
              Bucket,
              Key: target,
              CopySource: `${Bucket}/${str(item.s3Key)}`,
            }),
          );
        }
        await doc.send(
          new UpdateCommand({
            TableName,
            Key: { PK: pk, SK: screenSk(screenId) },
            UpdateExpression: "SET pinned = :t, s3Key = :k, #ttl = :ttl",
            ExpressionAttributeNames: { "#ttl": "ttl" },
            ExpressionAttributeValues: { ":t": true, ":k": target, ":ttl": ttl },
          }),
        );
      }

      const pin: PinRecord = {
        pinId,
        deviceId,
        from,
        to,
        name,
        createdBy,
        createdAt,
        screenCount: items.length,
      };
      await doc.send(
        new PutCommand({ TableName, Item: { PK: `PIN#${pinId}`, SK: "META", ...pin, ttl } }),
      );
      return pin;
    },

    async listPins() {
      const items = await scanAll(doc, {
        TableName,
        FilterExpression: "SK = :meta AND begins_with(PK, :pin)",
        ExpressionAttributeValues: { ":meta": "META", ":pin": "PIN#" },
      });
      return items.map(toPin).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  };
}
