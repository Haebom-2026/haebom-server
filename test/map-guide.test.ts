import { describe, expect, it } from "vitest";
import type { GuideModel } from "../src/ai/guide.js";
import { createProfileGuard } from "../src/core/profile.js";
import { createGuideTraceRecorder } from "../src/debug/guide-trace.js";
import type { ScreenDocument } from "../src/debug/store.js";
import { buildSeed } from "../src/map/seed.js";
import { actionsOf, stepsOfCommand, type ReviewRecord } from "../src/review/review.js";
import { createGuideRoute } from "../src/functions/ai/routes/guide.js";
import type { CommandLog, StepRecord } from "../src/route/command-log.js";
import type { CommandStore } from "../src/route/command-store.js";
import { createHttpHandler } from "../src/shared/handler.js";
import { createLogger } from "../src/shared/logger.js";
import { createRouter } from "../src/shared/router.js";
import { memoryCoreStore } from "./core-memory-store.js";
import { memoryDebugStore } from "./debug-memory-store.js";
import { httpEvent, lambdaContext, parseBody } from "./helpers.js";
import { guideRequestSchema, type GuideRequest } from "../src/ai/guide-schema.js";
import { mapFingerprint } from "../src/map/fingerprint.js";
import { decideMapStep, firstEdgeToward, objectParticle, pressSay } from "../src/map/guide.js";
import {
  edgeIdOf,
  type MapEdge,
  type MapFinishStep,
  type MapGoal,
  type MapSnapshot,
  toIdList,
} from "../src/map/store.js";
import type { CommandRecord, MapProgress } from "../src/route/command-store.js";
import { parseMap } from "../src/route/map.js";
import { SEED_MAP } from "../src/route/seed-map.js";
import { maskDeep } from "../src/shared/sensitive.js";

const routeMap = parseMap(SEED_MAP);
const LAUNCHER = "com.sec.android.app.launcher";
const SETTINGS = "com.android.settings";

type Node = Record<string, unknown> & { i: number };
const tv = (i: number, t: string, y: number, extra: Record<string, unknown> = {}): Node => ({
  i,
  t,
  c: "android.widget.TextView",
  b: [0, y, 1080, y + 100],
  ...extra,
});

const screens = {
  home: { pkg: LAUNCHER, nodes: [tv(0, "설정", 1500), tv(1, "카메라", 1700), tv(2, "12:30", 10)] },
  settings: {
    pkg: SETTINGS,
    nodes: [tv(0, "설정", 100), tv(1, "디스플레이", 600), tv(2, "소리", 800)],
  },
  display: {
    pkg: SETTINGS,
    nodes: [
      tv(0, "디스플레이", 100),
      tv(1, "밝기 최적화", 500, { c: "android.widget.Switch", checked: false }),
    ],
  },
  displayDone: {
    pkg: SETTINGS,
    nodes: [
      tv(0, "디스플레이", 100),
      tv(1, "밝기 최적화", 500, { c: "android.widget.Switch", checked: true }),
    ],
  },
};

function request(
  name: keyof typeof screens,
  lastAction?: GuideRequest["lastAction"],
  requestId = 1,
): GuideRequest {
  const s = screens[name];
  return guideRequestSchema.parse({
    requestId,
    goal: "UNKNOWN",
    commandId: 1,
    screen: { pkg: s.pkg, width: 1080, height: 2400, nodes: s.nodes },
    ...(lastAction ? { lastAction } : {}),
  });
}

const fpOf = (req: GuideRequest) => {
  const nodes = maskDeep(req.screen.nodes).value;
  return { nodes, fp: mapFingerprint({ ...req.screen, nodes }) };
};
const FP = {
  home: fpOf(request("home")).fp,
  settings: fpOf(request("settings")).fp,
  display: fpOf(request("display")).fp,
  displayDone: fpOf(request("displayDone")).fp,
};

const edge = (from: string, to: string, text: string, pkg = SETTINGS): MapEdge => {
  const base = {
    fromFp: from,
    toFp: to,
    action: "tap" as const,
    targetText: text,
    targetClass: "TextView",
  };
  return {
    ...base,
    edgeId: edgeIdOf(base),
    pkg,
    status: "verified",
    origin: "seed",
    evidence: [],
    createdAt: "2026-11-27T00:00:00.000Z",
  };
};
const E1 = edge(FP.home, FP.settings, "설정", LAUNCHER);
const E2 = edge(FP.settings, FP.display, "디스플레이");
const GOAL: MapGoal = {
  goalId: "settings.brightness_down",
  pkg: SETTINGS,
  arriveFps: [FP.display],
  finish: [
    {
      action: "tap",
      targetText: "밝기 최적화",
      targetClass: "Switch",
      verify: "node_state",
      sensitive: false,
    },
  ],
  status: "verified",
  origin: "seed",
  evidence: [],
  updatedAt: "2026-11-27T00:00:00.000Z",
};
const snapshot = (over: Partial<MapSnapshot> = {}): MapSnapshot => ({
  edges: [E1, E2],
  goals: new Map([[GOAL.goalId, GOAL]]),
  block: { edgeIds: [], goalIds: [] },
  ...over,
});

const command = (over: Partial<CommandRecord> = {}): CommandRecord => ({
  uid: "u1",
  commandId: 1,
  createdAt: "2026-11-27T00:00:00.000Z",
  gen: "g1",
  rev: 3,
  maskedUtterance: "화면 어둡게 해 줘",
  baseLevel: "L0",
  signals: [],
  category: "none",
  reason: "",
  degraded: false,
  level: "L0",
  chosenApp: "settings",
  chosenGoal: "settings.brightness_down",
  ...over,
});

function decide(req: GuideRequest, cmd = command(), snap = snapshot()) {
  const { nodes, fp } = fpOf(req);
  return decideMapStep({
    request: req,
    maskedNodes: nodes,
    fp,
    command: cmd,
    snapshot: snap,
    routeMap,
  });
}

/** 앞 결정을 저장한 것처럼 진행 상태를 만든다 */
function progressAfter(d: ReturnType<typeof decide>, stepId: string): MapProgress {
  if (d.kind !== "step") throw new Error(`expected step, got ${d.kind}`);
  return { ...d.progress, stepId };
}

describe("mapFingerprint", () => {
  it("치는 숫자(시계)에는 안 흔들리고 스위치 상태에는 달라진다", () => {
    const a = request("home");
    const b = guideRequestSchema.parse({
      ...a,
      screen: {
        ...a.screen,
        nodes: [tv(0, "설정", 1500), tv(1, "카메라", 1700), tv(2, "09:05", 10)],
      },
    });
    expect(fpOf(a).fp).toBe(fpOf(b).fp);
    expect(FP.display).not.toBe(FP.displayDone);
  });

  it("글자가 빈 노드는 설명(d)으로 화면을 구분한다", () => {
    const page = (title: string) =>
      mapFingerprint({
        pkg: SETTINGS,
        width: 1080,
        height: 2400,
        nodes: [{ i: 0, t: "", d: title, c: "android.widget.TextView", b: [0, 100, 1080, 200] }],
      });
    expect(page("다크 모드")).not.toBe(page("비행기 모드"));
  });

  it("글자 없는 스위치 둘 중 어느 것이 켜졌는지 구분한다", () => {
    const sw = (i: number, y: number, checked: boolean) => ({
      i,
      c: "android.widget.Switch",
      b: [900, y, 1000, y + 100],
      checked,
    });
    const fp = (nodes: object[]) =>
      mapFingerprint({ pkg: SETTINGS, width: 1080, height: 2400, nodes });
    expect(fp([sw(0, 500, true), sw(1, 900, false)])).not.toBe(
      fp([sw(0, 500, false), sw(1, 900, true)]),
    );
  });
});

describe("decideMapStep", () => {
  it("홈 → 설정 → 디스플레이 → 끝 단계 → Claude", () => {
    const d1 = decide(request("home"));
    expect(d1).toMatchObject({
      kind: "step",
      response: {
        type: "highlight",
        target: 0,
        targetText: "설정",
        say: "'설정'을 눌러 주세요.",
        status: "in_progress",
      },
      progress: { mode: "map", kind: "edge", ref: E1.edgeId, fp: FP.home },
    });

    const p1 = progressAfter(d1, "s1");
    const d2 = decide(
      request("settings", { stepId: "s1", seq: 0, action: "tap", text: "설정" }),
      command({ mapProgress: p1 }),
    );
    expect(d2).toMatchObject({
      kind: "step",
      response: { target: 1, targetText: "디스플레이", say: "'디스플레이'를 눌러 주세요." },
    });

    const p2 = progressAfter(d2, "s2");
    const d3 = decide(
      request("display", { stepId: "s2", seq: 1, action: "tap", text: "디스플레이" }),
      command({ mapProgress: p2 }),
    );
    expect(d3).toMatchObject({
      kind: "step",
      response: { target: 1 },
      progress: { kind: "finish", ref: "0" },
    });

    const p3 = progressAfter(d3, "s3");
    const d4 = decide(
      request("displayDone", { stepId: "s3", seq: 2, action: "tap", text: "밝기 최적화" }),
      command({ mapProgress: p3 }),
    );
    expect(d4).toEqual({ kind: "ai", reason: "finish-complete", persist: true });
  });

  it("끝 단계 뒤 화면이 그대로면 확인 안 됨 → Claude", () => {
    const p = progressAfter(decide(request("display")), "s3");
    const d = decide(
      request("display", { stepId: "s3", seq: 2, action: "tap", text: "밝기 최적화" }),
      command({ mapProgress: p }),
    );
    expect(d).toMatchObject({ kind: "ai", reason: "finish-not-verified" });
  });

  it("같은 화면 재요청은 저장된 안내를 그대로", () => {
    const p = progressAfter(decide(request("home")), "s1");
    const d = decide(request("home", undefined, 2), command({ mapProgress: p }));
    expect(d).toMatchObject({ kind: "resend", response: { stepId: "s1", targetText: "설정" } });
  });

  it("재요청은 지금 화면의 노드 번호로, 그 사이 차단된 연결선이면 Claude", () => {
    const p = progressAfter(decide(request("home")), "s1");
    // 같은 화면, 노드 순서만 바뀜 (지문은 같음)
    const base = request("home", undefined, 2);
    const shuffled = guideRequestSchema.parse({
      ...base,
      screen: {
        ...base.screen,
        nodes: [tv(0, "카메라", 1700), tv(1, "12:30", 10), tv(2, "설정", 1500)],
      },
    });
    expect(fpOf(shuffled).fp).toBe(FP.home);
    expect(decide(shuffled, command({ mapProgress: p }))).toMatchObject({
      kind: "resend",
      response: { stepId: "s1", target: 2, targetText: "설정" },
    });
    const blocked = snapshot({ block: { edgeIds: [E1.edgeId], goalIds: [] } });
    expect(decide(request("home"), command({ mapProgress: p }), blocked)).toMatchObject({
      kind: "ai",
      reason: "edge-gone",
    });
  });

  it("안내를 따르지 않고 화면이 바뀌면 Claude, 이후 계속 Claude", () => {
    const p = progressAfter(decide(request("home")), "s1");
    const d = decide(
      request("settings", { seq: 0, action: "tap", text: "설정" }),
      command({ mapProgress: p }),
    );
    expect(d).toEqual({ kind: "ai", reason: "not-followed", persist: true });
    const again = decide(request("home"), command({ mapProgress: { mode: "ai" } }));
    expect(again).toEqual({ kind: "ai", reason: "already-ai", persist: false });
  });

  it("따랐는데 예상과 다른 화면이면 Claude", () => {
    const p = progressAfter(decide(request("home")), "s1");
    const d = decide(
      request("display", { stepId: "s1", seq: 0, action: "tap", text: "설정" }),
      command({ mapProgress: p }),
    );
    expect(d).toMatchObject({ kind: "ai", reason: "unexpected-screen" });
  });

  it("위험한 명령·지도 없음·차단·값이 필요한 목표는 Claude", () => {
    expect(decide(request("home"), command({ level: "L3" }))).toMatchObject({
      reason: "unsafe-command",
      persist: true,
    });
    expect(decide(request("home"), command({ category: "scam" }))).toMatchObject({
      reason: "unsafe-command",
    });
    expect(decide(request("home"), { ...command(), chosenGoal: "settings.nope" })).toMatchObject({
      reason: "unknown-goal",
    });
    expect(decide(request("home"), command(), snapshot({ goals: new Map() }))).toMatchObject({
      reason: "no-map",
    });
    expect(
      decide(
        request("home"),
        command(),
        snapshot({ block: { edgeIds: [], goalIds: [GOAL.goalId] } }),
      ),
    ).toMatchObject({ reason: "no-map" });
    expect(
      decide(
        request("home"),
        command(),
        snapshot({ block: { edgeIds: [E1.edgeId], goalIds: [] } }),
      ),
    ).toMatchObject({ reason: "no-path" });
    const youtube = command({ chosenApp: "youtube", chosenGoal: "youtube.search" });
    expect(decide(request("home"), youtube)).toMatchObject({ kind: "ai" });
  });

  it("같은 글자·종류가 둘이면 어느 것인지 모름 → Claude", () => {
    screens.settings.nodes.push(tv(3, "디스플레이", 1200));
    try {
      const req = request("settings");
      const dup = edge(fpOf(req).fp, FP.display, "디스플레이");
      const d = decide(req, command(), snapshot({ edges: [E1, dup] }));
      expect(d).toMatchObject({ kind: "ai", reason: "target-not-unique" });
    } finally {
      screens.settings.nodes.pop();
    }
  });

  it("누를 글자는 숫자까지 같아야 한다 (지문은 같아도)", () => {
    const t30 = { pkg: SETTINGS, nodes: [tv(0, "화면 꺼짐 시간", 100), tv(1, "30초", 500)] };
    const t10 = { pkg: SETTINGS, nodes: [tv(0, "화면 꺼짐 시간", 100), tv(1, "10초", 500)] };
    const req = (sc: typeof t30) =>
      guideRequestSchema.parse({
        requestId: 1,
        goal: "UNKNOWN",
        commandId: 1,
        screen: { pkg: sc.pkg, width: 1080, height: 2400, nodes: sc.nodes },
      });
    const fp30 = fpOf(req(t30)).fp;
    expect(fpOf(req(t10)).fp).toBe(fp30);
    const goals = new Map([
      [
        GOAL.goalId,
        {
          ...GOAL,
          arriveFps: [fp30],
          finish: [
            { ...GOAL.finish[0], targetText: "30초", targetClass: "TextView" } as MapFinishStep,
          ],
        },
      ],
    ]);
    expect(decide(req(t30), command(), snapshot({ goals }))).toMatchObject({ kind: "step" });
    expect(decide(req(t10), command(), snapshot({ goals }))).toMatchObject({
      kind: "ai",
      reason: "target-not-unique",
    });
  });

  it("끝 단계가 여럿이면 seed 때 본 다음 화면에서만 이어 간다", () => {
    const two = {
      ...GOAL,
      finish: [
        { ...GOAL.finish[0], afterFp: "someOtherScreen" } as MapFinishStep,
        { ...GOAL.finish[0], targetText: "디스플레이", targetClass: "TextView" } as MapFinishStep,
      ],
    };
    const snap = snapshot({ goals: new Map([[GOAL.goalId, two]]) });
    const p = progressAfter(decide(request("display"), command(), snap), "s3");
    const d = decide(
      request("displayDone", { stepId: "s3", seq: 2, action: "tap", text: "밝기 최적화" }),
      command({ mapProgress: p }),
      snap,
    );
    expect(d).toMatchObject({ kind: "ai", reason: "finish-unexpected-screen" });
    const ok = {
      ...two,
      finish: [
        { ...two.finish[0], afterFp: FP.displayDone } as MapFinishStep,
        two.finish[1] as MapFinishStep,
      ],
    };
    const snapOk = snapshot({ goals: new Map([[GOAL.goalId, ok]]) });
    const d2 = decide(
      request("displayDone", { stepId: "s3", seq: 2, action: "tap", text: "밝기 최적화" }),
      command({ mapProgress: p }),
      snapOk,
    );
    expect(d2).toMatchObject({ kind: "step", response: { targetText: "디스플레이" } });
  });

  it("글자가 빈 노드는 설명(d)으로 찾는다", () => {
    const req = request("home");
    const nodes = req.screen.nodes.map((n) => (n.i === 0 ? { ...n, t: "", d: "설정" } : n));
    const desc = guideRequestSchema.parse({ ...req, screen: { ...req.screen, nodes } });
    const { fp } = fpOf(desc);
    const e = edge(fp, FP.settings, "설정", LAUNCHER);
    expect(decide(desc, command(), snapshot({ edges: [e, E2] }))).toMatchObject({
      kind: "step",
      response: { target: 0, targetText: "설정" },
    });
  });

  it("안내와 다른 것을 눌렀으면 같은 행동 종류여도 Claude", () => {
    const p = progressAfter(decide(request("home")), "s1");
    const d = decide(
      request("settings", { stepId: "s1", seq: 0, action: "tap", text: "카메라" }),
      command({ mapProgress: p }),
    );
    expect(d).toMatchObject({ kind: "ai", reason: "different-target" });
  });

  it("같은 안내는 두 번까지만 다시 준다", () => {
    const p = progressAfter(decide(request("home")), "s1");
    expect(decide(request("home"), command({ mapProgress: p }))).toMatchObject({
      kind: "resend",
      resends: 1,
    });
    expect(decide(request("home"), command({ mapProgress: { ...p, resends: 2 } }))).toMatchObject({
      kind: "ai",
      reason: "resend-limit",
    });
  });

  it("진행 상태 없이 앞 안내가 있던 명령은 지도가 끼지 않는다", () => {
    expect(
      decide(request("home", { stepId: "sAi", seq: 0, action: "tap", text: "x" })),
    ).toMatchObject({
      kind: "ai",
      reason: "claude-started",
    });
    const withHistory = guideRequestSchema.parse({
      ...request("home"),
      history: ["설정을 눌러 주세요."],
    });
    expect(decide(withHistory)).toMatchObject({ reason: "claude-started" });
  });

  it("끝난 명령은 다른 이유보다 먼저, 쓰지 않는다", () => {
    expect(decide(request("home"), command({ endResult: "done", level: "L3" }))).toEqual({
      kind: "ai",
      reason: "ended",
      persist: false,
    });
  });

  it("이름에 home 이 든 일반 앱은 런처가 아니다", () => {
    const req = request("home");
    const other = guideRequestSchema.parse({
      ...req,
      screen: { ...req.screen, pkg: "com.homeplus.app" },
    });
    expect(decide(other)).toMatchObject({ kind: "ai", reason: "other-app" });
  });

  it("밀기 끝 단계는 밀 곳이 하나뿐이면 가리킨다", () => {
    const bar = { i: 9, d: "밝기 막대 80%", c: "android.widget.SeekBar", b: [50, 900, 950, 1000] };
    const req = guideRequestSchema.parse({
      ...request("display"),
      screen: { ...request("display").screen, nodes: [...screens.display.nodes, bar] },
    });
    const { fp } = fpOf(req);
    const goal = {
      ...GOAL,
      arriveFps: [fp],
      finish: [
        {
          action: "swipe_left",
          targetText: "밝기 막대 80%",
          targetClass: "",
          verify: "node_state",
          sensitive: false,
        },
      ] as MapFinishStep[],
    };
    expect(
      decide(req, command(), snapshot({ goals: new Map([[GOAL.goalId, goal]]) })),
    ).toMatchObject({
      kind: "step",
      response: { type: "swipe", dir: "left", target: 9, targetText: "밝기 막대 80%" },
    });
  });

  it("꺼진 버튼은 Claude", () => {
    const req = request("home");
    const nodes = req.screen.nodes.map((n) => (n.i === 0 ? { ...n, enabled: false } : n));
    const off = guideRequestSchema.parse({ ...req, screen: { ...req.screen, nodes } });
    expect(fpOf(off).fp).toBe(FP.home);
    expect(decide(off)).toMatchObject({ kind: "ai", reason: "target-disabled" });
  });

  it("민감한 끝 단계는 Claude", () => {
    const goals = new Map([
      [GOAL.goalId, { ...GOAL, finish: GOAL.finish.map((f) => ({ ...f, sensitive: true })) }],
    ]);
    expect(decide(request("display"), command(), snapshot({ goals }))).toMatchObject({
      reason: "finish-needs-ai",
    });
  });
});

describe("firstEdgeToward", () => {
  it("가장 짧은 길의 첫 걸음", () => {
    const shortcut = edge(FP.home, FP.display, "디스플레이 바로가기", LAUNCHER);
    expect(firstEdgeToward(FP.home, new Set([FP.display]), [E1, E2])?.edgeId).toBe(E1.edgeId);
    expect(firstEdgeToward(FP.home, new Set([FP.display]), [E1, E2, shortcut])?.edgeId).toBe(
      shortcut.edgeId,
    );
    expect(firstEdgeToward(FP.display, new Set([FP.home]), [E1, E2])).toBeUndefined();
  });
});

describe("pressSay·toIdList·actionsOf", () => {
  it("긴 글자는 줄이고 '눌러 주세요'는 남긴다", () => {
    const say = pressSay("가".repeat(100));
    expect(say.length).toBeLessThanOrEqual(80);
    expect(say.endsWith("눌러 주세요.")).toBe(true);
    expect(say).toContain("…");
  });

  it("차단 목록은 없음·String Set·섞인 값도 문자열 배열로", () => {
    expect(toIdList(undefined)).toEqual([]);
    expect(toIdList(new Set(["a", "b"]))).toEqual(["a", "b"]);
    expect(toIdList(["a", 1, null])).toEqual(["a"]);
    expect(toIdList("a")).toEqual([]);
  });

  it("같은 seq 를 다시 보낸 재시도는 처음 행동만", () => {
    const step = (n: number, stepId: string, seq?: number): StepRecord => ({
      uid: "u1",
      commandId: 1,
      stepId,
      receivedAt: `2026-11-27T00:00:0${n}.000Z`,
      screen: { deviceId: "d1", screenId: String(n) },
      pkg: SETTINGS,
      guide: { type: "highlight", source: "ai" },
      ...(seq === undefined
        ? {}
        : { lastAction: { stepId: "x", seq, action: "tap", text: "설정" } }),
    });
    const acts = actionsOf([step(0, "a"), step(1, "b", 0), step(2, "c", 0)], command());
    expect(acts.map((a) => [a.seq, a.on])).toEqual([[0, 0]]);
  });
});

describe("objectParticle", () => {
  it("받침에 따라 을/를", () => {
    expect(objectParticle("설정")).toBe("을");
    expect(objectParticle("디스플레이")).toBe("를");
    expect(objectParticle("Wi-Fi")).toBe("를");
  });
});

describe("POST /v1/elder/guide 지도 안내", () => {
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
  function setup(initial: CommandRecord, mapFails = false, replaced = false) {
    let record = structuredClone(initial);
    let reads = 0;
    let bump = false;
    const commands: CommandStore = {
      create: () => Promise.resolve("created"),
      get: () => {
        reads += 1;
        // replaced: 첫 읽기 뒤 TTL 로 지워지고 같은 번호로 새 명령이 생김
        if (replaced && reads === 2) record = { ...command(), gen: "g2", rev: 0 };
        return Promise.resolve(structuredClone(record));
      },
      update: (_uid, _id, read, set) => {
        if (bump) {
          // 다른 요청이 그 사이 썼다
          bump = false;
          record = { ...record, rev: record.rev + 1 };
        }
        if (read.gen !== record.gen || read.rev !== record.rev) return Promise.resolve("conflict");
        record = { ...record, ...structuredClone(set), rev: record.rev + 1 };
        return Promise.resolve("ok");
      },
    };
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
    let modelCalls = 0;
    const model: GuideModel = () => {
      modelCalls += 1;
      return Promise.resolve({
        status: "ok",
        stopReason: "end_turn",
        usage,
        output: {
          plan: [],
          step: "",
          status: "in_progress",
          action: "tap",
          target_id: 1,
          speech: "카메라를 눌러 주세요.",
          type_text: null,
          seek: null,
          options: [],
          fact: "none",
        },
      });
    };
    const { store } = memoryCoreStore();
    void store.createUser({ uid: "u1", role: "elder", name: "", createdAt: "", updatedAt: "" });
    const handler = createHttpHandler(
      createRouter([
        {
          method: "POST",
          path: "/v1/elder/guide",
          handler: createGuideRoute(model, createProfileGuard(store), {
            recorder: createGuideTraceRecorder(memoryDebugStore().store),
            commandLog,
            mapGuide: {
              commands,
              maps: {
                snapshot: () =>
                  mapFails ? Promise.reject(new Error("map down")) : Promise.resolve(snapshot()),
                putEdge: () => Promise.resolve(),
                putGoal: () => Promise.resolve(),
                updateBlock: () => Promise.resolve(),
              },
              routeMap,
            },
          }),
        },
      ]),
      createLogger({}, { write: () => undefined }),
    );
    const post = async (req: GuideRequest) => {
      const result = await handler(
        { ...httpEvent("POST", "/v1/elder/guide", "u1"), body: JSON.stringify(req) },
        lambdaContext,
      );
      return parseBody(result.body) as Record<string, unknown>;
    };
    return {
      post,
      steps,
      record: () => record,
      modelCalls: () => modelCalls,
      bumpOnNextUpdate: () => {
        bump = true;
      },
    };
  }

  it("지도 길이면 Claude 를 부르지 않고, 벗어나면 Claude 로 넘겨 저장한다", async () => {
    const t = setup(command());
    const first = await t.post(request("home"));
    expect(first).toMatchObject({
      type: "highlight",
      targetText: "설정",
      status: "in_progress",
      source: "map",
    });
    expect(t.modelCalls()).toBe(0);
    expect(t.record().mapProgress).toMatchObject({
      mode: "map",
      stepId: first.stepId,
      kind: "edge",
    });
    expect(t.steps[0]).toMatchObject({ stepId: first.stepId, guide: { source: "map" } });

    // 안내와 다른 것을 눌러 다른 화면 → Claude, 이후 계속 Claude
    const off = await t.post(request("display", { seq: 0, action: "tap", text: "카메라" }, 2));
    expect(off).toMatchObject({ type: "highlight", targetText: "밝기 최적화", source: "ai" });
    expect(t.modelCalls()).toBe(1);
    expect(t.record().mapProgress).toMatchObject({ mode: "ai", reason: "not-followed" });
    expect(t.steps[1]).toMatchObject({ guide: { source: "ai" } });
    await t.post(request("home", undefined, 3));
    expect(t.modelCalls()).toBe(2);
  });

  it("같은 화면 재요청은 같은 stepId, 다시 준 횟수를 남기고 두 번 넘으면 Claude", async () => {
    const t = setup(command());
    const first = await t.post(request("home"));
    const again = await t.post(request("home", undefined, 2));
    expect(again).toMatchObject({ source: "map", stepId: first.stepId, requestId: 2 });
    expect(t.record().mapProgress).toMatchObject({ mode: "map", resends: 1 });
    await t.post(request("home", undefined, 3));
    const fourth = await t.post(request("home", undefined, 4));
    expect(fourth).toMatchObject({ source: "ai" });
    expect(t.record().mapProgress).toMatchObject({ mode: "ai", reason: "resend-limit" });
  });

  it("지도를 못 읽으면 Claude 로 넘긴 것을 저장한다", async () => {
    const t = setup(command(), true);
    const res = await t.post(request("home"));
    expect(res).toMatchObject({ source: "ai" });
    expect(t.modelCalls()).toBe(1);
    expect(t.record().mapProgress).toMatchObject({ mode: "ai", reason: "map-error" });
  });

  it("저장이 겹쳐 다시 읽었는데 같은 번호의 새 명령이면 건드리지 않는다", async () => {
    const t = setup(command(), true, true);
    await t.post(request("home"));
    expect(t.record().gen).toBe("g2");
    expect(t.record().mapProgress).toBeUndefined();
  });

  it("재요청 사이에 다른 요청이 Claude 로 넘겼으면 다시 주지 않는다", async () => {
    const t = setup(command());
    const first = await t.post(request("home"));
    t.bumpOnNextUpdate();
    await t.post(request("home", undefined, 2));
    expect(t.modelCalls()).toBe(1);
    expect(t.record().mapProgress).toMatchObject({ mode: "ai" });
    expect(first.stepId).toBeDefined();
  });

  it("commandId 가 없으면 지도를 보지 않는다", async () => {
    const t = setup(command());
    const req: GuideRequest = { ...request("home") };
    delete req.commandId;
    await t.post(req);
    expect(t.modelCalls()).toBe(1);
    expect(t.record().mapProgress).toBeUndefined();
  });
});

describe("buildSeed", () => {
  const doc = (name: keyof typeof screens): ScreenDocument => {
    const req = request(name);
    return {
      screenId: name,
      deviceId: "d1",
      receivedAt: "",
      capturedAt: "",
      pkg: req.screen.pkg,
      fingerprint: "",
      fpVersion: "fp@v1",
      nodeCount: req.screen.nodes.length,
      maskedCount: 0,
      pinned: false,
      screen: { ...req.screen, nodes: maskDeep(req.screen.nodes).value },
    };
  };
  const step = (n: number, stepId: string, lastAction?: StepRecord["lastAction"]): StepRecord => ({
    uid: "u1",
    commandId: 1,
    stepId,
    receivedAt: `2026-11-27T00:00:0${n}.000Z`,
    screen: { deviceId: "d1", screenId: String(n) },
    pkg: SETTINGS,
    guide: { type: "highlight", source: "ai" },
    ...(lastAction ? { lastAction } : {}),
  });
  const steps = [
    step(0, "s0"),
    step(1, "s1", { stepId: "s0", seq: 0, action: "tap", text: "설정" }),
    step(2, "s2", { stepId: "s1", seq: 1, action: "tap", text: "디스플레이" }),
  ];
  const cmd = command({
    endResult: "done",
    finalAction: { stepId: "s2", seq: 2, action: "tap", text: "밝기 최적화" },
  });
  const review = {
    version: "review@v1",
    model: "m",
    reviewedAt: "",
    commandId: 1,
    gen: "g1",
    outcome: "accept",
    reasons: [],
    goal: { kind: "existing", id: "settings.brightness_down" },
    edges: [],
    finish: [],
    opus: {
      success: "yes",
      evidence: "",
      goal: { kind: "existing", id: "settings.brightness_down", proposal: null },
      moves: [
        { seq: 0, action: "tap", text: "설정" },
        { seq: 1, action: "tap", text: "디스플레이" },
      ],
      finish: [{ seq: 2, action: "tap", text: "밝기 최적화", verify: "node_state" }],
      sensitiveSeqs: [],
      personalText: false,
    },
    stats: { screens: 3, actions: 3, ms: 1 },
  } satisfies ReviewRecord;
  const input = {
    uid: "u1",
    command: cmd,
    review,
    steps,
    docs: [doc("home"), doc("settings"), doc("display")],
    finalDoc: doc("displayDone"),
    now: new Date("2026-11-27T00:00:00.000Z"),
  };

  it("검토된 길을 지도로 만들면 지도 안내가 같은 길을 낸다", () => {
    const seed = buildSeed(input);
    if (!seed.ok) throw new Error(seed.error);
    expect(seed.warnings).toEqual([]);
    expect(seed.edges.map((e) => e.edgeId)).toEqual([E1.edgeId, E2.edgeId]);
    expect(seed.goal).toMatchObject({
      arriveFps: [FP.display],
      finish: GOAL.finish,
      status: "verified",
    });

    const snap = snapshot({ edges: seed.edges, goals: new Map([[seed.goal.goalId, seed.goal]]) });
    expect(decide(request("home"), command(), snap)).toMatchObject({
      kind: "step",
      response: { targetText: "설정" },
    });
  });

  it("같은 stepId 재요청 기록은 한 단계로 (처음 것)", () => {
    const resent = {
      ...(steps[1] as StepRecord),
      receivedAt: "2026-11-27T00:00:01.500Z",
    };
    delete resent.lastAction;
    const merged = stepsOfCommand([...steps, resent], cmd);
    expect(merged.map((x) => x.stepId)).toEqual(["s0", "s1", "s2"]);
    expect(merged[1]?.lastAction?.text).toBe("설정");
  });

  it("human·무효·다른 목표·개인 글자는 넣지 않는다", () => {
    expect(buildSeed({ ...input, review: { ...review, outcome: "human" } })).toMatchObject({
      ok: false,
    });
    expect(
      buildSeed({ ...input, review: { ...review, outcome: "human" }, force: true }),
    ).toMatchObject({ ok: true });
    const seeded = buildSeed(input);
    if (!seeded.ok) throw new Error(seeded.error);
    const otherFinish = {
      ...seeded.goal,
      finish: [{ ...seeded.goal.finish[0], targetText: "다른 것" } as MapFinishStep],
    };
    expect(buildSeed({ ...input, existingGoal: otherFinish })).toMatchObject({ ok: false });
    expect(buildSeed({ ...input, existingGoal: seeded.goal })).toMatchObject({ ok: true });
    // 끝 단계 없던 목표에 끝 단계가 있는 길도 합치지 않는다 (옛 도착 화면에 새 끝 단계가 붙음)
    expect(buildSeed({ ...input, existingGoal: { ...seeded.goal, finish: [] } })).toMatchObject({
      ok: false,
    });
    expect(buildSeed({ ...input, review: { ...review, invalidated: "scam" } })).toMatchObject({
      ok: false,
    });
    expect(
      buildSeed({ ...input, command: { ...cmd, chosenGoal: "settings.brightness_up" } }),
    ).toMatchObject({ ok: false });
    expect(
      buildSeed({ ...input, review: { ...review, opus: { ...review.opus, personalText: true } } }),
    ).toMatchObject({ ok: false });
  });
});
