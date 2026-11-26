import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/**
 * Secrets Manager 값을 읽어 Lambda 컨테이너 수명 동안 메모리에 둔다.
 * 값은 로그에 남기지 않는다.
 */
export function createSecretLoader(
  secretId: string,
  client: SecretsManagerClient = new SecretsManagerClient({}),
): () => Promise<string> {
  let cached: Promise<string> | undefined;
  return () => {
    cached ??= client.send(new GetSecretValueCommand({ SecretId: secretId })).then((out) => {
      if (out.SecretString === undefined || out.SecretString === "") {
        throw new Error(`Secret ${secretId} has no value`);
      }
      return out.SecretString;
    });
    // 실패하면 다음 호출에서 다시 시도한다.
    cached.catch(() => {
      cached = undefined;
    });
    return cached;
  };
}
