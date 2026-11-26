/**
 * 화면 매칭: 새 화면이 "이미 본 어느 페이지인지" 찾는다 (S6 캐싱 준비, 시험 단계).
 *
 * 지문(fp@v1)은 글자·위치가 조금만 달라도 갈리므로, 페이지를 두 단계로 찾는다.
 *   1. 정확히: 페이지가 이미 가진 지문과 같으면 그 페이지 (exact)
 *   2. 비슷하게: 같은 앱의 페이지들과 토큰(클래스 | 정규화한 글자, 위치 없음)이 겹치는 정도(Jaccard)
 *      - 1등 점수 ≥ MIN_SCORE 이고 2등과 MARGIN 이상 차이 → 그 페이지 (similar)
 *      - 1등 점수 ≥ MIN_SCORE 인데 2등과 차이가 작음 → 판단 보류 (ambiguous, 페이지를 바꾸지 않음)
 *      - 1등 점수 < MIN_SCORE → 새 페이지 (new)
 *
 * 캐시는 ambiguous 를 miss 로 본다 (엉뚱한 페이지의 답을 쓰지 않도록).
 * 규칙을 바꾸면 버전을 올린다.
 */
import { normalizeText, type FingerprintNode } from "./fingerprint.js";

export const MATCH_VERSION = "match@v1";
export const MIN_SCORE = 0.5;
export const MARGIN = 0.15;

export type MatchKind = "exact" | "similar" | "ambiguous" | "new";

export interface PageCandidate {
  pageId: string;
  /** 페이지를 처음 만든 화면의 토큰 */
  tokens: readonly string[];
  /** 가장 최근에 이 페이지로 판정된 화면의 토큰 (내용이 조금씩 바뀌는 페이지용) */
  lastTokens: readonly string[];
  fingerprints: readonly string[];
}

export interface MatchResult {
  version: string;
  kind: MatchKind;
  /** exact·similar·ambiguous: 1등 페이지. new: 없음 (저장할 때 새로 만든다) */
  pageId?: string;
  /** 1등 점수 (exact 는 1) */
  score: number;
  /** 2등 페이지와 점수 (있을 때만) */
  runnerUp?: { pageId: string; score: number };
}

/** 위치를 뺀 `클래스|정규화한 글자` 토큰 (정렬·중복 제거) */
export function matchTokens(nodes: readonly FingerprintNode[]): string[] {
  const out = new Set<string>();
  for (const node of nodes) {
    const text = normalizeText(node.t ?? node.d ?? "");
    const cls = node.c ?? "";
    if (text === "" && cls === "") continue;
    out.add(`${cls}|${text}`);
  }
  return [...out].sort();
}

/** Jaccard: 겹치는 토큰 / 합친 토큰 */
export function similarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  let both = 0;
  for (const token of new Set(b)) if (setA.has(token)) both += 1;
  return both / (setA.size + new Set(b).size - both);
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export function matchPage(
  input: { fingerprint: string; tokens: readonly string[] },
  pages: readonly PageCandidate[],
): MatchResult {
  const exact = pages.find((page) => page.fingerprints.includes(input.fingerprint));
  if (exact) return { version: MATCH_VERSION, kind: "exact", pageId: exact.pageId, score: 1 };

  const ranked = pages
    .map((page) => ({
      pageId: page.pageId,
      score: Math.max(
        similarity(input.tokens, page.tokens),
        similarity(input.tokens, page.lastTokens),
      ),
    }))
    .sort((a, b) => b.score - a.score);
  const [first, second] = ranked;
  if (!first || first.score < MIN_SCORE) {
    return {
      version: MATCH_VERSION,
      kind: "new",
      score: round(first?.score ?? 0),
      ...(first ? { runnerUp: { pageId: first.pageId, score: round(first.score) } } : {}),
    };
  }
  const runnerUp = second
    ? { runnerUp: { pageId: second.pageId, score: round(second.score) } }
    : {};
  const kind: MatchKind = second && first.score - second.score < MARGIN ? "ambiguous" : "similar";
  return {
    version: MATCH_VERSION,
    kind,
    pageId: first.pageId,
    score: round(first.score),
    ...runnerUp,
  };
}
