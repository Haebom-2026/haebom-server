/**
 * 명령 검토 모델 호출 (Claude Opus, docs/jev-routing-plan.md 7장).
 * 어르신을 기다리게 하지 않는 비동기 작업이라 시간을 넉넉히 준다. 실패는 { status } 로 (예외 아님).
 */
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getAnthropic } from "../ai/anthropic.js";
import { REVIEW_SYSTEM_PROMPT, reviewOutputSchema, type ReviewOutput } from "./prompt.js";

export const REVIEW_MODEL_TIMEOUT_MS = 90_000;
export const DEFAULT_REVIEW_MODEL = "claude-opus-5-5";

export type ReviewModelResult =
  | { status: "ok"; output: ReviewOutput; inputTokens: number; outputTokens: number }
  | { status: "refusal" | "invalid" | "error"; error?: unknown };

export type ReviewModel = (record: unknown) => Promise<ReviewModelResult>;

export const createClaudeReviewModel =
  (model: string = DEFAULT_REVIEW_MODEL): ReviewModel =>
  async (record) => {
    try {
      const client = await getAnthropic();
      const response = await client.messages.parse(
        {
          model,
          max_tokens: 4000,
          output_config: { effort: "medium", format: zodOutputFormat(reviewOutputSchema) },
          system: [
            { type: "text", text: REVIEW_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
          ],
          messages: [{ role: "user", content: `<record>\n${JSON.stringify(record)}\n</record>` }],
        },
        { timeout: REVIEW_MODEL_TIMEOUT_MS },
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
