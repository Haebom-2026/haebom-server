import { describe, expect, it } from "vitest";
import { handler as aiHandler } from "../src/functions/ai/index.js";
import { handler as apiHandler } from "../src/functions/api/index.js";
import { createHttpHandler } from "../src/shared/handler.js";
import { createLogger } from "../src/shared/logger.js";
import { createRouter } from "../src/shared/router.js";
import { httpEvent, lambdaContext, parseBody } from "./helpers.js";

describe("api-fn", () => {
  it("GET /v1/healthz 는 인증 없이 200", async () => {
    const result = await apiHandler(httpEvent("GET", "/v1/healthz"), lambdaContext);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result.body)).toMatchObject({ status: "ok" });
  });

  it("없는 경로는 404 not-found", async () => {
    const result = await apiHandler(httpEvent("GET", "/v1/nope", "uid-1"), lambdaContext);
    expect(result.statusCode).toBe(404);
    expect(parseBody(result.body)).toMatchObject({ error: { reason: "not-found" } });
  });
});

describe("ai-fn", () => {
  it("인증 정보가 없으면 401 unauthenticated", async () => {
    const result = await aiHandler(httpEvent("POST", "/v1/elder/classify"), lambdaContext);
    expect(result.statusCode).toBe(401);
    expect(parseBody(result.body)).toMatchObject({ error: { reason: "unauthenticated" } });
  });

  it("인증되면 아직 501 not-implemented", async () => {
    const result = await aiHandler(httpEvent("POST", "/v1/elder/guide", "uid-1"), lambdaContext);
    expect(result.statusCode).toBe(501);
  });
});

describe("createHttpHandler", () => {
  it("예상 못 한 오류는 내부 메시지를 숨기고 500 internal", async () => {
    const lines: string[] = [];
    const logger = createLogger({}, { write: (line) => lines.push(line) });
    const router = createRouter([
      {
        method: "GET",
        path: "/boom",
        handler: () => Promise.reject(new Error("secret detail")),
      },
    ]);

    const result = await createHttpHandler(router, logger)(
      httpEvent("GET", "/boom"),
      lambdaContext,
    );

    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain("secret detail");
    expect(parseBody(result.body)).toMatchObject({ error: { reason: "internal" } });
    expect(lines.some((line) => line.includes("secret detail"))).toBe(true);
  });
});
