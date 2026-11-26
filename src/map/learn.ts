/**
 * 지도 자동 반영 (docs/jev-routing-plan.md 8장, R5, dev).
 *
 * 검토가 accept 인 명령의 이동·도착 화면을 **후보(candidate)** 로 넣고, 서로 다른 기기
 * REQUIRED_DEVICES 대에서 성공하면 verified 로 올린다. 실패가 쌓이면 내린다.
 *
 * main 테이블 PK = "MAP" (store.ts 와 같은 파티션):
 *   EDGE#<edgeId>            연결선. evidence(SS: "uid#commandId#gen@기기"), oldEvidence(SS, 내려간 뒤 옛 증거),
 *                            recent(L: 최근 결과 1/0), rev(N), lastUsedAt, demotedAt
 *   GOAL#<goalId>            목표. finish(처음 정한 끝 단계, 바꾸지 않음), arriveFps(SS, verified 도착 화면만)
 *   ARRIVE#<goalId>#<fp>     도착 화면 후보. evidence·oldEvidence·status (기기 2대면 GOAL.arriveFps 에 더함)
 *   APPLIED#<uid>#<cmd>#<gen> 이 명령이 어디에 증거를 넣었나 (나중에 무효가 되면 거둬들임)
 *   PENDING#<uid>#<cmd>#<gen> 사람 확인 대기 (새 목표·민감·끝 단계 충돌·human 판정)
 *
 * 같은 명령을 두 번 세지 않게 증거 추가는 모두 조건부(NOT contains)다 (Stream 재전달·재시도).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { MAP_PK, toIdList, type MapEdge, type MapFinishStep } from "./store.js";

/** dev 기준 (8.1): 서로 다른 기기 2대, 날짜 조건 없음. prod 는 어르신 2명·2일 */
export const REQUIRED_DEVICES = 2;
/** 8.3: 최근 20번 중 실패가 30% 넘으면 내림 */
export const RESULT_WINDOW = 20;
export const DEMOTE_FAIL_RATIO = 0.3;
/** 8.3: 90일 안 쓰인 연결선은 쓰지 않음 */
export const STALE_DAYS = 90;
const SEED_DEVICE = "seed";

export const evidenceEntry = (uid: string, commandId: number, gen: string, device: string) =>
  `${uid}#${commandId}#${gen}@${device}`;

/** 증거에서 서로 다른 기기 (사람 seed 는 기기로 세지 않음) */
export function devicesOf(entries: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    const at = e.lastIndexOf("@");
    const device = at >= 0 ? e.slice(at + 1) : "";
    if (device !== "" && device !== SEED_DEVICE) out.add(device);
  }
  return out;
}

/** 결과 하나를 더한 최근 결과 (최대 RESULT_WINDOW 개) */
export const nextWindow = (recent: readonly number[], ok: boolean): number[] =>
  [...recent, ok ? 1 : 0].slice(-RESULT_WINDOW);

export function shouldDemote(recent: readonly number[]): boolean {
  if (recent.length === 0) return false;
  const fails = recent.filter((r) => r === 0).length;
  return fails / recent.length > DEMOTE_FAIL_RATIO;
}

/** 90일 안 쓰인 연결선 (마지막 사용, 없으면 만든 때 기준) */
export function isStale(edge: Pick<MapEdge, "createdAt"> & { lastUsedAt?: string }, now: Date) {
  const at = Date.parse(edge.lastUsedAt ?? edge.createdAt);
  return Number.isFinite(at) && now.getTime() - at > STALE_DAYS * 24 * 3600 * 1000;
}

export type EdgeBase = Pick<
  MapEdge,
  "edgeId" | "pkg" | "fromFp" | "toFp" | "action" | "targetText" | "targetClass"
>;

export interface AppliedRecord {
  uid: string;
  commandId: number;
  gen: string;
  entry: string;
  edgeIds: string[];
  goalId: string;
  arriveFp: string;
}

export type PendingReason =
  "human_review" | "new_goal" | "sensitive_goal" | "sensitive_finish" | "finish_conflict";

export interface PendingRecord {
  uid: string;
  commandId: number;
  gen: string;
  reasons: string[];
  goalId?: string;
  proposal?: { name: string; desc: string; slots: string[] };
  createdAt: string;
}

export type EvidenceResult = "added" | "duplicate" | "promoted";
export type ResultTarget = { kind: "edge"; id: string } | { kind: "goal"; id: string };

export interface MapLearnStore {
  /** 목표가 없으면 후보로 만든다. 있는데 끝 단계가 다르면 conflict (도착 화면과 끝 단계는 짝) */
  ensureGoal(
    goal: { goalId: string; pkg: string; finish: MapFinishStep[] },
    now: Date,
  ): Promise<"ok" | "conflict">;
  addEdgeEvidence(edge: EdgeBase, entry: string, now: Date): Promise<EvidenceResult>;
  addArriveEvidence(goalId: string, fp: string, entry: string, now: Date): Promise<EvidenceResult>;
  /** 사람 seed 도착 화면 (바로 verified, 무효·기기 수로 내리지 않음) */
  putSeedArrive(goalId: string, fp: string, entry: string, now: Date): Promise<void>;
  /** 지도 안내 결과 하나 (8.3). 실패가 쌓이면 candidate 로 내림 */
  recordResult(
    target: ResultTarget,
    ok: boolean,
    now: Date,
  ): Promise<"recorded" | "demoted" | "missing">;
  putApplied(record: AppliedRecord): Promise<void>;
  getApplied(uid: string, commandId: number, gen: string): Promise<AppliedRecord | undefined>;
  /** 무효가 된 명령의 증거를 거둬들임 (기기가 모자라면 내림) */
  retract(record: AppliedRecord, now: Date): Promise<void>;
  putPending(record: PendingRecord): Promise<void>;
  listPending(): Promise<PendingRecord[]>;
  deletePending(uid: string, commandId: number, gen: string): Promise<void>;
}

/**
 * 식에 쓰는 속성 이름 (DynamoDB 예약어가 섞여 있어서 모두 #이름 으로 바꿔 보낸다: finish 등).
 * 값 자리(:x)와 이미 바꾼 이름(#x)은 건드리지 않는다
 */
const EXPRESSION_ATTRS = [
  "PK",
  "finish",
  "pkg",
  "goalId",
  "origin",
  "updatedAt",
  "lastUsedAt",
  "promotedAt",
  "demotedAt",
  "evidence",
  "oldEvidence",
  "arriveFps",
  "recent",
  "rev",
  "createdAt",
  "fp",
] as const;

function aliased(input: UpdateCommandInput): UpdateCommandInput {
  const names: Record<string, string> = { ...(input.ExpressionAttributeNames ?? {}) };
  const rewrite = (expr: string | undefined) =>
    expr?.replace(new RegExp(`(?<![#:\\w])(${EXPRESSION_ATTRS.join("|")})(?!\\w)`, "g"), (word) => {
      names[`#a_${word}`] = word;
      return `#a_${word}`;
    });
  const update = rewrite(input.UpdateExpression);
  const condition = rewrite(input.ConditionExpression);
  return {
    ...input,
    ...(update === undefined ? {} : { UpdateExpression: update }),
    ...(condition === undefined ? {} : { ConditionExpression: condition }),
    ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
  };
}

const upd = (input: UpdateCommandInput) => new UpdateCommand(aliased(input));

/** 항목의 최근 결과 창 */
const recentOf = (item: Record<string, unknown>): number[] =>
  Array.isArray(item.recent) ? item.recent.filter((r): r is number => typeof r === "number") : [];

/** 트랜잭션 취소가 조건 실패 때문만인가 (충돌·처리량 초과 등은 아님 → 다시 시도해야 함) */
function isOnlyConditionCancel(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return false;
  const reasons =
    (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
  const codes = reasons.map((r) => r.Code ?? "None");
  return (
    codes.includes("ConditionalCheckFailed") &&
    codes.every((c) => c === "None" || c === "ConditionalCheckFailed")
  );
}

const isConditionFailed = (error: unknown) =>
  error instanceof Error && error.name === "ConditionalCheckFailedException";

export function createAwsMapLearnStore(
  table: string,
  client: DynamoDBClient = new DynamoDBClient({}),
): MapLearnStore {
  const doc = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const key = (sk: string) => ({ PK: MAP_PK, SK: sk });
  const cmdKey = (uid: string, commandId: number, gen: string) => `${uid}#${commandId}#${gen}`;

  /**
   * 예전(R4 seed)처럼 List 로 저장된 칸을 String Set 으로 바꾼다. 읽은 값 그대로일 때만 (그 사이
   * 바뀌었으면 덮어쓰지 않음). 바꿀 것이 있었으면 true
   */
  const migrateToSets = async (sk: string, fields: readonly string[]): Promise<boolean> => {
    const out = await doc.send(
      new GetCommand({ TableName: table, Key: key(sk), ConsistentRead: true }),
    );
    const item = out.Item ?? {};
    const sets: string[] = [];
    const removes: string[] = [];
    const conditions: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    fields.forEach((field, n) => {
      const old: unknown = item[field];
      if (!Array.isArray(old)) return;
      names[`#m${n}`] = field;
      conditions.push(`#m${n} = :old${n}`);
      values[`:old${n}`] = old;
      const ids = toIdList(old);
      if (ids.length === 0) removes.push(`#m${n}`);
      else {
        sets.push(`#m${n} = :new${n}`);
        values[`:new${n}`] = new Set(ids);
      }
    });
    if (conditions.length === 0) return false;
    await doc.send(
      upd({
        TableName: table,
        Key: key(sk),
        UpdateExpression: [
          sets.length > 0 ? `SET ${sets.join(", ")}` : "",
          removes.length > 0 ? `REMOVE ${removes.join(", ")}` : "",
        ]
          .filter((x) => x !== "")
          .join(" "),
        ConditionExpression: conditions.join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
    return true;
  };

  const EVIDENCE_FIELDS = ["evidence", "oldEvidence"] as const;
  const hasLists = (item: Record<string, unknown>) =>
    Array.isArray(item.evidence) || Array.isArray(item.oldEvidence);

  /** Set 연산이 List 칸 때문에 실패하면(ValidationException) 바꾼 뒤 한 번 더 */
  const withSets = async <T>(sk: string, fields: readonly string[], run: () => Promise<T>) => {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof Error && error.name === "ValidationException")) throw error;
      if (!(await migrateToSets(sk, fields))) throw error;
      return run();
    }
  };

  /** 도착 화면이 verified 면 목표의 arriveFps 에 있게 (반복해도 같음: 앞에서 목표 쓰기가 실패했어도 고쳐짐) */
  const syncArrival = async (goalId: string, fp: string, now: Date) => {
    const out = await doc.send(
      new GetCommand({
        TableName: table,
        Key: key(`ARRIVE#${goalId}#${fp}`),
        ConsistentRead: true,
      }),
    );
    if (out.Item?.status !== "verified") return;
    const goalSk = `GOAL#${goalId}`;
    const goalNow = await doc.send(
      new GetCommand({ TableName: table, Key: key(goalSk), ConsistentRead: true }),
    );
    if (goalNow.Item?.cleanupArrivals !== undefined) {
      // 내리던 목표의 정리가 덜 끝났다 → 마저 하고 이번에는 넣지 않음
      await finishGoalCleanup(goalId, now);
      return;
    }
    // 목표의 List 칸은 트랜잭션 전에 Set 으로 (트랜잭션 안에서는 바꿔 다시 시도하기 어려움)
    await migrateToSets(goalSk, ["arriveFps", "evidence"]);
    try {
      // 도착 화면이 **지금도** verified 일 때만 목표에 넣는다 (한 트랜잭션): 그 사이 목표 실패로
      // 도착 화면이 내려갔으면 넣지 않아, 내린 것을 새 증거 없이 되살리지 않는다
      await doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: table,
                Key: key(`ARRIVE#${goalId}#${fp}`),
                ConditionExpression: "#status = :verified",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":verified": "verified" },
              },
            },
            {
              Update: {
                TableName: table,
                Key: key(goalSk),
                UpdateExpression: "SET #status = :verified, #updatedAt = :now ADD #arriveFps :fp",
                // 정리 중인 목표에는 넣지 않는다 (내린 것을 되살리지 않게)
                ConditionExpression: "attribute_exists(#finish) AND attribute_not_exists(#cleanup)",
                ExpressionAttributeNames: {
                  "#status": "status",
                  "#updatedAt": "updatedAt",
                  "#arriveFps": "arriveFps",
                  "#finish": "finish",
                  "#cleanup": "cleanupArrivals",
                },
                ExpressionAttributeValues: {
                  ":verified": "verified",
                  ":now": now.toISOString(),
                  ":fp": new Set([fp]),
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      // 도착 화면이 내려갔거나 목표가 없으면(끝 단계 미정) 넣지 않는다. 충돌·처리량 같은 다른 이유의
      // 취소는 던져서 Stream 이 다시 시도하게
      if (isOnlyConditionCancel(error)) return;
      throw error;
    }
  };

  /** 사람 seed 도착 화면 항목 (바로 verified, origin seed) */
  const seedArrive = async (goalId: string, fp: string, entry: string, now: Date) => {
    await withSets(`ARRIVE#${goalId}#${fp}`, ["evidence", "oldEvidence"], () =>
      doc.send(
        upd({
          TableName: table,
          Key: key(`ARRIVE#${goalId}#${fp}`),
          UpdateExpression:
            "SET #type = :type, goalId = :goalId, fp = :fp, #status = :verified, origin = :seed, " +
            "createdAt = if_not_exists(createdAt, :now) ADD evidence :entrySet",
          ExpressionAttributeNames: { "#type": "type", "#status": "status" },
          ExpressionAttributeValues: {
            ":type": "map-arrive",
            ":goalId": goalId,
            ":fp": fp,
            ":verified": "verified",
            ":seed": "seed",
            ":now": now.toISOString(),
            ":entrySet": new Set([entry]),
          },
        }),
      ),
    );
  };

  /**
   * R5 전에 seed 된 목표는 도착 화면이 GOAL.arriveFps 에만 있다. 같은 화면에 배운 증거를 넣기 전에
   * seed 도착 항목을 만들어 사람 승인을 남긴다 (무효 처리가 승인된 도착 화면을 빼지 않게)
   */
  const backfillSeedArrival = async (goalId: string, fp: string, now: Date) => {
    const arrive = await doc.send(
      new GetCommand({
        TableName: table,
        Key: key(`ARRIVE#${goalId}#${fp}`),
        ConsistentRead: true,
      }),
    );
    if (arrive.Item) return;
    const goal = await doc.send(
      new GetCommand({ TableName: table, Key: key(`GOAL#${goalId}`), ConsistentRead: true }),
    );
    if (goal.Item?.origin === "seed" && toIdList(goal.Item.arriveFps).includes(fp)) {
      await seedArrive(goalId, fp, `legacy#${goalId}@seed`, now);
    }
  };

  /** 증거 하나를 조건부로 더하고, 후보이고 기기가 충분하면 verified 로 */
  const addEvidence = async (
    sk: string,
    sets: Record<string, unknown>,
    entry: string,
    now: Date,
  ): Promise<EvidenceResult> => {
    const names: Record<string, string> = { "#status": "status" };
    const values: Record<string, unknown> = {
      ":entry": entry,
      ":entrySet": new Set([entry]),
      ":candidate": "candidate",
      ":now": now.toISOString(),
    };
    const assigns = ["#status = if_not_exists(#status, :candidate)", "lastUsedAt = :now"];
    Object.entries(sets).forEach(([field, value], n) => {
      names[`#f${n}`] = field;
      values[`:v${n}`] = value;
      assigns.push(`#f${n} = if_not_exists(#f${n}, :v${n})`);
    });
    let added = true;
    try {
      await withSets(sk, ["evidence", "oldEvidence"], () =>
        doc.send(
          upd({
            TableName: table,
            Key: key(sk),
            UpdateExpression: `SET ${assigns.join(", ")} ADD evidence :entrySet`,
            ConditionExpression:
              "NOT contains(evidence, :entry) AND NOT contains(oldEvidence, :entry)",
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }),
        ),
      );
    } catch (error) {
      if (!isConditionFailed(error)) throw error;
      added = false;
    }
    // 이미 있던 증거(재전달)여도 올리기를 마저 한다 (앞에서 증거만 쓰고 올리기가 실패했을 수 있음)
    if (await promoteIfReady(sk, now)) return "promoted";
    return added ? "added" : "duplicate";
  };

  /**
   * 후보이고 증거의 기기가 충분하면 verified. 읽은 증거 그대로일 때만 (그 사이 내려가 증거가 옮겨졌으면 다시 봄)
   */
  const promoteIfReady = async (sk: string, now: Date): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const out = await doc.send(
        new GetCommand({ TableName: table, Key: key(sk), ConsistentRead: true }),
      );
      const item = out.Item;
      if (item && hasLists(item)) {
        // 예전 List 증거는 Set 과 비교되지 않는다 → 먼저 바꾸고 다시 읽음
        await migrateToSets(sk, EVIDENCE_FIELDS);
        continue;
      }
      const evidence = toIdList(item?.evidence);
      if (item?.status !== "candidate" || devicesOf(evidence).size < REQUIRED_DEVICES) {
        return false;
      }
      try {
        await doc.send(
          upd({
            TableName: table,
            Key: key(sk),
            UpdateExpression: "SET #status = :verified, promotedAt = :now",
            ConditionExpression: "#status = :candidate AND evidence = :snap",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":verified": "verified",
              ":candidate": "candidate",
              ":now": now.toISOString(),
              ":snap": new Set(evidence),
            },
          }),
        );
        return true;
      } catch (error) {
        if (!isConditionFailed(error)) throw error;
      }
    }
    return false;
  };

  /** 증거를 oldEvidence 로 옮기고 candidate 로 (다시 올리려면 내려간 뒤 새 성공이 필요, 8.3) */
  const demote = async (
    sk: string,
    now: Date,
    should: (item: Record<string, unknown>) => boolean = () => true,
    /** 목표를 내릴 때: "도착 화면 정리 중" 표시를 같은 쓰기에 남김 */
    markCleanup = false,
  ): Promise<boolean> => {
    // 지금 증거를 읽은 그대로 옮긴다: 그 사이 다른 함수가 증거를 더했으면 조건이 깨져 다시 읽음
    // (더해진 증거를 지우기만 하고 oldEvidence 로 옮기지 않는 일이 없게)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const out = await doc.send(
        new GetCommand({ TableName: table, Key: key(sk), ConsistentRead: true }),
      );
      const item = out.Item;
      if (!item || !should(item)) return false;
      if (hasLists(item)) {
        await migrateToSets(sk, EVIDENCE_FIELDS);
        continue;
      }
      const evidence = toIdList(item.evidence);
      try {
        await withSets(sk, ["evidence", "oldEvidence"], () =>
          doc.send(
            upd({
              TableName: table,
              Key: key(sk),
              UpdateExpression:
                evidence.length > 0
                  ? `SET #status = :candidate, demotedAt = :now${markCleanup ? ", cleanupArrivals = :now" : ""} ADD oldEvidence :old REMOVE evidence`
                  : `SET #status = :candidate, demotedAt = :now${markCleanup ? ", cleanupArrivals = :now" : ""}`,
              // 읽은 증거·결과 창(rev) 그대로일 때만: 그 사이 증거가 더해졌거나 다른 결과가 기록됐으면
              // 다시 읽고 should 를 다시 판단 (성공이 들어와 실패율이 내려갔으면 내리지 않음)
              ConditionExpression: [
                evidence.length > 0 ? "evidence = :old" : "attribute_not_exists(evidence)",
                typeof item.rev === "number" ? "rev = :rev" : "attribute_not_exists(rev)",
              ].join(" AND "),
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":candidate": "candidate",
                ":now": now.toISOString(),
                ...(evidence.length > 0 ? { ":old": new Set(evidence) } : {}),
                ...(typeof item.rev === "number" ? { ":rev": item.rev } : {}),
              },
            }),
          ),
        );
        return true;
      } catch (error) {
        if (!isConditionFailed(error)) throw error;
      }
    }
    throw new Error(`demote kept conflicting: ${sk}`);
  };

  /** 목표를 내리면 도착 화면도 모두 내린다 (예전 증거로 바로 다시 올라가지 않게) */
  const demoteGoalArrivals = async (goalId: string, now: Date) => {
    let start: Record<string, unknown> | undefined;
    do {
      const out = await doc.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": MAP_PK, ":prefix": `ARRIVE#${goalId}#` },
          // 막 생긴 도착 화면도 빠짐없이 내리게 (남으면 옛 증거로 목표가 다시 verified 가 됨)
          ConsistentRead: true,
          ExclusiveStartKey: start,
        }),
      );
      for (const item of out.Items ?? []) {
        // 도착 화면 하나씩 내리고 목표에서 뺀다 (중간에 실패해도 뺀 것까지는 맞음, 목표는 아직 verified 라
        // 다음 실패가 다시 이 정리를 이어 감)
        await demote(String(item.SK), now);
        await removeArrival(goalId, String(item.fp));
      }
      start = out.LastEvaluatedKey;
    } while (start !== undefined);
    // R5 전 seed 목표: 도착 화면이 GOAL.arriveFps 에만 있다. 내린 seed 도착 항목(candidate)을 남겨
    // 나중에 seed 로 다시 채워지지 않게 하고(새 기기 2대가 필요), 목표에서 뺀다
    const goal = await doc.send(
      new GetCommand({ TableName: table, Key: key(`GOAL#${goalId}`), ConsistentRead: true }),
    );
    for (const fp of toIdList(goal.Item?.arriveFps)) {
      await doc
        .send(
          new PutCommand({
            TableName: table,
            Item: {
              ...key(`ARRIVE#${goalId}#${fp}`),
              type: "map-arrive",
              goalId,
              fp,
              status: "candidate",
              origin: "seed",
              oldEvidence: new Set([`legacy#${goalId}@seed`]),
              demotedAt: now.toISOString(),
              createdAt: now.toISOString(),
            },
            ConditionExpression: "attribute_not_exists(PK)",
          }),
        )
        .catch(async (error: unknown) => {
          // 이미 있는 도착 항목(조회 뒤 생긴 것 등)이면 그것도 내린다
          if (isConditionFailed(error)) return demote(`ARRIVE#${goalId}#${fp}`, now);
          throw error;
        });
      await removeArrival(goalId, fp);
    }
  };

  /** 내린 목표의 도착 화면 정리를 끝내고 표시를 지운다 (반복해도 같음) */
  const finishGoalCleanup = async (goalId: string, now: Date) => {
    await demoteGoalArrivals(goalId, now);
    await doc
      .send(
        upd({
          TableName: table,
          Key: key(`GOAL#${goalId}`),
          UpdateExpression: "REMOVE cleanupArrivals",
          ConditionExpression: "attribute_exists(PK)",
        }),
      )
      .catch((error: unknown) => {
        if (isConditionFailed(error)) return undefined;
        throw error;
      });
  };

  /** 목표의 arriveFps 에서 하나 빼기 (반복해도 같음) */
  const removeArrival = async (goalId: string, fp: string) => {
    const goalSk = `GOAL#${goalId}`;
    await withSets(goalSk, ["arriveFps", "evidence"], () =>
      doc.send(
        upd({
          TableName: table,
          Key: key(goalSk),
          UpdateExpression: "DELETE arriveFps :fp",
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeValues: { ":fp": new Set([fp]) },
        }),
      ),
    ).catch((error: unknown) => {
      if (isConditionFailed(error)) return undefined;
      throw error;
    });
  };

  return {
    async ensureGoal(goal, now) {
      try {
        await doc.send(
          upd({
            TableName: table,
            Key: key(`GOAL#${goal.goalId}`),
            UpdateExpression:
              "SET goalId = :goalId, pkg = if_not_exists(pkg, :pkg), finish = if_not_exists(finish, :finish), " +
              "#status = if_not_exists(#status, :candidate), origin = if_not_exists(origin, :learned), " +
              "#type = :type, updatedAt = :now",
            ConditionExpression: "attribute_not_exists(finish) OR finish = :finish",
            ExpressionAttributeNames: { "#status": "status", "#type": "type" },
            ExpressionAttributeValues: {
              ":goalId": goal.goalId,
              ":pkg": goal.pkg,
              ":finish": goal.finish,
              ":candidate": "candidate",
              ":learned": "learned",
              ":type": "map-goal",
              ":now": now.toISOString(),
            },
          }),
        );
        return "ok";
      } catch (error) {
        if (isConditionFailed(error)) return "conflict";
        throw error;
      }
    },

    async addEdgeEvidence(edge, entry, now) {
      const result = await addEvidence(
        `EDGE#${edge.edgeId}`,
        {
          type: "map-edge",
          edgeId: edge.edgeId,
          pkg: edge.pkg,
          fromFp: edge.fromFp,
          toFp: edge.toFp,
          action: edge.action,
          targetText: edge.targetText,
          targetClass: edge.targetClass,
          origin: "learned",
          createdAt: now.toISOString(),
        },
        entry,
        now,
      );
      return result;
    },

    async addArriveEvidence(goalId, fp, entry, now) {
      await backfillSeedArrival(goalId, fp, now);
      const result = await addEvidence(
        `ARRIVE#${goalId}#${fp}`,
        { type: "map-arrive", goalId, fp, createdAt: now.toISOString() },
        entry,
        now,
      );
      // 도착 화면이 verified 면 목표에 더하고 목표를 verified 로. 이번에 올린 것이 아니어도(재전달) 맞춘다
      await syncArrival(goalId, fp, now);
      return result;
    },

    async putSeedArrive(goalId, fp, entry, now) {
      await seedArrive(goalId, fp, entry, now);
    },

    async recordResult(target, ok, now) {
      const sk = target.kind === "edge" ? `EDGE#${target.id}` : `GOAL#${target.id}`;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const out = await doc.send(
          new GetCommand({ TableName: table, Key: key(sk), ConsistentRead: true }),
        );
        const item = out.Item;
        if (!item) return "missing";
        if (target.kind === "goal" && item.cleanupArrivals !== undefined) {
          await finishGoalCleanup(target.id, now);
        }
        const rev = typeof item.rev === "number" ? item.rev : 0;
        const recent = nextWindow(recentOf(item), ok);
        try {
          await doc.send(
            upd({
              TableName: table,
              Key: key(sk),
              UpdateExpression: ok
                ? "SET recent = :recent, rev = :next, lastUsedAt = :now"
                : "SET recent = :recent, rev = :next",
              ConditionExpression:
                rev === 0 ? "attribute_not_exists(rev) OR rev = :rev" : "rev = :rev",
              ExpressionAttributeValues: {
                ":recent": recent,
                ":rev": rev,
                ":next": rev + 1,
                ...(ok ? { ":now": now.toISOString() } : {}),
              },
            }),
          );
        } catch (error) {
          if (isConditionFailed(error)) continue;
          throw error;
        }
        if (!ok && item.status === "verified" && shouldDemote(recent)) {
          // 지금 결과 창으로 다시 판단 (그 사이 다른 요청의 성공이 기록됐을 수 있음)
          const stillFailing = (it: Record<string, unknown>) =>
            it.status === "verified" && shouldDemote(recentOf(it));
          // 목표: 결과 창 버전을 확인하며 먼저 내리고 "도착 화면 정리 중" 표시를 남긴 뒤 도착 화면을 정리.
          // 동시에 성공이 들어오면 내리기 자체가 조건에 걸려 다시 판단되고(도착 화면은 그대로),
          // 정리가 중간에 멈추면 표시가 남아 다음 결과·증거 반영이 이어서 정리한다
          const demoted = await demote(sk, now, stillFailing, target.kind === "goal");
          if (demoted && target.kind === "goal") await finishGoalCleanup(target.id, now);
          return demoted ? "demoted" : "recorded";
        }
        return "recorded";
      }
      return "recorded";
    },

    async putApplied(record) {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            ...key(`APPLIED#${cmdKey(record.uid, record.commandId, record.gen)}`),
            type: "map-applied",
            ...record,
          },
        }),
      );
    },

    async getApplied(uid, commandId, gen) {
      const out = await doc.send(
        new GetCommand({
          TableName: table,
          Key: key(`APPLIED#${cmdKey(uid, commandId, gen)}`),
          ConsistentRead: true,
        }),
      );
      return out.Item as AppliedRecord | undefined;
    },

    async retract(record, now) {
      const pull = async (sk: string) => {
        const out = await withSets(sk, ["evidence", "oldEvidence"], () =>
          doc.send(
            upd({
              TableName: table,
              Key: key(sk),
              UpdateExpression: "DELETE evidence :entrySet",
              ConditionExpression: "attribute_exists(PK)",
              ExpressionAttributeValues: { ":entrySet": new Set([record.entry]) },
              ReturnValues: "ALL_NEW",
            }),
          ),
        ).catch((error: unknown) => {
          if (isConditionFailed(error)) return undefined;
          throw error;
        });
        return out?.Attributes;
      };
      const enough = (item: Record<string, unknown>) =>
        devicesOf(toIdList(item.evidence)).size >= REQUIRED_DEVICES;
      // 배운 것이 이 명령 없이 기기가 모자라면 내림 (사람 seed 는 그대로). 내리기는 다시 읽어 판단
      // 사람이 승인한 것(origin seed, 또는 배운 것에 seed 승인 증거가 붙음)은 기기 수로 내리지 않는다
      const approved = (it: Record<string, unknown>) =>
        it.origin === "seed" || toIdList(it.evidence).some((e) => e.endsWith("@seed"));
      const weakLearned = (it: Record<string, unknown>) =>
        !approved(it) && it.status === "verified" && !enough(it);
      for (const edgeId of record.edgeIds) {
        await pull(`EDGE#${edgeId}`);
        await demote(`EDGE#${edgeId}`, now, weakLearned);
      }
      const arriveSk = `ARRIVE#${record.goalId}#${record.arriveFp}`;
      await pull(arriveSk);
      await demote(arriveSk, now, weakLearned);
      // verified 가 아닌 배운 도착 화면은 목표에서 뺀다 (재시도에서 앞의 목표 쓰기가 실패했어도 고쳐지게)
      const arrive = (
        await doc.send(
          new GetCommand({ TableName: table, Key: key(arriveSk), ConsistentRead: true }),
        )
      ).Item;
      if (!(arrive && approved(arrive)) && !(arrive?.status === "verified" && enough(arrive))) {
        await removeArrival(record.goalId, record.arriveFp);
      }
      await doc.send(
        new DeleteCommand({
          TableName: table,
          Key: key(`APPLIED#${cmdKey(record.uid, record.commandId, record.gen)}`),
        }),
      );
    },

    async putPending(record) {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            ...key(`PENDING#${cmdKey(record.uid, record.commandId, record.gen)}`),
            type: "map-pending",
            ...record,
          },
        }),
      );
    },

    async listPending() {
      const items: PendingRecord[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const out = await doc.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
            ExpressionAttributeValues: { ":pk": MAP_PK, ":prefix": "PENDING#" },
            ConsistentRead: true,
            ExclusiveStartKey: start,
          }),
        );
        items.push(...((out.Items ?? []) as PendingRecord[]));
        start = out.LastEvaluatedKey;
      } while (start !== undefined);
      return items;
    },

    async deletePending(uid, commandId, gen) {
      await doc.send(
        new DeleteCommand({
          TableName: table,
          Key: key(`PENDING#${cmdKey(uid, commandId, gen)}`),
        }),
      );
    },
  };
}
