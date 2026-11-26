/** /v1/dev/* 응답 모양 (src/debug/store.ts 와 맞춘다). */

export interface Device {
  deviceId: string;
  uid: string;
  model: string;
  os: string;
  appVersion: string;
  label?: string;
  lastSeenAt: string;
  lastScreenAt?: string;
  screenCount: number;
  online: boolean;
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

/** 노드 필드는 임시 (i, t, d, c, b 외에 앱이 보내는 것은 그대로 보여 준다). */
export interface ScreenNode {
  i: number;
  t?: string;
  d?: string;
  c?: string;
  b?: [number, number, number, number];
  [extra: string]: unknown;
}

export interface ScreenDocument extends ScreenSummary {
  screen: { pkg: string; hash?: string; width: number; height: number; nodes: ScreenNode[] };
  guide?: {
    type?: string;
    say?: string;
    target?: number;
    latencyMs?: number;
    [k: string]: unknown;
  };
}

export interface ScreenPage {
  items: ScreenSummary[];
  nextCursor?: string;
}

export interface Pin {
  pinId: string;
  deviceId: string;
  from: string;
  to: string;
  name: string;
  createdBy: string;
  createdAt: string;
  screenCount: number;
}
