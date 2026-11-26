/**
 * `uiautomator dump` XML → 디버그 뷰어 screen 형식 (docs/debug-viewer-app-guide.md 4장).
 * 의존성 없이 정규식으로 읽는다: uiautomator 출력은 한 노드가 `<node 속성…>` 한 줄 형태라 충분하다.
 */

export interface RawNode {
  attrs: Record<string, string>;
  depth: number;
}

export interface CaptureNode {
  i: number;
  t?: string;
  d?: string;
  c?: string;
  b: [number, number, number, number];
  id?: string;
  clickable?: true;
  editable?: true;
  scrollable?: true;
  checkable?: true;
  checked?: true;
  selected?: true;
  focused?: true;
  password?: true;
}

export interface CaptureScreen {
  pkg: string;
  width: number;
  height: number;
  nodes: CaptureNode[];
}

export const MAX_NODES = 60;
const MAX_TEXT = 100;
/** 상태바·내비게이션 바 등 시스템 UI 는 화면 판단에 쓰지 않는다 */
const SYSTEM_PACKAGES = new Set(["com.android.systemui"]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, code: string) => {
    if (code.startsWith("#x")) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(parseInt(code.slice(1), 10));
    return ENTITIES[code] ?? match;
  });
}

export function parseNodes(xml: string): RawNode[] {
  const nodes: RawNode[] = [];
  let depth = 0;
  // <node …> / <node …/> / </node>
  const tag = /<(\/?)node\b([^>]*?)(\/?)>/g;
  for (const match of xml.matchAll(tag)) {
    const [, closing, body = "", selfClosing] = match;
    if (closing) {
      depth -= 1;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const attr of body.matchAll(/([\w-]+)="([^"]*)"/g)) {
      const [, key, value] = attr;
      if (key !== undefined && value !== undefined) attrs[key] = decode(value);
    }
    nodes.push({ attrs, depth });
    if (!selfClosing) depth += 1;
  }
  return nodes;
}

export function parseBounds(raw: string | undefined): [number, number, number, number] | undefined {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(raw ?? "");
  if (!match) return undefined;
  const [, l, t, r, b] = match.map(Number);
  if (l === undefined || t === undefined || r === undefined || b === undefined) return undefined;
  return [l, t, r, b];
}

const shortClass = (cls: string | undefined): string | undefined =>
  cls ? (cls.split(".").pop() ?? cls) : undefined;

const yes = (value: string | undefined) => value === "true";

/** 비어 있지 않은 글자만, 100자까지 */
function text(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : undefined;
}

interface Candidate {
  order: number;
  score: number;
  node: Omit<CaptureNode, "i">;
}

/**
 * 고령자 앱이 보낼 법한 노드만 고른다:
 *   글자·설명이 있거나, 누를 수 있거나, 입력·스크롤할 수 있는 보이는 노드.
 * 60개를 넘으면 (누를 수 있고 글자 있음) > (글자 있음) > (누를 수만 있음) 순으로 남기고,
 * 남은 것은 화면 순서(문서 순서)대로 번호를 붙인다.
 */
export function toScreen(xml: string): CaptureScreen | undefined {
  const raw = parseNodes(xml);
  if (raw.length === 0) return undefined;

  // 화면 크기: 가장 큰 노드 영역 (보통 첫 루트)
  let width = 0;
  let height = 0;
  for (const { attrs } of raw) {
    const b = parseBounds(attrs.bounds);
    if (b) {
      width = Math.max(width, b[2]);
      height = Math.max(height, b[3]);
    }
  }
  if (width <= 0 || height <= 0) return undefined;

  const packageCount = new Map<string, number>();
  const candidates: Candidate[] = [];

  raw.forEach(({ attrs }, order) => {
    const pkg = attrs.package ?? "";
    if (SYSTEM_PACKAGES.has(pkg)) return;
    const b = parseBounds(attrs.bounds);
    if (!b || b[2] <= b[0] || b[3] <= b[1]) return; // 안 보이는 노드

    const password = yes(attrs.password);
    const t = password ? undefined : text(attrs.text); // 비밀번호 글자는 보내지 않는다
    const d = text(attrs["content-desc"]);
    const cls = shortClass(attrs.class);
    const clickable = yes(attrs.clickable) || yes(attrs["long-clickable"]);
    const editable = cls === "EditText";
    const scrollable = yes(attrs.scrollable);
    if (!t && !d && !clickable && !editable && !scrollable) return;

    packageCount.set(pkg, (packageCount.get(pkg) ?? 0) + 1);
    const id = attrs["resource-id"]?.split(":id/").pop();
    candidates.push({
      order,
      score: (clickable ? 2 : 0) + (t || d ? 3 : 0) + (editable ? 2 : 0),
      node: {
        ...(t ? { t } : {}),
        ...(d ? { d } : {}),
        ...(cls ? { c: cls } : {}),
        b,
        ...(id ? { id } : {}),
        ...(clickable ? { clickable: true as const } : {}),
        ...(editable ? { editable: true as const } : {}),
        ...(scrollable ? { scrollable: true as const } : {}),
        ...(yes(attrs.checkable) ? { checkable: true as const } : {}),
        ...(yes(attrs.checked) ? { checked: true as const } : {}),
        ...(yes(attrs.selected) ? { selected: true as const } : {}),
        ...(yes(attrs.focused) ? { focused: true as const } : {}),
        ...(password ? { password: true as const } : {}),
      },
    });
  });

  const kept =
    candidates.length <= MAX_NODES
      ? candidates
      : [...candidates]
          .sort((a, b) => b.score - a.score || a.order - b.order)
          .slice(0, MAX_NODES)
          .sort((a, b) => a.order - b.order);

  const pkg = [...packageCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
  return { pkg, width, height, nodes: kept.map((c, i) => ({ i, ...c.node })) };
}
