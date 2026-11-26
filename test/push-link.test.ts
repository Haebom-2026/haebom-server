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
