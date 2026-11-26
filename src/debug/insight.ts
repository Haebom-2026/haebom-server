/**
 * 디버그 뷰어가 보는 R3~R5 기록 (docs/jev-routing-plan.md 7·8장, dev 전용, 읽기만).
 *   - 배운 지도: main 테이블 PK=MAP (연결선·목표·도착 화면·차단·사람 확인 대기·반영 기록)
 *   - 명령 하나: ELDER#uid 의 CMD#id (명령 기록·단계·Opus 검토) + 그 명령의 반영·대기 기록
 * 쓰기는 하지 않는다 (승인·버리기·차단은 scripts/map-*.ts).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { devicesOf, isStale } from "../map/learn.js";
import { MAP_PK, toIdList } from "../map/store.js";

export type Item = Record<string, unknown>;

export interface LearnedMap {
  /** 연결선. devices = 증거의 서로 다른 기기, stale = 90일 안 쓰여 안내에 안 씀 */
  edges: Item[];
  goals: Item[];
  /** 도착 화면 후보 (ARRIVE#goal#fp) */
  arrives: Item[];
  pending: Item[];
  applied: Item[];
  block: { edgeIds: string[]; goalIds: string[] };
}

export interface CommandInsight {
  uid: string;
  commandId: number;
  /** 명령 기록 (24시간 TTL 이라 없을 수 있음) */
  command?: Item;
  /** 단계 기록 (3일) */
  steps: Item[];
  /** Opus 검토 (gen 마다 하나, 30일) */
  reviews: Item[];
  applied: Item[];
  pending: Item[];
}

export interface InsightStore {
  learnedMap(now: Date): Promise<LearnedMap>;
  command(uid: string, commandId: number): Promise<CommandInsight>;
}

/** DynamoDB 값 → JSON 으로 보낼 수 있는 값 (String Set → 배열) */
export function plain(value: unknown): unknown {
  if (value instanceof Set) return [...(value as Set<unknown>)].map(plain).sort();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Item).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

const strings = (value: unknown): string[] => toIdList(plain(value));

/** 키·TTL 을 빼고 증거 기기를 붙인다 */
function view(item: Item): Item {
  const rest = Object.fromEntries(Object.entries(item).filter(([k]) => k !== "PK" && k !== "ttl"));
  const out = plain(rest) as Item;
  if ("evidence" in item) out.devices = [...devicesOf(strings(item.evidence))].sort();
  return out;
}

/** MAP 파티션 항목들을 종류별로 나눈다 (메모리 저장소·테스트도 같은 규칙) */
export function splitMap(items: readonly Item[], now: Date): LearnedMap {
  const out: LearnedMap = {
    edges: [],
    goals: [],
    arrives: [],
    pending: [],
    applied: [],
    block: { edgeIds: [], goalIds: [] },
  };
  for (const item of items) {
    const sk = typeof item.SK === "string" ? item.SK : "";
    const kind = sk.split("#")[0];
    if (kind === "BLOCK") {
      out.block = { edgeIds: strings(item.edgeIds), goalIds: strings(item.goalIds) };
      continue;
    }
    const v = view(item);
    if (kind === "EDGE") {
      const createdAt = typeof item.createdAt === "string" ? item.createdAt : "";
      const lastUsedAt = typeof item.lastUsedAt === "string" ? item.lastUsedAt : undefined;
      v.stale = isStale({ createdAt, ...(lastUsedAt ? { lastUsedAt } : {}) }, now);
      out.edges.push(v);
    } else if (kind === "GOAL") out.goals.push(v);
    else if (kind === "ARRIVE") out.arrives.push(v);
    else if (kind === "PENDING") out.pending.push(v);
    else if (kind === "APPLIED") out.applied.push(v);
  }
  return out;
}

export function createAwsInsightStore(
  table: string,
  client: DynamoDBClient = new DynamoDBClient({}),
): InsightStore {
  const doc = DynamoDBDocumentClient.from(client);

  const queryAll = async (input: Omit<QueryCommandInput, "TableName">): Promise<Item[]> => {
    const items: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out = await doc.send(
        new QueryCommand({
          TableName: table,
          ...input,
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      items.push(...((out.Items ?? []) as Item[]));
      start = out.LastEvaluatedKey;
    } while (start);
    return items;
  };

  const mapPrefix = (prefix: string) =>
    queryAll({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :p)",
      ExpressionAttributeValues: { ":pk": MAP_PK, ":p": prefix },
    });

  return {
    async learnedMap(now) {
      const items = await queryAll({
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": MAP_PK },
      });
      return splitMap(items, now);
    },

    async command(uid, commandId) {
      const pk = `ELDER#${uid}`;
      const [record, children, applied, pending] = await Promise.all([
        doc.send(new GetCommand({ TableName: table, Key: { PK: pk, SK: `CMD#${commandId}` } })),
        // CMD#12# 로 끝을 막아 CMD#123 이 섞이지 않게
        queryAll({
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :p)",
          ExpressionAttributeValues: { ":pk": pk, ":p": `CMD#${commandId}#` },
        }),
        mapPrefix(`APPLIED#${uid}#${commandId}#`),
        mapPrefix(`PENDING#${uid}#${commandId}#`),
      ]);
      const of = (part: string) =>
        children.filter((i) => typeof i.SK === "string" && i.SK.includes(`#${part}#`)).map(view);
      return {
        uid,
        commandId,
        ...(record.Item ? { command: view(record.Item as Item) } : {}),
        steps: of("STEP"),
        reviews: of("REVIEW"),
        applied: applied.map(view),
        pending: pending.map(view),
      };
    },
  };
}
