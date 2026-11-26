/**
 * 어르신이 직접 말한 전화번호 → `[번호N]` 자리표시.
 *
 * 모델·로그에는 진짜 번호를 보내지 않고, 모델이 번호 칸에 넣으라고 한 경우에만 응답에서 되돌린다.
 * (연락처 추가: "김민정 추가해 줘 / 010-1234-5678" 의 번호를 "넣기" 버튼으로 넣어 드리기 위함)
 * 화면에 보이는 번호는 대상이 아니다 — 그것은 지금처럼 *** 로 가린다.
 */

/** 한국 전화번호: 0 으로 시작, 하이픈·점·띄어쓰기로 끊기거나 붙어 있음 (9~11자리) */
const PHONE = /(?<!\d)0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}(?!\d)/g;

/** 모델이 조금 바꿔 써도 알아본다: "[번호1]", "[ 번호 1 ]" */
const PLACEHOLDER = /\[\s*번호\s*(\d+)\s*\]/g;

/** 자리표시처럼 보이지만 알아볼 수 없는 모양 (괄호 없이 "번호1" 등) */
const LOOSE_PLACEHOLDER = /번호\s*\d+/;

/** 번호를 넣어도 되는 칸인지: 칸 글자나 앱이 알려 준 입력 상태 */
const PHONE_FIELD = /전화|번호|휴대|핸드폰|연락처|phone|mobile|\btel\b/i;

export const SPOKEN_NUMBER = "말씀하신 번호";

/** `[번호N]` → 어르신이 말한 그대로의 번호 */
export type PhoneSlots = ReadonlyMap<string, string>;

const placeholder = (n: number): string => `[번호${String(n)}]`;

/** 객체 안의 모든 문자열에서 전화번호를 자리표시로 바꾼다. 같은 번호(숫자 기준)는 같은 자리표시. */
export function extractPhones<T>(value: T): { value: T; phones: Map<string, string> } {
  const phones = new Map<string, string>();
  const byDigits = new Map<string, string>();
  const replace = (text: string): string =>
    text.replace(PHONE, (match) => {
      const digits = match.replace(/\D/g, "");
      let key = byDigits.get(digits);
      if (key === undefined) {
        key = placeholder(phones.size + 1);
        byDigits.set(digits, key);
        phones.set(key, match);
      }
      return key;
    });
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return replace(item);
    if (Array.isArray(item)) return item.map(walk);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([k, inner]) => [k, walk(inner)]));
    }
    return item;
  };
  return { value: walk(value) as T, phones };
}

export const isPhoneField = (text: string | undefined): boolean =>
  text !== undefined && PHONE_FIELD.test(text);

/**
 * type_text 의 자리표시를 진짜 번호로 되돌린다.
 * 번호 칸이 아니거나, 모르는 자리표시·알아볼 수 없는 모양이면 undefined (넣기 버튼 없이 직접 쓰시게).
 */
export function restorePhones(
  text: string,
  phones: PhoneSlots,
  phoneField: boolean,
): string | undefined {
  if (!phoneField) return undefined;
  const keys = [...text.matchAll(PLACEHOLDER)].map((m) => placeholder(Number(m[1])));
  if (keys.some((key) => !phones.has(key))) return undefined;
  const restored = text.replace(
    PLACEHOLDER,
    (_m, n: string) => phones.get(placeholder(Number(n))) ?? "",
  );
  if (LOOSE_PLACEHOLDER.test(restored)) return undefined;
  return restored.trim() === "" ? undefined : restored;
}

/** 안내 말·선택지의 자리표시는 읽을 수 있는 말로 */
export const speakPhones = (text: string): string =>
  text
    .replace(PLACEHOLDER, SPOKEN_NUMBER)
    .replace(/\[\s*번호\s*\d+|번호\s*\d+\s*\]/g, SPOKEN_NUMBER);
