/**
 * guide 모델 호출 (Claude Sonnet 5.5, Anthropic API).
 *
 * - 구조화 출력(zodOutputFormat)으로 응답 모양을 강제한다.
 * - thinking 은 끈다 (Sonnet 5.5 는 disabled 가 400 이라 between_tools), effort low: 9초 목표.
 * - 시스템 프롬프트는 바이트가 매번 같아 프롬프트 캐싱이 된다.
 * - 서버 측 fallback(fallbacks: "default")은 쓰지 않는다: Sonnet 5.5 에서 cyber·frontier_llm
 *   거절만 재시도해 이 서비스에 효과가 없다. 거절은 say 로 안전하게 처리한다.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { anthropicModel, getAnthropic } from "./anthropic.js";
import type { GuideModel, ModelUsage } from "./guide.js";
import { guideModelOutputSchema } from "./guide-schema.js";
import { GUIDE_SYSTEM_PROMPT } from "./prompts/guide.js";

/** Lambda 타임아웃(12초) 안에서 키 로딩·후처리 여유를 남긴다. */
export const GUIDE_MODEL_TIMEOUT_MS = 8_500;

const usageOf = (usage: Anthropic.Usage): ModelUsage => ({
  inputTokens: usage.input_tokens,
  outputTokens: usage.output_tokens,
  cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
});

export const claudeGuideModel: GuideModel = async (input) => {
  const client = await getAnthropic();
  const response = await client.messages.parse(
    {
      model: anthropicModel(),
      max_tokens: 1024,
      thinking: { type: "between_tools" },
      output_config: { effort: "low", format: zodOutputFormat(guideModelOutputSchema) },
      system: [{ type: "text", text: GUIDE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `<request>\n${JSON.stringify(input)}\n</request>` }],
    },
    { timeout: GUIDE_MODEL_TIMEOUT_MS },
  );

  const usage = usageOf(response.usage);
  const stopReason = response.stop_reason;
  if (stopReason === "refusal") return { status: "refusal", usage, stopReason };
  if (stopReason !== "end_turn" || response.parsed_output === null) {
    return { status: "invalid", usage, stopReason };
  }
  return { status: "ok", output: response.parsed_output, usage, stopReason };
};
