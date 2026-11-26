/**
 * 실시간 수신 추상화 (docs/server-plan.md 12.6).
 * 지금은 1초 폴링. 늦게 느껴지면 이 파일만 AppSync Events 구독으로 바꾼다.
 */
import { api } from "./api.ts";
import type { ScreenSummary } from "./types.ts";

export const POLL_MS = 1000;

/**
 * 매번 마지막으로 받은 것보다 이만큼 앞부터 다시 가져온다.
 * 기록의 순서 키는 요청을 "받은 시각"인데 저장은 처리가 끝난 뒤라서
 * (classify 1~2초, guide 2~4초) 그 사이 저장된 폰 화면보다 앞자리에 뒤늦게 들어온다.
 * 겹쳐 가져온 것 중 이미 넘긴 것은 버린다.
 */
export const LOOKBACK_MS = 15_000;

/** screenId(`20261126T185228705Z-e1047a`)의 시각 → 그보다 ms 앞의 since 값 */
export function sinceBefore(screenId: string, ms: number): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(screenId);
  if (!m) return screenId;
  const [, y, mo, d, h, mi, s, ms3] = m;
  const at = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!, +ms3!) - ms;
  return new Date(at).toISOString().replace(/[-:.]/g, "");
}

export interface Subscription {
  stop(): void;
}

/**
 * since 이후 새 기록(화면·명령)을 시간 순(오래된 것부터)으로 onScreens 로 넘긴다.
 * 뒤늦게 저장된 기록은 이미 넘긴 것보다 앞 시각일 수 있다 → 받는 쪽은 시간 순 제자리에 넣는다.
 * @param known 부르는 쪽이 이미 가진 id (뒤돌아 가져올 때 다시 넘기지 않게)
 */
export function subscribeScreens(
  deviceId: string,
  since: string | undefined,
  onScreens: (items: ScreenSummary[]) => void,
  onError: (error: unknown) => void,
  known: Iterable<string> = [],
): Subscription {
  let last = since;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const seen = new Set(known);

  const tick = async () => {
    try {
      const page = await api.screens(
        deviceId,
        last === undefined ? { limit: 1 } : { since: sinceBefore(last, LOOKBACK_MS), limit: 200 },
      );
      if (stopped) return;
      // since 가 없으면(화면이 하나도 없던 기기) 최신 1개가 첫 새 화면이다
      const fresh = page.items.filter((x) => !seen.has(x.screenId));
      for (const x of page.items) {
        seen.add(x.screenId);
        if (last === undefined || x.screenId > last) last = x.screenId;
      }
      // 뒤돌아 보는 창보다 오래된 id 는 다시 올 일이 없으므로 잊는다
      if (last !== undefined) {
        const floor = sinceBefore(last, LOOKBACK_MS * 2);
        for (const id of seen) if (id < floor) seen.delete(id);
      }
      if (fresh.length > 0) onScreens(fresh.sort((a, b) => a.screenId.localeCompare(b.screenId)));
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
