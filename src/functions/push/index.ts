import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from "aws-lambda";
import { createLogger } from "../../shared/logger.js";

const log = createLogger({ service: "push" });

/**
 * push-fn: haebom-main Streams → FCM 발송 (S2·S3 에서 구현).
 * 부분 실패는 batchItemFailures 로 돌려 해당 레코드부터 재시도하게 한다.
 */
export const handler = (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  log.info("stream batch received", { records: event.Records.length });
  return Promise.resolve({ batchItemFailures: [] });
};
