/**
 * #16 guide: 화면 요소 목록 → 다음 행동 하나 (docs/server-plan.md 5.3).
 *
 * 순서: 거부 규칙 → 마스킹 → 모델 호출 → 후처리 검증.
 * 모델이 실패·거절·시간 초과해도 앱이 그대로 읽을 수 있는 { type: "say" } 로 답한다.
 */
import type { GuideModelOutput, GuideRequest, GuideResponse } from "./guide-schema.js";
import { maskDeep, maskText } from "../shared/sensitive.js";
import type { Logger } from "../shared/logger.js";

export const SAY_MAX = 60;
export const CHIPS_MAX = 4;
export const CHIP_MAX = 30;

export const FALLBACK_SAY = {
  busy: "서버가 잠시 바빠요. 조금 뒤에 다시 말씀해 주세요.",
  unsure: "제가 화면을 잘 못 알아봤어요. 다시 말씀해 주시겠어요?",
  secret: "이 화면은 직접 입력해 주세요. 제가 대신 보지 않을게요.",
  bank: "은행 일은 화면을 보지 않고 안내해 드려요. 직접 확인해 주세요.",
} as const;

/** 모델에게 보내는 화면 요소: 위치를 화면 대비 % 로 바꾼 압축 형태. */
export interface PromptNode {
  i: number;
  t?: string;
  d?: string;
  c?: string;
  pos?: [number, number, number, number];
}

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

const SECRET_FIELD = /비밀\s?번호|패스워드|password|인증\s?번호|OTP|보안\s?카드|CVC|CVV/i;

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

/** 모델 출력이 지금 화면과 규칙에 맞는지 확인한다. 맞지 않으면 say 로 낮춘다. */
export function finalize(
  requestId: number,
  output: GuideModelOutput,
  nodeIds: ReadonlySet<number>,
): GuideResponse {
  const say = truncate(maskText(output.say.trim()).text, SAY_MAX);
  const fallback: GuideResponse = { requestId, type: "say", say: FALLBACK_SAY.unsure };
  if (say === "") return fallback;

  switch (output.type) {
    case "highlight":
      if (output.target === null || !nodeIds.has(output.target)) return fallback;
      return { requestId, type: "highlight", say, target: output.target };
    case "suggest": {
      if (output.target === null || !nodeIds.has(output.target)) return fallback;
      const chips = (output.chips ?? [])
        .map((chip) => truncate(maskText(chip.trim()).text, CHIP_MAX))
        .filter((chip) => chip !== "" && !chip.includes("***"))
        .slice(0, CHIPS_MAX);
      return { requestId, type: "suggest", say, target: output.target, chips };
    }
    case "swipe":
      if (output.dir === null) return fallback;
      return { requestId, type: "swipe", say, dir: output.dir };
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
): Promise<GuideResponse> {
  const { requestId } = request;
  const say = (text: string): GuideResponse => ({ requestId, type: "say", say: text });

  if (request.goal.toUpperCase() === "BANK") {
    log.info("guide skipped", { reason: "bank-goal" });
    return say(FALLBACK_SAY.bank);
  }
  if (isSecretScreen(request)) {
    log.info("guide skipped", { reason: "secret-screen", pkg: request.screen.pkg });
    return say(FALLBACK_SAY.secret);
  }

  const { input, masked } = toPromptInput(request);
  const started = Date.now();
  let result: GuideModelResult;
  try {
    result = await model(input);
  } catch (error) {
    log.warn("guide model failed", { error, latencyMs: Date.now() - started });
    return say(FALLBACK_SAY.busy);
  }

  const nodeIds = new Set(request.screen.nodes.map((node) => node.i));
  const response =
    result.status === "ok" ? finalize(requestId, result.output, nodeIds) : say(FALLBACK_SAY.unsure);

  log.info("guide completed", {
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
