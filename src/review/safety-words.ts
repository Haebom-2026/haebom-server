/**
 * 지도 학습에서 쓰는 글자·화면 검사 (docs/jev-routing-plan.md 3.3·7.3·8.2).
 * - 민감한 행동: 이런 버튼·화면은 공유 연결선(이동)이 될 수 없고, 목표의 끝 단계(멈춤 포함)로만
 * - 학습 제외 앱: 대화·메일·메모·금융·건강 앱 화면을 지난 명령은 학습하지 않음
 * - 화면 속 지시 흔적: 이런 글자가 있던 화면을 지나간 명령은 학습하지 않음
 */
import type { ScreenDocument } from "../debug/store.js";
import { normalizeName, type IndexedMap } from "../route/map.js";

const SENSITIVE_WORDS = [
  "설치",
  "허용",
  "동의",
  "보내기",
  "전송",
  "송금",
  "이체",
  "결제",
  "구매",
  "주문",
  "삭제",
  "탈퇴",
  "해지",
  "확인",
  "완료",
  "등록",
  "신청",
  "발급",
  "인증",
  "로그인",
  "가입",
  "충전",
  "사용 중에만",
  "이번만",
  "install",
  "allow",
  "agree",
  "send",
  "pay",
  "buy",
  "delete",
  "confirm",
];

/** 누를 글자가 민감한 행동인가 (띄어쓰기·대소문자 무시) */
export function isSensitiveLabel(text: string): boolean {
  const t = normalizeName(text);
  return SENSITIVE_WORDS.some((w) => t.includes(normalizeName(w)));
}

/** 시스템 권한 창·앱 설치 창 패키지 (여기서 누른 것은 이동이 아님) */
const SYSTEM_SENSITIVE_PACKAGES = [
  /permissioncontroller/i,
  /packageinstaller/i,
  /^com\.android\.vending$/i,
  /deviceadmin|devicepolicy/i,
];

const truthy = (node: Record<string, unknown>, key: string) => node[key] === true;

/**
 * 출발 화면이 민감한 화면인가 (3.3): 권한·설치 창, 비밀번호 칸, 금액이 보이는 화면.
 * 이런 화면에서 한 행동은 글자가 평범해도 이동으로 쓰지 않는다.
 */
export function isSensitiveScreen(doc: ScreenDocument | undefined): boolean {
  if (!doc) return true;
  if (SYSTEM_SENSITIVE_PACKAGES.some((p) => p.test(doc.pkg))) return true;
  return doc.screen.nodes.some((n) => {
    const node = n as Record<string, unknown>;
    if (truthy(node, "password") || truthy(node, "secret")) return true;
    const text = `${n.t ?? ""} ${n.d ?? ""}`;
    return /\d[\d,]*\s?원|\*{3}/.test(text);
  });
}

/** 학습 제외 역할 (8.2): 대화·메일·메모·금융·건강 */
const EXCLUDED_ROLES = new Set([
  "messaging",
  "mail",
  "memo",
  "bank",
  "pay",
  "health_ins",
  "hospital",
]);
const EXCLUDED_PACKAGE_PATTERNS = [
  /bank|banking|pay|wallet|card|stock|invest|coin|upbit|bithumb|toss/i,
  /kakao\.talk|messag|mms|sms|mail|memo|note/i,
  /health|medical|hospital|nhis|pharm/i,
];

/** 이 패키지 화면을 지난 명령은 학습하지 않는가 */
export function isExcludedPackage(pkg: string, map: IndexedMap): boolean {
  if (EXCLUDED_PACKAGE_PATTERNS.some((p) => p.test(pkg))) return true;
  return map.map.apps.some(
    (a) =>
      a.packages.includes(pkg) &&
      a.roles.some((r) => EXCLUDED_ROLES.has(r) || map.roles.get(r)?.sensitive),
  );
}

const INJECTION_PATTERNS: readonly RegExp[] = [
  /(AI|에이아이|도우미|어시스턴트|assistant|claude|gpt|모델|검토자?)\s*(는|은|에게|야|님|가)?.{0,30}(누르|눌러|따르|무시|해\s*줘|하세요|응답|답하|답해|판단해)/i,
  /(이전|위의?)\s*(지시|명령|안내).{0,10}(무시|잊)/,
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
  /\b(success|evidence|sensitiveSeqs|personalText|moves|finish|goal)\b\s*[=:]/i,
  /<\/?\s*(record|system|assistant|user|instructions?|prompt)\b/i,
  /(검토|판정|결과)\s*(는|은|를|을)?.{0,15}(성공|yes|통과)\s*(으로|로)?\s*(해|하라|응답|답)/i,
  /https?:\/\/|www\.|\.(com|net|kr|xyz|top|io|ly|me)\b/i,
];

/** 화면 글자에 지시문·검토 조작·링크 흔적이 있는가 */
export function hasInjectionMarker(text: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(text));
}
