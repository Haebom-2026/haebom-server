/**
 * adb 로 폰(또는 에뮬레이터) 화면의 접근성 트리를 읽어 디버그 뷰어로 보낸다.
 * 고령자 앱이 붙기 전에 서버·뷰어·화면 지문을 실제 화면으로 확인하기 위한 도구 (dev 전용).
 *
 *   npm run capture                    # 연결된 기기 하나, 1.5초마다
 *   npm run capture -- --serial emulator-5554 --interval 1000
 *   npm run capture -- --once --dry-run   # 한 번 읽어 보낼 JSON 만 출력 (앱 팀 예시용)
 *
 * 로그인: Firebase 익명 로그인(REST). refreshToken 은 ~/.haebom-adb-capture.json 에 보관 → 같은 uid 유지.
 * 설정 출처: HAEBOM_API_URL / HAEBOM_FIREBASE_API_KEY 환경 변수, 없으면 infra/envs/dev (terraform output, tfvars).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { toScreen, type CaptureScreen } from "./parse.js";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const devEnvDir = path.join(root, "infra/envs/dev");
const TOKEN_FILE = path.join(homedir(), ".haebom-adb-capture.json");
const HEARTBEAT_MS = 5000;

const { values: args } = parseArgs({
  options: {
    serial: { type: "string", short: "s" },
    interval: { type: "string", default: "1500" },
    once: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const log = (message: string) => {
  const time = new Date().toLocaleTimeString("en-GB");
  console.log(`[${time}] ${message}`);
};

// ---------------------------------------------------------------------------
// adb
// ---------------------------------------------------------------------------

function adbPath(): string {
  const sdk =
    process.env.ANDROID_HOME ??
    process.env.ANDROID_SDK_ROOT ??
    path.join(homedir(), "Library/Android/sdk");
  const candidate = path.join(sdk, "platform-tools/adb");
  return existsSync(candidate) ? candidate : "adb";
}

const ADB = adbPath();

async function adb(serial: string | undefined, ...command: string[]): Promise<string> {
  const { stdout } = await run(ADB, [...(serial ? ["-s", serial] : []), ...command], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15_000,
  });
  return stdout;
}

async function pickSerial(): Promise<string> {
  if (args.serial) return args.serial;
  const lines = (await adb(undefined, "devices")).split("\n").slice(1);
  const devices = lines
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[1] === "device")
    .map((parts) => parts[0] ?? "");
  if (devices.length === 0) {
    throw new Error(
      "연결된 기기가 없어요. USB 디버깅을 켜거나 에뮬레이터를 실행하세요 (adb devices).",
    );
  }
  if (devices.length > 1) {
    throw new Error(`기기가 여러 대예요: ${devices.join(", ")} → --serial 로 고르세요.`);
  }
  return devices[0] ?? "";
}

/** 계속 갱신되는 화면(동영상, 진행 표시, 일부 설정 화면 등): uiautomator 가 끝내 읽지 못한다 (adb 방식의 한계) */
class NotIdleError extends Error {
  constructor() {
    super("화면이 계속 바뀌고 있어 adb 로 읽을 수 없어요 (이 화면은 건너뜀)");
  }
}

/** 화면 덤프. /dev/tty 로 바로 받고, 안 되는 기기는 파일로 받는다. */
async function dumpXml(serial: string): Promise<string> {
  const direct = await adb(serial, "exec-out", "uiautomator", "dump", "/dev/tty").catch(
    (error: unknown) => {
      // 시간 초과로 끊긴 uiautomator 가 남아 있으면 다음 덤프가 막힌다 → 정리
      void adb(serial, "shell", "pkill", "-f", "uiautomator").catch(() => undefined);
      throw error;
    },
  );
  if (direct.includes("could not get idle state")) throw new NotIdleError();
  const start = direct.indexOf("<?xml");
  const end = direct.lastIndexOf("</hierarchy>");
  if (start >= 0 && end > start) return direct.slice(start, end + "</hierarchy>".length);

  // /dev/tty 를 지원하지 않는 기기
  const out = await adb(serial, "shell", "uiautomator", "dump", "/sdcard/haebom_dump.xml");
  if (out.includes("could not get idle state")) throw new NotIdleError();
  return adb(serial, "exec-out", "cat", "/sdcard/haebom_dump.xml");
}

async function deviceInfo(serial: string) {
  const prop = async (name: string) => (await adb(serial, "shell", "getprop", name)).trim();
  const [model, release] = await Promise.all([
    prop("ro.product.model"),
    prop("ro.build.version.release"),
  ]);
  return {
    // 서버 규칙: [A-Za-z0-9_-] 8~64자
    deviceId: `adb-${serial}`
      .replace(/[^A-Za-z0-9_-]/g, "-")
      .padEnd(8, "0")
      .slice(0, 64),
    model,
    os: `Android ${release}`,
    appVersion: "adb-capture",
  };
}

// ---------------------------------------------------------------------------
// 설정·로그인
// ---------------------------------------------------------------------------

async function apiUrl(): Promise<string> {
  if (process.env.HAEBOM_API_URL) return process.env.HAEBOM_API_URL.replace(/\/$/, "");
  const { stdout } = await run("terraform", [
    "-chdir=" + devEnvDir,
    "output",
    "-raw",
    "api_endpoint",
  ]);
  return stdout.trim();
}

async function firebaseApiKey(): Promise<string> {
  if (process.env.HAEBOM_FIREBASE_API_KEY) return process.env.HAEBOM_FIREBASE_API_KEY;
  const tfvars = await readFile(path.join(devEnvDir, "terraform.tfvars"), "utf8");
  const match = /^\s*firebase_web_api_key\s*=\s*"([^"]+)"/m.exec(tfvars);
  if (!match?.[1])
    throw new Error("Firebase 웹 apiKey 가 없어요 (HAEBOM_FIREBASE_API_KEY 또는 tfvars).");
  return match[1];
}

interface TokenCache {
  refreshToken: string;
  uid: string;
}

/** Firebase 익명 로그인. ID 토큰은 1시간이라 만료 5분 전에 갱신한다. */
function createAuth(apiKey: string) {
  let idToken = "";
  let expiresAt = 0;

  const save = (cache: TokenCache) => writeFile(TOKEN_FILE, JSON.stringify(cache), { mode: 0o600 });

  const signUp = async () => {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ returnSecureToken: true }),
      },
    );
    const data = (await response.json()) as {
      idToken?: string;
      refreshToken?: string;
      localId?: string;
      expiresIn?: string;
      error?: { message?: string };
    };
    if (!response.ok || !data.idToken || !data.refreshToken || !data.localId) {
      throw new Error(`익명 로그인 실패: ${data.error?.message ?? response.status}`);
    }
    idToken = data.idToken;
    expiresAt = Date.now() + Number(data.expiresIn ?? 3600) * 1000;
    await save({ refreshToken: data.refreshToken, uid: data.localId });
    log(`익명 로그인 (새 uid ${data.localId})`);
  };

  const refresh = async (cache: TokenCache) => {
    const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: cache.refreshToken }),
    });
    const data = (await response.json()) as {
      id_token?: string;
      refresh_token?: string;
      expires_in?: string;
    };
    if (!response.ok || !data.id_token) return false;
    idToken = data.id_token;
    expiresAt = Date.now() + Number(data.expires_in ?? 3600) * 1000;
    if (data.refresh_token) await save({ ...cache, refreshToken: data.refresh_token });
    return true;
  };

  return async (): Promise<string> => {
    if (idToken && Date.now() < expiresAt - 5 * 60_000) return idToken;
    const cache = await readFile(TOKEN_FILE, "utf8")
      .then((text) => JSON.parse(text) as TokenCache)
      .catch(() => undefined);
    if (!(cache && (await refresh(cache)))) await signUp();
    return idToken;
  };
}

// ---------------------------------------------------------------------------
// 전송
// ---------------------------------------------------------------------------

async function post(base: string, token: string, pathname: string, body: unknown) {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : undefined };
}

const screenKey = (screen: CaptureScreen) =>
  createHash("sha256").update(JSON.stringify(screen)).digest("hex");

async function main() {
  const serial = await pickSerial();
  const device = await deviceInfo(serial);
  log(`기기 ${serial} (${device.model}, ${device.os}) → deviceId ${device.deviceId}`);

  if (args["dry-run"]) {
    const screen = toScreen(await dumpXml(serial));
    console.log(
      JSON.stringify(
        { deviceId: device.deviceId, capturedAt: new Date().toISOString(), screen },
        null,
        2,
      ),
    );
    return;
  }

  const base = await apiUrl();
  const token = createAuth(await firebaseApiKey());
  log(`API ${base}`);

  let lastHeartbeat = 0;
  let lastKey = "";
  let lastError = "";
  const interval = Math.max(500, Number(args.interval));

  for (;;) {
    const started = Date.now();
    try {
      if (started - lastHeartbeat >= HEARTBEAT_MS) {
        const res = await post(base, await token(), "/v1/dev/heartbeat", device);
        if (res.status !== 204) log(`heartbeat ${res.status} ${JSON.stringify(res.body)}`);
        lastHeartbeat = started;
      }

      const capturedAt = new Date().toISOString();
      const screen = toScreen(await dumpXml(serial));
      if (screen && screenKey(screen) !== lastKey) {
        const res = await post(base, await token(), "/v1/dev/screens", {
          deviceId: device.deviceId,
          capturedAt,
          screen,
        });
        const body = res.body as { status?: string; fingerprint?: string } | undefined;
        if (res.status === 202) {
          lastKey = screenKey(screen);
          if (body?.status === "saved") {
            log(
              `화면 저장 ${screen.pkg} 노드 ${screen.nodes.length}개 지문 ${body.fingerprint ?? "-"}`,
            );
          }
        } else {
          log(`screens ${res.status} ${JSON.stringify(res.body)}`);
        }
      }
      lastError = "";
    } catch (error) {
      // 같은 오류가 이어지면 한 번만 알린다 (예: 계속 움직이는 화면에 머무는 동안)
      const message = (error as Error).message;
      if (message !== lastError) log(error instanceof NotIdleError ? message : `오류: ${message}`);
      lastError = message;
    }
    if (args.once) return;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, interval - (Date.now() - started))),
    );
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
