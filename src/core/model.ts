/**
 * S1 사용자·기기·연결 모델 (docs/server-plan.md 3.2, 4.2).
 * 호칭은 두 앱 합의대로 elderLabel·guardianLabel 두 필드 (relationship 은 쓰지 않음).
 */
import { z } from "zod";

export type Role = "elder" | "guardian";

export interface UserProfile {
  uid: string;
  role: Role;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export type Platform = "android" | "ios" | "web";

export interface DeviceRecord {
  uid: string;
  deviceId: string;
  fcmToken: string;
  platform: Platform;
  updatedAt: string;
}

export interface LinkRecord {
  elderId: string;
  guardianId: string;
  elderName: string;
  guardianName: string;
  /** 보호자 앱에서 어르신을 부르는 호칭 (예: 어머니) */
  elderLabel: string;
  /** 고령자 앱에서 보호자를 부르는 호칭 (예: 큰딸) */
  guardianLabel: string;
  connectedAt: string;
}

export interface ConnectCode {
  code: string;
  elderId: string;
  createdAt: string;
  expiresAt: string;
  used: boolean;
}

/** 연결 코드: 6자리, 10분, 일회용 */
export const CODE_TTL_MS = 10 * 60_000;
/** 보호자 한 명이 10분 안에 틀릴 수 있는 횟수 */
export const GUARDIAN_CODE_FAILURES = 5;
export const GUARDIAN_FAILURE_WINDOW_MS = 10 * 60_000;
/** 익명 계정을 바꿔 가며 시도하는 경우를 막는 서버 전체 한도 (1분) */
export const GLOBAL_CODE_FAILURES = 60;
export const GLOBAL_FAILURE_WINDOW_MS = 60_000;

const name = z.string().trim().max(40);
const label = z.string().trim().max(20);

export const deviceIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, "deviceId must be 8-64 chars of [A-Za-z0-9_-]");

export const createUserSchema = z.object({
  role: z.enum(["elder", "guardian"]),
  name: name.default(""),
});

export const updateUserSchema = z.object({ name });

export const putDeviceSchema = z.object({
  fcmToken: z.string().min(1).max(4096),
  platform: z.enum(["android", "ios", "web"]),
});

export const linkByCodeSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "code must be 6 digits"),
  elderLabel: label.default(""),
  guardianLabel: label.default(""),
});

/** 고령자 앱이 받는 모양 (#18) */
export function elderView(link: LinkRecord) {
  return {
    guardianId: link.guardianId,
    guardianName: link.guardianName,
    guardianLabel: link.guardianLabel,
    elderLabel: link.elderLabel,
    connectedAt: link.connectedAt,
  };
}

/** 보호자 앱이 받는 모양 (#14, #20) */
export function guardianView(link: LinkRecord) {
  return {
    elderId: link.elderId,
    elderName: link.elderName,
    elderLabel: link.elderLabel,
    guardianLabel: link.guardianLabel,
    connectedAt: link.connectedAt,
  };
}

export function profileView(user: UserProfile) {
  return { uid: user.uid, role: user.role, name: user.name, createdAt: user.createdAt };
}
