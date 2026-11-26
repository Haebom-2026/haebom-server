/**
 * #16 guide 응답 캐시 (docs/server-plan.md 9장, S6).
 *
 * 같은 어르신이 **같은 화면에서 같은 요청**을 다시 하면 모델을 부르지 않고 저장된 답을 쓴다 (토큰 절약).
 *
 * 키 (SHA-256): guide | 프롬프트 버전 | 모델 | 화면 지문 버전 | uid | 화면 지문 | goal | slots | 정규화한 utterance
 * - uid 를 넣어 **어르신별**로만 재사용한다. 화면에 연락처 이름·검색어 같은 개인 글자가 섞이므로 다른 어르신과 나누지 않는다.
 * - 프롬프트·모델·지문 규칙이 바뀌면 키가 저절로 갈린다.
 * - history 는 넣지 않는다 (같은 화면·같은 요청이면 다음 행동이 같다고 봄).
 *
 * 저장: 모델이 정상 답하고 후처리에서 낮춰지지 않은 응답만. requestId 는 빼고 저장.
 * 적중: 저장된 target 이 지금 화면의 같은 글자 요소인지 다시 확인한다. 번호가 바뀌었으면 글자로 다시 찾고,
 *       못 찾으면 적중으로 보지 않는다 (모델을 부름).
 */
import { createHash } from "node:crypto";
import type { GuideRequest, GuideResponse } from "../ai/guide-schema.js";
import { FINGERPRINT_VERSION, fingerprint } from "./fingerprint.js";

/** 7일 */
export const GUIDE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** 저장하는 응답 (requestId 제외) */
export type CachedGuideResponse = Omit<GuideResponse, "requestId" | "cached">;

export interface CachedGuide {
  response: CachedGuideResponse;
  savedAt: string;
}

export interface GuideCacheStore {
  get(key: string): Promise<CachedGuide | undefined>;
  put(key: string, value: CachedGuide, ttlSeconds: number): Promise<void>;
}

export interface GuideCacheKeyInput {
  uid: string;
  request: GuideRequest;
  promptVersion: string;
  model: string;
}

const normalizeUtterance = (text: string): string => text.replace(/\s+/g, "").toLowerCase();

export function guideCacheKey({ uid, request, promptVersion, model }: GuideCacheKeyInput): string {
  const slots = Object.entries(request.slots)
    .map(([k, v]) => [k, v.trim()] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const parts = [
    "guide",
    promptVersion,
    model,
    FINGERPRINT_VERSION,
    uid,
    fingerprint(request.screen),
    request.goal.trim(),
    JSON.stringify(slots),
    normalizeUtterance(request.utterance),
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * 저장된 응답을 지금 화면에 맞춘다. 쓸 수 없으면 undefined.
 * [texts] 는 요소 번호 → 글자 (guide.ts 의 nodeTexts).
 */
export function revalidateCached(
  cached: CachedGuideResponse,
  texts: ReadonlyMap<number, string>,
): CachedGuideResponse | undefined {
  if (cached.target === undefined) return cached;
  const wanted = cached.targetText;
  if (texts.has(cached.target) && (wanted === undefined || texts.get(cached.target) === wanted))
    return cached;
  if (wanted === undefined) return undefined;
  for (const [index, text] of texts) {
    if (text === wanted) return { ...cached, target: index };
  }
  return undefined;
}

/** 테스트·로컬용 메모리 저장소 */
export function memoryGuideCache(
  now: () => number = Date.now,
): GuideCacheStore & { size(): number } {
  const items = new Map<string, { value: CachedGuide; expiresAt: number }>();
  return {
    get(key) {
      const item = items.get(key);
      if (!item) return Promise.resolve(undefined);
      if (item.expiresAt <= now()) {
        items.delete(key);
        return Promise.resolve(undefined);
      }
      return Promise.resolve(item.value);
    },
    put(key, value, ttlSeconds) {
      items.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
      return Promise.resolve();
    },
    size: () => items.size,
  };
}
