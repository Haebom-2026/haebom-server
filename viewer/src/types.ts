import type { RouteSelection, RouteTrace } from "./route-types.ts";

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
  /** 화면이 아닌 명령 기록 (classify·앱 선택). 이때 화면 필드는 빈 값 */
  entry?: "command";
  command?: CommandBrief;
}

/** 목록에 보이는 명령 요약 (src/debug/store.ts CommandBrief) */
export interface CommandBrief {
  kind: "classify" | "choose";
  commandId: number;
  utterance?: string;
  level?: string;
  category?: string;
  degraded?: boolean;
  /** route / ask_intent / fail / off */
  route?: string;
  routeReason?: string;
  candidates?: string[];
  appId?: string;
  appName?: string;
  goal?: string;
}

export interface MapNames {
  version: string;
  apps: Record<string, string>;
  roles: Record<string, string>;
  goals: Record<string, string>;
}

/** classify 기록 원본 (src/debug/command-trace.ts) */
export interface ClassifyEntryDetail {
  kind: "classify";
  request: { utterance: string; ruleLevel: string; ruleApp: string; signals: string[] };
  safety: {
    status: string;
    promptVersion: string;
    output?: {
      intent: string;
      app: string | null;
      level: string;
      category: string;
      reason: string;
    };
    inputTokens?: number;
    outputTokens?: number;
  };
  selection?: RouteSelection;
  trace?: RouteTrace;
  response: {
    commandId: number;
    intent: string;
    app: string | null;
    sensitivity: { level: string; category: string; reason: string; signals: string[] };
    degraded?: boolean;
    route?: { candidates: { appId: string; name: string; packages: string[] }[] };
    clarify?: { say: string };
  };
  saved: string;
  ms: number;
  names?: MapNames;
}

/** 앱 선택 기록 원본 */
export interface ChooseEntryDetail {
  kind: "choose";
  body: {
    appId?: string;
    installState?: string;
    askedUser?: boolean;
    answer?: { questionId: string; option: string };
  };
  response: {
    commandId: number;
    appId?: string;
    goal?: { id: string; name: string };
    sensitivity: { level: string };
    route?: { candidates: { appId: string; name: string }[] };
  };
  names?: MapNames;
}

export interface CommandEntryDocument extends ScreenSummary {
  entry: "command";
  command: CommandBrief;
  detail: ClassifyEntryDetail | ChooseEntryDetail;
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
