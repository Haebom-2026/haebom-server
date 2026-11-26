import { describe, expect, it, vi } from "vitest";
import {
  FALLBACK_SAY,
  finalize,
  guide,
  isSecretScreen,
  nodeTexts,
  todayInSeoul,
  toPromptInput,
  type GuideModel,
  type GuideModelResult,
} from "../src/ai/guide.js";
import { guideRequestSchema, type GuideModelOutput } from "../src/ai/guide-schema.js";
import { createProfileGuard } from "../src/core/profile.js";
import { createGuideRoute } from "../src/functions/ai/routes/guide.js";
import { createHttpHandler } from "../src/shared/handler.js";
import { createLogger } from "../src/shared/logger.js";
import { createRouter } from "../src/shared/router.js";
import { memoryCoreStore } from "./core-memory-store.js";
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
  plan: ["홈 화면에서 카카오톡 찾기", "카카오톡 누르기"],
  step: "홈 화면, 카카오톡이 보임",
  status: "in_progress",
  action: "tap",
  target_id: 12,
  speech: "화면 왼쪽 가운데의 카카오톡을 누르세요.",
  type_text: null,
  seek: null,
  options: [],
  fact: "none",
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

  it("true 인 상태만 state 로 넘긴다", () => {
    const req = request();
    req.screen.nodes.push({
      i: 20,
      c: "android.widget.EditText",
      editable: true,
      clickable: true,
      checked: false,
    });
    const { input } = toPromptInput(req);
    expect(input.screen.nodes.at(-1)).toEqual({
      i: 20,
      c: "EditText",
      state: ["clickable", "editable"],
    });
    expect(input.screen.nodes[0]).not.toHaveProperty("state");
  });

  it("focused 는 상태로, enabled:false 는 disabled 로 넘긴다", () => {
    const req = request();
    req.screen.nodes.push(
      { i: 30, t: "다음", clickable: true, enabled: false },
      { i: 31, editable: true, focused: true, enabled: true },
    );
    const { input } = toPromptInput(req);
    expect(input.screen.nodes.at(-2)).toMatchObject({ i: 30, state: ["clickable", "disabled"] });
    expect(input.screen.nodes.at(-1)).toMatchObject({ i: 31, state: ["editable", "focused"] });
  });

  it("입력 칸의 filled 는 상태로 넘기고, 비밀 칸이어도 남긴다 (내용은 지움)", () => {
    const req = request();
    req.screen.nodes.push(
      { i: 40, editable: true, filled: true, t: "(입력되어 있음)" },
      { i: 41, editable: true, secret: true, filled: true, t: "(입력되어 있음)" },
      { i: 42, editable: true, secret: true },
    );
    const parsed = guideRequestSchema.parse(req);
    expect(parsed.screen.nodes.at(-2)).toEqual({
      i: 41,
      editable: true,
      secret: true,
      filled: true,
    });
    const { input } = toPromptInput(parsed);
    expect(input.screen.nodes.slice(-3)).toEqual([
      { i: 40, t: "(입력되어 있음)", state: ["editable", "filled"] },
      { i: 41, state: ["editable", "secret", "filled"] },
      { i: 42, state: ["editable", "secret"] },
    ]);
  });

  it("오늘 날짜(한국 시각)·mode·user_reply 를 넣는다", () => {
    const { input } = toPromptInput(
      request({ userReply: "네", mode: "solo" }),
      new Date("2026-11-26T16:00:00.000Z"), // 한국 27일 새벽 1시
    );
    expect(input).toMatchObject({ today: "2026-11-27 (금)", user_reply: "네", mode: "solo" });
    expect(todayInSeoul(new Date("2026-11-26T03:00:00.000Z"))).toBe("2026-11-26 (목)");
    expect(toPromptInput(request()).input).toMatchObject({ user_reply: "", mode: "guide" });
  });

  it("어르신이 말한 번호는 [번호N] 으로 보내고, 화면의 번호는 *** 로 가린다", () => {
    const req = request({
      utterance: "김민정 추가해 줘 / 010-1234-5678",
      slots: { answer: "010-1234-5678", state: "입력 중: 전화번호" },
    });
    req.screen.nodes.push({ i: 30, t: "최근 통화 010-9999-8888" });
    const { input, phones } = toPromptInput(req);
    const sent = JSON.stringify(input);
    expect(input.utterance).toBe("김민정 추가해 줘 / [번호1]");
    expect(input.slots).toMatchObject({ answer: "[번호1]" });
    expect(sent).not.toContain("1234");
    expect(sent).not.toContain("9999");
    expect(phones.get("[번호1]")).toBe("010-1234-5678");
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
  const ids = new Map([
    [12, "카카오톡"],
    [13, "유튜브"],
  ]);
  const say = "화면 왼쪽 가운데의 카카오톡을 누르세요.";

  it("tap 은 highlight, status 를 함께 보낸다", () => {
    expect(finalize(1, output({}), ids)).toEqual({
      requestId: 1,
      type: "highlight",
      say,
      status: "in_progress",
      target: 12,
      targetText: "카카오톡",
    });
  });

  it("화면에 없는 target 이면 say 로 낮춘다", () => {
    expect(finalize(1, output({ target_id: 99 }), ids)).toEqual({
      requestId: 1,
      type: "say",
      say: FALLBACK_SAY.unsure,
    });
    expect(finalize(1, output({ action: "type", target_id: null }), ids).say).toBe(
      FALLBACK_SAY.unsure,
    );
  });

  it("type 은 suggest + typeText, chips 에도 같은 글자 (v3 앱 호환)", () => {
    expect(
      finalize(1, output({ action: "type", target_id: 13, type_text: "화면 자동 꺼짐" }), ids),
    ).toMatchObject({
      type: "suggest",
      target: 13,
      typeText: "화면 자동 꺼짐",
      chips: ["화면 자동 꺼짐"],
    });
  });

  it("입력 칸(editable)을 tap 으로 가리키면 suggest 로 바꾼다", () => {
    expect(finalize(1, output({ target_id: 13 }), ids, { editable: new Set([13]) })).toMatchObject({
      type: "suggest",
      target: 13,
      chips: [],
    });
    expect(finalize(1, output({ target_id: 12 }), ids, { editable: new Set([13]) }).type).toBe(
      "highlight",
    );
  });

  it("자리표시는 번호 칸일 때만 진짜 번호로 되돌린다", () => {
    const phones = new Map([["[번호1]", "010-1234-5678"]]);
    const nodes = new Map([
      [20, "전화번호"],
      [21, "이름"],
      [22, ""],
    ]);
    const typed = (target: number, inputState?: string) =>
      finalize(
        1,
        output({
          action: "type",
          target_id: target,
          type_text: "[번호1]",
          speech: "번호 칸에 [번호1]을 넣을게요.",
        }),
        nodes,
        { phones, ...(inputState ? { inputState } : {}) },
      );
    expect(typed(20)).toMatchObject({
      type: "suggest",
      typeText: "010-1234-5678",
      chips: ["010-1234-5678"],
      say: "번호 칸에 말씀하신 번호을 넣을게요.",
    });
    expect(typed(21)).not.toHaveProperty("typeText");
    // 칸 글자가 없으면 앱이 알려 준 입력 상태로
    expect(typed(22, "키보드 열림 · 입력 중: 전화번호")).toMatchObject({
      typeText: "010-1234-5678",
    });
    expect(typed(22, "입력 중: 이름")).not.toHaveProperty("typeText");
  });

  it("비밀 칸에는 AI 가 무엇을 내든 넣을 글자를 주지 않는다", () => {
    const result = finalize(
      1,
      output({
        action: "type",
        target_id: 13,
        type_text: "1234",
        speech: "그 칸은 직접 입력해 주세요.",
      }),
      ids,
      { editable: new Set([13]), secret: new Set([13]) },
    );
    expect(result).toMatchObject({ type: "suggest", target: 13, chips: [] });
    expect(result).not.toHaveProperty("typeText");
    // tap 으로 가리켜도 같다
    expect(
      finalize(1, output({ action: "tap", target_id: 13 }), ids, {
        editable: new Set([13]),
        secret: new Set([13]),
      }),
    ).toMatchObject({ type: "suggest", chips: [] });
  });

  it("type_text 가 비었거나 개인정보가 가려지면 typeText 없이 빈 chips", () => {
    for (const typeText of ["", "010-1234-5678", null]) {
      const result = finalize(1, output({ action: "type", type_text: typeText }), ids);
      expect(result).toMatchObject({ type: "suggest", chips: [] });
      expect(result).not.toHaveProperty("typeText");
    }
  });

  it("밀기는 손가락 방향 그대로 dir, 밀 영역과 seekText 를 붙인다", () => {
    const cases = [
      ["swipe_up", "up"],
      ["swipe_down", "down"],
      ["swipe_left", "left"],
      ["swipe_right", "right"],
    ] as const;
    for (const [action, dir] of cases) {
      expect(finalize(1, output({ action, target_id: null }), ids)).toMatchObject({
        type: "swipe",
        dir,
      });
    }
    expect(
      finalize(1, output({ action: "swipe_up", target_id: 13, seek: "디스플레이" }), ids),
    ).toMatchObject({ type: "swipe", dir: "up", target: 13, seekText: "디스플레이" });
  });

  it("밀 영역이 화면에 없으면 target 만 빼고 밀기는 살린다", () => {
    const result = finalize(1, output({ action: "swipe_up", target_id: 99 }), ids);
    expect(result).toMatchObject({ type: "swipe", dir: "up" });
    expect(result).not.toHaveProperty("target");
  });

  it("clarify 는 ask + options(4개, 가린 값 뺌) + fact", () => {
    const result = finalize(
      1,
      output({
        status: "clarify",
        action: "none",
        target_id: null,
        options: ["네, 있어요", "아니요", "010-1234-5678", "a", "b", "c"],
        fact: "site_membership",
      }),
      ids,
    );
    expect(result).toEqual({
      requestId: 1,
      type: "ask",
      say,
      status: "clarify",
      options: ["네, 있어요", "아니요", "a", "b"],
      fact: "site_membership",
    });
    const plain = finalize(1, output({ status: "clarify", action: "none", options: [] }), ids);
    expect(plain).not.toHaveProperty("options");
    expect(plain).not.toHaveProperty("fact");
  });

  it("done 은 done, home·back 은 say + nav, stopped·none 은 say", () => {
    expect(finalize(1, output({ status: "done", action: "none" }), ids)).toMatchObject({
      type: "done",
      status: "done",
    });
    expect(finalize(1, output({ status: "off_track", action: "back" }), ids)).toMatchObject({
      type: "say",
      status: "off_track",
      nav: "back",
    });
    expect(finalize(1, output({ action: "home", target_id: 12 }), ids)).not.toHaveProperty(
      "target",
    );
    expect(finalize(1, output({ status: "stopped", action: "none" }), ids)).toEqual({
      requestId: 1,
      type: "say",
      say,
      status: "stopped",
    });
  });

  it("targetText 는 가린 글자로, 글자가 없는 요소면 빼고 보낸다", () => {
    const nodes = new Map([
      [1, "010-1234-5678 에게 전화"],
      [2, ""],
    ]);
    expect(finalize(1, output({ target_id: 1 }), nodes)).toMatchObject({
      target: 1,
      targetText: "*** 에게 전화",
    });
    expect(finalize(1, output({ target_id: 2 }), nodes)).not.toHaveProperty("targetText");
  });

  it("speech 는 80자로 자르고 쓰지 않는 필드는 빼고 보낸다", () => {
    const result = finalize(
      1,
      output({ action: "none", speech: "가".repeat(100), target_id: 12 }),
      ids,
    );
    expect(result.say).toHaveLength(80);
    expect(result).not.toHaveProperty("target");
  });
});

describe("nodeTexts", () => {
  // 에뮬레이터 설정 화면에서 본 모양: 눌리는 줄(13)에는 글자가 없고 제목·부제는 안쪽 요소에 있다
  const settingsRow = () =>
    request({
      screen: {
        pkg: "com.android.settings",
        width: 1080,
        height: 2220,
        nodes: [
          { i: 12, t: "Network & internet", b: [190, 900, 1080, 960] },
          { i: 13, c: "android.widget.LinearLayout", b: [0, 1100, 1080, 1210], clickable: true },
          { i: 14, t: "Dark theme, font size, brightness", b: [190, 1160, 1080, 1200] },
          { i: 15, t: "Display", b: [190, 1110, 1080, 1155] },
          { i: 16, d: "Display icon", b: [40, 1120, 120, 1190] },
          { i: 17, c: "android.widget.FrameLayout", b: [0, 1300, 1080, 1400], clickable: true },
        ],
      },
    });

  it("자기 글자가 없으면 영역 안의 글자 중 위쪽·왼쪽 것을 쓴다", () => {
    const texts = nodeTexts(settingsRow());
    expect(texts.get(13)).toBe("Display");
    expect(texts.get(15)).toBe("Display");
  });

  it("영역 안에 글자가 없거나 위치가 없으면 빈 글자", () => {
    const texts = nodeTexts(settingsRow());
    expect(texts.get(17)).toBe("");
  });

  it("finalize 응답의 targetText 로 이어진다", () => {
    expect(finalize(1, output({ target_id: 13 }), nodeTexts(settingsRow()))).toMatchObject({
      target: 13,
      targetText: "Display",
    });
  });
});

describe("guide", () => {
  it("노드가 0개면 모델을 부르지 않고 empty 문장", async () => {
    const model = vi.fn<GuideModel>();
    const empty = request();
    empty.screen.nodes = [];
    await expect(guide(empty, model, log)).resolves.toEqual({
      requestId: 108,
      type: "say",
      say: FALLBACK_SAY.empty,
    });
    expect(model).not.toHaveBeenCalled();
  });

  it("모델 결과를 후처리해 돌려준다", async () => {
    await expect(guide(request(), okModel(), log)).resolves.toMatchObject({
      requestId: 108,
      type: "highlight",
      target: 12,
    });
  });

  it("비밀번호 입력 칸이 있는 화면은 모델을 부르지 않는다", async () => {
    const model = vi.fn<GuideModel>();
    const secret = request();
    secret.screen.nodes.push({
      i: 14,
      d: "비밀번호 입력",
      editable: true,
      b: [100, 800, 900, 900],
    });
    expect(isSecretScreen(secret)).toBe(true);
    await expect(guide(secret, model, log)).resolves.toMatchObject({ say: FALLBACK_SAY.secret });
    expect(model).not.toHaveBeenCalled();
  });

  it("입력 칸 바로 위·왼쪽의 짧은 이름표도 본다", () => {
    for (const label of [
      { i: 20, t: "주민등록번호", b: [100, 700, 500, 760] as [number, number, number, number] }, // 위
      { i: 20, t: "PIN", b: [0, 820, 90, 880] as [number, number, number, number] }, // 왼쪽
      { i: 20, t: "암호" }, // 위치 모름 → 보수적으로 이름표
    ]) {
      const screen = request();
      screen.screen.nodes.push(label, { i: 21, editable: true, b: [100, 800, 900, 900] });
      expect(isSecretScreen(screen)).toBe(true);
    }
  });

  it("비밀 칸(secret:true)은 글자를 지우고, 화면은 막지 않고 모델을 부른다", async () => {
    const login = request({
      screen: {
        pkg: "com.coupang.mobile",
        width: 1000,
        height: 2000,
        nodes: [
          { i: 0, t: "아이디", b: [100, 500, 400, 550] },
          { i: 1, editable: true, b: [100, 560, 900, 660] },
          { i: 2, t: "비밀번호", b: [100, 700, 400, 750] },
          // 앱이 실수로 글자를 실어 보내도 서버가 받자마자 지운다
          {
            i: 3,
            editable: true,
            secret: true,
            t: "mypass123",
            d: "비밀번호 입력",
            b: [100, 760, 900, 860],
          },
          { i: 4, t: "로그인", clickable: true, b: [100, 900, 900, 1000] },
        ],
      },
    });
    expect(login.screen.nodes[3]).toEqual({
      i: 3,
      editable: true,
      secret: true,
      b: [100, 760, 900, 860],
    });
    expect(isSecretScreen(login)).toBe(false);

    const model = vi.fn<GuideModel>(okModel({ action: "tap", target_id: 1 }));
    await guide(login, model, log);
    const sent = JSON.stringify(model.mock.calls[0]?.[0]);
    expect(sent).not.toContain("mypass123");
    expect(model.mock.calls[0]?.[0].screen.nodes[3]).toMatchObject({
      i: 3,
      state: ["editable", "secret"],
    });

    // 표시가 없는 비밀번호 칸이면 지금처럼 막는다
    const unflagged = request();
    unflagged.screen.nodes.push(
      { i: 20, t: "비밀번호", b: [100, 700, 400, 750] },
      { i: 21, editable: true, b: [100, 760, 900, 860] },
    );
    expect(isSecretScreen(unflagged)).toBe(true);
  });

  it("안내 문구에만 민감 단어가 있거나 입력 칸이 없으면 막지 않는다", () => {
    const notice = request();
    notice.screen.nodes.push(
      {
        i: 20,
        t: "주민등록번호 뒷자리는 본인인증 화면에서 직접 입력하세요. 개인정보는 저장되지 않습니다.",
        b: [0, 300, 1000, 400],
      },
      { i: 21, d: "검색", editable: true, b: [100, 1500, 900, 1600] },
    );
    expect(isSecretScreen(notice)).toBe(false);

    const keypad = request();
    keypad.screen.nodes.push(
      { i: 20, t: "비밀번호 6자리를 입력하세요" },
      { i: 21, t: "1", clickable: true },
    );
    expect(isSecretScreen(keypad)).toBe(false);

    const far = request();
    far.screen.nodes.push(
      { i: 20, t: "비밀번호 변경", b: [0, 100, 300, 160] },
      { i: 21, d: "이름", editable: true, b: [0, 1500, 900, 1600] },
    );
    expect(isSecretScreen(far)).toBe(false);
  });

  it("은행 앱 화면도 안내한다 (잔액·계좌번호는 가려서 보낸다)", async () => {
    const model = vi.fn<GuideModel>(
      okModel({ target_id: 1, speech: "화면 위쪽의 '조회'를 누르세요." }),
    );
    const bank = request({
      goal: "BANK",
      utterance: "잔액 보여 줘",
      screen: {
        pkg: "com.kbstar.kbbank",
        width: 100,
        height: 100,
        nodes: [
          { i: 0, t: "입출금 110-123-456789" },
          { i: 1, t: "조회", clickable: true },
          { i: 2, t: "잔액 1,234,567" },
        ],
      },
    });
    await expect(guide(bank, model, log)).resolves.toMatchObject({ type: "highlight", target: 1 });
    const sent = JSON.stringify(model.mock.calls[0]?.[0]);
    expect(sent).not.toContain("456789");
    expect(sent).not.toContain("1,234,567");
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
  const { store } = memoryCoreStore();
  const at = "2026-11-26T00:00:00.000Z";
  void store.createUser({ uid: "uid-1", role: "elder", name: "", createdAt: at, updatedAt: at });
  void store.createUser({
    uid: "guardian-1",
    role: "guardian",
    name: "",
    createdAt: at,
    updatedAt: at,
  });
  const handler = createHttpHandler(
    createRouter([
      {
        method: "POST",
        path: "/v1/elder/guide",
        handler: createGuideRoute(okModel(), createProfileGuard(store)),
      },
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

  it("프로필이 없으면 403 profile-required, 보호자면 403 permission-denied", async () => {
    const body = {
      requestId: 1,
      goal: "OPEN_APP",
      screen: { pkg: "a", width: 1, height: 1, nodes: [] },
    };
    const none = await post(body, "nobody");
    expect(none.statusCode).toBe(403);
    expect(parseBody(none.body)).toMatchObject({ error: { reason: "profile-required" } });
    const guardian = await post(body, "guardian-1");
    expect(parseBody(guardian.body)).toMatchObject({ error: { reason: "permission-denied" } });
  });

  it("인증이 없으면 401", async () => {
    const result = await post({}, null);
    expect(result.statusCode).toBe(401);
  });
});
