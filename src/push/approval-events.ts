/**
 * 승인 FCM (보호자 앱 요청 2.5, 고령자 앱 요청 3.4).
 *  - 보호자 항목(GUARDIAN#/APPROVAL#) INSERT → 그 보호자: 화면 알림 approval_requests
 *      data { kind: "approval", id, elderId }
 *  - 원본(APPROVAL#/META) 상태가 pending 에서 바뀜 → 고령자: 결과 data 메시지
 *      data { kind: "approval", id, status, respondedBy?, respondedByLabel? }
 *    + 남은 보호자들: 목록 갱신용 data 메시지 { kind: "approval", id, status, elderId }
 */
import type { AttributeValue as LambdaAttributeValue, DynamoDBRecord } from "aws-lambda";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { FcmMessage } from "./fcm.js";
import { sendToUser, type PushDeps } from "./link-events.js";

type Image = Record<string, unknown>;

function image(raw: Record<string, LambdaAttributeValue> | undefined): Image | undefined {
  return raw === undefined ? undefined : unmarshall(raw as Record<string, AttributeValue>);
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

export type ApprovalEvent =
  | { kind: "request"; id: string; guardianId: string; elderId: string }
  | {
      kind: "result";
      id: string;
      elderId: string;
      status: string;
      guardianIds: string[];
      respondedBy?: string;
      respondedByLabel?: string;
    };

export function approvalEventFromRecord(record: DynamoDBRecord): ApprovalEvent | undefined {
  const next = image(record.dynamodb?.NewImage);
  if (record.eventName === "INSERT" && next?.type === "guardian_approval") {
    const id = str(next.id);
    const guardianId = str(next.guardianId);
    const elderId = str(next.elderId);
    if (id && guardianId && elderId) return { kind: "request", id, guardianId, elderId };
    return undefined;
  }
  if (record.eventName === "MODIFY" && next?.type === "approval") {
    const prev = image(record.dynamodb?.OldImage);
    if (prev?.status !== "pending" || next.status === "pending") return undefined;
    const guardianIds = Array.isArray(next.guardianIds)
      ? next.guardianIds.filter((v): v is string => typeof v === "string")
      : [];
    const respondedBy = str(next.respondedBy);
    const respondedByLabel = str(next.respondedByLabel);
    return {
      kind: "result",
      id: str(next.id),
      elderId: str(next.elderId),
      status: str(next.status),
      guardianIds,
      ...(respondedBy ? { respondedBy } : {}),
      ...(respondedByLabel ? { respondedByLabel } : {}),
    };
  }
  return undefined;
}

export const APPROVAL_REQUEST_DISPLAY: NonNullable<FcmMessage["notification"]> = {
  title: "해봄 가족 · 승인 요청",
  body: "가족이 도움을 받아도 될지 물어요. 앱에서 확인해 주세요.",
  channelId: "approval_requests",
  urgent: true,
};

export async function notifyApproval(event: ApprovalEvent, deps: PushDeps): Promise<void> {
  if (event.kind === "request") {
    const sent = await sendToUser(
      event.guardianId,
      { kind: "approval", id: event.id, elderId: event.elderId },
      deps,
      APPROVAL_REQUEST_DISPLAY,
    );
    deps.log.info("approval request pushed", { sent });
    return;
  }
  const elderData: Record<string, string> = {
    kind: "approval",
    id: event.id,
    status: event.status,
  };
  if (event.respondedBy) elderData.respondedBy = event.respondedBy;
  if (event.respondedByLabel) elderData.respondedByLabel = event.respondedByLabel;
  const elderSent = await sendToUser(event.elderId, elderData, deps);
  let guardianSent = 0;
  for (const gid of event.guardianIds) {
    guardianSent += await sendToUser(
      gid,
      { kind: "approval", id: event.id, status: event.status, elderId: event.elderId },
      deps,
    );
  }
  deps.log.info("approval result pushed", { status: event.status, elderSent, guardianSent });
}
