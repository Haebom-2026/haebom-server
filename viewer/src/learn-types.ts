/**
 * R3~R5 기록 (서버 src/debug/insight.ts): 배운 지도와 명령 하나의 단계·검토·반영.
 * 서버는 DynamoDB 항목을 거의 그대로 보내므로 모든 칸을 있을 수도 없을 수도 있게 둔다.
 */
import type { MapNames } from "./types.ts";

export interface LearnedBase {
  SK: string;
  status?: "candidate" | "verified" | "retired";
  origin?: "seed" | "learned";
  /** "uid#commandId#gen@기기" */
  evidence?: string[];
  /** 내려간 뒤의 옛 증거 */
  oldEvidence?: string[];
  /** 서버가 센 증거의 서로 다른 기기 (seed 제외) */
  devices?: string[];
  createdAt?: string;
  updatedAt?: string;
  lastUsedAt?: string;
  /** 최근 결과 1 성공 / 0 실패 (최대 20) */
  recent?: number[];
  demotedAt?: string;
}

export interface LearnedEdge extends LearnedBase {
  edgeId: string;
  pkg: string;
  fromFp: string;
  toFp: string;
  action: string;
  targetText: string;
  targetClass?: string;
  /** 90일 안 쓰여 안내에 안 씀 */
  stale?: boolean;
}

export interface FinishStepView {
  action: string;
  targetText: string;
  targetClass?: string;
  verify: string;
  sensitive: boolean;
  afterFp?: string;
}

export interface LearnedGoal extends LearnedBase {
  goalId: string;
  pkg?: string;
  arriveFps?: string[];
  finish?: FinishStepView[];
  /** 목표를 내리고 도착 화면을 정리하는 중 */
  cleanupArrivals?: string;
}

export interface LearnedArrive extends LearnedBase {
  goalId?: string;
  fp?: string;
}

export interface PendingView {
  SK: string;
  uid: string;
  commandId: number;
  gen: string;
  reasons: string[];
  goalId?: string;
  proposal?: { name: string; desc: string; slots?: string[] };
  createdAt?: string;
}

export interface AppliedView {
  SK: string;
  uid: string;
  commandId: number;
  gen: string;
  entry: string;
  edgeIds: string[];
  goalId: string;
  arriveFp: string;
}

export interface LearnedMapView {
  edges: LearnedEdge[];
  goals: LearnedGoal[];
  arrives: LearnedArrive[];
  pending: PendingView[];
  applied: AppliedView[];
  block: { edgeIds: string[]; goalIds: string[] };
  names?: MapNames;
  serverTime: string;
}

export interface MapProgressView {
  mode: "map" | "ai";
  stepId?: string;
  fp?: string;
  kind?: "edge" | "finish";
  ref?: string;
  resends?: number;
  reason?: string;
}

export interface CommandRecordView {
  commandId: number;
  gen: string;
  createdAt?: string;
  level?: string;
  category?: string;
  degraded?: boolean;
  chosenApp?: string;
  chosenGoal?: string;
  endResult?: string;
  endedAt?: string;
  finalScreen?: { deviceId: string; screenId: string };
  finalAction?: { seq: number; action: string; text: string };
  mapProgress?: MapProgressView;
}

export interface StepView {
  SK: string;
  stepId: string;
  receivedAt: string;
  screen: { deviceId: string; screenId: string };
  page?: { kind: string; pageId?: string };
  pkg: string;
  guide: { type: string; targetText?: string; dir?: string; status?: string; source: "ai" | "map" };
  lastAction?: { stepId?: string; seq: number; action: string; text: string };
}

export interface ReviewOpus {
  success: "yes" | "no" | "unsure";
  evidence: string;
  goal: {
    kind: string;
    id: string | null;
    proposal: { name: string; desc: string; slots: string[] } | null;
  };
  moves: { seq: number; action: string; text: string }[];
  finish: { seq: number; action: string; text: string; verify: string }[];
  sensitiveSeqs: number[];
  personalText: boolean;
}

export interface ReviewView {
  version: string;
  model: string;
  reviewedAt: string;
  commandId: number;
  gen: string;
  outcome: "accept" | "human" | "reject" | "error";
  reasons: string[];
  /** 끝난 뒤 명령이 바뀌어 판정을 낮춘 이유 */
  invalidated?: string;
  appId?: string;
  goal?: { kind: string; id?: string; proposal?: { name: string; desc: string } };
  edges: { from: string; to: string; action: string; text: string; pkg: string }[];
  opus?: ReviewOpus;
  stats: {
    screens: number;
    actions: number;
    inputTokens?: number;
    outputTokens?: number;
    ms: number;
  };
}

export interface CommandInsightView {
  uid: string;
  commandId: number;
  command?: CommandRecordView;
  steps: StepView[];
  reviews: { SK: string; review: ReviewView }[];
  applied: AppliedView[];
  pending: PendingView[];
  names?: MapNames;
}
