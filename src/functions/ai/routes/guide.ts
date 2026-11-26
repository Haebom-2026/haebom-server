import { randomBytes } from "node:crypto";
import { guide, type GuideModel, type GuideTrace } from "../../../ai/guide.js";
import {
  guideRequestSchema,
  type GuideRequest,
  type GuideResponse,
} from "../../../ai/guide-schema.js";
import type { ProfileGuard } from "../../../core/profile.js";
import type { GuideTraceRecorder } from "../../../debug/guide-trace.js";
import { mapFingerprint } from "../../../map/fingerprint.js";
import { decideMapStep, MAP_PROMPT_VERSION } from "../../../map/guide.js";
import type { MapLearnStore } from "../../../map/learn.js";
import type { MapStore } from "../../../map/store.js";
import type { CommandLog } from "../../../route/command-log.js";
import type { CommandStore } from "../../../route/command-store.js";
import type { IndexedMap } from "../../../route/map.js";
import type { Logger } from "../../../shared/logger.js";
import { maskDeep, maskText } from "../../../shared/sensitive.js";
import { json } from "../../../shared/http.js";
import type { RouteHandler } from "../../../shared/router.js";
import { parseJsonBody } from "../../../shared/validate.js";

export interface GuideRouteOptions {
  /** dev 에서만: 요청·AI 입력·판단을 디버그 뷰어에 남긴다 */
  recorder?: GuideTraceRecorder | undefined;
  /** 기록에 남길 모델 이름 */
  modelName?: string | undefined;
  /** dev 에서만: commandId 가 오면 명령 단계를 남긴다 (지도 학습 재료, R3) */
  commandLog?: CommandLog | undefined;
  /** dev 에서만 (MAP_GUIDE_ENABLED): 검증된 지도 길이 있으면 Claude 없이 안내 (R4) */
  mapGuide?: MapGuideDeps | undefined;
  now?: () => Date;
}

export interface MapGuideDeps {
  commands: CommandStore;
  maps: MapStore;
  routeMap: IndexedMap;
  /** (R5) 지도 안내 결과(앞 연결선·끝 단계가 맞았나)를 세어 실패가 쌓이면 내림 */
  learn?: MapLearnStore | undefined;
}

/**
 * #16 POST /v1/elder/guide.
 * role=elder 만 (프로필 없으면 403 profile-required). 입력이 잘못되면 400,
 * 그 밖의 실패는 200 + { type: "say" }.
 * 호출 한도는 시연 단계라 두지 않는다 (docs/api/s5-guide.md 6장).
 */
export const createGuideRoute =
  (model: GuideModel, profiles: ProfileGuard, options: GuideRouteOptions = {}): RouteHandler =>
  async ({ event, log }) => {
    const receivedAt = (options.now ?? (() => new Date()))();
    const me = await profiles.require(event, "elder");
    const request = parseJsonBody(event, guideRequestSchema);
    const requestLog = log.child({ uid: me.uid, requestId: request.requestId });

    let trace: GuideTrace | undefined;
    let response: SentResponse;
    const mapped =
      options.mapGuide && request.commandId !== undefined
        ? await tryMap(options.mapGuide, me.uid, request.commandId, request, requestLog)
        : undefined;
    const source = mapped?.response ? "map" : "ai";
    if (mapped?.response) {
      response = mapped.response;
      trace = { promptVersion: MAP_PROMPT_VERSION, skipped: "map", map: mapped.info, latencyMs: 0 };
    } else {
      const answer = await guide(request, model, requestLog, (t) => {
        trace = t;
      });
      // 어르신이 이 안내를 따르면 앱이 다음 요청의 lastAction.stepId 로 돌려준다
      response = { ...answer, stepId: newStepId() };
      if (trace && mapped) trace.map = mapped.info;
    }

    if (options.recorder && trace) {
      try {
        const saved = await options.recorder.record({
          uid: me.uid,
          request,
          response,
          trace,
          model: options.modelName ?? "",
          receivedAt,
          deviceId: request.deviceId,
        });
        requestLog.debug("guide trace saved", saved);
        if (options.commandLog && request.commandId !== undefined) {
          const action = request.lastAction;
          await options.commandLog.appendStep({
            uid: me.uid,
            commandId: request.commandId,
            stepId: response.stepId,
            receivedAt: receivedAt.toISOString(),
            screen: { deviceId: saved.deviceId, screenId: saved.screenId },
            ...(saved.match
              ? {
                  page: {
                    kind: saved.match.kind,
                    ...(saved.match.pageId === undefined ? {} : { pageId: saved.match.pageId }),
                  },
                }
              : {}),
            pkg: request.screen.pkg,
            guide: {
              type: response.type,
              ...(response.targetText === undefined
                ? {}
                : { targetText: maskText(response.targetText).text }),
              ...(response.dir === undefined ? {} : { dir: response.dir }),
              ...(response.status === undefined ? {} : { status: response.status }),
              source,
            },
            ...(action
              ? {
                  lastAction: {
                    ...(action.stepId === undefined ? {} : { stepId: action.stepId }),
                    seq: action.seq,
                    action: action.action,
                    // 글자 넣기는 넣은 값을 남기지 않는다 (인증번호·PIN 일 수 있음)
                    text: action.action === "type" ? "" : maskText(action.text).text,
                  },
                }
              : {}),
          });
        }
      } catch (error) {
        // 디버그 기록 실패는 응답에 영향을 주지 않는다
        requestLog.warn("guide trace save failed", { error });
      }
    }
    return json(200, options.mapGuide ? { ...response, source } : response);
  };

type SentResponse = GuideResponse & { stepId: string };

interface MapAttempt {
  /** 지도로 안내할 때만 */
  response?: SentResponse;
  info: NonNullable<GuideTrace["map"]>;
}

/**
 * 지도 안내 시도 (docs/jev-routing-plan.md 5장). 실패·불확실은 모두 Claude 로 (지도 오류가 안내를 막지 않게).
 * 진행 상태는 명령 기록에 gen·rev 조건으로 쓴다. 겹친 요청이 이기지 못하면 Claude 로.
 */
async function tryMap(
  deps: MapGuideDeps,
  uid: string,
  commandId: number,
  request: GuideRequest,
  log: Logger,
): Promise<MapAttempt | undefined> {
  let readGen: string | undefined;
  try {
    const command = await deps.commands.get(uid, commandId);
    if (!command) return undefined;
    readGen = command.gen;
    const maskedNodes = maskDeep(request.screen.nodes).value;
    const fp = mapFingerprint({ ...request.screen, nodes: maskedNodes });
    const snapshot = await deps.maps.snapshot();
    const decision = decideMapStep({
      request,
      maskedNodes,
      fp,
      command,
      snapshot,
      routeMap: deps.routeMap,
    });
    const read = { gen: command.gen, rev: command.rev };
    // 앞 안내의 결과는 진행 상태를 바꾸는 쓰기가 성공한 요청만 센다 (재시도·겹친 요청이 두 번 세지 않게)
    const countResult = async () => {
      if (!decision.result || !deps.learn) return;
      const { ok, ...target } = decision.result;
      try {
        const out = await deps.learn.recordResult(target, ok, new Date());
        log.info("map result", { ...decision.result, out });
      } catch (error) {
        log.warn("map result failed", { error });
      }
    };
    switch (decision.kind) {
      case "resend": {
        const { stepId } = decision.response;
        if (stepId === undefined) return { info: { fp, decision: "ai", reason: "resend-broken" } };
        // 읽은 뒤 다른 요청이 Claude 로 넘겼으면 다시 주지 않는다: 다시 준 횟수를 gen·rev 조건으로 써서 확인
        const still = await deps.commands.update(uid, commandId, read, {
          mapProgress: { ...(command.mapProgress ?? { mode: "map" }), resends: decision.resends },
        });
        if (still !== "ok") {
          await persistAi(deps, uid, commandId, command.gen, `resend-${still}`, log);
          return { info: { fp, decision: "ai", reason: `resend-${still}` } };
        }
        // 늦게 온 재요청이 앞 요청 번호를 쓰지 않게 requestId 는 이번 것
        return {
          response: { ...decision.response, stepId, requestId: request.requestId },
          info: { fp, decision: "resend" },
        };
      }
      case "step": {
        const stepId = newStepId();
        const response: SentResponse = { ...decision.response, stepId };
        const saved = await deps.commands.update(uid, commandId, read, {
          mapProgress: { ...decision.progress, stepId },
        });
        if (saved !== "ok") {
          // 겹친 요청에 졌으면 이 요청은 Claude 가 안내하므로 Claude 로 넘긴 것을 저장
          log.info("map step not saved", { saved });
          await persistAi(deps, uid, commandId, command.gen, `progress-${saved}`, log);
          return { info: { fp, decision: "ai", reason: `progress-${saved}` } };
        }
        log.info("map step", { kind: decision.progress.kind, ref: decision.progress.ref });
        await countResult();
        return {
          response,
          info: {
            fp,
            decision: "step",
            ...(decision.progress.ref ? { ref: decision.progress.ref } : {}),
          },
        };
      }
      case "ai":
        if (decision.persist) {
          const saved = await deps.commands.update(uid, commandId, read, {
            mapProgress: { mode: "ai", reason: decision.reason },
          });
          if (saved === "ok") await countResult();
          if (saved === "conflict") {
            await persistAi(deps, uid, commandId, command.gen, decision.reason, log);
          }
        }
        return { info: { fp, decision: "ai", reason: decision.reason } };
    }
  } catch (error) {
    log.warn("map guide failed", { error });
    // 지도를 못 읽어 Claude 가 안내하게 됐으면, 나중에 지도가 돌아와도 끼어들지 않게
    if (readGen !== undefined) await persistAi(deps, uid, commandId, readGen, "map-error", log);
    return undefined;
  }
}

/**
 * 명령을 Claude 안내로 고정 (다시 읽고 두 번까지). 처음 읽은 세대(gen)일 때만:
 * 그 사이 TTL 로 지워지고 같은 번호로 새로 만든 명령은 건드리지 않는다.
 * 끝난 명령·이미 ai 면 쓰지 않음. 실패는 기록만
 */
async function persistAi(
  deps: MapGuideDeps,
  uid: string,
  commandId: number,
  gen: string,
  reason: string,
  log: Logger,
): Promise<void> {
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const command = await deps.commands.get(uid, commandId);
      if (!command || command.gen !== gen) return;
      if (command.endResult !== undefined || command.mapProgress?.mode === "ai") return;
      const saved = await deps.commands.update(
        uid,
        commandId,
        { gen: command.gen, rev: command.rev },
        { mapProgress: { mode: "ai", reason } },
      );
      if (saved !== "conflict") return;
    }
    log.warn("map ai handoff not saved", { reason });
  } catch (error) {
    log.warn("map ai handoff failed", { error });
  }
}

/** 안내 하나의 id: 시각 + 무작위 (앱이 lastAction.stepId 로 돌려줌) */
const newStepId = (): string => `s${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
