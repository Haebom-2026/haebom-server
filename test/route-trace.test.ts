import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { judgeApp } from "../src/route/decide.js";
import type { ChoiceQuestion, JevClient, JevResult } from "../src/route/jev.js";
import { parseMap } from "../src/route/map.js";
import { SEED_MAP } from "../src/route/seed-map.js";
import { createRouteSelector } from "../src/route/select.js";
import { createTracedSelector } from "../src/route/trace.js";

const seed = parseMap(SEED_MAP);
const large = parseMap(
  JSON.parse(readFileSync(new URL("./fixtures/route-map-large.json", import.meta.url), "utf8")),
);

/** 질문 이름(app / goal)으로 답을 정하는 가짜 jev. 주지 않은 후보는 0 */
const fakeJev = (
  answer: (key: string, q: ChoiceQuestion) => Record<string, number> | "fail",
): JevClient => ({
  choose(_state, questions) {
    const answers: Record<string, { choice: string; probabilities: Record<string, number> }> = {};
    for (const [key, q] of Object.entries(questions)) {
      const given = answer(key, q);
      if (given === "fail")
        return Promise.resolve<JevResult>({ ok: false, reason: "timeout", ms: 1500 });
      const p = Object.fromEntries(Object.keys(q.criteria).map((k) => [k, given[k] ?? 0]));
      const choice = Object.entries(p).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none";
      answers[key] = { choice, probabilities: p };
    }
    return Promise.resolve<JevResult>({
      ok: true,
      answers,
      ms: 400,
      cost: 0.00004,
      inputTokens: 100,
    });
  },
});

describe("1단계 규칙 (judgeApp rule)", () => {
  const rule = (p: Record<string, number>, utterance = "x", m = seed) => {
    const j = judgeApp(m, p, utterance);
    return j.kind === "candidates" ? j.rule : j.kind === "fail" ? j.reason : j.kind;
  };

  it("후보를 낸 규칙을 붙인다", () => {
    expect(rule({ youtube: 0.95 })).toBe("exclusive");
    expect(rule({ youtube: 0.6 })).toBe("top_app");
    expect(rule({ youtube: 0.8 }, "유튜브 틀어 줘")).toBe("named");
    expect(rule({ playstore: 0.8 }, "유튜브 깔아 줘")).toBe("named_appstore");
    expect(rule({ none: 0.6, youtube: 0.3 })).toBe("none");
  });
});

describe("판정 기록 (createTracedSelector)", () => {
  it("select() 와 같은 결과 + 1·2단계 확률·탄 규칙·가린 말", async () => {
    const jev = fakeJev((key, q) =>
      key === "app"
        ? { gov24: 0.7, none: 0.1 }
        : q.instructions.includes("정부24")
          ? { resident_copy: 0.5, resident_abstract: 0.42 }
          : {},
    );
    const input = { utterance: "서류 떼 줘 010-1234-5678" };
    const plain = await createRouteSelector({ jev, map: seed, now: () => 0 }).select(input);
    const { selection, trace } = await createTracedSelector({
      jev,
      map: seed,
      now: () => 0,
    }).select(input);

    expect(selection).toEqual(plain);
    expect(trace.masked).not.toContain("5678");
    expect(trace.app).toMatchObject({ ok: true, rule: "top_app", mention: { kind: "none" } });
    expect(trace.app?.probs[0]).toEqual(["gov24", 0.7]);
    expect(trace.app?.roles[0]?.[1]).toBeCloseTo(0.7);
    expect(trace.goals).toEqual([
      expect.objectContaining({
        appId: "gov24",
        judged: "ask",
        probs: expect.arrayContaining([["gov24.resident_copy", 0.5]]) as unknown,
      }),
    ]);
    expect(trace.thresholds.app).toBe(0.5);
  });

  it("하려는 일 물음과 jev 실패도 남긴다", async () => {
    const ask = await createTracedSelector({
      jev: fakeJev(() => ({ contacts: 0.3, naver: 0.28, none: 0.25 })),
      map: large,
    }).select({ utterance: "임영웅 찾아 줘" });
    expect(ask.trace.app?.rule).toBe("ask_intent");

    const down = await createTracedSelector({ jev: fakeJev(() => "fail"), map: seed }).select({
      utterance: "x",
    });
    expect(down.selection).toMatchObject({ kind: "fail", reason: "jev_timeout" });
    expect(down.trace.app).toMatchObject({ ok: false, reason: "timeout", probs: [] });
    expect(down.trace.app?.rule).toBeUndefined();
  });
});
