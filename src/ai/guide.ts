/**
 * #16 guide: 화면 요소 목록 → 다음 행동 하나 (docs/server-plan.md 5.3).
 *
 * 순서: 빈 화면·거부 규칙 → 마스킹 → 모델 호출 → 후처리 검증.
 * 모델이 실패·거절·시간 초과해도 앱이 그대로 읽을 수 있는 { type: "say" } 로 답한다.
 */
import type { GuideModelOutput, GuideRequest, GuideResponse } from "./guide-schema.js";
import { maskDeep, maskText } from "../shared/sensitive.js";
import type { Logger } from "../shared/logger.js";
import { GUIDE_PROMPT_VERSION } from "./prompts/guide.js";

export const SAY_MAX = 60;
export const CHIPS_MAX = 4;
export const CHIP_MAX = 30;

export const FALLBACK_SAY = {
  busy: "서버가 잠시 바빠요. 조금 뒤에 다시 말씀해 주세요.",
  unsure: "제가 화면을 잘 못 알아봤어요. 다시 말씀해 주시겠어요?",
  secret: "이 화면은 직접 입력해 주세요. 제가 대신 보지 않을게요.",
  empty: "지금 화면을 읽지 못했어요. 잠시 뒤에 다시 말씀해 주세요.",
} as const;

/** 모델에게 보내는 화면 요소: 위치를 화면 대비 % 로 바꾼 압축 형태. */
export interface PromptNode {
  i: number;
  t?: string;
  d?: string;
  c?: string;
  pos?: [number, number, number, number];
  /** 앱이 보낸 상태 중 true 인 것만 (clickable, editable, scrollable, checked, selected) */
  state?: string[];
}

export const NODE_STATES = ["clickable", "editable", "scrollable", "checked", "selected"] as const;
export const TARGET_TEXT_MAX = 100;

export interface GuidePromptInput {
  goal: string;
  utterance: string;
  slots: Record<string, string>;
  history: string[];
  screen: { pkg: string; nodes: PromptNode[] };
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type GuideModelResult =
  | { status: "ok"; output: GuideModelOutput; usage: ModelUsage; stopReason: string | null }
  | { status: "refusal" | "invalid"; usage: ModelUsage; stopReason: string | null };

export type GuideModel = (input: GuidePromptInput) => Promise<GuideModelResult>;

/**
 * 요청 하나를 처리한 과정 (디버그 뷰어용, dev 에서만 저장).
 * AI 에 보낸 입력과 모델의 원래 출력을 그대로 담는다 — 서버 후처리로 응답이 달라졌는지 보려고.
 */
export interface GuideTrace {
  promptVersion: string;
  /** 모델을 부르지 않은 이유 */
  skipped?: "empty-screen" | "secret-screen";
  /** AI 에 보낸 그대로 (마스킹 후, 위치 %·상태 포함) */
  input?: GuidePromptInput;
  masked?: number;
  status?: GuideModelResult["status"] | "error";
  stopReason?: string | null;
  /** 모델의 원래 출력 (후처리 전) */
  output?: GuideModelOutput;
  usage?: ModelUsage;
  latencyMs?: number;
  error?: string;
}

const SECRET_FIELD =
  /비밀\s?번호|패스워드|password|passcode|암호|인증\s?번호|OTP|보안\s?카드|CVC|CVV|PIN\b|핀\s?번호|주민\s?(등록)?\s?번호|생년월일\s?6자리/i;

/** 비밀번호·인증번호 입력 화면이면 화면을 모델에 보내지 않는다. */
export function isSecretScreen(request: GuideRequest): boolean {
  return request.screen.nodes.some((node) =>
    [node.t, node.d].some((text) => text !== undefined && SECRET_FIELD.test(text)),
  );
}

const shortClass = (name: string | undefined): string | undefined =>
  name === undefined ? undefined : name.slice(name.lastIndexOf(".") + 1);

const percent = (value: number, total: number): number =>
  Math.max(0, Math.min(100, Math.round((value / total) * 100)));

export function toPromptInput(request: GuideRequest): { input: GuidePromptInput; masked: number } {
  const { width, height } = request.screen;
  const nodes: PromptNode[] = request.screen.nodes.map((node) => {
    const out: PromptNode = { i: node.i };
    if (node.t) out.t = node.t;
    if (node.d) out.d = node.d;
    const cls = shortClass(node.c);
    if (cls) out.c = cls;
    if (node.b) {
      const [l, t, r, b] = node.b;
      out.pos = [percent(l, width), percent(t, height), percent(r, width), percent(b, height)];
    }
    const state = NODE_STATES.filter((name) => (node as Record<string, unknown>)[name] === true);
    if (state.length > 0) out.state = state;
    return out;
  });

  const { value, count } = maskDeep({
    goal: request.goal,
    utterance: request.utterance,
    slots: request.slots,
    history: request.history,
    screen: { pkg: request.screen.pkg, nodes },
  });
  return { input: value, masked: count };
}

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** 요소 번호 → 그 요소의 글자. 응답의 targetText 에 쓴다. */
export type NodeTexts = ReadonlyMap<number, string>;

type Bounds = readonly [number, number, number, number];

const ownText = (node: { t?: string | undefined; d?: string | undefined }): string =>
  (node.t ?? "").trim() || (node.d ?? "").trim();

/** inner 가 outer 영역 안에 들어 있는지 (경계 몇 px 오차 허용). */
const contains = (outer: Bounds, inner: Bounds, slack = 2): boolean =>
  inner[0] >= outer[0] - slack &&
  inner[1] >= outer[1] - slack &&
  inner[2] <= outer[2] + slack &&
  inner[3] <= outer[3] + slack;

/**
 * 요소의 글자: 자기 글자(t, 없으면 d). 없으면 **영역 안에 든 글자 요소** 중 위쪽·왼쪽 것.
 * 설정 화면의 한 줄처럼 눌리는 틀에는 글자가 없고 제목은 안쪽 요소에 있는 경우를 위한 것
 * (예: 틀 [13] 안의 "Display", "Dark theme, …" 중 "Display").
 */
export function nodeTexts(request: GuideRequest): Map<number, string> {
  const { nodes } = request.screen;
  const labeled = nodes
    .filter((node) => node.b !== undefined && ownText(node) !== "")
    .sort((a, b) => (a.b?.[1] ?? 0) - (b.b?.[1] ?? 0) || (a.b?.[0] ?? 0) - (b.b?.[0] ?? 0));

  return new Map(
    nodes.map((node) => {
      const own = ownText(node);
      if (own !== "" || node.b === undefined) return [node.i, own];
      const outer = node.b;
      const inner = labeled.find(
        (other) => other.i !== node.i && other.b !== undefined && contains(outer, other.b),
      );
      return [node.i, inner ? ownText(inner) : ""];
    }),
  );
}

const cleanText = (text: string | null | undefined): string | undefined => {
  const value = truncate(maskText((text ?? "").trim()).text, TARGET_TEXT_MAX);
  return value === "" ? undefined : value;
};

/** 모델 출력이 지금 화면과 규칙에 맞는지 확인한다. 맞지 않으면 say 로 낮춘다. */
export function finalize(
  requestId: number,
  output: GuideModelOutput,
  nodes: NodeTexts,
): GuideResponse {
  const say = truncate(maskText(output.say.trim()).text, SAY_MAX);
  const fallback: GuideResponse = { requestId, type: "say", say: FALLBACK_SAY.unsure };
  if (say === "") return fallback;
  const withTarget = (target: number) => {
    const targetText = cleanText(nodes.get(target));
    return targetText === undefined ? { target } : { target, targetText };
  };

  switch (output.type) {
    case "highlight":
      if (output.target === null || !nodes.has(output.target)) return fallback;
      return { requestId, type: "highlight", say, ...withTarget(output.target) };
    case "suggest": {
      if (output.target === null || !nodes.has(output.target)) return fallback;
      const chips = (output.chips ?? [])
        .map((chip) => truncate(maskText(chip.trim()).text, CHIP_MAX))
        .filter((chip) => chip !== "" && !chip.includes("***"))
        .slice(0, CHIPS_MAX);
      return { requestId, type: "suggest", say, ...withTarget(output.target), chips };
    }
    case "swipe": {
      if (output.dir === null) return fallback;
      const seekText = cleanText(output.seek);
      return { requestId, type: "swipe", say, dir: output.dir, ...(seekText ? { seekText } : {}) };
    }
    case "ask":
    case "say":
    case "done":
      return { requestId, type: output.type, say };
  }
}

export async function guide(
  request: GuideRequest,
  model: GuideModel,
  log: Logger,
  onTrace?: (trace: GuideTrace) => void,
): Promise<GuideResponse> {
  const { requestId } = request;
  const trace: GuideTrace = { promptVersion: GUIDE_PROMPT_VERSION };
  const say = (text: string): GuideResponse => {
    onTrace?.(trace);
    return { requestId, type: "say", say: text };
  };

  // 시스템 창(밝기 막대 등)만 떠 있거나 화면을 못 읽으면 노드가 0개다. 모델이 볼 것이 없으니 부르지 않는다.
  if (request.screen.nodes.length === 0) {
    log.info("guide skipped", { reason: "empty-screen", pkg: request.screen.pkg });
    trace.skipped = "empty-screen";
    return say(FALLBACK_SAY.empty);
  }

  if (isSecretScreen(request)) {
    log.info("guide skipped", { reason: "secret-screen", pkg: request.screen.pkg });
    trace.skipped = "secret-screen";
    return say(FALLBACK_SAY.secret);
  }

  const { input, masked } = toPromptInput(request);
  trace.input = input;
  trace.masked = masked;
  const started = Date.now();
  let result: GuideModelResult;
  try {
    result = await model(input);
  } catch (error) {
    log.warn("guide model failed", { error, latencyMs: Date.now() - started });
    trace.status = "error";
    trace.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    trace.latencyMs = Date.now() - started;
    return say(FALLBACK_SAY.busy);
  }

  trace.status = result.status;
  trace.stopReason = result.stopReason;
  trace.usage = result.usage;
  trace.latencyMs = Date.now() - started;
  if (result.status === "ok") trace.output = result.output;

  const response =
    result.status === "ok"
      ? finalize(requestId, result.output, nodeTexts(request))
      : say(FALLBACK_SAY.unsure);
  if (result.status === "ok") onTrace?.(trace);

  log.info("guide completed", {
    promptVersion: GUIDE_PROMPT_VERSION,
    goal: request.goal,
    pkg: request.screen.pkg,
    nodeCount: request.screen.nodes.length,
    masked,
    status: result.status,
    stopReason: result.stopReason,
    type: response.type,
    downgraded: result.status === "ok" && response.type !== result.output.type,
    latencyMs: Date.now() - started,
    ...result.usage,
  });
  return response;
}
