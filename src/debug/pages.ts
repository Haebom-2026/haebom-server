/**
 * 새 화면을 이미 본 페이지에 맞춘다 (화면 매칭 시험, src/cache/match.ts).
 * 디버그 화면 저장(POST /v1/dev/screens)과 guide 기록이 같이 쓴다.
 *
 *   const { match, commit } = await matcher.prepare(...)  // 1) 판정 (저장 전)
 *   await store.saveScreen({ ..., match })                 // 2) 화면 저장 (중복이면 저장 안 됨)
 *   if (saved) await commit()                              // 3) 저장됐을 때만 페이지 갱신
 */
import { randomBytes } from "node:crypto";
import type { FingerprintNode } from "../cache/fingerprint.js";
import { matchPage, matchTokens, type MatchResult } from "../cache/match.js";
import type { DebugStore } from "./store.js";

export interface PreparedMatch {
  match: MatchResult;
  commit(): Promise<void>;
}

export const newPageId = (): string => `p${randomBytes(4).toString("hex")}`;

export function createPageMatcher(store: DebugStore, makeId: () => string = newPageId) {
  return {
    async prepare(input: {
      pkg: string;
      fingerprint: string;
      nodes: readonly FingerprintNode[];
      deviceId: string;
      screenId: string;
      at: string;
    }): Promise<PreparedMatch> {
      const tokens = matchTokens(input.nodes);
      const pages = await store.listPages(input.pkg);
      const result = matchPage({ fingerprint: input.fingerprint, tokens }, pages);

      if (result.kind === "new") {
        const pageId = makeId();
        return {
          match: { ...result, pageId },
          commit: () =>
            store.createPage({
              pkg: input.pkg,
              pageId,
              tokens,
              lastTokens: tokens,
              fingerprints: [input.fingerprint],
              screenCount: 1,
              firstSeenAt: input.at,
              lastSeenAt: input.at,
              sampleDeviceId: input.deviceId,
              sampleScreenId: input.screenId,
            }),
        };
      }
      const { pageId } = result;
      if (result.kind === "ambiguous" || pageId === undefined) {
        // 판단 보류: 어느 페이지도 바꾸지 않는다
        return { match: result, commit: () => Promise.resolve() };
      }
      return {
        match: result,
        commit: () =>
          store.touchPage(input.pkg, pageId, {
            fingerprint: input.fingerprint,
            tokens,
            at: input.at,
          }),
      };
    },
  };
}

export type PageMatcher = ReturnType<typeof createPageMatcher>;
