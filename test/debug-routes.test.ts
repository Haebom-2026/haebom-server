import { describe, expect, it } from "vitest";
import { createDebugRoutes } from "../src/debug/routes.js";
import type {
  DebugStore,
  DeviceRecord,
  PinRecord,
  ScreenDocument,
  ScreenSummary,
} from "../src/debug/store.js";
import { summaryOf } from "../src/debug/store.js";
import { createHttpHandler } from "../src/shared/handler.js";
import type { HttpEvent } from "../src/shared/http.js";
import { createLogger } from "../src/shared/logger.js";
import { createRouter } from "../src/shared/router.js";
import { httpEvent, lambdaContext, parseBody } from "./helpers.js";

/** 메모리 구현: 라우트 동작만 검증한다 (DynamoDB·S3 연동은 dev 배포 후 확인). */
function memoryStore() {
  const devices = new Map<string, DeviceRecord & { lastKey?: string }>();
  const screens: (ScreenDocument & { uid: string })[] = [];
  const pins: PinRecord[] = [];

  const store: DebugStore = {
    heartbeat({ deviceId, uid, model, os, appVersion, now }) {
      const prev = devices.get(deviceId);
      devices.set(deviceId, {
        ...prev,
        deviceId,
        uid,
        model,
        os,
        appVersion,
        lastSeenAt: now.toISOString(),
        screenCount: prev?.screenCount ?? 0,
      });
      return Promise.resolve();
    },
    saveScreen({ dedupeKey, ...doc }) {
      const prev = devices.get(doc.deviceId);
      if (prev?.lastKey === dedupeKey) return Promise.resolve(false);
      devices.set(doc.deviceId, {
        model: "",
        os: "",
        appVersion: "",
        ...prev,
        deviceId: doc.deviceId,
        uid: doc.uid,
        lastKey: dedupeKey,
        lastSeenAt: doc.receivedAt,
        lastScreenAt: doc.receivedAt,
        screenCount: (prev?.screenCount ?? 0) + 1,
      });
      screens.push(doc);
      return Promise.resolve(true);
    },
    listDevices: () => Promise.resolve([...devices.values()]),
    setLabel(deviceId, label) {
      const prev = devices.get(deviceId);
      if (!prev) return Promise.resolve(false);
      devices.set(deviceId, { ...prev, label });
      return Promise.resolve(true);
    },
    listScreens(deviceId, { since, from, to, limit }) {
      const mine = screens.filter((s) => s.deviceId === deviceId).map(summaryOf);
      const items =
        since !== undefined
          ? mine.filter((s) => s.screenId > since).slice(0, limit)
          : from !== undefined && to !== undefined
            ? mine.filter((s) => s.screenId >= from && s.screenId <= to).slice(0, limit)
            : mine.reverse().slice(0, limit);
      return Promise.resolve({ items });
    },
    getScreen: (deviceId, screenId) =>
      Promise.resolve(screens.find((s) => s.deviceId === deviceId && s.screenId === screenId)),
    createPin(pin) {
      const record = {
        ...pin,
        screenCount: screens.filter(
          (s) => s.deviceId === pin.deviceId && s.screenId >= pin.from && s.screenId <= pin.to,
        ).length,
      };
      pins.push(record);
      return Promise.resolve(record);
    },
    listPins: () => Promise.resolve(pins),
  };
  return { store, screens };
}

const DEVICE = "device-0001";
const DEV_EMAIL = "dev@example.com";

function setup(start = Date.parse("2026-11-26T07:00:00.000Z")) {
  let clock = start;
  const { store, screens } = memoryStore();
  const router = createRouter(
    createDebugRoutes({ store, viewerEmails: new Set([DEV_EMAIL]), now: () => new Date(clock) }),
  );
  const handler = createHttpHandler(router, createLogger({}, { write: () => undefined }));
  return {
    screens,
    tick: (ms: number) => (clock += ms),
    call: (event: HttpEvent) => handler(event, lambdaContext),
  };
}

function request(
  method: string,
  path: string,
  options: { body?: unknown; query?: Record<string, string>; email?: string; uid?: string } = {},
): HttpEvent {
  const event = httpEvent(method, path, options.uid ?? "uid-elder");
  if (options.body !== undefined) event.body = JSON.stringify(options.body);
  if (options.query) event.queryStringParameters = options.query;
  const jwt = event.requestContext.authorizer?.jwt;
  if (options.email !== undefined && jwt) {
    jwt.claims = { ...jwt.claims, email: options.email, email_verified: "true" };
  }
  return event;
}

const viewer = { email: DEV_EMAIL, uid: "uid-dev" };

const screenBody = (text: string) => ({
  deviceId: DEVICE,
  capturedAt: "2026-11-26T06:59:59.500Z",
  screen: {
    pkg: "kr.go.gov24",
    width: 1080,
    height: 2400,
    nodes: [
      { i: 0, t: text, c: "Button", b: [100, 500, 500, 600], clickable: true },
      { i: 1, t: "계좌 110-123-456789", c: "TextView", b: [0, 0, 10, 10] },
    ],
  },
});

describe("debug-fn 앱 엔드포인트", () => {
  it("heartbeat → 204, 기기 목록에 online 으로 보인다", async () => {
    const t = setup();
    const hb = await t.call(
      request("POST", "/v1/dev/heartbeat", {
        body: { deviceId: DEVICE, model: "SM-S928N", os: "Android 15", appVersion: "0.3.1" },
      }),
    );
    expect(hb.statusCode).toBe(204);

    const list = await t.call(request("GET", "/v1/dev/devices", viewer));
    expect(parseBody(list.body)).toMatchObject({
      items: [{ deviceId: DEVICE, model: "SM-S928N", online: true }],
    });

    t.tick(16_000);
    const later = await t.call(request("GET", "/v1/dev/devices", viewer));
    expect(parseBody(later.body)).toMatchObject({ items: [{ online: false }] });
  });

  it("screens: 마스킹·지문 후 저장, 같은 화면은 unchanged", async () => {
    const t = setup();
    const first = await t.call(
      request("POST", "/v1/dev/screens", { body: screenBody("민원 신청") }),
    );
    expect(first.statusCode).toBe(202);
    expect(parseBody(first.body)).toMatchObject({ status: "saved" });

    const saved = t.screens[0];
    expect(saved?.screen.nodes[1]?.t).toBe("계좌 ***");
    expect(saved?.maskedCount).toBe(1);
    expect(saved?.fpVersion).toBe("fp@v1");
    expect(saved?.screen.nodes[0]).toMatchObject({ clickable: true }); // 모르는 필드도 보존

    t.tick(1000);
    const again = await t.call(
      request("POST", "/v1/dev/screens", { body: screenBody("민원 신청") }),
    );
    expect(parseBody(again.body)).toEqual({ status: "unchanged" });

    t.tick(1000);
    const changed = await t.call(
      request("POST", "/v1/dev/screens", { body: screenBody("증명서 발급") }),
    );
    expect(parseBody(changed.body)).toMatchObject({ status: "saved" });
    expect(t.screens).toHaveLength(2);
  });

  it("노드 60개 초과·잘못된 deviceId 는 400", async () => {
    const t = setup();
    const many = screenBody("x");
    many.screen.nodes = Array.from({ length: 61 }, (_, i) => ({
      i,
      t: "a",
      c: "V",
      b: [0, 0, 1, 1],
    }));
    expect((await t.call(request("POST", "/v1/dev/screens", { body: many }))).statusCode).toBe(400);

    const badId = { ...screenBody("x"), deviceId: "../x" };
    expect((await t.call(request("POST", "/v1/dev/screens", { body: badId }))).statusCode).toBe(
      400,
    );
  });

  it("인증 없으면 401", async () => {
    const t = setup();
    const event = httpEvent("POST", "/v1/dev/heartbeat");
    event.body = JSON.stringify({ deviceId: DEVICE });
    expect((await t.call(event)).statusCode).toBe(401);
  });
});

describe("debug-fn 뷰어 엔드포인트", () => {
  it("허용 목록에 없는 이메일·이메일 없는 토큰은 403", async () => {
    const t = setup();
    const stranger = await t.call(request("GET", "/v1/dev/devices", { email: "x@example.com" }));
    expect(stranger.statusCode).toBe(403);
    const elder = await t.call(request("GET", "/v1/dev/devices"));
    expect(elder.statusCode).toBe(403);
  });

  it("since 로 새 화면만 받고, 화면 원본을 조회한다", async () => {
    const t = setup();
    await t.call(request("POST", "/v1/dev/screens", { body: screenBody("A") }));
    const firstId = t.screens[0]?.screenId ?? "";
    t.tick(1000);
    await t.call(request("POST", "/v1/dev/screens", { body: screenBody("B") }));

    const res = await t.call(
      request("GET", `/v1/dev/devices/${DEVICE}/screens`, { ...viewer, query: { since: firstId } }),
    );
    const body = parseBody(res.body) as { items: ScreenSummary[] };
    expect(body.items).toHaveLength(1);
    expect((body.items[0]?.screenId ?? "") > firstId).toBe(true);

    const detail = await t.call(
      request("GET", `/v1/dev/devices/${DEVICE}/screens/${firstId}`, viewer),
    );
    expect(detail.statusCode).toBe(200);
    expect(parseBody(detail.body)).toMatchObject({
      screenId: firstId,
      screen: { pkg: "kr.go.gov24" },
    });
  });

  it("라벨 지정, 없는 기기는 404", async () => {
    const t = setup();
    await t.call(request("POST", "/v1/dev/heartbeat", { body: { deviceId: DEVICE } }));
    const ok = await t.call(
      request("PATCH", `/v1/dev/devices/${DEVICE}`, { ...viewer, body: { label: "시연폰 A" } }),
    );
    expect(ok.statusCode).toBe(204);
    const missing = await t.call(
      request("PATCH", "/v1/dev/devices/device-9999", { ...viewer, body: { label: "x" } }),
    );
    expect(missing.statusCode).toBe(404);
  });

  it("보관 세션 생성·목록", async () => {
    const t = setup();
    await t.call(request("POST", "/v1/dev/screens", { body: screenBody("A") }));
    t.tick(1000);
    await t.call(request("POST", "/v1/dev/screens", { body: screenBody("B") }));
    const [a, b] = t.screens.map((s) => s.screenId);

    const created = await t.call(
      request("PUT", `/v1/dev/devices/${DEVICE}/pins`, {
        ...viewer,
        body: { from: a, to: b, name: "정부24 L2 1회차" },
      }),
    );
    expect(created.statusCode).toBe(201);
    expect(parseBody(created.body)).toMatchObject({ screenCount: 2, createdBy: DEV_EMAIL });

    const reversed = await t.call(
      request("PUT", `/v1/dev/devices/${DEVICE}/pins`, {
        ...viewer,
        body: { from: b, to: a, name: "x" },
      }),
    );
    expect(reversed.statusCode).toBe(400);

    const range = await t.call(
      request("GET", `/v1/dev/devices/${DEVICE}/screens`, {
        ...viewer,
        query: { from: a ?? "", to: b ?? "" },
      }),
    );
    expect((parseBody(range.body) as { items: unknown[] }).items).toHaveLength(2);

    const onlyFrom = await t.call(
      request("GET", `/v1/dev/devices/${DEVICE}/screens`, { ...viewer, query: { from: a ?? "" } }),
    );
    expect(onlyFrom.statusCode).toBe(400);

    const list = await t.call(request("GET", "/v1/dev/pins", viewer));
    expect(parseBody(list.body)).toMatchObject({ items: [{ name: "정부24 L2 1회차" }] });
  });
});
