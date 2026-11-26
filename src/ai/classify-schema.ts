/**
 * #17 POST /v1/elder/classify 요청·응답 (지침서 5.3, docs/server-plan.md 5.2, docs/jev-routing-plan.md 5.1).
 * 명령 한 번에 한 번. 화면 정보는 받지 않는다.
 */
import { z } from "zod";
import { CATEGORIES, LEVELS, type Category, type Level } from "../core/notifications.js";

/** 앱 IntentParser 의 목표 종류 (지침서 5.3) */
export const INTENTS = [
  "ADD_CONTACT",
  "YOUTUBE",
  "GOV24",
  "BANK",
  "OPEN_APP",
  "SOS",
  "UNKNOWN",
] as const;
export type Intent = (typeof INTENTS)[number];

/** 상황 신호 허용 목록 (지침서 4.4). 목록 밖 값은 버린다 */
export const SIGNALS = ["통화 중", "모르는 번호 연락", "늦은 밤", "처음 쓰는 금융 앱"] as const;
export type Signal = (typeof SIGNALS)[number];

export const classifyRequestSchema = z.object({
  /** 앱이 명령마다 올리는 번호. 같은 어르신 안에서 명령을 가리킨다 (늦은 응답 버리기·앱 선택 API) */
  commandId: z.number().int().nonnegative(),
  utterance: z.string().trim().min(1).max(200),
  /** 앱 안 규칙(SensitiveCommand) 결과. 서버는 이보다 낮게 답하지 않는다 */
  ruleLevel: z.enum(LEVELS).default("L0"),
  ruleApp: z.string().trim().max(40).default(""),
  signals: z
    .array(z.string().max(40))
    .max(10)
    .default([])
    .transform((list) => [
      ...new Set(list.filter((s): s is Signal => (SIGNALS as readonly string[]).includes(s))),
    ]),
  slots: z.record(z.string().max(40), z.string().max(100)).default({}),
});

export type ClassifyRequest = z.output<typeof classifyRequestSchema>;

/** 안전 분류 모델 출력 (classify@v1) */
export const classifyModelOutputSchema = z.object({
  intent: z.enum(INTENTS),
  /** 말에 나온 앱 이름 (없으면 null) */
  app: z.string().nullable(),
  level: z.enum(LEVELS),
  category: z.enum(CATEGORIES),
  /** 보호자 앱에 보일 짧은 이유 */
  reason: z.string(),
});

export type ClassifyModelOutput = z.output<typeof classifyModelOutputSchema>;

export interface Sensitivity {
  level: Level;
  category: Category;
  reason: string;
  signals: Signal[];
}

export interface ClassifyResponse {
  commandId: number;
  intent: Intent;
  app: string | null;
  sensitivity: Sensitivity;
  /** 안전 분류 모델이 실패해 규칙 결과로만 답함 (앱은 규칙 결과를 유지) */
  degraded?: true;
  /** jev 앱·목표 고르기 (docs/jev-routing-plan.md 4·5장). 사기 의심이면 싣지 않는다 */
  route?: RouteOut;
  /** 하려는 일을 물음 (route 대신) */
  clarify?: ClarifyOut;
}

export interface ClarifyOut {
  questionId: string;
  say: string;
  options: { id: string; name: string; level?: Level; verified?: boolean }[];
}

export interface RouteCandidateOut {
  appId: string;
  name: string;
  packages: string[];
  by: string;
  level: Level;
  goal?: {
    id: string;
    version: number;
    name: string;
    level: Level;
    slots: string[];
    /** 검증된 목표만 명령 단계를 올린다 (candidate 목표는 안 씀) */
    verified: boolean;
  };
  clarify?: ClarifyOut;
}

export interface RouteOut {
  mapVersion: string;
  role: string;
  named: boolean;
  exclusive: boolean;
  mentionedApp?: string;
  ask: boolean;
  candidates: RouteCandidateOut[];
}

/** POST /v1/elder/commands/{commandId}/app (docs/jev-routing-plan.md 5.2) */
export const chooseAppRequestSchema = z
  .object({
    /** 폰이 고른 후보. 하려는 일 질문에 답할 때는 없어도 된다 */
    appId: z.string().min(1).max(40).optional(),
    installState: z.enum(["installed", "unknown"]).default("installed"),
    /** 민감한 역할에서 어르신께 물어서 골랐는지 */
    askedUser: z.boolean().default(false),
    answer: z
      .object({ questionId: z.string().min(1).max(60), option: z.string().min(1).max(80) })
      .optional(),
  })
  .refine((v) => v.appId !== undefined || v.answer !== undefined, {
    error: "appId 또는 answer 가 필요합니다",
  });

export type ChooseAppRequest = z.output<typeof chooseAppRequestSchema>;
