import type { HttpEvent } from "../src/shared/http.js";

export function httpEvent(method: string, path: string, uid?: string): HttpEvent {
  const event = {
    version: "2.0",
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: "",
    headers: {},
    isBase64Encoded: false,
    requestContext: {
      accountId: "123456789012",
      apiId: "api",
      domainName: "example.com",
      domainPrefix: "example",
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
      requestId: "req",
      routeKey: `${method} ${path}`,
      stage: "$default",
      time: "",
      timeEpoch: 0,
      ...(uid === undefined
        ? {}
        : {
            authorizer: {
              principalId: "",
              integrationLatency: 0,
              jwt: { claims: { sub: uid }, scopes: [] },
            },
          }),
    },
  };
  return event;
}

export const lambdaContext = { awsRequestId: "test-request" };

export function parseBody(body: string | undefined): unknown {
  return JSON.parse(body ?? "null");
}
