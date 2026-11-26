import { guide, type GuideModel } from "../../../ai/guide.js";
import { guideRequestSchema } from "../../../ai/guide-schema.js";
import type { ProfileGuard } from "../../../core/profile.js";
import { json } from "../../../shared/http.js";
import type { RouteHandler } from "../../../shared/router.js";
import { parseJsonBody } from "../../../shared/validate.js";

/**
 * #16 POST /v1/elder/guide.
 * role=elder 만 (프로필 없으면 403 profile-required). 입력이 잘못되면 400,
 * 그 밖의 실패는 200 + { type: "say" }.
 * 호출 한도는 시연 단계라 두지 않는다 (docs/api/s5-guide.md 6장).
 */
export const createGuideRoute =
  (model: GuideModel, profiles: ProfileGuard): RouteHandler =>
  async ({ event, log }) => {
    const me = await profiles.require(event, "elder");
    const request = parseJsonBody(event, guideRequestSchema);
    const response = await guide(
      request,
      model,
      log.child({ uid: me.uid, requestId: request.requestId }),
    );
    return json(200, response);
  };
