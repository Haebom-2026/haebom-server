/** 1. 기기 목록 — 3초마다 갱신, online 점, 라벨 편집 */
import { api } from "../api.ts";
import { ago, h } from "../dom.ts";
import { every } from "../subscribe.ts";
import type { Device } from "../types.ts";

export function devicesView(root: HTMLElement): () => void {
  const body = h("tbody");
  const status = h("p", { class: "muted" }, "불러오는 중…");
  root.append(
    h(
      "section",
      { class: "page" },
      h("header", { class: "page-head" }, h("h1", {}, "기기"), status),
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "devices" },
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h("th", {}, "기기"),
              h("th", {}, "모델 · OS"),
              h("th", {}, "앱"),
              h("th", { class: "num" }, "마지막 신호"),
              h("th", { class: "num" }, "마지막 화면"),
              h("th", { class: "num" }, "화면 수"),
            ),
          ),
          body,
        ),
      ),
    ),
  );

  const row = (d: Device) =>
    h(
      "tr",
      {},
      h(
        "td",
        {},
        h(
          "div",
          { class: "device-name" },
          h("span", {
            class: d.online ? "dot on" : "dot",
            title: d.online ? "온라인" : "오프라인",
          }),
          h(
            "a",
            { href: `#/d/${encodeURIComponent(d.deviceId)}` },
            d.label ?? d.deviceId.slice(0, 8),
          ),
          h(
            "button",
            {
              class: "link small",
              title: "이름 바꾸기",
              onclick: () => {
                const label = prompt("기기 이름 (예: 시연폰 A)", d.label ?? "");
                if (label?.trim()) void api.setLabel(d.deviceId, label.trim()).then(refresh);
              },
            },
            "이름",
          ),
        ),
        h("div", { class: "muted mono small" }, d.deviceId),
      ),
      h("td", {}, d.model || "–", h("div", { class: "muted small" }, d.os || "")),
      h("td", { class: "mono" }, d.appVersion || "–"),
      h("td", { class: "num" }, ago(d.lastSeenAt)),
      h("td", { class: "num" }, ago(d.lastScreenAt)),
      h("td", { class: "num" }, d.screenCount),
    );

  const refresh = async () => {
    try {
      const { items } = await api.devices();
      body.replaceChildren(...items.map(row));
      const online = items.filter((d) => d.online).length;
      status.textContent = items.length
        ? `${items.length}대 · 온라인 ${online}대`
        : "아직 신호를 보낸 기기가 없어요. 앱 debug 빌드에서 heartbeat 를 켜 주세요.";
      status.className = "muted";
    } catch (error) {
      status.textContent = `목록을 못 불러왔어요: ${(error as Error).message}`;
      status.className = "error";
    }
  };

  const sub = every(3000, refresh);
  return () => {
    sub.stop();
  };
}
