import { randomBytes } from "node:crypto";
import { guide, type GuideModel, type GuideTrace } from "../../../ai/guide.js";
import { guideRequestSchema } from "../../../ai/guide-schema.js";
import type { ProfileGuard } from "../../../core/profile.js";
import type { GuideTraceRecorder } from "../../../debug/guide-trace.js";
import type { CommandLog } from "../../../route/command-log.js";
import { maskText } from "../../../shared/sensitive.js";
import { json } from "../../../shared/http.js";
import type { RouteHandler } from "../../../shared/router.js";
import { parseJsonBody } from "../../../shared/validate.js";

export interface GuideRouteOptions {
  /** dev 에서만: 요청·AI 입력·판단을 디버그 뷰어에 남긴다 */
  recorder?: GuideTraceRecorder | undefined;
  /** 기록에 남길 모델 이름 */
  modelName?: string | undefined;
  /** dev 에서만: commandId 가 오면 명령 단계를 남긴다 (지도 학습 재료, R3) */
  commandLog?: CommandLog | undefined;
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
    const answer = await guide(request, model, requestLog, (t) => {
      trace = t;
    });
    // 어르신이 이 안내를 따르면 앱이 다음 요청의 lastAction.stepId 로 돌려준다
    const response = { ...answer, stepId: newStepId() };

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
        if (options.commandLog && request.commandId !== undefined) {
          const action = request.lastAction;
          await options.commandLog.appendStep({
            uid: me.uid,
            commandId: request.commandId,
            stepId: response.stepId,
            receivedAt: receivedAt.toISOString(),
            screen: { deviceId: saved.deviceId, screenId: saved.screenId },
            ...(saved.match
              ? {
                  page: {
                    kind: saved.match.kind,
                    ...(saved.match.pageId === undefined ? {} : { pageId: saved.match.pageId }),
                  },
                }
              : {}),
            pkg: request.screen.pkg,
            guide: {
              type: response.type,
              ...(response.targetText === undefined
                ? {}
                : { targetText: maskText(response.targetText).text }),
              ...(response.dir === undefined ? {} : { dir: response.dir }),
              ...(response.status === undefined ? {} : { status: response.status }),
              source: "ai",
            },
            ...(action
              ? {
                  lastAction: {
                    ...(action.stepId === undefined ? {} : { stepId: action.stepId }),
                    seq: action.seq,
                    action: action.action,
                    // 글자 넣기는 넣은 값을 남기지 않는다 (인증번호·PIN 일 수 있음)
                    text: action.action === "type" ? "" : maskText(action.text).text,
                  },
                }
              : {}),
          });
        }
      } catch (error) {
        // 디버그 기록 실패는 응답에 영향을 주지 않는다
        requestLog.warn("guide trace save failed", { error });
      }
    }
    return json(200, response);
  };

/** 안내 하나의 id: 시각 + 무작위 (앱이 lastAction.stepId 로 돌려줌) */
const newStepId = (): string => `s${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
