import type { HttpEvent, HttpResult } from "./http.js";
import type { Logger } from "./logger.js";

export interface RequestContext {
  event: HttpEvent;
  params: Readonly<Record<string, string>>;
  log: Logger;
}

export type RouteHandler = (ctx: RequestContext) => Promise<HttpResult>;

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** 예: `/v1/elder/approvals/{id}/cancel` */
  path: string;
  handler: RouteHandler;
}

export interface RouteMatch {
  handler: RouteHandler;
  params: Record<string, string>;
}

export interface Router {
  match(method: string, path: string): RouteMatch | undefined;
}

type Segment = { kind: "static"; value: string } | { kind: "param"; name: string };

function parsePattern(path: string): Segment[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((part) =>
      part.startsWith("{") && part.endsWith("}")
        ? { kind: "param", name: part.slice(1, -1) }
        : { kind: "static", value: part },
    );
}

export function createRouter(routes: Route[]): Router {
  const compiled = routes.map((route) => ({ ...route, segments: parsePattern(route.path) }));

  return {
    match(method, path) {
      const parts = path.split("/").filter(Boolean);
      for (const route of compiled) {
        if (route.method !== method.toUpperCase()) continue;
        if (route.segments.length !== parts.length) continue;

        const params: Record<string, string> = {};
        const matched = route.segments.every((segment, i) => {
          const part = parts[i] ?? "";
          if (segment.kind === "static") return segment.value === part;
          params[segment.name] = decodeURIComponent(part);
          return part !== "";
        });
        if (matched) return { handler: route.handler, params };
      }
      return undefined;
    },
  };
}
