import { z } from "zod";
import { chooseAppRequestSchema, classifyRequestSchema } from "../../../ai/classify-schema.js";
import { chooseApp, classify, type ClassifyDeps } from "../../../ai/classify.js";
import type { ProfileGuard } from "../../../core/profile.js";
import { ApiError } from "../../../shared/errors.js";
import { json } from "../../../shared/http.js";
import type { RouteHandler } from "../../../shared/router.js";
import { parseJsonBody } from "../../../shared/validate.js";

export type ClassifyRouteDeps = Omit<ClassifyDeps, "log">;

/**
 * #17 POST /v1/elder/classify (docs/api/s4-classify.md).
 * role=elder 만. 입력이 잘못되면 400. 안전 분류가 실패해도 200 + degraded (규칙 결과).
 */
export const createClassifyRoute =
  (profiles: ProfileGuard, deps: ClassifyRouteDeps): RouteHandler =>
  async ({ event, log }) => {
    const me = await profiles.require(event, "elder");
    const request = parseJsonBody(event, classifyRequestSchema);
    const requestLog = log.child({ uid: me.uid, commandId: request.commandId });
    return json(200, await classify(me.uid, request, { ...deps, log: requestLog }));
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
    return json(200, await chooseApp(me.uid, parsed.data, body, { ...deps, log: requestLog }));
  };
