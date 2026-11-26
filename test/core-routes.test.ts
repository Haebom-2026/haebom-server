import { beforeEach, describe, expect, it } from "vitest";
import { createCoreRoutes } from "../src/core/routes.js";
import { createHttpHandler } from "../src/shared/handler.js";
import type { HttpEvent } from "../src/shared/http.js";
import { createLogger } from "../src/shared/logger.js";
import { createRouter } from "../src/shared/router.js";
import { memoryCoreStore, memoryIdempotencyStore } from "./core-memory-store.js";
import { httpEvent, lambdaContext, parseBody } from "./helpers.js";

const ELDER = "elder-1";
const GUARDIAN = "guardian-1";
const GUARDIAN2 = "guardian-2";

function setup(codes: string[] = ["123456", "654321", "111111", "222222"]) {
  const mem = memoryCoreStore();
  const idem = memoryIdempotencyStore();
  let clock = new Date("2026-11-26T06:00:00.000Z");
  const queue = [...codes];
  const handler = createHttpHandler(
    createRouter(
      createCoreRoutes({
        store: mem.store,
        idempotency: idem,
        now: () => clock,
        randomCode: () => queue.shift() ?? "999999",
      }),
    ),
    createLogger({}, { level: "error", write: () => undefined }),
  );

  async function call(
    method: string,
    path: string,
    uid: string | undefined,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const event: HttpEvent = httpEvent(method, path, uid);
    if (body !== undefined) event.body = JSON.stringify(body);
    event.headers = headers;
    const result = await handler(event, lambdaContext);
    return { status: result.statusCode, body: result.body ? parseBody(result.body) : undefined };
  }

  return {
    mem,
    idem,
    call,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

type Ctx = ReturnType<typeof setup>;

async function register(ctx: Ctx) {
  await ctx.call("POST", "/v1/users/me", ELDER, { role: "elder", name: "김순자" });
  await ctx.call("POST", "/v1/users/me", GUARDIAN, { role: "guardian", name: "김수연" });
  await ctx.call("POST", "/v1/users/me", GUARDIAN2, { role: "guardian", name: "이민호" });
}

async function linkWithCode(ctx: Ctx, guardian = GUARDIAN) {
  const code = await ctx.call("POST", "/v1/elder/connect-codes", ELDER);
  const { code: value } = code.body as { code: string };
  return ctx.call("POST", "/v1/guardian/links", guardian, {
    code: value,
    elderLabel: "어머니",
    guardianLabel: "큰딸",
  });
}

describe("#2·#3 users", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it("처음 등록은 201, 같은 role 로 다시 부르면 200 으로 기존 프로필", async () => {
    const first = await ctx.call("POST", "/v1/users/me", ELDER, { role: "elder", name: "김순자" });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ uid: ELDER, role: "elder", name: "김순자" });

    const again = await ctx.call("POST", "/v1/users/me", ELDER, {
      role: "elder",
      name: "다른 이름",
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ name: "김순자" });
  });

  it("다른 role 로 다시 등록하면 409 conflict", async () => {
    await ctx.call("POST", "/v1/users/me", ELDER, { role: "elder" });
    const res = await ctx.call("POST", "/v1/users/me", ELDER, { role: "guardian" });
    expect(res).toMatchObject({ status: 409, body: { error: { reason: "conflict" } } });
  });

  it("프로필 없이 다른 API 를 부르면 403 profile-required", async () => {
    const res = await ctx.call("GET", "/v1/elder/links", ELDER);
    expect(res).toMatchObject({ status: 403, body: { error: { reason: "profile-required" } } });
  });

  it("role 이 다르면 403 permission-denied", async () => {
    await register(ctx);
    const res = await ctx.call("POST", "/v1/elder/connect-codes", GUARDIAN);
    expect(res).toMatchObject({ status: 403, body: { error: { reason: "permission-denied" } } });
  });

  it("이름을 바꾸면 연결 목록의 이름도 바뀐다", async () => {
    await register(ctx);
    await linkWithCode(ctx);
    const res = await ctx.call("PATCH", "/v1/users/me", ELDER, { name: "김순자 할머니" });
    expect(res).toMatchObject({ status: 200, body: { name: "김순자 할머니" } });
    const links = await ctx.call("GET", "/v1/guardian/links", GUARDIAN);
    expect(links.body).toMatchObject({ links: [{ elderName: "김순자 할머니" }] });
  });

  it("잘못된 본문은 400 invalid-argument", async () => {
    const res = await ctx.call("POST", "/v1/users/me", ELDER, { role: "admin" });
    expect(res).toMatchObject({ status: 400, body: { error: { reason: "invalid-argument" } } });
  });
});

describe("#4·#5 devices", () => {
  it("등록·해제, 재설치로 uid 가 바뀌면 이전 uid 의 토큰을 지운다", async () => {
    const ctx = setup();
    await register(ctx);
    const put = await ctx.call("PUT", "/v1/devices/device-abc-123", ELDER, {
      fcmToken: "token-1",
      platform: "android",
    });
    expect(put.status).toBe(204);
    expect(await ctx.mem.store.listDevices(ELDER)).toHaveLength(1);

    await ctx.call("POST", "/v1/users/me", "elder-reinstalled", { role: "elder" });
    await ctx.call("PUT", "/v1/devices/device-abc-123", "elder-reinstalled", {
      fcmToken: "token-2",
      platform: "android",
    });
    expect(await ctx.mem.store.listDevices(ELDER)).toHaveLength(0);
    expect(await ctx.mem.store.listDevices("elder-reinstalled")).toHaveLength(1);

    const del = await ctx.call("DELETE", "/v1/devices/device-abc-123", "elder-reinstalled");
    expect(del.status).toBe(204);
    expect(await ctx.mem.store.listDevices("elder-reinstalled")).toHaveLength(0);
  });

  it("deviceId 형식이 틀리면 400", async () => {
    const ctx = setup();
    await register(ctx);
    const res = await ctx.call("PUT", "/v1/devices/bad id", ELDER, {
      fcmToken: "t",
      platform: "ios",
    });
    expect(res.status).toBe(400);
  });
});

describe("#11·#14 연결 코드로 연결", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = setup();
    await register(ctx);
  });

  it("코드 발급 → 연결 → 양쪽 목록에 호칭 두 필드가 나온다", async () => {
    const code = await ctx.call("POST", "/v1/elder/connect-codes", ELDER);
    expect(code).toMatchObject({
      status: 201,
      body: { code: "123456", expiresAt: "2026-11-26T06:10:00.000Z" },
    });

    const link = await ctx.call("POST", "/v1/guardian/links", GUARDIAN, {
      code: "123456",
      elderLabel: "어머니",
      guardianLabel: "큰딸",
    });
    expect(link).toMatchObject({
      status: 201,
      body: {
        elderId: ELDER,
        elderName: "김순자",
        elderLabel: "어머니",
        guardianLabel: "큰딸",
        connectedAt: "2026-11-26T06:00:00.000Z",
      },
    });

    const elderLinks = await ctx.call("GET", "/v1/elder/links", ELDER);
    expect(elderLinks.body).toEqual({
      links: [
        {
          guardianId: GUARDIAN,
          guardianName: "김수연",
          guardianLabel: "큰딸",
          elderLabel: "어머니",
          connectedAt: "2026-11-26T06:00:00.000Z",
        },
      ],
    });
    const guardianLinks = await ctx.call("GET", "/v1/guardian/links", GUARDIAN);
    expect(guardianLinks.body).toMatchObject({ links: [{ elderId: ELDER, elderLabel: "어머니" }] });
  });

  it("다대다: 같은 어르신에 보호자 둘", async () => {
    await linkWithCode(ctx, GUARDIAN);
    const second = await linkWithCode(ctx, GUARDIAN2);
    expect(second.status).toBe(201);
    const links = await ctx.call("GET", "/v1/elder/links", ELDER);
    expect((links.body as { links: unknown[] }).links).toHaveLength(2);
  });

  it("없는 코드는 404 invalid-code", async () => {
    const res = await ctx.call("POST", "/v1/guardian/links", GUARDIAN, { code: "000000" });
    expect(res).toMatchObject({ status: 404, body: { error: { reason: "invalid-code" } } });
  });

  it("10분이 지나면 409 code-expired", async () => {
    await ctx.call("POST", "/v1/elder/connect-codes", ELDER);
    ctx.advance(10 * 60_000 + 1);
    const res = await ctx.call("POST", "/v1/guardian/links", GUARDIAN, { code: "123456" });
    expect(res).toMatchObject({ status: 409, body: { error: { reason: "code-expired" } } });
  });

  it("이미 쓴 코드는 409 code-used", async () => {
    await linkWithCode(ctx, GUARDIAN);
    const res = await ctx.call("POST", "/v1/guardian/links", GUARDIAN2, { code: "123456" });
    expect(res).toMatchObject({ status: 409, body: { error: { reason: "code-used" } } });
  });

  it("새 코드를 받으면 이전 코드는 409 code-used", async () => {
    await ctx.call("POST", "/v1/elder/connect-codes", ELDER);
    await ctx.call("POST", "/v1/elder/connect-codes", ELDER);
    const old = await ctx.call("POST", "/v1/guardian/links", GUARDIAN, { code: "123456" });
    expect(old).toMatchObject({ status: 409, body: { error: { reason: "code-used" } } });
    const fresh = await ctx.call("POST", "/v1/guardian/links", GUARDIAN, { code: "654321" });
    expect(fresh.status).toBe(201);
  });

  it("이미 연결된 어르신은 409 already-linked (코드는 소모되지 않음)", async () => {
    await linkWithCode(ctx, GUARDIAN);
    await ctx.call("POST", "/v1/elder/connect-codes", ELDER);
    const res = await ctx.call("POST", "/v1/guardian/links", GUARDIAN, { code: "654321" });
    expect(res).toMatchObject({ status: 409, body: { error: { reason: "already-linked" } } });
    const other = await ctx.call("POST", "/v1/guardian/links", GUARDIAN2, { code: "654321" });
    expect(other.status).toBe(201);
  });

  it("10분에 5번 틀리면 429 too-many-attempts, 10분 뒤 풀린다", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await ctx.call("POST", "/v1/guardian/links", GUARDIAN, { code: "000000" });
      expect(res.status).toBe(404);
    }
    const locked = await ctx.call("POST", "/v1/guardian/links", GUARDIAN, { code: "000000" });
    expect(locked).toMatchObject({ status: 429, body: { error: { reason: "too-many-attempts" } } });

    const otherGuardian = await ctx.call("POST", "/v1/guardian/links", GUARDIAN2, {
      code: "000000",
    });
    expect(otherGuardian.status).toBe(404);

    ctx.advance(10 * 60_000);
    const later = await ctx.call("POST", "/v1/guardian/links", GUARDIAN, { code: "000000" });
    expect(later.status).toBe(404);
  });

  it("같은 번호가 아직 유효하면 다른 번호로 다시 뽑는다", async () => {
    const other = setup(["123456", "123456", "777777"]);
    await other.call("POST", "/v1/users/me", ELDER, { role: "elder" });
    await other.call("POST", "/v1/users/me", "elder-2", { role: "elder" });
    await other.call("POST", "/v1/elder/connect-codes", ELDER);
    const second = await other.call("POST", "/v1/elder/connect-codes", "elder-2");
    expect(second.body).toMatchObject({ code: "777777" });
  });

  it("Idempotency-Key 로 재시도하면 첫 성공 응답을 그대로 돌려준다", async () => {
    await ctx.call("POST", "/v1/elder/connect-codes", ELDER);
    const headers = { "idempotency-key": "retry-key-0001" };
    const body = { code: "123456", elderLabel: "어머니", guardianLabel: "큰딸" };
    const first = await ctx.call("POST", "/v1/guardian/links", GUARDIAN, body, headers);
    const retry = await ctx.call("POST", "/v1/guardian/links", GUARDIAN, body, headers);
    expect(first.status).toBe(201);
    expect(retry).toEqual(first);

    const without = await ctx.call("POST", "/v1/guardian/links", GUARDIAN, body);
    expect(without).toMatchObject({ status: 409 });
  });

  it("같은 Idempotency-Key 로 다른 요청을 보내면 400", async () => {
    const headers = { "idempotency-key": "retry-key-0002" };
    await ctx.call("POST", "/v1/guardian/links", GUARDIAN, { code: "000000" }, headers);
    const res = await ctx.call("POST", "/v1/guardian/links", GUARDIAN, { code: "111111" }, headers);
    expect(res).toMatchObject({ status: 400, body: { error: { reason: "invalid-argument" } } });
  });
});

describe("#12·#15 해제", () => {
  it("어르신·보호자 어느 쪽에서든 해제, 없는 연결은 404", async () => {
    const ctx = setup();
    await register(ctx);
    await linkWithCode(ctx, GUARDIAN);
    await linkWithCode(ctx, GUARDIAN2);

    expect((await ctx.call("DELETE", `/v1/elder/links/${GUARDIAN}`, ELDER)).status).toBe(204);
    expect((await ctx.call("DELETE", `/v1/guardian/links/${ELDER}`, GUARDIAN2)).status).toBe(204);
    expect((await ctx.call("GET", "/v1/elder/links", ELDER)).body).toEqual({ links: [] });

    const again = await ctx.call("DELETE", `/v1/elder/links/${GUARDIAN}`, ELDER);
    expect(again).toMatchObject({ status: 404, body: { error: { reason: "not-found" } } });
  });
});

describe("호칭 변경", () => {
  it("보호자는 어르신 호칭을, 어르신은 보호자 호칭을 바꾼다. 양쪽 목록에 반영", async () => {
    const ctx = setup();
    await register(ctx);
    await linkWithCode(ctx, GUARDIAN);

    const g = await ctx.call("PATCH", `/v1/guardian/links/${ELDER}`, GUARDIAN, {
      elderLabel: "엄마",
    });
    expect(g).toMatchObject({
      status: 200,
      body: { elderId: ELDER, elderLabel: "엄마", guardianLabel: "큰딸" },
    });

    const e = await ctx.call("PATCH", `/v1/elder/links/${GUARDIAN}`, ELDER, {
      guardianLabel: "수연이",
    });
    expect(e).toMatchObject({
      status: 200,
      body: { guardianId: GUARDIAN, guardianLabel: "수연이", elderLabel: "엄마" },
    });

    const list = (await ctx.call("GET", "/v1/guardian/links", GUARDIAN)).body as {
      links: { elderLabel: string; guardianLabel: string }[];
    };
    expect(list.links[0]).toMatchObject({ elderLabel: "엄마", guardianLabel: "수연이" });
  });

  it("빈 문자열은 호칭 지우기, 둘 다 없으면 400, 연결이 없으면 404, 역할이 다르면 403", async () => {
    const ctx = setup();
    await register(ctx);
    await linkWithCode(ctx, GUARDIAN);

    const cleared = await ctx.call("PATCH", `/v1/guardian/links/${ELDER}`, GUARDIAN, {
      elderLabel: "",
    });
    expect(cleared.body).toMatchObject({ elderLabel: "" });
    expect((await ctx.call("PATCH", `/v1/guardian/links/${ELDER}`, GUARDIAN, {})).status).toBe(400);
    expect(
      (
        await ctx.call("PATCH", `/v1/guardian/links/${ELDER}`, GUARDIAN, {
          elderLabel: "가".repeat(21),
        })
      ).status,
    ).toBe(400);
    expect(
      (await ctx.call("PATCH", `/v1/guardian/links/${ELDER}`, GUARDIAN2, { elderLabel: "엄마" }))
        .body,
    ).toMatchObject({ error: { reason: "not-found" } });
    expect(
      (await ctx.call("PATCH", `/v1/elder/links/${GUARDIAN}`, GUARDIAN, { guardianLabel: "x" }))
        .status,
    ).toBe(403);
  });
});
