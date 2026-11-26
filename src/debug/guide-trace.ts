/**
 * guide 요청을 디버그 뷰어에 남긴다 (dev 전용, docs/server-plan.md 12장).
 *
 * 화면 하나 = 디버그 저장소의 화면 문서 하나. 여기에 guide 필드로
 *   - request : 앱이 보낸 목표·한 말·slots·history
 *   - ai      : AI 에 보낸 입력 그대로, 모델의 원래 출력, 상태·지연·토큰
 *   - response: 서버가 검증해 앱에 보낸 최종 응답
 * 을 붙인다. 뷰어의 기존 화면 패널이 target 을 화면 위에 표시한다.
 *
 * 저장은 응답에 영향을 주지 않는다: 실패하면 로그만 남긴다.
 */
import { randomBytes } from "node:crypto";
import type { GuideRequest, GuideResponse } from "../ai/guide-schema.js";
import type { GuideTrace } from "../ai/guide.js";
import { FINGERPRINT_VERSION, fingerprint } from "../cache/fingerprint.js";
import type { MatchResult } from "../cache/match.js";
import type { Screen } from "./schema.js";
import { maskDeep } from "../shared/sensitive.js";
import { createPageMatcher, type PreparedMatch } from "./pages.js";
import { newScreenId, type DebugStore } from "./store.js";

export interface GuideTraceRecord {
  uid: string;
  request: GuideRequest;
  response: GuideResponse;
  trace: GuideTrace;
  model: string;
  receivedAt: Date;
  /** 앱이 보낸 디버그 기기 ID. 없으면 같은 uid 의 최근 기기, 그것도 없으면 uid 기반 가상 기기 */
  deviceId?: string | undefined;
}

export interface GuideTraceRecorder {
  /** 저장한 화면과 화면 매칭 결과 (매칭에 실패하면 match 없음) */
  record(
    entry: GuideTraceRecord,
  ): Promise<{ deviceId: string; screenId: string; match?: MatchResult }>;
  /** 끝 신호의 마지막 화면 (명령 검토에 씀). guide 응답 없이 화면만 */
  recordFinal(entry: {
    uid: string;
    screen: Screen;
    receivedAt: Date;
    deviceId?: string | undefined;
    commandId: number;
    result: string;
  }): Promise<{ deviceId: string; screenId: string; match?: MatchResult }>;
}

/** deviceIdSchema 규칙(8~64자 [A-Za-z0-9_-])에 맞는 uid 기반 기기 ID */
export const uidDeviceId = (uid: string): string =>
  `uid-${uid.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60)}`.padEnd(8, "0");

/**
 * 기록을 붙일 디버그 기기: 앱이 보낸 ID → 같은 uid 의 최근 실제 기기 → uid 기반 가상 기기.
 * (heartbeat 로 등록된 실제 기기만 고른다. 가상 기기는 실제 기기가 없을 때만 쓴다)
 */
export async function resolveDebugDevice(
  store: DebugStore,
  uid: string,
  deviceId?: string,
): Promise<string> {
  if (deviceId) return deviceId;
  const virtual = uidDeviceId(uid);
  const mine = (await store.listDevices())
    .filter((device) => device.uid === uid && device.deviceId !== virtual)
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  return mine[0]?.deviceId ?? virtual;
}

export function createGuideTraceRecorder(
  store: DebugStore,
  matcher = createPageMatcher(store),
): GuideTraceRecorder {
  const resolveDevice = (uid: string, deviceId?: string) =>
    resolveDebugDevice(store, uid, deviceId);

  return {
    async recordFinal({ uid, screen: raw, receivedAt, deviceId, commandId, result }) {
      const device = await resolveDevice(uid, deviceId);
      const masked = maskDeep(raw.nodes);
      const screen = { ...raw, nodes: masked.value };
      const screenId = newScreenId(receivedAt, randomBytes(3).toString("hex"));
      const fp = fingerprint(screen);
      const prepared = await matcher
        .prepare({
          pkg: screen.pkg,
          fingerprint: fp,
          nodes: screen.nodes,
          deviceId: device,
          screenId,
          at: receivedAt.toISOString(),
        })
        .catch(() => undefined);
      const saved = await store.saveScreen({
        uid,
        dedupeKey: `end|${screenId}`,
        screenId,
        deviceId: device,
        receivedAt: receivedAt.toISOString(),
        capturedAt: receivedAt.toISOString(),
        pkg: screen.pkg,
        ...(screen.hash === undefined ? {} : { appHash: screen.hash }),
        fingerprint: fp,
        fpVersion: FINGERPRINT_VERSION,
        nodeCount: screen.nodes.length,
        maskedCount: masked.count,
        pinned: false,
        guideType: "end",
        ...(prepared ? { match: prepared.match } : {}),
        screen,
        guide: { type: "end", say: "", end: { commandId, result } },
      });
      if (saved && prepared) await prepared.commit().catch(() => undefined);
      return { deviceId: device, screenId, ...(prepared ? { match: prepared.match } : {}) };
    },

    async record({ uid, request, response: sent, trace, model, receivedAt, deviceId }) {
      const device = await resolveDevice(uid, deviceId);
      // 앱에 보낸 응답에는 어르신이 말한 번호가 되돌려져 있을 수 있다 (typeText). 저장할 때는 가린다
      const response = maskDeep(sent).value;
      const masked = maskDeep(request.screen.nodes);
      const screen = { ...request.screen, nodes: masked.value };
      const screenId = newScreenId(receivedAt, randomBytes(3).toString("hex"));
      const history = maskDeep({
        utterance: request.utterance,
        slots: request.slots,
        history: request.history,
      }).value;

      const fp = fingerprint(screen);
      // 이 guide 요청 화면이 이미 본 어느 페이지인지 (시험). 실패해도 기록은 남긴다
      const prepared: PreparedMatch | undefined = await matcher
        .prepare({
          pkg: screen.pkg,
          fingerprint: fp,
          nodes: screen.nodes,
          deviceId: device,
          screenId,
          at: receivedAt.toISOString(),
        })
        .catch(() => undefined);

      const saved = await store.saveScreen({
        uid,
        // guide 요청은 화면이 같아도 매번 남긴다 (요청마다 판단이 다를 수 있음)
        dedupeKey: `guide|${screenId}`,
        screenId,
        deviceId: device,
        receivedAt: receivedAt.toISOString(),
        capturedAt: receivedAt.toISOString(),
        pkg: screen.pkg,
        ...(screen.hash === undefined ? {} : { appHash: screen.hash }),
        fingerprint: fp,
        fpVersion: FINGERPRINT_VERSION,
        nodeCount: screen.nodes.length,
        maskedCount: masked.count,
        pinned: false,
        guideType: response.type,
        ...(prepared ? { match: prepared.match } : {}),
        screen,
        guide: {
          // 뷰어 화면 패널이 바로 읽는 요약
          type: response.type,
          say: response.say,
          ...(response.target === undefined ? {} : { target: response.target }),
          ...(trace.latencyMs === undefined ? {} : { latencyMs: trace.latencyMs }),
          request: { requestId: request.requestId, goal: request.goal, ...history },
          ai: { model, ...trace },
          response,
        },
      });
      if (saved && prepared) await prepared.commit().catch(() => undefined);
      return { deviceId: device, screenId, ...(prepared ? { match: prepared.match } : {}) };
    },
  };
}
