/**
 * 디버그 뷰어 API (docs/server-plan.md 12장, dev 환경 전용).
 *   앱   : POST /v1/dev/heartbeat, POST /v1/dev/screens
 *   뷰어 : GET·PATCH /v1/dev/devices…, PUT·GET pins  (개발자 허용 목록만)
 *          GET /v1/dev/map, GET /v1/dev/devices/{deviceId}/commands/{commandId}  (R3~R5 기록, 읽기만)
 */
import { randomBytes, randomUUID } from "node:crypto";
import { FINGERPRINT_VERSION, fingerprint } from "../cache/fingerprint.js";
import { requireAuth, type AuthContext } from "../shared/auth.js";
import { ApiError } from "../shared/errors.js";
import { json, type HttpEvent, type HttpResult } from "../shared/http.js";
import type { Route } from "../shared/router.js";
import { maskDeep } from "../shared/sensitive.js";
import { parseJsonBody, parseQuery } from "../shared/validate.js";
import {
  deviceIdSchema,
  heartbeatSchema,
  labelSchema,
  pinSchema,
  screenIdSchema,
  screenPostSchema,
  screensQuerySchema,
} from "./schema.js";
import { createPageMatcher, type PreparedMatch } from "./pages.js";
import type { MapNames } from "./command-trace.js";
import type { InsightStore } from "./insight.js";
import { ONLINE_WINDOW_MS, newScreenId, type DebugStore } from "./store.js";

export interface DebugDeps {
  store: DebugStore;
  /** 뷰어를 쓸 수 있는 개발자 이메일 (소문자) */
  viewerEmails: ReadonlySet<string>;
  now?: () => Date;
  /** 테스트용: 새 페이지 ID */
  newPageId?: () => string;
  /** 배운 지도·명령 검토 (main 테이블 읽기). 없으면 그 두 주소는 unavailable */
  insight?: InsightStore | undefined;
  /** 목표·앱 이름표 (jev 지도) */
  names?: MapNames | undefined;
}

export function parseEmailList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

const noContent = (): HttpResult => ({ statusCode: 204 });

/**
 * 앱용: 로그인만 확인한다.
 * TODO(S1): users 프로필이 생기면 role=elder 만 허용 (12.3).
 */
function requireApp(event: HttpEvent): AuthContext {
  return requireAuth(event);
}

/** 뷰어용: Google 로그인 토큰의 이메일이 허용 목록에 있고 인증된 이메일이어야 한다. */
function requireViewer(
  event: HttpEvent,
  allowed: ReadonlySet<string>,
): AuthContext & { email: string } {
  const auth = requireAuth(event);
  const claims = event.requestContext.authorizer?.jwt.claims ?? {};
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (email === "" || !verified || !allowed.has(email)) {
    throw new ApiError("permission-denied", "Debug viewer is limited to allowed developers");
  }
  return { ...auth, email };
}

function param(params: Readonly<Record<string, string>>, name: string): string {
  const value = params[name];
  if (value === undefined) throw new ApiError("invalid-argument", `missing ${name}`);
  return value;
}

function validDeviceId(params: Readonly<Record<string, string>>): string {
  const result = deviceIdSchema.safeParse(param(params, "deviceId"));
  if (!result.success) throw new ApiError("invalid-argument", "invalid deviceId");
  return result.data;
}

const COMMAND_ID = /^\d{1,15}$/;

export function createDebugRoutes(deps: DebugDeps): Route[] {
  const { store, viewerEmails } = deps;
  const insight = (): InsightStore => {
    if (!deps.insight) throw new ApiError("unavailable", "map insight is not configured");
    return deps.insight;
  };
  const now = deps.now ?? (() => new Date());
  const matcher = createPageMatcher(store, deps.newPageId);

  return [
    {
      method: "POST",
      path: "/v1/dev/heartbeat",
      handler: async ({ event }) => {
        const { uid } = requireApp(event);
        const body = parseJsonBody(event, heartbeatSchema);
        await store.heartbeat({ ...body, uid, now: now() });
        return noContent();
      },
    },
    {
      method: "POST",
      path: "/v1/dev/screens",
      handler: async ({ event, log }) => {
        const { uid } = requireApp(event);
        const body = parseJsonBody(event, screenPostSchema);
        const received = now();

        // 저장 전 마스킹 (7.4). 지문도 마스킹된 글자로 계산한다 → 캐싱 계층과 같은 입력.
        // pkg·hash 는 식별자라 건드리지 않고 노드만 가린다.
        const masked = maskDeep(body.screen.nodes);
        const screen = { ...body.screen, nodes: masked.value };
        const fp = fingerprint(screen);
        const screenId = newScreenId(received, randomBytes(3).toString("hex"));

        // 이미 본 어느 페이지인지 (시험). 실패해도 화면 저장은 계속한다
        let prepared: PreparedMatch | undefined;
        try {
          prepared = await matcher.prepare({
            pkg: screen.pkg,
            fingerprint: fp,
            nodes: screen.nodes,
            deviceId: body.deviceId,
            screenId,
            at: received.toISOString(),
          });
        } catch (error) {
          log.warn("screen match failed", { error: (error as Error).message });
        }

        const saved = await store.saveScreen({
          uid,
          dedupeKey: `${screen.pkg}|${screen.hash ?? fp}`,
          screenId,
          deviceId: body.deviceId,
          receivedAt: received.toISOString(),
          capturedAt: body.capturedAt,
          pkg: screen.pkg,
          ...(screen.hash === undefined ? {} : { appHash: screen.hash }),
          fingerprint: fp,
          fpVersion: FINGERPRINT_VERSION,
          nodeCount: screen.nodes.length,
          maskedCount: masked.count,
          pinned: false,
          ...(prepared ? { match: prepared.match } : {}),
          screen,
        });
        if (saved && prepared) {
          await prepared.commit().catch((error: unknown) => {
            log.warn("page update failed", { error: (error as Error).message });
          });
        }

        if (masked.count > 0) log.warn("sensitive text masked", { maskedCount: masked.count });
        return json(
          202,
          saved
            ? {
                status: "saved",
                screenId,
                fingerprint: fp,
                ...(prepared ? { match: prepared.match } : {}),
              }
            : { status: "unchanged" },
        );
      },
    },
    {
      method: "GET",
      path: "/v1/dev/devices",
      handler: async ({ event }) => {
        requireViewer(event, viewerEmails);
        const devices = await store.listDevices();
        const nowMs = now().getTime();
        const items = devices
          .map((device) => ({
            ...device,
            online: nowMs - Date.parse(device.lastSeenAt) <= ONLINE_WINDOW_MS,
          }))
          .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
        return json(200, { items, serverTime: new Date(nowMs).toISOString() });
      },
    },
    {
      method: "PATCH",
      path: "/v1/dev/devices/{deviceId}",
      handler: async ({ event, params }) => {
        requireViewer(event, viewerEmails);
        const deviceId = validDeviceId(params);
        const { label } = parseJsonBody(event, labelSchema);
        if (!(await store.setLabel(deviceId, label)))
          throw new ApiError("not-found", "device not found");
        return noContent();
      },
    },
    {
      method: "GET",
      path: "/v1/dev/devices/{deviceId}/screens",
      handler: async ({ event, params }) => {
        requireViewer(event, viewerEmails);
        const deviceId = validDeviceId(params);
        const query = parseQuery(event, screensQuerySchema);
        return json(200, await store.listScreens(deviceId, query));
      },
    },
    {
      method: "GET",
      path: "/v1/dev/devices/{deviceId}/screens/{screenId}",
      handler: async ({ event, params }) => {
        requireViewer(event, viewerEmails);
        const deviceId = validDeviceId(params);
        const screenId = screenIdSchema.safeParse(param(params, "screenId"));
        if (!screenId.success) throw new ApiError("invalid-argument", "invalid screenId");
        const screen = await store.getScreen(deviceId, screenId.data);
        if (!screen) throw new ApiError("not-found", "screen not found (expired?)");
        return json(200, screen);
      },
    },
    {
      method: "PUT",
      path: "/v1/dev/devices/{deviceId}/pins",
      handler: async ({ event, params }) => {
        const { email } = requireViewer(event, viewerEmails);
        const deviceId = validDeviceId(params);
        const body = parseJsonBody(event, pinSchema);
        const pin = await store.createPin({
          pinId: randomUUID(),
          deviceId,
          ...body,
          createdBy: email,
          createdAt: now().toISOString(),
        });
        return json(201, pin);
      },
    },
    {
      method: "GET",
      path: "/v1/dev/devices/{deviceId}/commands/{commandId}",
      handler: async ({ event, params }) => {
        requireViewer(event, viewerEmails);
        const deviceId = validDeviceId(params);
        const raw = param(params, "commandId");
        if (!COMMAND_ID.test(raw)) throw new ApiError("invalid-argument", "invalid commandId");
        // 명령은 uid 에 묶여 있다: 그 기기를 마지막으로 쓴 uid (가상 기기 uid-… 도 META 에 uid 가 있음)
        const device = (await store.listDevices()).find((d) => d.deviceId === deviceId);
        if (!device) throw new ApiError("not-found", "device not found");
        return json(200, {
          ...(await insight().command(device.uid, Number(raw))),
          ...(deps.names ? { names: deps.names } : {}),
        });
      },
    },
    {
      method: "GET",
      path: "/v1/dev/map",
      handler: async ({ event }) => {
        requireViewer(event, viewerEmails);
        const at = now();
        return json(200, {
          ...(await insight().learnedMap(at)),
          ...(deps.names ? { names: deps.names } : {}),
          serverTime: at.toISOString(),
        });
      },
    },
    {
      method: "GET",
      path: "/v1/dev/pins",
      handler: async ({ event }) => {
        requireViewer(event, viewerEmails);
        return json(200, { items: await store.listPins() });
      },
    },
  ];
}
