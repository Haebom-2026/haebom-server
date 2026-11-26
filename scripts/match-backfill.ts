/**
 * 이미 저장된 디버그 화면에 화면 매칭(match@v1)을 채운다 (dev 전용, 한 번 돌리는 도구).
 * 오래된 화면부터 차례로 페이지를 만들고 맞춘다 → 새 화면이 들어올 때와 같은 순서.
 * match 가 이미 있는 화면은 건너뛰므로 여러 번 돌려도 된다.
 *
 *   AWS_PROFILE=<dev 계정 프로필> npx tsx scripts/match-backfill.ts [--dry-run]
 *
 * 테이블·버킷: DEBUG_TABLE / DEBUG_BUCKET, 없으면 infra/envs/dev 의 terraform output debug.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { createAwsDebugStore } from "../src/debug/aws-store.js";
import { createPageMatcher } from "../src/debug/pages.js";
import type { DebugStore, PageRecord, ScreenSummary } from "../src/debug/store.js";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const { values: args } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });

async function config(): Promise<{ table: string; bucket: string }> {
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

/** dry-run: 페이지 변경을 메모리에만 반영해 실제로 돌렸을 때와 같은 판정을 보여 준다 */
function withMemoryPages(store: DebugStore): DebugStore {
  const cache = new Map<string, PageRecord[]>();
  const pagesOf = async (pkg: string) => {
    let pages = cache.get(pkg);
    if (!pages) {
      pages = await store.listPages(pkg);
      cache.set(pkg, pages);
    }
    return pages;
  };
  return {
    ...store,
    listPages: async (pkg) => structuredClone(await pagesOf(pkg)),
    createPage: async (page) => {
      (await pagesOf(page.pkg)).push(structuredClone(page));
    },
    touchPage: async (pkg, pageId, { fingerprint, tokens, at }) => {
      const page = (await pagesOf(pkg)).find((p) => p.pageId === pageId);
      if (!page) return;
      if (!page.fingerprints.includes(fingerprint)) page.fingerprints.push(fingerprint);
      page.lastTokens = tokens;
      page.lastSeenAt = at;
      page.screenCount += 1;
    },
  };
}

async function main() {
  const store = createAwsDebugStore(await config());
  const matcher = createPageMatcher(args["dry-run"] ? withMemoryPages(store) : store);

  const summaries: ScreenSummary[] = [];
  for (const device of await store.listDevices()) {
    let cursor: string | undefined;
    do {
      const page = await store.listScreens(device.deviceId, { cursor, limit: 500 });
      summaries.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
  }
  const todo = summaries
    .filter((s) => s.match === undefined)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  console.log(`화면 ${summaries.length}개 중 매칭 없는 화면 ${todo.length}개`);

  const counts: Record<string, number> = {};
  for (const summary of todo) {
    const doc = await store.getScreen(summary.deviceId, summary.screenId);
    if (!doc) continue;
    const prepared = await matcher.prepare({
      pkg: doc.pkg,
      fingerprint: doc.fingerprint,
      nodes: doc.screen.nodes,
      deviceId: doc.deviceId,
      screenId: doc.screenId,
      at: doc.receivedAt,
    });
    counts[prepared.match.kind] = (counts[prepared.match.kind] ?? 0) + 1;
    if (args["dry-run"]) {
      await prepared.commit();
      continue;
    }
    await store.setScreenMatch(doc.deviceId, doc.screenId, prepared.match);
    await prepared.commit();
  }
  console.log(args["dry-run"] ? "(dry-run, 저장 안 함)" : "저장 완료", counts);
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
