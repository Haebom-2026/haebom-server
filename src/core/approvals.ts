/**
 * S3 승인 모델 (docs/server-plan.md 3.2·6장, 지침서 5.5·8장).
 * 보호자 승인은 거래 승인이 아니라 "도우미가 계속 도와도 되는지"만 묻는다.
 *
 * 원본 1개 + 보호자별 항목. 상태가 바뀌면 둘을 한 트랜잭션으로 갱신한다.
 * 같은 어르신·같은 action 의 pending 은 하나만 (잠금 항목).
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { compactTime, type Category, CATEGORIES } from "./notifications.js";

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export type FinalStatus = Exclude<ApprovalStatus, "pending">;

/** 응답 시간 5분 (지침서 5.5) */
export const APPROVAL_TTL_MS = 5 * 60_000;
/** 기록 보관 */
export const APPROVAL_RETENTION_SECONDS = 90 * 24 * 3600;

/** 지침서 5.5 의 6종 + 고령자 앱이 쓰는 guide_unknown_app. 앞으로 늘 수 있어 guide_* 형식이면 받는다. */
export const KNOWN_ACTIONS = [
  "guide_gov24_auth",
  "guide_bank_open",
  "guide_money_move",
  "guide_identity",
  "guide_install",
  "guide_privacy_send",
  "guide_unknown_app",
] as const;

export interface ApprovalRecord {
  id: string;
  elderId: string;
  elderName: string;
  guardianIds: string[];
  packageName: string;
  appName: string;
  action: string;
  category?: Category;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  respondedAt?: string;
  respondedBy?: string;
  /** 응답한 보호자를 어르신이 부르는 호칭 (고령자 앱 안내 "큰딸 님이 허락했어요") */
  respondedByLabel?: string;
}

/** 보호자별 항목 = 원본 요약 + 그 보호자 기준 호칭 */
export interface GuardianApproval extends Omit<ApprovalRecord, "guardianIds"> {
  guardianId: string;
  elderLabel: string;
}

export function newApprovalId(now: Date): string {
  return `a${compactTime(now)}-${randomBytes(3).toString("hex")}`;
}

export const approvalIdSchema = z
  .string()
  .regex(/^a\d{8}T\d{9}Z-[0-9a-f]{6}$/, "invalid approval id");

export const createApprovalSchema = z.object({
  packageName: z.string().trim().min(1).max(200),
  appName: z.string().trim().min(1).max(100),
  action: z.string().regex(/^guide_[a-z0-9_]{1,40}$/, "action must look like guide_*"),
  category: z.enum(CATEGORIES).optional(),
});

export const respondSchema = z.object({ decision: z.enum(["approved", "rejected"]) });

export const guardianListQuerySchema = z.object({
  status: z.enum(["pending", "all"]).default("all"),
  cursor: z.string().max(200).optional(),
  since: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** pending 이지만 시간이 지났으면 expired 로 본다 (expire-fn 이 늦어도 정확하게) */
export function effectiveStatus(
  a: Pick<ApprovalRecord, "status" | "expiresAt">,
  nowIso: string,
): ApprovalStatus {
  return a.status === "pending" && a.expiresAt <= nowIso ? "expired" : a.status;
}

const responded = (
  a: Pick<ApprovalRecord, "respondedAt" | "respondedBy" | "respondedByLabel">,
) => ({
  ...(a.respondedAt === undefined ? {} : { respondedAt: a.respondedAt }),
  ...(a.respondedBy === undefined ? {} : { respondedBy: a.respondedBy }),
  ...(a.respondedByLabel === undefined ? {} : { respondedByLabel: a.respondedByLabel }),
});

/** 고령자 앱이 받는 모양 (#9·#10·#19) */
export function elderApprovalView(a: ApprovalRecord, nowIso: string) {
  return {
    id: a.id,
    status: effectiveStatus(a, nowIso),
    action: a.action,
    packageName: a.packageName,
    appName: a.appName,
    ...(a.category === undefined ? {} : { category: a.category }),
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    ...responded(a),
  };
}

/** 보호자 앱이 받는 모양 (#13·#23·#24) */
export function guardianApprovalView(a: GuardianApproval, nowIso: string) {
  return {
    id: a.id,
    elderId: a.elderId,
    elderName: a.elderName,
    elderLabel: a.elderLabel,
    status: effectiveStatus(a, nowIso),
    action: a.action,
    packageName: a.packageName,
    appName: a.appName,
    ...(a.category === undefined ? {} : { category: a.category }),
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    updatedAt: a.updatedAt,
    ...responded(a),
  };
}

export interface TransitionFields {
  updatedAt: string;
  respondedAt?: string;
  respondedBy?: string;
  respondedByLabel?: string;
}

/**
 * 상태 전이 조건.
 *  active  : pending 이고 아직 만료 전 (응답·취소)
 *  expired : pending 이고 이미 만료 (expire-fn, 읽을 때 만료)
 *  pending : pending 이기만 하면 (보호자가 모두 해제돼 취소)
 */
export type TransitionGuard = "active" | "expired" | "pending";

export interface GuardianApprovalPage {
  items: GuardianApproval[];
  nextCursor?: string;
}

/** 승인 저장소. 구현: approval-store.ts (DynamoDB), test/core-memory-store.ts */
export interface ApprovalStore {
  /** 같은 action 의 유효한 잠금이 있으면 아무것도 쓰지 않고 "locked" */
  create(
    record: ApprovalRecord,
    items: readonly GuardianApproval[],
    now: string,
  ): Promise<"created" | "locked">;
  get(id: string): Promise<ApprovalRecord | undefined>;
  /** 이 어르신·action 의 잠금이 가리키는 승인 id */
  lockedApprovalId(elderId: string, action: string): Promise<string | undefined>;
  /** pending → to. 조건이 맞지 않으면 false. 원본·보호자 항목·잠금을 한 번에 갱신 */
  transition(
    record: ApprovalRecord,
    to: FinalStatus,
    fields: TransitionFields,
    guard: TransitionGuard,
    now: string,
  ): Promise<boolean>;
  getForGuardian(guardianId: string, id: string): Promise<GuardianApproval | undefined>;
  listForGuardian(
    guardianId: string,
    options: {
      pendingOnly: boolean;
      now: string;
      cursor?: string | undefined;
      since?: string | undefined;
      limit: number;
    },
  ): Promise<GuardianApprovalPage>;
  /** 만료 시각이 지난 pending 승인 id (expire-fn) */
  listExpiredPending(now: string, limit: number): Promise<string[]>;
  /** 이 어르신의 pending 승인 (연결 해제 처리) */
  listPendingForElder(elderId: string): Promise<ApprovalRecord[]>;
  /** pending 승인에서 보호자 한 명을 빼고 그 보호자 항목을 지운다. 남은 보호자 목록을 돌려준다. */
  removeGuardian(record: ApprovalRecord, guardianId: string): Promise<string[] | undefined>;
  /** 연결 해제 시: 그 보호자의 그 어르신 승인 항목을 모두 지운다 */
  deleteForGuardianAndElder(guardianId: string, elderId: string): Promise<number>;
}
