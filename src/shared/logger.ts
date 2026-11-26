type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 로그에 남기면 안 되는 필드 (docs/server-plan.md 7장: 화면 nodes, 푸시 토큰, 인증 정보). */
const REDACTED_KEYS = new Set(["nodes", "fcmtoken", "authorization", "apikey", "token"]);

export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? "[redacted]" : redact(item, depth + 1);
    }
    return out;
  }
  return value;
}

function parseLevel(raw: string | undefined): Level {
  return raw === "debug" || raw === "warn" || raw === "error" ? raw : "info";
}

export interface LoggerOptions {
  level?: Level;
  /** 테스트에서 출력을 가로챌 때 사용. 기본은 stdout 에 JSON 한 줄. */
  write?: (line: string) => void;
}

/**
 * 구조화 JSON 로거. Lambda 런타임의 console 접두사(시각·requestId)를 피하려고
 * stdout 에 직접 한 줄씩 쓴다 → CloudWatch Logs Insights 가 JSON 으로 바로 파싱.
 */
export function createLogger(base: LogContext = {}, options: LoggerOptions = {}): Logger {
  const minLevel = options.level ?? parseLevel(process.env.LOG_LEVEL);
  const write = options.write ?? ((line: string) => process.stdout.write(line + "\n"));

  const emit = (level: Level, message: string, context?: LogContext) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const record = redact({
      time: new Date().toISOString(),
      level,
      message,
      ...base,
      ...context,
    });
    write(JSON.stringify(record));
  };

  return {
    debug: (message, context) => {
      emit("debug", message, context);
    },
    info: (message, context) => {
      emit("info", message, context);
    },
    warn: (message, context) => {
      emit("warn", message, context);
    },
    error: (message, context) => {
      emit("error", message, context);
    },
    child: (context) => createLogger({ ...base, ...context }, { level: minLevel, write }),
  };
}
