/**
 * 화면 지도에서 "같은 화면" 을 묶는 규칙.
 * fp@v1 은 서버가 계산한 지문(src/cache/fingerprint.ts)을 그대로 쓰고,
 * 나머지는 같은 토큰 규칙에서 위치·노드 범위를 바꿔 뷰어에서 계산해 비교해 보는 후보다.
 */
import type { ScreenDocument, ScreenNode } from "./types.ts";

export type RuleId = "v1" | "nopos" | "act";

export const RULES: { id: RuleId; label: string; hint: string }[] = [
  { id: "v1", label: "fp@v1 (지금)", hint: "클래스 | 글자 | 위치칸(10등분) — 서버 지문" },
  { id: "nopos", label: "위치 빼기", hint: "클래스 | 글자 — 스크롤·밀림에 안 갈림" },
  {
    id: "act",
    label: "누를 수 있는 것만",
    hint: "누르기·입력·스크롤·체크 가능한 노드의 클래스 | 글자 — 화면 종류에 가까움",
  },
];

/** 서버 normalizeText 와 같은 규칙: 공백 정리, 숫자 → #, 30자 */
export const normalizeText = (text: string): string =>
  text.trim().replace(/\s+/g, " ").replace(/\d/g, "#").slice(0, 30);

export const isActionable = (node: ScreenNode): boolean =>
  node.clickable === true ||
  node.editable === true ||
  node.scrollable === true ||
  node.checkable === true;

function tokens(doc: ScreenDocument, rule: Exclude<RuleId, "v1">): string[] {
  const out = new Set<string>();
  for (const node of doc.screen.nodes) {
    if (rule === "act" && !isActionable(node)) continue;
    const text = normalizeText(node.t ?? node.d ?? "");
    const cls = node.c ?? "";
    if (text === "" && cls === "") continue;
    out.add(`${cls}|${text}`);
  }
  return [...out].sort();
}

/** 같은 값이면 같은 화면으로 묶는다 (pkg 포함) */
export function ruleKey(doc: ScreenDocument, rule: RuleId): string {
  if (rule === "v1") return `${doc.pkg}#${doc.fingerprint}`;
  return `${doc.pkg}#${tokens(doc, rule).join("\n")}`;
}
