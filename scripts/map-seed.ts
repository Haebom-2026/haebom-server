/**
 * 검토된 명령 하나를 지도에 넣는다 (docs/jev-routing-plan.md 3.5, R4 사람 승인 seed, dev 전용).
 * 기본은 보여 주기만 한다. 사람이 연결선·목표를 보고 --apply 로 쓴다.
 *
 *   AWS_PROFILE=<dev 계정 프로필> npx tsx scripts/map-seed.ts --uid <uid> --command <id> [--force] [--apply]
 *
 * --force: 검토가 human 인 것도 (사람이 보고 성공이라 판단했을 때만)
 * 테이블: TABLE_MAIN (기본 haebom-dev-main), 디버그: DEBUG_TABLE / DEBUG_BUCKET 또는 terraform output debug.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { createAwsDebugStore } from "../src/debug/aws-store.js";
import type { ScreenDocument } from "../src/debug/store.js";
import { buildSeed } from "../src/map/seed.js";
import { createAwsMapLearnStore, evidenceEntry } from "../src/map/learn.js";
import { createAwsMapStore } from "../src/map/store.js";
import { createAwsCommandLog } from "../src/route/command-log.js";
import { createAwsCommandStore, type ScreenRef } from "../src/route/command-store.js";
import { stepsOfCommand, type ReviewRecord } from "../src/review/review.js";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const { values: args } = parseArgs({
  options: {
    uid: { type: "string" },
    command: { type: "string" },
    force: { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
  },
});

async function debugConfig(): Promise<{ table: string; bucket: string }> {
  if (process.env.DEBUG_TABLE && process.env.DEBUG_BUCKET) {
    return { table: process.env.DEBUG_TABLE, bucket: process.env.DEBUG_BUCKET };
  }
  const { stdout } = await run("terraform", [
    `-chdir=${path.join(root, "infra/envs/dev")}`,
    "output",
    "-json",
    "debug",
  ]);
  const debug = JSON.parse(stdout) as { table_name: string; bucket_name: string };
  return { table: debug.table_name, bucket: debug.bucket_name };
}

async function main(): Promise<void> {
  const uid = args.uid;
  const commandId = Number(args.command);
  if (!uid || !Number.isInteger(commandId)) {
    throw new Error("usage: --uid <uid> --command <commandId> [--force] [--apply]");
  }
  const table = process.env.TABLE_MAIN ?? "haebom-dev-main";
  const debug = createAwsDebugStore(await debugConfig());
  const commands = createAwsCommandStore(table);
  const commandLog = createAwsCommandLog(table);
  const maps = createAwsMapStore(table);

  const command = await commands.get(uid, commandId);
  if (!command) throw new Error("command not found");
  const review = (await commandLog.getReview(uid, commandId, command.gen)) as
    (ReviewRecord & { invalidated?: string }) | undefined;
  if (!review) throw new Error("no review for this command generation");
  const steps = stepsOfCommand(await commandLog.listSteps(uid, commandId), command);
  const getScreen = async (ref: ScreenRef | undefined): Promise<ScreenDocument | undefined> => {
    if (!ref) return undefined;
    const doc = await debug.getScreen(ref.deviceId, ref.screenId);
    return doc && "screen" in doc ? doc : undefined;
  };
  const docs = await Promise.all(steps.map((s) => getScreen(s.screen)));
  const finalDoc = await getScreen(command.finalScreen);
  const snapshot = await maps.snapshot();

  const result = buildSeed({
    uid,
    command,
    review,
    steps,
    docs,
    finalDoc,
    force: args.force,
    existingGoal: command.chosenGoal ? snapshot.goals.get(command.chosenGoal) : undefined,
    now: new Date(),
  });
  if (!result.ok) throw new Error(result.error);

  console.log(`goal ${result.goal.goalId}: arrive ${result.goal.arriveFps.join(", ")}`);
  for (const f of result.goal.finish) {
    console.log(
      `  finish ${f.action} '${f.targetText}' (${f.targetClass}) verify=${f.verify}${f.sensitive ? " SENSITIVE" : ""}`,
    );
  }
  for (const e of result.edges) {
    const known = snapshot.edges.some((x) => x.edgeId === e.edgeId);
    console.log(
      `edge ${e.edgeId}${known ? " (exists)" : ""}: ${e.fromFp} -${e.action} '${e.targetText}' (${e.targetClass})-> ${e.toFp}`,
    );
  }
  for (const w of result.warnings) console.log(`warning: ${w}`);

  if (!args.apply) {
    console.log("dry run: nothing written (add --apply after checking)");
    return;
  }
  for (const e of result.edges) {
    const old = snapshot.edges.find((x) => x.edgeId === e.edgeId);
    await maps.putEdge(
      old
        ? {
            ...old,
            status: "verified",
            // 사람이 승인했으니 seed 로 (자동 반영의 무효·기기 수가 내리지 않게)
            origin: "seed",
            evidence: [...new Set([...old.evidence, ...e.evidence])],
            // 새로 승인한 성공이니 90일 기준을 지금으로 (오래 안 쓰여 빠졌던 연결선도 다시 쓰임)
            lastUsedAt: new Date().toISOString(),
          }
        : e,
    );
  }
  await maps.putGoal(result.goal);
  // R5: 도착 화면도 사람 seed 로 남기고(자동 반영·무효가 건드리지 않게), 대기에서 뺀다
  const learn = createAwsMapLearnStore(table);
  await learn.putSeedArrive(
    result.goal.goalId,
    result.arriveFp,
    evidenceEntry(uid, commandId, command.gen, "seed"),
    new Date(),
  );
  await learn.deletePending(uid, commandId, command.gen);
  console.log(`written: ${result.edges.length} edges, goal ${result.goal.goalId}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
