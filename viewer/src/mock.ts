/**
 * npm run mock: 서버·로그인 없이 화면을 확인하기 위한 가짜 API.
 * "시연폰 A" 는 3초마다 정부24 흐름의 다음 화면을 보내는 것처럼 동작한다 (실시간 표시 확인용).
 * 시계 글자가 바뀌어도 지문이 같은지 볼 수 있도록 같은 화면을 다시 지나가게 했다.
 */
import type { Api } from "./api.ts";
import type {
  ClassifyEntryDetail,
  CommandEntryDocument,
  Device,
  Pin,
  ScreenDocument,
  ScreenMatch,
  ScreenNode,
  ScreenSummary,
} from "./types.ts";

const W = 1080;
const H = 2400;

type Template = {
  name: string;
  fp: string;
  pkg?: string;
  nodes: (clock: string, step: number) => ScreenNode[];
};

const statusBar = (clock: string): ScreenNode[] => [
  { i: 0, t: clock, c: "TextView", b: [40, 20, 200, 80] },
  { i: 1, d: "배터리 82%", c: "ImageView", b: [940, 20, 1040, 80] },
];

const TEMPLATES: Template[] = [
  {
    name: "정부24 메인",
    fp: "a1f04c2e9b7d3a10",
    nodes: (clock) => [
      ...statusBar(clock),
      { i: 2, t: "정부24", c: "TextView", b: [60, 140, 400, 230] },
      { i: 3, d: "검색", c: "ImageButton", b: [920, 140, 1040, 240], clickable: true },
      { i: 4, t: "민원 신청", c: "Button", b: [60, 420, 520, 640], clickable: true },
      { i: 5, t: "증명서 발급", c: "Button", b: [560, 420, 1020, 640], clickable: true },
      { i: 6, t: "보조금24", c: "Button", b: [60, 680, 520, 900], clickable: true },
      { i: 7, t: "알림 3건", c: "TextView", b: [560, 680, 1020, 900] },
      { i: 8, t: "홈", c: "Tab", b: [0, 2240, 270, 2400], selected: true },
      { i: 9, t: "전체메뉴", c: "Tab", b: [810, 2240, 1080, 2400] },
    ],
  },
  {
    name: "증명서 발급 목록",
    fp: "7c2b88e01f4d5a63",
    nodes: (clock) => [
      ...statusBar(clock),
      { i: 2, d: "뒤로 가기", c: "ImageButton", b: [20, 140, 140, 260], clickable: true },
      { i: 3, t: "증명서 발급", c: "TextView", b: [160, 150, 700, 250] },
      { i: 4, t: "주민등록표 등본", c: "Button", b: [60, 360, 1020, 520], clickable: true },
      { i: 5, t: "주민등록표 초본", c: "Button", b: [60, 540, 1020, 700], clickable: true },
      {
        i: 6,
        t: "건강보험 자격득실 확인서",
        c: "Button",
        b: [60, 720, 1020, 880],
        clickable: true,
      },
      { i: 7, t: "지방세 납세증명서", c: "Button", b: [60, 900, 1020, 1060], clickable: true },
    ],
  },
  {
    name: "등본 신청",
    fp: "e93d10b4c6a27f85",
    nodes: (clock) => [
      ...statusBar(clock),
      { i: 2, d: "뒤로 가기", c: "ImageButton", b: [20, 140, 140, 260], clickable: true },
      { i: 3, t: "주민등록표 등본 발급", c: "TextView", b: [160, 150, 900, 250] },
      { i: 4, t: "주민등록번호 ***", c: "TextView", b: [60, 380, 1020, 470] },
      { i: 5, t: "수령 방법", c: "TextView", b: [60, 520, 400, 600] },
      {
        i: 6,
        t: "온라인 발급(본인 출력)",
        c: "RadioButton",
        b: [60, 620, 1020, 720],
        checked: true,
      },
      { i: 7, t: "전자문서지갑", c: "RadioButton", b: [60, 740, 1020, 840] },
      { i: 8, t: "민원 신청하기", c: "Button", b: [60, 2080, 1020, 2220], clickable: true },
    ],
  },
  {
    name: "본인 인증",
    fp: "40b7e2d9113c8a6f",
    nodes: (clock) => [
      ...statusBar(clock),
      { i: 2, t: "본인 인증", c: "TextView", b: [60, 150, 700, 250] },
      { i: 3, t: "간편인증", c: "Button", b: [60, 380, 1020, 560], clickable: true },
      { i: 4, t: "공동인증서", c: "Button", b: [60, 580, 1020, 760], clickable: true },
      { i: 5, t: "취소", c: "Button", b: [60, 2080, 1020, 2220], clickable: true },
    ],
  },
];

/** 영상 제목이 계속 바뀌는 화면: fp@v1 은 매번 갈리고 "누를 수 있는 것만" 이면 하나로 묶인다 */
const VIDEOS = ["트로트 메들리 1시간", "아침 체조 따라하기", "고향의 봄 합창", "오늘의 날씨"];
TEMPLATES.push({
  name: "유튜브 홈",
  fp: "",
  pkg: "com.google.android.youtube",
  nodes: (clock, step) => [
    ...statusBar(clock),
    { i: 2, d: "검색", c: "ImageButton", b: [900, 120, 1040, 240], clickable: true },
    {
      i: 3,
      t: VIDEOS[step % VIDEOS.length] ?? "",
      c: "TextView",
      b: [40, 900, 1040, 980],
    },
    { i: 4, d: "동영상 재생", c: "View", b: [0, 280, 1080, 880], clickable: true },
    { i: 5, t: "홈", c: "Button", b: [0, 2240, 270, 2400], clickable: true },
    { i: 6, t: "구독", c: "Button", b: [540, 2240, 810, 2400], clickable: true },
  ],
});

/** 정부24 흐름: 메인 → 목록 → 신청 → 목록(뒤로) → 신청 → 인증 → 메인 … */
const FLOW = [0, 1, 2, 1, 2, 3, 0];

const devices = new Map<string, Omit<Device, "online">>();
const screens: ScreenDocument[] = [];
const pins: Pin[] = [];

const seenFps = new Map<string, Set<string>>();
const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const screenIdAt = (date: Date) =>
  `${date.toISOString().replace(/[-:.]/g, "")}-${Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0")}`;
const clockText = (date: Date) => {
  const h = date.getHours();
  return `${h < 12 ? "오전" : "오후"} ${h % 12 || 12}:${pad(date.getMinutes())}`;
};

function addScreen(deviceId: string, step: number, at: Date, index?: number) {
  const template = TEMPLATES[index ?? FLOW[step % FLOW.length] ?? 0] ?? TEMPLATES[0];
  if (!template) return;
  let nodes = template.nodes(clockText(at), step);
  let fp = template.fp || `${template.name}-${step % VIDEOS.length}`;
  // 정부24 메인: 가끔 공지 배너가 위에 붙어 아래 노드가 밀린다 → fp@v1 이 갈린다
  if (template.name === "정부24 메인" && step % 3 === 1) {
    nodes = [
      ...nodes.map((n) =>
        n.b && n.b[1] > 100 && n.b[1] < 2200
          ? {
              ...n,
              b: [n.b[0], n.b[1] + 260, n.b[2], n.b[3] + 260] as [number, number, number, number],
            }
          : n,
      ),
      { i: nodes.length, t: "시스템 점검 안내", c: "TextView", b: [60, 260, 1020, 380] },
    ];
    fp = `${template.fp.slice(0, 15)}b`;
  }
  const pkg = template.pkg ?? "kr.go.gov24";
  // 서버 화면 매칭 흉내: 템플릿 = 페이지. 처음이면 new, 본 지문이면 exact, 아니면 similar
  const pageId = `p${String(TEMPLATES.indexOf(template)).padStart(7, "0")}`;
  const seen = seenFps.get(pageId);
  const match: ScreenMatch = !seen
    ? { version: "match@v1", kind: "new", pageId, score: 0 }
    : seen.has(fp)
      ? { version: "match@v1", kind: "exact", pageId, score: 1 }
      : pkg.includes("youtube") && seen.size === 2
        ? // dev 처럼 유튜브에서 가끔 판단 보류 (묶음 중간에 섞이게)
          {
            version: "match@v1",
            kind: "ambiguous",
            pageId,
            score: 0.67,
            runnerUp: { pageId: "p9999999", score: 0.64 },
          }
        : { version: "match@v1", kind: "similar", pageId, score: 0.71 };
  seenFps.set(pageId, (seen ?? new Set()).add(fp));
  screens.push({
    screenId: screenIdAt(at),
    deviceId,
    receivedAt: at.toISOString(),
    capturedAt: new Date(at.getTime() - 120).toISOString(),
    pkg,
    appHash: fp.slice(0, 8),
    fingerprint: fp,
    fpVersion: "fp@v1",
    nodeCount: nodes.length,
    maskedCount: template.name === "등본 신청" ? 1 : 0,
    pinned: false,
    match,
    screen: { pkg, width: W, height: H, nodes },
  });
  const device = devices.get(deviceId);
  if (device) {
    device.lastScreenAt = at.toISOString();
    device.lastSeenAt = at.toISOString();
    device.screenCount += 1;
  }
}

// ---------- 명령 기록 (classify·앱 선택) ----------
const entries: CommandEntryDocument[] = [];
const THRESHOLDS = {
  app: 0.5,
  role: 0.5,
  intentMin: 0.25,
  intentGap: 0.2,
  goal: 0.7,
  goalMargin: 0.3,
  goalAskMin: 0.3,
  exclusive: 0.9,
  maxCandidates: 3,
};
const NAMES = {
  version: "map@seed-2",
  apps: { gov24: "정부24", youtube: "유튜브", settings: "설정", kakaotalk: "카카오톡" },
  roles: { gov_docs: "공공 서류", video: "영상 보기", settings: "설정" },
  goals: {
    "gov24.resident_copy": "등본",
    "gov24.resident_abstract": "초본",
    "gov24.basic_cert": "기본증명서",
  },
};
const GOV24 = {
  appId: "gov24",
  name: "정부24",
  packages: ["kr.go.gov24"],
  by: "jev" as const,
  level: "L2" as const,
};

/** 예시 classify 세 가지: 목표 정함 / 목표 물음 / 해당 없음 */
function classifyDetail(variant: number, commandId: number): ClassifyEntryDetail {
  const base = {
    request: { utterance: "", ruleLevel: "L0", ruleApp: "", signals: [] as string[] },
    safety: {
      status: "ok",
      promptVersion: "classify@v1",
      output: {
        intent: "OPEN_APP",
        app: null,
        level: "L1",
        category: "public",
        reason: "공공 서류 발급",
      },
      inputTokens: 812,
      outputTokens: 41,
    },
    saved: "created",
    ms: 1180,
    names: NAMES,
  };
  const appTrace = (top: number, none: number) => ({
    ok: true,
    ms: 640,
    cost: 0.00004,
    probs: [
      ["gov24", top],
      ["none", none],
      ["settings", 0.01],
      ["youtube", 0.005],
    ] as [string, number][],
    roles: [
      ["gov_docs", top],
      ["settings", 0.01],
      ["video", 0.005],
    ] as [string, number][],
    mention: { kind: "none" as const },
    rule: top >= 0.9 ? "exclusive" : "top_app",
  });
  if (variant === 2) {
    return {
      kind: "classify",
      ...base,
      request: { ...base.request, utterance: "오늘 저녁 뭐 먹지" },
      safety: {
        ...base.safety,
        output: {
          ...base.safety.output,
          intent: "UNKNOWN",
          level: "L0",
          category: "none",
          reason: "일반 대화",
        },
      },
      selection: {
        kind: "fail",
        reason: "none",
        mapVersion: "map@seed-2",
        ms: 610,
        cost: 0.00004,
        confidence: { app: 0.08, role: 0.08 },
      },
      trace: {
        masked: "오늘 저녁 뭐 먹지",
        thresholds: THRESHOLDS,
        app: {
          ok: true,
          ms: 610,
          cost: 0.00004,
          probs: [
            ["none", 0.86],
            ["youtube", 0.08],
            ["kakaotalk", 0.04],
          ],
          roles: [["video", 0.08]],
          mention: { kind: "none" },
          rule: "none",
        },
        goals: [],
      },
      response: {
        commandId,
        intent: "UNKNOWN",
        app: null,
        sensitivity: { level: "L0", category: "none", reason: "일반 대화", signals: [] },
      },
    };
  }
  const ask = variant === 1;
  const utterance = ask ? "서류 떼 줘" : "등본 떼 줘 010-****-****";
  const goalProbs: [string, number][] = ask
    ? [
        ["gov24.resident_copy", 0.48],
        ["gov24.resident_abstract", 0.41],
        ["none", 0.06],
        ["gov24.basic_cert", 0.05],
      ]
    : [
        ["gov24.resident_copy", 0.91],
        ["gov24.basic_cert", 0.05],
        ["gov24.resident_abstract", 0.03],
        ["none", 0.01],
      ];
  const candidate = ask
    ? {
        ...GOV24,
        clarify: {
          questionId: "goal:gov24",
          say: "등본인가요, 초본인가요?",
          options: [
            { id: "gov24.resident_copy", name: "등본" },
            { id: "gov24.resident_abstract", name: "초본" },
          ],
        },
      }
    : {
        ...GOV24,
        goal: {
          id: "gov24.resident_copy",
          version: 1,
          name: "등본",
          level: "L2" as const,
          slots: [],
          confidence: 0.91,
          verified: true,
        },
      };
  return {
    kind: "classify",
    ...base,
    request: { ...base.request, utterance },
    selection: {
      kind: "route",
      role: "gov_docs",
      named: false,
      exclusive: !ask,
      ask: false,
      candidates: [candidate],
      confidence: { app: ask ? 0.78 : 0.97, role: ask ? 0.78 : 0.97 },
      mapVersion: "map@seed-2",
      ms: 1020,
      cost: 0.00008,
    },
    trace: {
      masked: utterance,
      thresholds: THRESHOLDS,
      app: appTrace(ask ? 0.78 : 0.97, ask ? 0.15 : 0.01),
      goals: [
        {
          ok: true,
          ms: 380,
          cost: 0.00004,
          appId: "gov24",
          probs: goalProbs,
          judged: ask ? "ask" : "goal",
        },
      ],
    },
    response: {
      commandId,
      intent: "OPEN_APP",
      app: null,
      sensitivity: { level: "L2", category: "public", reason: "공공 서류 발급", signals: [] },
      route: { candidates: [{ appId: "gov24", name: "정부24", packages: ["kr.go.gov24"] }] },
    },
  };
}

let commandSeq = 100;
function addCommand(deviceId: string, at: Date, variant: number) {
  const commandId = commandSeq++;
  const detail = classifyDetail(variant, commandId);
  const sel = detail.selection;
  const empty = {
    pkg: "",
    fingerprint: "",
    fpVersion: "",
    nodeCount: 0,
    maskedCount: 0,
    pinned: false,
  };
  entries.push({
    ...empty,
    screenId: screenIdAt(at),
    deviceId,
    receivedAt: at.toISOString(),
    capturedAt: at.toISOString(),
    entry: "command",
    command: {
      kind: "classify",
      commandId,
      utterance: detail.request.utterance,
      level: detail.response.sensitivity.level,
      category: detail.response.sensitivity.category,
      route: sel?.kind ?? "off",
      ...(sel?.kind === "fail" ? { routeReason: sel.reason } : {}),
      ...(sel?.kind === "route"
        ? {
            candidates: sel.candidates.map((c) => c.name),
            goal: sel.candidates[0]?.goal?.name ?? (sel.candidates[0]?.clarify ? "?" : undefined),
          }
        : {}),
    } as CommandEntryDocument["command"],
    detail,
  });
  if (sel?.kind === "route") {
    const chosenAt = new Date(at.getTime() + 900);
    entries.push({
      ...empty,
      screenId: screenIdAt(chosenAt),
      deviceId,
      receivedAt: chosenAt.toISOString(),
      capturedAt: chosenAt.toISOString(),
      entry: "command",
      command: {
        kind: "choose",
        commandId,
        level: "L2",
        appId: "gov24",
        appName: "정부24",
        ...(variant === 0 ? { goal: "등본" } : {}),
      },
      detail: {
        kind: "choose",
        body: { appId: "gov24", installState: "installed", askedUser: false },
        response: {
          commandId,
          appId: "gov24",
          ...(variant === 0 ? { goal: { id: "gov24.resident_copy", name: "등본" } } : {}),
          sensitivity: { level: "L2" },
        },
        names: NAMES,
      },
    });
  }
}

// 초기 데이터
const start = Date.now();
devices.set("a3f9c1e2-demo-a", {
  deviceId: "a3f9c1e2-demo-a",
  uid: "anon-uid-a",
  model: "SM-S928N",
  os: "Android 15",
  appVersion: "0.3.1",
  label: "시연폰 A",
  lastSeenAt: new Date(start).toISOString(),
  screenCount: 0,
});
devices.set("b7d20f44-demo-b", {
  deviceId: "b7d20f44-demo-b",
  uid: "anon-uid-b",
  model: "SM-S918N",
  os: "Android 14",
  appVersion: "0.3.0",
  lastSeenAt: new Date(start - 2 * 3600_000).toISOString(),
  screenCount: 0,
});
addCommand("a3f9c1e2-demo-a", new Date(start - 8 * 7000 - 3000), 0);
for (let step = 0; step < 8; step++)
  addScreen("a3f9c1e2-demo-a", step, new Date(start - (8 - step) * 7000));
addCommand("a3f9c1e2-demo-a", new Date(start - 3 * 7000 + 2500), 2);
for (let step = 0; step < 5; step++) {
  addScreen("b7d20f44-demo-b", step, new Date(start - 2 * 3600_000 - (5 - step) * 9000));
}
for (let step = 0; step < 6; step++) {
  addScreen("b7d20f44-demo-b", step, new Date(start - 2 * 3600_000 + step * 5000), 4);
}
const bDevice = devices.get("b7d20f44-demo-b");
if (bDevice) bDevice.lastSeenAt = new Date(start - 2 * 3600_000).toISOString();

let liveStep = 8;
setInterval(() => {
  // 정부24 첫 화면으로 돌아올 때마다 그 앞에 명령 하나 (목표 정함·목표 물음 번갈아)
  // 실제 서버처럼 명령 기록은 "받은 시각"으로, 처리(1~2초)가 끝난 뒤에 저장된다:
  // 그 사이 폰 화면이 먼저 저장되므로 뷰어 폴링이 뒤돌아 가져와야 보인다
  if (FLOW[liveStep % FLOW.length] === 0) {
    const receivedAt = new Date(Date.now() - 500);
    const variant = liveStep % 2;
    setTimeout(() => addCommand("a3f9c1e2-demo-a", receivedAt, variant), 1800);
  }
  addScreen("a3f9c1e2-demo-a", liveStep++, new Date());
}, 3000);
setInterval(() => {
  const a = devices.get("a3f9c1e2-demo-a");
  if (a) a.lastSeenAt = new Date().toISOString();
}, 5000);

const summary = ({ screen: _screen, guide: _guide, ...rest }: ScreenDocument): ScreenSummary =>
  rest;
const delay = <T>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), 80));

export const mockApi: Api = {
  devices: () => {
    const now = Date.now();
    return delay({
      items: [...devices.values()]
        .map((d) => ({ ...d, online: now - Date.parse(d.lastSeenAt) <= 15_000 }))
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
      serverTime: new Date(now).toISOString(),
    });
  },
  setLabel: (deviceId, label) => {
    const device = devices.get(deviceId);
    if (device) device.label = label;
    return delay(undefined);
  },
  screens: (deviceId, query = {}) => {
    const mine = [
      ...screens.filter((s) => s.deviceId === deviceId).map(summary),
      ...entries
        .filter((e) => e.deviceId === deviceId)
        .map(({ detail: _detail, ...rest }): ScreenSummary => rest),
    ].sort((a, b) => a.screenId.localeCompare(b.screenId));
    const limit = query.limit ?? 50;
    const { since, from, to } = query;
    // 서버 screenIdSchema 와 같은 검사 (src/debug/schema.ts): 모양이 다르면 400
    const screenIdShape = /^\d{8}T\d{9}Z-[0-9a-f]{6}$/;
    for (const v of [since, from, to])
      if (v !== undefined && !screenIdShape.test(v))
        return Promise.reject(new Error(`400 invalid screenId: ${v}`));
    if (since !== undefined)
      return delay({ items: mine.filter((s) => s.screenId > since).slice(0, limit) });
    if (from !== undefined && to !== undefined) {
      return delay({
        items: mine.filter((s) => s.screenId >= from && s.screenId <= to).slice(0, limit),
      });
    }
    return delay({ items: mine.reverse().slice(0, limit) });
  },
  screen: (deviceId, screenId) => {
    const found = screens.find((s) => s.deviceId === deviceId && s.screenId === screenId);
    return found ? delay(found) : Promise.reject(new Error("not found"));
  },
  entry: (deviceId, screenId) => {
    const found = entries.find((s) => s.deviceId === deviceId && s.screenId === screenId);
    return found ? delay(found) : Promise.reject(new Error("not found"));
  },
  pin: (deviceId, from, to, name) => {
    const inRange = screens.filter(
      (s) => s.deviceId === deviceId && s.screenId >= from && s.screenId <= to,
    );
    for (const s of inRange) s.pinned = true;
    const pin: Pin = {
      pinId: crypto.randomUUID(),
      deviceId,
      from,
      to,
      name,
      createdBy: "mock@example.com",
      createdAt: new Date().toISOString(),
      screenCount: inRange.length,
    };
    pins.unshift(pin);
    return delay(pin);
  },
  pins: () => delay({ items: pins }),
};
