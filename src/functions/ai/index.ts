import { createHttpHandler } from "../../shared/handler.js";
import { createLogger } from "../../shared/logger.js";
import { createRouter } from "../../shared/router.js";
import { notImplemented } from "./routes/not-implemented.js";

/** ai-fn: #16 guide, #17 classify. */
export const router = createRouter([
  { method: "POST", path: "/v1/elder/guide", handler: notImplemented },
  { method: "POST", path: "/v1/elder/classify", handler: notImplemented },
]);

export const handler = createHttpHandler(router, createLogger({ service: "ai" }));
