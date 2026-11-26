import { describe, expect, it } from "vitest";
import { classify, type ClassifyDetail } from "../src/ai/classify.js";
import type { ClassifyModel } from "../src/ai/classify-model.js";
import { classifyRequestSchema } from "../src/ai/classify-schema.js";
import { createCommandTraceRecorder } from "../src/debug/command-trace.js";
import { uidDeviceId } from "../src/debug/guide-trace.js";
import type { CommandEntryDocument } from "../src/debug/store.js";
import type { CommandRecord, CommandStore } from "../src/route/command-store.js";
import type { ChoiceQuestion, JevClient, JevResult } from "../src/route/jev.js";
import { parseMap } from "../src/route/map.js";
import { SEED_MAP } from "../src/route/seed-map.js";
import { createRecordingSelector } from "../src/route/trace.js";
import { createLogger } from "../src/shared/logger.js";
import { memoryDebugStore } from "./debug-memory-store.js";

const seed = parseMap(SEED_MAP);
const log = createLogger({}, { write: () => undefined });

/** 정부24 → 등본 으로 답하는 가짜 jev */
const jev: JevClient = {
  choose(_state, questions) {
    const answers: Record<string, { choice: string; probabilities: Record<string, number> }> = {};
    for (const [key, q] of Object.entries<ChoiceQuestion>(questions)) {
      const given: Record<string, number> =
        key === "app" ? { gov24: 0.95, none: 0.02 } : { resident_copy: 0.9 };
      const p = Object.fromEntries(Object.keys(q.criteria).map((k) => [k, given[k] ?? 0]));
      answers[key] = { choice: Object.keys(given)[0] ?? "none", probabilities: p };
    }
    return Promise.resolve<JevResult>({
      ok: true,
      answers,
      ms: 300,
      cost: 0.00004,
      inputTokens: 9,
    });
  },
};

const model: ClassifyModel = () =>
  Promise.resolve({
    status: "ok",
    output: {
      intent: "OPEN_APP",
      app: null,
      level: "L1",
      category: "public",
      reason: "등본 발급 010-1234-5678",
    },
    inputTokens: 10,
    outputTokens: 5,
  });

function commands(): CommandStore & { saved: CommandRecord[] } {
  const saved: CommandRecord[] = [];
  return {
    saved,
    create(record) {
      saved.push(record);
      return Promise.resolve("created");
    },
    get: () => Promise.resolve(undefined),
    update: () => Promise.resolve("ok"),
  };
}

async function run(utterance: string) {
  let detail: ClassifyDetail | undefined;
  const store = commands();
  const response = await classify("u1", classifyRequestSchema.parse({ commandId: 7, utterance }), {
    model,
    selector: createRecordingSelector({ jev, map: seed }),
    commands: store,
    log,
    observe: (d) => {
      detail = d;
    },
  });
  if (!detail) throw new Error("observe not called");
  return { response, detail, store };
}

describe("명령 기록 (command-trace)", () => {
  it("classify 판단 과정을 넘기지만 응답·명령 저장에는 trace 가 없다", async () => {
    const { response, detail, store } = await run("등본 떼 줘 010-1234-5678");
    expect(JSON.stringify(response)).not.toContain("trace");
    expect(JSON.stringify(store.saved)).not.toContain("thresholds");
    expect(detail.request.utterance).not.toContain("5678");
    expect(detail.safety.output?.reason).not.toContain("5678");
    expect(detail.selection).toMatchObject({ kind: "route" });
  });

  it("기기 시간 순 목록에 명령 기록으로 남긴다 (실제 기기, 요약·원본)", async () => {
    const { store, entries } = memoryDebugStore();
    await store.heartbeat({
      deviceId: "pixel-real-1",
      uid: "u1",
      model: "Pixel",
      os: "15",
      appVersion: "1",
      now: new Date("2026-11-27T00:00:00Z"),
    });
    const recorder = createCommandTraceRecorder(store, seed);
    const { detail } = await run("등본 떼 줘");
    const saved = await recorder.classify({
      uid: "u1",
      receivedAt: new Date("2026-11-27T00:00:05Z"),
      detail,
    });
    expect(saved.deviceId).toBe("pixel-real-1");

    const { items } = await store.listScreens("pixel-real-1", { limit: 10 });
    expect(items[0]).toMatchObject({
      entry: "command",
      command: {
        kind: "classify",
        commandId: 7,
        level: "L2",
        route: "route",
        candidates: ["정부24"],
        goal: "등본",
      },
    });
    // 화면 수는 늘지 않는다
    expect((await store.listDevices())[0]?.screenCount).toBe(0);

    const doc = (await store.getScreen("pixel-real-1", saved.screenId)) as CommandEntryDocument;
    const body = doc.detail as {
      trace: { app: { rule: string } };
      selection: Record<string, unknown>;
      names: { apps: Record<string, string> };
    };
    expect(body.trace.app.rule).toBe("exclusive");
    expect(body.selection.trace).toBeUndefined();
    expect(body.names.apps.gov24).toBe("정부24");
    expect(entries).toHaveLength(1);
  });

  it("앱 선택도 남기고, 실제 기기가 없으면 uid 가상 기기", async () => {
    const { store } = memoryDebugStore();
    const recorder = createCommandTraceRecorder(store, seed);
    const saved = await recorder.choose({
      uid: "u2",
      receivedAt: new Date("2026-11-27T00:00:00Z"),
      commandId: 7,
      body: { appId: "gov24", installState: "installed", askedUser: false },
      response: {
        commandId: 7,
        appId: "gov24",
        goal: { id: "gov24.resident_copy", name: "등본" },
        sensitivity: { level: "L2" },
      },
    });
    expect(saved.deviceId).toBe(uidDeviceId("u2"));
    const { items } = await store.listScreens(saved.deviceId, { limit: 10 });
    expect(items[0]?.command).toEqual({
      kind: "choose",
      commandId: 7,
      level: "L2",
      appId: "gov24",
      appName: "정부24",
      goal: "등본",
    });
  });
});
