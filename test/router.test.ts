import { describe, expect, it } from "vitest";
import { json } from "../src/shared/http.js";
import { createRouter, type RouteHandler } from "../src/shared/router.js";

const ok: RouteHandler = () => Promise.resolve(json(200, {}));

describe("createRouter", () => {
  const router = createRouter([
    { method: "GET", path: "/v1/healthz", handler: ok },
    { method: "POST", path: "/v1/elder/approvals/{id}/cancel", handler: ok },
  ]);

  it("정적 경로를 찾는다", () => {
    expect(router.match("GET", "/v1/healthz")).toBeDefined();
    expect(router.match("get", "/v1/healthz/")).toBeDefined();
  });

  it("경로 변수를 꺼낸다", () => {
    expect(router.match("POST", "/v1/elder/approvals/a_789/cancel")?.params).toEqual({
      id: "a_789",
    });
  });

  it("메서드나 경로가 다르면 찾지 않는다", () => {
    expect(router.match("POST", "/v1/healthz")).toBeUndefined();
    expect(router.match("POST", "/v1/elder/approvals/cancel")).toBeUndefined();
    expect(router.match("GET", "/v1/unknown")).toBeUndefined();
  });
});
