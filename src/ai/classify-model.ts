/**
 * #17 안전 분류 모델 호출 (Claude, guide 와 같은 모델·키).
 * 지침서 목표가 응답 4초라 모델 시간은 3.5초로 자른다. 실패는 { status } 로 돌려준다 (예외 아님).
 */
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { anthropicModel, getAnthropic } from "./anthropic.js";
import { classifyModelOutputSchema, type ClassifyModelOutput } from "./classify-schema.js";
import { CLASSIFY_SYSTEM_PROMPT } from "./prompts/classify.js";

export const CLASSIFY_MODEL_TIMEOUT_MS = 3_500;

export interface ClassifyModelInput {
  utterance: string;
  ruleLevel: string;
  ruleApp: string;
  signals: string[];
}

export type ClassifyModelResult =
  | { status: "ok"; output: ClassifyModelOutput; inputTokens: number; outputTokens: number }
  | { status: "refusal" | "invalid" | "error"; error?: unknown };

export type ClassifyModel = (input: ClassifyModelInput) => Promise<ClassifyModelResult>;

export const claudeClassifyModel: ClassifyModel = async (input) => {
  try {
    const client = await getAnthropic();
    const response = await client.messages.parse(
      {
        model: anthropicModel(),
        max_tokens: 300,
        thinking: { type: "between_tools" },
        output_config: { effort: "low", format: zodOutputFormat(classifyModelOutputSchema) },
        system: [
          { type: "text", text: CLASSIFY_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: `<request>\n${JSON.stringify(input)}\n</request>` }],
      },
      { timeout: CLASSIFY_MODEL_TIMEOUT_MS },
    );
    if (response.stop_reason === "refusal") return { status: "refusal" };
    if (response.stop_reason !== "end_turn" || response.parsed_output === null) {
      return { status: "invalid" };
    }
    return {
      status: "ok",
      output: response.parsed_output,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  } catch (error) {
    return { status: "error", error };
  }
};
