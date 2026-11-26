import type { ScheduledEvent } from "aws-lambda";
import { expireDue } from "../../core/approval-routes.js";
import { createAwsApprovalStore } from "../../core/approval-store.js";
import type { ApprovalStore } from "../../core/approvals.js";
import { requireEnv } from "../../shared/config.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger({ service: "expire" });

let approvals: ApprovalStore | undefined;

/**
 * expire-fn: 1분마다 응답 시간이 지난 pending 승인 → expired (docs/server-plan.md 6장).
 * 상태가 바뀌면 push-fn 이 고령자 기기에 결과를 보낸다. API 도 읽을 때 만료를 판정하므로
 * 이 함수가 늦어도 앱에는 정확한 상태가 보인다.
 */
export function createExpireHandler(
  resolve: () => ApprovalStore,
  now: () => Date = () => new Date(),
) {
  return async (event: ScheduledEvent): Promise<{ expired: number }> => {
    const expired = await expireDue(resolve(), now(), log.child({ scheduledAt: event.time }));
    return { expired };
  };
}

export const handler = createExpireHandler(() => {
  approvals ??= createAwsApprovalStore(requireEnv("TABLE_MAIN"));
  return approvals;
});
