# S3 API: 보호자 승인

- 작성일: 2026-11-26
- 대상: 고령자 앱 (#9·#10·#19), 보호자 앱 (#13·#23·#24, FCM)
- 상태: **dev 배포 완료**
- 기준: 지침서 4.2·5.5·8장, [서버 기획](../server-plan.md) 4.2·6장, 두 앱 검토 답변 (보호자 앱 2.3·2.4·2.5, 고령자 앱 3.3·3.4·3.5)

> 보호자 승인은 **거래 승인이 아닙니다.** "도우미가 계속 도와 드려도 되는지"만 묻습니다. 보호자 앱 문구도 "송금을 허락합니다"가 아니라 "계속 도와 드려도 될까요?"로 써 주세요 (지침서 8.4).

공통 규칙(Base URL, 인증, Idempotency-Key, 오류 형식)은 [S1 문서 1장](s1-users-links.md#1-공통)과 같습니다. 모든 경로는 `POST /v1/users/me`로 역할을 등록한 뒤 부를 수 있습니다.

---

## 1. 흐름

```
고령자 앱 ── #9 승인 요청 ──▶ 서버: 연결된 보호자마다 대기 중 항목 + FCM(approval_requests)
                                       │  응답 시간 5분
보호자 앱 ── #13 approved/rejected ──▶ 서버: 첫 유효 응답만 반영
                                       └─ 고령자 기기에 결과 FCM (data) + 다른 보호자에게 목록 갱신 FCM
고령자 앱 ◀── FCM 또는 #19 폴링(3초) ── approved → 2.5초 뒤 지금 화면으로 다시 판단해 안내 계속
```

### 상태

| `status`    | 뜻                                                  | 고령자 앱 (지침서 5.5)                                                          |
| ----------- | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| `pending`   | 대기 중 (5분)                                       | "{보호자}에게 … 물어봤어요. 잠시 기다려 주세요." + [기다리지 않기]. 안내만 멈춤 |
| `approved`  | 보호자가 허락                                       | "{respondedByLabel}가 허락했어요. 이어서 안내할게요."                           |
| `rejected`  | 보호자가 멈추자고 함                                | "{respondedByLabel}가 이번에는 멈추자고 했어요." → 종료                         |
| `expired`   | 5분 동안 응답 없음                                  | 안내 종료 → SOS 제안                                                            |
| `cancelled` | 어르신이 취소, 또는 **연결된 보호자가 모두 해제됨** | "기다리기를 그만뒀어요." → 종료                                                 |

- 대기 중 상태에서만 바뀌고, 한 번 바뀌면 다시 바뀌지 않습니다.
- 응답 시간이 지난 요청은 서버가 1분 안에 `expired`로 바꿉니다. 그 전에 조회해도 `expired`로 보입니다.

---

## 2. 고령자 앱

### #9 `POST /v1/elder/approvals`: 승인 요청

`Idempotency-Key`를 받습니다.

```json
{
  "packageName": "kr.go.minwon.m",
  "appName": "정부24",
  "action": "guide_gov24_auth",
  "category": "public"
}
```

| 필드          | 필수 | 규칙                                                        |
| ------------- | ---- | ----------------------------------------------------------- |
| `packageName` | ✅   | 200자까지                                                   |
| `appName`     | ✅   | 100자까지                                                   |
| `action`      | ✅   | `guide_`로 시작하는 소문자·숫자·`_` (아래 표). 새 값도 받음 |
| `category`    |      | S2와 같은 값 (`finance`, `identity`, `public` …)            |

| `action`             | 언제                                 |
| -------------------- | ------------------------------------ |
| `guide_gov24_auth`   | 정부24 본인인증 화면                 |
| `guide_bank_open`    | 은행 앱 열기 전                      |
| `guide_money_move`   | 송금·이체·대출 화면                  |
| `guide_identity`     | 본인인증·신분증 제출 (정부24 외)     |
| `guide_install`      | 출처 모를 앱 설치·권한 허용          |
| `guide_privacy_send` | 개인정보·신분증 사진 보내기          |
| `guide_unknown_app`  | 고령자 앱이 쓰는 값 (모르는 민감 앱) |

| HTTP | 응답                                                                 | 뜻                                                       |
| ---- | -------------------------------------------------------------------- | -------------------------------------------------------- |
| 201  | `{ "result": "created", "approvalId": "a2026…", "expiresAt": "…" }`  | 새 요청                                                  |
| 200  | `{ "result": "existing", "approvalId": "a2026…", "expiresAt": "…" }` | **같은 action이 이미 대기 중** → 그 요청을 그대로 기다림 |
| 200  | `{ "result": "no_guardians" }`                                       | 연결된 가족이 없음                                       |
| 오류 | 네트워크·5xx                                                         | 문자 SOS 제안 (지침서 5.5)                               |

### #10 `POST /v1/elder/approvals/{id}/cancel`: 취소

[기다리지 않기], 대기 중 새 명령, [그만하기] 때 부릅니다. 본문 없음.

- 200: 취소된 승인 (#19와 같은 모양, `status: "cancelled"`)
- 409 (`already-responded` / `approval-expired` / `approval-cancelled`), 404: **무시**하면 됩니다.

### #19 `GET /v1/elder/approvals/{id}`: 결과 조회

FCM이 빠질 때를 대비해 대기 중 **3초 간격**으로 부릅니다 (최대 5분).

```json
{
  "id": "a20261126T103329720Z-642356",
  "status": "approved",
  "action": "guide_gov24_auth",
  "packageName": "kr.go.minwon.m",
  "appName": "정부24",
  "category": "public",
  "createdAt": "2026-11-26T10:33:29.720Z",
  "expiresAt": "2026-11-26T10:38:29.720Z",
  "respondedAt": "2026-11-26T10:33:31.000Z",
  "respondedBy": "g_1",
  "respondedByLabel": "큰딸"
}
```

- `respondedBy`, `respondedByLabel`, `respondedAt`은 승인·거절일 때만 옵니다.
- `respondedByLabel`은 **응답한 보호자를 어르신이 부르는 호칭**입니다 (`guardianLabel`, 비어 있으면 보호자 이름). 응답 직후 그 보호자가 해제돼도 이 값으로 안내할 수 있습니다.
- 앱은 `expiresAt + 5초`가 지나면 서버와 관계없이 끝난 것으로 처리합니다 (지침서 5.5).

---

## 3. 보호자 앱

### #13 `POST /v1/guardian/approvals/{id}/respond`: 승인·거절

`Idempotency-Key`를 붙여 주세요.

```json
{ "decision": "approved" }
```

`decision`: `approved` / `rejected`. 200이면 응답이 반영된 승인을 돌려줍니다 (#24와 같은 모양).

| HTTP | reason               | 보호자 앱 문구                                  |
| ---- | -------------------- | ----------------------------------------------- |
| 409  | `already-responded`  | 이미 다른 보호자가 응답한 요청입니다.           |
| 409  | `approval-expired`   | 응답 가능 시간이 지나 요청이 만료되었습니다.    |
| 409  | `approval-cancelled` | 가족이 요청을 취소했습니다.                     |
| 404  | `not-found`          | 없는 요청, 또는 **연결이 해제된 어르신**의 요청 |

- **첫 유효 응답만** 반영합니다. 보호자 두 명이 동시에 눌러도 한 명만 성공하고, 다른 쪽은 `already-responded`입니다.

### #23 `GET /v1/guardian/approvals`: 목록

| 쿼리     | 규칙                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------- |
| `status` | `pending`: 응답이 필요한 요청만 (만료 전). `all`(기본): 지난 요청 포함                          |
| `limit`  | 1~50, 기본 20                                                                                   |
| `cursor` | 앞 응답의 `nextCursor`                                                                          |
| `since`  | 이 시각 **뒤에 생기거나 상태가 바뀐** 요청만. 앞 응답의 `serverTime`을 넣습니다 (iPhone 폴링용) |

```json
{
  "items": [
    {
      "id": "a20261126T103329720Z-642356",
      "elderId": "e_1",
      "elderName": "김순자",
      "elderLabel": "어머니",
      "status": "pending",
      "action": "guide_gov24_auth",
      "packageName": "kr.go.minwon.m",
      "appName": "정부24",
      "category": "public",
      "createdAt": "2026-11-26T10:33:29.720Z",
      "expiresAt": "2026-11-26T10:38:29.720Z",
      "updatedAt": "2026-11-26T10:33:29.720Z"
    }
  ],
  "nextCursor": "QVBQUk9W…",
  "serverTime": "2026-11-26T10:33:36.591Z"
}
```

- 최신순입니다. 남은 시간은 `expiresAt - 지금`으로 계산합니다.
- 승인·거절된 요청에는 `respondedAt`, `respondedBy`, `respondedByLabel`이 붙습니다. "누가 언제" 표시(지침서 8.2)에 씁니다.
- **연결을 해제한 어르신의 요청은 나오지 않습니다.**
- `status=pending`이나 `since`를 쓰면 한 페이지에 `limit`보다 적게 올 수 있습니다. `nextCursor`가 있으면 다음 페이지를 이어서 받아 주세요.

### #24 `GET /v1/guardian/approvals/{id}`: 상세

#23 항목 하나와 같은 모양입니다. 없으면 404입니다.

---

## 4. FCM

| 언제                         | 받는 사람          | 메시지                                                                                   |
| ---------------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| 승인 요청이 생김             | 각 보호자          | `data: { kind: "approval", id, elderId }` + 화면 알림 (채널 `approval_requests`, 높음)   |
| 상태가 바뀜 (응답·만료·취소) | 어르신             | `data: { kind: "approval", id, status, respondedBy?, respondedByLabel? }` (data만, 높음) |
| 상태가 바뀜                  | 남아 있는 보호자들 | `data: { kind: "approval", id, status, elderId }` (data만, 목록 갱신용)                  |

- 화면 알림 문구: title `해봄 가족 · 승인 요청`, body `가족이 도움을 받아도 될지 물어요. 앱에서 확인해 주세요.` S2 알림 문구와 같은 형식이고, 앱 이름·내용은 넣지 않습니다. **보호자 앱 확인이 필요합니다.**
- 보호자 앱은 `approval_requests` 채널을 미리 만들어 두어야 합니다.
- 고령자 앱은 결과 메시지를 받으면 `respondedByLabel`로 바로 안내할 수 있어서 #19를 부르지 않아도 됩니다.

---

## 5. 연결 해제와 승인

- 보호자 한 명이 해제하면: 대기 중 요청에서 그 보호자만 빠집니다. 다른 보호자는 그대로 응답할 수 있습니다.
- **연결된 보호자가 모두 해제되면**: 대기 중 요청은 `cancelled`가 되고, 어르신 기기에 결과 FCM이 갑니다 (고령자 앱 요청 3.3).
- 해제한 보호자의 목록에서는 그 어르신의 요청이 모두 사라집니다 (보호자 앱 요청).

## 6. 확인 상태

- 단위 테스트: 승인 시나리오 14개 + push 2개
- dev 실제 확인
  - 요청 → 같은 action 재요청은 `existing` → 보호자 대기 목록 → 승인(`respondedByLabel: 큰딸`) → 다른 보호자 응답은 `already-responded` → 어르신 조회 `approved`
  - 취소 → 다시 취소하면 `approval-cancelled`
  - 보호자 두 명 모두 해제하면 대기 중 요청이 `cancelled`, 보호자 목록은 빔
  - 5분 뒤 expire-fn이 `expired`로 바꾸는 것 (만료 59초 뒤 처리, 어르신 결과 FCM 발송)
- FCM: 승인 요청 화면 알림, 어르신 결과 data를 실제 서비스 계정으로 보내 FCM이 형식을 받아들이는 것까지 확인 (가짜 토큰이라 토큰 오류로 끝남)
- **아직 확인하지 않은 것**: 실제 폰 표시, 고령자 앱이 결과를 받아 2.5초 뒤 안내를 이어 가는 흐름. 앱 연동 때 확인 부탁드립니다.
