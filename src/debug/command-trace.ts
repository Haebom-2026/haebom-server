/**
 * classify·앱 선택을 디버그 뷰어에 남긴다 (dev 전용, docs/jev-routing-plan.md 9.1 "명령" 화면).
 *
 * 기록 하나 = 디버그 저장소의 명령 기록 하나. 화면과 같은 기기 시간 순 목록에 끼워 넣어
 * 뷰어의 실시간 폴링으로 같이 따라온다. 목록에는 요약(CommandBrief), 원본(detail)에는
 *   - classify: 가린 말·규칙 단계, 안전 분류 출력, jev 결과와 판정 과정(trace), 앱에 보낸 응답
 *   - choose  : 앱이 보낸 고른 앱·질문 답, 응답
 * 과 지도 이름표(앱·역할·목표 id → 이름)를 붙인다.
 *
 * 저장은 응답에 영향을 주지 않는다: 부르는 쪽이 실패를 로그로만 남긴다.
 */
import { randomBytes } from "node:crypto";
import type { ChooseAppRequest } from "../ai/classify-schema.js";
import type { ChooseAppResponse, ClassifyDetail } from "../ai/classify.js";
import type { IndexedMap } from "../route/map.js";
import { traceOf } from "../route/trace.js";
import { resolveDebugDevice } from "./guide-trace.js";
import { newScreenId, type CommandBrief, type DebugStore } from "./store.js";

export interface MapNames {
  version: string;
  apps: Record<string, string>;
  roles: Record<string, string>;
  goals: Record<string, string>;
}

export interface CommandTraceRecorder {
  classify(entry: {
    uid: string;
    receivedAt: Date;
    detail: ClassifyDetail;
  }): Promise<{ deviceId: string; screenId: string }>;
  choose(entry: {
    uid: string;
    receivedAt: Date;
    commandId: number;
    body: ChooseAppRequest;
    response: ChooseAppResponse;
  }): Promise<{ deviceId: string; screenId: string }>;
}

export function mapNames(m: IndexedMap): MapNames {
  return {
    version: m.map.version,
    apps: Object.fromEntries(m.map.apps.map((a) => [a.id, a.name])),
    roles: Object.fromEntries(m.map.roles.map((r) => [r.id, r.name])),
    goals: Object.fromEntries(m.map.goals.map((g) => [g.id, g.name])),
  };
}

/** @param map jev 가 쓰는 지도 (없으면 이름표 없이 id 로 보임) */
export function createCommandTraceRecorder(
  store: DebugStore,
  map?: IndexedMap,
): CommandTraceRecorder {
  const names = map ? mapNames(map) : undefined;

  const save = async (
    uid: string,
    receivedAt: Date,
    command: CommandBrief,
    detail: unknown,
  ): Promise<{ deviceId: string; screenId: string }> => {
    const deviceId = await resolveDebugDevice(store, uid);
    const screenId = newScreenId(receivedAt, randomBytes(3).toString("hex"));
    const at = receivedAt.toISOString();
    await store.saveEntry({
      uid,
      entry: "command",
      command,
      detail,
      screenId,
      deviceId,
      receivedAt: at,
      capturedAt: at,
      // 화면이 아니므로 화면 필드는 빈 값
      pkg: "",
      fingerprint: "",
      fpVersion: "",
      nodeCount: 0,
      maskedCount: 0,
      pinned: false,
    });
    return { deviceId, screenId };
  };

  return {
    classify({ uid, receivedAt, detail }) {
      const { selection, response } = detail;
      const trace = traceOf(selection);
      // trace 는 selection 에서 떼어 따로 둔다 (뷰어가 고르기 탭과 같은 모양으로 읽음)
      const plain: unknown = selection
        ? JSON.parse(JSON.stringify({ ...selection, trace: undefined }))
        : undefined;
      const candidates =
        selection?.kind === "route" ? selection.candidates.map((c) => c.name) : undefined;
      const goal =
        selection?.kind === "route"
          ? (selection.candidates.find((c) => c.goal)?.goal?.name ??
            (selection.candidates.some((c) => c.clarify) ? "?" : undefined))
          : undefined;
      const brief: CommandBrief = {
        kind: "classify",
        commandId: response.commandId,
        utterance: detail.request.utterance.slice(0, 60),
        level: response.sensitivity.level,
        category: response.sensitivity.category,
        ...(response.degraded ? { degraded: true } : {}),
        route: selection?.kind ?? "off",
        ...(selection?.kind === "fail" ? { routeReason: selection.reason } : {}),
        ...(candidates ? { candidates } : {}),
        ...(goal ? { goal } : {}),
      };
      return save(uid, receivedAt, brief, {
        kind: "classify",
        ...detail,
        selection: plain,
        trace,
        names,
      });
    },

    choose({ uid, receivedAt, commandId, body, response }) {
      const brief: CommandBrief = {
        kind: "choose",
        commandId,
        level: response.sensitivity.level,
        ...(response.appId ? { appId: response.appId } : {}),
        ...(response.appId && names?.apps[response.appId]
          ? { appName: names.apps[response.appId] }
          : {}),
        ...(response.goal ? { goal: response.goal.name } : {}),
        ...(response.route
          ? { route: "route", candidates: response.route.candidates.map((c) => c.name) }
          : {}),
      };
      return save(uid, receivedAt, brief, { kind: "choose", body, response, names });
    },
  };
}
