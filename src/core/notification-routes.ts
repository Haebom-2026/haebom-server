/**
 * S2 알림 API (docs/server-plan.md 4.2, 6장 처리 규칙, 지침서 5.4·5.6).
 *   고령자 : POST /v1/elder/sensitive-entries (#6), POST /v1/elder/stuck (#7), POST /v1/elder/sos (#8)
 *   보호자 : GET /v1/guardian/notifications (#21), POST /v1/guardian/notifications/{id}/read (#22)
 * 받을 보호자는 서버가 연결 목록에서 정한다 (앱은 보호자를 지정하지 않음).
 * 보호자별 알림함 항목이 생기면 push-fn 이 Streams 로 받아 그 보호자 기기에 FCM 을 보낸다.
 */
import { ApiError } from "../shared/errors.js";
import { json, type HttpResult } from "../shared/http.js";
import { idempotent, type IdempotencyStore } from "../shared/idempotency.js";
import type { Route } from "../shared/router.js";
import { maskText } from "../shared/sensitive.js";
import { parseJsonBody, parseQuery } from "../shared/validate.js";
import type { LinkRecord } from "./model.js";
import {
  SENSITIVE_DEDUP_MS,
  inboxView,
  listQuerySchema,
  newNotificationId,
  notificationIdSchema,
  readAllSchema,
  sensitiveEntrySchema,
  sosSchema,
  stuckSchema,
  type InboxItem,
  type NotificationRecord,
  type NotificationStore,
} from "./notifications.js";
import { createProfileGuard, type ProfileGuard } from "./profile.js";
import type { CoreStore } from "./store.js";

export interface NotificationDeps {
  store: CoreStore;
  notifications: NotificationStore;
  idempotency: IdempotencyStore;
  profiles?: ProfileGuard;
  now?: () => Date;
}

const masked = (text: string): string => maskText(text).text;

export function createNotificationRoutes(deps: NotificationDeps): Route[] {
  const { store, notifications } = deps;
  const now = deps.now ?? (() => new Date());
  const profiles = deps.profiles ?? createProfileGuard(store, () => now().getTime());
  const withKey = (handler: Route["handler"]) => idempotent(deps.idempotency, handler, now);

  /** 연결된 보호자 모두에게 알림을 만든다. 보호자가 없으면 아무것도 쓰지 않는다. */
  async function notify(
    elderId: string,
    content: Omit<NotificationRecord, "id" | "elderId" | "createdAt">,
    dedup: boolean,
  ): Promise<HttpResult> {
    const links: LinkRecord[] = await store.listLinksByElder(elderId);
    if (links.length === 0) return json(200, { result: "no_guardians" });

    const at = now();
    const record: NotificationRecord = {
      id: newNotificationId(at),
      elderId,
      createdAt: at.toISOString(),
      ...content,
    };
    const inbox: InboxItem[] = links.map((link) => ({
      ...record,
      guardianId: link.guardianId,
      elderName: link.elderName,
      elderLabel: link.elderLabel,
    }));
    const result = await notifications.create(record, inbox, {
      now: record.createdAt,
      ...(dedup ? { dedupUntil: new Date(at.getTime() + SENSITIVE_DEDUP_MS).toISOString() } : {}),
    });
    if (result === "duplicate_suppressed") return json(200, { result });
    return json(201, { result, notificationId: record.id, guardianCount: links.length });
  }

  return [
    // #6 민감 앱 알림 (L1 이상, 어르신이 "예"를 눌렀을 때). 같은 앱 10분 안이면 duplicate_suppressed.
    {
      method: "POST",
      path: "/v1/elder/sensitive-entries",
      handler: withKey(async ({ event }) => {
        const me = await profiles.require(event, "elder");
        const input = parseJsonBody(event, sensitiveEntrySchema);
        return notify(
          me.uid,
          {
            type: "sensitive_entry",
            packageName: input.packageName,
            appName: masked(input.appName),
            level: input.level,
            category: input.category,
            reason: masked(input.reason),
          },
          true,
        );
      }),
    },

    // #7 막힘 (45초 진행 없음). 중복 방지 없음.
    {
      method: "POST",
      path: "/v1/elder/stuck",
      handler: withKey(async ({ event }) => {
        const me = await profiles.require(event, "elder");
        const input = parseJsonBody(event, stuckSchema);
        return notify(
          me.uid,
          { type: "stuck", packageName: input.packageName, appName: masked(input.appName) },
          false,
        );
      }),
    },

    // #8 SOS (L3 사기 의심 포함). 누를 때마다 보낸다.
    {
      method: "POST",
      path: "/v1/elder/sos",
      handler: withKey(async ({ event }) => {
        const me = await profiles.require(event, "elder");
        const input = parseJsonBody(event, sosSchema);
        return notify(
          me.uid,
          {
            type: "sos",
            packageName: input.packageName,
            appName: masked(input.appName),
            ...(input.category === undefined ? {} : { category: input.category }),
            ...(input.reason === undefined ? {} : { reason: masked(input.reason) }),
            ...(input.category === "scam" ? { level: "L3" as const } : {}),
          },
          false,
        );
      }),
    },

    // #21 알림 목록 (최신순). since 는 iPhone 폴링용: 응답의 serverTime 을 다음 요청에 넣는다.
    {
      method: "GET",
      path: "/v1/guardian/notifications",
      handler: async ({ event }) => {
        const me = await profiles.require(event, "guardian");
        const query = parseQuery(event, listQuerySchema);
        const serverTime = now().toISOString();
        const page = await notifications.listInbox(me.uid, {
          cursor: query.cursor,
          since: query.since,
          limit: query.limit,
        });
        return json(200, {
          items: page.items.map(inboxView),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          serverTime,
        });
      },
    },

    // 알림 한 건 (보호자 앱 요청: FCM 알림을 눌러 상세 열기). 없거나 해제됐으면 404.
    {
      method: "GET",
      path: "/v1/guardian/notifications/{id}",
      handler: async ({ event, params }) => {
        const me = await profiles.require(event, "guardian");
        const id = notificationIdSchema.safeParse(params.id);
        if (!id.success) throw new ApiError("invalid-argument", "invalid notification id");
        const item = await notifications.getInbox(me.uid, id.data);
        if (item === undefined) throw new ApiError("not-found", "Notification not found");
        return json(200, inboxView(item));
      },
    },

    // 모두 읽음 (보호자 앱 "모두 확인"). elderId 를 주면 그 어르신 것만.
    {
      method: "POST",
      path: "/v1/guardian/notifications/read-all",
      handler: async ({ event }) => {
        const me = await profiles.require(event, "guardian");
        // 본문 없이 불러도 된다 (전체 읽음).
        const input =
          event.body === undefined || event.body === "" ? {} : parseJsonBody(event, readAllSchema);
        const updated = await notifications.markAllRead(me.uid, now().toISOString(), input.elderId);
        return json(200, { updated });
      },
    },

    // #22 읽음 처리. 이미 읽었으면 처음 읽은 시각을 유지한다.
    {
      method: "POST",
      path: "/v1/guardian/notifications/{id}/read",
      handler: async ({ event, params }) => {
        const me = await profiles.require(event, "guardian");
        const id = notificationIdSchema.safeParse(params.id);
        if (!id.success) throw new ApiError("invalid-argument", "invalid notification id");
        if (!(await notifications.markRead(me.uid, id.data, now().toISOString()))) {
          throw new ApiError("not-found", "Notification not found");
        }
        return { statusCode: 204 };
      },
    },
  ];
}
