/**
 * 지도 데이터 (docs/jev-routing-plan.md 3장).
 *
 * 역할 → 앱 → 목표. 연결선(3.3)과 목표의 도착지·끝 단계(3.2)는 지도 안내(R4)에서 더한다.
 * 지도는 코드가 아니라 데이터다: 처음엔 저장소 seed(seed-map.ts), 나중엔 DynamoDB(R3).
 * 어디서 읽든 parseMap 으로 모양과 서로 맞는지(참조, 중복)를 확인한다.
 */
import { z } from "zod";

export const LEVELS = ["L0", "L1", "L2", "L3"] as const;
export type Level = (typeof LEVELS)[number];

const id = z.string().regex(/^[a-z][a-z0-9_]*$/);
const goalId = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
const text = z.string().trim().min(1).max(120);

export const roleSchema = z.object({
  id,
  /** 어르신께 "하려는 일"을 물을 때 쓰는 짧은 이름 ("노래 듣기") */
  name: text,
  /** 습관으로 못 정할 때 앞에 세우는 앱 (4.3). 민감한 역할은 두지 않는다 */
  defaultApp: id.optional(),
  /** 은행·결제처럼 넘겨짚으면 안 되는 역할. 폰이 깔린 후보 중에서 묻는다 */
  sensitive: z.boolean().default(false),
});

export const appSchema = z.object({
  id,
  name: text,
  /** jev 1단계 후보 설명 */
  desc: text,
  /** 같은 일을 대신할 수 있는 앱끼리 묶는다. 한 앱이 여러 역할일 수 있다 (유튜브 = 영상·음악) */
  roles: z.array(id).min(1),
  /** 폰이 깔려 있는지 확인할 때 쓴다 (4.4) */
  packages: z.array(z.string().min(1)).min(1),
  /** 목표 없이 앱만 열 때의 민감도 (은행 앱 L3 등) */
  level: z.enum(LEVELS).default("L0"),
});

export const goalSchema = z.object({
  id: goalId,
  version: z.number().int().positive().default(1),
  app: id,
  /** 어르신께 물을 때 보여 주는 짧은 이름 ("등본") */
  name: text,
  /** jev 2단계 후보 설명 */
  desc: text,
  level: z.enum(LEVELS).default("L0"),
  /** 필요한 값. 비어 있으면 지도 안내 대신 Claude (4.5) */
  slots: z.array(z.string().regex(/^[a-z][A-Za-z0-9_]*$/)).default([]),
  status: z.enum(["candidate", "verified", "retired"]).default("verified"),
  origin: z.enum(["seed", "learned"]).default("seed"),
});

export const mapSchema = z
  .object({
    version: z.string().min(1).max(60),
    roles: z.array(roleSchema),
    apps: z.array(appSchema).min(1),
    goals: z.array(goalSchema),
  })
  .superRefine((map, ctx) => {
    const issue = (message: string) => {
      ctx.addIssue({ code: "custom", message });
    };
    const dup = (kind: string, ids: string[]) => {
      const seen = new Set<string>();
      for (const value of ids) {
        if (seen.has(value)) issue(`${kind} id 중복: ${value}`);
        seen.add(value);
      }
    };
    dup(
      "role",
      map.roles.map((r) => r.id),
    );
    dup(
      "app",
      map.apps.map((a) => a.id),
    );
    dup(
      "goal",
      map.goals.map((g) => g.id),
    );
    // none 은 jev 질문의 '해당 없음' 자리라 id 로 쓰지 않는다
    if (map.apps.some((a) => a.id === "none")) issue("app id 로 none 을 쓸 수 없음");

    const roles = new Set(map.roles.map((r) => r.id));
    const apps = new Map(map.apps.map((a) => [a.id, a]));
    for (const app of map.apps) {
      for (const role of app.roles) if (!roles.has(role)) issue(`${app.id}: 없는 역할 ${role}`);
    }
    for (const role of map.roles) {
      if (role.defaultApp === undefined) continue;
      const app = apps.get(role.defaultApp);
      if (!app) issue(`역할 ${role.id}: 없는 기본 앱 ${role.defaultApp}`);
      else if (!app.roles.includes(role.id))
        issue(`역할 ${role.id}: 기본 앱 ${app.id} 가 이 역할이 아님`);
      if (role.sensitive) issue(`민감한 역할 ${role.id} 에는 기본 앱을 두지 않음`);
    }
    for (const goal of map.goals) {
      if (!apps.has(goal.app)) issue(`${goal.id}: 없는 앱 ${goal.app}`);
      if (!goal.id.startsWith(`${goal.app}.`))
        issue(`${goal.id}: id 가 앱 ${goal.app}. 으로 시작하지 않음`);
      if (goal.id.endsWith(".none")) issue(`${goal.id}: none 은 목표 이름으로 쓸 수 없음`);
    }
  });

export type MapInput = z.input<typeof mapSchema>;
export type RouteMap = z.output<typeof mapSchema>;
export type MapRole = RouteMap["roles"][number];
export type MapApp = RouteMap["apps"][number];
export type MapGoal = RouteMap["goals"][number];

/** 지도 + 찾기용 색인 */
export interface IndexedMap {
  map: RouteMap;
  roles: ReadonlyMap<string, MapRole>;
  apps: ReadonlyMap<string, MapApp>;
  /** 앱별 jev 2단계 후보 (retired 제외) */
  goalsByApp: ReadonlyMap<string, readonly MapGoal[]>;
  goals: ReadonlyMap<string, MapGoal>;
}

export function parseMap(input: unknown): IndexedMap {
  const map = mapSchema.parse(input);
  const goalsByApp = new Map<string, MapGoal[]>();
  for (const goal of map.goals) {
    if (goal.status === "retired") continue;
    const list = goalsByApp.get(goal.app) ?? [];
    list.push(goal);
    goalsByApp.set(goal.app, list);
  }
  return {
    map,
    roles: new Map(map.roles.map((r) => [r.id, r])),
    apps: new Map(map.apps.map((a) => [a.id, a])),
    goalsByApp,
    goals: new Map(map.goals.map((g) => [g.id, g])),
  };
}

/** 목표 질문의 후보 키 (goalId 에서 앱 부분을 뗀 것) */
export const goalKey = (goal: MapGoal): string => goal.id.slice(goal.app.length + 1);
