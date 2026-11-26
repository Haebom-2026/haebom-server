/**
 * S1 사용자·기기·연결 API (docs/server-plan.md 4.2).
 *   공통   : POST·PATCH /v1/users/me (#2·#3), PUT·DELETE /v1/devices/{deviceId} (#4·#5)
 *   고령자 : POST /v1/elder/connect-codes (#11), DELETE /v1/elder/links/{guardianId} (#12), GET /v1/elder/links (#18)
 *   보호자 : POST /v1/guardian/links (#14), DELETE /v1/guardian/links/{elderId} (#15), GET /v1/guardian/links (#20)
 * 연결이 생기거나 지워지면 push-fn 이 Streams 로 받아 양쪽 기기에 FCM data 를 보낸다 (push/link-events.ts).
 */
import { randomInt } from "node:crypto";
import { requireAuth } from "../shared/auth.js";
import { ApiError } from "../shared/errors.js";
import { json, type HttpResult } from "../shared/http.js";
import { idempotent, type IdempotencyStore } from "../shared/idempotency.js";
import type { Route } from "../shared/router.js";
import { parseJsonBody } from "../shared/validate.js";
import {
  CODE_TTL_MS,
  GLOBAL_CODE_FAILURES,
  GUARDIAN_CODE_FAILURES,
  createUserSchema,
  deviceIdSchema,
  elderView,
  guardianView,
  linkByCodeSchema,
  profileView,
  putDeviceSchema,
  updateLinkLabelsSchema,
  updateUserSchema,
  type LinkRecord,
  type UserProfile,
} from "./model.js";
import { createProfileGuard } from "./profile.js";
import type { CoreStore } from "./store.js";

export interface CoreDeps {
  store: CoreStore;
  idempotency: IdempotencyStore;
  now?: () => Date;
  /** 테스트에서 번호를 고정할 때 */
  randomCode?: () => string;
  /** 연결이 지워진 뒤 정리 (S2: 보호자 알림함에서 그 어르신 알림 삭제) */
  onUnlink?: (elderId: string, guardianId: string) => Promise<void>;
}

const noContent = (): HttpResult => ({ statusCode: 204 });
const uidPattern = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_CODE_ATTEMPTS = 5;

function pathParam(params: Readonly<Record<string, string>>, name: string): string {
  const value = params[name];
  if (value === undefined || !uidPattern.test(value)) {
    throw new ApiError("invalid-argument", `invalid ${name}`);
  }
  return value;
}

const defaultRandomCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** 바꾸려는 호칭만 (undefined 는 빼서 저장 쪽에 넘긴다) */
function definedLabels(labels: {
  elderLabel?: string | undefined;
  guardianLabel?: string | undefined;
}) {
  return {
    ...(labels.elderLabel === undefined ? {} : { elderLabel: labels.elderLabel }),
    ...(labels.guardianLabel === undefined ? {} : { guardianLabel: labels.guardianLabel }),
  };
}

export function createCoreRoutes(deps: CoreDeps): Route[] {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const randomCode = deps.randomCode ?? defaultRandomCode;
  const guard = createProfileGuard(store, () => now().getTime());
  const withKey = (handler: Route["handler"]) => idempotent(deps.idempotency, handler, now);

  return [
    // #2 처음 1회 역할·이름 등록. 같은 role 로 다시 부르면 기존 프로필을 돌려준다.
    {
      method: "POST",
      path: "/v1/users/me",
      handler: async ({ event }) => {
        const { uid } = requireAuth(event);
        const input = parseJsonBody(event, createUserSchema);
        const at = now().toISOString();
        const user: UserProfile = {
          uid,
          role: input.role,
          name: input.name,
          createdAt: at,
          updatedAt: at,
        };
        if (await store.createUser(user)) {
          guard.remember(user);
          return json(201, profileView(user));
        }
        const existing = await store.getUser(uid);
        if (existing === undefined) throw new ApiError("unavailable", "Please retry");
        if (existing.role !== input.role) {
          throw new ApiError("conflict", `Already registered as role=${existing.role}`);
        }
        guard.remember(existing);
        return json(200, profileView(existing));
      },
    },

    // #3 이름 변경. 연결 항목에 복사된 이름도 함께 바꾼다.
    {
      method: "PATCH",
      path: "/v1/users/me",
      handler: async ({ event }) => {
        const me = await guard.require(event);
        const { name } = parseJsonBody(event, updateUserSchema);
        const updated = await store.updateUserName(me.uid, name, now().toISOString());
        if (updated === undefined) throw new ApiError("profile-required", "Profile not found");
        guard.remember(updated);
        if (me.role === "elder") {
          await store.setLinkNames(await store.listLinksByElder(me.uid), { elderName: name });
        } else {
          await store.setLinkNames(await store.listLinksByGuardian(me.uid), { guardianName: name });
        }
        return json(200, profileView(updated));
      },
    },

    // #4 FCM 등록 토큰 등록·갱신
    {
      method: "PUT",
      path: "/v1/devices/{deviceId}",
      handler: async ({ event, params }) => {
        const me = await guard.require(event);
        const deviceId = deviceIdSchema.safeParse(params.deviceId);
        if (!deviceId.success) throw new ApiError("invalid-argument", "invalid deviceId");
        const input = parseJsonBody(event, putDeviceSchema);
        await store.putDevice({
          uid: me.uid,
          deviceId: deviceId.data,
          fcmToken: input.fcmToken,
          platform: input.platform,
          updatedAt: now().toISOString(),
        });
        return noContent();
      },
    },

    // #5 푸시 토큰 해제 (없어도 204)
    {
      method: "DELETE",
      path: "/v1/devices/{deviceId}",
      handler: async ({ event, params }) => {
        const me = await guard.require(event);
        const deviceId = deviceIdSchema.safeParse(params.deviceId);
        if (!deviceId.success) throw new ApiError("invalid-argument", "invalid deviceId");
        await store.deleteDevice(me.uid, deviceId.data);
        return noContent();
      },
    },

    // #11 연결 코드 발급: 6자리, 10분, 일회용, 새로 받으면 이전 코드 무효
    {
      method: "POST",
      path: "/v1/elder/connect-codes",
      handler: withKey(async ({ event, log }) => {
        const me = await guard.require(event, "elder");
        const issuedAt = now();
        const expiresAt = new Date(issuedAt.getTime() + CODE_TTL_MS).toISOString();
        for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
          const code = randomCode();
          const issued = await store.issueCode(
            { code, elderId: me.uid, createdAt: issuedAt.toISOString(), expiresAt, used: false },
            issuedAt.toISOString(),
          );
          if (issued) return json(201, { code, expiresAt });
          log.warn("connect code collision", { attempt });
        }
        throw new ApiError("unavailable", "Could not issue a connect code, please retry");
      }),
    },

    // #14 코드 + 호칭으로 연결
    {
      method: "POST",
      path: "/v1/guardian/links",
      handler: withKey(async ({ event }) => {
        const me = await guard.require(event, "guardian");
        const input = parseJsonBody(event, linkByCodeSchema);
        const at = now();
        const iso = at.toISOString();

        const failures = await store.codeFailures(me.uid, at);
        if (
          failures.guardian >= GUARDIAN_CODE_FAILURES ||
          failures.global >= GLOBAL_CODE_FAILURES
        ) {
          throw new ApiError("too-many-attempts", "Too many wrong codes, try again later");
        }
        const fail = async (error: ApiError): Promise<never> => {
          await store.recordCodeFailure(me.uid, at);
          throw error;
        };

        const code = await store.getCode(input.code);
        if (code === undefined) return fail(new ApiError("invalid-code", "Connect code not found"));
        if (code.used || !code.active)
          return fail(new ApiError("code-used", "Connect code is no longer valid"));
        if (code.expiresAt <= iso)
          return fail(new ApiError("code-expired", "Connect code has expired"));
        if (code.elderId === me.uid)
          throw new ApiError("invalid-argument", "Cannot link to yourself");

        const elder = await store.getUser(code.elderId);
        if (elder?.role !== "elder")
          return fail(new ApiError("invalid-code", "Connect code not found"));

        const link: LinkRecord = {
          elderId: elder.uid,
          guardianId: me.uid,
          elderName: elder.name,
          guardianName: me.name,
          elderLabel: input.elderLabel,
          guardianLabel: input.guardianLabel,
          connectedAt: iso,
        };
        const result = await store.redeemCode(input.code, link, iso);
        if (result === "already-linked")
          throw new ApiError("already-linked", "Already linked to this elder");
        if (result === "code-unavailable") {
          return fail(new ApiError("code-used", "Connect code is no longer valid"));
        }
        return json(201, guardianView(link));
      }),
    },

    // #12 고령자 쪽 해제
    {
      method: "DELETE",
      path: "/v1/elder/links/{guardianId}",
      handler: async ({ event, params }) => {
        const me = await guard.require(event, "elder");
        const guardianId = pathParam(params, "guardianId");
        if (!(await store.deleteLink(me.uid, guardianId)))
          throw new ApiError("not-found", "Link not found");
        // TODO(S3): 남은 보호자가 없는 pending 승인 취소
        await deps.onUnlink?.(me.uid, guardianId);
        return noContent();
      },
    },

    // #15 보호자 쪽 해제
    {
      method: "DELETE",
      path: "/v1/guardian/links/{elderId}",
      handler: async ({ event, params }) => {
        const me = await guard.require(event, "guardian");
        const elderId = pathParam(params, "elderId");
        if (!(await store.deleteLink(elderId, me.uid)))
          throw new ApiError("not-found", "Link not found");
        await deps.onUnlink?.(elderId, me.uid);
        return noContent();
      },
    },

    // 고령자 쪽 호칭 변경 (보호자 호칭 "큰딸" 등). 응답은 #18 항목 모양
    {
      method: "PATCH",
      path: "/v1/elder/links/{guardianId}",
      handler: async ({ event, params }) => {
        const me = await guard.require(event, "elder");
        const guardianId = pathParam(params, "guardianId");
        const labels = parseJsonBody(event, updateLinkLabelsSchema);
        const link = (await store.listLinksByElder(me.uid)).find(
          (l) => l.guardianId === guardianId,
        );
        if (link === undefined) throw new ApiError("not-found", "Link not found");
        const changed = definedLabels(labels);
        await store.setLinkNames([link], changed);
        return json(200, elderView({ ...link, ...changed }));
      },
    },

    // 보호자 쪽 호칭 변경 (어르신 호칭 "어머니" 등). 응답은 #20 항목 모양
    {
      method: "PATCH",
      path: "/v1/guardian/links/{elderId}",
      handler: async ({ event, params }) => {
        const me = await guard.require(event, "guardian");
        const elderId = pathParam(params, "elderId");
        const labels = parseJsonBody(event, updateLinkLabelsSchema);
        const link = (await store.listLinksByGuardian(me.uid)).find((l) => l.elderId === elderId);
        if (link === undefined) throw new ApiError("not-found", "Link not found");
        const changed = definedLabels(labels);
        await store.setLinkNames([link], changed);
        return json(200, guardianView({ ...link, ...changed }));
      },
    },

    // #18 고령자의 연결된 보호자 목록
    {
      method: "GET",
      path: "/v1/elder/links",
      handler: async ({ event }) => {
        const me = await guard.require(event, "elder");
        const links = await store.listLinksByElder(me.uid);
        links.sort((a, b) => a.connectedAt.localeCompare(b.connectedAt));
        return json(200, { links: links.map(elderView) });
      },
    },

    // #20 보호자의 연결된 어르신 목록
    {
      method: "GET",
      path: "/v1/guardian/links",
      handler: async ({ event }) => {
        const me = await guard.require(event, "guardian");
        const links = await store.listLinksByGuardian(me.uid);
        links.sort((a, b) => a.connectedAt.localeCompare(b.connectedAt));
        return json(200, { links: links.map(guardianView) });
      },
    },
  ];
}
