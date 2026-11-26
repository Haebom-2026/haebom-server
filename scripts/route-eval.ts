/**
 * jev 고르기 회귀 측정 (docs/jev-routing-plan.md 10장).
 *
 * 회귀 말 세트(test/fixtures/route-utterances.json)를 실제 jev 에 돌려
 * 1단계(후보 앱)·폰 고르기(가상 폰)·2단계(목표)의 정확도와 시간·비용을 낸다.
 * 돈이 드는 외부 호출이라 CI 에서는 돌리지 않는다 (말 98개 × 지도 하나 ≈ $0.01~0.02).
 *
 *   npx tsx scripts/route-eval.ts [--map seed|large|both] [--concurrency 4]
 *
 * 키: 환경 변수 OPENROUTER_API_KEY 또는 ~/.config/haebom/openrouter.key (출력하지 않음).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { createJevClient } from "../src/route/jev.js";
import { parseMap, type IndexedMap } from "../src/route/map.js";
import { SEED_MAP } from "../src/route/seed-map.js";
import { createRouteSelector, type RouteSelection } from "../src/route/select.js";

interface Utterance {
  utterance: string;
  /** 이 중 어느 앱이든 어르신 일은 된다 */
  apps: string[];
  /** 정답 목표 id (또는 none). 없으면 목표는 채점하지 않음 */
  goals?: string[];
  source: "real" | "synthetic";
}

const { values } = parseArgs({
  options: {
    map: { type: "string", default: "both" },
    concurrency: { type: "string", default: "4" },
  },
});

function apiKey(): string {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const path = `${homedir()}/.config/haebom/openrouter.key`;
  const fromFile = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  if (!fromFile)
    throw new Error(
      "OpenRouter 키가 없습니다 (OPENROUTER_API_KEY 또는 ~/.config/haebom/openrouter.key)",
    );
  return fromFile;
}

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8"));

const utterances = fixture("route-utterances.json") as Utterance[];
const maps: Record<string, IndexedMap> = {
  seed: parseMap(SEED_MAP),
  large: parseMap(fixture("route-map-large.json")),
};

// ---------- 가상 폰 (2.3 과 같은 설정) ----------
const ALWAYS = new Set([
  "settings",
  "contacts",
  "phone",
  "gallery",
  "camera",
  "playstore",
  "messages",
  "clock",
  "calendar",
  "calculator",
  "files",
  "memo",
]);
const COMMON: Record<string, number> = {
  youtube: 0.95,
  kakaotalk: 0.95,
  naver: 0.7,
  chrome: 0.6,
  weather: 0.6,
};

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function phones(m: IndexedMap, count: number): Set<string>[] {
  const random = rng(7);
  return Array.from({ length: count }, () => {
    const phone = new Set<string>();
    for (const app of m.map.apps) {
      if (ALWAYS.has(app.id) || random() < (COMMON[app.id] ?? 0.3)) phone.add(app.id);
    }
    return phone;
  });
}

async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

const pct = (a: number, b: number) => (b === 0 ? "-" : `${((a / b) * 100).toFixed(1)}%`);

async function evaluate(name: string, m: IndexedMap): Promise<void> {
  const key = apiKey();
  const selector = createRouteSelector({
    jev: createJevClient({ apiKey: () => Promise.resolve(key) }),
    map: m,
  });
  const results: { u: Utterance; accept: string[]; r: RouteSelection }[] = await pool(
    utterances,
    Number(values.concurrency),
    async (u) => ({
      u,
      accept: u.apps.filter((a) => m.apps.has(a)),
      r: await selector.select({ utterance: u.utterance }),
    }),
  );

  const misses: string[] = [];
  const kinds: Record<string, number> = {};
  let routed = 0,
    hit = 0,
    falsePositive = 0,
    expectedApps = 0;
  for (const { u, accept, r } of results) {
    kinds[r.kind === "fail" ? `fail(${r.reason})` : r.kind] =
      (kinds[r.kind === "fail" ? `fail(${r.reason})` : r.kind] ?? 0) + 1;
    if (accept.length > 0) expectedApps += 1;
    if (r.kind !== "route") {
      if (accept.length > 0)
        misses.push(`  · ${r.kind}: ${u.utterance} | 정답 ${accept.slice(0, 3).join(",")}`);
      continue;
    }
    routed += 1;
    const ids = r.candidates.map((c) => c.appId);
    if (accept.length === 0) {
      falsePositive += 1;
      misses.push(`  ✗ 해당 없음인데 후보: ${u.utterance} | ${ids.join(",")}`);
    } else if (ids.some((id) => accept.includes(id))) hit += 1;
    else
      misses.push(
        `  ✗ 후보에 정답 없음: ${u.utterance} | 정답 ${accept.slice(0, 3).join(",")} | 후보 ${ids.join(",")}`,
      );
  }

  // 폰 고르기
  const devices = phones(m, 30);
  let picked = 0,
    right = 0,
    askInstall = 0;
  const wrongPick = new Map<string, string>();
  for (const { u, accept, r } of results) {
    if (r.kind !== "route" || r.ask || accept.length === 0) continue;
    for (const phone of devices) {
      const first = r.candidates.find((c) => phone.has(c.appId));
      if (!first) {
        if (r.exclusive) askInstall += 1;
        continue;
      }
      picked += 1;
      if (accept.includes(first.appId)) right += 1;
      else wrongPick.set(u.utterance, `${first.appId} (정답 ${accept.slice(0, 3).join(",")})`);
    }
  }

  // 2단계
  let goalTotal = 0,
    goalTaken = 0,
    goalRight = 0;
  for (const { u, accept, r } of results) {
    if (r.kind !== "route" || !u.goals) continue;
    const c = r.candidates.find((x) => accept.includes(x.appId) && m.goalsByApp.has(x.appId));
    if (!c) continue;
    goalTotal += 1;
    if (c.goal) {
      goalTaken += 1;
      if (u.goals.includes(c.goal.id)) goalRight += 1;
      else
        misses.push(
          `  ✗ 목표: ${u.utterance} | 정답 ${u.goals.join(",")} | ${c.goal.id} ${c.goal.confidence.toFixed(2)}`,
        );
    }
  }

  const ms = results.map((x) => x.r.ms).sort((a, b) => a - b);
  const cost = results.reduce((s, x) => s + x.r.cost, 0);
  const at = (q: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * q))] ?? 0;

  console.log(
    `\n=== 지도 ${name} (${m.map.version}, 앱 ${m.map.apps.length}개, 목표 ${m.map.goals.length}개) · 말 ${results.length}개 ===`,
  );
  console.log(
    `결과: ${Object.entries(kinds)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
  );
  console.log(
    `1단계: 후보를 냄 ${routed}개, 그중 정답 앱이 후보 안 ${pct(hit, routed)} (해당 없음인데 후보 ${falsePositive}) | 정답 앱이 있는 말 중 후보를 냄 ${pct(hit, expectedApps)}`,
  );
  console.log(
    `폰 고르기 (가상 폰 30대, 민감 역할 제외): ${picked}번 중 맞음 ${pct(right, picked)} | 말한 앱이 없어 설치를 물음 ${askInstall}번`,
  );
  console.log(
    `2단계: 정답 앱 후보 ${goalTotal}건, 목표를 정함 ${pct(goalTaken, goalTotal)}, 그중 맞음 ${pct(goalRight, goalTaken)}`,
  );
  console.log(
    `시간: 중앙값 ${at(0.5)}ms, 90% ${at(0.9)}ms, 최대 ${ms.at(-1) ?? 0}ms | 비용 합계 $${cost.toFixed(5)} (명령당 $${(cost / results.length).toFixed(6)})`,
  );
  for (const line of misses) console.log(line);
  for (const [u, w] of wrongPick) console.log(`  ✗ 폰 고르기: ${u} → ${w}`);
}

const which = values.map === "both" ? ["seed", "large"] : [values.map];
for (const name of which) {
  const m = maps[name];
  if (!m) throw new Error(`--map 은 seed | large | both`);
  await evaluate(name, m);
}
