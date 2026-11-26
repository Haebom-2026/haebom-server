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
  /** guide 요청으로 저장된 화면이면 응답 type */
  guideType?: string;
  /** 화면 매칭: 이미 본 어느 페이지인지 (src/cache/match.ts) */
  match?: ScreenMatch;
}

export interface ScreenMatch {
  version: string;
  /** exact 같은 지문 · similar 비슷함 · ambiguous 판단 보류 · new 새 페이지 */
  kind: "exact" | "similar" | "ambiguous" | "new";
  pageId?: string;
  score: number;
  runnerUp?: { pageId: string; score: number };
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
  guide?: GuideRecord;
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

/** guide 요청 기록 (src/debug/guide-trace.ts) */
export interface GuideRecord {
  type?: string;
  say?: string;
  target?: number;
  latencyMs?: number;
  /** 앱이 보낸 목표·한 말·slots·history */
  request?: {
    requestId?: number;
    goal?: string;
    utterance?: string;
    slots?: Record<string, string>;
    history?: string[];
  };
  /** AI 호출 과정 */
  ai?: {
    model?: string;
    promptVersion?: string;
    skipped?: string;
    status?: string;
    stopReason?: string | null;
    latencyMs?: number;
    masked?: number;
    error?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    /** AI 에 보낸 그대로 */
    input?: unknown;
    /** 모델의 원래 출력 (후처리 전) */
    output?: Record<string, unknown>;
  };
  /** 앱에 보낸 최종 응답 */
  response?: Record<string, unknown>;
}
