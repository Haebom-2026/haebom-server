import { requireAuth } from "../../../shared/auth.js";
import { ApiError } from "../../../shared/errors.js";
import type { RouteHandler } from "../../../shared/router.js";

/** S4(#17)·S5(#16) 에서 교체할 자리. 인증 경로는 지금부터 실제와 같게 둔다. */
export const notImplemented: RouteHandler = ({ event }) => {
  requireAuth(event);
  return Promise.reject(new ApiError("not-implemented", "Not implemented yet"));
};
