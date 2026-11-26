import { describe, expect, it, vi } from "vitest";
import {
  FALLBACK_SAY,
  finalize,
  guide,
  isSecretScreen,
  toPromptInput,
  type GuideModel,
  type GuideModelResult,
} from "../src/ai/guide.js";
import { guideRequestSchema, type GuideModelOutput } from "../src/ai/guide-schema.js";
import { createGuideRoute } from "../src/functions/ai/routes/guide.js";
import { createHttpHandler } from "../src/shared/handler.js";
import { createLogger } from "../src/shared/logger.js";
import { createRouter } from "../src/shared/router.js";
import { httpEvent, lambdaContext, parseBody } from "./helpers.js";

const log = createLogger({}, { write: () => undefined });
const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

function request(overrides: Record<string, unknown> = {}) {
  return guideRequestSchema.parse({
    requestId: 108,
    goal: "OPEN_APP",
    utterance: "카카오톡 열어 줘",
    slots: { app: "카카오톡" },
    screen: {
      pkg: "com.sec.android.app.launcher",
      width: 1000,
      height: 2000,
      nodes: [
        { i: 12, t: "카카오톡", c: "android.widget.TextView", b: [50, 1200, 250, 1400] },
        { i: 13, t: "유튜브", c: "android.widget.TextView", b: [300, 1200, 500, 1400] },
      ],
    },
    ...overrides,
  });
}

const output = (patch: Partial<GuideModelOutput>): GuideModelOutput => ({
  type: "highlight",
  say: "화면 왼쪽 가운데의 카카오톡을 누르세요.",
  target: 12,
  chips: null,
  dir: null,
  ...patch,
});

const okModel =
  (patch: Partial<GuideModelOutput> = {}): GuideModel =>
  () =>
    Promise.resolve({ status: "ok", output: output(patch), usage, stopReason: "end_turn" });

describe("toPromptInput", () => {
  it("위치를 화면 대비 % 로, 클래스를 짧은 이름으로 바꾼다", () => {
    const { input } = toPromptInput(request());
    expect(input.screen.nodes[0]).toEqual({
      i: 12,
      t: "카카오톡",
      c: "TextView",
      pos: [5, 60, 25, 70],
    });
  });

  it("숫자 개인정보를 가린다", () => {
    const { input, masked } = toPromptInput(
      request({ utterance: "엄마한테 010-1234-5678 로 50,000원 보내 줘" }),
    );
    expect(input.utterance).not.toContain("1234");
    expect(input.utterance).not.toContain("50,000");
    expect(masked).toBe(2);
  });
});

describe("finalize", () => {
  const ids = new Set([12, 13]);

  it("화면에 있는 target 이면 그대로", () => {
    expect(finalize(1, output({}), ids)).toEqual({
      requestId: 1,
      type: "highlight",
      say: "화면 왼쪽 가운데의 카카오톡을 누르세요.",
      target: 12,
    });
  });

  it("화면에 없는 target 이면 say 로 낮춘다", () => {
    expect(finalize(1, output({ target: 99 }), ids)).toEqual({
      requestId: 1,
      type: "say",
      say: FALLBACK_SAY.unsure,
    });
  });

  it("suggest 의 chips 는 4개까지, 가려진 값은 뺀다", () => {
    const result = finalize(
      1,
      output({ type: "suggest", chips: ["홍길동", "010-1234-5678", "a", "b", "c", "d"] }),
      ids,
    );
    expect(result).toMatchObject({ type: "suggest", target: 12, chips: ["홍길동", "a", "b", "c"] });
  });

  it("swipe 는 dir 이 있어야 한다", () => {
    expect(finalize(1, output({ type: "swipe", target: null, dir: null }), ids).type).toBe("say");
    expect(finalize(1, output({ type: "swipe", target: null, dir: "down" }), ids)).toMatchObject({
      type: "swipe",
      dir: "down",
    });
  });

  it("say 는 60자로 자르고 쓰지 않는 필드는 빼고 보낸다", () => {
    const result = finalize(1, output({ type: "say", say: "가".repeat(100), target: 12 }), ids);
    expect(result.say).toHaveLength(60);
    expect(result).not.toHaveProperty("target");
  });
});

describe("guide", () => {
  it("모델 결과를 후처리해 돌려준다", async () => {
    await expect(guide(request(), okModel(), log)).resolves.toMatchObject({
      requestId: 108,
      type: "highlight",
      target: 12,
    });
  });

  it("은행 목표와 비밀번호 화면은 모델을 부르지 않는다", async () => {
    const model = vi.fn<GuideModel>();
    await expect(guide(request({ goal: "BANK" }), model, log)).resolves.toMatchObject({
      type: "say",
      say: FALLBACK_SAY.bank,
    });

    const secret = request();
    secret.screen.nodes.push({ i: 14, t: "비밀번호 6자리를 입력하세요" });
    expect(isSecretScreen(secret)).toBe(true);
    await expect(guide(secret, model, log)).resolves.toMatchObject({ say: FALLBACK_SAY.secret });
    expect(model).not.toHaveBeenCalled();
  });

  it("거절·오류는 say 로 답한다", async () => {
    const refusal: GuideModel = () =>
      Promise.resolve<GuideModelResult>({ status: "refusal", usage, stopReason: "refusal" });
    await expect(guide(request(), refusal, log)).resolves.toMatchObject({
      type: "say",
      say: FALLBACK_SAY.unsure,
    });

    const failing: GuideModel = () => Promise.reject(new Error("timeout"));
    await expect(guide(request(), failing, log)).resolves.toMatchObject({
      type: "say",
      say: FALLBACK_SAY.busy,
    });
  });
});

describe("POST /v1/elder/guide", () => {
  const handler = createHttpHandler(
    createRouter([
      { method: "POST", path: "/v1/elder/guide", handler: createGuideRoute(okModel()) },
    ]),
    log,
  );
  const post = (body: unknown, uid: string | null = "uid-1") =>
    handler(
      { ...httpEvent("POST", "/v1/elder/guide", uid ?? undefined), body: JSON.stringify(body) },
      lambdaContext,
    );

  it("200 + 안내", async () => {
    const result = await post({
      requestId: 108,
      goal: "OPEN_APP",
      screen: { pkg: "a", width: 100, height: 100, nodes: [{ i: 12, t: "카카오톡" }] },
    });
    expect(result.statusCode).toBe(200);
    expect(parseBody(result.body)).toMatchObject({ requestId: 108, type: "highlight", target: 12 });
  });

  it("본문이 잘못되면 400 invalid-argument", async () => {
    const result = await post({ requestId: 1 });
    expect(result.statusCode).toBe(400);
    expect(parseBody(result.body)).toMatchObject({ error: { reason: "invalid-argument" } });
  });

  it("인증이 없으면 401", async () => {
    const result = await post({}, null);
    expect(result.statusCode).toBe(401);
  });
});
