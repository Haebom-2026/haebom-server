/** CoreStore·IdempotencyStore 메모리 구현: DynamoDB 조건부 쓰기와 같은 규칙을 흉내 낸다. */
import {
  GLOBAL_FAILURE_WINDOW_MS,
  GUARDIAN_FAILURE_WINDOW_MS,
  type ConnectCode,
  type DeviceRecord,
  type LinkRecord,
  type UserProfile,
} from "../src/core/model.js";
import type {
  InboxItem,
  NotificationRecord,
  NotificationStore,
} from "../src/core/notifications.js";
import type { CodeLookup, CoreStore, RedeemResult } from "../src/core/store.js";
import type { BeginResult, IdempotencyStore } from "../src/shared/idempotency.js";

export function memoryCoreStore() {
  const users = new Map<string, UserProfile>();
  const devices = new Map<string, DeviceRecord>(); // `${uid}|${deviceId}`
  const owners = new Map<string, string>(); // deviceId → uid
  const links = new Map<string, LinkRecord>(); // `${eid}|${gid}`
  const codes = new Map<string, ConnectCode>();
  const activeCodes = new Map<string, string>(); // elderId → code
  const failures = new Map<string, number>();

  const failureKeys = (gid: string, now: Date) =>
    [
      `g|${gid}|${Math.floor(now.getTime() / GUARDIAN_FAILURE_WINDOW_MS)}`,
      `all|${Math.floor(now.getTime() / GLOBAL_FAILURE_WINDOW_MS)}`,
    ] as const;

  const store: CoreStore = {
    getUser: (uid) => Promise.resolve(users.get(uid)),
    createUser(user) {
      if (users.has(user.uid)) return Promise.resolve(false);
      users.set(user.uid, { ...user });
      return Promise.resolve(true);
    },
    updateUserName(uid, name, now) {
      const user = users.get(uid);
      if (user === undefined) return Promise.resolve(undefined);
      const updated = { ...user, name, updatedAt: now };
      users.set(uid, updated);
      return Promise.resolve(updated);
    },
    putDevice(device) {
      const previous = owners.get(device.deviceId);
      if (previous !== undefined && previous !== device.uid) {
        devices.delete(`${previous}|${device.deviceId}`);
      }
      devices.set(`${device.uid}|${device.deviceId}`, { ...device });
      owners.set(device.deviceId, device.uid);
      return Promise.resolve();
    },
    deleteDevice(uid, deviceId) {
      devices.delete(`${uid}|${deviceId}`);
      if (owners.get(deviceId) === uid) owners.delete(deviceId);
      return Promise.resolve();
    },
    listDevices: (uid) => Promise.resolve([...devices.values()].filter((d) => d.uid === uid)),
    listLinksByElder: (eid) =>
      Promise.resolve([...links.values()].filter((l) => l.elderId === eid)),
    listLinksByGuardian: (gid) =>
      Promise.resolve([...links.values()].filter((l) => l.guardianId === gid)),
    setLinkNames(list, names) {
      for (const link of list) {
        const key = `${link.elderId}|${link.guardianId}`;
        const current = links.get(key);
        if (current) links.set(key, { ...current, ...names });
      }
      return Promise.resolve();
    },
    deleteLink: (eid, gid) => Promise.resolve(links.delete(`${eid}|${gid}`)),
    issueCode(code, now) {
      const existing = codes.get(code.code);
      if (existing !== undefined && existing.expiresAt >= now) return Promise.resolve(false);
      codes.set(code.code, { ...code });
      activeCodes.set(code.elderId, code.code);
      return Promise.resolve(true);
    },
    getCode(code): Promise<CodeLookup | undefined> {
      const item = codes.get(code);
      if (item === undefined) return Promise.resolve(undefined);
      return Promise.resolve({ ...item, active: activeCodes.get(item.elderId) === code });
    },
    redeemCode(code, link, now): Promise<RedeemResult> {
      const item = codes.get(code);
      const codeOk =
        item !== undefined &&
        !item.used &&
        item.expiresAt > now &&
        item.elderId === link.elderId &&
        activeCodes.get(link.elderId) === code;
      const key = `${link.elderId}|${link.guardianId}`;
      if (!codeOk) return Promise.resolve("code-unavailable");
      if (links.has(key)) return Promise.resolve("already-linked");
      codes.set(code, { ...item, used: true });
      links.set(key, { ...link });
      return Promise.resolve("ok");
    },
    codeFailures(gid, now) {
      const [g, all] = failureKeys(gid, now);
      return Promise.resolve({ guardian: failures.get(g) ?? 0, global: failures.get(all) ?? 0 });
    },
    recordCodeFailure(gid, now) {
      for (const key of failureKeys(gid, now)) failures.set(key, (failures.get(key) ?? 0) + 1);
      return Promise.resolve();
    },
  };

  return { store, users, devices, links, codes };
}

export function memoryIdempotencyStore(): IdempotencyStore & { size: () => number } {
  const items = new Map<string, { hash: string; done?: { statusCode: number; body: string } }>();
  return {
    size: () => items.size,
    begin(key, requestHash): Promise<BeginResult> {
      const item = items.get(key);
      if (item === undefined) {
        items.set(key, { hash: requestHash });
        return Promise.resolve({ state: "new" });
      }
      if (item.done === undefined) return Promise.resolve({ state: "in-progress" });
      return Promise.resolve({ state: "done", requestHash: item.hash, ...item.done });
    },
    complete(key, statusCode, body) {
      const item = items.get(key);
      if (item) item.done = { statusCode, body };
      return Promise.resolve();
    },
    abort(key) {
      items.delete(key);
      return Promise.resolve();
    },
  };
}

/** NotificationStore 메모리 구현 */
export function memoryNotificationStore() {
  const originals: NotificationRecord[] = [];
  const inbox = new Map<string, InboxItem>(); // `${gid}|${id}`
  const dedup = new Map<string, string>(); // `${eid}|${pkg}` → until

  const store: NotificationStore = {
    create(record, entries, { dedupUntil, now }) {
      if (dedupUntil !== undefined) {
        const key = `${record.elderId}|${record.packageName}`;
        const until = dedup.get(key);
        if (until !== undefined && until >= now) return Promise.resolve("duplicate_suppressed");
        dedup.set(key, dedupUntil);
      }
      originals.push({ ...record });
      for (const entry of entries) inbox.set(`${entry.guardianId}|${entry.id}`, { ...entry });
      return Promise.resolve("created");
    },
    listInbox(guardianId, { cursor, since, limit }) {
      let items = [...inbox.values()]
        .filter((item) => item.guardianId === guardianId)
        .sort((a, b) => b.id.localeCompare(a.id));
      if (since !== undefined) items = items.filter((item) => item.createdAt > since);
      if (cursor !== undefined) items = items.filter((item) => item.id < cursor);
      const page = items.slice(0, limit);
      const last = page.at(-1);
      return Promise.resolve(
        items.length > limit && last ? { items: page, nextCursor: last.id } : { items: page },
      );
    },
    markRead(guardianId, id, readAt) {
      const item = inbox.get(`${guardianId}|${id}`);
      if (item === undefined) return Promise.resolve(false);
      item.readAt ??= readAt;
      return Promise.resolve(true);
    },
    deleteInboxForElder(guardianId, elderId) {
      let count = 0;
      for (const [key, item] of inbox) {
        if (item.guardianId === guardianId && item.elderId === elderId) {
          inbox.delete(key);
          count++;
        }
      }
      return Promise.resolve(count);
    },
  };
  return { store, originals, inbox };
}
