/**
 * #16 POST /v1/elder/guide 요청·응답 (지침서 5.7, docs/server-plan.md 5.3).
 * 화면(screen)은 디버그 뷰어와 같은 모양을 쓴다 → 앱은 같은 화면 객체를 두 곳에 보낼 수 있다.
 */
import { z } from "zod";
import { deviceIdSchema, screenSchema } from "../debug/schema.js";

export const GUIDE_TYPES = ["highlight", "suggest", "swipe", "ask", "say", "done"] as const;
export const SWIPE_DIRS = ["up", "down", "left", "right"] as const;

/** 앱이 보고하는 실제 행동 종류 */
export const LAST_ACTIONS = [
  "tap",
  "type",
  "swipe_up",
  "swipe_down",
  "swipe_left",
  "swipe_right",
  "back",
  "home",
  "other",
] as const;

export const guideRequestSchema = z.object({
  /** 앱이 붙이는 요청 번호. 그대로 돌려준다 (늦은 응답 버리기, 지침서 3.2). */
  requestId: z.number().int().nonnegative(),
  /** IntentParser 의 목표 종류 (ADD_CONTACT, YOUTUBE, GOV24, BANK, OPEN_APP, UNKNOWN ...) */
  goal: z.string().trim().min(1).max(40),
  utterance: z.string().max(200).default(""),
  slots: z.record(z.string().max(40), z.string().max(100)).default({}),
  /** 지금까지 안내한 단계 (오래된 것부터, 최대 10개) */
  history: z.array(z.string().max(200)).max(10).default([]),
  /** 바로 앞 질문(ask)에 어르신이 고른 답. "모르겠어요", "가족 답: …", "가족도 모름" 포함 */
  userReply: z.string().max(100).default(""),
  /** guide: 말로 이끌어 드림(기본), solo: 혼자 하다가 막힐 때 보는 힌트 */
  mode: z.enum(["guide", "solo"]).default("guide"),
  screen: screenSchema,
  /** (dev 디버그용, 선택) 디버그 뷰어 기기 ID. 이 기기 아래에 요청·판단이 기록된다. 서버 동작에는 영향 없음 */
  deviceId: deviceIdSchema.optional(),
  /** (선택) classify 의 명령 번호. 명령 단계 기록·지도 학습에 쓴다 (docs/jev-routing-plan.md 3.6·6장) */
  commandId: z.number().int().nonnegative().optional(),
  /** (선택) 바로 앞 화면에서 어르신이 실제로 한 행동 (접근성 이벤트). 연결선을 실제 행동으로 만든다 */
  lastAction: z
    .object({
      /** 그 화면에서 받은 안내의 stepId (안내를 따랐는지 확인). 안내 없이 한 행동이면 없음 */
      stepId: z.string().max(40).optional(),
      /** 명령 안의 행동 순번 (0부터). 빠진 번호가 있으면 그 구간은 학습하지 않는다 */
      seq: z.number().int().nonnegative(),
      action: z.enum(LAST_ACTIONS),
      /** 누른 노드의 글자(t, 없으면 d). 서버가 가린 뒤 저장 */
      text: z.string().max(100).default(""),
    })
    .optional(),
});

export type GuideRequest = z.output<typeof guideRequestSchema>;

export const GUIDE_STATUSES = ["in_progress", "clarify", "off_track", "stopped", "done"] as const;
export const GUIDE_ACTIONS = [
  "tap",
  "type",
  "swipe_up",
  "swipe_down",
  "swipe_left",
  "swipe_right",
  "home",
  "back",
  "none",
] as const;
export const GUIDE_FACTS = ["none", "site_membership", "login_method", "has_certificate"] as const;
export const NAV_ACTIONS = ["home", "back"] as const;

/**
 * 모델이 내는 출력 (guide@v4). 이름은 앱 시제품 프롬프트 그대로 두고, 앱 응답은 finalize 가 바꾼다.
 * plan·step 을 먼저 쓰게 해 thinking 없이도 계획 → 지금 위치 → 행동 순서로 판단하게 한다.
 * 구조화 출력은 선택 필드보다 nullable 이 안정적이라 모두 필수 + null 허용.
 * 길이 제한은 스키마 대신 후처리에서 자른다 (구조화 출력이 지원하지 않는 제약이 있어서).
 */
export const guideModelOutputSchema = z.object({
  plan: z.array(z.string()),
  step: z.string(),
  status: z.enum(GUIDE_STATUSES),
  action: z.enum(GUIDE_ACTIONS),
  target_id: z.number().int().nullable(),
  speech: z.string(),
  /** action: type 일 때 칸에 넣을 글자. 어르신만 아는 값·비밀 칸이면 "". type 이 아니면 null */
  type_text: z.string().nullable(),
  /** 밀기일 때 밀어서 찾으려는 요소의 글자 (예: "디스플레이"). 모르면 null */
  seek: z.string().nullable(),
  /** clarify 일 때 답 버튼 글자. 아니면 [] */
  options: z.array(z.string()),
  fact: z.enum(GUIDE_FACTS),
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
  /** highlight·suggest: 가리킨 요소의 글자(t, 없으면 d). 스크롤로 번호가 바뀌어도 다시 찾기 위함. */
  targetText?: string;
  /** swipe: 밀어서 찾으려는 요소의 글자. 화면에 나타나면 앱이 바로 누르기 안내로 바꿀 수 있다. */
  seekText?: string;
  /** (v4) 안내 상태. 서버가 대신 답한 문장이면 없음 */
  status?: (typeof GUIDE_STATUSES)[number];
  /** (v4) suggest: 칸에 넣을 글자. 앱이 칸 아래 "넣기" 버튼으로 띄운다. 어르신이 직접 쓸 칸이면 없음 */
  typeText?: string;
  /** (v4) ask: 답 버튼 글자 (최대 4개). 앱이 "모르겠어요"를 덧붙인다 */
  options?: string[];
  /** (v4) ask: 가족에게 물어볼 수 있는 질문의 종류 */
  fact?: Exclude<(typeof GUIDE_FACTS)[number], "none">;
  /** (v4) say: 홈 버튼·뒤로 버튼을 누르게 하는 안내 */
  nav?: (typeof NAV_ACTIONS)[number];
  /** 이 안내의 id. 어르신이 따르면 앱이 다음 요청의 lastAction.stepId 로 돌려준다 */
  stepId?: string;
}
