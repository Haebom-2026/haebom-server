/**
 * 어르신 말 → 후보 앱 순서 + 목표 (docs/jev-routing-plan.md 4장).
 *
 * 1단계: 지도의 앱 전체로 jev → judgeApp → 후보 앱(최대 3개)
 * 2단계: 후보 중 목표가 있는 앱마다 jev 를 동시에 → judgeGoal
 * 서버는 폰에 무엇이 깔렸는지 모른다. 폰이 후보 중 깔린 첫 번째를 쓴다 (4.3·4.4).
 *
 * 두 단계를 합친 시간 예산(budgetMs)을 넘거나 1단계가 실패하면 fail → route 없음 (Claude 안내).
 * 2단계만 실패하면 그 후보는 앱만 (목표 없음) 으로 둔다.
 * jev 에는 가린 말과 지도의 앱·목표 설명만 보낸다 (9장).
 * 이 결과는 민감도를 올리는 데만 쓴다: 안전 분류는 따로 늘 돈다 (5.1, 호출하는 쪽 책임).
 */
import { maskText } from "../shared/sensitive.js";
import {
  appQuestion,
  goalQuestion,
  judgeApp,
  judgeGoal,
  judgeRole,
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
  /** candidate 목표의 level 은 안전 분류에 쓰지 않는다 (5.1) */
  verified: boolean;
}

/** 어르신께 물을 것. 답은 앱 선택 API 로 (5.2) */
export interface RouteClarifyOption {
  id: string;
  name: string;
  /** 목표 질문일 때: 그 목표의 단계와 검증 여부 (서버가 단계를 올릴 때만 씀) */
  level?: Level;
  verified?: boolean;
}

export interface RouteClarify {
  questionId: string;
  say: string;
  options: RouteClarifyOption[];
}

export interface RouteCandidate {
  appId: string;
  name: string;
  packages: string[];
  by: CandidateBy;
  /** 이 후보로 갈 때의 민감도: 목표가 있으면 목표, 없으면 앱 */
  level: Level;
  goal?: RouteGoal;
  /** 이 후보 앱에서 두 목표가 비슷 → 폰이 이 앱을 고르면 물음 (4.3) */
  clarify?: RouteClarify;
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
      /** 후보 하나, 없으면 바꾸지 않고 설치를 물음 (4.3) */
      exclusive: boolean;
      /** Play 스토어로 다른 앱을 깔기·지우기 할 때 말한 앱 이름 (슬롯 appName) */
      mentionedApp?: string;
      ask: boolean;
      candidates: RouteCandidate[];
      confidence: { app: number; role: number };
    })
  | (Base & { kind: "ask_intent"; clarify: RouteClarify; confidence: { role: number } })
  | (Base & { kind: "fail"; reason: string; confidence?: { app: number; role: number } });

export interface RouteSelector {
  select(input: {
    utterance: string;
    prefs?: Readonly<Record<string, string>>;
    /** 하려는 일 질문의 답 (역할 id). 있으면 1단계 판정 대신 이 역할의 앱으로 */
    role?: string;
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
    async select({ utterance, prefs, role }) {
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

      const judged: AppJudgement =
        role === undefined
          ? judgeApp(m, appAnswer.probabilities, utterance, prefs)
          : judgeRole(m, appAnswer.probabilities, role, prefs);
      if (judged.kind === "fail") {
        return { ...base(), kind: "fail", reason: judged.reason, confidence: judged.confidence };
      }
      if (judged.kind === "ask_intent") {
        const options = judged.roles.map((roleId) => ({
          id: roleId,
          name: m.roles.get(roleId)?.name ?? roleId,
        }));
        return {
          ...base(),
          kind: "ask_intent",
          clarify: { questionId: "intent", say: askSay(options), options },
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
                verified: g.status === "verified",
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
                verified: g.status === "verified",
              },
            };
          }
          if (goal.kind === "ask") {
            const options = goal.keys.flatMap((key) => {
              const g = gq.goals.get(key);
              return g
                ? [{ id: g.id, name: g.name, level: g.level, verified: g.status === "verified" }]
                : [];
            });
            // 물을 때는 두 목표 중 높은 민감도로 본다
            const levels = goal.keys.map((key) => gq.goals.get(key)?.level ?? app.level);
            const level = levels.reduce((a, b) => (a > b ? a : b), app.level);
            return {
              ...out,
              level,
              clarify: { questionId: `goal:${appId}`, say: askSay(options), options },
            };
          }
          return out;
        }),
      );

      return {
        ...base(),
        kind: "route",
        role: judged.role,
        named: judged.named,
        exclusive: judged.exclusive,
        ...(judged.mentionedApp === undefined ? {} : { mentionedApp: judged.mentionedApp }),
        ask: judged.ask,
        candidates: judged.named ? candidates : byGoalStrength(candidates),
        confidence: judged.confidence,
      };
    },
  };
}

/** "등본인가요, 초본인가요?" */
const askSay = (options: readonly { name: string }[]): string =>
  `${options.map((o) => `${o.name}인가요`).join(", ")}?`;

/**
 * 목표가 약해지는 후보를 앞에 세우지 않는다 (4.3): 한 후보가 구체 목표를 정했으면,
 * 목표 없음·앱 열기(.open)뿐인 후보는 선호·기본 앱이라도 그 뒤로. 같은 등급 안의 순서는 그대로.
 */
export function byGoalStrength(candidates: readonly RouteCandidate[]): RouteCandidate[] {
  const strength = (c: RouteCandidate) =>
    c.goal && !c.goal.id.endsWith(".open") ? 0 : c.clarify ? 1 : 2;
  if (!candidates.some((c) => strength(c) === 0)) return [...candidates];
  return candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => strength(a.c) - strength(b.c) || a.i - b.i)
    .map(({ c }) => c);
}
