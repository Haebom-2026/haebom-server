import { describe, expect, it } from "vitest";
import { guide, type GuideModel, type GuideTrace } from "../src/ai/guide.js";
import { guideRequestSchema } from "../src/ai/guide-schema.js";
import { createProfileGuard } from "../src/core/profile.js";
import {
  createGuideTraceRecorder,
  uidDeviceId,
  type GuideTraceRecorder,
} from "../src/debug/guide-trace.js";
import { createGuideRoute } from "../src/functions/ai/routes/guide.js";
import type { CommandLog, StepRecord } from "../src/route/command-log.js";
import { createHttpHandler } from "../src/shared/handler.js";
import { createLogger } from "../src/shared/logger.js";
import { createRouter } from "../src/shared/router.js";
import { memoryCoreStore } from "./core-memory-store.js";
import { memoryDebugStore } from "./debug-memory-store.js";
import { httpEvent, lambdaContext, parseBody } from "./helpers.js";

const log = createLogger({}, { write: () => undefined });
const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 1800, cacheWriteTokens: 0 };
const NOW = new Date("2026-11-26T10:00:00.000Z");

const body = {
  requestId: 3,
  goal: "UNKNOWN",
  utterance: "엄마 010-1234-5678 로 전화해 줘",
  history: ["설정을 눌러 주세요."],
  screen: {
    pkg: "com.android.settings",
    width: 1080,
    height: 2220,
    nodes: [
      { i: 0, c: "android.widget.LinearLayout", b: [0, 1100, 1080, 1210], clickable: true },
      { i: 1, t: "Display", b: [190, 1110, 1080, 1155] },
      { i: 2, t: "계좌 110-123-456789", b: [190, 1300, 1080, 1350] },
    ],
  },
};

const okModel: GuideModel = () =>
  Promise.resolve({
    status: "ok",
    output: {
      plan: ["설정 열기", "디스플레이 누르기"],
      step: "설정 첫 화면",
      status: "in_progress",
      action: "tap",
      target_id: 0,
      speech: "가운데의 Display 를 누르세요.",
      type_text: null,
      seek: null,
      options: [],
      fact: "none",
    },
    usage,
    stopReason: "end_turn",
  });

describe("guide onTrace", () => {
  const run = async (model: GuideModel, overrides: Record<string, unknown> = {}) => {
    let trace: GuideTrace | undefined;
    await guide(guideRequestSchema.parse({ ...body, ...overrides }), model, log, (t) => {
      trace = t;
    });
    return trace;
  };

  it("AI 입력(마스킹·위치%)과 모델 원래 출력, 토큰을 담는다", async () => {
    const trace = await run(okModel);
    expect(trace?.status).toBe("ok");
    expect(trace?.output).toMatchObject({ action: "tap", target_id: 0 });
    expect(trace?.usage).toEqual(usage);
    expect(trace?.input?.utterance).not.toContain("5678");
    expect(trace?.input?.screen.nodes[0]).toMatchObject({
      i: 0,
      pos: [0, 50, 100, 55],
      state: ["clickable"],
    });
  });

  it("모델을 부르지 않으면 skipped, 실패하면 error", async () => {
    expect(await run(okModel, { screen: { ...body.screen, nodes: [] } })).toMatchObject({
      skipped: "empty-screen",
    });
    const failing: GuideModel = () => Promise.reject(new Error("timeout"));
    expect(await run(failing)).toMatchObject({ status: "error", error: "Error: timeout" });
  });
});

describe("guide trace recorder", () => {
  const record = async (recorder: GuideTraceRecorder, deviceId?: string) => {
    const request = guideRequestSchema.parse({ ...body, ...(deviceId ? { deviceId } : {}) });
    let trace: GuideTrace | undefined;
    const response = await guide(request, okModel, log, (t) => {
      trace = t;
    });
    if (!trace) throw new Error("no trace");
    return recorder.record({
      uid: "uid-1",
      request,
      response,
      trace,
      model: "claude-sonnet-5-5",
      receivedAt: NOW,
      deviceId: request.deviceId,
    });
  };

  it("화면(마스킹)·요청·AI 과정·응답을 화면 문서 하나로 저장한다", async () => {
    const { store, screens } = memoryDebugStore();
    const saved = await record(createGuideTraceRecorder(store), "pixel-emulator");

    expect(saved.deviceId).toBe("pixel-emulator");
    const doc = screens[0];
    expect(doc).toMatchObject({ deviceId: "pixel-emulator", guideType: "highlight", nodeCount: 3 });
    expect(JSON.stringify(doc?.screen)).not.toContain("456789");
    expect(doc?.guide).toMatchObject({
      type: "highlight",
      target: 0,
      request: { requestId: 3, goal: "UNKNOWN", history: ["설정을 눌러 주세요."] },
      ai: { model: "claude-sonnet-5-5", status: "ok", output: { target_id: 0 }, usage },
      response: { type: "highlight", target: 0, targetText: "Display" },
    });
    expect(JSON.stringify(doc?.guide)).not.toContain("5678");
  });

  it("같은 화면이라도 요청마다 남긴다", async () => {
    const { store, screens } = memoryDebugStore();
    const recorder = createGuideTraceRecorder(store);
    await record(recorder, "pixel-emulator");
    await record(recorder, "pixel-emulator");
    expect(screens).toHaveLength(2);
  });

  it("deviceId 가 없으면 같은 uid 의 최근 기기, 그것도 없으면 uid 기반 기기", async () => {
    const { store } = memoryDebugStore();
    const recorder = createGuideTraceRecorder(store);
    expect((await record(recorder)).deviceId).toBe(uidDeviceId("uid-1"));

    await store.heartbeat({
      deviceId: "adb-R3CR80QJAVT",
      uid: "uid-1",
      model: "",
      os: "",
      appVersion: "",
      now: NOW,
    });
    expect((await record(recorder)).deviceId).toBe("adb-R3CR80QJAVT");
  });
});

describe("POST /v1/elder/guide 기록", () => {
  const setup = (recorder: GuideTraceRecorder, commandLog?: CommandLog) => {
    const { store } = memoryCoreStore();
    void store.createUser({ uid: "uid-1", role: "elder", name: "", createdAt: "", updatedAt: "" });
    return createHttpHandler(
      createRouter([
        {
          method: "POST",
          path: "/v1/elder/guide",
          handler: createGuideRoute(okModel, createProfileGuard(store), {
            recorder,
            modelName: "m",
            commandLog,
          }),
        },
      ]),
      log,
    );
  };
  const post = (handler: ReturnType<typeof setup>) =>
    handler(
      { ...httpEvent("POST", "/v1/elder/guide", "uid-1"), body: JSON.stringify(body) },
      lambdaContext,
    );

  it("응답을 주면서 기록한다", async () => {
    const { store, screens } = memoryDebugStore();
    const result = await post(setup(createGuideTraceRecorder(store)));
    expect(result.statusCode).toBe(200);
    expect(parseBody(result.body)).toMatchObject({ type: "highlight", target: 0 });
    expect(screens).toHaveLength(1);
  });

  it("commandId 가 오면 stepId 를 주고 명령 단계를 남긴다 (행동 글자는 가림)", async () => {
    const { store } = memoryDebugStore();
    const steps: StepRecord[] = [];
    const commandLog: CommandLog = {
      appendStep: (step) => {
        steps.push(step);
        return Promise.resolve();
      },
      listSteps: () => Promise.resolve([]),
      saveReview: () => Promise.resolve(true),
      getReview: () => Promise.resolve(undefined),
      invalidateReview: () => Promise.resolve(),
    };
    const handler = setup(createGuideTraceRecorder(store), commandLog);
    const result = await handler(
      {
        ...httpEvent("POST", "/v1/elder/guide", "uid-1"),
        body: JSON.stringify({
          ...body,
          commandId: 42,
          lastAction: { stepId: "s0", seq: 0, action: "tap", text: "인증번호 123456" },
        }),
      },
      lambdaContext,
    );
    const res = parseBody(result.body) as { stepId?: string };
    expect(res.stepId).toMatch(/^s/);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      uid: "uid-1",
      commandId: 42,
      stepId: res.stepId,
      guide: { type: "highlight", source: "ai" },
      lastAction: { stepId: "s0", seq: 0, action: "tap", text: "인증번호 ***" },
    });
  });

  it("글자 넣기 행동은 넣은 값을 남기지 않는다", async () => {
    const { store } = memoryDebugStore();
    const steps: StepRecord[] = [];
    const commandLog: CommandLog = {
      appendStep: (step) => {
        steps.push(step);
        return Promise.resolve();
      },
      listSteps: () => Promise.resolve([]),
      saveReview: () => Promise.resolve(true),
      getReview: () => Promise.resolve(undefined),
      invalidateReview: () => Promise.resolve(),
    };
    await setup(createGuideTraceRecorder(store), commandLog)(
      {
        ...httpEvent("POST", "/v1/elder/guide", "uid-1"),
        body: JSON.stringify({
          ...body,
          commandId: 42,
          lastAction: { seq: 0, action: "type", text: "123456" },
        }),
      },
      lambdaContext,
    );
    expect(steps[0]?.lastAction).toEqual({ seq: 0, action: "type", text: "" });
  });

  it("기록에 실패해도 응답은 그대로", async () => {
    const broken: GuideTraceRecorder = {
      record: () => Promise.reject(new Error("s3 down")),
      recordFinal: () => Promise.reject(new Error("s3 down")),
    };
    const result = await post(setup(broken));
    expect(result.statusCode).toBe(200);
    expect(parseBody(result.body)).toMatchObject({ type: "highlight" });
  });
});
