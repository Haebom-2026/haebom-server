/** 앱은 `error.reason` 만 보고 분기한다 (docs/server-plan.md 4.1). */
export type ErrorReason =
  | "unauthenticated"
  | "profile-required"
  | "permission-denied"
  | "invalid-argument"
  | "not-found"
  | "conflict"
  | "rate-limited"
  | "unavailable"
  | "not-implemented"
  | "internal"
  // 연결 코드 (#14, 보호자 앱 요청 2.3)
  | "invalid-code"
  | "code-expired"
  | "code-used"
  | "already-linked"
  | "too-many-attempts"
  // 승인 응답 #13 (보호자 앱 요청 2.3)
  | "already-responded"
  | "approval-expired"
  | "approval-cancelled";

const STATUS_BY_REASON: Record<ErrorReason, number> = {
  unauthenticated: 401,
  "profile-required": 403,
  "permission-denied": 403,
  "invalid-argument": 400,
  "not-found": 404,
  conflict: 409,
  "rate-limited": 429,
  unavailable: 503,
  "not-implemented": 501,
  internal: 500,
  "invalid-code": 404,
  "code-expired": 409,
  "code-used": 409,
  "already-linked": 409,
  "too-many-attempts": 429,
  "already-responded": 409,
  "approval-expired": 409,
  "approval-cancelled": 409,
};

export class ApiError extends Error {
  readonly status: number;

  constructor(
    readonly reason: ErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = STATUS_BY_REASON[reason];
  }
}
