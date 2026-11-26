import { describe, expect, it, vi } from "vitest";
import { guide, type GuideModel } from "../src/ai/guide.js";
import { guideRequestSchema, type GuideModelOutput } from "../src/ai/guide-schema.js";
import {
  GUIDE_CACHE_TTL_SECONDS,
  guideCacheKey,
  memoryGuideCache,
  revalidateCached,
} from "../src/cache/guide-cache.js";
import { createLogger } from "../src/shared/logger.js";

const log = createLogger({}, { write: () => undefined });
const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

function request(overrides: Record<string, unknown> = {}) {
  return guideRequestSchema.parse({
    requestId: 1,
    goal: "YOUTUBE",
    utterance: "유튜브에 임영웅 검색해 줘",
    slots: { query: "임영웅" },
    screen: {
      pkg: "com.google.android.youtube",
      width: 1080,
      height: 2640,
      nodes: [
        { i: 0, d: "알림", c: "ImageView", b: [792, 94, 936, 238], clickable: true },
        { i: 1, d: "검색", c: "ImageView", b: [936, 94, 1080, 238], clickable: true },
      ],
    },
    ...overrides,
  });
}

const output = (patch: Partial<GuideModelOutput> = {}): GuideModelOutput => ({
  type: "highlight",
  say: "화면 오른쪽 위의 검색을 누르세요.",
  target: 1,
  chips: null,
  dir: null,
  seek: null,
  ...patch,
});

const countingModel = (patch: Partial<GuideModelOutput> = {}) => {
  const fn = vi.fn<GuideModel>(() =>
    Promise.resolve({ status: "ok", output: output(patch), usage, stopReason: "end_turn" }),
  );
  return fn;
};

const key = (req = request(), uid = "elder-1") =>
  guideCacheKey({ uid, request: req, promptVersion: "guide@v3", model: "claude-sonnet-5-5" });

describe("guideCacheKey", () => {
  it("같은 화면·같은 요청이면 같은 키 (requestId·history·숫자·띄어쓰기는 상관없음)", () => {
    const again = request({
      requestId: 99,
      history: ["검색을 누르세요."],
      utterance: "유튜브에 임영웅  검색해줘",
    });
    expect(key(again)).toBe(key());
  });

  it("어르신·검색어·화면·프롬프트가 다르면 다른 키", () => {
    expect(key(request(), "elder-2")).not.toBe(key());
    expect(key(request({ slots: { query: "나훈아" } }))).not.toBe(key());
    const other = request();
    other.screen.nodes.push({ i: 2, t: "방탄소년단", c: "TextView", b: [0, 300, 1080, 400] });
    expect(key(other)).not.toBe(key());
    expect(
      guideCacheKey({
        uid: "elder-1",
        request: request(),
        promptVersion: "guide@v4",
        model: "claude-sonnet-5-5",
      }),
    ).not.toBe(key());
  });
});

describe("revalidateCached", () => {
  const texts = new Map([
    [0, "알림"],
    [1, "검색"],
  ]);

  it("번호와 글자가 맞으면 그대로, 번호가 바뀌었으면 글자로 다시 찾음", () => {
    const cached = {
      type: "highlight" as const,
      say: "검색을 누르세요.",
      target: 1,
      targetText: "검색",
    };
    expect(revalidateCached(cached, texts)).toEqual(cached);
    expect(revalidateCached({ ...cached, target: 0 }, texts)).toEqual(cached);
  });

  it("글자를 못 찾으면 쓰지 않음, target 없는 답은 그대로", () => {
    expect(
      revalidateCached({ type: "highlight", say: "", target: 5, targetText: "없는 단추" }, texts),
    ).toBeUndefined();
    expect(revalidateCached({ type: "done", say: "다 됐어요." }, texts)).toEqual({
      type: "done",
      say: "다 됐어요.",
    });
  });
});

describe("guide + 응답 캐시", () => {
  it("두 번째 같은 요청은 모델을 부르지 않고 cached: true 로 답함", async () => {
    const store = memoryGuideCache();
    const model = countingModel();
    const handle = { store, key: key() };

    const first = await guide(request(), model, log, undefined, handle);
    expect(first).toEqual({
      requestId: 1,
      type: "highlight",
      say: output().say,
      target: 1,
      targetText: "검색",
    });

    const traces: unknown[] = [];
    const second = await guide(
      request({ requestId: 2 }),
      model,
      log,
      (t) => traces.push(t),
      handle,
    );
    expect(second).toEqual({ ...first, requestId: 2, cached: true });
    expect(model).toHaveBeenCalledTimes(1);
    expect(traces[0]).toMatchObject({ cache: "hit" });
  });

  it("낮춰진 답·대체 문장·모델 실패는 저장하지 않음", async () => {
    const store = memoryGuideCache();
    // 화면에 없는 target → say 로 낮춰짐
    await guide(request(), countingModel({ target: 42 }), log, undefined, { store, key: key() });
    expect(store.size()).toBe(0);

    const failing: GuideModel = () => Promise.reject(new Error("timeout"));
    await guide(request(), failing, log, undefined, { store, key: key() });
    expect(store.size()).toBe(0);

    await guide(
      request(),
      countingModel({ type: "say", say: "  ", target: null }),
      log,
      undefined,
      {
        store,
        key: key(),
      },
    );
    expect(store.size()).toBe(0);
  });

  it("비밀번호 화면은 캐시도 보지 않음", async () => {
    const store = memoryGuideCache();
    const get = vi.spyOn(store, "get");
    const secret = request();
    secret.screen.nodes.push({ i: 2, t: "비밀번호", c: "TextView" });
    await guide(secret, countingModel(), log, undefined, { store, key: key(secret) });
    expect(get).not.toHaveBeenCalled();
  });

  it("캐시 저장소가 고장나도 모델 답을 돌려줌", async () => {
    const broken = {
      get: () => Promise.reject(new Error("dynamo down")),
      put: () => Promise.reject(new Error("dynamo down")),
    };
    const response = await guide(request(), countingModel(), log, undefined, {
      store: broken,
      key: key(),
    });
    expect(response.type).toBe("highlight");
  });

  it("만료되면 다시 모델을 부름", async () => {
    let now = 0;
    const store = memoryGuideCache(() => now);
    const model = countingModel();
    await guide(request(), model, log, undefined, { store, key: key() });
    now = GUIDE_CACHE_TTL_SECONDS * 1000 + 1;
    await guide(request(), model, log, undefined, { store, key: key() });
    expect(model).toHaveBeenCalledTimes(2);
  });
});
