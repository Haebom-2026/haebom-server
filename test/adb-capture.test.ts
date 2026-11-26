import { describe, expect, it } from "vitest";
import { MAX_NODES, parseBounds, parseNodes, toScreen } from "../scripts/adb-capture/parse.js";
import { screenSchema } from "../src/debug/schema.js";

const node = (attrs: Record<string, string>, children = "") => {
  const body = Object.entries({
    text: "",
    "resource-id": "",
    class: "android.view.View",
    package: "kr.go.gov24",
    "content-desc": "",
    clickable: "false",
    scrollable: "false",
    password: "false",
    bounds: "[0,0][10,10]",
    ...attrs,
  })
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return children ? `<node ${body}>${children}</node>` : `<node ${body} />`;
};

const dump = (inner: string) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${inner}</hierarchy>`;

const sample = dump(
  node(
    { class: "android.widget.FrameLayout", bounds: "[0,0][1080,2400]" },
    [
      node({ package: "com.android.systemui", text: "오후 3:24", bounds: "[0,0][200,60]" }),
      node({ text: "정부24", class: "android.widget.TextView", bounds: "[60,140][400,230]" }),
      node({
        text: "민원 신청",
        class: "android.widget.Button",
        clickable: "true",
        "resource-id": "kr.go.gov24:id/apply",
        bounds: "[60,420][520,640]",
      }),
      node({
        "content-desc": "검색 &amp; 찾기",
        class: "android.widget.ImageButton",
        clickable: "true",
        bounds: "[920,140][1040,240]",
      }),
      node({
        text: "secret",
        class: "android.widget.EditText",
        password: "true",
        bounds: "[60,700][1020,800]",
      }),
      node({ text: "", class: "android.view.View", bounds: "[0,0][1080,2400]" }), // 의미 없는 컨테이너
      node({ text: "숨김", bounds: "[10,10][10,10]" }), // 크기 0
    ].join(""),
  ),
);

describe("adb-capture parse", () => {
  it("bounds 를 읽는다", () => {
    expect(parseBounds("[60,420][520,640]")).toEqual([60, 420, 520, 640]);
    expect(parseBounds("bad")).toBeUndefined();
  });

  it("중첩 깊이와 엔티티", () => {
    const nodes = parseNodes(sample);
    expect(nodes[0]?.depth).toBe(0);
    expect(nodes[1]?.depth).toBe(1);
    expect(
      nodes.find((n) => n.attrs["content-desc"]?.startsWith("검색"))?.attrs["content-desc"],
    ).toBe("검색 & 찾기");
  });

  it("의미 있는 노드만 고르고 시스템 UI·빈 컨테이너·크기 0 은 뺀다", () => {
    const screen = toScreen(sample);
    expect(screen).toMatchObject({ pkg: "kr.go.gov24", width: 1080, height: 2400 });
    expect(screen?.nodes.map((n) => n.t ?? n.d)).toEqual([
      "정부24",
      "민원 신청",
      "검색 & 찾기",
      undefined,
    ]);
    expect(screen?.nodes[1]).toMatchObject({ i: 1, c: "Button", clickable: true, id: "apply" });
  });

  it("비밀번호 칸은 글자를 보내지 않는다", () => {
    const pw = toScreen(sample)?.nodes.find((n) => n.password);
    expect(pw).toMatchObject({ c: "EditText", editable: true, password: true });
    expect(pw?.t).toBeUndefined();
  });

  it("60개를 넘으면 누를 수 있고 글자 있는 노드를 먼저 남기고, 화면 순서로 번호를 매긴다", () => {
    const many = Array.from({ length: 50 }, (_, k) =>
      node({ text: `글 ${k}`, bounds: `[0,${k * 10}][100,${k * 10 + 9}]` }),
    );
    const buttons = Array.from({ length: 20 }, (_, k) =>
      node({ text: `버튼 ${k}`, clickable: "true", bounds: `[200,${k * 10}][300,${k * 10 + 9}]` }),
    );
    const screen = toScreen(
      dump(node({ bounds: "[0,0][1080,2400]" }, [...many, ...buttons].join(""))),
    );
    expect(screen?.nodes).toHaveLength(MAX_NODES);
    expect(screen?.nodes.filter((n) => n.clickable)).toHaveLength(20);
    expect(screen?.nodes.map((n) => n.i)).toEqual(Array.from({ length: MAX_NODES }, (_, k) => k));
  });

  it("결과는 서버 스키마를 통과한다", () => {
    const screen = toScreen(sample);
    expect(screenSchema.safeParse(screen).success).toBe(true);
  });

  it("빈 덤프는 undefined", () => {
    expect(toScreen("<hierarchy/>")).toBeUndefined();
  });
});
