import type {
  APIGatewayEventRequestContextJWTAuthorizer,
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import type { ApiError } from "./errors.js";

/**
 * API Gateway HTTP API (payload 2.0) 이벤트.
 * 인증 없는 라우트(healthz)에서는 authorizer 가 없으므로 optional 로 둔다.
 */
export type HttpEvent = APIGatewayProxyEventV2 & {
  requestContext: { authorizer?: APIGatewayEventRequestContextJWTAuthorizer };
};

export type HttpResult = APIGatewayProxyStructuredResultV2;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function json(statusCode: number, body: unknown): HttpResult {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

export function errorResult(error: ApiError): HttpResult {
  return json(error.status, { error: { reason: error.reason, message: error.message } });
}
