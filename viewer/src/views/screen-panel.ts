/** 3. 화면 뷰어 — 노드 박스 + 번호, 노드 목록, 속성 */
import { fpChip, h, s, time } from "../dom.ts";
import type { ScreenDocument, ScreenNode, ScreenSummary } from "../types.ts";
import { renderGuide } from "./guide-panel.ts";

const KNOWN = new Set(["i", "t", "d", "c", "b"]);

function nodeLabel(node: ScreenNode): string {
  return node.t ?? node.d ?? "";
}

function flags(node: ScreenNode): string[] {
  return Object.entries(node)
    .filter(([key, value]) => !KNOWN.has(key) && value === true)
    .map(([key]) => key);
}

export function renderScreen(
  doc: ScreenDocument,
  history: { sameBefore: ScreenSummary | undefined; seenCount: number },
): HTMLElement {
  const { width, height, nodes } = doc.screen;
  const target = doc.guide?.target;
  let selected: number | undefined;

  const props = h(
    "div",
    { class: "props" },
    h("p", { class: "muted" }, "박스나 목록에 마우스를 올려 보세요."),
  );
  const showProps = (node: ScreenNode | undefined) => {
    if (!node) return;
    props.replaceChildren(
      h("h3", {}, `#${node.i} `, h("span", { class: "muted" }, node.c ?? "")),
      h(
        "dl",
        {},
        Object.entries(node).flatMap(([key, value]) => [
          h("dt", {}, key),
          h("dd", { class: "mono" }, typeof value === "string" ? value : JSON.stringify(value)),
        ]),
      ),
    );
  };

  const rects = new Map<number, SVGGElement>();
  const items = new Map<number, HTMLLIElement>();
  const highlight = (i: number | undefined, sticky = false) => {
    if (sticky) selected = selected === i ? undefined : i;
    const active = i ?? selected;
    for (const [key, el] of rects) el.classList.toggle("active", key === active);
    for (const [key, el] of items) el.classList.toggle("active", key === active);
    showProps(nodes.find((n) => n.i === active));
  };

  const stroke = Math.max(2, Math.round(width / 360));
  const fontSize = Math.round(width / 28);
  const svg = s(
    "svg",
    {
      viewBox: `0 0 ${width} ${height}`,
      class: "phone",
      role: "img",
      "aria-label": `${doc.pkg} 화면, 노드 ${nodes.length}개`,
    },
    s("rect", { x: 0, y: 0, width, height, class: "phone-bg" }),
    nodes
      .filter((n) => n.b)
      .map((n) => {
        const [l, t, r, b] = n.b ?? [0, 0, 0, 0];
        const g = s(
          "g",
          {
            class: `node${flags(n).includes("clickable") ? " clickable" : ""}${n.i === target ? " target" : ""}`,
            onmouseenter: () => highlight(n.i),
            onmouseleave: () => highlight(undefined),
            onclick: () => highlight(n.i, true),
          },
          s("rect", {
            x: l,
            y: t,
            width: Math.max(1, r - l),
            height: Math.max(1, b - t),
            rx: stroke * 2,
            "stroke-width": stroke,
          }),
          s(
            "text",
            { x: l + stroke * 3, y: t + fontSize + stroke, "font-size": fontSize, class: "idx" },
            n.i,
          ),
          nodeLabel(n)
            ? s(
                "text",
                {
                  x: l + stroke * 3,
                  y: b - stroke * 4,
                  "font-size": Math.round(fontSize * 0.8),
                  class: "txt",
                },
                nodeLabel(n).slice(0, Math.max(4, Math.floor((r - l) / (fontSize * 0.85)))),
              )
            : null,
        );
        rects.set(n.i, g);
        return g;
      }),
  );

  const list = h(
    "ol",
    { class: "node-list" },
    nodes.map((n) => {
      const li = h(
        "li",
        {
          onmouseenter: () => highlight(n.i),
          onmouseleave: () => highlight(undefined),
          onclick: () => highlight(n.i, true),
          class: n.i === target ? "target" : undefined,
        },
        h("span", { class: "idx mono" }, n.i),
        h("span", { class: "label" }, nodeLabel(n) || h("span", { class: "muted" }, "(글자 없음)")),
        h("span", { class: "muted small" }, n.c ?? ""),
        flags(n).map((f) => h("span", { class: "tag" }, f)),
        n.b
          ? null
          : h("span", { class: "tag warn", title: "좌표가 없어 그림에 안 나와요" }, "no bounds"),
      );
      items.set(n.i, li);
      return li;
    }),
  );

  const same = history.sameBefore;
  const meta = h(
    "div",
    { class: "screen-meta" },
    h(
      "div",
      {},
      h("strong", { class: "mono" }, doc.pkg),
      " ",
      fpChip(doc.fingerprint),
      " ",
      h("span", { class: "muted small" }, doc.fpVersion),
    ),
    h(
      "div",
      { class: "small" },
      same
        ? h(
            "span",
            {},
            "이전에 본 화면과 같음 · ",
            h("span", { class: "mono" }, time(same.receivedAt)),
            ` (이 지문 ${history.seenCount}번째)`,
          )
        : h("span", { class: "new" }, "새 화면 (처음 보는 지문)"),
    ),
    h(
      "div",
      { class: "muted small" },
      `받음 ${time(doc.receivedAt)} · 캡처 ${time(doc.capturedAt)} · 노드 ${nodes.length}개 · ${width}×${height}`,
      doc.appHash ? ` · 앱 hash ${doc.appHash}` : "",
      doc.maskedCount ? h("span", { class: "tag warn" }, `마스킹 ${doc.maskedCount}`) : null,
    ),
  );

  return h(
    "div",
    { class: "screen-view" },
    meta,
    doc.guide ? renderGuide(doc.guide) : null,
    h(
      "div",
      { class: "screen-body" },
      h("div", { class: "phone-wrap" }, svg),
      h("div", { class: "side" }, list, props),
    ),
  );
}
