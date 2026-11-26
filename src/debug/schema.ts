/**
 * 디버그 뷰어 요청 스키마 (docs/server-plan.md 12.4).
 *
 * 노드 필드는 앱 실제 샘플을 받기 전까지 **임시**다 (14장 #14).
 * 아는 필드(i, t, d, c, b)만 검증하고 나머지는 그대로 받아 뷰어에 보여 준다 (looseObject).
 *   i: 노드 번호 (#16 target 과 같은 값)
 *   t: 글자, d: 설명(contentDescription), c: 클래스 이름
 *   b: [left, top, right, bottom] 화면 픽셀 좌표
 */
import { z } from "zod";

const int = z.number().int();

export const deviceIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, "deviceId must be 8-64 chars of [A-Za-z0-9_-]");

/** `20261126T070104123Z-1a2b3c` (받은 시각 + 난수) — 문자열 정렬 = 시간순. */
export const screenIdSchema = z.string().regex(/^\d{8}T\d{9}Z-[0-9a-f]{6}$/, "invalid screenId");

export const nodeSchema = z.looseObject({
  i: int.nonnegative(),
  t: z.string().max(100).optional(),
  d: z.string().max(100).optional(),
  c: z.string().max(100).optional(),
  b: z.tuple([int, int, int, int]).optional(),
});

export const screenSchema = z.object({
  pkg: z.string().min(1).max(200),
  /** 앱이 계산한 화면 지문 (지침서 3.3). 없으면 서버 지문으로 중복을 판단한다. */
  hash: z.string().max(128).optional(),
  width: int.positive().max(10000),
  height: int.positive().max(10000),
  nodes: z
    .array(nodeSchema)
    .max(60)
    // 비밀 칸(앱이 secret:true 로 표시: 비밀번호·인증번호·계좌번호 등)은 글자가 따라와도 버린다.
    // 받은 직후 지우므로 AI·디버그 기록·로그 어디에도 남지 않는다
    .transform((nodes) =>
      nodes.map((node) => {
        if (node.secret !== true) return node;
        const cleaned = { ...node };
        delete cleaned.t;
        delete cleaned.d;
        return cleaned;
      }),
    ),
});

export const heartbeatSchema = z.object({
  deviceId: deviceIdSchema,
  model: z.string().max(100).default(""),
  os: z.string().max(50).default(""),
  appVersion: z.string().max(50).default(""),
});

export const screenPostSchema = z.object({
  deviceId: deviceIdSchema,
  capturedAt: z.iso.datetime({ offset: true }),
  screen: screenSchema,
});

export const labelSchema = z.object({ label: z.string().trim().min(1).max(40) });

export const pinSchema = z
  .object({ from: screenIdSchema, to: screenIdSchema, name: z.string().trim().min(1).max(60) })
  .refine((pin) => pin.from <= pin.to, { error: "from must not be after to" });

/**
 * 화면 목록 조회 방식 (셋 중 하나):
 *   since      : 그 이후 새 화면만, 오래된 것부터 (뷰어 실시간 폴링)
 *   from + to  : 구간 안 화면, 오래된 것부터 (보관 세션 보기)
 *   (없음)     : 최신순 페이지, cursor 로 다음 페이지
 */
export const screensQuerySchema = z
  .object({
    since: screenIdSchema.optional(),
    from: screenIdSchema.optional(),
    to: screenIdSchema.optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
  })
  .refine((q) => (q.from === undefined) === (q.to === undefined), {
    error: "from and to must be given together",
  })
  .refine((q) => !(q.since !== undefined && q.from !== undefined), {
    error: "since cannot be combined with from/to",
  });

export type Screen = z.output<typeof screenSchema>;
export type HeartbeatInput = z.output<typeof heartbeatSchema>;
