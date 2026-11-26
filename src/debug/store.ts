import type { MatchResult } from "../cache/match.js";
import type { HeartbeatInput, Screen } from "./schema.js";

/** 보관 기간 (docs/server-plan.md 12.5) */
export const SCREEN_TTL_SECONDS = 3 * 24 * 3600;
export const PINNED_TTL_SECONDS = 30 * 24 * 3600;
export const DEVICE_TTL_SECONDS = 30 * 24 * 3600;
/** heartbeat 5초 × 3 */
export const ONLINE_WINDOW_MS = 15_000;
export const MAX_PIN_SCREENS = 500;
/** 페이지(화면 매칭 결과 묶음)는 마지막으로 본 뒤 30일 */
export const PAGE_TTL_SECONDS = 30 * 24 * 3600;

export interface DeviceRecord {
  deviceId: string;
  uid: string;
  model: string;
  os: string;
  appVersion: string;
  label?: string;
  lastSeenAt: string;
  lastScreenAt?: string;
  screenCount: number;
}

export interface ScreenSummary {
  screenId: string;
  deviceId: string;
  receivedAt: string;
  capturedAt: string;
  pkg: string;
  appHash?: string;
  fingerprint: string;
  fpVersion: string;
  nodeCount: number;
  maskedCount: number;
  pinned: boolean;
  /** guide 요청으로 저장된 화면이면 그 응답 type (목록에서 구분용) */
  guideType?: string;
  /** 화면 매칭 결과: 이미 본 어느 페이지인지 (src/cache/match.ts) */
  match?: MatchResult;
  /**
   * 화면이 아닌 기록: classify·앱 선택 (src/debug/command-trace.ts).
   * 화면과 같은 시간 순 목록에 끼워 넣어 실시간 폴링으로 같이 따라온다.
   * 이때 화면 필드(pkg·fingerprint·노드 수)는 빈 값이다
   */
  entry?: "command";
  command?: CommandBrief;
}

/** 목록에 보이는 명령 요약 (원본은 CommandEntryDocument.detail) */
export interface CommandBrief {
  kind: "classify" | "choose";
  commandId: number;
  /** 가린 말 (앞 60자) */
  utterance?: string;
  level?: string;
  category?: string;
  degraded?: boolean;
  /** jev 결과: route / ask_intent / fail / off */
  route?: string;
  routeReason?: string;
  /** 후보 앱 이름 (순서대로) */
  candidates?: string[];
  /** 고른 앱 (앱 선택) */
  appId?: string;
  appName?: string;
  goal?: string;
}

/** 명령 기록 원본 (S3) */
export interface CommandEntryDocument extends ScreenSummary {
  entry: "command";
  command: CommandBrief;
  detail: unknown;
}

/** 페이지: 같은 화면으로 판정된 화면들의 묶음 (앱별) */
export interface PageRecord {
  pkg: string;
  pageId: string;
  tokens: string[];
  lastTokens: string[];
  fingerprints: string[];
  screenCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  sampleDeviceId: string;
  sampleScreenId: string;
}

/** S3 에 저장하는 화면 원본 (마스킹 후). S5 이후 guide 응답이 붙는다. */
export interface ScreenDocument extends ScreenSummary {
  screen: Screen;
  guide?: unknown;
}

export interface PinRecord {
  pinId: string;
  deviceId: string;
  from: string;
  to: string;
  name: string;
  createdBy: string;
  createdAt: string;
  screenCount: number;
}

export interface ScreenPage {
  items: ScreenSummary[];
  nextCursor?: string;
}

export interface DebugStore {
  heartbeat(input: HeartbeatInput & { uid: string; now: Date }): Promise<void>;
  /** 같은 기기의 직전 화면과 dedupeKey 가 같으면 저장하지 않고 false. */
  saveScreen(doc: ScreenDocument & { uid: string; dedupeKey: string }): Promise<boolean>;
  /** 명령 기록을 기기 시간 순 목록에 넣는다 (화면 수·중복 확인에는 안 셈) */
  saveEntry(doc: CommandEntryDocument & { uid: string }): Promise<void>;
  listDevices(): Promise<DeviceRecord[]>;
  /** 기기가 없으면 false */
  setLabel(deviceId: string, label: string): Promise<boolean>;
  listScreens(
    deviceId: string,
    options: {
      since?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      cursor?: string | undefined;
      limit: number;
    },
  ): Promise<ScreenPage>;
  getScreen(
    deviceId: string,
    screenId: string,
  ): Promise<ScreenDocument | CommandEntryDocument | undefined>;
  createPin(pin: Omit<PinRecord, "screenCount">): Promise<PinRecord>;
  listPins(): Promise<PinRecord[]>;
  /** 앱 하나의 페이지 전부 */
  listPages(pkg: string): Promise<PageRecord[]>;
  createPage(page: PageRecord): Promise<void>;
  /** 페이지로 판정된 화면 하나를 더한다: 지문 추가, 최근 토큰·시각 갱신, 횟수 +1 */
  touchPage(
    pkg: string,
    pageId: string,
    update: { fingerprint: string; tokens: string[]; at: string },
  ): Promise<void>;
  /** 이미 저장된 화면의 매칭 결과만 바꾼다 (다시 매칭할 때) */
  setScreenMatch(deviceId: string, screenId: string, match: MatchResult): Promise<void>;
}

/** 원본 문서에서 요약 필드만 꺼낸다 (테이블 항목·목록 응답용). */
export function summaryOf(doc: ScreenSummary): ScreenSummary {
  return {
    screenId: doc.screenId,
    deviceId: doc.deviceId,
    receivedAt: doc.receivedAt,
    capturedAt: doc.capturedAt,
    pkg: doc.pkg,
    ...(doc.appHash === undefined ? {} : { appHash: doc.appHash }),
    fingerprint: doc.fingerprint,
    fpVersion: doc.fpVersion,
    nodeCount: doc.nodeCount,
    maskedCount: doc.maskedCount,
    pinned: doc.pinned,
    ...(doc.guideType === undefined ? {} : { guideType: doc.guideType }),
    ...(doc.match === undefined ? {} : { match: doc.match }),
    ...(doc.entry === undefined ? {} : { entry: doc.entry }),
    ...(doc.command === undefined ? {} : { command: doc.command }),
  };
}

/** 문자열 정렬 = 시간순이 되도록: `20261126T070104123Z-1a2b3c` */
export function newScreenId(now: Date, random: string): string {
  return `${now.toISOString().replace(/[-:.]/g, "")}-${random}`;
}

export const epochSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);
