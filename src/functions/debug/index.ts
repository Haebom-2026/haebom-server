import { createAwsDebugStore } from "../../debug/aws-store.js";
import { mapNames } from "../../debug/command-trace.js";
import { createAwsInsightStore } from "../../debug/insight.js";
import { createDebugRoutes, parseEmailList } from "../../debug/routes.js";
import { parseMap } from "../../route/map.js";
import { SEED_MAP } from "../../route/seed-map.js";
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
    // R3~R5 기록 (main 테이블 MAP·ELDER# 파티션 읽기, infra/envs/dev 의 debug_main_read)
    insight: process.env.TABLE_MAIN ? createAwsInsightStore(process.env.TABLE_MAIN) : undefined,
    names: mapNames(parseMap(SEED_MAP)),
  }),
);

export const handler = createHttpHandler(router, createLogger({ service: "debug" }));
