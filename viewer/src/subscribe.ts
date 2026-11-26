/**
 * 실시간 수신 추상화 (docs/server-plan.md 12.6).
 * 지금은 1초 폴링. 늦게 느껴지면 이 파일만 AppSync Events 구독으로 바꾼다.
 */
import { api } from "./api.ts";
import type { ScreenSummary } from "./types.ts";

export const POLL_MS = 1000;

export interface Subscription {
  stop(): void;
}

/** since 이후 새 화면을 오래된 것부터 onScreens 로 넘긴다. */
export function subscribeScreens(
  deviceId: string,
  since: string | undefined,
  onScreens: (items: ScreenSummary[]) => void,
  onError: (error: unknown) => void,
): Subscription {
  let last = since;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    try {
      const page = await api.screens(
        deviceId,
        last === undefined ? { limit: 1 } : { since: last, limit: 100 },
      );
      if (stopped) return;
      // since 가 없으면(화면이 하나도 없던 기기) 최신 1개가 첫 새 화면이다
      const items = page.items;
      if (items.length > 0) {
        last = items[items.length - 1]?.screenId ?? last;
        onScreens(items);
      }
    } catch (error) {
      if (!stopped) onError(error);
    }
    if (!stopped && document.visibilityState !== "hidden")
      timer = setTimeout(() => void tick(), POLL_MS);
    else if (!stopped) document.addEventListener("visibilitychange", resume, { once: true });
  };

  const resume = () => {
    if (!stopped) void tick();
  };

  timer = setTimeout(() => void tick(), POLL_MS);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    },
  };
}

/** 주기적으로 fn 을 다시 부른다 (기기 목록 3초). */
export function every(ms: number, fn: () => Promise<void>): Subscription {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loop = async () => {
    await fn().catch(() => undefined);
    if (!stopped) timer = setTimeout(() => void loop(), ms);
  };
  void loop();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
