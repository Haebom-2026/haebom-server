import { claudeGuideModel } from "../../ai/guide-model.js";
import { createAwsCoreStore } from "../../core/aws-store.js";
import { createProfileGuard } from "../../core/profile.js";
import { createHttpHandler } from "../../shared/handler.js";
import { createLogger } from "../../shared/logger.js";
import { createRouter } from "../../shared/router.js";
import { createGuideRoute } from "./routes/guide.js";
import { notImplemented } from "./routes/not-implemented.js";

const profiles = createProfileGuard(
  createAwsCoreStore(process.env.TABLE_MAIN ?? "haebom-local-main"),
);

/** ai-fn: #16 guide, #17 classify. */
export const router = createRouter([
  {
    method: "POST",
    path: "/v1/elder/guide",
    handler: createGuideRoute(claudeGuideModel, profiles),
  },
  { method: "POST", path: "/v1/elder/classify", handler: notImplemented },
]);

export const handler = createHttpHandler(router, createLogger({ service: "ai" }));
