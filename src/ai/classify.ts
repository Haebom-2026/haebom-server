/**
 * #17 classify: 명령 한 번 → 안전 분류 + (켜져 있으면) jev 앱·목표 고르기.
 * docs/server-plan.md 5.2, docs/jev-routing-plan.md 5.1·5.2, docs/api/s4-classify.md.
 *
 * 단계 계산 (finalLevel, 모든 경로가 같은 함수를 씀):
 *   기본 = max(규칙, 안전 분류)  — 안전 분류가 실패하면 규칙만 (degraded)
 *   + 검증된 목표 단계 (올리기만, candidate 목표는 안 씀, degraded 면 안 씀)
 *   + 상황 신호가 있으면 한 단계, scam 이면 L3
 * 명령 단계는 내려가지 않는다: 재시도·질문 답·앱 선택은 max(저장된 단계, 다시 계산한 단계).
 * route 는 안전 분류가 성공했고 scam 이 아니고 최종 단계가 L3 가 아닐 때만 싣는다.
 * 응답은 언제나 **저장된(합친) 명령 상태**로 만든다 (재시도가 저장과 다른 답을 주지 않게).
 */
import { randomUUID } from "node:crypto";
import { LEVELS, type Category, type Level } from "../core/notifications.js";
import type {
  CommandPatch,
  CommandRecord,
  CommandStore,
  RemovableField,
} from "../route/command-store.js";
import type { RouteSelection, RouteSelector } from "../route/select.js";
import { ApiError } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import { maskText } from "../shared/sensitive.js";
import type {
  ChooseAppRequest,
  ClassifyRequest,
  ClassifyResponse,
  RouteOut,
  Signal,
} from "./classify-schema.js";
import type { ClassifyModel } from "./classify-model.js";
import { CLASSIFY_PROMPT_VERSION } from "./prompts/classify.js";

export const REASON_MAX = 40;
const STORE_ATTEMPTS = 3;

const rank = (level: Level) => LEVELS.indexOf(level);
export const maxLevel = (...levels: Level[]): Level =>
  levels.reduce((a, b) => (rank(b) > rank(a) ? b : a), "L0");
const bump = (level: Level): Level => LEVELS[Math.min(rank(level) + 1, 3)] ?? "L3";

/** 최종 단계. classify·재시도·질문 답·앱 선택이 모두 이 함수로 계산한다 */
export function finalLevel(
  base: Level,
  signalCount: number,
  category: Category,
  goalLevels: readonly Level[],
): Level {
  let level = maxLevel(base, ...goalLevels);
  if (signalCount > 0) level = bump(level);
  if (category === "scam") level = "L3";
  return level;
}

const routeAllowed = (r: Pick<CommandRecord, "degraded" | "category" | "level">) =>
  !r.degraded && r.category !== "scam" && r.level !== "L3";

export interface ClassifyDeps {
  model: ClassifyModel;
  /** 없으면 jev 라우팅 꺼짐 (ROUTE_ENABLED) */
  selector?: RouteSelector | undefined;
  commands: CommandStore;
  log: Logger;
  now?: () => Date;
}

/** 후보 중 검증된 목표들의 단계 (올리는 데만 씀) */
function verifiedGoalLevels(selection: RouteSelection | undefined): Level[] {
  if (selection?.kind !== "route") return [];
  return selection.candidates.flatMap((c) => (c.goal?.verified ? [c.goal.level] : []));
}

function toRouteOut(selection: Extract<RouteSelection, { kind: "route" }>): RouteOut {
  return {
    mapVersion: selection.mapVersion,
    role: selection.role,
    named: selection.named,
    exclusive: selection.exclusive,
    ...(selection.mentionedApp === undefined ? {} : { mentionedApp: selection.mentionedApp }),
    ask: selection.ask,
    candidates: selection.candidates.map((c) => ({
      appId: c.appId,
      name: c.name,
      packages: c.packages,
      by: c.by,
      level: c.level,
      ...(c.goal
        ? {
            goal: {
              id: c.goal.id,
              version: c.goal.version,
              name: c.goal.name,
              level: c.goal.level,
              slots: c.goal.slots,
              verified: c.goal.verified,
            },
          }
        : {}),
      ...(c.clarify ? { clarify: c.clarify } : {}),
    })),
  };
}

const CATEGORY_RANK: Record<Category, number> = {
  none: 0,
  public: 1,
  device: 2,
  privacy: 2,
  identity: 3,
  finance: 3,
  scam: 9,
};

/** 저장된 명령의 검증된 목표 단계: 후보의 목표 + 고른 목표 (질문 답으로 고른 것 포함) */
function storedGoalLevels(record: CommandRecord): Level[] {
  const levels: Level[] = [];
  for (const c of record.route?.candidates ?? []) {
    if (c.goal?.verified) levels.push(c.goal.level);
    if (c.appId === record.chosenApp) {
      const picked = c.clarify?.options.find((o) => o.id === record.chosenGoal);
      if (picked?.verified && picked.level) levels.push(picked.level);
    }
  }
  return levels;
}

/**
 * 살아 있는 명령에 같은 번호로 classify 가 다시 옴 = 재시도. 저장된 상태와 합친다.
 * 단계·분류는 높은 쪽, 신호는 합집합, 고른 앱·처리한 답·후보는 그대로 둔다.
 */
function mergeRetry(
  stored: CommandRecord,
  fresh: CommandRecord,
  freshGoalLevels: readonly Level[],
): { patch: CommandPatch; remove: RemovableField[]; merged: CommandRecord } {
  const signals = [...new Set([...stored.signals, ...fresh.signals])] as Signal[];
  const category =
    CATEGORY_RANK[fresh.category] > CATEGORY_RANK[stored.category]
      ? fresh.category
      : stored.category;
  const degraded = stored.degraded && fresh.degraded;
  const baseLevel = maxLevel(stored.baseLevel, fresh.baseLevel);
  const level = maxLevel(
    stored.level,
    // 새 신호가 저장된 목표에도 적용되도록 저장된 검증 목표 단계도 함께 계산
    finalLevel(
      baseLevel,
      signals.length,
      category,
      degraded ? [] : [...freshGoalLevels, ...storedGoalLevels(stored)],
    ),
  );
  const reason = category === fresh.category && !fresh.degraded ? fresh.reason : stored.reason;
  const base = { ...stored, baseLevel, signals, category, degraded, level, reason };

  const remove: RemovableField[] = [];
  const patch: CommandPatch = { baseLevel, signals, category, degraded, level, reason };
  const untouched =
    stored.route === undefined &&
    stored.clarify === undefined &&
    stored.chosenApp === undefined &&
    stored.intentAnswer === undefined;
  let route = stored.route;
  let clarify = stored.clarify;
  if (!routeAllowed(base)) {
    // 사기 의심·멈춤·degraded 면 후보와 질문을 지운다
    if (route) remove.push("route");
    if (clarify) remove.push("clarify");
    route = undefined;
    clarify = undefined;
  } else if (untouched) {
    // 처음 시도가 후보를 못 냈으면(예: 안전 분류 실패) 이번 결과를 쓴다
    route = fresh.route;
    clarify = fresh.clarify;
    if (route) patch.route = route;
    if (clarify) patch.clarify = clarify;
  }
  const merged: CommandRecord = { ...base, rev: stored.rev + 1 };
  if (route) merged.route = route;
  else delete merged.route;
  if (clarify) merged.clarify = clarify;
  else delete merged.clarify;
  return { patch, remove, merged };
}

export async function classify(
  uid: string,
  request: ClassifyRequest,
  deps: ClassifyDeps,
): Promise<ClassifyResponse> {
  const started = Date.now();
  const masked = maskText(request.utterance).text;
  const ruleApp = maskText(request.ruleApp).text;

  const [safety, selection] = await Promise.all([
    deps.model({
      utterance: masked,
      ruleLevel: request.ruleLevel,
      ruleApp,
      signals: request.signals,
    }),
    deps.selector
      ? deps.selector.select({ utterance: masked }).catch((error: unknown) => {
          deps.log.warn("route select failed", { error });
          return undefined;
        })
      : Promise.resolve(undefined),
  ]);

  const ok = safety.status === "ok" ? safety.output : undefined;
  const degraded = ok === undefined;
  const baseLevel = maxLevel(request.ruleLevel, ok?.level ?? "L0");
  const category = ok?.category ?? "none";
  const goalLevels = degraded ? [] : verifiedGoalLevels(selection);
  const level = finalLevel(baseLevel, request.signals.length, category, goalLevels);
  const fresh: CommandRecord = {
    uid,
    commandId: request.commandId,
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
    gen: randomUUID(),
    rev: 0,
    maskedUtterance: masked,
    baseLevel,
    signals: request.signals,
    category,
    degraded,
    level,
    reason: ok ? maskText(ok.reason.trim()).text.slice(0, REASON_MAX) : "ai-unavailable",
  };
  if (routeAllowed(fresh)) {
    if (selection?.kind === "route") fresh.route = toRouteOut(selection);
    if (selection?.kind === "ask_intent") fresh.clarify = selection.clarify;
  }

  // 저장: 처음이면 만들고, 살아 있는 명령이 있으면 재시도로 합친다. 실패해도 응답은 막지 않는다
  // 저장: 처음이면 만들고, 살아 있는 명령이 있으면 재시도로 합친다.
  // 저장(또는 합치기)이 끝나지 않으면 503: 이미 저장된 scam·L3 보다 낮은 결과를 200 으로 주지 않기 위해.
  // 서버 실패 때 앱은 규칙 결과로 진행한다 (지침서 4.6)
  let state: CommandRecord | undefined;
  let saved = "failed";
  let firstGen: string | undefined;
  try {
    for (let attempt = 0; attempt < STORE_ATTEMPTS && !state; attempt++) {
      if ((await deps.commands.create(fresh)) === "created") {
        state = fresh;
        saved = "created";
        break;
      }
      const stored = await deps.commands.get(uid, request.commandId);
      if (!stored) continue;
      // 재시도 중 명령이 바뀌면(하루가 지나 같은 번호로 새로 만들어짐) 합치지 않는다
      firstGen ??= stored.gen;
      if (stored.gen !== firstGen) break;
      const { patch, remove, merged } = mergeRetry(stored, fresh, goalLevels);
      if ((await deps.commands.update(uid, request.commandId, stored, patch, remove)) === "ok") {
        state = merged;
        saved = "merged";
      }
    }
  } catch (error) {
    deps.log.error("command save failed", { error });
  }
  if (!state) {
    deps.log.error("classify not saved", { commandId: request.commandId, safety: safety.status });
    throw new ApiError("unavailable", "잠시 뒤 다시 시도해 주세요");
  }

  const response: ClassifyResponse = {
    commandId: request.commandId,
    intent: ok?.intent ?? "UNKNOWN",
    app: ok ? (ok.app?.trim() ? maskText(ok.app.trim()).text.slice(0, 40) : null) : ruleApp || null,
    sensitivity: {
      level: state.level,
      category: state.category,
      reason: state.reason,
      signals: state.signals,
    },
    ...(state.degraded ? { degraded: true as const } : {}),
    ...(routeAllowed(state) && state.route ? { route: state.route } : {}),
    ...(routeAllowed(state) && state.clarify ? { clarify: state.clarify } : {}),
  };

  deps.log.info("classify", {
    prompt: CLASSIFY_PROMPT_VERSION,
    commandId: request.commandId,
    safety: safety.status,
    ruleLevel: request.ruleLevel,
    llmLevel: ok?.level,
    level: state.level,
    category: state.category,
    signals: state.signals.length,
    route: selection?.kind ?? "off",
    routeReason: selection?.kind === "fail" ? selection.reason : undefined,
    candidates: response.route?.candidates.map((c) => c.appId),
    mapVersion: selection?.mapVersion,
    routeMs: selection?.ms,
    routeCost: selection?.cost,
    saved,
    ms: Date.now() - started,
  });
  return response;
}

export interface ChooseAppResponse {
  commandId: number;
  /** 하려는 일 질문에 답했을 때: 그 역할로 다시 매긴 후보 */
  route?: RouteOut;
  appId?: string;
  goal?: { id: string; name: string };
  sensitivity: { level: Level };
}

/** 명령의 기본 정보로 단계를 다시 계산 (내려가지 않게 지금 단계와 max) */
const recompute = (record: CommandRecord, goalLevels: readonly Level[]): Level =>
  maxLevel(
    record.level,
    finalLevel(
      record.baseLevel,
      record.signals.length,
      record.category,
      record.degraded ? [] : goalLevels,
    ),
  );

function chosenResponse(record: CommandRecord, commandId: number): ChooseAppResponse {
  const candidate = record.route?.candidates.find((c) => c.appId === record.chosenApp);
  const goalName =
    candidate?.goal?.id === record.chosenGoal
      ? candidate?.goal?.name
      : candidate?.clarify?.options.find((o) => o.id === record.chosenGoal)?.name;
  return {
    commandId,
    ...(record.chosenApp ? { appId: record.chosenApp } : {}),
    ...(record.chosenGoal && goalName ? { goal: { id: record.chosenGoal, name: goalName } } : {}),
    sensitivity: { level: record.level },
  };
}

const notFound = () => new ApiError("not-found", "명령이 없거나 지났습니다");
const changed = () => new ApiError("conflict", "명령이 바뀌었습니다. 다시 시도해 주세요");

/**
 * 앱 선택 API (docs/jev-routing-plan.md 5.2): 폰이 고른 후보를 명령에 고정, 질문 답 받기.
 * 같은 요청의 재전송은 저장된 결과를 그대로 돌려준다.
 */
export async function chooseApp(
  uid: string,
  commandId: number,
  body: ChooseAppRequest,
  deps: Pick<ClassifyDeps, "selector" | "commands" | "log">,
  /** 동시 쓰기와 부딪혀 한 번 다시 읽어 처리할 때: 처음 읽은 명령의 gen (다른 명령이면 409) */
  retryOf?: string,
): Promise<ChooseAppResponse> {
  const record = await deps.commands.get(uid, commandId);
  if (!record) throw notFound();
  if (retryOf !== undefined && record.gen !== retryOf) throw changed();
  /**
   * 조건부 쓰기 충돌: 같은 명령(gen)을 한 번만 다시 읽어 처음부터 판단한다.
   * (같은 앱·같은 답이면 저장된 결과, 앱만 먼저 저장됐으면 이 답을 반영, 다른 답이면 409)
   */
  const onConflict = (): Promise<ChooseAppResponse> => {
    if (retryOf !== undefined) throw changed();
    return chooseApp(uid, commandId, body, deps, record.gen);
  };

  // 하려는 일 질문의 답 → 그 역할로 후보를 다시 매김
  if (body.answer?.questionId === "intent") {
    const option = body.answer.option;
    if (record.intentAnswer !== undefined) {
      if (record.intentAnswer !== option) {
        throw new ApiError("conflict", "이미 다른 답으로 처리했습니다");
      }
      return {
        commandId,
        ...(routeAllowed(record) && record.route ? { route: record.route } : {}),
        sensitivity: { level: record.level },
      };
    }
    if (!record.clarify?.options.some((o) => o.id === option)) {
      throw new ApiError("invalid-argument", "열려 있는 질문의 선택지가 아닙니다");
    }
    if (!deps.selector) throw new ApiError("unavailable", "앱 고르기가 꺼져 있습니다");
    const selection = await deps.selector.select({
      utterance: record.maskedUtterance,
      role: option,
    });
    // jev 가 일시적으로 실패하면 답을 확정하지 않는다 (질문을 남겨 두고 앱이 다시 시도)
    if (selection.kind === "fail" && selection.reason.startsWith("jev_")) {
      throw new ApiError("unavailable", "잠시 뒤 다시 시도해 주세요");
    }
    const level = recompute(record, verifiedGoalLevels(selection));
    const route =
      selection.kind === "route" &&
      routeAllowed({ degraded: record.degraded, category: record.category, level })
        ? toRouteOut(selection)
        : undefined;
    const result = await deps.commands.update(
      uid,
      commandId,
      record,
      { intentAnswer: option, level, ...(route ? { route } : {}) },
      route ? ["clarify"] : ["clarify", "route"],
    );
    if (result === "missing") throw notFound();
    if (result === "conflict") return onConflict();
    deps.log.info("command intent answered", { commandId, role: option, level, route: !!route });
    return { commandId, ...(route ? { route } : {}), sensitivity: { level } };
  }

  const appId = body.appId;
  if (appId === undefined) throw new ApiError("invalid-argument", "appId 가 필요합니다");

  // 이미 고름: 같은 앱이면 저장된 그대로(지금 단계로), 다른 앱이면 409.
  // 후보보다 먼저 본다 — 재시도로 scam 이 되어 후보가 지워져도 같은 앱 재전송은 200
  if (record.chosenApp !== undefined) {
    if (record.chosenApp !== appId) {
      throw new ApiError("conflict", "이 명령은 이미 다른 앱을 골랐습니다");
    }
    // 앱만 먼저 고르고 목표 질문의 답을 나중에 보냄 → 그 답을 반영 (단계도 다시 계산)
    const chosen = record.route?.candidates.find((c) => c.appId === appId);
    if (body.answer && record.chosenGoal === undefined && chosen?.clarify) {
      if (body.answer.questionId !== chosen.clarify.questionId) {
        throw new ApiError("invalid-argument", "이 후보의 질문이 아닙니다");
      }
      const picked = chosen.clarify.options.find((o) => o.id === body.answer?.option);
      if (!picked) throw new ApiError("invalid-argument", "질문의 선택지가 아닙니다");
      const level = recompute(record, picked.verified && picked.level ? [picked.level] : []);
      const result = await deps.commands.update(uid, commandId, record, {
        chosenGoal: picked.id,
        level,
      });
      if (result === "missing") throw notFound();
      if (result === "conflict") return onConflict();
      deps.log.info("command goal answered", { commandId, appId, goal: picked.id, level });
      return {
        commandId,
        appId,
        goal: { id: picked.id, name: picked.name },
        sensitivity: { level },
      };
    }
    if (
      body.answer &&
      record.chosenGoal !== undefined &&
      body.answer.option !== record.chosenGoal
    ) {
      throw new ApiError("conflict", "이미 다른 답으로 처리했습니다");
    }
    return chosenResponse(record, commandId);
  }

  const candidate = record.route?.candidates.find((c) => c.appId === appId);
  if (!candidate) throw new ApiError("invalid-argument", "이 명령의 후보 앱이 아닙니다");

  let goal: { id: string; name: string; level: Level; verified: boolean } | undefined =
    candidate.goal;
  if (body.answer) {
    if (!candidate.clarify || body.answer.questionId !== candidate.clarify.questionId) {
      throw new ApiError("invalid-argument", "이 후보의 질문이 아닙니다");
    }
    const picked = candidate.clarify.options.find((o) => o.id === body.answer?.option);
    if (!picked) throw new ApiError("invalid-argument", "질문의 선택지가 아닙니다");
    goal = {
      id: picked.id,
      name: picked.name,
      level: picked.level ?? "L0",
      verified: picked.verified ?? false,
    };
  }

  // 고른 목표가 검증된 것이면 그 단계로 올린다 (낮추지 않음, candidate 목표는 안 씀)
  const level = recompute(record, goal?.verified ? [goal.level] : []);
  const result = await deps.commands.update(uid, commandId, record, {
    chosenApp: candidate.appId,
    ...(goal ? { chosenGoal: goal.id } : {}),
    askedUser: body.askedUser,
    level,
  });
  if (result === "missing") throw notFound();
  if (result === "conflict") return onConflict();

  deps.log.info("command app chosen", {
    commandId,
    appId: candidate.appId,
    goal: goal?.id,
    installState: body.installState,
    askedUser: body.askedUser,
    level,
    raised: level !== record.level,
  });
  return {
    commandId,
    appId: candidate.appId,
    ...(goal ? { goal: { id: goal.id, name: goal.name } } : {}),
    sensitivity: { level },
  };
}
