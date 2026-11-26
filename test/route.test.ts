import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  appQuestion,
  findAppMention,
  goalQuestion,
  judgeApp,
  judgeGoal,
} from "../src/route/decide.js";
import {
  createJevClient,
  type ChoiceQuestion,
  type JevClient,
  type JevResult,
} from "../src/route/jev.js";
import { parseMap, type MapInput } from "../src/route/map.js";
import { SEED_MAP } from "../src/route/seed-map.js";
import { byGoalStrength, createRouteSelector, type RouteCandidate } from "../src/route/select.js";

const seed = parseMap(SEED_MAP);
const large = parseMap(
  JSON.parse(readFileSync(new URL("./fixtures/route-map-large.json", import.meta.url), "utf8")),
);

/** 확률을 일부만 주면 나머지 후보는 0 */
const probs = (q: ChoiceQuestion, given: Record<string, number>) =>
  Object.fromEntries(Object.keys(q.criteria).map((k) => [k, given[k] ?? 0]));

describe("지도", () => {
  it("seed 와 큰 지도가 확인을 통과한다", () => {
    expect(seed.map.apps).toHaveLength(10);
    expect(large.map.apps.length).toBeGreaterThan(50);
    expect(seed.goalsByApp.get("settings")?.some((g) => g.id === "settings.brightness_down")).toBe(
      true,
    );
  });

  it("중복 id, 없는 역할, 민감한 역할의 기본 앱을 거부한다", () => {
    const bad: MapInput = {
      version: "t",
      roles: [{ id: "bank", name: "은행", sensitive: true, defaultApp: "kb" }],
      apps: [
        { id: "kb", name: "KB", desc: "은행", roles: ["bank"], packages: ["a"] },
        { id: "kb", name: "KB2", desc: "은행", roles: ["nope"], packages: ["b"] },
      ],
      goals: [],
    };
    expect(() => parseMap(bad)).toThrow(
      /app id 중복[\s\S]*없는 역할 nope[\s\S]*기본 앱을 두지 않음/,
    );
  });

  it("앱 질문에는 모든 앱과 none, 목표 질문에는 그 앱의 목표와 none", () => {
    const q = appQuestion(seed);
    expect(Object.keys(q.criteria)).toHaveLength(11);
    expect(q.criteria.none).toBeDefined();
    const g = goalQuestion(seed, "gov24");
    expect(g.kind).toBe("ask");
    if (g.kind === "ask") expect(Object.keys(g.question.criteria)).toContain("resident_copy");
    expect(goalQuestion(seed, "camera").kind).toBe("none");
  });
});

describe("1단계 판정 (judgeApp)", () => {
  const q = appQuestion(large);
  const sq = appQuestion(seed);
  const order = (j: ReturnType<typeof judgeApp>) =>
    j.kind === "candidates" ? j.candidates.map((c) => [c.appId, c.by]) : j.kind;

  it("'해당 없음'이 1등 앱 이상이면 역할 합계가 커도 실패 (해당 없음을 먼저 봄)", () => {
    const j = judgeApp(large, probs(q, { melon: 0.4, genie: 0.15, none: 0.45 }), "노래 틀어 줘");
    expect(j).toMatchObject({ kind: "fail", reason: "none" });
  });

  it("말에 앱 이름이 있고 jev 1등도 그 앱 → 그 앱 하나 (확률이 낮아도)", () => {
    const j = judgeApp(
      large,
      probs(q, { kakaotalk: 0.45, messages: 0.3, none: 0.25 }),
      "손녀한테 카톡 보내 줘",
    );
    expect(j).toMatchObject({ kind: "candidates", named: true, role: "messaging" });
    expect(order(j)).toEqual([["kakaotalk", "named"]]);
  });

  it("말한 앱과 jev 1등이 다르면 route 없음", () => {
    const j = judgeApp(large, probs(q, { youtube: 0.8, melon: 0.1 }), "멜론에서 트로트 들려 줘");
    expect(j).toMatchObject({ kind: "fail", reason: "named_mismatch" });
  });

  it("지도 밖 앱 이름(seed 의 멜론)이 있으면 route 없음", () => {
    const j = judgeApp(seed, probs(sq, { youtube: 0.9 }), "멜론에서 트로트 들려 줘");
    expect(j).toMatchObject({ kind: "fail", reason: "unknown_app" });
  });

  it("앱 이름 + 깔아 줘 → Play 스토어, 말한 앱 이름을 같이 (지도 밖 앱도)", () => {
    const j = judgeApp(seed, probs(sq, { playstore: 0.9 }), "배달의민족 깔아 줘");
    expect(j).toMatchObject({ kind: "candidates", named: true, mentionedApp: "배달의민족" });
    expect(order(j)).toEqual([["playstore", "named"]]);
  });

  it("다른 앱 이름이 같은 길이로 둘이면 route 없음", () => {
    const j = judgeApp(large, probs(q, { toss: 0.6 }), "토스로 카톡 보내 줘");
    expect(j).toMatchObject({ kind: "fail", reason: "named_ambiguous" });
  });

  it("가장 긴 앱 이름이 이긴다 (유튜브 뮤직 > 유튜브)", () => {
    expect(findAppMention(large, "유튜브 뮤직 틀어 줘")).toMatchObject({
      kind: "map",
      appId: "ytmusic",
    });
    expect(findAppMention(seed, "정부 24 열어 줘")).toMatchObject({ kind: "map", appId: "gov24" });
  });

  it("1등 앱 ≥ 0.5 면 그 앱 먼저, 뒤에 같은 역할 앱 (선호 → 기본 → 확률)", () => {
    const j = judgeApp(
      large,
      probs(q, { melon: 0.55, genie: 0.2, youtube: 0.1, none: 0.15 }),
      "트로트 틀어 줘",
      {
        music: "genie",
      },
    );
    expect(j).toMatchObject({ kind: "candidates", named: false });
    expect(order(j)).toEqual([
      ["melon", "jev"],
      ["genie", "pref"],
      ["youtube", "default"],
    ]);
  });

  it("말한 앱이 아니어도 jev 가 아주 확실하면(≥0.9) 그 앱만 — 없으면 설치를 물음", () => {
    const j = judgeApp(large, probs(q, { korail: 0.95, srt: 0.03 }), "서울 가는 KTX 표 끊어 줘");
    expect(j).toMatchObject({ kind: "candidates", named: false, exclusive: true });
    expect(order(j)).toEqual([["korail", "jev"]]);
  });

  it("앱이 갈리면 역할 합계로, 순서는 선호 → 기본 → 확률", () => {
    const j = judgeApp(
      large,
      probs(q, { melon: 0.35, genie: 0.2, youtube: 0.15, none: 0.3 }),
      "노래 좀 틀어 봐",
    );
    expect(j).toMatchObject({ kind: "candidates", role: "music", named: false });
    expect(order(j)).toEqual([
      ["youtube", "default"],
      ["melon", "jev"],
      ["genie", "jev"],
    ]);
  });

  it("민감한 역할은 ask, 기본 앱 없음", () => {
    const j = judgeApp(large, probs(q, { nh_bank: 0.3, kb_bank: 0.3, none: 0.25 }), "돈 보내야 돼");
    expect(j).toMatchObject({ kind: "candidates", role: "bank", ask: true });
    if (j.kind === "candidates") expect(j.candidates.every((c) => c.by === "jev")).toBe(true);
  });

  it("두 역할이 비슷하면 역할을 확정하기 전에 하려는 일을 묻는다", () => {
    const j = judgeApp(
      large,
      probs(q, { contacts: 0.3, naver: 0.28, none: 0.25 }),
      "임영웅 찾아 줘",
    );
    expect(j).toMatchObject({ kind: "ask_intent", roles: ["contacts", "search"] });
    // 1등 앱이 0.5 를 넘어도 두 역할이 비슷하면 묻는다
    const k = judgeApp(large, probs(q, { contacts: 0.5, naver: 0.4, none: 0.1 }), "김철수 찾아 줘");
    expect(k).toMatchObject({ kind: "ask_intent" });
  });

  it("두 역할이 같은 1등 앱에서 나왔으면(유튜브 = 영상·음악) 묻지 않고 그 앱", () => {
    const j = judgeApp(
      large,
      probs(q, { youtube: 0.3, none: 0.25, melon: 0.05 }),
      "아까 본 영상 다시 보고 싶어",
    );
    expect(j).toMatchObject({ kind: "candidates", named: false });
    if (j.kind === "candidates") expect(j.candidates[0]).toEqual({ appId: "youtube", by: "jev" });
  });
});

describe("2단계 판정 (judgeGoal)", () => {
  it("확실하면 그 목표", () => {
    expect(judgeGoal({ resident_copy: 0.9, resident_abstract: 0.08, none: 0.02 })).toEqual({
      kind: "goal",
      key: "resident_copy",
      confidence: 0.9,
    });
  });
  it("두 목표가 비슷하면 묻는다", () => {
    expect(judgeGoal({ resident_copy: 0.5, resident_abstract: 0.4, none: 0.1 })).toMatchObject({
      kind: "ask",
      keys: ["resident_copy", "resident_abstract"],
    });
  });
  it("none 이 1등이거나 애매하면 앱만", () => {
    expect(judgeGoal({ search: 0.3, none: 0.6, open: 0.1 }).kind).toBe("none");
    expect(judgeGoal({ search: 0.65, open: 0.25, none: 0.1 }).kind).toBe("none");
  });
});

describe("jev 호출", () => {
  const question: ChoiceQuestion = {
    instructions: "i",
    criteria: { a: "A", b: "B", none: "없음" },
  };
  const respond =
    (body: unknown, status = 200): typeof fetch =>
    () =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
  const client = (f: typeof fetch) =>
    createJevClient({ apiKey: () => Promise.resolve("k"), fetch: f });

  it("응답을 검증하고 빠진 후보 확률은 0", async () => {
    let sent: { url: string; body: unknown; auth: string | null } | undefined;
    const reply = respond({
      answers: { q: { choice: "a", probabilities: { a: 0.8, b: 0.2 } } },
      usage: { cost: 0.00004 },
    });
    const f: typeof fetch = (url, init) => {
      sent = {
        url: url instanceof Request ? url.url : url.toString(),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        auth: new Headers(init?.headers).get("authorization"),
      };
      return reply(url, init);
    };
    const res = await client(f).choose("상태", { q: question });
    expect(res).toMatchObject({
      ok: true,
      cost: 0.00004,
      answers: { q: { choice: "a", probabilities: { a: 0.8, b: 0.2, none: 0 } } },
    });
    expect(sent?.auth).toBe("Bearer k");
    expect(sent?.body).toMatchObject({
      model: "typesafe/jev-1.14",
      state: "상태",
      questions: { q: { type: "choice" } },
    });
  });

  it("묻지 않은 후보를 고르면 invalid, HTTP 오류는 http, 시간 초과는 timeout", async () => {
    const bad = await client(
      respond({ answers: { q: { choice: "zzz", probabilities: {} } } }),
    ).choose("s", { q: question });
    expect(bad).toMatchObject({ ok: false, reason: "invalid" });
    const http = await client(respond({}, 500)).choose("s", { q: question });
    expect(http).toMatchObject({ ok: false, reason: "http", status: 500 });
    const slow: typeof fetch = () => Promise.reject(new DOMException("t", "TimeoutError"));
    expect(await client(slow).choose("s", { q: question })).toMatchObject({
      ok: false,
      reason: "timeout",
    });
    expect(await client(slow).choose("s", { q: question }, { timeoutMs: 0 })).toMatchObject({
      ok: false,
      reason: "timeout",
    });
  });
});

describe("고르기 (select)", () => {
  /** 질문 이름(app / goal)과 앱 질문 여부로 답을 정하는 가짜 jev */
  const fakeJev = (
    answer: (key: string, q: ChoiceQuestion) => Record<string, number> | "fail",
  ): JevClient & { states: string[] } => {
    const states: string[] = [];
    return {
      states,
      choose(state, questions) {
        states.push(state);
        const answers: Record<string, { choice: string; probabilities: Record<string, number> }> =
          {};
        for (const [key, q] of Object.entries(questions)) {
          const given = answer(key, q);
          if (given === "fail")
            return Promise.resolve<JevResult>({ ok: false, reason: "timeout", ms: 1500 });
          const p = probs(q, given);
          const choice = Object.entries(p).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none";
          answers[key] = { choice, probabilities: p };
        }
        return Promise.resolve<JevResult>({
          ok: true,
          answers,
          ms: 500,
          cost: 0.00004,
          inputTokens: 100,
        });
      },
    };
  };

  it("앱 → 목표, 후보마다 민감도, 가린 말만 보냄", async () => {
    const jev = fakeJev((key, q) =>
      key === "app"
        ? { gov24: 0.95 }
        : q.instructions.includes("정부24")
          ? { resident_copy: 0.9 }
          : {},
    );
    const res = await createRouteSelector({ jev, map: seed }).select({
      utterance: "등본 떼 줘 010-1234-5678",
    });
    expect(res).toMatchObject({
      kind: "route",
      named: false,
      candidates: [
        {
          appId: "gov24",
          level: "L2",
          goal: { id: "gov24.resident_copy", name: "등본", verified: true },
        },
      ],
    });
    expect(jev.states.every((s) => s.includes("***") && !s.includes("5678"))).toBe(true);
  });

  it("두 목표가 비슷하면 그 후보에 clarify", async () => {
    const jev = fakeJev((key) =>
      key === "app" ? { gov24: 0.9 } : { resident_copy: 0.5, resident_abstract: 0.42 },
    );
    const res = await createRouteSelector({ jev, map: seed }).select({ utterance: "서류 떼 줘" });
    if (res.kind !== "route") throw new Error(res.kind);
    expect(res.candidates[0]?.clarify).toEqual({
      questionId: "goal:gov24",
      say: "등본인가요, 초본인가요?",
      options: [
        { id: "gov24.resident_copy", name: "등본" },
        { id: "gov24.resident_abstract", name: "초본" },
      ],
    });
  });

  it("1단계 실패는 fail, 2단계 실패는 앱만", async () => {
    const down = fakeJev(() => "fail");
    expect(
      await createRouteSelector({ jev: down, map: seed }).select({ utterance: "x" }),
    ).toMatchObject({
      kind: "fail",
      reason: "jev_timeout",
    });
    const half = fakeJev((key) => (key === "app" ? { youtube: 0.9 } : "fail"));
    const res = await createRouteSelector({ jev: half, map: seed }).select({
      utterance: "임영웅 틀어 줘",
    });
    expect(res).toMatchObject({ kind: "route", candidates: [{ appId: "youtube" }] });
    if (res.kind === "route") expect(res.candidates[0]?.goal).toBeUndefined();
  });

  it("목표가 없는 앱은 2단계를 부르지 않는다", async () => {
    const jev = fakeJev((key) => (key === "app" ? { camera: 0.9 } : {}));
    await createRouteSelector({ jev, map: seed }).select({ utterance: "사진 찍고 싶어" });
    expect(jev.states).toHaveLength(1);
  });
  it("하려는 일을 물을 때 clarify (역할 이름)", async () => {
    const jev = fakeJev(() => ({ contacts: 0.3, naver: 0.28, none: 0.25 }));
    const res = await createRouteSelector({ jev, map: large }).select({
      utterance: "임영웅 찾아 줘",
    });
    expect(res).toMatchObject({
      kind: "ask_intent",
      clarify: {
        questionId: "intent",
        options: [
          { id: "contacts", name: "연락처" },
          { id: "search", name: "인터넷 검색" },
        ],
      },
    });
  });
});

describe("후보 순서: 목표가 약해지는 후보는 뒤로 (byGoalStrength)", () => {
  const c = (appId: string, goal?: string): RouteCandidate => ({
    appId,
    name: appId,
    packages: [appId],
    by: "jev",
    level: "L0",
    ...(goal
      ? {
          goal: {
            id: goal,
            version: 1,
            name: goal,
            level: "L0",
            slots: [],
            confidence: 0.9,
            verified: true,
          },
        }
      : {}),
  });
  it("구체 목표가 정해진 후보가 있으면 목표 없음·열기뿐인 후보를 뒤로", () => {
    const out = byGoalStrength([
      c("melon"),
      c("youtube", "youtube.search"),
      c("genie", "genie.open"),
    ]);
    expect(out.map((x) => x.appId)).toEqual(["youtube", "melon", "genie"]);
  });
  it("구체 목표가 하나도 없으면 순서 그대로", () => {
    const out = byGoalStrength([c("melon"), c("genie", "genie.open")]);
    expect(out.map((x) => x.appId)).toEqual(["melon", "genie"]);
  });
});
