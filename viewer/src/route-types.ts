/**
 * 고르기 회귀 측정 결과 파일 (서버 src/route/eval-report.ts·select.ts·trace.ts 와 같은 모양).
 * scripts/route-eval.ts --out 이 쓰고, "고르기" 탭이 연다.
 */

export type Level = "L0" | "L1" | "L2" | "L3";
export type CandidateBy = "named" | "jev" | "pref" | "default";

export interface RouteGoal {
  id: string;
  version: number;
  name: string;
  level: Level;
  slots: string[];
  confidence: number;
  verified: boolean;
}

export interface RouteClarify {
  questionId: string;
  say: string;
  options: { id: string; name: string }[];
}

export interface RouteCandidate {
  appId: string;
  name: string;
  packages: string[];
  by: CandidateBy;
  level: Level;
  goal?: RouteGoal;
  clarify?: RouteClarify;
}

interface Base {
  mapVersion: string;
  ms: number;
  cost: number;
}

export type RouteSelection =
  | (Base & {
      kind: "route";
      role: string;
      named: boolean;
      exclusive: boolean;
      mentionedApp?: string;
      ask: boolean;
      candidates: RouteCandidate[];
      confidence: { app: number; role: number };
    })
  | (Base & { kind: "ask_intent"; clarify: RouteClarify; confidence: { role: number } })
  | (Base & { kind: "fail"; reason: string; confidence?: { app: number; role: number } });

export type NameMention =
  | { kind: "map"; appId: string; text: string }
  | { kind: "other"; text: string }
  | { kind: "ambiguous" }
  | { kind: "none" };

export interface JevCallTrace {
  ok: boolean;
  reason?: string;
  ms: number;
  cost: number;
}

export interface RouteTrace {
  masked: string;
  thresholds: Record<string, number>;
  app?: JevCallTrace & {
    probs: [string, number][];
    roles: [string, number][];
    mention: NameMention;
    rule?: string;
  };
  goals: (JevCallTrace & { appId: string; probs: [string, number][]; judged?: string })[];
}

export type AppGrade = "hit" | "miss" | "false_positive" | "no_route" | "ask" | "none_ok";
export type GoalGrade = "right" | "wrong" | "ask" | "no_goal";

export interface EvalItem {
  utterance: string;
  source: "real" | "synthetic";
  expect: { apps: string[]; goals?: string[] };
  selection: RouteSelection;
  trace: RouteTrace;
  grade: { app: AppGrade; goal?: GoalGrade };
}

export interface EvalMapInfo {
  name: string;
  version: string;
  roles: { id: string; name: string; sensitive: boolean }[];
  apps: { id: string; name: string; roles: string[] }[];
  goals: { id: string; app: string; name: string; level: string; status: string }[];
}

export interface EvalRun {
  map: EvalMapInfo;
  items: EvalItem[];
}

export interface EvalReport {
  kind: "route-eval";
  version: 1;
  createdAt: string;
  jevModel: string;
  runs: EvalRun[];
}

/** 파일 내용이 결과 파일인지 가볍게 확인 */
export function parseReport(text: string): EvalReport {
  const data = JSON.parse(text) as Partial<EvalReport>;
  if (data.kind !== "route-eval" || !Array.isArray(data.runs)) {
    throw new Error("route-eval 결과 파일이 아니에요 (scripts/route-eval.ts --out 으로 만든 파일)");
  }
  if (data.version !== 1) throw new Error(`모르는 결과 파일 버전: ${String(data.version)}`);
  return data as EvalReport;
}
