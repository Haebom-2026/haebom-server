/**
 * jev 확률 → 판정 (docs/jev-routing-plan.md 4.2·4.3). 네트워크 없는 순수 함수.
 *
 * 1단계(앱): '해당 없음' 먼저 → 말한 앱(별칭) → 두 역할이 비슷하면 하려는 일을 물음 →
 *            1등 앱 + 같은 역할 앱 → 역할 합계 → 그 밖 실패(route 없음)
 * 2단계(목표): 확실 → 그 목표 / 두 목표가 비슷 → 어르신께 물음 / 그 밖 → 앱만
 */
import type { ChoiceQuestion } from "./jev.js";
import { goalKey, normalizeName, type IndexedMap, type MapGoal } from "./map.js";

/** 시작값. 회귀 세트(scripts/route-eval.ts)로 조정한다 */
export const ROUTE_THRESHOLDS = {
  app: 0.5,
  role: 0.5,
  /** 두 역할이 둘 다 이 이상이고 차이가 intentGap 보다 작으면 하려는 일을 물음 */
  intentMin: 0.25,
  intentGap: 0.2,
  goal: 0.7,
  goalMargin: 0.3,
  goalAskMin: 0.3,
  /** 말한 앱은 아니어도 1등 앱이 이만큼 확실하면 같은 역할 앱으로 바꾸지 않음 (KTX → SRT 같은 바꿈 방지) */
  exclusive: 0.9,
  maxCandidates: 3,
} as const;

export const NONE = "none";

export const APP_INSTRUCTIONS =
  "고령자가 스마트폰 도우미에게 한 말입니다. 이 일을 하려면 어느 앱을 써야 하나요? " +
  "말에 앱 이름이 들어 있어도 그 앱을 새로 깔기·업데이트·지우려는 말이면 Play 스토어를 고르세요. " +
  "맞는 앱이 없거나 무엇을 하려는지 알 수 없으면 none 을 고르세요.";

export function appQuestion(m: IndexedMap): ChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const app of m.map.apps) criteria[app.id] = `${app.name}: ${app.desc}`;
  criteria[NONE] = "해당 없음: 위 앱 어느 것에도 맞지 않는 일, 또는 무엇을 하려는지 알 수 없음";
  return { instructions: APP_INSTRUCTIONS, criteria };
}

export type GoalQuestion =
  | { kind: "ask"; question: ChoiceQuestion; goals: ReadonlyMap<string, MapGoal> }
  | { kind: "only"; goal: MapGoal }
  | { kind: "none" };

/** 앱의 목표 질문. 목표가 없으면 none, 하나뿐이면 묻지 않고 그 목표 */
export function goalQuestion(m: IndexedMap, appId: string): GoalQuestion {
  const goals = m.goalsByApp.get(appId) ?? [];
  const [first] = goals;
  if (!first) return { kind: "none" };
  if (goals.length === 1) return { kind: "only", goal: first };
  const app = m.apps.get(appId);
  const criteria: Record<string, string> = {};
  const byKey = new Map<string, MapGoal>();
  for (const goal of goals) {
    criteria[goalKey(goal)] = goal.desc;
    byKey.set(goalKey(goal), goal);
  }
  criteria[NONE] = "위 목표 어느 것도 아님";
  return {
    kind: "ask",
    goals: byKey,
    question: {
      instructions: `고령자가 ${app?.name ?? appId} 앱에서 하려는 일은 어느 것인가요? 맞는 것이 없으면 none 을 고르세요.`,
      criteria,
    },
  };
}

const sortDesc = (probs: Record<string, number>, skip?: string) =>
  Object.entries(probs)
    .filter(([key]) => key !== skip)
    .sort((a, b) => b[1] - a[1]);

export type CandidateBy = "named" | "jev" | "pref" | "default";

export interface AppCandidate {
  appId: string;
  by: CandidateBy;
}

export type FailReason =
  /** '해당 없음'이 1등 앱 이상 */
  | "none"
  /** 1등 앱·역할 모두 기준 미달 */
  | "low"
  /** 말에 지도 앱 이름이 있는데 jev 1등은 다른 앱 */
  | "named_mismatch"
  /** 말에 지도 밖 앱 이름이 있음 (예: 지도에 없는 멜론) */
  | "unknown_app"
  /** 말에 서로 다른 앱 이름이 같은 길이로 둘 이상 */
  | "named_ambiguous";

export type AppJudgement =
  | {
      kind: "candidates";
      role: string;
      /** 말한 앱 (별칭이 말에 있음) */
      named: boolean;
      /** 후보는 그 앱 하나. 없으면 같은 역할 앱으로 바꾸지 않고 설치를 물음 (말한 앱이거나 jev ≥ 0.9) */
      exclusive: boolean;
      /** Play 스토어로 다른 앱을 깔기·지우기 할 때 말한 앱 이름 (슬롯 appName) */
      mentionedApp?: string;
      /** 민감한 역할 → 폰이 깔린 후보 중에서 물음 */
      ask: boolean;
      candidates: AppCandidate[];
      confidence: { app: number; role: number };
    }
  | { kind: "ask_intent"; roles: [string, string]; confidence: { role: number } }
  | { kind: "fail"; reason: FailReason; confidence: { app: number; role: number } };

export type NameMention =
  | { kind: "map"; appId: string; text: string }
  | { kind: "other"; text: string }
  | { kind: "ambiguous" }
  | { kind: "none" };

/**
 * 말에 나온 앱 이름 (4.2 3번). 가장 긴 이름이 이긴다 ("유튜브 뮤직" > "유튜브").
 * 띄어쓰기는 무시한다 ("정부 24" = "정부24").
 */
export function findAppMention(m: IndexedMap, utterance: string): NameMention {
  const said = normalizeName(utterance);
  let best: { len: number; owners: Set<string>; text: string } | undefined;
  const consider = (alias: string, owner: string) => {
    const key = normalizeName(alias);
    if (key.length === 0 || !said.includes(key)) return;
    if (!best || key.length > best.len)
      best = { len: key.length, owners: new Set([owner]), text: alias };
    else if (key.length === best.len) best.owners.add(owner);
  };
  for (const app of m.map.apps) for (const alias of app.aliases) consider(alias, app.id);
  for (const name of m.map.otherAppNames) consider(name, OTHER);
  if (!best) return { kind: "none" };
  if (best.owners.size > 1) return { kind: "ambiguous" };
  const [owner] = [...best.owners];
  return owner === OTHER || owner === undefined
    ? { kind: "other", text: best.text }
    : { kind: "map", appId: owner, text: best.text };
}

const OTHER = "\u0000other";

/**
 * 1단계 판정 (docs/jev-routing-plan.md 4.2). 위에서부터 처음 맞는 것:
 *   '해당 없음' ≥ 1등 앱 → 실패 / 말한 앱 / 두 역할이 비슷 → 하려는 일을 물음 /
 *   1등 앱 ≥ 0.5 / 역할 합계 ≥ 0.5 / 그 밖 실패
 * @param prefs 역할 → 이 어르신이 평소 쓰던 앱 (4.3)
 */
export function judgeApp(
  m: IndexedMap,
  probs: Record<string, number>,
  utterance: string,
  prefs: Readonly<Record<string, string>> = {},
): AppJudgement {
  const t = ROUTE_THRESHOLDS;
  const apps = sortDesc(probs, NONE).filter(([id]) => m.apps.has(id));
  const roleSum = new Map<string, number>();
  for (const [id, p] of apps) {
    for (const role of m.apps.get(id)?.roles ?? []) roleSum.set(role, (roleSum.get(role) ?? 0) + p);
  }
  const roles = [...roleSum.entries()].sort((a, b) => b[1] - a[1]);
  const [topApp, topAppP] = apps[0] ?? ["", 0];
  const [topRole, topRoleP] = roles[0] ?? ["", 0];
  const probOf = (id: string) => probs[id] ?? 0;
  const confidence = { app: topAppP, role: topRoleP };
  const fail = (reason: FailReason): AppJudgement => ({ kind: "fail", reason, confidence });

  /** 역할(들)에 속한 앱을 선호 → 기본 앱 → 확률 순으로 */
  const ordered = (roleIds: readonly string[], skip: string | undefined): AppCandidate[] => {
    const members = m.map.apps.filter(
      (a) => a.id !== skip && a.roles.some((r) => roleIds.includes(r)),
    );
    const rank = (appId: string): [number, CandidateBy] => {
      if (roleIds.some((r) => prefs[r] === appId)) return [0, "pref"];
      if (roleIds.some((r) => m.roles.get(r)?.defaultApp === appId)) return [1, "default"];
      return [2, "jev"];
    };
    return members
      .map((a) => ({ appId: a.id, rank: rank(a.id) }))
      .sort((a, b) => a.rank[0] - b.rank[0] || probOf(b.appId) - probOf(a.appId))
      .map(({ appId, rank: [, by] }) => ({ appId, by }));
  };
  const bestRoleOf = (appId: string): string => {
    const appRoles = m.apps.get(appId)?.roles ?? [];
    return appRoles.reduce(
      (best, r) => ((roleSum.get(r) ?? 0) > (roleSum.get(best) ?? 0) ? r : best),
      appRoles[0] ?? "",
    );
  };
  const result = (
    role: string,
    candidates: AppCandidate[],
    extra: { named?: boolean; exclusive?: boolean; mentionedApp?: string } = {},
  ): AppJudgement => ({
    kind: "candidates",
    role,
    named: extra.named ?? false,
    exclusive: extra.exclusive ?? extra.named ?? false,
    ...(extra.mentionedApp === undefined ? {} : { mentionedApp: extra.mentionedApp }),
    ask: m.roles.get(role)?.sensitive ?? false,
    candidates: candidates.slice(0, t.maxCandidates),
    confidence: { app: topAppP, role: roleSum.get(role) ?? 0 },
  });
  const isAppStore = (appId: string) => m.apps.get(appId)?.roles.includes(APPSTORE_ROLE) ?? false;

  // 1. '해당 없음'이 1등 앱 이상
  if (!topApp || probOf(NONE) >= topAppP) return fail("none");

  // 2. 말한 앱 (별칭). jev 확률은 "말했다"는 증거가 아니다
  const mention = findAppMention(m, utterance);
  if (mention.kind === "ambiguous") return fail("named_ambiguous");
  if (mention.kind === "map" || mention.kind === "other") {
    const mentioned = mention.kind === "map" ? mention.appId : undefined;
    if (mentioned !== undefined && topApp === mentioned) {
      return result(bestRoleOf(topApp), [{ appId: topApp, by: "named" }], { named: true });
    }
    // "배달의민족 깔아 줘": 앱 이름이 있어도 깔기·지우기면 Play 스토어
    if (isAppStore(topApp) && topAppP >= t.app) {
      return result(bestRoleOf(topApp), [{ appId: topApp, by: "named" }], {
        named: true,
        mentionedApp: mention.text,
      });
    }
    return fail(mention.kind === "map" ? "named_mismatch" : "unknown_app");
  }

  // 3. 두 역할이 비슷하면 하려는 일을 묻는다 (역할 확정보다 먼저)
  const second = roles[1];
  if (
    second &&
    topRoleP >= t.intentMin &&
    second[1] >= t.intentMin &&
    topRoleP - second[1] < t.intentGap
  ) {
    // 두 역할이 같은 1등 앱에서 나온 것이면(유튜브 = 영상·음악) 하려는 일은 갈리지 않았다 → 아래로
    const topRoles = m.apps.get(topApp)?.roles ?? [];
    if (!(topRoles.includes(topRole) && topRoles.includes(second[0]))) {
      return { kind: "ask_intent", roles: [topRole, second[0]], confidence: { role: topRoleP } };
    }
  }

  // 4. 1등 앱 → 그 앱 + 1등 앱의 모든 역할에서 같은 일을 하는 앱. 아주 확실하면 그 앱만
  if (topAppP >= t.exclusive) {
    return result(bestRoleOf(topApp), [{ appId: topApp, by: "jev" }], { exclusive: true });
  }
  if (topAppP >= t.app) {
    const appRoles = m.apps.get(topApp)?.roles ?? [];
    return result(bestRoleOf(topApp), [{ appId: topApp, by: "jev" }, ...ordered(appRoles, topApp)]);
  }
  // 5. 역할 합계
  if (topRoleP >= t.role) return result(topRole, ordered([topRole], undefined));
  // 두 역할이 같은 1등 앱에서 나온 경우 (위 3번에서 넘어옴)
  const topRoles = m.apps.get(topApp)?.roles ?? [];
  if (
    second &&
    topRoles.includes(topRole) &&
    topRoles.includes(second[0]) &&
    topRoleP >= t.intentMin
  ) {
    return result(bestRoleOf(topApp), [{ appId: topApp, by: "jev" }, ...ordered(topRoles, topApp)]);
  }
  return fail("low");
}

/** 다른 앱을 깔기·업데이트·지우는 역할 (3.4) */
export const APPSTORE_ROLE = "appstore";

export type GoalJudgement =
  | { kind: "goal"; key: string; confidence: number }
  | { kind: "ask"; keys: [string, string]; confidence: number }
  | { kind: "none"; confidence: number };

/** 2단계 판정 */
export function judgeGoal(probs: Record<string, number>): GoalJudgement {
  const t = ROUTE_THRESHOLDS;
  const all = sortDesc(probs);
  const [topKey, topP] = all[0] ?? [NONE, 0];
  const secondP = all[1]?.[1] ?? 0;
  if (topKey !== NONE && topP >= t.goal && topP - secondP >= t.goalMargin) {
    return { kind: "goal", key: topKey, confidence: topP };
  }
  const goals = sortDesc(probs, NONE);
  const a = goals[0];
  const b = goals[1];
  if (a && b && a[1] >= t.goalAskMin && b[1] >= t.goalAskMin && a[1] - b[1] < t.goalMargin) {
    return { kind: "ask", keys: [a[0], b[0]], confidence: a[1] };
  }
  return { kind: "none", confidence: topP };
}
