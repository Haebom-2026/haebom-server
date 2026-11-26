import type {
  CommandEntryDocument,
  DebugStore,
  DeviceRecord,
  PageRecord,
  PinRecord,
  ScreenDocument,
} from "../src/debug/store.js";
import { summaryOf } from "../src/debug/store.js";

/** 메모리 구현: 라우트 동작만 검증한다 (DynamoDB·S3 연동은 dev 배포 후 확인). */
export function memoryDebugStore() {
  const devices = new Map<string, DeviceRecord & { lastKey?: string }>();
  const screens: (ScreenDocument & { uid: string })[] = [];
  const entries: (CommandEntryDocument & { uid: string })[] = [];
  /** 화면과 명령 기록을 시간(id) 순으로 */
  const timeline = () =>
    [...screens, ...entries].sort((a, b) => a.screenId.localeCompare(b.screenId));
  const pins: PinRecord[] = [];
  const pages: PageRecord[] = [];

  const store: DebugStore = {
    heartbeat({ deviceId, uid, model, os, appVersion, now }) {
      const prev = devices.get(deviceId);
      devices.set(deviceId, {
        ...prev,
        deviceId,
        uid,
        model,
        os,
        appVersion,
        lastSeenAt: now.toISOString(),
        screenCount: prev?.screenCount ?? 0,
      });
      return Promise.resolve();
    },
    saveScreen({ dedupeKey, ...doc }) {
      const prev = devices.get(doc.deviceId);
      if (prev?.lastKey === dedupeKey) return Promise.resolve(false);
      devices.set(doc.deviceId, {
        model: "",
        os: "",
        appVersion: "",
        ...prev,
        deviceId: doc.deviceId,
        uid: doc.uid,
        lastKey: dedupeKey,
        lastSeenAt: doc.receivedAt,
        lastScreenAt: doc.receivedAt,
        screenCount: (prev?.screenCount ?? 0) + 1,
      });
      screens.push(doc);
      return Promise.resolve(true);
    },
    saveEntry(doc) {
      const prev = devices.get(doc.deviceId);
      devices.set(doc.deviceId, {
        model: "",
        os: "",
        appVersion: "",
        screenCount: 0,
        ...prev,
        deviceId: doc.deviceId,
        uid: doc.uid,
        lastSeenAt: doc.receivedAt,
      });
      entries.push(doc);
      return Promise.resolve();
    },
    listDevices: () => Promise.resolve([...devices.values()]),
    setLabel(deviceId, label) {
      const prev = devices.get(deviceId);
      if (!prev) return Promise.resolve(false);
      devices.set(deviceId, { ...prev, label });
      return Promise.resolve(true);
    },
    listScreens(deviceId, { since, from, to, limit }) {
      const mine = timeline()
        .filter((s) => s.deviceId === deviceId)
        .map(summaryOf);
      const items =
        since !== undefined
          ? mine.filter((s) => s.screenId > since).slice(0, limit)
          : from !== undefined && to !== undefined
            ? mine.filter((s) => s.screenId >= from && s.screenId <= to).slice(0, limit)
            : mine.reverse().slice(0, limit);
      return Promise.resolve({ items });
    },
    getScreen: (deviceId, screenId) =>
      Promise.resolve(timeline().find((s) => s.deviceId === deviceId && s.screenId === screenId)),
    createPin(pin) {
      const record = {
        ...pin,
        screenCount: screens.filter(
          (s) => s.deviceId === pin.deviceId && s.screenId >= pin.from && s.screenId <= pin.to,
        ).length,
      };
      pins.push(record);
      return Promise.resolve(record);
    },
    listPins: () => Promise.resolve(pins),
    listPages: (pkg) => Promise.resolve(structuredClone(pages.filter((p) => p.pkg === pkg))),
    createPage(page) {
      pages.push(structuredClone(page));
      return Promise.resolve();
    },
    touchPage(pkg, pageId, { fingerprint, tokens, at }) {
      const page = pages.find((p) => p.pkg === pkg && p.pageId === pageId);
      if (!page) return Promise.reject(new Error("page not found"));
      if (!page.fingerprints.includes(fingerprint)) page.fingerprints.push(fingerprint);
      page.lastTokens = tokens;
      page.lastSeenAt = at;
      page.screenCount += 1;
      return Promise.resolve();
    },
    setScreenMatch(deviceId, screenId, match) {
      const screen = screens.find((s) => s.deviceId === deviceId && s.screenId === screenId);
      if (screen) screen.match = match;
      return Promise.resolve();
    },
  };
  return {
    entries,
    store,
    screens,
    pages,
  };
}
