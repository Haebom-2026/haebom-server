/**
 * 지도용 화면 지문 mfp@v1 (docs/jev-routing-plan.md 3.7).
 *
 * fp@v1(글자·위치·클래스, 숫자는 #) 에 노드 상태(체크·선택·켜짐)를 더한다. 값만 다른 화면
 * (스위치 켜짐/꺼짐)을 같은 화면으로 보지 않기 위해서다.
 * **가린 노드**(maskDeep 뒤)로 계산한다: 디버그 저장소의 화면도 가린 뒤 저장되므로, 학습한 지문과
 * 안내할 때의 지문이 같은 규칙으로 나온다.
 * 지도 안내는 이 지문이 학습한 화면의 지문과 **정확히 같을 때만** 쓴다 (비슷함은 안 씀).
 */
import { createHash } from "node:crypto";
import { fingerprintTokens, normalizeText, type FingerprintInput } from "../cache/fingerprint.js";

export const MAP_FINGERPRINT_VERSION = "mfp@v1";

const STATE_KEYS = ["checked", "selected"] as const;

/** fp@v1 과 같은 위치 칸 (가로·세로 10등분) */
const cell = (value: number, size: number): number =>
  size > 0 ? Math.min(10, Math.max(0, Math.round((value / size) * 10))) : 0;

export function mapFingerprint(
  input: Omit<FingerprintInput, "nodes"> & { nodes: readonly object[] },
): string {
  const hash = createHash("sha256");
  hash.update(`${MAP_FINGERPRINT_VERSION}\n${input.pkg}`);
  // 글자(t)가 비어 있으면 설명(d)을 글자로 (fp@v1 은 t ?? d 라 빈 t 에서 d 를 버림. 지도용은 nodeLabel 과 같은 규칙)
  type LabeledNode = Record<string, unknown> & { t?: string | undefined; d?: undefined };
  const nodes = (input.nodes as readonly Record<string, unknown>[]).map((node): LabeledNode => {
    const t = typeof node.t === "string" ? node.t.trim() : "";
    const d = typeof node.d === "string" ? node.d.trim() : "";
    return { ...node, t: t !== "" ? t : d !== "" ? d : undefined, d: undefined };
  });
  for (const token of fingerprintTokens({ ...input, nodes: nodes })) hash.update("\n" + token);
  const states: string[] = [];
  for (const node of nodes) {
    for (const key of STATE_KEYS) {
      if (node[key] === true) {
        const label = normalizeText(node.t ?? "");
        // 어느 컨트롤의 상태인지: 종류 + 위치 칸 (글자가 같거나 없는 스위치 둘을 구분)
        const cls = typeof node.c === "string" ? node.c : "";
        const b = Array.isArray(node.b) ? (node.b as number[]) : undefined;
        const pos =
          b && b.length === 4
            ? `${cell(b[0] ?? 0, input.width)},${cell(b[1] ?? 0, input.height)}`
            : "-";
        states.push(`${key}|${cls}|${label}|${pos}`);
      }
    }
  }
  for (const s of states.sort()) hash.update("\nS:" + s);
  return hash.digest("hex").slice(0, 16);
}
