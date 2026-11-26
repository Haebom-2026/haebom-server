/**
 * 지도 긴급 차단 (docs/jev-routing-plan.md 3.5, dev 전용). 연결선·목표를 바로 막거나 푼다.
 * 목록을 통째로 쓰지 않고 넣을 것·뺄 것만 원자적으로 바꾼다 (동시에 실행해도 다른 차단이 지워지지 않음).
 * 켜져 있는 ai-fn 에는 지도 캐시 때문에 **최대 1분 뒤** 반영된다.
 *
 *   AWS_PROFILE=<dev 계정 프로필> npx tsx scripts/map-block.ts                      # 지금 차단 목록
 *   AWS_PROFILE=<dev 계정 프로필> npx tsx scripts/map-block.ts --edge <id> --goal <id>  # 막기
 *   AWS_PROFILE=<dev 계정 프로필> npx tsx scripts/map-block.ts --unblock --edge <id>     # 풀기
 *
 * 테이블: TABLE_MAIN (기본 haebom-dev-main).
 */
import { parseArgs } from "node:util";
import { createAwsMapStore } from "../src/map/store.js";

const { values: args } = parseArgs({
  options: {
    edge: { type: "string", multiple: true, default: [] },
    goal: { type: "string", multiple: true, default: [] },
    unblock: { type: "boolean", default: false },
  },
});

async function main(): Promise<void> {
  const maps = createAwsMapStore(process.env.TABLE_MAIN ?? "haebom-dev-main");
  const edgeIds = args.edge;
  const goalIds = args.goal;
  if (edgeIds.length > 0 || goalIds.length > 0) {
    await maps.updateBlock(args.unblock ? "remove" : "add", { edgeIds, goalIds });
    console.log(`${args.unblock ? "풀었음" : "막았음"}. 켜진 ai-fn 에는 최대 1분 뒤 반영`);
  }
  // 보여 주기용 (쓰기는 위에서 원자적으로 끝남)
  const { block } = await maps.snapshot();
  console.log(`edges: ${block.edgeIds.join(", ") || "(없음)"}`);
  console.log(`goals: ${block.goalIds.join(", ") || "(없음)"}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
