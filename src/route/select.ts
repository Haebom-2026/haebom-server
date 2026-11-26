/**
 * 어르신 말 → 후보 앱 순서 + 목표 (docs/jev-routing-plan.md 4장).
 *
 * 1단계: 지도의 앱 전체로 jev → judgeApp → 후보 앱(최대 3개)
 * 2단계: 후보 중 목표가 있는 앱마다 jev 를 동시에 → judgeGoal
 * 서버는 폰에 무엇이 깔렸는지 모른다. 폰이 후보 중 깔린 첫 번째를 쓴다 (4.3·4.4).
 *
 * 두 단계를 합친 시간 예산(budgetMs)을 넘거나 1단계가 실패하면 fail → 지금 흐름(Claude).
 * 2단계만 실패하면 그 후보는 앱만 (목표 없음) 으로 둔다.
 * jev 에는 가린 말만 보낸다 (9장).
 */
import { maskText } from "../shared/sensitive.js";
import {
  appQuestion,
  goalQuestion,
  judgeApp,
  judgeGoal,
  type AppJudgement,
  type CandidateBy,
} from "./decide.js";
import type { JevClient } from "./jev.js";
import type { IndexedMap, Level } from "./map.js";

export const ROUTE_BUDGET_MS = 1_500;

export interface RouteGoal {
  id: string;
  version: number;
  name: string;
  level: Level;
  slots: string[];
  confidence: number;
}

export interface RouteCandidate {
  appId: string;
  name: string;
  packages: string[];
  by: CandidateBy;
  /** 이 후보로 갈 때의 민감도: 목표가 있으면 목표, 없으면 앱 */
  level: Level;
  goal?: RouteGoal;
  /** 두 목표가 비슷 → 어르신께 물음 (목표 name) */
  goalOptions?: { id: string; name: string }[];
}

interface Base {
  mapVersion: string;
  ms: number;
  cost: number;
}

export type RouteSelection =
  | (Base & {
      kind: "route";
      role: string;
      named: boolean;
      ask: boolean;
      candidates: RouteCandidate[];
      confidence: { app: number; role: number };
    })
  | (Base & {
      kind: "ask_intent";
      options: { roleId: string; name: string }[];
      confidence: { role: number };
    })
  | (Base & { kind: "fail"; reason: string; confidence?: { app: number; role: number } });

export interface RouteSelector {
  select(input: {
    utterance: string;
    prefs?: Readonly<Record<string, string>>;
  }): Promise<RouteSelection>;
}

export function createRouteSelector(deps: {
  jev: JevClient;
  map: IndexedMap;
  budgetMs?: number;
  now?: () => number;
}): RouteSelector {
  const budget = deps.budgetMs ?? ROUTE_BUDGET_MS;
  const now = deps.now ?? Date.now;
  const m = deps.map;

  return {
    async select({ utterance, prefs }) {
      const started = now();
      const left = () => budget - (now() - started);
      let cost = 0;
      const base = () => ({ mapVersion: m.map.version, ms: now() - started, cost });

      const state = `어르신이 한 말: ${maskText(utterance).text}`;
      const first = await deps.jev.choose(state, { app: appQuestion(m) }, { timeoutMs: left() });
      if (!first.ok) return { ...base(), kind: "fail", reason: `jev_${first.reason}` };
      cost += first.cost;
      const appAnswer = first.answers.app;
      if (!appAnswer) return { ...base(), kind: "fail", reason: "jev_invalid" };

      const judged: AppJudgement = judgeApp(m, appAnswer.probabilities, prefs);
      if (judged.kind === "fail") {
        return { ...base(), kind: "fail", reason: judged.reason, confidence: judged.confidence };
      }
      if (judged.kind === "ask_intent") {
        return {
          ...base(),
          kind: "ask_intent",
          options: judged.roles.map((roleId) => ({
            roleId,
            name: m.roles.get(roleId)?.name ?? roleId,
          })),
          confidence: judged.confidence,
        };
      }

      const candidates = await Promise.all(
        judged.candidates.map(async ({ appId, by }): Promise<RouteCandidate> => {
          const app = m.apps.get(appId);
          if (!app) throw new Error(`unknown app ${appId}`);
          const out: RouteCandidate = {
            appId,
            name: app.name,
            packages: app.packages,
            by,
            level: app.level,
          };
          const gq = goalQuestion(m, appId);
          if (gq.kind === "none") return out;
          if (gq.kind === "only") {
            const g = gq.goal;
            return {
              ...out,
              level: g.level,
              goal: {
                id: g.id,
                version: g.version,
                name: g.name,
                level: g.level,
                slots: g.slots,
                confidence: 1,
              },
            };
          }
          const res = await deps.jev.choose(state, { goal: gq.question }, { timeoutMs: left() });
          if (!res.ok) return out;
          cost += res.cost;
          const answer = res.answers.goal;
          if (!answer) return out;
          const goal = judgeGoal(answer.probabilities);
          if (goal.kind === "goal") {
            const g = gq.goals.get(goal.key);
            if (!g) return out;
            return {
              ...out,
              level: g.level,
              goal: {
                id: g.id,
                version: g.version,
                name: g.name,
                level: g.level,
                slots: g.slots,
                confidence: goal.confidence,
              },
            };
          }
          if (goal.kind === "ask") {
            const options = goal.keys.flatMap((key) => {
              const g = gq.goals.get(key);
              return g ? [{ id: g.id, name: g.name }] : [];
            });
            // 물을 때는 두 목표 중 높은 민감도로 본다
            const levels = goal.keys.map((key) => gq.goals.get(key)?.level ?? app.level);
            const level = levels.reduce((a, b) => (a > b ? a : b), app.level);
            return { ...out, level, goalOptions: options };
          }
          return out;
        }),
      );

      return {
        ...base(),
        kind: "route",
        role: judged.role,
        named: judged.named,
        ask: judged.ask,
        candidates,
        confidence: judged.confidence,
      };
    },
  };
}
