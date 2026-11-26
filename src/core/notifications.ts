/**
 * S2 알림 모델 (docs/server-plan.md 3.2, 4.2 #6~#8·#21·#22, 지침서 5.4·5.6).
 * 원본 1개(ELDER#) + 보호자별 알림함 복사(GUARDIAN#). 보호자별 읽음 시각은 알림함에 둔다.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";

export type NotificationType = "sensitive_entry" | "stuck" | "sos";
export const LEVELS = ["L0", "L1", "L2", "L3"] as const;
export const CATEGORIES = [
  "finance",
  "identity",
  "public",
  "device",
  "privacy",
  "scam",
  "none",
] as const;
export type Level = (typeof LEVELS)[number];
export type Category = (typeof CATEGORIES)[number];

/** 같은 어르신·같은 앱의 민감 알림은 10분에 한 번 (지침서 4.1) */
export const SENSITIVE_DEDUP_MS = 10 * 60_000;
/** 알림 보관 기간 */
export const NOTIFICATION_TTL_SECONDS = 90 * 24 * 3600;

export interface NotificationRecord {
  id: string;
  elderId: string;
  type: NotificationType;
  packageName: string;
  appName: string;
  level?: Level;
  category?: Category;
  reason?: string;
  createdAt: string;
}

/** 보호자 알림함 항목 = 원본 + 그 보호자 기준 이름·호칭·읽음 */
export interface InboxItem extends NotificationRecord {
  guardianId: string;
  elderName: string;
  elderLabel: string;
  readAt?: string;
}

/** 문자열 정렬 = 시간순: `n20261126T070104123Z-1a2b3c` */
export function newNotificationId(now: Date): string {
  return `n${compactTime(now)}-${randomBytes(3).toString("hex")}`;
}

export function compactTime(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

export const notificationIdSchema = z
  .string()
  .regex(/^n\d{8}T\d{9}Z-[0-9a-f]{6}$/, "invalid notification id");

const appFields = {
  packageName: z.string().trim().max(200),
  appName: z.string().trim().max(100),
};
const reason = z.string().trim().max(100);

/** #6: 민감 앱 알림 */
export const sensitiveEntrySchema = z.object({
  packageName: appFields.packageName.min(1),
  appName: appFields.appName.min(1),
  level: z.enum(LEVELS).default("L1"),
  category: z.enum(CATEGORIES).default("none"),
  reason: reason.default(""),
});

/** #7: 막힘 (앱 밖이면 빈 문자열) */
export const stuckSchema = z.object({
  packageName: appFields.packageName.default(""),
  appName: appFields.appName.default(""),
});

/** #8: SOS (L3 사기 의심이면 category·reason 을 함께) */
export const sosSchema = z.object({
  packageName: appFields.packageName.default(""),
  appName: appFields.appName.default(""),
  category: z.enum(CATEGORIES).optional(),
  reason: reason.optional(),
});

/** 모두 읽음: 본문이 없거나 {} 이면 전체, elderId 가 있으면 그 어르신만 */
export const readAllSchema = z
  .object({
    elderId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .optional(),
  })
  .default({});

export const listQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  since: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** 보호자 앱이 받는 모양 (#21) */
export function inboxView(item: InboxItem) {
  return {
    id: item.id,
    elderId: item.elderId,
    elderName: item.elderName,
    elderLabel: item.elderLabel,
    type: item.type,
    packageName: item.packageName,
    appName: item.appName,
    ...(item.level === undefined ? {} : { level: item.level }),
    ...(item.category === undefined ? {} : { category: item.category }),
    ...(item.reason === undefined || item.reason === "" ? {} : { reason: item.reason }),
    createdAt: item.createdAt,
    readAt: item.readAt ?? null,
  };
}

/** 사기 의심이면 어떤 종류든 가장 급한 알림으로 (보호자 앱 요청 2.5) */
export const isUrgent = (n: Pick<NotificationRecord, "type" | "level" | "category">): boolean =>
  n.type !== "sensitive_entry" || n.category === "scam" || n.level === "L3";

export type CreateResult = "created" | "duplicate_suppressed";

export interface InboxPage {
  items: InboxItem[];
  nextCursor?: string;
}

/** 알림 저장소. 구현: notification-store.ts (DynamoDB), test/core-memory-store.ts */
export interface NotificationStore {
  /**
   * 원본 + 보호자별 알림함을 한 번에 쓴다.
   * dedupUntil 이 있으면 같은 어르신·같은 패키지의 표식이 아직 유효할 때 아무것도 쓰지 않고 duplicate_suppressed.
   */
  create(
    record: NotificationRecord,
    inbox: readonly InboxItem[],
    options: { dedupUntil?: string; now: string },
  ): Promise<CreateResult>;
  listInbox(
    guardianId: string,
    options: { cursor?: string | undefined; since?: string | undefined; limit: number },
  ): Promise<InboxPage>;
  /** 없으면 false */
  markRead(guardianId: string, id: string, readAt: string): Promise<boolean>;
  /** 보호자 알림함 한 건 (FCM 알림을 눌러 상세를 열 때) */
  getInbox(guardianId: string, id: string): Promise<InboxItem | undefined>;
  /** 안 읽은 알림을 모두 읽음으로. elderId 가 있으면 그 어르신 것만. 바꾼 개수를 돌려준다. */
  markAllRead(guardianId: string, readAt: string, elderId?: string): Promise<number>;
  /** 연결 해제 시: 그 보호자 알림함에서 그 어르신 알림을 지운다 (보호자 앱 요청) */
  deleteInboxForElder(guardianId: string, elderId: string): Promise<number>;
}
