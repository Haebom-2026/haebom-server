import { guide, type GuideModel, type GuideTrace } from "../../../ai/guide.js";
import { guideRequestSchema } from "../../../ai/guide-schema.js";
import type { ProfileGuard } from "../../../core/profile.js";
import type { GuideTraceRecorder } from "../../../debug/guide-trace.js";
import { json } from "../../../shared/http.js";
import type { RouteHandler } from "../../../shared/router.js";
import { parseJsonBody } from "../../../shared/validate.js";

export interface GuideRouteOptions {
  /** dev 에서만: 요청·AI 입력·판단을 디버그 뷰어에 남긴다 */
  recorder?: GuideTraceRecorder | undefined;
  /** 기록에 남길 모델 이름 */
  modelName?: string | undefined;
  now?: () => Date;
}

/**
 * #16 POST /v1/elder/guide.
 * role=elder 만 (프로필 없으면 403 profile-required). 입력이 잘못되면 400,
 * 그 밖의 실패는 200 + { type: "say" }.
 * 호출 한도는 시연 단계라 두지 않는다 (docs/api/s5-guide.md 6장).
 */
export const createGuideRoute =
  (model: GuideModel, profiles: ProfileGuard, options: GuideRouteOptions = {}): RouteHandler =>
  async ({ event, log }) => {
    const receivedAt = (options.now ?? (() => new Date()))();
    const me = await profiles.require(event, "elder");
    const request = parseJsonBody(event, guideRequestSchema);
    const requestLog = log.child({ uid: me.uid, requestId: request.requestId });

    let trace: GuideTrace | undefined;
    const response = await guide(request, model, requestLog, (t) => {
      trace = t;
    });

    if (options.recorder && trace) {
      try {
        const saved = await options.recorder.record({
          uid: me.uid,
          request,
          response,
          trace,
          model: options.modelName ?? "",
          receivedAt,
          deviceId: request.deviceId,
        });
        requestLog.debug("guide trace saved", saved);
      } catch (error) {
        // 디버그 기록 실패는 응답에 영향을 주지 않는다
        requestLog.warn("guide trace save failed", { error });
      }
    }
    return json(200, response);
  };
