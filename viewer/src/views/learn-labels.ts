/** R3~R5 글자 (서버 src/map/guide.ts·learn.ts·review/review.ts 의 값) */

/** 지도가 Claude 로 넘긴 이유 (src/map/guide.ts) */
export const MAP_REASON: Record<string, string> = {
  ended: "끝난 명령",
  "already-ai": "이미 Claude 가 안내 중",
  "claude-started": "Claude 가 먼저 시작함",
  "no-goal": "고른 목표 없음",
  "unsafe-command": "사기 의심·L3·degraded",
  "unknown-goal": "jev 지도에 없는 목표",
  "goal-not-mappable": "값이 필요하거나 검증 안 된 목표",
  "no-map": "배운 지도에 verified 목표 없음 (또는 차단)",
  "other-app": "다른 앱 화면",
  "sensitive-screen": "민감한 화면",
  "not-followed": "안내를 안 따르고 화면이 바뀜",
  "resend-limit": "같은 안내를 너무 많이 다시 줌",
  "resend-broken": "다시 줄 안내가 깨짐",
  "edge-gone": "따르던 연결선이 사라짐",
  "different-action": "다른 행동을 함",
  "different-target": "다른 것을 누름",
  "unexpected-screen": "연결선 도착 화면이 아님 (실패로 셈)",
  "finish-gone": "끝 단계가 사라짐",
  "finish-not-verified": "끝 단계 뒤 화면이 그대로",
  "finish-unexpected-screen": "끝 단계 뒤 다른 화면 (실패로 셈)",
  "finish-complete": "끝 단계를 다 함 → 다 됐는지는 Claude",
  "finish-needs-ai": "민감하거나 확인 못 하는 끝 단계",
  "no-path": "여기서 도착 화면까지 길 없음",
  "no-target-text": "누를 글자가 없음",
  "sensitive-target": "누를 것이 민감함",
  "target-disabled": "누를 것이 꺼져 있음",
  "target-is-input": "누를 것이 입력칸",
  "target-not-unique": "같은 글자가 여러 개",
};

export const mapReason = (reason: string | undefined): string => {
  if (!reason) return "";
  if (reason.startsWith("progress-")) return `진행 상태 저장 실패 (${reason.slice(9)})`;
  if (reason.startsWith("resend-") && !MAP_REASON[reason])
    return `다시 주기 저장 실패 (${reason.slice(7)})`;
  return MAP_REASON[reason] ?? reason;
};

export const STATUS_LABEL: Record<string, string> = {
  verified: "verified",
  candidate: "후보",
  retired: "은퇴",
};

export const OUTCOME_LABEL: Record<string, string> = {
  accept: "accept · 자동 반영 후보",
  human: "human · 사람 확인",
  reject: "reject · 배우지 않음",
  error: "error · 모델 오류",
};

export const PENDING_REASON: Record<string, string> = {
  human_review: "검토가 사람 확인",
  new_goal: "새 목표",
  sensitive_goal: "L2 이상",
  sensitive_finish: "민감한 끝 단계",
  finish_conflict: "끝 단계가 기존과 다름",
};

export const END_LABEL: Record<string, string> = {
  done: "done · 다 함",
  gave_up: "gave_up · 포기",
  stopped_user: "stopped_user · 어르신이 멈춤",
  stopped_safe: "stopped_safe · 안전하게 멈춤",
};

/** 최근 결과 1/0 → "성공 3 · 실패 1" */
export function recentLine(recent: readonly number[] | undefined): string {
  if (!recent?.length) return "–";
  const ok = recent.filter((r) => r === 1).length;
  return `성공 ${ok} · 실패 ${recent.length - ok}`;
}

export const short = (id: string | undefined, n = 8): string => (id ? id.slice(0, n) : "–");
