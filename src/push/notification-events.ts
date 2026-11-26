/**
 * 보호자 알림함 항목(GUARDIAN#/NOTI#)이 생기면 그 보호자의 모든 기기에 FCM 을 보낸다.
 * 모양은 보호자 앱 요청 2.5 (ALIGNMENT_CHECKLIST 4장):
 *   data: { kind: "notification", id, type, elderId }
 *   android channel: family_activity | help_alerts | sos_alerts
 *   잠금 화면 문구는 짧게, 앱 이름·내용은 넣지 않는다.
 */
import type { AttributeValue as LambdaAttributeValue, DynamoDBRecord } from "aws-lambda";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  isUrgent,
  type Category,
  type Level,
  type NotificationType,
} from "../core/notifications.js";
import type { FcmMessage } from "./fcm.js";
import { sendToUser, type PushDeps } from "./link-events.js";

export interface InboxEvent {
  id: string;
  guardianId: string;
  elderId: string;
  type: NotificationType;
  level?: Level;
  category?: Category;
}

export function inboxEventFromRecord(record: DynamoDBRecord): InboxEvent | undefined {
  if (record.eventName !== "INSERT") return undefined;
  const raw = record.dynamodb?.NewImage as Record<string, LambdaAttributeValue> | undefined;
  if (raw === undefined) return undefined;
  const item: Record<string, unknown> = unmarshall(raw as Record<string, AttributeValue>);
  if (item.type !== "inbox") return undefined;
  const { id, guardianId, elderId, notificationType, level, category } = item;
  if (typeof id !== "string" || typeof guardianId !== "string" || typeof elderId !== "string") {
    return undefined;
  }
  if (
    notificationType !== "sensitive_entry" &&
    notificationType !== "stuck" &&
    notificationType !== "sos"
  ) {
    return undefined;
  }
  return {
    id,
    guardianId,
    elderId,
    type: notificationType,
    ...(typeof level === "string" ? { level: level as Level } : {}),
    ...(typeof category === "string" ? { category: category as Category } : {}),
  };
}

export const LOCK_SCREEN_TEXT = {
  activity: { title: "해봄 가족", body: "새 가족 알림이 도착했습니다." },
  help: {
    title: "해봄 가족 · 도움 필요",
    body: "가족에게 도움이 필요할 수 있습니다. 앱에서 확인해 주세요.",
  },
  urgent: { title: "해봄 가족 · 긴급", body: "가족이 도움을 요청했습니다. 앱에서 확인해 주세요." },
} as const;

export function notificationDisplay(event: InboxEvent): NonNullable<FcmMessage["notification"]> {
  const urgent = isUrgent(event);
  const scam = event.category === "scam" || event.level === "L3";
  const channelId =
    scam || event.type === "sos"
      ? "sos_alerts"
      : event.type === "stuck"
        ? "help_alerts"
        : "family_activity";
  // 보호자 앱이 앱 안에서 띄우는 문구와 같게 (보호자 앱 S2 검토). 앱 이름·내용은 넣지 않는다.
  const text =
    scam || event.type === "sos"
      ? LOCK_SCREEN_TEXT.urgent
      : event.type === "stuck"
        ? LOCK_SCREEN_TEXT.help
        : LOCK_SCREEN_TEXT.activity;
  return { ...text, channelId, urgent };
}

export async function notifyInbox(event: InboxEvent, deps: PushDeps): Promise<void> {
  const data = { kind: "notification", id: event.id, type: event.type, elderId: event.elderId };
  const sent = await sendToUser(event.guardianId, data, deps, notificationDisplay(event));
  deps.log.info("notification pushed", { type: event.type, urgent: isUrgent(event), sent });
}
