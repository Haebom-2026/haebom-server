import { createAwsCoreStore } from "../../core/aws-store.js";
import { createCoreRoutes } from "../../core/routes.js";
import { requireEnv } from "../../shared/config.js";
import { createHttpHandler } from "../../shared/handler.js";
import { createAwsIdempotencyStore } from "../../shared/idempotency.js";
import { createLogger } from "../../shared/logger.js";
import { createRouter } from "../../shared/router.js";
import { healthz } from "./routes/healthz.js";

/** api-fn: #1~#15, #18~#24 (S1: 사용자·기기·연결) */
export const router = createRouter([
  { method: "GET", path: "/v1/healthz", handler: healthz },
  ...createCoreRoutes({
    store: createAwsCoreStore(process.env.TABLE_MAIN ?? "haebom-local-main"),
    idempotency: createAwsIdempotencyStore(process.env.TABLE_IDEM ?? "haebom-local-idem"),
  }),
]);

export const handler = createHttpHandler(router, createLogger({ service: "api" }));

// 배포 환경에서는 테이블 이름이 반드시 있어야 한다 (테스트에서는 생략 가능).
if (process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined) {
  requireEnv("TABLE_MAIN");
  requireEnv("TABLE_IDEM");
}
