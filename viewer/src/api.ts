import { idToken } from "./auth.ts";
import type { CommandInsightView, LearnedMapView } from "./learn-types.ts";
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
  /** 배운 지도 (R4·R5): 연결선·목표·도착 화면·대기·반영 */
  learnedMap(): Promise<LearnedMapView>;
  /** 명령 하나의 단계·끝·Opus 검토·지도 반영 (R3~R5). 기기의 uid 로 찾음 */
  commandInsight(deviceId: string, commandId: number): Promise<CommandInsightView>;
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
  learnedMap: () => request("GET", "/v1/dev/map"),
  commandInsight: (deviceId, commandId) =>
    request("GET", `/v1/dev/devices/${enc(deviceId)}/commands/${commandId}`),
};

export const api: Api = isMock ? mockApi : realApi;
