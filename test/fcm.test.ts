import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFcmSender, signJwt } from "../src/push/fcm.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const account = {
  client_email: "sa@example.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  token_uri: "https://oauth2.example.com/token",
  project_id: "demo-project",
};

describe("signJwt", () => {
  it("RS256 서명이 공개키로 검증된다", () => {
    const jwt = signJwt(account, 1_000);
    const [header, claims, signature] = jwt.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, signature ?? "", "base64url")).toBe(true);
    expect(JSON.parse(Buffer.from(claims ?? "", "base64url").toString())).toMatchObject({
      iss: account.client_email,
      aud: account.token_uri,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      exp: 4_600,
    });
  });
});

describe("createFcmSender", () => {
  function fakeFetch(sendStatus: number, sendBody = "{}") {
    const calls: { url: string; body: string }[] = [];
    const fn = (url: string, init?: RequestInit) => {
      calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      if (url === account.token_uri) {
        return Promise.resolve(Response.json({ access_token: "oauth-token", expires_in: 3600 }));
      }
      return Promise.resolve(new Response(sendBody, { status: sendStatus }));
    };
    return { fn: fn as unknown as typeof fetch, calls };
  }

  it("OAuth 토큰은 한 번 받아 재사용하고, v1 API 로 data 를 보낸다", async () => {
    const fake = fakeFetch(200);
    const sender = createFcmSender({
      loadServiceAccount: () => Promise.resolve(JSON.stringify(account)),
      projectId: "copilot-demo-c9a74",
      fetchFn: fake.fn,
    });
    expect(await sender.send({ token: "t1", data: { kind: "link" } })).toBe("sent");
    expect(await sender.send({ token: "t2", data: { kind: "link" } })).toBe("sent");

    const oauthCalls = fake.calls.filter((c) => c.url === account.token_uri);
    expect(oauthCalls).toHaveLength(1);
    const send = fake.calls.find((c) => c.url.includes("messages:send"));
    expect(send?.url).toBe(
      "https://fcm.googleapis.com/v1/projects/copilot-demo-c9a74/messages:send",
    );
    expect(JSON.parse(send?.body ?? "{}")).toMatchObject({
      message: { token: "t1", data: { kind: "link" }, android: { priority: "HIGH" } },
    });
  });

  it("404 UNREGISTERED 는 unregistered, 5xx 는 throw", async () => {
    const gone = createFcmSender({
      loadServiceAccount: () => Promise.resolve(JSON.stringify(account)),
      fetchFn: fakeFetch(
        404,
        '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}',
      ).fn,
    });
    expect(await gone.send({ token: "t", data: {} })).toBe("unregistered");

    const down = createFcmSender({
      loadServiceAccount: () => Promise.resolve(JSON.stringify(account)),
      fetchFn: fakeFetch(503).fn,
    });
    await expect(down.send({ token: "t", data: {} })).rejects.toThrow("FCM send failed: 503");
  });
});
