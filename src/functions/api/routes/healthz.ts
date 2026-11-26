import { appEnv, appVersion } from "../../../shared/config.js";
import { json } from "../../../shared/http.js";
import type { RouteHandler } from "../../../shared/router.js";

/** #1 GET /v1/healthz — 인증 없음. */
export const healthz: RouteHandler = () =>
  Promise.resolve(json(200, { status: "ok", env: appEnv(), version: appVersion() }));
