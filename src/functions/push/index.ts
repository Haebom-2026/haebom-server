import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from "aws-lambda";
import { createAwsCoreStore } from "../../core/aws-store.js";
import { createFcmSender } from "../../push/fcm.js";
import { linkChangeFromRecord, notifyLinkChange, type PushDeps } from "../../push/link-events.js";
import { requireEnv } from "../../shared/config.js";
import { createLogger } from "../../shared/logger.js";
import { createSecretLoader } from "../../shared/secrets.js";

const log = createLogger({ service: "push" });

let deps: PushDeps | undefined;
function getDeps(): PushDeps {
  if (deps === undefined) {
    const store = createAwsCoreStore(requireEnv("TABLE_MAIN"));
    deps = {
      listDevices: (uid) => store.listDevices(uid),
      deleteDevice: (uid, deviceId) => store.deleteDevice(uid, deviceId),
      sender: createFcmSender({
        loadServiceAccount: createSecretLoader(requireEnv("FCM_SECRET_ID")),
        projectId: requireEnv("FIREBASE_PROJECT_ID"),
      }),
      log,
    };
  }
  return deps;
}

/**
 * push-fn: haebom-main Streams → FCM.
 * S1: 연결 생성·해제. S2·S3 에서 알림·승인을 추가한다.
 * 실패한 레코드부터 다시 받도록 첫 실패에서 멈추고 batchItemFailures 로 돌려준다.
 * (Lambda 는 두 번째 인자로 context 를 넘기므로 의존성은 팩토리로 주입한다.)
 */
export function createPushHandler(resolveDeps: () => PushDeps) {
  return async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
    for (const record of event.Records) {
      try {
        const change = linkChangeFromRecord(record);
        if (change !== undefined) await notifyLinkChange(change, resolveDeps());
      } catch (error) {
        log.error("push failed", { error, eventId: record.eventID });
        const id = record.dynamodb?.SequenceNumber;
        return { batchItemFailures: id === undefined ? [] : [{ itemIdentifier: id }] };
      }
    }
    return { batchItemFailures: [] };
  };
}

export const handler = createPushHandler(getDeps);
