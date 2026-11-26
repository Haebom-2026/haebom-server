import { describe, expect, it } from "vitest";
import { createLogger } from "../src/shared/logger.js";

describe("createLogger", () => {
  it("민감 필드를 가리고 JSON 한 줄로 쓴다", () => {
    const lines: string[] = [];
    const log = createLogger(
      { service: "test" },
      { level: "info", write: (line) => lines.push(line) },
    );

    log.info("guide request", {
      screen: { pkg: "com.example", nodes: [{ t: "010-1234-5678" }] },
      device: { fcmToken: "abc" },
    });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(record).toMatchObject({
      level: "info",
      service: "test",
      screen: { pkg: "com.example", nodes: "[redacted]" },
      device: { fcmToken: "[redacted]" },
    });
  });

  it("최소 레벨 아래는 쓰지 않는다", () => {
    const lines: string[] = [];
    const log = createLogger({}, { level: "warn", write: (line) => lines.push(line) });
    log.info("skip");
    log.child({ a: 1 }).warn("keep");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"a":1');
  });
});
