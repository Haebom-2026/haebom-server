/**
 * 민감 정보 마스킹 (docs/server-plan.md 7.4, 서버 이중 방어).
 * 앱이 이미 거르지만, 서버에서도 저장·LLM 전달 전에 한 번 더 가린다.
 * 마스킹 건수만 메트릭으로 남기고 원래 값은 어디에도 남기지 않는다.
 */

const MASK = "***";

/** 순서가 중요하다: 긴 패턴(주민·카드)을 먼저 가려야 계좌 패턴이 일부만 먹지 않는다. */
const PATTERNS: readonly RegExp[] = [
  // 주민등록번호
  /(?<!\d)\d{6}-?[1-4]\d{6}(?!\d)/g,
  // 카드번호
  /(?<!\d)\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}(?!\d)/g,
  // 하이픈·점·띄어쓰기로 끊긴 긴 번호 (계좌·전화번호 등): 숫자 10자리 이상
  /(?<![\d-])\d{2,6}(?:[-. ]\d{2,7}){2,3}(?![\d-])/g,
  // 붙어 있는 긴 숫자열 (계좌 형태 10~14자리)
  /(?<!\d)\d{10,14}(?!\d)/g,
  // 금액 표현
  /\d[\d,]*\s?원/g,
  // "원" 없이 쉼표로 묶인 금액·잔액 (1,234 이상, 은행 화면에 흔함)
  /(?<![\d,])\d{1,3}(?:,\d{3})+(?![\d,])/g,
];

const digitCount = (value: string): number => value.replace(/\D/g, "").length;

export interface MaskResult {
  text: string;
  count: number;
}

/**
 * 인증번호·비밀번호처럼 짧은 숫자는 위 패턴에 안 걸린다 → 이름표가 붙어 있을 때만 숫자를 가린다
 * ("인증번호 123456", "비밀번호는 1234", "OTP: 987654"). 이름표는 남긴다.
 */
const SECRET_NUMBER =
  /(인증\s*번호|인증\s*코드|비밀\s*번호|비번|암호|OTP|otp|PIN|pin|핀\s*번호|보안\s*카드(?:\s*번호)?)(\s*(?:는|은|이|가|을|를)?\s*[:=]?\s*)\d(?:[\d\s-]*\d)?/g;

export function maskText(input: string): MaskResult {
  let count = 0;
  let text = input.replace(SECRET_NUMBER, (_match, label: string, gap: string) => {
    count += 1;
    return `${label}${gap}${MASK}`;
  });
  PATTERNS.forEach((pattern, index) => {
    text = text.replace(pattern, (match) => {
      // 하이픈 패턴은 숫자가 10자리 이상일 때만 (날짜 2026-11-26 같은 것 제외)
      if (index === 2 && digitCount(match) < 10) return match;
      count += 1;
      return MASK;
    });
  });
  return { text, count };
}

/** 객체·배열 안의 모든 문자열 값을 마스킹한 복사본과 총 건수. 키 이름은 건드리지 않는다. */
export function maskDeep<T>(value: T): { value: T; count: number } {
  let count = 0;
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") {
      const result = maskText(item);
      count += result.count;
      return result.text;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)]));
    }
    return item;
  };
  return { value: walk(value) as T, count };
}
