/**
 * Anthropic 클라이언트. API 키는 Secrets Manager 에서 콜드 스타트 때 한 번 읽어 메모리에 둔다
 * (환경 변수에는 비밀 이름만 있다, docs/server-plan.md 11.4).
 */
import Anthropic from "@anthropic-ai/sdk";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { requireEnv } from "../shared/config.js";

let clientPromise: Promise<Anthropic> | undefined;

async function loadApiKey(): Promise<string> {
  const secrets = new SecretsManagerClient({});
  const result = await secrets.send(
    new GetSecretValueCommand({ SecretId: requireEnv("ANTHROPIC_SECRET_ID") }),
  );
  const key = result.SecretString?.trim();
  if (!key) throw new Error("Anthropic API key secret is empty");
  return key;
}

export function getAnthropic(): Promise<Anthropic> {
  // 실패하면 다음 요청에서 다시 읽도록 캐시를 비운다.
  clientPromise ??= loadApiKey()
    .then((apiKey) => new Anthropic({ apiKey, maxRetries: 0 }))
    .catch((error: unknown) => {
      clientPromise = undefined;
      throw error;
    });
  return clientPromise;
}

export const anthropicModel = (): string => requireEnv("ANTHROPIC_MODEL");
