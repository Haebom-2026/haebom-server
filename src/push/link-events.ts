/**
 * 연결 항목(ELDER#/LINK#)이 생기거나 지워지면 어르신·보호자 기기 모두에 FCM data 를 보낸다.
 * 앱은 받으면 #18·#20 을 다시 조회한다 (고령자 앱 요청 3.2).
 *   { kind: "link", change: "created" | "deleted", elderId, guardianId }
 */
import type { AttributeValue as LambdaAttributeValue, DynamoDBRecord } from "aws-lambda";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { DeviceRecord } from "../core/model.js";
import type { Logger } from "../shared/logger.js";
import type { FcmMessage, FcmSender } from "./fcm.js";

export interface LinkChange {
  change: "created" | "deleted";
  elderId: string;
  guardianId: string;
}

function image(
  raw: Record<string, LambdaAttributeValue> | undefined,
): Record<string, unknown> | undefined {
  return raw === undefined ? undefined : unmarshall(raw as Record<string, AttributeValue>);
}

export function linkChangeFromRecord(record: DynamoDBRecord): LinkChange | undefined {
  const change =
    record.eventName === "INSERT"
      ? "created"
      : record.eventName === "REMOVE"
        ? "deleted"
        : undefined;
  if (change === undefined) return undefined;
  const item = image(change === "created" ? record.dynamodb?.NewImage : record.dynamodb?.OldImage);
  if (item?.type !== "link") return undefined;
  const { elderId, guardianId } = item;
  if (typeof elderId !== "string" || typeof guardianId !== "string") return undefined;
  return { change, elderId, guardianId };
}

export interface PushDeps {
  listDevices(uid: string): Promise<DeviceRecord[]>;
  deleteDevice(uid: string, deviceId: string): Promise<void>;
  sender: FcmSender;
  log: Logger;
}

/** uid 의 모든 기기에 보낸다. 무효 토큰은 지우고, 일시 오류는 throw (Streams 재시도). */
export async function sendToUser(
  uid: string,
  data: Record<string, string>,
  deps: PushDeps,
  notification?: FcmMessage["notification"],
) {
  const devices = await deps.listDevices(uid);
  let sent = 0;
  for (const device of devices) {
    const result = await deps.sender.send({
      token: device.fcmToken,
      data,
      ...(notification === undefined ? {} : { notification }),
    });
    if (result === "unregistered") {
      deps.log.info("removing unregistered device", { uid, deviceId: device.deviceId });
      await deps.deleteDevice(uid, device.deviceId);
    } else {
      sent++;
    }
  }
  return sent;
}

export async function notifyLinkChange(change: LinkChange, deps: PushDeps): Promise<void> {
  const data = { kind: "link", ...change };
  const elderSent = await sendToUser(change.elderId, data, deps);
  const guardianSent = await sendToUser(change.guardianId, data, deps);
  deps.log.info("link change pushed", { change: change.change, elderSent, guardianSent });
}
