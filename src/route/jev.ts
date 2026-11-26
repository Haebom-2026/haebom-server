/**
 * jev(고르기 전용 모델) 호출 — OpenRouter Decisions API (docs/jev-routing-plan.md 9장).
 *
 * /api/alpha/decisions 는 alpha 라 형식이 바뀔 수 있다 → 이 파일 한 곳에서만 부르고,
 * 응답을 zod 로 검증한다. 형식이 다르거나 시간이 넘으면 오류를 던지지 않고 { ok: false } 를
 * 돌려준다 → 부르는 쪽은 지금 흐름(Claude)으로 간다. 재시도는 하지 않는다.
 * 키와 보낸 글자는 로그에 남기지 않는다.
 */
import { z } from "zod";

export const JEV_URL = "https://openrouter.ai/api/alpha/decisions";
export const JEV_MODEL = "typesafe/jev-1.14";

export interface ChoiceQuestion {
  instructions: string;
  /** 후보 키 → 설명. '해당 없음'(none)을 넣는 것은 부르는 쪽 책임 */
  criteria: Record<string, string>;
}

export interface ChoiceAnswer {
  choice: string;
  /** 후보별 확률 (합 ≈ 1). 응답에 빠진 후보는 0 */
  probabilities: Record<string, number>;
}

export type JevResult =
  | {
      ok: true;
      answers: Record<string, ChoiceAnswer>;
      ms: number;
      cost: number;
      inputTokens: number;
    }
  | { ok: false; reason: "timeout" | "http" | "invalid" | "network"; status?: number; ms: number };

export interface JevClient {
  choose(
    state: string,
    questions: Record<string, ChoiceQuestion>,
    opts?: { timeoutMs?: number },
  ): Promise<JevResult>;
}

const answerSchema = z.object({
  choice: z.string(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
});

const responseSchema = z.object({
  answers: z.record(z.string(), answerSchema),
  usage: z
    .object({
      cost: z.number().optional(),
      input_tokens: z.number().optional(),
    })
    .optional(),
});

export interface JevClientOptions {
  apiKey: () => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
  /** 기본 타임아웃 (opts.timeoutMs 가 없을 때) */
  timeoutMs?: number;
  model?: string;
}

export function createJevClient(options: JevClientOptions): JevClient {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const model = options.model ?? JEV_MODEL;

  return {
    async choose(state, questions, opts) {
      const started = now();
      const timeoutMs = opts?.timeoutMs ?? options.timeoutMs ?? 1_500;
      const elapsed = () => now() - started;
      if (timeoutMs <= 0) return { ok: false, reason: "timeout", ms: 0 };

      const body = {
        model,
        state,
        questions: Object.fromEntries(
          Object.entries(questions).map(([key, q]) => [
            key,
            { type: "choice", instructions: q.instructions, criteria: q.criteria },
          ]),
        ),
      };

      let response: Response;
      try {
        const key = await options.apiKey();
        response = await doFetch(JEV_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut =
          error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        return { ok: false, reason: timedOut ? "timeout" : "network", ms: elapsed() };
      }
      if (!response.ok)
        return { ok: false, reason: "http", status: response.status, ms: elapsed() };

      let json: unknown;
      try {
        json = await response.json();
      } catch {
        return { ok: false, reason: "invalid", ms: elapsed() };
      }
      const parsed = responseSchema.safeParse(json);
      if (!parsed.success) return { ok: false, reason: "invalid", ms: elapsed() };

      const answers: Record<string, ChoiceAnswer> = {};
      for (const [key, question] of Object.entries(questions)) {
        const answer = parsed.data.answers[key];
        // 묻지 않은 후보를 고르거나 답이 빠지면 형식이 바뀐 것으로 본다
        if (!answer || !(answer.choice in question.criteria)) {
          return { ok: false, reason: "invalid", ms: elapsed() };
        }
        const probabilities: Record<string, number> = {};
        for (const option of Object.keys(question.criteria)) {
          probabilities[option] = answer.probabilities[option] ?? 0;
        }
        answers[key] = { choice: answer.choice, probabilities };
      }
      return {
        ok: true,
        answers,
        ms: elapsed(),
        cost: parsed.data.usage?.cost ?? 0,
        inputTokens: parsed.data.usage?.input_tokens ?? 0,
      };
    },
  };
}
