import { createAwsDebugStore } from "../../debug/aws-store.js";
import { createDebugRoutes, parseEmailList } from "../../debug/routes.js";
import { requireEnv } from "../../shared/config.js";
import { createHttpHandler } from "../../shared/handler.js";
import { createLogger } from "../../shared/logger.js";
import { createRouter } from "../../shared/router.js";

/**
 * debug-fn: 디버그 뷰어 API (docs/server-plan.md 12장).
 * dev 환경에만 배포된다 (infra/modules/debug 는 envs/dev 에서만 사용).
 */
export const router = createRouter(
  createDebugRoutes({
    store: createAwsDebugStore({
      table: requireEnv("DEBUG_TABLE"),
      bucket: requireEnv("DEBUG_BUCKET"),
    }),
    viewerEmails: parseEmailList(process.env.DEBUG_VIEWER_EMAILS),
  }),
);

export const handler = createHttpHandler(router, createLogger({ service: "debug" }));
