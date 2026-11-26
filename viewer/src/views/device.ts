/**
 * 2. 기기 상세 — 왼쪽: 화면 기록(1초 폴링으로 새 화면이 위에 붙음), 오른쪽: 선택한 화면.
 * "실시간 따라가기" 가 켜져 있으면 새 화면이 오는 대로 오른쪽이 바뀐다.
 * 행 클릭 = 선택, Shift+클릭 = 구간 선택 → "구간 보관".
 * ?from=&to= 로 열면 보관 세션 구간만 보여 주고 폴링하지 않는다.
 */
import { api } from "../api.ts";
import { fpChip, h, time } from "../dom.ts";
import { subscribeScreens, type Subscription } from "../subscribe.ts";
import type { ScreenSummary } from "../types.ts";
import { commandInsightSection } from "./command-insight.ts";
import { commandSummary, renderCommand } from "./command-panel.ts";
import { renderScreen } from "./screen-panel.ts";

export function deviceView(
  root: HTMLElement,
  deviceId: string,
  range: { from: string; to: string } | undefined,
): () => void {
  /** 최신이 앞 */
  let screens: ScreenSummary[] = [];
  let cursor: string | undefined;
  let selectedId: string | undefined;
  let rangeEnd: string | undefined;
  let follow = range === undefined;
  let pkgFilter = "";
  let sub: Subscription | undefined;
  let disposed = false;
  let loadToken = 0;

  const title = h("h1", {}, deviceId.slice(0, 8));
  const status = h("span", { class: "muted small" });
  const followBox = h("input", {
    type: "checkbox",
    checked: follow,
    onchange: (e: Event) => {
      follow = (e.target as HTMLInputElement).checked;
      if (follow && screens[0]) select(screens[0].screenId);
    },
  });
  const pkgSelect = h("select", {
    onchange: (e: Event) => {
      pkgFilter = (e.target as HTMLSelectElement).value;
      renderList();
    },
  });
  const pinButton = h(
    "button",
    { class: "primary", disabled: true, onclick: () => void pinRange() },
    "구간 보관",
  );
  const list = h("ol", { class: "timeline" });
  const more = h("button", { class: "link", onclick: () => void loadOlder() }, "이전 화면 더 보기");
  const panel = h(
    "div",
    { class: "screen-panel" },
    h("p", { class: "muted" }, "왼쪽에서 화면을 고르세요."),
  );

  root.append(
    h(
      "section",
      { class: "page device-page" },
      h(
        "header",
        { class: "page-head" },
        h(
          "a",
          { href: range ? "#/pins" : "#/", class: "back" },
          "← ",
          range ? "보관 세션" : "기기",
        ),
        title,
        status,
      ),
      h(
        "div",
        { class: "split" },
        h(
          "aside",
          { class: "timeline-col" },
          h(
            "div",
            { class: "toolbar" },
            range
              ? h("span", { class: "tag" }, "보관 세션 구간")
              : h("label", { class: "follow" }, followBox, " 실시간 따라가기"),
            pkgSelect,
            range ? null : pinButton,
          ),
          h(
            "p",
            { class: "muted small hint" },
            range ? "" : "Shift+클릭으로 구간을 골라 보관할 수 있어요.",
          ),
          list,
          range ? null : more,
        ),
        panel,
      ),
    ),
  );

  // 명령 기록(classify·앱 선택)은 앱을 걸러도 늘 보인다
  const visible = () =>
    pkgFilter ? screens.filter((x) => x.entry || x.pkg === pkgFilter) : screens;

  /** 선택 구간 (오래된 → 최신) */
  const selection = (): { from: string; to: string } | undefined => {
    if (!selectedId || !rangeEnd || selectedId === rangeEnd) return undefined;
    return selectedId < rangeEnd
      ? { from: selectedId, to: rangeEnd }
      : { from: rangeEnd, to: selectedId };
  };

  function renderList() {
    const pkgs = [...new Set(screens.filter((x) => !x.entry).map((x) => x.pkg))].sort();
    pkgSelect.replaceChildren(
      h("option", { value: "" }, `모든 앱 (${pkgs.length})`),
      ...pkgs.map((p) => h("option", { value: p, selected: p === pkgFilter }, p)),
    );
    const sel = selection();
    pinButton.disabled = !sel;
    const items = visible();
    list.replaceChildren(
      ...items.map((x, index) => {
        const older = items[index + 1];
        const inRange = sel ? x.screenId >= sel.from && x.screenId <= sel.to : false;
        if (x.entry && x.command) {
          const c = x.command;
          return h(
            "li",
            {
              class: ["cmd", x.screenId === selectedId ? "selected" : "", inRange ? "in-range" : ""]
                .filter(Boolean)
                .join(" "),
              onclick: () => {
                rangeEnd = undefined;
                if (!range) {
                  follow = x === screens[0];
                  followBox.checked = follow;
                }
                select(x.screenId);
              },
            },
            h("span", { class: "mono small" }, time(x.receivedAt)),
            h(
              "span",
              {
                class: `tag cmd-tag ${c.kind}`,
                title: c.kind === "classify" ? "classify: 안전 분류 + jev 고르기" : "앱 선택 API",
              },
              c.kind === "classify" ? "jev" : "선택",
            ),
            h("span", { class: "cmd-text" }, commandSummary(c)),
            c.level
              ? h(
                  "span",
                  { class: `tag ${c.level >= "L2" ? "warn" : ""}`, title: "명령 단계" },
                  c.level,
                )
              : null,
          );
        }
        return h(
          "li",
          {
            class: [
              x.screenId === selectedId ? "selected" : "",
              inRange ? "in-range" : "",
              older && !older.entry && older.fingerprint === x.fingerprint ? "same" : "",
            ]
              .filter(Boolean)
              .join(" "),
            onclick: (e: MouseEvent) => {
              if (e.shiftKey && selectedId && !range) {
                rangeEnd = x.screenId;
                renderList();
              } else {
                rangeEnd = undefined;
                if (!range) {
                  follow = x === screens[0];
                  followBox.checked = follow;
                }
                select(x.screenId);
              }
            },
          },
          h("span", { class: "mono small" }, time(x.receivedAt)),
          fpChip(x.fingerprint),
          h("span", { class: "pkg" }, x.pkg),
          h("span", { class: "muted small num" }, `${x.nodeCount}`),
          x.guideType
            ? h(
                "span",
                { class: "tag ai", title: "guide 요청 (AI 판단 기록)" },
                `AI ${x.guideType}`,
              )
            : null,
          x.pinned ? h("span", { class: "tag", title: "보관됨 (30일)" }, "보관") : null,
          x.maskedCount ? h("span", { class: "tag warn", title: "민감 정보 마스킹" }, "M") : null,
        );
      }),
    );
    if (!items.length) list.append(h("li", { class: "empty muted" }, "화면 기록이 없어요."));
    more.hidden = !cursor;
    const shots = screens.filter((x) => !x.entry).length;
    const commands = screens.length - shots;
    const counts = `화면 ${shots}개${commands ? ` · 명령 ${commands}개` : ""}`;
    status.textContent = range ? counts : `${counts} 불러옴 · 1초마다 확인`;
  }

  function select(screenId: string) {
    selectedId = screenId;
    renderList();
    const token = ++loadToken;
    panel.classList.add("loading");
    if (screens.find((x) => x.screenId === screenId)?.entry) {
      api
        .entry(deviceId, screenId)
        .then((doc) => {
          if (token !== loadToken || disposed) return;
          panel.replaceChildren(
            renderCommand(doc),
            commandInsightSection(deviceId, doc.command.commandId),
          );
        })
        .catch((error: unknown) => {
          if (token !== loadToken) return;
          panel.replaceChildren(
            h("p", { class: "error" }, `명령 기록을 못 불러왔어요: ${(error as Error).message}`),
          );
        })
        .finally(() => panel.classList.remove("loading"));
      return;
    }
    api
      .screen(deviceId, screenId)
      .then((doc) => {
        if (token !== loadToken || disposed) return;
        // 같은 지문 이력: 불러온 기록 안에서 계산
        const older = screens.filter(
          (x) => !x.entry && x.screenId < screenId && x.fingerprint === doc.fingerprint,
        );
        panel.replaceChildren(
          renderScreen(doc, { sameBefore: older[0], seenCount: older.length + 1 }),
        );
      })
      .catch((error: unknown) => {
        if (token !== loadToken) return;
        panel.replaceChildren(
          h("p", { class: "error" }, `화면을 못 불러왔어요: ${(error as Error).message}`),
        );
      })
      .finally(() => panel.classList.remove("loading"));
  }

  async function loadOlder() {
    if (!cursor) return;
    const page = await api.screens(deviceId, { cursor, limit: 50 });
    screens = [...screens, ...page.items];
    cursor = page.nextCursor;
    renderList();
  }

  async function pinRange() {
    const sel = selection();
    if (!sel) return;
    const name = prompt("보관 세션 이름 (예: 정부24 L2 흐름 1회차)");
    if (!name?.trim()) return;
    try {
      const pin = await api.pin(deviceId, sel.from, sel.to, name.trim());
      screens = screens.map((x) =>
        x.screenId >= sel.from && x.screenId <= sel.to ? { ...x, pinned: true } : x,
      );
      rangeEnd = undefined;
      renderList();
      alert(`보관했어요: ${pin.name} (${pin.screenCount}개, 30일)`);
    } catch (error) {
      alert(`보관 실패: ${(error as Error).message}`);
    }
  }

  async function start() {
    try {
      const devices = await api.devices();
      const device = devices.items.find((d) => d.deviceId === deviceId);
      if (device) title.textContent = device.label ?? device.deviceId.slice(0, 8);

      const page = range
        ? await api.screens(deviceId, { from: range.from, to: range.to, limit: 500 })
        : await api.screens(deviceId, { limit: 50 });
      if (disposed) return;
      screens = range ? [...page.items].reverse() : page.items;
      cursor = range ? undefined : page.nextCursor;
      renderList();
      if (screens[0]) select(screens[0].screenId);

      if (!range) {
        sub = subscribeScreens(
          deviceId,
          screens[0]?.screenId,
          (fresh) => {
            // 뒤늦게 저장된 기록(classify·guide)은 이미 보이는 화면보다 앞 시각일 수 있다 → 제자리에
            const have = new Set(screens.map((x) => x.screenId));
            screens = [...screens, ...fresh.filter((x) => !have.has(x.screenId))].sort((a, b) =>
              b.screenId.localeCompare(a.screenId),
            );
            if (follow && screens[0]) select(screens[0].screenId);
            else renderList();
          },
          (error) => {
            status.textContent = `갱신 실패: ${(error as Error).message}`;
          },
          screens.map((x) => x.screenId),
        );
      }
    } catch (error) {
      status.textContent = `불러오기 실패: ${(error as Error).message}`;
      status.className = "error";
    }
  }

  void start();
  return () => {
    disposed = true;
    sub?.stop();
  };
}
