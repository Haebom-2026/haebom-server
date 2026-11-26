import { ApiError } from "./errors.js";
import type { HttpEvent } from "./http.js";

export interface AuthContext {
  /** Firebase uid (JWT `sub`). 서명·만료 검증은 API Gateway JWT Authorizer 가 끝낸 상태. */
  uid: string;
}

export function requireAuth(event: HttpEvent): AuthContext {
  const sub = event.requestContext.authorizer?.jwt.claims.sub;
  if (typeof sub !== "string" || sub === "") {
    throw new ApiError("unauthenticated", "Missing or invalid credentials");
  }
  return { uid: sub };
}
