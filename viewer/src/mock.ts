/**
 * npm run mock: 서버·로그인 없이 화면을 확인하기 위한 가짜 API.
 * "시연폰 A" 는 3초마다 정부24 흐름의 다음 화면을 보내는 것처럼 동작한다 (실시간 표시 확인용).
 * 시계 글자가 바뀌어도 지문이 같은지 볼 수 있도록 같은 화면을 다시 지나가게 했다.
 */
import type { Api } from "./api.ts";
import type { Device, Pin, ScreenDocument, ScreenNode, ScreenSummary } from "./types.ts";

const W = 1080;
const H = 2400;

type Template = { name: string; fp: string; nodes: (clock: string) => ScreenNode[] };

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

/** 정부24 흐름: 메인 → 목록 → 신청 → 목록(뒤로) → 신청 → 인증 → 메인 … */
const FLOW = [0, 1, 2, 1, 2, 3, 0];

const devices = new Map<string, Omit<Device, "online">>();
const screens: ScreenDocument[] = [];
const pins: Pin[] = [];

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const screenIdAt = (date: Date) =>
  `${date.toISOString().replace(/[-:.]/g, "")}-${Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0")}`;
const clockText = (date: Date) => {
  const h = date.getHours();
  return `${h < 12 ? "오전" : "오후"} ${h % 12 || 12}:${pad(date.getMinutes())}`;
};

function addScreen(deviceId: string, step: number, at: Date) {
  const template = TEMPLATES[FLOW[step % FLOW.length] ?? 0] ?? TEMPLATES[0];
  if (!template) return;
  const nodes = template.nodes(clockText(at));
  screens.push({
    screenId: screenIdAt(at),
    deviceId,
    receivedAt: at.toISOString(),
    capturedAt: new Date(at.getTime() - 120).toISOString(),
    pkg: "kr.go.gov24",
    appHash: template.fp.slice(0, 8),
    fingerprint: template.fp,
    fpVersion: "fp@v1",
    nodeCount: nodes.length,
    maskedCount: template.name === "등본 신청" ? 1 : 0,
    pinned: false,
    screen: { pkg: "kr.go.gov24", width: W, height: H, nodes },
  });
  const device = devices.get(deviceId);
  if (device) {
    device.lastScreenAt = at.toISOString();
    device.lastSeenAt = at.toISOString();
    device.screenCount += 1;
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
for (let step = 0; step < 8; step++)
  addScreen("a3f9c1e2-demo-a", step, new Date(start - (8 - step) * 7000));
for (let step = 0; step < 5; step++) {
  addScreen("b7d20f44-demo-b", step, new Date(start - 2 * 3600_000 - (5 - step) * 9000));
}
const bDevice = devices.get("b7d20f44-demo-b");
if (bDevice) bDevice.lastSeenAt = new Date(start - 2 * 3600_000).toISOString();

let liveStep = 8;
setInterval(() => {
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
    const mine = screens.filter((s) => s.deviceId === deviceId).map(summary);
    const limit = query.limit ?? 50;
    const { since, from, to } = query;
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
