import { describe, expect, it } from "vitest";
import { maskDeep, maskText } from "../src/shared/sensitive.js";

describe("maskText", () => {
  it.each([
    ["주민번호 900101-1234567 입니다", "주민번호 *** 입니다"],
    ["카드 1234-5678-9012-3456", "카드 ***"],
    ["계좌 110-123-456789", "계좌 ***"],
    ["계좌 12345678901234", "계좌 ***"],
    ["전화 010-1234-5678", "전화 ***"],
    ["50,000원 보내기", "*** 보내기"],
  ])("%s", (input, expected) => {
    expect(maskText(input).text).toBe(expected);
  });

  it("날짜·시각·짧은 숫자는 그대로", () => {
    const input = "2026-11-26 오후 3:24 알림 12개";
    expect(maskText(input)).toEqual({ text: input, count: 0 });
  });

  it("원 없이 쉼표로 묶인 금액도 가린다", () => {
    expect(maskText("잔액 1,234,567 / 출금 12,000").text).toBe("잔액 *** / 출금 ***");
    expect(maskText("1,000원 미만 999개").text).toBe("*** 미만 999개");
  });

  it("건수를 센다", () => {
    expect(maskText("900101-1234567, 1000원").count).toBe(2);
  });
});

describe("maskDeep", () => {
  it("중첩된 문자열만 가리고 키·숫자는 유지", () => {
    const result = maskDeep([{ i: 1, t: "잔액 1,200원", extra: { note: "12345678901" } }]);
    expect(result.value).toEqual([{ i: 1, t: "잔액 ***", extra: { note: "***" } }]);
    expect(result.count).toBe(2);
  });
});
