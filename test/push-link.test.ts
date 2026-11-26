import type { DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { marshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it } from "vitest";
import { createPushHandler } from "../src/functions/push/index.js";
import type { DeviceRecord } from "../src/core/model.js";
import type { FcmMessage, FcmSender } from "../src/push/fcm.js";
import { linkChangeFromRecord, type PushDeps } from "../src/push/link-events.js";
import { createLogger } from "../src/shared/logger.js";

const linkImage = {
  PK: "ELDER#e1",
  SK: "LINK#g1",
  type: "link",
  elderId: "e1",
  guardianId: "g1",
  elderName: "김순자",
};

function record(
  eventName: "INSERT" | "REMOVE" | "MODIFY",
  item: object,
  seq = "1",
): DynamoDBRecord {
  const image = marshall(item) as NonNullable<NonNullable<DynamoDBRecord["dynamodb"]>["NewImage"]>;
  return {
    eventName,
    eventID: `ev-${seq}`,
    dynamodb: {
      SequenceNumber: seq,
      ...(eventName === "REMOVE" ? { OldImage: image } : { NewImage: image }),
    },
  };
}

function deps(devices: DeviceRecord[], results: Record<string, "sent" | "unregistered" | "error">) {
  const sent: FcmMessage[] = [];
  const deleted: string[] = [];
  const sender: FcmSender = {
    send(message) {
      const result = results[message.token] ?? "sent";
      if (result === "error") return Promise.reject(new Error("FCM 503"));
      sent.push(message);
      return Promise.resolve(result);
    },
  };
  const value: PushDeps = {
    listDevices: (uid) => Promise.resolve(devices.filter((d) => d.uid === uid)),
    deleteDevice: (uid, deviceId) => {
      deleted.push(`${uid}/${deviceId}`);
      return Promise.resolve();
    },
    sender,
    log: createLogger({}, { level: "error", write: () => undefined }),
  };
  return { value, sent, deleted };
}

const device = (uid: string, deviceId: string, fcmToken: string): DeviceRecord => ({
  uid,
  deviceId,
  fcmToken,
  platform: "android",
  updatedAt: "",
});

describe("linkChangeFromRecord", () => {
  it("연결 항목의 생성·삭제만 고른다", () => {
    expect(linkChangeFromRecord(record("INSERT", linkImage))).toEqual({
      change: "created",
      elderId: "e1",
      guardianId: "g1",
    });
    expect(linkChangeFromRecord(record("REMOVE", linkImage))?.change).toBe("deleted");
    expect(linkChangeFromRecord(record("MODIFY", linkImage))).toBeUndefined();
    expect(linkChangeFromRecord(record("INSERT", { PK: "USER#u", type: "user" }))).toBeUndefined();
  });
});

describe("push-fn", () => {
  it("연결이 생기면 어르신·보호자의 모든 기기에 data 를 보내고, 무효 토큰은 지운다", async () => {
    const d = deps(
      [
        device("e1", "dev-e1", "tok-e1"),
        device("g1", "dev-g1", "tok-g1"),
        device("g1", "old", "tok-old"),
      ],
      { "tok-old": "unregistered" },
    );
    const event: DynamoDBStreamEvent = { Records: [record("INSERT", linkImage)] };
    const res = await createPushHandler(() => d.value)(event);

    expect(res.batchItemFailures).toEqual([]);
    expect(d.sent.map((m) => m.token).sort()).toEqual(["tok-e1", "tok-g1", "tok-old"]);
    expect(d.sent[0]?.data).toEqual({
      kind: "link",
      change: "created",
      elderId: "e1",
      guardianId: "g1",
    });
    expect(d.deleted).toEqual(["g1/old"]);
  });

  it("일시 오류면 그 레코드부터 다시 받도록 돌려준다", async () => {
    const d = deps([device("e1", "dev-e1", "tok-e1")], { "tok-e1": "error" });
    const event: DynamoDBStreamEvent = {
      Records: [record("INSERT", linkImage, "10"), record("REMOVE", linkImage, "11")],
    };
    const res = await createPushHandler(() => d.value)(event);
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: "10" }]);
  });
});

describe("push-fn: 보호자 알림함", () => {
  const inboxImage = (patch: object = {}) => ({
    PK: "GUARDIAN#g1",
    SK: "NOTI#n20261126T060000000Z-abcdef",
    type: "inbox",
    id: "n20261126T060000000Z-abcdef",
    guardianId: "g1",
    elderId: "e1",
    notificationType: "sensitive_entry",
    level: "L1",
    category: "finance",
    appName: "토스",
    ...patch,
  });

  it("보호자 기기에 data + 짧은 알림을 보낸다 (앱 이름은 넣지 않음)", async () => {
    const d = deps([device("g1", "dev-g1", "tok-g1"), device("e1", "dev-e1", "tok-e1")], {});
    await createPushHandler(() => d.value)({ Records: [record("INSERT", inboxImage())] });
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]).toEqual({
      token: "tok-g1",
      data: {
        kind: "notification",
        id: "n20261126T060000000Z-abcdef",
        type: "sensitive_entry",
        elderId: "e1",
      },
      notification: {
        title: "해봄 가족",
        body: "새 가족 알림이 도착했습니다.",
        channelId: "family_activity",
        urgent: false,
      },
    });
    expect(JSON.stringify(d.sent[0]?.notification)).not.toContain("토스");
  });

  it("종류별 채널: 막힘 help_alerts, SOS·사기 의심 sos_alerts", async () => {
    const d = deps([device("g1", "dev-g1", "tok-g1")], {});
    await createPushHandler(() => d.value)({
      Records: [
        record("INSERT", { ...inboxImage({ notificationType: "stuck" }), level: "" }, "1"),
        record("INSERT", inboxImage({ notificationType: "sos" }), "2"),
        record("INSERT", inboxImage({ category: "scam", level: "L3" }), "3"),
        record("REMOVE", inboxImage(), "4"),
      ],
    });
    expect(
      d.sent.map((m) => [m.notification?.channelId, m.notification?.urgent, m.notification?.title]),
    ).toEqual([
      ["help_alerts", true, "해봄 가족 · 도움 필요"],
      ["sos_alerts", true, "해봄 가족 · 긴급"],
      ["sos_alerts", true, "해봄 가족 · 긴급"],
    ]);
  });
});

describe("push-fn: 승인", () => {
  const base = {
    id: "a20261126T060000000Z-abcdef",
    elderId: "e1",
    appName: "정부24",
    action: "guide_gov24_auth",
  };

  it("보호자 항목이 생기면 그 보호자에게 approval_requests 알림 (앱 이름 없음)", async () => {
    const d = deps([device("g1", "dev-g1", "tok-g1")], {});
    await createPushHandler(() => d.value)({
      Records: [
        record("INSERT", {
          ...base,
          PK: "GUARDIAN#g1",
          SK: "APPROVAL#x",
          type: "guardian_approval",
          guardianId: "g1",
          status: "pending",
        }),
      ],
    });
    expect(d.sent).toEqual([
      {
        token: "tok-g1",
        data: { kind: "approval", id: base.id, elderId: "e1" },
        notification: {
          title: "해봄 가족 · 승인 요청",
          body: "가족이 도움을 받아도 될지 물어요. 앱에서 확인해 주세요.",
          channelId: "approval_requests",
          urgent: true,
        },
      },
    ]);
  });

  it("pending 에서 바뀌면 어르신에게 결과, 보호자에게 목록 갱신 data", async () => {
    const d = deps([device("e1", "dev-e1", "tok-e1"), device("g1", "dev-g1", "tok-g1")], {});
    const original = {
      ...base,
      PK: "APPROVAL#x",
      SK: "META",
      type: "approval",
      guardianIds: ["g1"],
    };
    const modify = (oldStatus: string, newStatus: string, extra: object = {}) => {
      const r = record("MODIFY", { ...original, status: newStatus, ...extra });
      const old = record("INSERT", { ...original, status: oldStatus });
      return { ...r, dynamodb: { ...r.dynamodb, OldImage: old.dynamodb?.NewImage } };
    };
    await createPushHandler(() => d.value)({
      Records: [
        modify("pending", "approved", { respondedBy: "g1", respondedByLabel: "큰딸" }),
        modify("approved", "approved"),
      ],
    });
    expect(d.sent).toEqual([
      {
        token: "tok-e1",
        data: {
          kind: "approval",
          id: base.id,
          status: "approved",
          respondedBy: "g1",
          respondedByLabel: "큰딸",
        },
      },
      {
        token: "tok-g1",
        data: { kind: "approval", id: base.id, status: "approved", elderId: "e1" },
      },
    ]);
  });
});
