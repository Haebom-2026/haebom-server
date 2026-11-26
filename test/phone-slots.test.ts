import { describe, expect, it } from "vitest";
import {
  SPOKEN_NUMBER,
  extractPhones,
  isPhoneField,
  restorePhones,
  speakPhones,
} from "../src/ai/phone-slots.js";
import { maskText } from "../src/shared/sensitive.js";

describe("extractPhones", () => {
  it("어르신이 말한 번호를 [번호N] 으로, 같은 번호는 같은 자리표시로", () => {
    const { value, phones } = extractPhones({
      utterance: "김민정 추가해 줘 / 010-1234-5678",
      slots: { answer: "01012345678", other: "010 9876 5432" },
      history: ["번호를 말씀해 주세요."],
    });
    expect(value.utterance).toBe("김민정 추가해 줘 / [번호1]");
    expect(value.slots).toEqual({ answer: "[번호1]", other: "[번호2]" });
    expect([...phones]).toEqual([
      ["[번호1]", "010-1234-5678"],
      ["[번호2]", "010 9876 5432"],
    ]);
  });

  it("지역번호·점 형식도, 날짜·짧은 숫자는 그대로", () => {
    const { value } = extractPhones({ a: "02-123-4567", b: "010.1234.5678", c: "2026-11-26 3시" });
    expect(value).toEqual({ a: "[번호1]", b: "[번호2]", c: "2026-11-26 3시" });
  });
});

describe("restorePhones", () => {
  const phones = new Map([["[번호1]", "010-1234-5678"]]);

  it("번호 칸이면 자리표시를 되돌린다 (모델이 띄어 써도)", () => {
    expect(restorePhones("[번호1]", phones, true)).toBe("010-1234-5678");
    expect(restorePhones("[ 번호 1 ]", phones, true)).toBe("010-1234-5678");
  });

  it("번호 칸이 아니거나, 모르는 자리표시·알아볼 수 없는 모양이면 넣지 않는다", () => {
    expect(restorePhones("[번호1]", phones, false)).toBeUndefined();
    expect(restorePhones("[번호2]", phones, true)).toBeUndefined();
    expect(restorePhones("번호1", phones, true)).toBeUndefined();
  });

  it("번호 칸 판단: 칸 글자나 입력 상태", () => {
    expect(isPhoneField("전화번호")).toBe(true);
    expect(isPhoneField("키보드 열림 · 입력 중: 휴대전화")).toBe(true);
    expect(isPhoneField("이름")).toBe(false);
    expect(isPhoneField(undefined)).toBe(false);
  });

  it("안내 말의 자리표시는 '말씀하신 번호'로", () => {
    expect(speakPhones("[번호1]을 넣을게요")).toBe(`${SPOKEN_NUMBER}을 넣을게요`);
    expect(speakPhones("전화번호 칸을 누르세요")).toBe("전화번호 칸을 누르세요");
  });
});

describe("maskText: 띄어쓴 번호", () => {
  it("띄어쓰기·점으로 끊긴 10자리 이상 번호도 가린다", () => {
    expect(maskText("010 1234 5678 로 전화").text).toBe("*** 로 전화");
    expect(maskText("010.1234.5678").text).toBe("***");
    expect(maskText("2026 11 26").text).toBe("2026 11 26");
  });
});
