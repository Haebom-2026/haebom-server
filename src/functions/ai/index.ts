import { claudeGuideModel } from "../../ai/guide-model.js";
import { createAwsGuideCache } from "../../cache/aws-guide-cache.js";
import { createAwsCoreStore } from "../../core/aws-store.js";
import { createProfileGuard } from "../../core/profile.js";
import { createAwsDebugStore } from "../../debug/aws-store.js";
import { createGuideTraceRecorder } from "../../debug/guide-trace.js";
import { createHttpHandler } from "../../shared/handler.js";
import { createLogger } from "../../shared/logger.js";
import { createRouter } from "../../shared/router.js";
import { createGuideRoute } from "./routes/guide.js";
import { notImplemented } from "./routes/not-implemented.js";

const profiles = createProfileGuard(
  createAwsCoreStore(process.env.TABLE_MAIN ?? "haebom-local-main"),
);

/** dev 에만 디버그 저장소가 있다 (infra/envs/dev 가 DEBUG_TABLE·DEBUG_BUCKET 을 넘김). prod 는 기록하지 않는다. */
const debugTable = process.env.DEBUG_TABLE;
const debugBucket = process.env.DEBUG_BUCKET;
const recorder =
  debugTable && debugBucket
    ? createGuideTraceRecorder(createAwsDebugStore({ table: debugTable, bucket: debugBucket }))
    : undefined;

/** #16 응답 캐시 (docs/server-plan.md 9장). 테이블이 없으면 캐시 없이 동작 */
const cacheTable = process.env.TABLE_AI_CACHE;
const cache = cacheTable ? createAwsGuideCache({ table: cacheTable }) : undefined;

/** ai-fn: #16 guide, #17 classify. */
export const router = createRouter([
  {
    method: "POST",
    path: "/v1/elder/guide",
    handler: createGuideRoute(claudeGuideModel, profiles, {
      recorder,
      modelName: process.env.ANTHROPIC_MODEL,
      cache,
    }),
  },
  { method: "POST", path: "/v1/elder/classify", handler: notImplemented },
]);

export const handler = createHttpHandler(router, createLogger({ service: "ai" }));
