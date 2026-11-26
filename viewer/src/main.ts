import "./style.css";
import { ApiFailure, isMock } from "./api.ts";
import { logOut, signIn, watchUser } from "./auth.ts";
import { h } from "./dom.ts";
import { deviceView } from "./views/device.ts";
import { devicesView } from "./views/devices.ts";
import { mapView } from "./views/map.ts";
import { pinsView } from "./views/pins.ts";
import { routeView } from "./views/route.ts";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("#app missing");

const userSlot = h("span", { class: "user" });
const main = h("main");
const nav = h(
  "nav",
  {},
  h("a", { href: "#/", "data-route": "devices" }, "기기"),
  h("a", { href: "#/map", "data-route": "map" }, "화면 지도"),
  h("a", { href: "#/pins", "data-route": "pins" }, "보관 세션"),
  h("a", { href: "#/route", "data-route": "route" }, "고르기"),
);

app.append(
  h(
    "header",
    { class: "top" },
    h("a", { href: "#/", class: "brand" }, "해봄 ", h("span", {}, "디버그 뷰어")),
    isMock
      ? h("span", { class: "tag warn", title: "npm run mock: 가짜 데이터" }, "MOCK")
      : h("span", { class: "tag" }, "dev"),
    nav,
    userSlot,
  ),
  main,
);

let cleanup: (() => void) | undefined;

function route() {
  cleanup?.();
  main.replaceChildren();
  const [path = "", query = ""] = location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  const parts = path.split("/").filter(Boolean);

  for (const link of nav.querySelectorAll("a")) {
    const section =
      parts[0] === "pins" || parts[0] === "map" || parts[0] === "route" ? parts[0] : "devices";
    const active = link.dataset.route === section;
    link.classList.toggle("active", active);
  }

  if (parts[0] === "d" && parts[1]) {
    const from = params.get("from");
    const to = params.get("to");
    cleanup = deviceView(main, decodeURIComponent(parts[1]), from && to ? { from, to } : undefined);
  } else if (parts[0] === "map") {
    cleanup = mapView(main);
  } else if (parts[0] === "route") {
    cleanup = routeView(main);
  } else if (parts[0] === "pins") {
    cleanup = pinsView(main);
  } else {
    cleanup = devicesView(main);
  }
}

function signInScreen(message?: string) {
  cleanup?.();
  cleanup = undefined;
  main.replaceChildren(
    h(
      "section",
      { class: "page signin" },
      h("h1", {}, "개발자 로그인"),
      h("p", { class: "muted" }, "허용 목록에 있는 Google 계정만 쓸 수 있어요 (dev 전용)."),
      message ? h("p", { class: "error" }, message) : null,
      h(
        "button",
        {
          class: "primary",
          onclick: () => void signIn().catch((e: unknown) => signInScreen((e as Error).message)),
        },
        "Google 로 로그인",
      ),
    ),
  );
}

// 403(허용 목록 밖) 은 화면마다 오류로 보이므로 여기서 한 번 더 안내한다
window.addEventListener("unhandledrejection", (event) => {
  if (event.reason instanceof ApiFailure && event.reason.status === 403) {
    signInScreen(
      "이 계정은 디버그 뷰어 허용 목록에 없어요. terraform.tfvars 의 debug_viewer_emails 를 확인하세요.",
    );
  }
});

if (isMock) {
  userSlot.textContent = "mock@example.com";
  window.addEventListener("hashchange", route);
  route();
} else {
  watchUser((user) => {
    if (!user) {
      userSlot.replaceChildren();
      window.removeEventListener("hashchange", route);
      signInScreen();
      return;
    }
    userSlot.replaceChildren(
      user.email ?? "",
      " ",
      h("button", { class: "link small", onclick: () => void logOut() }, "로그아웃"),
    );
    window.addEventListener("hashchange", route);
    route();
  }).catch((error: unknown) => {
    signInScreen((error as Error).message);
  });
}
