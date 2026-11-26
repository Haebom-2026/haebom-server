/** 아주 작은 DOM 도우미 (프레임워크 없이). */

type Child = Node | string | number | null | undefined | false;
// 이벤트 핸들러가 MouseEvent 같은 구체 타입을 받을 수 있게 넓게 둔다
type Handler = (event: any) => void;
type Attrs = Record<string, string | number | boolean | Handler | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Child | Child[])[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

function setAttrs(el: Element, attrs: Attrs) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function")
      el.addEventListener(key.replace(/^on/, ""), value as EventListener);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
}

function append(el: Element, children: (Child | Child[])[]) {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "number" ? String(child) : child);
  }
}

/** "3초 전", "2시간 전" */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "–";
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (sec < 60) return `${sec}초 전`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hour = Math.round(min / 60);
  if (hour < 48) return `${hour}시간 전`;
  return `${Math.round(hour / 24)}일 전`;
}

export function time(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** 지문마다 고정된 색 (같은 화면 = 같은 색). 밝기·채도는 CSS 변수로 테마에 맞춘다. */
export function fpHue(fingerprint: string): number {
  let hash = 0;
  for (const ch of fingerprint) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}

export function fpChip(fingerprint: string): HTMLElement {
  return h(
    "span",
    { class: "fp", style: `--h:${fpHue(fingerprint)}`, title: `서버 지문 ${fingerprint}` },
    fingerprint.slice(0, 6),
  );
}
