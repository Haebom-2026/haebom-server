/** 4. 보관 세션 — 목록, 클릭하면 그 구간 화면을 기기 화면에서 본다 */
import { api } from "../api.ts";
import { ago, h } from "../dom.ts";

export function pinsView(root: HTMLElement): () => void {
  const body = h("div", { class: "pins" }, h("p", { class: "muted" }, "불러오는 중…"));
  root.append(
    h(
      "section",
      { class: "page" },
      h(
        "header",
        { class: "page-head" },
        h("h1", {}, "보관 세션"),
        h("p", { class: "muted" }, "30일 보관. 지문 규칙을 바꿀 때 다시 돌려 비교하는 기록이에요."),
      ),
      body,
    ),
  );

  api
    .pins()
    .then(({ items }) => {
      if (!items.length) {
        body.replaceChildren(
          h(
            "p",
            { class: "muted" },
            "아직 없어요. 기기 화면에서 Shift+클릭으로 구간을 고른 뒤 “구간 보관”을 누르세요.",
          ),
        );
        return;
      }
      body.replaceChildren(
        h(
          "ul",
          { class: "pin-list" },
          items.map((pin) =>
            h(
              "li",
              {},
              h(
                "a",
                {
                  href: `#/d/${encodeURIComponent(pin.deviceId)}?from=${pin.from}&to=${pin.to}`,
                },
                h("strong", {}, pin.name),
              ),
              h(
                "span",
                { class: "muted small" },
                `화면 ${pin.screenCount}개 · ${pin.createdBy} · ${ago(pin.createdAt)}`,
              ),
              h("span", { class: "muted small mono" }, pin.deviceId),
            ),
          ),
        ),
      );
    })
    .catch((error: unknown) => {
      body.replaceChildren(
        h("p", { class: "error" }, `목록을 못 불러왔어요: ${(error as Error).message}`),
      );
    });

  return () => undefined;
}
