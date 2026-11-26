import { guide, type GuideModel } from "../../../ai/guide.js";
import { guideRequestSchema } from "../../../ai/guide-schema.js";
import { requireAuth } from "../../../shared/auth.js";
import { json } from "../../../shared/http.js";
import type { RouteHandler } from "../../../shared/router.js";
import { parseJsonBody } from "../../../shared/validate.js";

/** #16 POST /v1/elder/guide. 입력이 잘못되면 400, 그 밖의 실패는 200 + { type: "say" }. */
export const createGuideRoute =
  (model: GuideModel): RouteHandler =>
  async ({ event, log }) => {
    const { uid } = requireAuth(event);
    const request = parseJsonBody(event, guideRequestSchema);
    const response = await guide(request, model, log.child({ uid, requestId: request.requestId }));
    return json(200, response);
  };
