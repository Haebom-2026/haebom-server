import type { HeartbeatInput, Screen } from "./schema.js";

/** 보관 기간 (docs/server-plan.md 12.5) */
export const SCREEN_TTL_SECONDS = 3 * 24 * 3600;
export const PINNED_TTL_SECONDS = 30 * 24 * 3600;
export const DEVICE_TTL_SECONDS = 30 * 24 * 3600;
/** heartbeat 5초 × 3 */
export const ONLINE_WINDOW_MS = 15_000;
export const MAX_PIN_SCREENS = 500;

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
  getScreen(deviceId: string, screenId: string): Promise<ScreenDocument | undefined>;
  createPin(pin: Omit<PinRecord, "screenCount">): Promise<PinRecord>;
  listPins(): Promise<PinRecord[]>;
}

/** 원본 문서에서 요약 필드만 꺼낸다 (테이블 항목·목록 응답용). */
export function summaryOf(doc: ScreenDocument): ScreenSummary {
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
  };
}

/** 문자열 정렬 = 시간순이 되도록: `20261126T070104123Z-1a2b3c` */
export function newScreenId(now: Date, random: string): string {
  return `${now.toISOString().replace(/[-:.]/g, "")}-${random}`;
}

export const epochSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);
