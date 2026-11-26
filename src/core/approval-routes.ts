/**
 * S3 승인 API (docs/server-plan.md 4.2·6장, 지침서 5.5·8장, 두 앱 검토 답변).
 *   고령자 : POST /v1/elder/approvals (#9), POST /v1/elder/approvals/{id}/cancel (#10),
 *            GET /v1/elder/approvals/{id} (#19, FCM 이 빠질 때 폴링)
 *   보호자 : POST /v1/guardian/approvals/{id}/respond (#13), GET /v1/guardian/approvals (#23),
 *            GET /v1/guardian/approvals/{id} (#24)
 * 보호자 항목이 생기면 보호자에게, 상태가 바뀌면 고령자에게 push-fn 이 FCM 을 보낸다.
 */
import { ApiError } from "../shared/errors.js";
import { json } from "../shared/http.js";
import { idempotent, type IdempotencyStore } from "../shared/idempotency.js";
import type { Logger } from "../shared/logger.js";
import type { Route } from "../shared/router.js";
import { maskText } from "../shared/sensitive.js";
import { parseJsonBody, parseQuery } from "../shared/validate.js";
import {
  APPROVAL_TTL_MS,
  approvalIdSchema,
  createApprovalSchema,
  effectiveStatus,
  elderApprovalView,
  guardianApprovalView,
  guardianListQuerySchema,
  newApprovalId,
  respondSchema,
  type ApprovalRecord,
  type ApprovalStatus,
  type ApprovalStore,
  type GuardianApproval,
} from "./approvals.js";
import { createProfileGuard, type ProfileGuard } from "./profile.js";
import type { CoreStore } from "./store.js";

export interface ApprovalDeps {
  store: CoreStore;
  approvals: ApprovalStore;
  idempotency: IdempotencyStore;
  profiles?: ProfileGuard;
  now?: () => Date;
}

/** pending 이 아닌 승인에 응답·취소하려 할 때의 오류 (보호자 앱 요청 2.3) */
function finishedError(status: ApprovalStatus): ApiError {
  switch (status) {
    case "approved":
    case "rejected":
      return new ApiError("already-responded", "This request was already answered");
    case "expired":
      return new ApiError("approval-expired", "This request has expired");
    case "cancelled":
      return new ApiError("approval-cancelled", "This request was cancelled");
    case "pending":
      return new ApiError("conflict", "This request is still pending");
  }
}

function parseId(params: Readonly<Record<string, string>>): string {
  const id = approvalIdSchema.safeParse(params.id);
  if (!id.success) throw new ApiError("invalid-argument", "invalid approval id");
  return id.data;
}

/** 응답 시간이 지난 pending 을 지금 expired 로 바꾸고 최신 상태를 돌려준다 (expire-fn 보다 먼저 읽은 경우). */
export async function settle(
  approvals: ApprovalStore,
  record: ApprovalRecord,
  nowIso: string,
): Promise<ApprovalRecord> {
  if (effectiveStatus(record, nowIso) !== "expired" || record.status !== "pending") return record;
  await approvals.transition(record, "expired", { updatedAt: nowIso }, "expired", nowIso);
  return (await approvals.get(record.id)) ?? record;
}

/** expire-fn: 만료 시각이 지난 pending 을 expired 로 (한 번에 최대 250개) */
export async function expireDue(approvals: ApprovalStore, now: Date, log: Logger): Promise<number> {
  const nowIso = now.toISOString();
  let expired = 0;
  for (let round = 0; round < 5; round++) {
    const ids = await approvals.listExpiredPending(nowIso, 50);
    for (const id of ids) {
      const record = await approvals.get(id);
      if (record === undefined) continue;
      if (await approvals.transition(record, "expired", { updatedAt: nowIso }, "expired", nowIso)) {
        expired++;
      }
    }
    if (ids.length < 50) break;
  }
  if (expired > 0) log.info("approvals expired", { expired });
  return expired;
}

/**
 * 연결 해제(#12·#15) 때: 그 보호자를 pending 승인에서 빼고, 남은 보호자가 없으면 취소한다 (고령자 앱 요청 3.3).
 * 그 보호자의 그 어르신 승인 항목은 모두 지운다 (보호자 앱 요청).
 */
export async function handleApprovalUnlink(
  approvals: ApprovalStore,
  elderId: string,
  guardianId: string,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  for (const record of await approvals.listPendingForElder(elderId)) {
    if (!record.guardianIds.includes(guardianId)) continue;
    const remaining = await approvals.removeGuardian(record, guardianId);
    if (remaining !== undefined && remaining.length === 0) {
      await approvals.transition(
        { ...record, guardianIds: [] },
        "cancelled",
        { updatedAt: nowIso },
        "pending",
        nowIso,
      );
    }
  }
  await approvals.deleteForGuardianAndElder(guardianId, elderId);
}

export function createApprovalRoutes(deps: ApprovalDeps): Route[] {
  const { store, approvals } = deps;
  const now = deps.now ?? (() => new Date());
  const profiles = deps.profiles ?? createProfileGuard(store, () => now().getTime());
  const withKey = (handler: Route["handler"]) => idempotent(deps.idempotency, handler, now);

  async function ownedByElder(id: string, elderId: string): Promise<ApprovalRecord> {
    const record = await approvals.get(id);
    if (record?.elderId !== elderId) throw new ApiError("not-found", "Approval not found");
    return settle(approvals, record, now().toISOString());
  }

  return [
    // #9 승인 요청. 같은 action 이 아직 대기 중이면 새로 만들지 않고 그 요청을 돌려준다.
    {
      method: "POST",
      path: "/v1/elder/approvals",
      handler: withKey(async ({ event }) => {
        const me = await profiles.require(event, "elder");
        const input = parseJsonBody(event, createApprovalSchema);
        const links = await store.listLinksByElder(me.uid);
        if (links.length === 0) return json(200, { result: "no_guardians" });

        const existing = async () => {
          const lockedId = await approvals.lockedApprovalId(me.uid, input.action);
          if (lockedId === undefined) return undefined;
          const record = await approvals.get(lockedId);
          if (record === undefined) return undefined;
          const settled = await settle(approvals, record, now().toISOString());
          return settled.status === "pending" ? settled : undefined;
        };
        const reuse = (record: ApprovalRecord) =>
          json(200, { result: "existing", approvalId: record.id, expiresAt: record.expiresAt });

        const pending = await existing();
        if (pending) return reuse(pending);

        const at = now();
        const iso = at.toISOString();
        const record: ApprovalRecord = {
          id: newApprovalId(at),
          elderId: me.uid,
          elderName: me.name,
          guardianIds: links.map((link) => link.guardianId),
          packageName: input.packageName,
          appName: maskText(input.appName).text,
          action: input.action,
          ...(input.category === undefined ? {} : { category: input.category }),
          status: "pending",
          createdAt: iso,
          expiresAt: new Date(at.getTime() + APPROVAL_TTL_MS).toISOString(),
          updatedAt: iso,
        };
        const { guardianIds, ...summary } = record;
        const items: GuardianApproval[] = guardianIds.map((guardianId, i) => ({
          ...summary,
          guardianId,
          elderLabel: links[i]?.elderLabel ?? "",
        }));
        if ((await approvals.create(record, items, iso)) === "locked") {
          const raced = await existing();
          if (raced) return reuse(raced);
          throw new ApiError("unavailable", "Please retry");
        }
        return json(201, { result: "created", approvalId: record.id, expiresAt: record.expiresAt });
      }),
    },

    // #10 취소: [기다리지 않기], 대기 중 새 명령, [그만하기]. 대기 중이 아니면 409 (앱은 무시).
    {
      method: "POST",
      path: "/v1/elder/approvals/{id}/cancel",
      handler: async ({ event, params }) => {
        const me = await profiles.require(event, "elder");
        const record = await ownedByElder(parseId(params), me.uid);
        if (record.status !== "pending") throw finishedError(record.status);
        const iso = now().toISOString();
        if (!(await approvals.transition(record, "cancelled", { updatedAt: iso }, "active", iso))) {
          const latest = await ownedByElder(record.id, me.uid);
          throw finishedError(latest.status);
        }
        const updated = (await approvals.get(record.id)) ?? record;
        return json(200, elderApprovalView(updated, iso));
      },
    },

    // #19 상태 조회 (고령자). FCM 이 빠질 때 대기 중 3초 간격으로 부른다.
    {
      method: "GET",
      path: "/v1/elder/approvals/{id}",
      handler: async ({ event, params }) => {
        const me = await profiles.require(event, "elder");
        const record = await ownedByElder(parseId(params), me.uid);
        return json(200, elderApprovalView(record, now().toISOString()));
      },
    },

    // #13 승인·거절. 대기 중이고 만료 전이며, 지금도 연결된 보호자만. 첫 유효 응답만 반영.
    {
      method: "POST",
      path: "/v1/guardian/approvals/{id}/respond",
      handler: withKey(async ({ event, params }) => {
        const me = await profiles.require(event, "guardian");
        const id = parseId(params);
        const { decision } = parseJsonBody(event, respondSchema);
        const found = await approvals.get(id);
        if (found === undefined || !found.guardianIds.includes(me.uid)) {
          throw new ApiError("not-found", "Approval not found");
        }
        const link = (await store.listLinksByElder(found.elderId)).find(
          (l) => l.guardianId === me.uid,
        );
        if (link === undefined) throw new ApiError("not-found", "Approval not found");

        const iso = now().toISOString();
        const record = await settle(approvals, found, iso);
        if (record.status !== "pending") throw finishedError(record.status);

        const label = link.guardianLabel !== "" ? link.guardianLabel : link.guardianName;
        const ok = await approvals.transition(
          record,
          decision,
          {
            updatedAt: iso,
            respondedAt: iso,
            respondedBy: me.uid,
            ...(label === "" ? {} : { respondedByLabel: label }),
          },
          "active",
          iso,
        );
        if (!ok) {
          const latest = await settle(approvals, (await approvals.get(id)) ?? record, iso);
          throw finishedError(latest.status);
        }
        const item = await approvals.getForGuardian(me.uid, id);
        if (item === undefined) throw new ApiError("not-found", "Approval not found");
        return json(200, guardianApprovalView(item, iso));
      }),
    },

    // #23 보호자 승인 목록: status=pending(응답이 필요한 요청) 또는 all(지난 요청 포함, 기본)
    {
      method: "GET",
      path: "/v1/guardian/approvals",
      handler: async ({ event }) => {
        const me = await profiles.require(event, "guardian");
        const query = parseQuery(event, guardianListQuerySchema);
        const iso = now().toISOString();
        const page = await approvals.listForGuardian(me.uid, {
          pendingOnly: query.status === "pending",
          now: iso,
          cursor: query.cursor,
          since: query.since,
          limit: query.limit,
        });
        return json(200, {
          items: page.items.map((item) => guardianApprovalView(item, iso)),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          serverTime: iso,
        });
      },
    },

    // #24 보호자 승인 상세 (남은 시간 표시)
    {
      method: "GET",
      path: "/v1/guardian/approvals/{id}",
      handler: async ({ event, params }) => {
        const me = await profiles.require(event, "guardian");
        const item = await approvals.getForGuardian(me.uid, parseId(params));
        if (item === undefined) throw new ApiError("not-found", "Approval not found");
        return json(200, guardianApprovalView(item, now().toISOString()));
      },
    },
  ];
}
