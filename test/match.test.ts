import { describe, expect, it } from "vitest";
import { matchPage, matchTokens, similarity, type PageCandidate } from "../src/cache/match.js";
import { createPageMatcher } from "../src/debug/pages.js";
import { createDebugRoutes } from "../src/debug/routes.js";
import { createHttpHandler } from "../src/shared/handler.js";
import { createLogger } from "../src/shared/logger.js";
import { createRouter } from "../src/shared/router.js";
import { memoryDebugStore } from "./debug-memory-store.js";
import { httpEvent, lambdaContext, parseBody } from "./helpers.js";

const listening = (said: string, y = 500) => [
  { t: "듣고 있어요. 천천히 말씀해 주세요.", c: "TextView", b: [168, 300, 912, 420] as const },
  { t: `“${said}”`, c: "TextView", b: [168, 420, 912, 500] as const },
  { c: "EditText", b: [168, y, 912, y + 190] as const },
  { t: "안내 요청", c: "Button", b: [168, y + 220, 912, y + 420] as const },
  { t: "🎤 말하기", c: "Button", b: [168, y + 450, 912, y + 650] as const },
  { t: "취소", c: "Button", b: [168, y + 680, 912, y + 880] as const },
];

const page = (
  pageId: string,
  nodes: Parameters<typeof matchTokens>[0],
  fp: string,
): PageCandidate => {
  const tokens = matchTokens(nodes);
  return { pageId, tokens, lastTokens: tokens, fingerprints: [fp] };
};

describe("화면 매칭 (match@v1)", () => {
  it("토큰은 위치를 빼고 숫자는 # 로", () => {
    expect(matchTokens([{ t: "알림 3건", c: "TextView", b: [0, 0, 1, 1] }])).toEqual([
      "TextView|알림 #건",
    ]);
    expect(similarity(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(similarity([], [])).toBe(1);
  });

  it("같은 지문이면 exact", () => {
    const result = matchPage({ fingerprint: "fp1", tokens: [] }, [
      page("p1", listening("계좌"), "fp1"),
    ]);
    expect(result).toMatchObject({ kind: "exact", pageId: "p1", score: 1 });
  });

  it("말한 내용이 달라 지문이 갈려도 같은 페이지로 (similar)", () => {
    const pages = [
      page("listen", listening("계좌"), "fpA"),
      page(
        "home",
        [
          { t: "해봄 어르신", c: "TextView" },
          { t: "말로 요청하기", c: "Button" },
        ],
        "fpH",
      ),
    ];
    const result = matchPage(
      { fingerprint: "fpB", tokens: matchTokens(listening("유튜브에서 트로트 검색해 줘", 545)) },
      pages,
    );
    expect(result.kind).toBe("similar");
    expect(result.pageId).toBe("listen");
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  it("비슷한 페이지가 둘이면 판단 보류 (ambiguous)", () => {
    const a = [
      { t: "확인", c: "Button" },
      { t: "취소", c: "Button" },
      { t: "알림", c: "TextView" },
    ];
    const b = [
      { t: "확인", c: "Button" },
      { t: "취소", c: "Button" },
      { t: "경고", c: "TextView" },
    ];
    const result = matchPage(
      {
        fingerprint: "x",
        tokens: matchTokens([
          { t: "확인", c: "Button" },
          { t: "취소", c: "Button" },
        ]),
      },
      [page("a", a, "fa"), page("b", b, "fb")],
    );
    expect(result).toMatchObject({ kind: "ambiguous", runnerUp: { score: result.score } });
  });

  it("겹치는 게 적으면 새 페이지, 가장 가까운 페이지는 runnerUp 으로", () => {
    const result = matchPage(
      { fingerprint: "x", tokens: matchTokens([{ t: "설정", c: "TextView" }]) },
      [page("listen", listening("계좌"), "fpA")],
    );
    expect(result.kind).toBe("new");
    expect(result.pageId).toBeUndefined();
    expect(result.runnerUp?.pageId).toBe("listen");
  });
});

describe("페이지 매처", () => {
  it("new → 페이지 생성, similar → 지문 추가·횟수 증가, ambiguous → 그대로", async () => {
    const { store, pages } = memoryDebugStore();
    let n = 0;
    const matcher = createPageMatcher(store, () => `p${++n}`);
    const base = { pkg: "kr.haebom.elder", deviceId: "dev-00001", at: "2026-11-26T07:00:00.000Z" };

    const first = await matcher.prepare({
      ...base,
      fingerprint: "f1",
      nodes: listening("계좌"),
      screenId: "s1",
    });
    expect(first.match).toMatchObject({ kind: "new", pageId: "p1" });
    await first.commit();

    const second = await matcher.prepare({
      ...base,
      fingerprint: "f2",
      nodes: listening("디스플레이 설정", 545),
      screenId: "s2",
    });
    expect(second.match).toMatchObject({ kind: "similar", pageId: "p1" });
    await second.commit();
    expect(pages[0]).toMatchObject({ pageId: "p1", fingerprints: ["f1", "f2"], screenCount: 2 });

    const third = await matcher.prepare({ ...base, fingerprint: "f2", nodes: [], screenId: "s3" });
    expect(third.match).toMatchObject({ kind: "exact", pageId: "p1" });
  });
});

describe("POST /v1/dev/screens 매칭", () => {
  it("응답과 저장된 화면에 match 가 붙고, 중복(unchanged)이면 페이지를 바꾸지 않는다", async () => {
    const { store, screens, pages } = memoryDebugStore();
    let n = 0;
    const router = createRouter(
      createDebugRoutes({ store, viewerEmails: new Set(), newPageId: () => `p${++n}` }),
    );
    const handler = createHttpHandler(router, createLogger({}, { write: () => undefined }));
    const post = async (said: string) => {
      const event = httpEvent("POST", "/v1/dev/screens", "uid-elder");
      event.body = JSON.stringify({
        deviceId: "dev-00001",
        capturedAt: "2026-11-26T07:00:00.000Z",
        screen: {
          pkg: "kr.haebom.elder",
          width: 1080,
          height: 2400,
          nodes: listening(said).map((node, i) => ({ i, ...node, b: [...node.b] })),
        },
      });
      return parseBody((await handler(event, lambdaContext)).body);
    };

    expect(await post("계좌")).toMatchObject({
      status: "saved",
      match: { kind: "new", pageId: "p1" },
    });
    expect(await post("계좌")).toEqual({ status: "unchanged" });
    expect(await post("유튜브")).toMatchObject({ match: { kind: "similar", pageId: "p1" } });
    expect(screens.map((s) => s.match?.pageId)).toEqual(["p1", "p1"]);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.screenCount).toBe(2);
  });
});
