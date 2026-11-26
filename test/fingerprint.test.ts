import { describe, expect, it } from "vitest";
import { fingerprint, fingerprintTokens, normalizeText } from "../src/cache/fingerprint.js";

const base = {
  pkg: "kr.go.gov24",
  width: 1080,
  height: 2400,
  nodes: [
    { t: "민원 신청", c: "Button", b: [100, 500, 500, 600] as const },
    { t: "오후 3:24", c: "TextView", b: [900, 10, 1070, 60] as const },
    { d: "뒤로 가기", c: "ImageButton", b: [0, 80, 120, 200] as const },
  ],
};

describe("fingerprint fp@v1", () => {
  it("숫자를 #로 바꿔 시계·알림 숫자에 흔들리지 않는다", () => {
    expect(normalizeText("  오후  3:24 ")).toBe("오후 #:##");
    const later = {
      ...base,
      nodes: base.nodes.map((n) => (n.t === "오후 3:24" ? { ...n, t: "오후 3:25" } : n)),
    };
    expect(fingerprint(later)).toBe(fingerprint(base));
  });

  it("노드 순서가 달라도 같다", () => {
    expect(fingerprint({ ...base, nodes: [...base.nodes].reverse() })).toBe(fingerprint(base));
  });

  // 반올림 경계(예: 가로 85%)를 넘는 이동은 칸이 바뀐다 — fp@v1 의 알려진 한계, 뷰어로 실제 빈도를 본다.
  it("칸 경계를 넘지 않는 작은 이동은 같은 지문", () => {
    const shifted = {
      ...base,
      nodes: base.nodes.map((n) => ({
        ...n,
        b: [n.b[0] + 10, n.b[1] + 15, n.b[2], n.b[3]] as const,
      })),
    };
    expect(fingerprint(shifted)).toBe(fingerprint(base));
  });

  it("글자가 다르거나 앱이 다르면 다르다", () => {
    const other = {
      ...base,
      nodes: [{ ...base.nodes[0], t: "증명서 발급" }, ...base.nodes.slice(1)],
    };
    expect(fingerprint(other)).not.toBe(fingerprint(base));
    expect(fingerprint({ ...base, pkg: "com.other" })).not.toBe(fingerprint(base));
  });

  it("글자·클래스 없는 노드는 빠진다", () => {
    const tokens = fingerprintTokens({
      ...base,
      nodes: [...base.nodes, { b: [0, 0, 10, 10] as const }],
    });
    expect(tokens).toHaveLength(3);
  });

  it("16자 hex", () => {
    expect(fingerprint(base)).toMatch(/^[0-9a-f]{16}$/);
  });
});
