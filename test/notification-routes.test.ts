import { beforeEach, describe, expect, it } from "vitest";
import { createNotificationRoutes } from "../src/core/notification-routes.js";
import { createCoreRoutes } from "../src/core/routes.js";
import { createHttpHandler } from "../src/shared/handler.js";
import type { HttpEvent } from "../src/shared/http.js";
import { createLogger } from "../src/shared/logger.js";
import { createRouter } from "../src/shared/router.js";
import {
  memoryCoreStore,
  memoryIdempotencyStore,
  memoryNotificationStore,
} from "./core-memory-store.js";
import { httpEvent, lambdaContext, parseBody } from "./helpers.js";

const ELDER = "elder-1";
const G1 = "guardian-1";
const G2 = "guardian-2";

function setup() {
  const core = memoryCoreStore();
  const noti = memoryNotificationStore();
  const idem = memoryIdempotencyStore();
  let clock = new Date("2026-11-26T06:00:00.000Z");
  const now = () => clock;
  const codes = ["111111", "222222", "333333"];
  const handler = createHttpHandler(
    createRouter([
      ...createCoreRoutes({
        store: core.store,
        idempotency: idem,
        now,
        randomCode: () => codes.shift() ?? "999999",
        onUnlink: async (eid, gid) => {
          await noti.store.deleteInboxForElder(gid, eid);
        },
      }),
      ...createNotificationRoutes({
        store: core.store,
        notifications: noti.store,
        idempotency: idem,
        now,
      }),
    ]),
    createLogger({}, { level: "error", write: () => undefined }),
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
    return { status: result.statusCode, body: result.body ? parseBody(result.body) : undefined };
  }

  async function link(guardian: string, elderLabel: string) {
    const code = await call("POST", "/v1/elder/connect-codes", ELDER);
    await call("POST", "/v1/guardian/links", guardian, {
      code: (code.body as { code: string }).code,
      elderLabel,
      guardianLabel: "딸",
    });
  }

  return {
    noti,
    call,
    link,
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
type Items = { items: Record<string, unknown>[]; nextCursor?: string; serverTime: string };

const toss = {
  packageName: "viva.republica.toss",
  appName: "토스",
  level: "L1",
  category: "finance",
  reason: "은행 앱 열기",
};

describe("#6 민감 앱 알림", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = setup();
    await ctx.register();
  });

  it("연결된 보호자가 없으면 no_guardians, 아무것도 저장하지 않는다", async () => {
    const res = await ctx.call("POST", "/v1/elder/sensitive-entries", ELDER, toss);
    expect(res).toEqual({ status: 200, body: { result: "no_guardians" } });
    expect(ctx.noti.originals).toHaveLength(0);
  });

  it("보호자마다 알림함에 들어가고, 각자의 호칭으로 보인다", async () => {
    await ctx.link(G1, "어머니");
    await ctx.link(G2, "장모님");
    const res = await ctx.call("POST", "/v1/elder/sensitive-entries", ELDER, toss);
    expect(res).toMatchObject({ status: 201, body: { result: "created", guardianCount: 2 } });

    const g1 = (await ctx.call("GET", "/v1/guardian/notifications", G1)).body as Items;
    expect(g1.items).toEqual([
      {
        id: (res.body as { notificationId: string }).notificationId,
        elderId: ELDER,
        elderName: "김순자",
        elderLabel: "어머니",
        type: "sensitive_entry",
        packageName: "viva.republica.toss",
        appName: "토스",
        level: "L1",
        category: "finance",
        reason: "은행 앱 열기",
        createdAt: "2026-11-26T06:00:00.000Z",
        readAt: null,
      },
    ]);
    const g2 = (await ctx.call("GET", "/v1/guardian/notifications", G2)).body as Items;
    expect(g2.items[0]).toMatchObject({ elderLabel: "장모님" });
  });

  it("같은 앱은 10분에 한 번, 다른 앱은 따로", async () => {
    await ctx.link(G1, "어머니");
    await ctx.call("POST", "/v1/elder/sensitive-entries", ELDER, toss);
    const again = await ctx.call("POST", "/v1/elder/sensitive-entries", ELDER, toss);
    expect(again).toEqual({ status: 200, body: { result: "duplicate_suppressed" } });

    const other = await ctx.call("POST", "/v1/elder/sensitive-entries", ELDER, {
      ...toss,
      packageName: "kr.go.minwon.m",
      appName: "정부24",
      category: "public",
    });
    expect(other.status).toBe(201);

    ctx.advance(10 * 60_000 + 1);
    expect((await ctx.call("POST", "/v1/elder/sensitive-entries", ELDER, toss)).status).toBe(201);
  });

  it("이유·앱 이름의 숫자 개인정보는 가린다", async () => {
    await ctx.link(G1, "어머니");
    await ctx.call("POST", "/v1/elder/sensitive-entries", ELDER, {
      ...toss,
      reason: "50,000원 송금",
    });
    const list = (await ctx.call("GET", "/v1/guardian/notifications", G1)).body as Items;
    expect(list.items[0]?.reason).toBe("*** 송금");
  });

  it("보호자는 부를 수 없다 (403), 본문이 틀리면 400", async () => {
    expect((await ctx.call("POST", "/v1/elder/sensitive-entries", G1, toss)).status).toBe(403);
    const bad = await ctx.call("POST", "/v1/elder/sensitive-entries", ELDER, { appName: "토스" });
    expect(bad).toMatchObject({ status: 400, body: { error: { reason: "invalid-argument" } } });
  });

  it("Idempotency-Key 로 재시도해도 알림은 하나", async () => {
    await ctx.link(G1, "어머니");
    const headers = { "idempotency-key": "noti-retry-0001" };
    const first = await ctx.call("POST", "/v1/elder/sensitive-entries", ELDER, toss, { headers });
    const retry = await ctx.call("POST", "/v1/elder/sensitive-entries", ELDER, toss, { headers });
    expect(retry).toEqual(first);
    expect(ctx.noti.originals).toHaveLength(1);
  });
});

describe("#7 막힘, #8 SOS", () => {
  it("중복 방지 없이 매번 보내고, scam 이면 L3 로 남긴다", async () => {
    const ctx = setup();
    await ctx.register();
    await ctx.link(G1, "어머니");

    expect(
      (
        await ctx.call("POST", "/v1/elder/stuck", ELDER, {
          packageName: "kr.go.minwon.m",
          appName: "정부24",
        })
      ).status,
    ).toBe(201);
    ctx.advance(1);
    expect((await ctx.call("POST", "/v1/elder/stuck", ELDER, {})).status).toBe(201);
    ctx.advance(1);
    expect((await ctx.call("POST", "/v1/elder/sos", ELDER, {})).status).toBe(201);
    ctx.advance(1);
    ctx.advance(1);
    const scam = await ctx.call("POST", "/v1/elder/sos", ELDER, {
      packageName: "viva.republica.toss",
      appName: "토스",
      category: "scam",
      reason: "기관 사칭 송금 요청",
    });
    expect(scam.status).toBe(201);
    ctx.advance(1);

    const list = (await ctx.call("GET", "/v1/guardian/notifications", G1)).body as Items;
    expect(list.items.map((i) => i.type)).toEqual(["sos", "sos", "stuck", "stuck"]);
    expect(list.items[0]).toMatchObject({
      category: "scam",
      level: "L3",
      reason: "기관 사칭 송금 요청",
    });
    expect(list.items[3]).toMatchObject({ packageName: "kr.go.minwon.m", appName: "정부24" });
  });
});

describe("#21 목록, #22 읽음", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = setup();
    await ctx.register();
    await ctx.link(G1, "어머니");
    for (let i = 0; i < 3; i++) {
      await ctx.call("POST", "/v1/elder/sos", ELDER, {});
      ctx.advance(1000);
    }
  });

  it("최신순 페이지, nextCursor 로 다음 페이지", async () => {
    const first = (
      await ctx.call("GET", "/v1/guardian/notifications", G1, undefined, { query: { limit: "2" } })
    ).body as Items;
    expect(first.items).toHaveLength(2);
    expect(first.items[0]?.createdAt).toBe("2026-11-26T06:00:02.000Z");
    expect(first.nextCursor).toBeDefined();
    expect(first.serverTime).toBe("2026-11-26T06:00:03.000Z");

    const second = (
      await ctx.call("GET", "/v1/guardian/notifications", G1, undefined, {
        query: { limit: "2", cursor: first.nextCursor ?? "" },
      })
    ).body as Items;
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
  });

  it("since 이후 생긴 것만", async () => {
    const list = (
      await ctx.call("GET", "/v1/guardian/notifications", G1, undefined, {
        query: { since: "2026-11-26T06:00:00.500Z" },
      })
    ).body as Items;
    expect(list.items).toHaveLength(2);
  });

  it("읽음은 처음 읽은 시각을 유지하고, 없는 알림은 404", async () => {
    const list = (await ctx.call("GET", "/v1/guardian/notifications", G1)).body as Items;
    const id = String(list.items[0]?.id);
    expect((await ctx.call("POST", `/v1/guardian/notifications/${id}/read`, G1)).status).toBe(204);
    ctx.advance(60_000);
    await ctx.call("POST", `/v1/guardian/notifications/${id}/read`, G1);
    const after = (await ctx.call("GET", "/v1/guardian/notifications", G1)).body as Items;
    expect(after.items[0]?.readAt).toBe("2026-11-26T06:00:03.000Z");

    const missing = await ctx.call(
      "POST",
      "/v1/guardian/notifications/n20261126T000000000Z-abcdef/read",
      G1,
    );
    expect(missing).toMatchObject({ status: 404, body: { error: { reason: "not-found" } } });
    expect((await ctx.call("POST", "/v1/guardian/notifications/bad-id/read", G1)).status).toBe(400);
  });

  it("연결을 해제하면 그 어르신 알림은 보호자 목록에서 빠진다", async () => {
    await ctx.call("DELETE", `/v1/guardian/links/${ELDER}`, G1);
    const list = (await ctx.call("GET", "/v1/guardian/notifications", G1)).body as Items;
    expect(list.items).toEqual([]);
  });

  it("한 건 조회: #21 항목과 같은 모양, 없거나 해제되면 404", async () => {
    const list = (await ctx.call("GET", "/v1/guardian/notifications", G1)).body as Items;
    const first = list.items[0];
    const one = await ctx.call("GET", `/v1/guardian/notifications/${String(first?.id)}`, G1);
    expect(one).toEqual({ status: 200, body: first });
    const path = `/v1/guardian/notifications/${String(first?.id)}`;
    // 연결되지 않은 보호자에게는 없는 알림, 어르신은 부를 수 없음
    expect((await ctx.call("GET", path, G2)).status).toBe(404);
    expect((await ctx.call("GET", path, ELDER)).status).toBe(403);
    // 해제하면 404
    await ctx.call("DELETE", `/v1/guardian/links/${ELDER}`, G1);
    expect((await ctx.call("GET", path, G1)).status).toBe(404);
  });

  it("모두 읽음: 본문 없이 전체, elderId 로 한 어르신만, 이미 읽은 것은 그대로", async () => {
    const list = (await ctx.call("GET", "/v1/guardian/notifications", G1)).body as Items;
    await ctx.call("POST", `/v1/guardian/notifications/${String(list.items[0]?.id)}/read`, G1);
    ctx.advance(60_000);

    const other = await ctx.call("POST", "/v1/guardian/notifications/read-all", G1, {
      elderId: "someone-else",
    });
    expect(other).toEqual({ status: 200, body: { updated: 0 } });
    const all = await ctx.call("POST", "/v1/guardian/notifications/read-all", G1);
    expect(all).toEqual({ status: 200, body: { updated: 2 } });

    const after = (await ctx.call("GET", "/v1/guardian/notifications", G1)).body as Items;
    expect(after.items.map((i) => i.readAt)).toEqual([
      "2026-11-26T06:00:03.000Z",
      "2026-11-26T06:01:03.000Z",
      "2026-11-26T06:01:03.000Z",
    ]);
  });
});
