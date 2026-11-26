import { idToken } from "./auth.ts";
import { mockApi } from "./mock.ts";
import type { CommandEntryDocument, Device, Pin, ScreenDocument, ScreenPage } from "./types.ts";

export const isMock = import.meta.env.VITE_MOCK === "1";

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${await idToken()}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => ({}))) as {
    error?: { reason?: string; message?: string };
  };
  if (!response.ok) {
    throw new ApiFailure(
      response.status,
      data.error?.reason ?? "unknown",
      data.error?.message ?? response.statusText,
    );
  }
  return data as T;
}

const enc = encodeURIComponent;

export interface ScreenQuery {
  since?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export interface Api {
  devices(): Promise<{ items: Device[]; serverTime: string }>;
  setLabel(deviceId: string, label: string): Promise<void>;
  screens(deviceId: string, query?: ScreenQuery): Promise<ScreenPage>;
  screen(deviceId: string, screenId: string): Promise<ScreenDocument>;
  /** 명령 기록 (목록의 entry: "command"). 화면과 같은 주소 */
  entry(deviceId: string, screenId: string): Promise<CommandEntryDocument>;
  pin(deviceId: string, from: string, to: string, name: string): Promise<Pin>;
  pins(): Promise<{ items: Pin[] }>;
}

const realApi: Api = {
  devices: () => request("GET", "/v1/dev/devices"),
  setLabel: (deviceId, label) => request("PATCH", `/v1/dev/devices/${enc(deviceId)}`, { label }),
  screens: (deviceId, query = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    return request("GET", `/v1/dev/devices/${enc(deviceId)}/screens${qs ? `?${qs}` : ""}`);
  },
  screen: (deviceId, screenId) =>
    request("GET", `/v1/dev/devices/${enc(deviceId)}/screens/${enc(screenId)}`),
  entry: (deviceId, screenId) =>
    request("GET", `/v1/dev/devices/${enc(deviceId)}/screens/${enc(screenId)}`),
  pin: (deviceId, from, to, name) =>
    request("PUT", `/v1/dev/devices/${enc(deviceId)}/pins`, { from, to, name }),
  pins: () => request("GET", "/v1/dev/pins"),
};

export const api: Api = isMock ? mockApi : realApi;
