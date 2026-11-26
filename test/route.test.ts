import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appQuestion, goalQuestion, judgeApp, judgeGoal } from "../src/route/decide.js";
import {
  createJevClient,
  type ChoiceQuestion,
  type JevClient,
  type JevResult,
} from "../src/route/jev.js";
import { parseMap, type MapInput } from "../src/route/map.js";
import { SEED_MAP } from "../src/route/seed-map.js";
import { createRouteSelector } from "../src/route/select.js";

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

  it("말한 앱이 분명하면(≥0.7) 그 앱 하나만 — 같은 역할 앱으로 바꾸지 않음", () => {
    const j = judgeApp(large, probs(q, { kakaotalk: 0.93, messages: 0.05 }));
    expect(j).toMatchObject({ kind: "candidates", named: true, role: "messaging" });
    if (j.kind === "candidates")
      expect(j.candidates).toEqual([{ appId: "kakaotalk", by: "named" }]);
  });

  it("1등 앱 ≥ 0.5 면 그 앱 먼저, 뒤에 같은 역할 앱 (선호 → 기본 → 확률)", () => {
    const j = judgeApp(large, probs(q, { melon: 0.55, genie: 0.2, youtube: 0.1 }), {
      music: "genie",
    });
    expect(j.kind).toBe("candidates");
    if (j.kind !== "candidates") return;
    expect(j.named).toBe(false);
    expect(j.candidates.map((c) => [c.appId, c.by])).toEqual([
      ["melon", "jev"],
      ["genie", "pref"],
      ["youtube", "default"],
    ]);
  });

  it("앱이 갈리면 역할 합계로 (멜론 0.3 + 지니 0.2 + 유튜브 0.2)", () => {
    const j = judgeApp(large, probs(q, { melon: 0.3, genie: 0.2, youtube: 0.2, none: 0.3 }));
    expect(j).toMatchObject({ kind: "candidates", role: "music", named: false });
    if (j.kind === "candidates")
      expect(j.candidates[0]).toEqual({ appId: "youtube", by: "default" });
  });

  it("민감한 역할은 ask, 기본 앱 없음", () => {
    const j = judgeApp(large, probs(q, { nh_bank: 0.3, kb_bank: 0.3, none: 0.4 }));
    expect(j).toMatchObject({ kind: "candidates", role: "bank", ask: true });
    if (j.kind === "candidates") expect(j.candidates.every((c) => c.by === "jev")).toBe(true);
  });

  it("두 역할이 비슷하면 하려는 일을 묻는다", () => {
    const j = judgeApp(large, probs(q, { contacts: 0.3, naver: 0.28, none: 0.42 }));
    expect(j).toMatchObject({ kind: "ask_intent", roles: ["contacts", "search"] });
  });

  it("두 역할이 같은 1등 앱에서 나왔으면(유튜브 = 영상·음악) 묻지 않고 그 앱", () => {
    const j = judgeApp(large, probs(q, { youtube: 0.3, none: 0.45, melon: 0.05 }));
    expect(j).toMatchObject({ kind: "candidates", named: false });
    if (j.kind === "candidates") expect(j.candidates[0]).toEqual({ appId: "youtube", by: "jev" });
  });

  it("none 이 크면 실패 (Claude)", () => {
    expect(judgeApp(large, probs(q, { none: 0.8, playstore: 0.2 }))).toMatchObject({
      kind: "fail",
      reason: "none",
    });
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
      named: true,
      candidates: [
        { appId: "gov24", level: "L2", goal: { id: "gov24.resident_copy", name: "등본" } },
      ],
    });
    expect(jev.states.every((s) => s.includes("***") && !s.includes("5678"))).toBe(true);
  });

  it("두 목표가 비슷하면 goalOptions", async () => {
    const jev = fakeJev((key) =>
      key === "app" ? { gov24: 0.9 } : { resident_copy: 0.5, resident_abstract: 0.42 },
    );
    const res = await createRouteSelector({ jev, map: seed }).select({ utterance: "서류 떼 줘" });
    if (res.kind !== "route") throw new Error(res.kind);
    expect(res.candidates[0]?.goalOptions).toEqual([
      { id: "gov24.resident_copy", name: "등본" },
      { id: "gov24.resident_abstract", name: "초본" },
    ]);
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
});
