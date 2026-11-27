import { describe, expect, it } from "vitest";
import { splitMap, type CommandInsight, type InsightStore } from "../src/debug/insight.js";
import { createDebugRoutes } from "../src/debug/routes.js";
import { createHttpHandler } from "../src/shared/handler.js";
import type { HttpEvent } from "../src/shared/http.js";
import { createLogger } from "../src/shared/logger.js";
import { createRouter } from "../src/shared/router.js";
import { memoryDebugStore } from "./debug-memory-store.js";
import { httpEvent, lambdaContext, parseBody } from "./helpers.js";

const DEV_EMAIL = "dev@example.com";
const NOW = new Date("2026-11-27T00:00:00.000Z");

const MAP_ITEMS = [
  {
    PK: "MAP",
    SK: "EDGE#e1",
    edgeId: "e1",
    status: "verified",
    evidence: new Set(["u1#1#g1@phone-a", "u2#2#g2@phone-b", "u3#3#g3@phone-a", "x#0#0@seed"]),
    createdAt: "2026-11-26T00:00:00.000Z",
    recent: [1, 1, 0],
  },
  {
    PK: "MAP",
    SK: "EDGE#e2",
    edgeId: "e2",
    status: "verified",
    evidence: ["u1#1#g1@phone-a"],
    createdAt: "2026-07-01T00:00:00.000Z",
  },
  {
    PK: "MAP",
    SK: "GOAL#settings.wifi",
    goalId: "settings.wifi",
    arriveFps: new Set(["fp2", "fp1"]),
    evidence: new Set<string>(),
  },
  { PK: "MAP", SK: "ARRIVE#settings.wifi#fp1", status: "candidate", evidence: ["u1#1#g1@phone-a"] },
  { PK: "MAP", SK: "PENDING#u9#5#g", uid: "u9", reasons: ["new_goal"], ttl: 123 },
  { PK: "MAP", SK: "APPLIED#u1#1#g1", uid: "u1", edgeIds: ["e1"] },
  { PK: "MAP", SK: "BLOCK", edgeIds: new Set(["e2"]), goalIds: ["settings.wifi"] },
];

describe("splitMap", () => {
  it("종류별로 나누고 Set 을 배열로, 증거 기기(seed 제외)·90일을 붙인다", () => {
    const m = splitMap(MAP_ITEMS, NOW);
    expect(m.edges.map((e) => e.edgeId)).toEqual(["e1", "e2"]);
    expect(m.edges[0]).toMatchObject({ devices: ["phone-a", "phone-b"], stale: false });
    expect(m.edges[0]?.evidence).toHaveLength(4);
    expect(m.edges[0]).not.toHaveProperty("PK");
    expect(m.edges[1]).toMatchObject({ stale: true });
    expect(m.goals[0]).toMatchObject({ arriveFps: ["fp1", "fp2"], devices: [] });
    expect(m.arrives[0]).toMatchObject({ SK: "ARRIVE#settings.wifi#fp1", devices: ["phone-a"] });
    expect(m.pending[0]).toMatchObject({ uid: "u9", reasons: ["new_goal"] });
    expect(m.pending[0]).not.toHaveProperty("ttl");
    expect(m.applied).toHaveLength(1);
    expect(m.block).toEqual({ edgeIds: ["e2"], goalIds: ["settings.wifi"] });
  });
});

function setup(insight?: InsightStore) {
  const { store } = memoryDebugStore();
  const handler = createHttpHandler(
    createRouter(
      createDebugRoutes({
        store,
        viewerEmails: new Set([DEV_EMAIL]),
        now: () => NOW,
        insight,
        names: { version: "t", apps: {}, roles: {}, goals: { "settings.wifi": "와이파이" } },
      }),
    ),
    createLogger({}, { write: () => undefined }),
  );
  return { store, call: (event: HttpEvent) => handler(event, lambdaContext) };
}

function get(path: string, email = DEV_EMAIL): HttpEvent {
  const event = httpEvent("GET", path, "uid-dev");
  const jwt = event.requestContext.authorizer?.jwt;
  if (jwt) jwt.claims = { ...jwt.claims, email, email_verified: "true" };
  return event;
}

const fakeInsight = (calls: string[]): InsightStore => ({
  learnedMap: (now) => Promise.resolve(splitMap(MAP_ITEMS, now)),
  command: (uid, commandId): Promise<CommandInsight> => {
    calls.push(`${uid}:${commandId}`);
    return Promise.resolve({
      uid,
      commandId,
      command: { endResult: "done" },
      steps: [],
      reviews: [{ outcome: "accept" }],
      applied: [],
      pending: [],
    });
  },
});

describe("debug-fn R3~R5 기록", () => {
  it("GET /v1/dev/map: 배운 지도 + 이름표", async () => {
    const t = setup(fakeInsight([]));
    const res = await t.call(get("/v1/dev/map"));
    expect(res.statusCode).toBe(200);
    expect(parseBody(res.body)).toMatchObject({
      edges: [{ edgeId: "e1" }, { edgeId: "e2" }],
      names: { goals: { "settings.wifi": "와이파이" } },
      serverTime: NOW.toISOString(),
    });
  });

  it("명령 기록은 기기의 uid 로 찾는다", async () => {
    const calls: string[] = [];
    const t = setup(fakeInsight(calls));
    await t.store.heartbeat({
      deviceId: "device-0001",
      model: "m",
      os: "o",
      appVersion: "1",
      uid: "elder-1",
      now: NOW,
    });
    const res = await t.call(get("/v1/dev/devices/device-0001/commands/1795734365"));
    expect(res.statusCode).toBe(200);
    expect(parseBody(res.body)).toMatchObject({
      uid: "elder-1",
      reviews: [{ outcome: "accept" }],
    });
    expect(calls).toEqual(["elder-1:1795734365"]);

    expect((await t.call(get("/v1/dev/devices/device-0001/commands/12x"))).statusCode).toBe(400);
    expect((await t.call(get("/v1/dev/devices/device-9999/commands/1"))).statusCode).toBe(404);
  });

  it("허용 목록 밖은 403, 저장소가 없으면 unavailable", async () => {
    expect((await setup(fakeInsight([])).call(get("/v1/dev/map", "x@y.z"))).statusCode).toBe(403);
    expect((await setup().call(get("/v1/dev/map"))).statusCode).toBe(503);
  });
});
