/**
 * #16 POST /v1/elder/guide 요청·응답 (지침서 5.7, docs/server-plan.md 5.3).
 * 화면(screen)은 디버그 뷰어와 같은 모양을 쓴다 → 앱은 같은 화면 객체를 두 곳에 보낼 수 있다.
 */
import { z } from "zod";
import { screenSchema } from "../debug/schema.js";

export const GUIDE_TYPES = ["highlight", "suggest", "swipe", "ask", "say", "done"] as const;
export const SWIPE_DIRS = ["up", "down", "left", "right"] as const;

export const guideRequestSchema = z.object({
  /** 앱이 붙이는 요청 번호. 그대로 돌려준다 (늦은 응답 버리기, 지침서 3.2). */
  requestId: z.number().int().nonnegative(),
  /** IntentParser 의 목표 종류 (ADD_CONTACT, YOUTUBE, GOV24, BANK, OPEN_APP, UNKNOWN ...) */
  goal: z.string().trim().min(1).max(40),
  utterance: z.string().max(200).default(""),
  slots: z.record(z.string().max(40), z.string().max(100)).default({}),
  /** 지금까지 안내한 단계 (오래된 것부터, 최대 10개) */
  history: z.array(z.string().max(200)).max(10).default([]),
  screen: screenSchema,
});

export type GuideRequest = z.output<typeof guideRequestSchema>;

/**
 * 모델이 내는 출력. 구조화 출력은 선택 필드보다 nullable 이 안정적이라 모두 필수 + null 허용.
 * 길이 제한은 스키마 대신 후처리에서 자른다 (구조화 출력이 지원하지 않는 제약이 있어서).
 */
export const guideModelOutputSchema = z.object({
  type: z.enum(GUIDE_TYPES),
  say: z.string(),
  target: z.number().int().nullable(),
  chips: z.array(z.string()).nullable(),
  dir: z.enum(SWIPE_DIRS).nullable(),
});

export type GuideModelOutput = z.output<typeof guideModelOutputSchema>;

/** 앱에 돌려주는 응답. 쓰지 않는 필드는 빼고 보낸다. */
export interface GuideResponse {
  requestId: number;
  type: (typeof GUIDE_TYPES)[number];
  say: string;
  target?: number;
  chips?: string[];
  dir?: (typeof SWIPE_DIRS)[number];
}
