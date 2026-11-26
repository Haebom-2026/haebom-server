/**
 * 화면 지문 (docs/server-plan.md 12.7, 9장 캐싱 준비).
 * "지금 어느 화면인지" 를 같은 값으로 묶기 위한 키. 디버그 뷰어와 캐싱 계층이 같은 함수를 쓴다.
 *
 * fp@v1 규칙 (지침서 3.3 "글자 + 위치 10% 반올림" 을 출발점으로):
 * - 노드마다 `클래스 | 정규화한 글자 | 위치 칸(가로·세로 10등분)` 토큰을 만든다.
 * - 글자 정규화: 앞뒤 공백 제거, 연속 공백 하나로, **숫자는 모두 #** (시계·알림 숫자·날짜에 흔들리지 않게), 30자까지.
 * - 글자도 클래스도 없는 노드는 뺀다.
 * - 토큰을 정렬·중복 제거해 노드 순서가 바뀌어도 같은 값이 나오게 한다.
 * - pkg 와 함께 SHA-256 → 앞 16자.
 *
 * 규칙을 바꾸면 버전을 올린다 (저장된 지문과 섞이지 않게, 보관 세션에 다시 돌려 비교).
 */
import { createHash } from "node:crypto";

export const FINGERPRINT_VERSION = "fp@v1";

export interface FingerprintNode {
  t?: string | undefined;
  d?: string | undefined;
  c?: string | undefined;
  b?: readonly [number, number, number, number] | undefined;
}

export interface FingerprintInput {
  pkg: string;
  width: number;
  height: number;
  nodes: readonly FingerprintNode[];
}

export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/\d/g, "#").slice(0, 30);
}

const cell = (value: number, size: number): number =>
  size > 0 ? Math.min(10, Math.max(0, Math.round((value / size) * 10))) : 0;

export function fingerprintTokens(input: FingerprintInput): string[] {
  const tokens = new Set<string>();
  for (const node of input.nodes) {
    const text = normalizeText(node.t ?? node.d ?? "");
    const cls = node.c ?? "";
    if (text === "" && cls === "") continue;
    const pos = node.b ? `${cell(node.b[0], input.width)},${cell(node.b[1], input.height)}` : "-";
    tokens.add(`${cls}|${text}|${pos}`);
  }
  return [...tokens].sort();
}

export function fingerprint(input: FingerprintInput): string {
  const hash = createHash("sha256");
  hash.update(input.pkg);
  for (const token of fingerprintTokens(input)) hash.update("\n" + token);
  return hash.digest("hex").slice(0, 16);
}
