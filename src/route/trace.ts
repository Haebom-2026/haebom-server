/**
 * 고르기 판정 기록 (docs/jev-routing-plan.md 9.1, R1.2).
 *
 * select() 는 그대로 두고, jev 호출을 가로채 원래 확률을 남긴 뒤
 * 같은 순수 판정(judgeApp·judgeGoal)을 다시 돌려 "어느 규칙을 탔는지"를 붙인다.
 * 판정 함수가 결정적이라 select() 안에서 낸 결과와 같다.
 *
 * 남기는 말은 jev 에 보낸 것과 같은 가린 말뿐이다.
 */
import { maskText } from "../shared/sensitive.js";
import {
  findAppMention,
  judgeApp,
  judgeGoal,
  NONE,
  ROUTE_THRESHOLDS,
  type AppRule,
  type FailReason,
  type GoalJudgement,
  type NameMention,
} from "./decide.js";
import type { ChoiceQuestion, JevClient, JevResult } from "./jev.js";
import { goalKey, type IndexedMap } from "./map.js";
import { createRouteSelector, type RouteSelection, type RouteSelector } from "./select.js";

/** 1단계에서 탄 규칙: 후보를 낸 규칙, 실패 이유, 또는 하려는 일 물음 */
export type AppTraceRule = AppRule | FailReason | "ask_intent";

export interface JevCallTrace {
  ok: boolean;
  /** 실패했을 때 (timeout·http·invalid·network) */
  reason?: string;
  ms: number;
  cost: number;
}

export interface AppStageTrace extends JevCallTrace {
  /** 앱 id(와 none) → 확률, 높은 순 */
  probs: [string, number][];
  /** 역할 id → 합계, 높은 순 */
  roles: [string, number][];
  /** 말에서 찾은 앱 이름 (4.2 2번) */
  mention: NameMention;
  rule?: AppTraceRule;
}

export interface GoalStageTrace extends JevCallTrace {
  appId: string;
  /** 목표 id(와 none) → 확률, 높은 순 */
  probs: [string, number][];
  judged?: GoalJudgement["kind"];
}

export interface RouteTrace {
  /** jev 에 보낸 가린 말 */
  masked: string;
  thresholds: typeof ROUTE_THRESHOLDS;
  app?: AppStageTrace;
  goals: GoalStageTrace[];
}

interface RecordedCall {
  questions: Record<string, ChoiceQuestion>;
  result: JevResult;
}

const sortDesc = (probs: Record<string, number>): [string, number][] =>
  Object.entries(probs).sort((a, b) => b[1] - a[1]);

const callTrace = (r: JevResult): JevCallTrace =>
  r.ok ? { ok: true, ms: r.ms, cost: r.cost } : { ok: false, reason: r.reason, ms: r.ms, cost: 0 };

/** 목표 질문 후보 키 → 그 질문의 앱 */
function goalApp(m: IndexedMap, criteria: Record<string, string>): string | undefined {
  const keys = Object.keys(criteria).filter((k) => k !== NONE);
  for (const [appId, goals] of m.goalsByApp) {
    const own = new Set(goals.map(goalKey));
    if (keys.length > 0 && keys.every((k) => own.has(k))) return appId;
  }
  return undefined;
}

/** 목표 키 → 목표 id (앱 이름을 붙임). none 은 그대로 */
const goalIds = (appId: string, probs: [string, number][]): [string, number][] =>
  probs.map(([k, p]) => [k === NONE ? NONE : `${appId}.${k}`, p]);

export function buildTrace(
  m: IndexedMap,
  input: { utterance: string; prefs?: Readonly<Record<string, string>> },
  calls: readonly RecordedCall[],
): RouteTrace {
  const trace: RouteTrace = {
    masked: maskText(input.utterance).text,
    thresholds: ROUTE_THRESHOLDS,
    goals: [],
  };
  for (const { questions, result } of calls) {
    if (questions.app) {
      const probs = result.ok ? (result.answers.app?.probabilities ?? {}) : {};
      const roleSum = new Map<string, number>();
      for (const [id, p] of Object.entries(probs)) {
        for (const role of m.apps.get(id)?.roles ?? [])
          roleSum.set(role, (roleSum.get(role) ?? 0) + p);
      }
      const stage: AppStageTrace = {
        ...callTrace(result),
        probs: sortDesc(probs),
        roles: [...roleSum.entries()].sort((a, b) => b[1] - a[1]),
        mention: findAppMention(m, input.utterance),
      };
      if (result.ok && result.answers.app) {
        const judged = judgeApp(m, probs, input.utterance, input.prefs);
        const rule =
          judged.kind === "fail"
            ? judged.reason
            : judged.kind === "ask_intent"
              ? "ask_intent"
              : judged.rule;
        if (rule !== undefined) stage.rule = rule;
      }
      trace.app = stage;
    } else if (questions.goal) {
      const appId = goalApp(m, questions.goal.criteria) ?? "?";
      const probs = result.ok ? (result.answers.goal?.probabilities ?? {}) : {};
      const stage: GoalStageTrace = {
        ...callTrace(result),
        appId,
        probs: goalIds(appId, sortDesc(probs)),
      };
      if (result.ok && result.answers.goal) stage.judged = judgeGoal(probs).kind;
      trace.goals.push(stage);
    }
  }
  return trace;
}

export interface TracedSelector {
  select(input: {
    utterance: string;
    prefs?: Readonly<Record<string, string>>;
  }): Promise<{ selection: RouteSelection; trace: RouteTrace }>;
}

/** select() 와 같은 고르기 + 판정 기록 */
export function createTracedSelector(deps: {
  jev: JevClient;
  map: IndexedMap;
  budgetMs?: number;
  now?: () => number;
}): TracedSelector {
  return {
    async select(input) {
      const calls: RecordedCall[] = [];
      const jev: JevClient = {
        async choose(state, questions, opts) {
          const result = await deps.jev.choose(state, questions, opts);
          calls.push({ questions, result });
          return result;
        },
      };
      const selector: RouteSelector = createRouteSelector({ ...deps, jev });
      const selection = await selector.select(input);
      return { selection, trace: buildTrace(deps.map, input, calls) };
    },
  };
}
