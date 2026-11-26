import { beforeEach, describe, expect, it } from "vitest";
import {
  createApprovalRoutes,
  expireDue,
  handleApprovalUnlink,
} from "../src/core/approval-routes.js";
import { createCoreRoutes } from "../src/core/routes.js";
import { createExpireHandler } from "../src/functions/expire/index.js";
import { createHttpHandler } from "../src/shared/handler.js";
import type { HttpEvent } from "../src/shared/http.js";
import { createLogger } from "../src/shared/logger.js";
import { createRouter } from "../src/shared/router.js";
import {
  memoryApprovalStore,
  memoryCoreStore,
  memoryIdempotencyStore,
} from "./core-memory-store.js";
import { httpEvent, lambdaContext, parseBody } from "./helpers.js";

const ELDER = "elder-1";
const G1 = "guardian-1";
const G2 = "guardian-2";
const quiet = createLogger({}, { level: "error", write: () => undefined });

const gov24 = {
  packageName: "kr.go.minwon.m",
  appName: "정부24",
  action: "guide_gov24_auth",
  category: "public",
};

function setup() {
  const core = memoryCoreStore();
  const appr = memoryApprovalStore();
  const idem = memoryIdempotencyStore();
  let clock = new Date("2026-11-26T06:00:00.000Z");
  const now = () => clock;
  const codes = ["111111", "222222", "333333", "444444"];
  const handler = createHttpHandler(
    createRouter([
      ...createCoreRoutes({
        store: core.store,
        idempotency: idem,
        now,
        randomCode: () => codes.shift() ?? "999999",
        onUnlink: (eid, gid) => handleApprovalUnlink(appr.store, eid, gid, now()),
      }),
      ...createApprovalRoutes({ store: core.store, approvals: appr.store, idempotency: idem, now }),
    ]),
    quiet,
  );

  async function call(
    method: string,
    path: string,
    uid: string,
    body?: unknown,
    options: { headers?: Record<string, string>; query?: Record<string, string> } = {},
  ) {
    const event: HttpEvent = httpEvent(method, path, uid);
    if (body !== undefined) event.body = JSON.stringify(body);
    event.headers = options.headers ?? {};
    if (options.query) event.queryStringParameters = options.query;
    const result = await handler(event, lambdaContext);
    return {
      status: result.statusCode,
      body: (result.body ? parseBody(result.body) : undefined) as Record<string, unknown>,
    };
  }

  async function link(guardian: string, guardianLabel: string) {
    const code = await call("POST", "/v1/elder/connect-codes", ELDER);
    await call("POST", "/v1/guardian/links", guardian, {
      code: code.body.code,
      elderLabel: "어머니",
      guardianLabel,
    });
  }

  return {
    appr,
    call,
    link,
    now,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    async register() {
      await call("POST", "/v1/users/me", ELDER, { role: "elder", name: "김순자" });
      await call("POST", "/v1/users/me", G1, { role: "guardian", name: "김수연" });
      await call("POST", "/v1/users/me", G2, { role: "guardian", name: "이민호" });
    },
  };
}

type Ctx = ReturnType<typeof setup>;
type List = { items: Record<string, unknown>[]; nextCursor?: string; serverTime: string };

async function request(ctx: Ctx, body: object = gov24) {
  const res = await ctx.call("POST", "/v1/elder/approvals", ELDER, body);
  return String(res.body.approvalId);
}

describe("#9 승인 요청", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = setup();
    await ctx.register();
  });

  it("연결된 보호자가 없으면 no_guardians", async () => {
    const res = await ctx.call("POST", "/v1/elder/approvals", ELDER, gov24);
    expect(res).toEqual({ status: 200, body: { result: "no_guardians" } });
  });

  it("201 + 5분 뒤 만료, 보호자마다 대기 중 목록에 보인다", async () => {
    await ctx.link(G1, "큰딸");
    await ctx.link(G2, "사위");
    const res = await ctx.call("POST", "/v1/elder/approvals", ELDER, gov24);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ result: "created", expiresAt: "2026-11-26T06:05:00.000Z" });

    const list = (
      await ctx.call("GET", "/v1/guardian/approvals", G1, undefined, {
        query: { status: "pending" },
      })
    ).body as unknown as List;
    expect(list.items).toEqual([
      {
        id: res.body.approvalId,
        elderId: ELDER,
        elderName: "김순자",
        elderLabel: "어머니",
        status: "pending",
        action: "guide_gov24_auth",
        packageName: "kr.go.minwon.m",
        appName: "정부24",
        category: "public",
        createdAt: "2026-11-26T06:00:00.000Z",
        expiresAt: "2026-11-26T06:05:00.000Z",
        updatedAt: "2026-11-26T06:00:00.000Z",
      },
    ]);
    const detail = await ctx.call(
      "GET",
      `/v1/guardian/approvals/${String(res.body.approvalId)}`,
      G2,
    );
    expect(detail.body).toMatchObject({ status: "pending", elderLabel: "어머니" });
  });

  it("같은 action 이 대기 중이면 기존 요청을 돌려주고, 다른 action 은 새로 만든다", async () => {
    await ctx.link(G1, "큰딸");
    const first = await request(ctx);
    const again = await ctx.call("POST", "/v1/elder/approvals", ELDER, gov24);
    expect(again).toMatchObject({ status: 200, body: { result: "existing", approvalId: first } });

    const other = await ctx.call("POST", "/v1/elder/approvals", ELDER, {
      ...gov24,
      action: "guide_unknown_app",
    });
    expect(other.status).toBe(201);
  });

  it("action 형식이 틀리면 400, 보호자가 부르면 403", async () => {
    await ctx.link(G1, "큰딸");
    const bad = await ctx.call("POST", "/v1/elder/approvals", ELDER, {
      ...gov24,
      action: "transfer",
    });
    expect(bad.status).toBe(400);
    expect((await ctx.call("POST", "/v1/elder/approvals", G1, gov24)).status).toBe(403);
  });
});

describe("#13 응답, #19 결과 조회", () => {
  let ctx: Ctx;
  let id: string;
  beforeEach(async () => {
    ctx = setup();
    await ctx.register();
    await ctx.link(G1, "큰딸");
    await ctx.link(G2, "사위");
    id = await request(ctx);
    ctx.advance(30_000);
  });

  it("승인하면 어르신은 누가(호칭) 허락했는지 받는다", async () => {
    const res = await ctx.call("POST", `/v1/guardian/approvals/${id}/respond`, G1, {
      decision: "approved",
    });
    expect(res).toMatchObject({
      status: 200,
      body: {
        status: "approved",
        respondedBy: G1,
        respondedByLabel: "큰딸",
        respondedAt: "2026-11-26T06:00:30.000Z",
      },
    });
    const elder = await ctx.call("GET", `/v1/elder/approvals/${id}`, ELDER);
    expect(elder.body).toMatchObject({
      status: "approved",
      respondedBy: G1,
      respondedByLabel: "큰딸",
    });

    // 다른 보호자의 목록에도 반영된다
    const g2 = await ctx.call("GET", `/v1/guardian/approvals/${id}`, G2);
    expect(g2.body).toMatchObject({ status: "approved", respondedByLabel: "큰딸" });
  });

  it("첫 응답만 반영: 나중 응답은 409 already-responded", async () => {
    await ctx.call("POST", `/v1/guardian/approvals/${id}/respond`, G2, { decision: "rejected" });
    const late = await ctx.call("POST", `/v1/guardian/approvals/${id}/respond`, G1, {
      decision: "approved",
    });
    expect(late).toMatchObject({ status: 409, body: { error: { reason: "already-responded" } } });
    expect((await ctx.call("GET", `/v1/elder/approvals/${id}`, ELDER)).body).toMatchObject({
      status: "rejected",
      respondedByLabel: "사위",
    });
  });

  it("같은 Idempotency-Key 재시도는 첫 응답을 그대로", async () => {
    const headers = { "idempotency-key": "respond-key-0001" };
    const first = await ctx.call(
      "POST",
      `/v1/guardian/approvals/${id}/respond`,
      G1,
      { decision: "approved" },
      { headers },
    );
    const retry = await ctx.call(
      "POST",
      `/v1/guardian/approvals/${id}/respond`,
      G1,
      { decision: "approved" },
      { headers },
    );
    expect(retry).toEqual(first);
  });

  it("5분이 지나면 expired: 조회하면 바로 만료로 보이고 응답은 409 approval-expired", async () => {
    ctx.advance(5 * 60_000);
    expect((await ctx.call("GET", `/v1/elder/approvals/${id}`, ELDER)).body).toMatchObject({
      status: "expired",
    });
    expect(ctx.appr.originals.get(id)?.status).toBe("expired");
    const late = await ctx.call("POST", `/v1/guardian/approvals/${id}/respond`, G1, {
      decision: "approved",
    });
    expect(late).toMatchObject({ status: 409, body: { error: { reason: "approval-expired" } } });

    // 잠금이 풀려 같은 action 으로 새 요청을 할 수 있다
    expect((await ctx.call("POST", "/v1/elder/approvals", ELDER, gov24)).status).toBe(201);
  });

  it("연결되지 않은 보호자는 404", async () => {
    await ctx.call("POST", "/v1/users/me", "stranger", { role: "guardian" });
    const res = await ctx.call("POST", `/v1/guardian/approvals/${id}/respond`, "stranger", {
      decision: "approved",
    });
    expect(res.status).toBe(404);
    expect((await ctx.call("GET", `/v1/elder/approvals/${id}`, "other-elder")).status).toBe(403);
  });
});

describe("#10 취소", () => {
  it("대기 중이면 cancelled, 다시 취소하거나 응답하면 409 approval-cancelled, 남의 요청은 404", async () => {
    const ctx = setup();
    await ctx.register();
    await ctx.link(G1, "큰딸");
    const id = await request(ctx);

    const res = await ctx.call("POST", `/v1/elder/approvals/${id}/cancel`, ELDER);
    expect(res).toMatchObject({ status: 200, body: { status: "cancelled" } });
    const again = await ctx.call("POST", `/v1/elder/approvals/${id}/cancel`, ELDER);
    expect(again).toMatchObject({ status: 409, body: { error: { reason: "approval-cancelled" } } });
    const respond = await ctx.call("POST", `/v1/guardian/approvals/${id}/respond`, G1, {
      decision: "approved",
    });
    expect(respond).toMatchObject({
      status: 409,
      body: { error: { reason: "approval-cancelled" } },
    });

    await ctx.call("POST", "/v1/users/me", "elder-2", { role: "elder" });
    expect((await ctx.call("POST", `/v1/elder/approvals/${id}/cancel`, "elder-2")).status).toBe(
      404,
    );
  });
});

describe("연결 해제", () => {
  it("보호자 한 명이 해제하면 그 보호자에게서만 사라지고, 모두 해제되면 자동 취소", async () => {
    const ctx = setup();
    await ctx.register();
    await ctx.link(G1, "큰딸");
    await ctx.link(G2, "사위");
    const id = await request(ctx);

    await ctx.call("DELETE", `/v1/guardian/links/${ELDER}`, G2);
    expect(
      ((await ctx.call("GET", "/v1/guardian/approvals", G2)).body as unknown as List).items,
    ).toEqual([]);
    expect(ctx.appr.originals.get(id)).toMatchObject({ status: "pending", guardianIds: [G1] });
    const unlinked = await ctx.call("POST", `/v1/guardian/approvals/${id}/respond`, G2, {
      decision: "approved",
    });
    expect(unlinked.status).toBe(404);

    await ctx.call("DELETE", `/v1/elder/links/${G1}`, ELDER);
    expect((await ctx.call("GET", `/v1/elder/approvals/${id}`, ELDER)).body).toMatchObject({
      status: "cancelled",
    });
  });
});

describe("#23 목록", () => {
  it("all 은 지난 요청 포함, since 는 그 뒤에 바뀐 것만", async () => {
    const ctx = setup();
    await ctx.register();
    await ctx.link(G1, "큰딸");
    const first = await request(ctx);
    ctx.advance(1000);
    await ctx.call("POST", `/v1/guardian/approvals/${first}/respond`, G1, { decision: "approved" });
    ctx.advance(1000);
    const mark = (await ctx.call("GET", "/v1/guardian/approvals", G1)).body as unknown as List;
    expect(mark.items.map((i) => i.status)).toEqual(["approved"]);

    ctx.advance(1000);
    await request(ctx, { ...gov24, action: "guide_bank_open" });
    const pending = (
      await ctx.call("GET", "/v1/guardian/approvals", G1, undefined, {
        query: { status: "pending" },
      })
    ).body as unknown as List;
    expect(pending.items.map((i) => i.action)).toEqual(["guide_bank_open"]);
    const changed = (
      await ctx.call("GET", "/v1/guardian/approvals", G1, undefined, {
        query: { since: mark.serverTime },
      })
    ).body as unknown as List;
    expect(changed.items.map((i) => i.action)).toEqual(["guide_bank_open"]);
  });
});

describe("expire-fn", () => {
  it("응답 시간이 지난 대기 중 승인만 expired 로 바꾸고 잠금을 푼다", async () => {
    const ctx = setup();
    await ctx.register();
    await ctx.link(G1, "큰딸");
    const old = await request(ctx);
    ctx.advance(4 * 60_000);
    const fresh = await request(ctx, { ...gov24, action: "guide_bank_open" });
    ctx.advance(60_000 + 1);

    expect(await expireDue(ctx.appr.store, ctx.now(), quiet)).toBe(1);
    expect(ctx.appr.originals.get(old)?.status).toBe("expired");
    expect(ctx.appr.originals.get(fresh)?.status).toBe("pending");
    expect(ctx.appr.locks.has(`${ELDER}|guide_gov24_auth`)).toBe(false);

    const handler = createExpireHandler(() => ctx.appr.store, ctx.now);
    await expect(handler({ time: "" } as never)).resolves.toEqual({ expired: 0 });
  });
});
