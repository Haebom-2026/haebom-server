/** npm run mock: 배운 지도·명령 검토 가짜 데이터 (서버 src/debug/insight.ts 모양) */
import type {
  CommandInsightView,
  LearnedEdge,
  LearnedMapView,
  ReviewView,
  StepView,
} from "./learn-types.ts";
import type { MapNames } from "./types.ts";

const NAMES: MapNames = {
  version: "map@seed-2",
  apps: { gov24: "정부24", settings: "설정" },
  roles: {},
  goals: {
    "gov24.resident_copy": "등본",
    "settings.brightness_down": "화면 어둡게",
    "settings.wifi_on": "와이파이 켜기",
  },
};

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ev = (n: number, device: string) => `elder-${n}#17957${n}#g${n}@${device}`;

const edge = (
  edgeId: string,
  part: Partial<LearnedEdge> & Pick<LearnedEdge, "fromFp" | "toFp" | "targetText">,
): LearnedEdge => ({
  SK: `EDGE#${edgeId}`,
  edgeId,
  pkg: "com.android.settings",
  action: "tap",
  targetClass: "TextView",
  status: "candidate",
  origin: "learned",
  evidence: [],
  devices: [],
  createdAt: ago(600),
  ...part,
});

export function mockLearnedMap(): LearnedMapView {
  return {
    serverTime: new Date().toISOString(),
    names: NAMES,
    block: { edgeIds: ["9f00aa11bb22cc33"], goalIds: [] },
    edges: [
      edge("1c1b64658655dd4e", {
        fromFp: "m-launcher-01",
        toFp: "m-settings-main",
        targetText: "설정",
        pkg: "com.sec.android.app.launcher",
        status: "verified",
        evidence: [ev(1, "galaxy-a"), ev(2, "pixel-b")],
        devices: ["galaxy-a", "pixel-b"],
        lastUsedAt: ago(5),
        recent: [1, 1, 1, 1],
      }),
      edge("1fedd0adbf19281a", {
        fromFp: "m-settings-main",
        toFp: "m-display",
        targetText: "디스플레이",
        status: "verified",
        evidence: [ev(1, "galaxy-a"), ev(2, "pixel-b"), ev(3, "galaxy-a")],
        devices: ["galaxy-a", "pixel-b"],
        lastUsedAt: ago(5),
        recent: [1, 1, 0, 1],
      }),
      edge("5a5a77e0c0ffee01", {
        fromFp: "m-settings-main",
        toFp: "m-connections",
        targetText: "연결",
        evidence: [ev(4, "galaxy-a")],
        devices: ["galaxy-a"],
      }),
      edge("77aa00bb11cc22dd", {
        fromFp: "m-connections",
        toFp: "m-wifi",
        targetText: "Wi-Fi",
        evidence: [],
        oldEvidence: [ev(5, "galaxy-a"), ev(6, "pixel-b")],
        devices: [],
        demotedAt: ago(40),
        recent: [1, 0, 0],
      }),
      edge("9f00aa11bb22cc33", {
        fromFp: "m-display",
        toFp: "m-display-adv",
        targetText: "고급 설정",
        status: "verified",
        origin: "seed",
        evidence: ["seed#0#0@seed"],
        devices: [],
        createdAt: ago(60 * 24 * 120),
        stale: true,
      }),
    ],
    goals: [
      {
        SK: "GOAL#settings.brightness_down",
        goalId: "settings.brightness_down",
        pkg: "com.android.settings",
        status: "verified",
        origin: "learned",
        arriveFps: ["m-display"],
        evidence: [],
        devices: [],
        updatedAt: ago(5),
        recent: [1, 1],
        finish: [
          {
            action: "swipe_left",
            targetText: "밝기",
            targetClass: "SeekBar",
            verify: "node_state",
            sensitive: false,
          },
        ],
      },
      {
        SK: "GOAL#settings.wifi_on",
        goalId: "settings.wifi_on",
        pkg: "com.android.settings",
        status: "candidate",
        origin: "learned",
        arriveFps: [],
        evidence: [],
        devices: [],
        demotedAt: ago(40),
        cleanupArrivals: ago(40),
        recent: [0],
        finish: [
          {
            action: "tap",
            targetText: "Wi-Fi",
            targetClass: "Switch",
            verify: "node_state",
            sensitive: false,
          },
        ],
      },
    ],
    arrives: [
      {
        SK: "ARRIVE#settings.brightness_down#m-display",
        goalId: "settings.brightness_down",
        fp: "m-display",
        status: "verified",
        evidence: [ev(1, "galaxy-a"), ev(2, "pixel-b")],
        devices: ["galaxy-a", "pixel-b"],
      },
      {
        SK: "ARRIVE#settings.wifi_on#m-wifi",
        goalId: "settings.wifi_on",
        fp: "m-wifi",
        status: "candidate",
        evidence: [ev(5, "galaxy-a")],
        devices: ["galaxy-a"],
      },
    ],
    pending: [
      {
        SK: "PENDING#elder-7#1795700007#g7",
        uid: "elder-7",
        commandId: 1795700007,
        gen: "g7",
        reasons: ["new_goal"],
        proposal: { name: "글자 크게", desc: "화면 글자 크기를 키운다", slots: [] },
        createdAt: ago(25),
      },
      {
        SK: "PENDING#elder-8#1795700008#g8",
        uid: "elder-8",
        commandId: 1795700008,
        gen: "g8",
        reasons: ["sensitive_goal"],
        goalId: "gov24.resident_copy",
        createdAt: ago(12),
      },
    ],
    applied: [
      {
        SK: "APPLIED#elder-1#179571#g1",
        uid: "elder-1",
        commandId: 179571,
        gen: "g1",
        entry: ev(1, "galaxy-a"),
        edgeIds: ["1c1b64658655dd4e", "1fedd0adbf19281a"],
        goalId: "settings.brightness_down",
        arriveFp: "m-display",
      },
    ],
  };
}

const step = (
  n: number,
  deviceId: string,
  guide: StepView["guide"],
  lastAction?: StepView["lastAction"],
): StepView => ({
  SK: `CMD#1#STEP#${n}`,
  stepId: `s${n}`,
  receivedAt: ago(10 - n),
  screen: { deviceId, screenId: `2026112${n}T000000000Z-00000${n}` },
  pkg: "kr.go.gov24",
  page: { kind: "exact", pageId: `p000000${n}` },
  guide,
  ...(lastAction ? { lastAction } : {}),
});

/** 명령 번호에 따라 세 가지: 지도 안내 + accept 반영 / Claude 안내 + human 대기 / 아직 검토 전 */
export function mockCommandInsight(deviceId: string, commandId: number): CommandInsightView {
  const variant = commandId % 3;
  const gen = `gen-${commandId}`;
  const steps: StepView[] = [
    step(1, deviceId, {
      type: "highlight",
      targetText: "증명서 발급",
      source: variant === 0 ? "map" : "ai",
    }),
    step(
      2,
      deviceId,
      { type: "highlight", targetText: "주민등록표 등본", source: variant === 0 ? "map" : "ai" },
      { stepId: "s1", seq: 1, action: "tap", text: "증명서 발급" },
    ),
    step(
      3,
      deviceId,
      { type: "done", status: "done", source: "ai" },
      { stepId: "s2", seq: 2, action: "tap", text: "주민등록표 등본" },
    ),
  ];
  const review: ReviewView = {
    version: "review@v1",
    model: "claude-opus-5-5",
    reviewedAt: ago(1),
    commandId,
    gen,
    outcome: variant === 0 ? "accept" : "human",
    reasons: variant === 0 ? [] : ["new_goal"],
    appId: "gov24",
    goal:
      variant === 0
        ? { kind: "existing", id: "gov24.resident_copy" }
        : { kind: "new", proposal: { name: "초본 받기", desc: "주민등록 초본을 발급한다" } },
    edges: [
      { from: "p0000001", to: "p0000002", action: "tap", text: "증명서 발급", pkg: "kr.go.gov24" },
    ],
    opus: {
      success: "yes",
      evidence: "마지막 화면에 '발급 완료' 글자와 등본 미리보기가 보입니다.",
      goal: { kind: variant === 0 ? "existing" : "new", id: null, proposal: null },
      moves: [{ seq: 1, action: "tap", text: "증명서 발급" }],
      finish: [{ seq: 2, action: "tap", text: "주민등록표 등본", verify: "page" }],
      sensitiveSeqs: [],
      personalText: false,
    },
    stats: { screens: 3, actions: 2, inputTokens: 5210, outputTokens: 340, ms: 8400 },
  };
  return {
    uid: "elder-mock",
    commandId,
    names: NAMES,
    command: {
      commandId,
      gen,
      createdAt: ago(10),
      level: "L2",
      category: "public",
      chosenApp: "gov24",
      chosenGoal: "gov24.resident_copy",
      ...(variant === 2 ? {} : { endResult: "done", endedAt: ago(2) }),
      mapProgress:
        variant === 0
          ? { mode: "map", kind: "finish", ref: "0", stepId: "s2", fp: "m-gov24-cert" }
          : { mode: "ai", reason: "no-map" },
    },
    steps,
    reviews: variant === 2 ? [] : [{ SK: `CMD#${commandId}#REVIEW#${gen}`, review }],
    applied:
      variant === 0
        ? [
            {
              SK: `APPLIED#elder-mock#${commandId}#${gen}`,
              uid: "elder-mock",
              commandId,
              gen,
              entry: `elder-mock#${commandId}#${gen}@${deviceId}`,
              edgeIds: ["1c1b64658655dd4e"],
              goalId: "gov24.resident_copy",
              arriveFp: "m-gov24-cert",
            },
          ]
        : [],
    pending:
      variant === 1
        ? [
            {
              SK: `PENDING#elder-mock#${commandId}#${gen}`,
              uid: "elder-mock",
              commandId,
              gen,
              reasons: ["human_review", "new_goal"],
              proposal: { name: "초본 받기", desc: "주민등록 초본을 발급한다" },
              createdAt: ago(1),
            },
          ]
        : [],
  };
}
