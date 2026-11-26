import type { Context } from "aws-lambda";
import { ApiError } from "./errors.js";
import { errorResult, type HttpEvent, type HttpResult } from "./http.js";
import { createLogger, type Logger } from "./logger.js";
import type { Router } from "./router.js";

export type HttpLambda = (
  event: HttpEvent,
  context: Pick<Context, "awsRequestId">,
) => Promise<HttpResult>;

/**
 * HTTP Lambda 공통 래퍼: 라우팅, 오류 형식 통일, 접근 로그.
 * 예상하지 못한 오류는 내부 메시지를 숨기고 `internal` 로 응답한다.
 */
export function createHttpHandler(router: Router, logger: Logger = createLogger()): HttpLambda {
  return async (event, context) => {
    const started = Date.now();
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    const log = logger.child({ requestId: context.awsRequestId, method, path });

    let result: HttpResult;
    try {
      const match = router.match(method, path);
      if (!match) throw new ApiError("not-found", `No route for ${method} ${path}`);
      result = await match.handler({ event, params: match.params, log });
    } catch (error) {
      if (error instanceof ApiError) {
        result = errorResult(error);
      } else {
        log.error("unhandled error", { error });
        result = errorResult(new ApiError("internal", "Internal server error"));
      }
    }

    log.info("request completed", { status: result.statusCode, durationMs: Date.now() - started });
    return result;
  };
}
