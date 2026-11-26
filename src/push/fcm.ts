/**
 * FCM HTTP v1 발송 (firebase-admin 없이).
 * 서비스 계정 JSON 으로 JWT 를 서명해 OAuth 토큰을 받고, 만료 1분 전까지 재사용한다.
 */
import { createSign } from "node:crypto";

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
  project_id: string;
}

export interface FcmMessage {
  token: string;
  /** FCM data 는 문자열 값만 받는다. */
  data: Record<string, string>;
}

/** sent: 보냄 / unregistered: 토큰이 더 이상 유효하지 않음 (기기 항목을 지운다) */
export type SendResult = "sent" | "unregistered";

export interface FcmSender {
  /** 일시 오류(네트워크·5xx·429)는 throw → 호출자가 재시도 */
  send(message: FcmMessage): Promise<SendResult>;
}

export interface FcmOptions {
  loadServiceAccount: () => Promise<string>;
  /** 없으면 서비스 계정의 project_id */
  projectId?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

const base64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");

export function signJwt(account: ServiceAccount, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: account.token_uri,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(account.private_key, "base64url")}`;
}

function parseAccount(raw: string): ServiceAccount {
  const value = JSON.parse(raw) as Partial<ServiceAccount>;
  if (!value.client_email || !value.private_key || !value.token_uri || !value.project_id) {
    throw new Error("FCM service account JSON is missing required fields");
  }
  return value as ServiceAccount;
}

/** FCM v1 오류 응답에서 등록 토큰이 무효인지 판단 */
function isUnregistered(status: number, body: string): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  return body.includes("UNREGISTERED") || body.includes("registration token");
}

export function createFcmSender(options: FcmOptions): FcmSender {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => Date.now());
  let account: ServiceAccount | undefined;
  let token: { value: string; expiresAt: number } | undefined;

  async function accessToken(): Promise<{ value: string; projectId: string }> {
    account ??= parseAccount(await options.loadServiceAccount());
    const projectId = options.projectId ?? account.project_id;
    if (token !== undefined && token.expiresAt - 60_000 > now())
      return { value: token.value, projectId };

    const assertion = signJwt(account, Math.floor(now() / 1000));
    const res = await fetchFn(account.token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    if (!res.ok) throw new Error(`FCM OAuth token request failed: ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("FCM OAuth token response has no access_token");
    token = { value: body.access_token, expiresAt: now() + (body.expires_in ?? 3600) * 1000 };
    return { value: token.value, projectId };
  }

  return {
    async send(message) {
      const auth = await accessToken();
      const res = await fetchFn(
        `https://fcm.googleapis.com/v1/projects/${auth.projectId}/messages:send`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${auth.value}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            message: {
              token: message.token,
              data: message.data,
              android: { priority: "HIGH" },
              // iOS 백그라운드 data 메시지 (APNs 키가 등록된 경우에만 전달됨)
              apns: {
                headers: { "apns-priority": "5" },
                payload: { aps: { "content-available": 1 } },
              },
            },
          }),
        },
      );
      if (res.ok) return "sent";
      const text = await res.text();
      if (res.status === 401) token = undefined;
      if (isUnregistered(res.status, text)) return "unregistered";
      throw new Error(`FCM send failed: ${res.status} ${text.slice(0, 200)}`);
    },
  };
}
