import { z } from "zod";
import type { MapLearnStore } from "../../../map/learn.js";
import { chooseAppRequestSchema, classifyRequestSchema } from "../../../ai/classify-schema.js";
import {
  chooseApp,
  classify,
  type ClassifyDeps,
  type ClassifyDetail,
} from "../../../ai/classify.js";
import type { ProfileGuard } from "../../../core/profile.js";
import type { CommandTraceRecorder } from "../../../debug/command-trace.js";
import { ApiError } from "../../../shared/errors.js";
import { json } from "../../../shared/http.js";
import type { RouteHandler } from "../../../shared/router.js";
import { parseJsonBody } from "../../../shared/validate.js";
import type { GuideTraceRecorder } from "../../../debug/guide-trace.js";
import { endCommand, endCommandRequestSchema } from "../../../route/command-end.js";

export type ClassifyRouteDeps = Omit<ClassifyDeps, "log" | "observe"> & {
  /** dev 에만: classify·앱 선택을 디버그 뷰어 기기 목록에 남김 */
  recorder?: CommandTraceRecorder | undefined;
  now?: () => Date;
};

/**
 * #17 POST /v1/elder/classify (docs/api/s4-classify.md).
 * role=elder 만. 입력이 잘못되면 400. 안전 분류가 실패해도 200 + degraded (규칙 결과).
 */
export const createClassifyRoute =
  (profiles: ProfileGuard, deps: ClassifyRouteDeps): RouteHandler =>
  async ({ event, log }) => {
    const receivedAt = (deps.now ?? (() => new Date()))();
    const me = await profiles.require(event, "elder");
    const request = parseJsonBody(event, classifyRequestSchema);
    const requestLog = log.child({ uid: me.uid, commandId: request.commandId });
    let detail: ClassifyDetail | undefined;
    const response = await classify(me.uid, request, {
      ...deps,
      log: requestLog,
      observe: deps.recorder
        ? (d) => {
            detail = d;
          }
        : undefined,
    });
    if (deps.recorder && detail) {
      try {
        await deps.recorder.classify({ uid: me.uid, receivedAt, detail });
      } catch (error) {
        // 디버그 기록 실패는 응답에 영향을 주지 않는다
        requestLog.warn("classify trace save failed", { error });
      }
    }
    return json(200, response);
  };

const commandIdSchema = z.coerce.number().int().nonnegative();

/**
 * POST /v1/elder/commands/{commandId}/app — 폰이 고른 후보 앱을 고정, 질문 답 받기.
 * 다른 어르신의 명령은 키가 달라 404.
 */
export const createChooseAppRoute =
  (profiles: ProfileGuard, deps: ClassifyRouteDeps): RouteHandler =>
  async ({ event, params, log }) => {
    const me = await profiles.require(event, "elder");
    const parsed = commandIdSchema.safeParse(params.commandId);
    if (!parsed.success) throw new ApiError("invalid-argument", "commandId 가 숫자가 아닙니다");
    const body = parseJsonBody(event, chooseAppRequestSchema);
    const requestLog = log.child({ uid: me.uid, commandId: parsed.data });
    const receivedAt = (deps.now ?? (() => new Date()))();
    const response = await chooseApp(me.uid, parsed.data, body, { ...deps, log: requestLog });
    if (deps.recorder) {
      try {
        await deps.recorder.choose({
          uid: me.uid,
          receivedAt,
          commandId: parsed.data,
          body,
          response,
        });
      } catch (error) {
        requestLog.warn("choose trace save failed", { error });
      }
    }
    return json(200, response);
  };

/**
 * POST /v1/elder/commands/{commandId}/end — 명령이 끝났음과 마지막 화면 (R3).
 * 다른 어르신의 명령은 키가 달라 404. done·stopped_safe 이면 dev 에서 Opus 검토가 돈다.
 */
export const createEndCommandRoute =
  (
    profiles: ProfileGuard,
    deps: Pick<ClassifyRouteDeps, "commands"> & {
      recorder?: GuideTraceRecorder | undefined;
      learn?: MapLearnStore | undefined;
    },
  ): RouteHandler =>
  async ({ event, params, log }) => {
    const me = await profiles.require(event, "elder");
    const parsed = commandIdSchema.safeParse(params.commandId);
    if (!parsed.success) throw new ApiError("invalid-argument", "commandId 가 숫자가 아닙니다");
    const body = parseJsonBody(event, endCommandRequestSchema);
    const requestLog = log.child({ uid: me.uid, commandId: parsed.data });
    return json(200, await endCommand(me.uid, parsed.data, body, { ...deps, log: requestLog }));
  };
