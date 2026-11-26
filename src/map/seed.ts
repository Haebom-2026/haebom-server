/**
 * 검토(accept)된 명령 하나 → 지도 연결선·목표 (docs/jev-routing-plan.md 3.5, R4 사람 승인 seed).
 *
 * 순수 함수: 읽기·쓰기는 scripts/map-seed.ts 가 한다. 사람이 결과를 보고 승인해야 쓴다.
 * 지문은 디버그 저장소의 화면(이미 가린 노드)으로 계산한다 → guide 가 가린 노드로 계산한 값과 같다.
 */
import type { ScreenDocument } from "../debug/store.js";
import type { StepRecord } from "../route/command-log.js";
import type { CommandRecord } from "../route/command-store.js";
import { actionsOf, type ReviewAction, type ReviewRecord } from "../review/review.js";
import { isSensitiveLabel, isSensitiveScreen } from "../review/safety-words.js";
import { mapFingerprint } from "./fingerprint.js";
import { evidenceEntry } from "./learn.js";
import { classOf, exactLabel, nodeLabel } from "./guide.js";
import { edgeIdOf, type MapEdge, type MapFinishStep, type MapGoal } from "./store.js";

export interface SeedInput {
  uid: string;
  command: CommandRecord;
  review: ReviewRecord & { invalidated?: string };
  steps: readonly StepRecord[];
  /** steps 와 같은 순서의 화면 (없으면 undefined) */
  docs: readonly (ScreenDocument | undefined)[];
  finalDoc?: ScreenDocument | undefined;
  /** human 판정도 사람이 보고 넣을 때 */
  force?: boolean;
  /** 이미 있는 목표 (도착 화면을 합침) */
  existingGoal?: MapGoal | undefined;
  now: Date;
}

export type SeedResult =
  | {
      ok: true;
      edges: MapEdge[];
      goal: MapGoal;
      /** 이 명령의 도착 화면 (자동 반영이 ARRIVE 증거로 씀) */
      arriveFp: string;
      warnings: string[];
    }
  | { ok: false; error: string };

const MOVE_ACTIONS = new Set(["tap", "swipe_up", "swipe_down", "swipe_left", "swipe_right"]);
const labelOf = nodeLabel;

export const fpOfDoc = (doc: ScreenDocument): string =>
  mapFingerprint({ ...doc.screen, pkg: doc.pkg });

export function buildSeed(input: SeedInput): SeedResult {
  const { review, command, steps, docs } = input;
  const fail = (error: string): SeedResult => ({ ok: false, error });
  if (review.invalidated !== undefined) return fail(`review invalidated: ${review.invalidated}`);
  if (review.outcome === "reject" || review.outcome === "error") {
    return fail(`review outcome ${review.outcome}`);
  }
  if (review.outcome === "human" && !input.force) return fail("review needs human (use --force)");
  if (review.gen !== command.gen) return fail("review gen differs from command");
  if (command.category === "scam" || command.level === "L3") return fail("unsafe command");
  const opus = review.opus;
  if (!opus || opus.success !== "yes") return fail("not a success");
  if (opus.personalText) return fail("personal text in path");
  if (review.goal?.kind !== "existing" || !review.goal.id)
    return fail("goal is not an existing goal");
  if (review.goal.id !== command.chosenGoal) return fail("review goal differs from chosen goal");
  const goalId = review.goal.id;

  const warnings: string[] = [];
  const actions = actionsOf(steps, command);
  const bySeq = new Map(actions.map((a) => [a.seq, a]));
  const docAt = (n: number): ScreenDocument | undefined =>
    n < docs.length ? docs[n] : n === docs.length ? input.finalDoc : undefined;
  const evidence = evidenceEntry(input.uid, command.commandId, command.gen, "seed");
  const at = input.now.toISOString();

  /** 행동을 한 화면에서 누른 노드의 클래스 (같은 글자가 하나일 때만) */
  const targetOf = (a: ReviewAction, doc: ScreenDocument): string | undefined => {
    if (a.action !== "tap") return "";
    const want = exactLabel(a.text);
    if (want === "") return undefined;
    const hits = doc.screen.nodes.filter((n) => labelOf(n) === want);
    const classes = new Set(hits.map((n) => classOf(n.c)));
    return hits.length === 1 ? [...classes][0] : undefined;
  };

  const edges: MapEdge[] = [];
  for (const m of opus.moves) {
    const a = bySeq.get(m.seq);
    if (!a) {
      warnings.push(`move seq ${m.seq}: no action`);
      continue;
    }
    const from = docAt(a.on);
    const to = docAt(a.on + 1);
    if (!from || !to) {
      warnings.push(`move seq ${m.seq}: screen missing`);
      continue;
    }
    if (!MOVE_ACTIONS.has(a.action)) {
      warnings.push(`move seq ${m.seq}: action ${a.action} is not a move`);
      continue;
    }
    if (isSensitiveLabel(a.text) || isSensitiveScreen(from) || opus.sensitiveSeqs.includes(a.seq)) {
      warnings.push(`move seq ${m.seq}: sensitive`);
      continue;
    }
    const targetClass = targetOf(a, from);
    if (targetClass === undefined) {
      warnings.push(`move seq ${m.seq}: target '${a.text}' not unique on screen`);
      continue;
    }
    const fromFp = fpOfDoc(from);
    const toFp = fpOfDoc(to);
    if (fromFp === toFp) {
      warnings.push(`move seq ${m.seq}: same screen`);
      continue;
    }
    const base = {
      fromFp,
      toFp,
      action: a.action as MapEdge["action"],
      targetText: a.text,
      targetClass,
    };
    edges.push({
      ...base,
      edgeId: edgeIdOf(base),
      pkg: from.pkg,
      status: "verified",
      origin: "seed",
      evidence: [evidence],
      createdAt: at,
    });
  }

  // 도착 화면: 첫 끝 단계를 한 화면, 끝 단계가 없으면 마지막 이동의 도착 화면
  const finish: MapFinishStep[] = [];
  let arriveFp: string | undefined;
  for (const f of opus.finish) {
    const a = bySeq.get(f.seq);
    const doc = a ? docAt(a.on) : undefined;
    if (!a || !doc) return fail(`finish seq ${f.seq}: screen missing`);
    if (!MOVE_ACTIONS.has(a.action)) {
      // 글자 넣기 같은 끝 단계는 지도에 남기되 Claude 가 하게 (verify none 처럼 다룸)
      warnings.push(`finish seq ${f.seq}: ${a.action} handed to Claude`);
    }
    const targetClass = targetOf(a, doc);
    arriveFp ??= fpOfDoc(doc);
    const after = docAt(a.on + 1);
    finish.push({
      action: (MOVE_ACTIONS.has(a.action) ? a.action : "tap") as MapFinishStep["action"],
      targetText: a.text,
      targetClass: targetClass ?? "",
      verify: MOVE_ACTIONS.has(a.action) && targetClass !== undefined ? f.verify : "none",
      sensitive: opus.sensitiveSeqs.includes(a.seq) || isSensitiveLabel(a.text),
      ...(after ? { afterFp: fpOfDoc(after) } : {}),
    });
  }
  arriveFp ??= edges.at(-1)?.toFp;
  if (arriveFp === undefined) return fail("no arrive screen");
  if (edges.length > 0 && edges.at(-1)?.toFp !== arriveFp) {
    warnings.push("last move does not end on the arrive screen");
  }

  const old = input.existingGoal;
  // 도착 화면과 끝 단계는 짝이다: 끝 단계가 다른 길은 합치지 않는다 (다른 화면의 끝 단계를 쓰게 됨)
  if (old && JSON.stringify(old.finish) !== JSON.stringify(finish)) {
    return fail("finish differs from the existing goal (not merged)");
  }
  const goal: MapGoal = {
    goalId,
    pkg: old?.pkg ?? lastPkg(docs, input.finalDoc),
    arriveFps: [...new Set([...(old?.arriveFps ?? []), arriveFp])],
    finish,
    status: "verified",
    origin: "seed",
    evidence: [...new Set([...(old?.evidence ?? []), evidence])],
    updatedAt: at,
  };
  return { ok: true, edges, goal, arriveFp, warnings };
}

function lastPkg(
  docs: readonly (ScreenDocument | undefined)[],
  finalDoc: ScreenDocument | undefined,
): string {
  return finalDoc?.pkg ?? docs.filter((d) => d !== undefined).at(-1)?.pkg ?? "";
}
