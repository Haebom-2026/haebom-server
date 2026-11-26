/**
 * 지도 저장소 (docs/jev-routing-plan.md 3.3·3.5, R4, dev).
 *
 * main 테이블 PK = "MAP" 한 파티션:
 *   연결선 : SK EDGE#<edgeId>   — 화면(지도 지문) A 에서 누르면 화면 B 로 가는 이동. 모든 목표가 같이 씀
 *   목표   : SK GOAL#<goalId>   — 도착 화면 지문들 + 도착한 뒤의 끝 단계
 *   차단   : SK BLOCK            — 바로 막을 연결선·목표 (긴급 차단)
 *
 * ai-fn 은 파티션 전체를 읽어 1분 동안 메모리에 둔다 (dev 규모). 기획서의 S3 스냅샷 게시는
 * 지도가 커지면 옮긴다. 쓰기는 사람 승인 스크립트(scripts/map-seed.ts)만 한다 (R5 자동 반영 전).
 */
import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

export const MAP_PK = "MAP";
export const MAP_CACHE_MS = 60_000;

export type MapStatus = "candidate" | "verified" | "retired";

export interface MapEdge {
  edgeId: string;
  pkg: string;
  /** 출발·도착 화면의 지도 지문 (mfp@v1) */
  fromFp: string;
  toFp: string;
  action: "tap" | "swipe_up" | "swipe_down" | "swipe_left" | "swipe_right";
  targetText: string;
  /** 누를 노드의 클래스 (마지막 . 뒤). 같은 글자의 다른 노드와 구분 */
  targetClass: string;
  status: MapStatus;
  origin: "seed" | "learned";
  /** 증거: 어느 명령(uid#commandId#gen)에서 나왔나 */
  evidence: string[];
  createdAt: string;
}

export interface MapFinishStep {
  action: MapEdge["action"];
  targetText: string;
  targetClass: string;
  verify: "page" | "node_state" | "none";
  sensitive: boolean;
  /** 이 단계를 한 뒤의 화면 지문 (seed 때 본 것). 다음 끝 단계는 이 화면일 때만 */
  afterFp?: string;
}

export interface MapGoal {
  goalId: string;
  pkg: string;
  /** 도착 화면 지문들 */
  arriveFps: string[];
  finish: MapFinishStep[];
  status: MapStatus;
  origin: "seed" | "learned";
  evidence: string[];
  updatedAt: string;
}

export interface MapBlock {
  edgeIds: string[];
  goalIds: string[];
}

export interface MapSnapshot {
  edges: MapEdge[];
  goals: Map<string, MapGoal>;
  block: MapBlock;
}

export interface MapStore {
  /** 캐시된 지도 (1분) */
  snapshot(): Promise<MapSnapshot>;
  putEdge(edge: MapEdge): Promise<void>;
  putGoal(goal: MapGoal): Promise<void>;
}

/** 같은 이동은 같은 id: 출발·도착 지문 + 행동 + 글자 + 클래스 */
export function edgeIdOf(
  e: Pick<MapEdge, "fromFp" | "toFp" | "action" | "targetText" | "targetClass">,
): string {
  return createHash("sha256")
    .update([e.fromFp, e.toFp, e.action, e.targetText, e.targetClass].join("\n"))
    .digest("hex")
    .slice(0, 16);
}

export function createAwsMapStore(
  table: string,
  client: DynamoDBClient = new DynamoDBClient({}),
  now: () => number = Date.now,
): MapStore {
  const doc = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
  let cached: { at: number; value: Promise<MapSnapshot> } | undefined;

  const load = async (): Promise<MapSnapshot> => {
    const edges: MapEdge[] = [];
    const goals = new Map<string, MapGoal>();
    let block: MapBlock = { edgeIds: [], goalIds: [] };
    let start: Record<string, unknown> | undefined;
    do {
      const out = await doc.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": MAP_PK },
          ExclusiveStartKey: start,
        }),
      );
      for (const item of out.Items ?? []) {
        const sk = String(item.SK);
        if (sk.startsWith("EDGE#")) edges.push(item as unknown as MapEdge);
        else if (sk.startsWith("GOAL#")) {
          const goal = item as unknown as MapGoal;
          goals.set(goal.goalId, goal);
        } else if (sk === "BLOCK") block = item as unknown as MapBlock;
      }
      start = out.LastEvaluatedKey;
    } while (start !== undefined);
    return { edges, goals, block: { edgeIds: block.edgeIds, goalIds: block.goalIds } };
  };

  return {
    snapshot() {
      if (!cached || now() - cached.at > MAP_CACHE_MS) {
        const value = load().catch((error: unknown) => {
          cached = undefined;
          throw error;
        });
        cached = { at: now(), value };
      }
      return cached.value;
    },
    async putEdge(edge) {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: { PK: MAP_PK, SK: `EDGE#${edge.edgeId}`, type: "map-edge", ...edge },
        }),
      );
      cached = undefined;
    },
    async putGoal(goal) {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: { PK: MAP_PK, SK: `GOAL#${goal.goalId}`, type: "map-goal", ...goal },
        }),
      );
      cached = undefined;
    },
  };
}
