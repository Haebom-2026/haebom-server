/**
 * 지도 사람 확인 대기 (docs/jev-routing-plan.md 8.2, R5, dev 전용).
 * 자동 반영이 넣지 않고 남긴 명령(새 목표·L2 이상·민감한 끝 단계·끝 단계 충돌·human 판정)을 본다.
 *
 *   AWS_PROFILE=<dev 계정 프로필> npx tsx scripts/map-pending.ts                          # 목록
 *   AWS_PROFILE=<dev 계정 프로필> npx tsx scripts/map-pending.ts --drop <uid>:<commandId>:<gen>  # 버리기
 *
 * 넣기(승인)는 scripts/map-seed.ts --uid <uid> --command <id> --force --apply (넣으면 대기에서 빠짐).
 * 테이블: TABLE_MAIN (기본 haebom-dev-main).
 */
import { parseArgs } from "node:util";
import { createAwsMapLearnStore } from "../src/map/learn.js";

const { values: args } = parseArgs({ options: { drop: { type: "string" } } });

async function main(): Promise<void> {
  const learn = createAwsMapLearnStore(process.env.TABLE_MAIN ?? "haebom-dev-main");
  if (args.drop) {
    const [uid, id, gen] = args.drop.split(":");
    if (!uid || !id || !gen) throw new Error("usage: --drop <uid>:<commandId>:<gen>");
    await learn.deletePending(uid, Number(id), gen);
    console.log("버렸음");
    return;
  }
  const items = await learn.listPending();
  if (items.length === 0) console.log("대기 없음");
  for (const p of items) {
    const proposal = p.proposal ? ` 새 목표 제안: ${p.proposal.name} (${p.proposal.desc})` : "";
    console.log(
      `${p.uid}:${p.commandId}:${p.gen} ${p.createdAt} goal=${p.goalId ?? "-"} [${p.reasons.join(", ")}]${proposal}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
