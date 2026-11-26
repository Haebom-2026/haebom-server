import type { ScheduledEvent } from "aws-lambda";
import { createLogger } from "../../shared/logger.js";

const log = createLogger({ service: "expire" });

/** expire-fn: 1분마다 만료된 pending 승인 → expired (S3 에서 구현). */
export const handler = (event: ScheduledEvent): Promise<void> => {
  log.info("expire tick", { scheduledAt: event.time });
  return Promise.resolve();
};
