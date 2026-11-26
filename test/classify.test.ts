import { describe, expect, it } from "vitest";
import { chooseApp, classify, maxLevel, type ClassifyDeps } from "../src/ai/classify.js";
import type { ClassifyModel, ClassifyModelInput } from "../src/ai/classify-model.js";
import {
  chooseAppRequestSchema,
  classifyRequestSchema,
  type ClassifyModelOutput,
} from "../src/ai/classify-schema.js";
import { createProfileGuard } from "../src/core/profile.js";
import { createChooseAppRoute, createClassifyRoute } from "../src/functions/ai/routes/classify.js";
import type { CommandRecord, CommandStore, UpdateResult } from "../src/route/command-store.js";
import type { RouteCandidate, RouteSelection, RouteSelector } from "../src/route/select.js";
import { ApiError } from "../src/shared/errors.js";
import { createHttpHandler } from "../src/shared/handler.js";
import { createLogger } from "../src/shared/logger.js";
import { createRouter } from "../src/shared/router.js";
import { memoryCoreStore } from "./core-memory-store.js";
import { httpEvent, lambdaContext, parseBody } from "./helpers.js";

const log = createLogger({}, { write: () => undefined });

/** DynamoDB 조건식과 같은 규칙: create 는 살아 있는 명령이 없을 때만, update 는 rev 가 같을 때만 */
function memoryCommands(): CommandStore & { records: Map<string, CommandRecord> } {
  const records = new Map<string, CommandRecord>();
  const key = (uid: string, id: number) => `${uid}|${id}`;
  return {
    records,
    create(record) {
      if (records.has(key(record.uid, record.commandId))) return Promise.resolve("exists" as const);
      records.set(key(record.uid, record.commandId), structuredClone(record));
      return Promise.resolve("created" as const);
    },
    get(uid, id) {
      const r = records.get(key(uid, id));
      return Promise.resolve(r ? structuredClone(r) : undefined);
    },
    update(uid, id, read, set, remove = []): Promise<UpdateResult> {
      const r = records.get(key(uid, id));
      if (!r) return Promise.resolve("missing");
      if (r.gen !== read.gen || r.rev !== read.rev) return Promise.resolve("conflict");
      for (const [field, value] of Object.entries(set)) {
        Object.assign(r, { [field]: structuredClone(value) });
      }
      if (remove.includes("route")) delete r.route;
      if (remove.includes("clarify")) delete r.clarify;
      r.rev += 1;
      return Promise.resolve("ok");
    },
  };
}

const output = (over: Partial<ClassifyModelOutput> = {}): ClassifyModelOutput => ({
  intent: "OPEN_APP",
  app: null,
  level: "L0",
  category: "none",
  reason: "일반 명령",
  ...over,
});

function fakeModel(result: ClassifyModelOutput | "fail") {
  const inputs: ClassifyModelInput[] = [];
  const model: ClassifyModel = (input) => {
    inputs.push(input);
    return Promise.resolve(
      result === "fail"
        ? { status: "error" as const }
        : { status: "ok" as const, output: result, inputTokens: 1, outputTokens: 1 },
    );
  };
  return { model, inputs };
}

const candidate = (appId: string, extra: Partial<RouteCandidate> = {}): RouteCandidate => ({
  appId,
  name: appId,
  packages: [`pkg.${appId}`],
  by: "jev",
  level: "L0",
  ...extra,
});

function fakeSelector(...answers: RouteSelection[]): RouteSelector & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    select(input) {
      calls.push(input);
      const next = answers.length > 1 ? answers.shift() : answers[0];
      if (!next) throw new Error("no answer");
      return Promise.resolve(next);
    },
  };
}

const route = (candidates: RouteCandidate[]): RouteSelection => ({
  kind: "route",
  mapVersion: "map@t",
  ms: 500,
  cost: 0.0001,
  role: "music",
  named: false,
  exclusive: false,
  ask: false,
  candidates,
  confidence: { app: 0.6, role: 0.8 },
});

const req = (over: Record<string, unknown> = {}) =>
  classifyRequestSchema.parse({ commandId: 42, utterance: "토스 열어 줘", ...over });

function deps(
  model: ClassifyModel,
  selector?: RouteSelector,
): Omit<ClassifyDeps, "log"> & { commands: ReturnType<typeof memoryCommands> } {
  return { model, selector, commands: memoryCommands() };
}

describe("classify 단계", () => {
  it("max(규칙, AI): AI 가 낮게 답해도 규칙 단계를 지킨다", async () => {
    const d = deps(fakeModel(output({ level: "L0" })).model);
    const res = await classify("uid-1", req({ ruleLevel: "L1" }), { ...d, log });
    expect(res.sensitivity.level).toBe("L1");
    const up = deps(fakeModel(output({ level: "L2", category: "finance" })).model);
    expect(
      (await classify("uid-1", req({ ruleLevel: "L1" }), { ...up, log })).sensitivity,
    ).toMatchObject({
      level: "L2",
      category: "finance",
    });
  });

  it("상황 신호가 있으면 한 단계 올림, 목록 밖 신호는 버림", async () => {
    const d = deps(fakeModel(output({ level: "L1", category: "finance" })).model);
    const res = await classify("uid-1", req({ signals: ["통화 중", "이상한 신호"] }), {
      ...d,
      log,
    });
    expect(res.sensitivity).toMatchObject({ level: "L2", signals: ["통화 중"] });
  });

  it("scam 이면 L3, route 를 싣지 않음", async () => {
    const d = deps(
      fakeModel(output({ level: "L2", category: "scam", reason: "기관 사칭" })).model,
      fakeSelector(route([candidate("toss")])),
    );
    const res = await classify("uid-1", req({ utterance: "경찰이 토스로 돈 보내래" }), {
      ...d,
      log,
    });
    expect(res.sensitivity).toMatchObject({ level: "L3", category: "scam" });
    expect(res.route).toBeUndefined();
  });

  it("안전 분류가 실패하면 규칙 결과(+신호)로, degraded", async () => {
    const d = deps(fakeModel("fail").model);
    const res = await classify(
      "uid-1",
      req({ ruleLevel: "L1", ruleApp: "토스", signals: ["통화 중"] }),
      {
        ...d,
        log,
      },
    );
    expect(res).toMatchObject({
      intent: "UNKNOWN",
      app: "토스",
      degraded: true,
      sensitivity: { level: "L2", category: "none", reason: "ai-unavailable" },
    });
  });

  it("모델에는 가린 말만 보낸다", async () => {
    const m = fakeModel(output());
    await classify("uid-1", req({ utterance: "010-1234-5678 로 전화 걸어 줘" }), {
      ...deps(m.model),
      log,
    });
    expect(m.inputs[0]?.utterance).toContain("***");
    expect(m.inputs[0]?.utterance).not.toContain("5678");
  });

  it("검증된 목표 단계만 올리는 데 쓴다 (candidate 목표는 안 씀)", async () => {
    const goal = (level: "L2", verified: boolean) => ({
      id: "gov24.resident_copy",
      version: 1,
      name: "등본",
      level,
      slots: [],
      confidence: 0.9,
      verified,
    });
    const verified = deps(
      fakeModel(output({ level: "L1", category: "public" })).model,
      fakeSelector(route([candidate("gov24", { level: "L2", goal: goal("L2", true) })])),
    );
    expect((await classify("uid-1", req(), { ...verified, log })).sensitivity.level).toBe("L2");
    const unverified = deps(
      fakeModel(output({ level: "L1", category: "public" })).model,
      fakeSelector(route([candidate("gov24", { level: "L2", goal: goal("L2", false) })])),
    );
    expect((await classify("uid-1", req(), { ...unverified, log })).sensitivity.level).toBe("L1");
  });

  it("route 를 싣고 명령을 uid 아래에 저장, 라우팅이 꺼져 있으면 route 없음", async () => {
    const d = deps(fakeModel(output()).model, fakeSelector(route([candidate("youtube")])));
    const res = await classify("uid-1", req({ utterance: "트로트 틀어 줘" }), { ...d, log });
    expect(res.route?.candidates.map((c) => c.appId)).toEqual(["youtube"]);
    expect(d.commands.records.get("uid-1|42")).toMatchObject({ uid: "uid-1", level: "L0" });
    const off = deps(fakeModel(output()).model);
    expect((await classify("uid-1", req(), { ...off, log })).route).toBeUndefined();
  });

  it("하려는 일을 물을 때 clarify", async () => {
    const clarify = {
      questionId: "intent",
      say: "영상 보기인가요, 연락처인가요?",
      options: [
        { id: "video", name: "영상 보기" },
        { id: "contacts", name: "연락처" },
      ],
    };
    const d = deps(
      fakeModel(output()).model,
      fakeSelector({
        kind: "ask_intent",
        mapVersion: "m",
        ms: 1,
        cost: 0,
        clarify,
        confidence: { role: 0.3 },
      }),
    );
    const res = await classify("uid-1", req({ utterance: "임영웅 찾아 줘" }), { ...d, log });
    expect(res.clarify).toEqual(clarify);
    expect(d.commands.records.get("uid-1|42")?.clarify).toEqual(clarify);
  });

  it("maxLevel", () => {
    expect(maxLevel("L0", "L2", "L1")).toBe("L2");
    expect(maxLevel()).toBe("L0");
  });
});

describe("앱 선택 (chooseApp)", () => {
  const body = (b: Record<string, unknown>) => chooseAppRequestSchema.parse(b);

  async function setup(candidates: RouteCandidate[]) {
    const d = deps(
      fakeModel(output({ level: "L1", category: "finance" })).model,
      fakeSelector(route(candidates)),
    );
    await classify("uid-1", req(), { ...d, log });
    return d;
  }

  it("후보 앱을 고정하고, 다른 앱으로 바꾸면 409, 같은 앱 재시도는 그대로", async () => {
    const d = await setup([candidate("melon"), candidate("youtube")]);
    const ok = await chooseApp("uid-1", 42, body({ appId: "youtube" }), { ...d, log });
    expect(ok).toMatchObject({ appId: "youtube", sensitivity: { level: "L1" } });
    expect(d.commands.records.get("uid-1|42")?.chosenApp).toBe("youtube");
    await expect(
      chooseApp("uid-1", 42, body({ appId: "youtube" }), { ...d, log }),
    ).resolves.toMatchObject({
      appId: "youtube",
    });
    await expect(
      chooseApp("uid-1", 42, body({ appId: "melon" }), { ...d, log }),
    ).rejects.toMatchObject({
      reason: "conflict",
    });
  });

  it("후보에 없는 앱은 400, 다른 어르신의 명령은 404", async () => {
    const d = await setup([candidate("youtube")]);
    await expect(
      chooseApp("uid-1", 42, body({ appId: "netflix" }), { ...d, log }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      chooseApp("uid-2", 42, body({ appId: "youtube" }), { ...d, log }),
    ).rejects.toMatchObject({
      reason: "not-found",
    });
  });

  const goalOf = (id: string, level: "L0" | "L1" | "L2" | "L3", verified: boolean) => ({
    id,
    version: 1,
    name: id,
    level,
    slots: [],
    confidence: 0.9,
    verified,
  });

  it("고른 후보의 검증된 목표만 명령 단계를 올린다 (candidate 목표는 안 올림)", async () => {
    const d = await setup([
      candidate("a", { level: "L2", goal: goalOf("a.x", "L2", false) }),
      candidate("b", { level: "L2", goal: goalOf("b.x", "L2", true) }),
    ]);
    // classify 때 검증된 b 의 L2 가 이미 반영됨 → 다른 명령으로 따로 본다
    expect(d.commands.records.get("uid-1|42")?.level).toBe("L2");
    const only = await setup([candidate("a", { level: "L2", goal: goalOf("a.x", "L2", false) })]);
    const res = await chooseApp("uid-1", 42, body({ appId: "a" }), { ...only, log });
    expect(res.sensitivity.level).toBe("L1");
    const verified = await setup([
      candidate("b", { level: "L2", goal: goalOf("b.x", "L2", true) }),
    ]);
    expect(
      (await chooseApp("uid-1", 42, body({ appId: "b" }), { ...verified, log })).sensitivity.level,
    ).toBe("L2");
  });

  it("후보의 목표 질문에 답하면 그 목표로", async () => {
    const d = await setup([
      candidate("gov24", {
        clarify: {
          questionId: "goal:gov24",
          say: "등본인가요, 초본인가요?",
          options: [
            { id: "gov24.resident_copy", name: "등본" },
            { id: "gov24.resident_abstract", name: "초본" },
          ],
        },
      }),
    ]);
    const res = await chooseApp(
      "uid-1",
      42,
      body({
        appId: "gov24",
        answer: { questionId: "goal:gov24", option: "gov24.resident_abstract" },
      }),
      { ...d, log },
    );
    expect(res.goal).toEqual({ id: "gov24.resident_abstract", name: "초본" });
  });

  it("질문에 없는 선택지는 400", async () => {
    const d = await setup([
      candidate("gov24", {
        clarify: {
          questionId: "goal:gov24",
          say: "?",
          options: [{ id: "gov24.resident_copy", name: "등본" }],
        },
      }),
    ]);
    await expect(
      chooseApp(
        "uid-1",
        42,
        body({ appId: "gov24", answer: { questionId: "goal:gov24", option: "x" } }),
        { ...d, log },
      ),
    ).rejects.toMatchObject({ reason: "invalid-argument" });
  });

  it("하려는 일 답 → 그 역할로 다시 고름 (가린 말로)", async () => {
    const clarify = {
      questionId: "intent",
      say: "?",
      options: [
        { id: "video", name: "영상 보기" },
        { id: "contacts", name: "연락처" },
      ],
    };
    const selector = fakeSelector(
      { kind: "ask_intent", mapVersion: "m", ms: 1, cost: 0, clarify, confidence: { role: 0.3 } },
      route([candidate("youtube")]),
    );
    const d = deps(fakeModel(output()).model, selector);
    await classify("uid-1", req({ utterance: "임영웅 찾아 줘 010-1234-5678" }), { ...d, log });
    const res = await chooseApp(
      "uid-1",
      42,
      body({ answer: { questionId: "intent", option: "video" } }),
      {
        ...d,
        log,
      },
    );
    expect(res.route?.candidates.map((c) => c.appId)).toEqual(["youtube"]);
    expect(selector.calls[1]).toMatchObject({ role: "video" });
    expect(JSON.stringify(selector.calls[1])).not.toContain("5678");
  });

  const intentClarify = {
    questionId: "intent",
    say: "?",
    options: [
      { id: "video", name: "영상 보기" },
      { id: "bank", name: "은행" },
    ],
  };
  const askIntent: RouteSelection = {
    kind: "ask_intent",
    mapVersion: "m",
    ms: 1,
    cost: 0,
    clarify: intentClarify,
    confidence: { role: 0.3 },
  };

  it("질문 답으로 검증된 목표가 나와도 상황 신호 보정을 다시 적용, L3 면 route 를 싣지 않음", async () => {
    const selector = fakeSelector(
      askIntent,
      route([candidate("toss", { goal: goalOf("toss.send", "L2", true) })]),
    );
    const d = deps(fakeModel(output({ level: "L0" })).model, selector);
    const first = await classify("uid-1", req({ signals: ["통화 중"] }), { ...d, log });
    expect(first.sensitivity.level).toBe("L1");
    const res = await chooseApp(
      "uid-1",
      42,
      body({ answer: { questionId: "intent", option: "bank" } }),
      {
        ...d,
        log,
      },
    );
    expect(res.sensitivity.level).toBe("L3");
    expect(res.route).toBeUndefined();
    expect(d.commands.records.get("uid-1|42")?.route).toBeUndefined();
  });

  it("동시에 온 두 질문 답: 늦은 쪽은 409, 올라간 단계가 내려가지 않음", async () => {
    const selector = fakeSelector(
      askIntent,
      route([candidate("toss", { goal: goalOf("toss.send", "L2", true) })]),
      route([candidate("youtube")]),
    );
    const d = deps(fakeModel(output()).model, selector);
    await classify("uid-1", req(), { ...d, log });
    const stale = await d.commands.get("uid-1", 42);
    await chooseApp("uid-1", 42, body({ answer: { questionId: "intent", option: "bank" } }), {
      ...d,
      log,
    });
    expect(d.commands.records.get("uid-1|42")?.level).toBe("L2");
    // 늦게 끝난 요청은 예전 rev 로 쓰려다 실패
    if (!stale) throw new Error("no record");
    expect(await d.commands.update("uid-1", 42, stale, { level: "L0" })).toBe("conflict");
    expect(d.commands.records.get("uid-1|42")?.level).toBe("L2");
    // 같은 답 재전송은 저장된 결과, 다른 답은 409
    const again = await chooseApp(
      "uid-1",
      42,
      body({ answer: { questionId: "intent", option: "bank" } }),
      { ...d, log },
    );
    expect(again).toMatchObject({
      sensitivity: { level: "L2" },
      route: { candidates: [{ appId: "toss" }] },
    });
    await expect(
      chooseApp("uid-1", 42, body({ answer: { questionId: "intent", option: "video" } }), {
        ...d,
        log,
      }),
    ).rejects.toMatchObject({ reason: "conflict" });
  });

  it("살아 있는 명령에 같은 번호로 classify 재시도 → 합침: 고른 앱 유지, 단계는 내려가지 않음", async () => {
    const d = await setup([candidate("melon"), candidate("youtube")]);
    await chooseApp("uid-1", 42, body({ appId: "youtube" }), { ...d, log });
    // 재시도에서 모델이 더 낮게 답해도 저장된 L1 유지, 응답도 저장 상태로
    const low = await classify("uid-1", req(), {
      ...d,
      model: fakeModel(output({ level: "L0" })).model,
      log,
    });
    expect(low.sensitivity.level).toBe("L1");
    expect(d.commands.records.get("uid-1|42")).toMatchObject({ chosenApp: "youtube", level: "L1" });
    await expect(
      chooseApp("uid-1", 42, body({ appId: "melon" }), { ...d, log }),
    ).rejects.toMatchObject({ reason: "conflict" });
  });

  it("재시도에서 scam 이 나오면 L3 로 올리고 후보를 지움 (응답에도 route 없음)", async () => {
    const d = await setup([candidate("youtube")]);
    const res = await classify("uid-1", req(), {
      ...d,
      model: fakeModel(output({ level: "L1", category: "scam", reason: "기관 사칭" })).model,
      log,
    });
    expect(res.sensitivity).toMatchObject({ level: "L3", category: "scam", reason: "기관 사칭" });
    expect(res.route).toBeUndefined();
    expect(d.commands.records.get("uid-1|42")?.route).toBeUndefined();
    // 다시 낮게 답하는 재시도가 와도 L3·scam 유지, route 도 다시 나오지 않음
    const again = await classify("uid-1", req(), { ...d, log });
    expect(again.sensitivity).toMatchObject({ level: "L3", category: "scam" });
    expect(again.route).toBeUndefined();
  });

  it("저장·합치기가 끝나지 않으면 503 (만들기 예외, 계속 충돌)", async () => {
    const d = await setup([candidate("youtube")]);
    const stuck: CommandStore = { ...d.commands, update: () => Promise.resolve("conflict") };
    await expect(classify("uid-1", req(), { ...d, commands: stuck, log })).rejects.toMatchObject({
      reason: "unavailable",
    });
    const down: CommandStore = { ...d.commands, create: () => Promise.reject(new Error("down")) };
    await expect(
      classify("uid-1", req({ commandId: 43 }), { ...d, commands: down, log }),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("classify 재시도 중 명령이 바뀌면(gen 다름) 새 명령에 합치지 않고 503", async () => {
    const d = await setup([candidate("youtube")]);
    const realGet = d.commands.get.bind(d.commands);
    let reads = 0;
    const swapping: CommandStore = {
      ...d.commands,
      update: () => Promise.resolve("conflict"),
      get: async (uid, id) => {
        reads += 1;
        if (reads === 2) {
          // 두 번째 읽기 전에 TTL 로 지워지고 같은 번호의 새 명령이 생김
          d.commands.records.delete("uid-1|42");
          await classify("uid-1", req({ utterance: "유튜브 열어 줘" }), { ...d, log });
        }
        return realGet(uid, id);
      },
    };
    await expect(
      classify("uid-1", req(), {
        ...d,
        commands: swapping,
        model: fakeModel(output({ level: "L1", category: "scam" })).model,
        log,
      }),
    ).rejects.toMatchObject({ reason: "unavailable" });
    // 새 명령은 자기 판정(finance) 그대로, 이전 요청의 scam 이 섞이지 않음
    expect(d.commands.records.get("uid-1|42")?.category).toBe("finance");
  });

  it("재시도에서 새 신호가 오면 저장된 검증 목표에도 적용 (jev 가 이번엔 실패해도)", async () => {
    const d = deps(
      fakeModel(output({ level: "L1", category: "public" })).model,
      fakeSelector(
        route([candidate("gov24", { goal: goalOf("gov24.resident_copy", "L2", true) })]),
      ),
    );
    expect((await classify("uid-1", req(), { ...d, log })).sensitivity.level).toBe("L2");
    const res = await classify("uid-1", req({ signals: ["통화 중"] }), {
      ...d,
      selector: fakeSelector({
        kind: "fail",
        mapVersion: "m",
        ms: 1500,
        cost: 0,
        reason: "jev_timeout",
      }),
      log,
    });
    expect(res.sensitivity.level).toBe("L3");
    expect(res.route).toBeUndefined();
  });

  it("하루가 지나 같은 번호로 다시 만든 명령에는 예전 요청의 갱신이 들어가지 않음 (gen)", async () => {
    const d = await setup([candidate("youtube")]);
    const old = await d.commands.get("uid-1", 42);
    if (!old) throw new Error("no record");
    // TTL 로 지워지고 같은 번호로 새 명령이 만들어짐 (rev 는 다시 0)
    d.commands.records.delete("uid-1|42");
    await classify("uid-1", req({ utterance: "카메라 켜 줘" }), { ...d, log });
    expect(await d.commands.update("uid-1", 42, old, { chosenApp: "youtube" })).toBe("conflict");
    expect(d.commands.records.get("uid-1|42")?.chosenApp).toBeUndefined();
  });

  it("앱을 고른 뒤 재시도로 scam 이 되어 후보가 지워져도 같은 앱 재전송은 200 (L3)", async () => {
    const d = await setup([candidate("youtube")]);
    await chooseApp("uid-1", 42, body({ appId: "youtube" }), { ...d, log });
    await classify("uid-1", req(), {
      ...d,
      model: fakeModel(output({ level: "L1", category: "scam" })).model,
      log,
    });
    const res = await chooseApp("uid-1", 42, body({ appId: "youtube" }), { ...d, log });
    expect(res).toMatchObject({ appId: "youtube", sensitivity: { level: "L3" } });
  });

  it("앱만 먼저 고르고 목표 질문 답을 나중에 보내면 반영 (신호 보정 포함), 다른 답은 409", async () => {
    const clarify = {
      questionId: "goal:gov24",
      say: "?",
      options: [
        { id: "gov24.resident_copy", name: "등본", level: "L1" as const, verified: true },
        { id: "gov24.resident_abstract", name: "초본", level: "L2" as const, verified: true },
      ],
    };
    const d = deps(
      fakeModel(output({ level: "L1", category: "public" })).model,
      fakeSelector(route([candidate("gov24", { clarify })])),
    );
    const first = await classify("uid-1", req({ signals: ["통화 중"] }), { ...d, log });
    expect(first.sensitivity.level).toBe("L2");
    await chooseApp("uid-1", 42, body({ appId: "gov24" }), { ...d, log });
    const res = await chooseApp(
      "uid-1",
      42,
      body({
        appId: "gov24",
        answer: { questionId: "goal:gov24", option: "gov24.resident_abstract" },
      }),
      { ...d, log },
    );
    expect(res).toMatchObject({
      goal: { id: "gov24.resident_abstract" },
      sensitivity: { level: "L3" },
    });
    expect(d.commands.records.get("uid-1|42")).toMatchObject({
      chosenGoal: "gov24.resident_abstract",
      level: "L3",
    });
    await expect(
      chooseApp(
        "uid-1",
        42,
        body({
          appId: "gov24",
          answer: { questionId: "goal:gov24", option: "gov24.resident_copy" },
        }),
        { ...d, log },
      ),
    ).rejects.toMatchObject({ reason: "conflict" });
  });

  const govClarify = {
    questionId: "goal:gov24",
    say: "?",
    options: [
      { id: "gov24.resident_copy", name: "등본", level: "L1" as const, verified: true },
      { id: "gov24.resident_abstract", name: "초본", level: "L2" as const, verified: true },
    ],
  };

  it("동시 앱 선택: 앱만 고른 요청이 먼저 저장돼도 목표 답 요청은 다시 읽어 반영 (L3)", async () => {
    const d = deps(
      fakeModel(output({ level: "L1", category: "public" })).model,
      fakeSelector(route([candidate("gov24", { clarify: govClarify })])),
    );
    await classify("uid-1", req({ signals: ["통화 중"] }), { ...d, log });
    // 목표 답 요청이 읽은 직후, 앱만 고른 요청이 먼저 저장된 상황을 흉내
    const realGet = d.commands.get.bind(d.commands);
    let first = true;
    const racing: CommandStore = {
      ...d.commands,
      get: async (uid, id) => {
        const r = await realGet(uid, id);
        if (first) {
          first = false;
          await chooseApp("uid-1", 42, body({ appId: "gov24" }), { ...d, log });
        }
        return r;
      },
    };
    const res = await chooseApp(
      "uid-1",
      42,
      body({
        appId: "gov24",
        answer: { questionId: "goal:gov24", option: "gov24.resident_abstract" },
      }),
      { ...d, commands: racing, log },
    );
    expect(res).toMatchObject({
      goal: { id: "gov24.resident_abstract" },
      sensitivity: { level: "L3" },
    });
    expect(d.commands.records.get("uid-1|42")).toMatchObject({
      chosenGoal: "gov24.resident_abstract",
      level: "L3",
    });
  });

  it("하려는 일 답에서 jev 가 시간 초과면 503, 답을 확정하지 않아 다시 시도할 수 있음", async () => {
    const clarify = {
      questionId: "intent",
      say: "?",
      options: [
        { id: "video", name: "영상 보기" },
        { id: "contacts", name: "연락처" },
      ],
    };
    const selector = fakeSelector(
      { kind: "ask_intent", mapVersion: "m", ms: 1, cost: 0, clarify, confidence: { role: 0.3 } },
      { kind: "fail", mapVersion: "m", ms: 1500, cost: 0, reason: "jev_timeout" },
      route([candidate("youtube")]),
    );
    const d = deps(fakeModel(output()).model, selector);
    await classify("uid-1", req(), { ...d, log });
    const answer = body({ answer: { questionId: "intent", option: "video" } });
    await expect(chooseApp("uid-1", 42, answer, { ...d, log })).rejects.toMatchObject({
      reason: "unavailable",
    });
    expect(d.commands.records.get("uid-1|42")?.intentAnswer).toBeUndefined();
    const ok = await chooseApp("uid-1", 42, answer, { ...d, log });
    expect(ok.route?.candidates.map((c) => c.appId)).toEqual(["youtube"]);
  });

  it("다시 읽었더니 다른 명령(gen 다름)이면 409", async () => {
    const d = await setup([candidate("youtube")]);
    const realGet = d.commands.get.bind(d.commands);
    let calls = 0;
    const swapped: CommandStore = {
      ...d.commands,
      // 첫 읽기 뒤 TTL 로 지워지고 같은 번호의 새 명령이 생긴 상황
      get: async (uid, id) => {
        const r = await realGet(uid, id);
        calls += 1;
        if (calls === 1) {
          d.commands.records.delete("uid-1|42");
          await classify("uid-1", req(), { ...d, log });
        }
        return r;
      },
    };
    await expect(
      chooseApp("uid-1", 42, body({ appId: "youtube" }), { ...d, commands: swapped, log }),
    ).rejects.toMatchObject({ reason: "conflict" });
  });

  it("저장된 명령이 있는데 읽지 못하면 낮은 결과 대신 503", async () => {
    const d = await setup([candidate("youtube")]);
    await classify("uid-1", req(), {
      ...d,
      model: fakeModel(output({ level: "L1", category: "scam" })).model,
      log,
    });
    const unreadable: CommandStore = {
      ...d.commands,
      get: () => Promise.reject(new Error("dynamo down")),
    };
    await expect(
      classify("uid-1", req(), { ...d, commands: unreadable, log }),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("안전 분류가 실패하면 검증 목표 단계도 쓰지 않고 route 도 싣지 않음 (규칙 결과만)", async () => {
    const d = deps(
      fakeModel("fail").model,
      fakeSelector(
        route([candidate("gov24", { goal: goalOf("gov24.resident_copy", "L2", true) })]),
      ),
    );
    const res = await classify("uid-1", req({ ruleLevel: "L0" }), { ...d, log });
    expect(res).toMatchObject({ degraded: true, sensitivity: { level: "L0" } });
    expect(res.route).toBeUndefined();
  });
});

describe("HTTP", () => {
  const { store } = memoryCoreStore();
  const at = "2026-11-27T00:00:00.000Z";
  void store.createUser({ uid: "uid-1", role: "elder", name: "", createdAt: at, updatedAt: at });
  void store.createUser({ uid: "g-1", role: "guardian", name: "", createdAt: at, updatedAt: at });
  const d = deps(
    fakeModel(output({ level: "L1", category: "finance" })).model,
    fakeSelector(route([candidate("toss")])),
  );
  const profiles = createProfileGuard(store);
  const handler = createHttpHandler(
    createRouter([
      { method: "POST", path: "/v1/elder/classify", handler: createClassifyRoute(profiles, d) },
      {
        method: "POST",
        path: "/v1/elder/commands/{commandId}/app",
        handler: createChooseAppRoute(profiles, d),
      },
    ]),
    log,
  );
  const post = (path: string, body: unknown, uid = "uid-1") =>
    handler({ ...httpEvent("POST", path, uid), body: JSON.stringify(body) }, lambdaContext);

  it("classify 200, 본문이 잘못되면 400, 보호자는 403", async () => {
    const ok = await post("/v1/elder/classify", {
      commandId: 7,
      utterance: "토스 열어 줘",
      ruleLevel: "L1",
    });
    expect(ok.statusCode).toBe(200);
    expect(parseBody(ok.body)).toMatchObject({ commandId: 7, sensitivity: { level: "L1" } });
    expect((await post("/v1/elder/classify", { commandId: "x" })).statusCode).toBe(400);
    expect(
      (await post("/v1/elder/classify", { commandId: 1, utterance: "a" }, "g-1")).statusCode,
    ).toBe(403);
  });

  it("앱 선택 200, commandId 가 숫자가 아니면 400, 없는 명령 404", async () => {
    await post("/v1/elder/classify", { commandId: 8, utterance: "토스 열어 줘" });
    const ok = await post("/v1/elder/commands/8/app", { appId: "toss" });
    expect(ok.statusCode).toBe(200);
    expect((await post("/v1/elder/commands/abc/app", { appId: "toss" })).statusCode).toBe(400);
    expect((await post("/v1/elder/commands/999/app", { appId: "toss" })).statusCode).toBe(404);
    expect((await post("/v1/elder/commands/8/app", {})).statusCode).toBe(400);
  });
});
