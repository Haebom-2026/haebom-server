import { claudeClassifyModel } from "../../ai/classify-model.js";
import { claudeGuideModel } from "../../ai/guide-model.js";
import { createAwsCoreStore } from "../../core/aws-store.js";
import { createProfileGuard } from "../../core/profile.js";
import { createAwsDebugStore } from "../../debug/aws-store.js";
import { createAwsMapLearnStore } from "../../map/learn.js";
import { createAwsMapStore } from "../../map/store.js";
import { createCommandTraceRecorder } from "../../debug/command-trace.js";
import { createGuideTraceRecorder } from "../../debug/guide-trace.js";
import { createAwsCommandStore } from "../../route/command-store.js";
import { createJevClient } from "../../route/jev.js";
import { parseMap } from "../../route/map.js";
import { SEED_MAP } from "../../route/seed-map.js";
import { createRouteSelector } from "../../route/select.js";
import { createRecordingSelector } from "../../route/trace.js";
import { createHttpHandler } from "../../shared/handler.js";
import { createLogger } from "../../shared/logger.js";
import { createRouter } from "../../shared/router.js";
import { createSecretLoader } from "../../shared/secrets.js";
import { createAwsCommandLog } from "../../route/command-log.js";
import {
  createChooseAppRoute,
  createClassifyRoute,
  createEndCommandRoute,
} from "./routes/classify.js";
import { createGuideRoute } from "./routes/guide.js";

const table = process.env.TABLE_MAIN ?? "haebom-local-main";
const profiles = createProfileGuard(createAwsCoreStore(table));

/** dev 에만 디버그 저장소가 있다 (infra/envs/dev 가 DEBUG_TABLE·DEBUG_BUCKET 을 넘김). prod 는 기록하지 않는다. */
const debugTable = process.env.DEBUG_TABLE;
const debugBucket = process.env.DEBUG_BUCKET;
const debugStore =
  debugTable && debugBucket
    ? createAwsDebugStore({ table: debugTable, bucket: debugBucket })
    : undefined;
const recorder = debugStore ? createGuideTraceRecorder(debugStore) : undefined;

/**
 * jev 앱·목표 고르기 (docs/jev-routing-plan.md). ROUTE_ENABLED=true 이고 키 비밀 이름이 있을 때만.
 * 꺼져 있으면 classify 는 안전 분류만 한다. 지도는 아직 저장소 seed (R3 에서 스냅샷으로).
 */
const openRouterSecret = process.env.OPENROUTER_SECRET_ID;
const routeMap = parseMap(SEED_MAP);
const routeDeps = openRouterSecret
  ? { jev: createJevClient({ apiKey: createSecretLoader(openRouterSecret) }), map: routeMap }
  : undefined;
// dev(디버그 저장소가 있음)는 판정 과정(trace)을 붙여 뷰어에 남긴다
const selector =
  process.env.ROUTE_ENABLED === "true" && routeDeps
    ? debugStore
      ? createRecordingSelector(routeDeps)
      : createRouteSelector(routeDeps)
    : undefined;

const commands = createAwsCommandStore(table);
const classifyDeps = {
  model: claudeClassifyModel,
  selector,
  commands,
  recorder: debugStore ? createCommandTraceRecorder(debugStore, routeMap) : undefined,
};

/**
 * 지도 안내 (R4). dev 에서만: MAP_GUIDE_ENABLED=true 이고 디버그 저장소가 있을 때 (명령 단계 기록과 함께 씀).
 * 지도는 사람이 승인한 길만 (scripts/map-seed.ts).
 */
/** (R5) 지도 안내 결과 세기·내리기. 지도 안내가 켜진 dev 에서만 */
const mapLearn =
  process.env.MAP_GUIDE_ENABLED === "true" && recorder ? createAwsMapLearnStore(table) : undefined;
const mapGuide =
  process.env.MAP_GUIDE_ENABLED === "true" && recorder
    ? { commands, maps: createAwsMapStore(table), routeMap, learn: mapLearn }
    : undefined;

/** ai-fn: #16 guide, #17 classify, 앱 선택, 끝 신호. */
export const router = createRouter([
  {
    method: "POST",
    path: "/v1/elder/guide",
    handler: createGuideRoute(claudeGuideModel, profiles, {
      recorder,
      modelName: process.env.ANTHROPIC_MODEL,
      // 명령 단계 기록은 디버그 저장소가 있는 dev 에서만 (prod 는 개인정보 정책 뒤)
      commandLog: recorder ? createAwsCommandLog(table) : undefined,
      mapGuide,
    }),
  },
  {
    method: "POST",
    path: "/v1/elder/classify",
    handler: createClassifyRoute(profiles, classifyDeps),
  },
  {
    method: "POST",
    path: "/v1/elder/commands/{commandId}/app",
    handler: createChooseAppRoute(profiles, classifyDeps),
  },
  {
    method: "POST",
    path: "/v1/elder/commands/{commandId}/end",
    handler: createEndCommandRoute(profiles, {
      commands: classifyDeps.commands,
      recorder,
      learn: mapLearn,
    }),
  },
]);

export const handler = createHttpHandler(router, createLogger({ service: "ai" }));
