/**
 * 명령 상태 (docs/jev-routing-plan.md 3.5·5.1·5.2, docs/api/s4-classify.md 6장).
 *
 * 키: main 테이블 `ELDER#<uid>` / `CMD#<commandId>`. 어르신 uid 아래에 두므로 다른 어르신은
 * 같은 commandId 로도 이 명령을 읽거나 바꿀 수 없다 (명령 소유).
 *
 * 계약: 같은 어르신의 commandId 는 하루(TTL) 안에 다른 명령에 다시 쓰지 않는다.
 * 그래서 살아 있는 명령에 같은 번호로 classify 가 다시 오면 **재시도**로 보고 합친다 (classify.ts).
 *
 * 쓰기 규칙
 * - 처음 만들기(create): 없거나 TTL 이 지났을 때만
 * - 그 밖의 모든 쓰기(update): 읽은 때의 `rev` 와 같을 때만 쓰고 `rev` 를 올린다.
 *   동시에 온 두 쓰기 중 늦은 쪽은 conflict → 늦은 쓰기가 앞의 결과(단계·고른 앱)를 덮지 않는다
 * - 읽기는 강한 일관성 (classify 바로 뒤 앱 선택이 404 가 되지 않게)
 */
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { ClarifyOut, RouteOut, Signal } from "../ai/classify-schema.js";
import type { Category, Level } from "../core/notifications.js";

export const COMMAND_TTL_SECONDS = 24 * 3600;

export interface CommandRecord {
  uid: string;
  commandId: number;
  createdAt: string;
  /** 명령을 만들 때마다 새로 정하는 id. TTL 뒤 같은 번호로 다시 만든 명령에 예전 갱신이 들어가지 않게 */
  gen: string;
  /** 쓸 때마다 +1. 모든 갱신은 읽은 gen·rev 와 같을 때만 */
  rev: number;
  /** jev 에 보낸 것과 같은 가린 말. 하려는 일 질문에 답할 때 다시 고르는 데 쓴다 */
  maskedUtterance: string;
  /** 신호·scam 보정 전 단계: max(규칙, 안전 분류). 안전 분류가 실패했으면 규칙 */
  baseLevel: Level;
  signals: Signal[];
  category: Category;
  /** 보호자 앱에 보일 이유 (가림 적용, 40자) */
  reason: string;
  /** 안전 분류가 한 번도 성공하지 못함 → route 없음, 규칙 결과만 */
  degraded: boolean;
  /** 지금 명령 단계 (내려가지 않음) */
  level: Level;
  route?: RouteOut;
  clarify?: ClarifyOut;
  /** 처리한 하려는 일 답 (같은 답 재전송은 저장된 결과로) */
  intentAnswer?: string;
  /** 앱 선택 API 로 고정한 앱. 한 번 정하면 바꾸지 않는다 */
  chosenApp?: string;
  chosenGoal?: string;
  askedUser?: boolean;
}

/** update 로 바꿀 수 있는 필드 */
export type CommandPatch = Partial<
  Pick<
    CommandRecord,
    | "baseLevel"
    | "signals"
    | "category"
    | "reason"
    | "degraded"
    | "level"
    | "route"
    | "clarify"
    | "intentAnswer"
    | "chosenApp"
    | "chosenGoal"
    | "askedUser"
  >
>;
export type RemovableField = "route" | "clarify";

export type UpdateResult = "ok" | "missing" | "conflict";

export interface CommandStore {
  /** 없거나 TTL 이 지났을 때만 만든다. 살아 있는 명령이 있으면 "exists" */
  create(record: CommandRecord): Promise<"created" | "exists">;
  get(uid: string, commandId: number): Promise<CommandRecord | undefined>;
  /** 읽은 때의 gen·rev 와 같을 때만. remove 는 지움 */
  update(
    uid: string,
    commandId: number,
    read: Pick<CommandRecord, "gen" | "rev">,
    set: CommandPatch,
    remove?: readonly RemovableField[],
  ): Promise<UpdateResult>;
}

const pk = (uid: string) => `ELDER#${uid}`;
const sk = (commandId: number) => `CMD#${commandId}`;

export function createAwsCommandStore(
  table: string,
  client: DynamoDBClient = new DynamoDBClient({}),
  now: () => Date = () => new Date(),
): CommandStore {
  const doc = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const nowSec = () => Math.floor(now().getTime() / 1000);
  const key = (uid: string, commandId: number) => ({ PK: pk(uid), SK: sk(commandId) });

  const get = async (uid: string, commandId: number): Promise<CommandRecord | undefined> => {
    const out = await doc.send(
      new GetCommand({ TableName: table, Key: key(uid, commandId), ConsistentRead: true }),
    );
    const item = out.Item;
    if (!item) return undefined;
    // TTL 삭제는 늦을 수 있다
    if (typeof item.ttl === "number" && item.ttl < nowSec()) return undefined;
    return item as unknown as CommandRecord;
  };

  return {
    async create(record) {
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: {
              ...key(record.uid, record.commandId),
              type: "command",
              ...record,
              ttl: nowSec() + COMMAND_TTL_SECONDS,
            },
            ConditionExpression: "attribute_not_exists(PK) OR #ttl < :now",
            ExpressionAttributeNames: { "#ttl": "ttl" },
            ExpressionAttributeValues: { ":now": nowSec() },
          }),
        );
        return "created";
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return "exists";
        throw error;
      }
    },

    get,

    async update(uid, commandId, read, set, remove = []) {
      const names: Record<string, string> = { "#rev": "rev", "#gen": "gen", "#ttl": "ttl" };
      const values: Record<string, unknown> = {
        ":rev": read.rev,
        ":gen": read.gen,
        ":next": read.rev + 1,
        ":now": nowSec(),
      };
      const sets = ["#rev = :next"];
      for (const [field, value] of Object.entries(set)) {
        names[`#${field}`] = field;
        values[`:${field}`] = value;
        sets.push(`#${field} = :${field}`);
      }
      const removes = remove.map((field) => {
        names[`#${field}`] = field;
        return `#${field}`;
      });
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: key(uid, commandId),
            ConditionExpression:
              "attribute_exists(PK) AND #gen = :gen AND #rev = :rev AND #ttl >= :now",
            UpdateExpression: `SET ${sets.join(", ")}${removes.length ? ` REMOVE ${removes.join(", ")}` : ""}`,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }),
        );
        return "ok";
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          return (await get(uid, commandId)) ? "conflict" : "missing";
        }
        throw error;
      }
    },
  };
}
