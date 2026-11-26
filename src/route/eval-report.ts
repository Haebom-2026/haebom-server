/**
 * 고르기 회귀 측정 결과 파일 (scripts/route-eval.ts --out, docs/jev-routing-plan.md 9.1).
 * 디버그 뷰어 "고르기" 탭이 이 파일을 연다 (viewer/src/route-types.ts 가 같은 모양).
 */
import type { IndexedMap } from "./map.js";
import type { RouteSelection } from "./select.js";
import type { RouteTrace } from "./trace.js";

export const EVAL_REPORT_VERSION = 1;

export interface EvalExpect {
  /** 이 중 어느 앱이든 어르신 일은 된다 (지도에 있는 것만) */
  apps: string[];
  /** 정답 목표 id. 없으면 목표는 채점하지 않음 */
  goals?: string[];
}

export type AppGrade =
  /** 후보 안에 정답 앱 */
  | "hit"
  /** 후보를 냈지만 정답 앱 없음 */
  | "miss"
  /** 해당 없음이어야 하는데 후보를 냄 */
  | "false_positive"
  /** 정답 앱이 있는데 route 없음 (실패) */
  | "no_route"
  /** 정답 앱이 있는데 하려는 일을 물음 */
  | "ask"
  /** 해당 없음을 맞힘 */
  | "none_ok";

export type GoalGrade = "right" | "wrong" | "ask" | "no_goal";

export interface EvalItem {
  utterance: string;
  source: "real" | "synthetic";
  expect: EvalExpect;
  selection: RouteSelection;
  trace: RouteTrace;
  grade: { app: AppGrade; goal?: GoalGrade };
}

export interface EvalMapInfo {
  name: string;
  version: string;
  roles: { id: string; name: string; sensitive: boolean }[];
  apps: { id: string; name: string; roles: string[] }[];
  goals: { id: string; app: string; name: string; level: string; status: string }[];
}

export interface EvalRun {
  map: EvalMapInfo;
  items: EvalItem[];
}

export interface EvalReport {
  kind: "route-eval";
  version: typeof EVAL_REPORT_VERSION;
  createdAt: string;
  jevModel: string;
  runs: EvalRun[];
}

export function mapInfo(name: string, m: IndexedMap): EvalMapInfo {
  return {
    name,
    version: m.map.version,
    roles: m.map.roles.map((r) => ({ id: r.id, name: r.name, sensitive: r.sensitive })),
    apps: m.map.apps.map((a) => ({ id: a.id, name: a.name, roles: a.roles })),
    goals: m.map.goals.map((g) => ({
      id: g.id,
      app: g.app,
      name: g.name,
      level: g.level,
      status: g.status,
    })),
  };
}

/** 채점 (route-eval.ts 의 1단계·2단계 집계와 같은 기준) */
export function grade(m: IndexedMap, expect: EvalExpect, r: RouteSelection): EvalItem["grade"] {
  const accept = expect.apps;
  if (r.kind !== "route") {
    if (accept.length === 0) return { app: "none_ok" };
    return { app: r.kind === "ask_intent" ? "ask" : "no_route" };
  }
  if (accept.length === 0) return { app: "false_positive" };
  const hit = r.candidates.some((c) => accept.includes(c.appId));
  if (!hit) return { app: "miss" };
  if (!expect.goals) return { app: "hit" };
  const c = r.candidates.find((x) => accept.includes(x.appId) && m.goalsByApp.has(x.appId));
  if (!c) return { app: "hit" };
  const goal: GoalGrade = c.goal
    ? expect.goals.includes(c.goal.id)
      ? "right"
      : "wrong"
    : c.clarify
      ? "ask"
      : "no_goal";
  return { app: "hit", goal };
}
