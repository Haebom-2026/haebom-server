import type { ConnectCode, DeviceRecord, LinkRecord, UserProfile } from "./model.js";

export type RedeemResult = "ok" | "already-linked" | "code-unavailable";

/** 코드 조회 결과. active=false 면 같은 어르신이 새 코드를 받아 무효가 된 코드. */
export interface CodeLookup extends ConnectCode {
  active: boolean;
}

/**
 * S1 저장소. 조건부 쓰기(동시성)는 구현체가 보장한다.
 * DynamoDB 구현: aws-store.ts / 테스트: test/core-memory-store.ts
 */
export interface CoreStore {
  getUser(uid: string): Promise<UserProfile | undefined>;
  /** 이미 있으면 false */
  createUser(user: UserProfile): Promise<boolean>;
  updateUserName(uid: string, name: string, now: string): Promise<UserProfile | undefined>;

  putDevice(device: DeviceRecord): Promise<void>;
  deleteDevice(uid: string, deviceId: string): Promise<void>;
  listDevices(uid: string): Promise<DeviceRecord[]>;

  listLinksByElder(elderId: string): Promise<LinkRecord[]>;
  listLinksByGuardian(guardianId: string): Promise<LinkRecord[]>;
  setLinkNames(
    links: readonly LinkRecord[],
    names: { elderName?: string; guardianName?: string },
  ): Promise<void>;
  /** 없으면 false */
  deleteLink(elderId: string, guardianId: string): Promise<boolean>;

  /** 같은 번호가 아직 유효하면 false (호출자가 번호를 다시 뽑는다). 새 코드가 그 어르신의 유일한 유효 코드가 된다. */
  issueCode(code: ConnectCode, now: string): Promise<boolean>;
  getCode(code: string): Promise<CodeLookup | undefined>;
  /** 코드 사용 + 연결 생성을 한 번에. 코드가 그 사이 무효가 됐거나 이미 연결돼 있으면 실패. */
  redeemCode(code: string, link: LinkRecord, now: string): Promise<RedeemResult>;

  codeFailures(guardianId: string, now: Date): Promise<{ guardian: number; global: number }>;
  recordCodeFailure(guardianId: string, now: Date): Promise<void>;
}
