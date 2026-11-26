import { createHttpHandler } from "../../shared/handler.js";
import { createLogger } from "../../shared/logger.js";
import { createRouter } from "../../shared/router.js";
import { healthz } from "./routes/healthz.js";

/** api-fn: #1~#15, #18~#24. S1 부터 라우트를 추가한다. */
export const router = createRouter([{ method: "GET", path: "/v1/healthz", handler: healthz }]);

export const handler = createHttpHandler(router, createLogger({ service: "api" }));
