# 해봄 서버 기획 (초안 v0.1)

- 작성일: 2026-11-26
- 기반 문서: `해봄_개발지침서.docx` (2026-11-26, 고령자 앱 담당 작성)
- 범위: **서버만** (고령자 앱·보호자 앱이 호출하는 API, 데이터, 푸시, LLM 판단)
- 스택 결정 (확정)
  - 런타임: **AWS Lambda (Node.js 24, arm64) + API Gateway HTTP API + DynamoDB**
  - 언어: **TypeScript**
  - LLM: **Claude Sonnet 5.5 (`claude-sonnet-5-5`)**, **Anthropic API 직접 호출** (Bedrock 사용 안 함, API 키는 Secrets Manager `haebom-<env>/anthropic-api-key`)
  - IaC: **Terraform**, 이 저장소의 `infra/` 에 함께 둠
  - AWS 계정: **`045861054142`** (서울 `ap-northeast-2`), dev·prod 같은 계정
- 캐싱 설계: **별도 문서로 받을 예정** → 이 문서에는 끼워 넣을 자리(9장)만 잡아 둠

> 지침서는 Claude Haiku를 가정했지만 이 기획은 Sonnet 5.5로 바꾼다. 응답 속도와 토큰 단가가 달라지므로 5.1의 지연·비용 메모를 따른다.

> 상태 표시: **확정**(이번에 정함) · **제안**(서버 쪽 제안, 앱과 합의 필요) · **협의**(정해야 함)

---

## 0. 지침서 대비 바뀌는 점 요약

지침서는 서버를 **Firebase Functions + Firestore + FCM** 으로 가정했다. 이번 서버는 **Lambda + DynamoDB** 이므로 아래가 달라진다.

| 항목        | 지침서 가정                                        | 이 기획                                                             | 앱에 미치는 영향                        |
| ----------- | -------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------- |
| 런타임      | Firebase Functions                                 | API Gateway(HTTP API) + Lambda                                      | 주소만 바뀜                             |
| DB          | Firestore                                          | DynamoDB                                                            | 앱이 DB를 **직접 읽을 수 없음**         |
| 실시간 구독 | Firestore 스냅샷 리스너 (approvals, notifications) | **FCM 데이터 메시지 + 조회 API(폴링 보조)**                         | 구독 코드 → 푸시 수신 + GET 호출로 교체 |
| 인증        | Firebase Auth ID 토큰                              | **그대로 유지** (API Gateway JWT Authorizer가 Firebase 토큰 검증)   | 변경 없음                               |
| 푸시        | FCM                                                | **그대로 FCM** (Lambda에서 FCM HTTP v1 호출)                        | 변경 없음                               |
| AI          | 서버 함수가 Haiku 호출                             | Lambda가 **Sonnet 5.5**를 Anthropic API로 호출 + **응답 캐시 계층** | 변경 없음                               |
| 승인 만료   | 예약 작업 1분                                      | EventBridge 1분 + **읽을 때 만료 판정(lazy)**                       | 변경 없음                               |

**핵심 영향**: 지침서 5.2 끝의 "Firestore 직접 접근(읽기만)" 부분이 전부 **GET 엔드포인트**로 바뀐다 (4.3절 #18~#24). 1단계(앱끼리 Firestore 직접 연결)는 테스트 프로젝트에서 그대로 진행해도 되고, 2단계 전환 시 앱의 "데이터 처리 한 곳"만 바꾸면 된다는 원칙은 유지된다.

---

## 1. 서버의 역할

1. **화면 안내 판단 (#16 guide)** — 고령자 앱이 보낸 접근성 요소 목록(최대 60개)과 목표를 보고, 다음에 누를 요소/말할 문장을 LLM으로 결정.
2. **명령 민감도 판단 (#17 classify)** — 명령 문장 + 규칙 결과 + 상황 신호로 intent·민감도(L0~L3)·분류를 LLM으로 판단.
3. **보호자 연동** — 가족 연결(코드), 민감 알림, SOS·막힘 알림, 승인 요청/응답/만료.
4. **푸시** — 보호자에게 알림·승인 요청, 고령자에게 승인 결과.
5. **비용 통제** — 응답 캐시(별도 설계), 사용량 제한, 토큰 로깅.

### 지켜야 할 원칙 (지침서 1.5 · 4.6 · 9.3 계승)

- **민감 정보 미수신·미보관**: 비밀번호·인증번호·주민번호·계좌번호·금액·화면 캡처는 받지 않는다. 받더라도 서버에서 한 번 더 걸러 낸다(7.4).
- **화면 nodes는 보관하지 않는다.** 로그에 명령 문장은 가능, nodes는 불가.
- **AI는 올리기만**: 최종 민감도 = max(규칙, AI). 서버도 `ruleLevel`보다 낮은 값을 돌려주지 않는다.
- **AI 실패 = 정상 응답 모양**: #16은 `{type:"say"}`, #17은 실패 시 규칙 결과 그대로 반환(또는 오류 → 앱이 무시).
- **승인은 거래 승인이 아니다**: "도우미가 계속 도와도 되는지"만 다룬다.
- **API 키는 서버에만** (Secrets Manager).

---

## 2. 아키텍처

```
 고령자 앱 (Kotlin)          보호자 앱 (Flutter)
      │  Firebase ID 토큰         │
      ▼                           ▼
 ┌──────────────── API Gateway (HTTP API) ────────────────┐
 │  JWT Authorizer: iss=securetoken.google.com/<project>  │
 │  스로틀링 (경로별)                                      │
 └───────┬───────────────────────────┬────────────────────┘
         │ /v1/elder/guide, classify │ 나머지 /v1/*
         ▼                           ▼
   ┌───────────┐               ┌───────────┐
   │ ai-fn     │               │ api-fn    │  (라우터 1개 Lambda)
   │ (Lambda)  │               │ (Lambda)  │
   └─┬───┬─────┘               └─────┬─────┘
     │   │                           │
     │   └──► 캐시 계층 (9장, 별도 설계)│
     │                               │
     ▼                               ▼
  Anthropic API              DynamoDB (haebom-main, haebom-idem, ...)
  (claude-sonnet-5-5)                │ Streams
                                     ▼
                              ┌───────────┐       FCM HTTP v1
                              │ push-fn   │ ────► 보호자 / 고령자 기기
                              └───────────┘
   EventBridge (1분) ──► expire-fn (승인 만료)
```

### Lambda 구성 (제안)

| 함수        | 담당                                  | 메모리/타임아웃 | 이유                                                              |
| ----------- | ------------------------------------- | --------------- | ----------------------------------------------------------------- |
| `api-fn`    | #1~#15, #18~#24 (CRUD·연결·알림·승인) | 512MB / 10s     | 라우터 하나로 묶어 콜드 스타트·배포 단순화                        |
| `ai-fn`     | #16 guide, #17 classify               | 1024MB / 12s    | 타임아웃·동시성·비용 모니터링을 분리. 프로비저닝 동시성 검토 대상 |
| `push-fn`   | DynamoDB Streams → FCM 발송           | 256MB / 30s     | 요청 응답 지연에서 푸시를 분리, 재시도는 Streams가 처리           |
| `expire-fn` | 1분마다 만료된 pending 승인 → expired | 256MB / 60s     | 지침서 9.2 승인 만료                                              |

- 언어: **확정** — TypeScript, Lambda 런타임 `nodejs24.x`, 아키텍처 `arm64`. esbuild로 함수별 번들(zip).
- 주요 라이브러리: `@anthropic-ai/sdk`(Claude), `@aws-sdk/client-dynamodb` + `lib-dynamodb`, `zod`(요청·LLM 출력 검증), FCM은 `google-auth-library` + FCM HTTP v1 직접 호출(firebase-admin 전체 번들은 무거움 — 측정 후 결정).
- IaC: **확정** — Terraform (11장). dev / prod 두 환경.
- 리전: `ap-northeast-2` (서울).

### 인증

- 앱은 지금처럼 Firebase Auth(고령자: 익명, 보호자: 로그인)로 ID 토큰을 받아 `Authorization: Bearer` 로 보낸다.
- API Gateway HTTP API의 **JWT Authorizer**에 issuer `https://securetoken.google.com/<firebase-project-id>`, audience `<firebase-project-id>` 로 설정하면 Lambda 코드 없이 서명·만료 검증이 끝난다. `sub` 가 uid.
- **role 검사**는 `api-fn`/`ai-fn` 안에서 `users` 항목을 읽어 수행 (`/v1/elder/*` → elder, `/v1/guardian/*` → guardian). 짧은 TTL 메모리 캐시로 DynamoDB 조회를 줄인다.
- Cognito로 옮길 이유는 현재 없음 (앱 변경만 생김).

---

## 3. 데이터 설계 (DynamoDB)

### 3.1 접근 패턴

| #   | 패턴                                         | 사용처                           |
| --- | -------------------------------------------- | -------------------------------- |
| A1  | uid로 프로필(role, name) 조회                | 모든 요청의 role 검사            |
| A2  | uid의 푸시 토큰 목록                         | 푸시 발송                        |
| A3  | 어르신의 연결된 보호자 목록                  | 보호자 결정, 고령자 앱 가족 목록 |
| A4  | 보호자의 연결된 어르신 목록                  | 보호자 앱 어르신 목록            |
| A5  | 연결 코드로 어르신 찾기 + 이전 코드 무효화   | #11, #14                         |
| A6  | 같은 어르신+같은 앱 10분 내 알림 있었는지    | sensitive_entry 중복 방지        |
| A7  | 보호자 알림함 최신순 페이지 조회 + 읽음 처리 | 보호자 앱 알림 목록              |
| A8  | 승인 ID로 조회/상태 변경(조건부)             | #10, #13, 고령자 폴링            |
| A9  | 같은 어르신+같은 action pending 승인 있는지  | 승인 중복                        |
| A10 | 만료 시각 지난 pending 승인 목록             | expire-fn                        |
| A11 | 보호자의 pending 승인 목록                   | 보호자 앱 승인 화면              |
| A12 | Idempotency-Key로 이전 응답 조회             | 생성 요청 재시도                 |
| A13 | 어르신별 일일 AI 호출 수                     | 비용 제한                        |

### 3.2 테이블 (단일 테이블 + 보조 테이블 2개)

**`haebom-main`** — PK `PK`, SK `SK`, GSI1(`GSI1PK`,`GSI1SK`), GSI2(`GSI2PK`,`GSI2SK`, sparse), TTL `ttl`, Streams on (NEW_AND_OLD_IMAGES)

| 엔티티                 | PK               | SK                           | GSI1                                   | GSI2                                       | 주요 속성                                                                                            |
| ---------------------- | ---------------- | ---------------------------- | -------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 사용자                 | `USER#<uid>`     | `PROFILE`                    | –                                      | –                                          | role, name, createdAt                                                                                |
| 기기                   | `USER#<uid>`     | `DEVICE#<deviceId>`          | –                                      | –                                          | fcmToken, platform, updatedAt                                                                        |
| 연결                   | `ELDER#<eid>`    | `LINK#<gid>`                 | `GUARDIAN#<gid>` / `LINK#<eid>`        | –                                          | elderName, guardianName, elderLabel, guardianLabel, connectedAt (S1 반영, relationship 은 쓰지 않음) |
| 연결 코드              | `CODE#<6자리>`   | `CODE`                       | –                                      | –                                          | elderId, expiresAt, used, ttl                                                                        |
| 현재 코드 포인터       | `ELDER#<eid>`    | `ACTIVECODE`                 | –                                      | –                                          | code. 연결할 때 이 값과 다른 코드는 거부 → 새 발급 시 이전 코드 자동 무효                            |
| 알림 (원본)            | `ELDER#<eid>`    | `NOTI#<ts>#<nid>`            | –                                      | –                                          | type, appName, packageName, level, category, reason, guardianIds                                     |
| 알림함 (보호자별 복사) | `GUARDIAN#<gid>` | `NOTI#<ts>#<nid>`            | –                                      | –                                          | 위 요약 + elderId, elderName, readAt                                                                 |
| 중복 방지 표식         | `ELDER#<eid>`    | `DEDUP#<packageName>`        | –                                      | –                                          | until(=+10분), ttl                                                                                   |
| 승인                   | `APPROVAL#<aid>` | `META`                       | `ELDER#<eid>` / `APPROVAL#<createdAt>` | `PENDING` / `<expiresAt>` (pending일 때만) | action, appName, category, status, guardianIds, expiresAt, respondedAt, respondedBy                  |
| 승인 보호자 인덱스     | `GUARDIAN#<gid>` | `APPROVAL#<createdAt>#<aid>` | –                                      | –                                          | aid, 요약 (상태는 원본 조회)                                                                         |
| pending 잠금           | `ELDER#<eid>`    | `PENDING#<action>`           | –                                      | –                                          | aid (승인 중복 방지, 상태 변경 시 삭제)                                                              |
| AI 사용량              | `ELDER#<eid>`    | `USAGE#<yyyy-mm-dd>`         | –                                      | –                                          | guideCalls, classifyCalls, inTokens, outTokens, ttl(+35일)                                           |

설계 메모:

- **guardianIds 배열 대신 보호자별 알림함 복사(fan-out on write)**: DynamoDB는 "배열에 내가 포함" 쿼리가 안 되므로. 가족 수가 적어(보통 1~4명) 쓰기 비용 문제 없음. `readBy{uid}` 는 알림함 항목의 `readAt` 으로 바뀐다.
- **중복 방지(A6)**: `DEDUP#<pkg>` 를 `attribute_not_exists(PK) OR until < :now` 조건부 Put. 성공하면 알림 생성, 실패하면 `duplicate_suppressed`. 트랜잭션(TransactWriteItems)으로 표식 + 원본 + 알림함을 한 번에 쓴다.
- **연결 코드 충돌**: `CODE#<6자리>` 를 `attribute_not_exists` 조건부 Put, 충돌 시 재생성. 사용 시 `used=false AND expiresAt > now` 조건부 Update(일회용 보장).
- **만료(A10)**: GSI2 sparse 인덱스 `PENDING` 파티션을 `GSI2SK < now` 로 Query. 트래픽이 작아 단일 파티션으로 충분. DynamoDB TTL은 삭제가 최대 수십 시간 늦을 수 있어 **만료 판정에 쓰지 않는다** (청소용으로만).
- **lazy 만료**: 승인을 읽거나 응답(#13)할 때 `status=pending AND expiresAt < now` 면 그 자리에서 expired로 바꾼다 → expire-fn이 늦어도 정확.

**`haebom-idem`** — PK `key` (`<uid>#<Idempotency-Key>`), 속성 statusCode, body, ttl(+24h). 처리 시작 시 `IN_PROGRESS` 로 조건부 Put, 끝나면 결과 저장. 같은 키가 오면 저장된 응답 그대로 반환.

**`haebom-ai-cache`** — 9장 캐싱 설계에 따라 정함. S0에서는 만들지 않음.

### 3.3 지침서 5.8(Firestore 규격) ↔ API 응답 모양

앱 쪽 필드 이름은 **그대로** 유지한다. 서버는 DynamoDB 키(PK/SK/GSI)를 응답에 노출하지 않고, 지침서 5.8 문서 모양으로 바꿔서 돌려준다. 1단계에서 앱끼리 검증한 모양이 그대로 API 응답 스키마가 된다.

---

## 4. API

### 4.1 공통 규칙 (지침서 5.1 유지)

주소 `https://<api-domain>/v1/...`, Bearer ID 토큰, 본문에 uid 넣지 않음, ISO 8601 UTC, 생성 요청에 `Idempotency-Key`, 오류 `{ "error": { "reason", "message" } }`.

| reason              | HTTP | 언제                                  |
| ------------------- | ---- | ------------------------------------- |
| `unauthenticated`   | 401  | 토큰 없음/만료 (API Gateway가 반환)   |
| `profile-required`  | 403  | users 프로필 없음 → 앱이 #2 후 재시도 |
| `permission-denied` | 403  | role 불일치, 남의 리소스              |
| `invalid-argument`  | 400  | 스키마 위반                           |
| `not-found`         | 404  |                                       |
| `conflict`          | 409  | 상태 전이 불가(이미 응답·만료·취소)   |
| `rate-limited`      | 429  | 사용량 초과                           |
| `unavailable`       | 503  | 일시 장애 → 같은 키로 1번 재시도      |

### 4.2 지침서 엔드포인트 (#1~#17)

| #   | 메서드 · 경로                            | Lambda | 메모                                                                                             |
| --- | ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| 1   | GET /v1/healthz                          | api-fn | 인증 없음                                                                                        |
| 2   | POST /v1/users/me                        | api-fn | role, name. 이미 있으면 role 변경 불가(409)                                                      |
| 3   | PATCH /v1/users/me                       | api-fn | name. 연결 항목의 elderName/guardianName도 갱신                                                  |
| 4   | PUT /v1/devices/{deviceId}               | api-fn | fcmToken, platform                                                                               |
| 5   | DELETE /v1/devices/{deviceId}            | api-fn |                                                                                                  |
| 6   | POST /v1/elder/sensitive-entries         | api-fn | created / duplicate_suppressed / no_guardians. level·category·reason 수용                        |
| 7   | POST /v1/elder/stuck                     | api-fn | 중복 방지 없음                                                                                   |
| 8   | POST /v1/elder/sos                       | api-fn | 중복 방지 없음. category·reason 선택 필드 수용                                                   |
| 9   | POST /v1/elder/approvals                 | api-fn | action `guide_*` 수용(7종 + 새 값). 같은 action pending이면 `existing`으로 기존 approvalId 반환  |
| 10  | POST /v1/elder/approvals/{id}/cancel     | api-fn | pending만, 아니면 409 (already-responded / approval-expired / approval-cancelled)                |
| 11  | POST /v1/elder/connect-codes             | api-fn | 6자리, 10분, 일회용, 이전 코드 무효                                                              |
| 12  | DELETE /v1/elder/links/{guardianId}      | api-fn | 204. 없으면 404 not-found (S1 구현)                                                              |
| 13  | POST /v1/guardian/approvals/{id}/respond | api-fn | `{decision: approved \| rejected}`. pending·만료 전·연결된 보호자만, 첫 응답만. 409 reason 3종   |
| 14  | POST /v1/guardian/links                  | api-fn | `{code, elderLabel, guardianLabel}`, Idempotency-Key. reason 은 [S1 문서](api/s1-users-links.md) |
| 15  | DELETE /v1/guardian/links/{elderId}      | api-fn |                                                                                                  |
| 16  | POST /v1/elder/guide                     | ai-fn  | 5장                                                                                              |
| 17  | POST /v1/elder/classify                  | ai-fn  | 5장                                                                                              |

#13~#15 경로는 지침서에서 `SERVER_API.md` 로 미정이었으므로 위 경로를 **제안**한다.

### 4.3 추가 엔드포인트 (Firestore 직접 읽기 대체) — 제안

| #   | 메서드 · 경로                                         | 호출   | 대체하는 것                                               |
| --- | ----------------------------------------------------- | ------ | --------------------------------------------------------- |
| 18  | GET /v1/elder/links                                   | 고령자 | links(elderId == 나) 조회                                 |
| 19  | GET /v1/elder/approvals/{id}                          | 고령자 | approvals/{id} 구독 (FCM 못 받았을 때 폴링)               |
| 20  | GET /v1/guardian/links                                | 보호자 | links(guardianId == 나) 조회                              |
| 21  | GET /v1/guardian/notifications?cursor=&since=         | 보호자 | notifications 구독 (최신순 페이지, since·serverTime 폴링) |
| 22  | POST /v1/guardian/notifications/{id}/read             | 보호자 | 보호자별 readAt (204)                                     |
| 23  | GET /v1/guardian/approvals?status=pending\|all&since= | 보호자 | approvals 구독 (지난 요청 포함, since·serverTime 폴링)    |
| 24  | GET /v1/guardian/approvals/{id}                       | 보호자 | 승인 상세(남은 시간)                                      |

### 4.4 실시간성 대체 방식

| 상황                      | 방식                                                                                                                                | 지침서 요구                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 보호자에게 알림·승인 요청 | push-fn이 FCM 알림 발송 (우선순위는 지침서 8.3) → 앱은 탭/수신 시 #21·#23 조회                                                      | 8.3                             |
| 고령자에게 승인 결과      | 승인 상태 변경 → Streams → push-fn이 **고령자 기기에 FCM data 메시지**(high priority) `{approvalId, status}`                        | "승인 → 2.5초 안에 이어서 안내" |
| 연결 생성·해제 (S1)       | 연결 항목 Streams → push-fn이 어르신·보호자 모든 기기에 FCM data `{kind:"link", change, elderId, guardianId}` → 앱은 #18·#20 재조회 | 두 앱 요청                      |
| FCM 누락 대비             | 고령자 앱은 대기 중 **3초 간격으로 #19 폴링** (최대 5분 ≈ 100회, 비용 무시 가능)                                                    | 5.5                             |
| 보호자 앱이 켜진 상태     | 화면 진입·포그라운드 복귀 시 조회 + FCM 수신 시 갱신                                                                                |                                 |

WebSocket(API Gateway WebSocket API)은 연결 관리 비용 대비 이득이 작아 **1차에서는 제외**. 보호자 앱에 실시간 대시보드가 필요해지면 재검토.

---

## 5. AI 판단 설계

### 5.1 공통

- 모델: **`claude-sonnet-5-5`** (확정). 호출 경로: **Anthropic API 직접**, SDK는 `@anthropic-ai/sdk`. API 키는 별도로 받아 **Secrets Manager에만** 넣는다(코드·tfvars·Terraform state·환경 변수 평문 금지, 11.4).
- **구조화 출력**(`output_config.format` JSON 스키마)으로 응답 모양을 강제한다. 프롬프트로 "JSON만 답하라"에 의존하지 않는다. 받은 뒤에도 zod로 다시 검증한다.
- **Sonnet 5.5 API 주의점** (Haiku 기준으로 쓴 코드와 다름)
  - `thinking: {type: "disabled"}` 는 **400 오류**. thinking을 끄려면 `thinking: {type: "between_tools"}` (effort `high` 이하에서만, 다른 필드 같이 넣으면 400).
  - effort 기본값은 `high`. 짧은 판단 작업이므로 명시적으로 낮춘다.
  - `temperature`·`top_p`·`top_k` 를 기본값 아닌 값으로 보내면 400 → 보내지 않는다.
  - 강제 도구 호출(`tool_choice: any/tool`)은 400 → 도구 대신 구조화 출력을 쓰므로 해당 없음.
  - 안전 분류기가 거절하면 HTTP 200 + `stop_reason: "refusal"` 로 온다. **`stop_reason` 을 먼저 확인**하고, 거절이면 대체 응답(#16 `say`, #17 규칙 결과). 사기·금융 관련 문장이 많아 오탐 가능성이 있으므로 거절 건수를 메트릭으로 남긴다. 서버 측 fallback(`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) 적용 여부는 측정 후 결정.
- **지연 시간**: Sonnet은 Haiku보다 느리다. 지침서 목표(#17 4초, #16 9초)를 지키기 위해
  - 시작 설정: #17 `thinking: between_tools` + effort `low`, #16 effort `low` (thinking 유무는 정확도·지연을 같이 측정해 결정)
  - `max_tokens` 를 작게 (#17 ≈ 256, #16 ≈ 512)
  - S4·S5 단계에서 p50/p95를 재고, #17 4초를 못 맞추면 **목표 완화 vs 모델 분리(#17만 Haiku)** 를 다시 협의
- **비용**: Sonnet 5.5 기준 입력 $2 / 출력 $10 (100만 토큰당), 프롬프트 캐시 읽기 $0.10. Haiku 대비 단가가 높으므로 9장 응답 캐시와 아래 프롬프트 캐싱의 효과가 더 크다.
- **프롬프트 캐싱(Anthropic 쪽)**: 시스템 프롬프트(4장 표, 앱 이름 예시, 출력 규칙)를 **매 요청 바이트 동일**하게 두고 `cache_control` 을 건다. Sonnet 5.5 최소 캐시 단위 512토큰 → 시스템 프롬프트가 이보다 길면 입력 토큰 비용이 크게 줄어든다. 요청마다 바뀌는 값(시각, requestId 등)은 시스템 프롬프트에 넣지 않는다. `usage.cache_read_input_tokens` 로 실제 적중을 확인한다. 9장의 응답 캐시와는 **별개이며 함께 쓴다**.
- 타임아웃: SDK 클라이언트 타임아웃 #17 3.5초 / #16 8.5초, 재시도 0~1회(남은 시간 안에서만). 초과 시 대체 응답.
- 로그: 모델, 입력/출력/캐시 토큰, 지연, 캐시 적중 여부, intent/level 결과. **nodes와 say 원문의 화면 내용은 남기지 않는다.**

### 5.2 #17 classify

> jev(고르기 전용 모델)로 앱·목표를 먼저 고르는 구조를 기획 중: [jev 라우팅 + 스스로 자라는 지도 기획](jev-routing-plan.md). S4는 그 구조로 만든다: 아래 LLM 안전 분류는 jev와 상관없이 늘 돌고, jev가 고른 지도 목표의 민감도는 올리는 데만 쓴다 (그 문서 5.1).

```
요청 { commandId, utterance, ruleLevel, ruleApp, signals[] }
응답 { commandId, intent, app, sensitivity: { level, category, reason, signals } }
```

처리 순서:

1. 입력 검증 (utterance ≤ 200자, signals는 허용 목록만).
2. **민감 정보 필터**(7.4) — 숫자열(주민·계좌·카드 패턴)은 마스킹 후 LLM에 전달.
3. 캐시 조회(9장) → 적중 시 바로 반환.
4. LLM 호출: 시스템 프롬프트 = 지침서 4.2 단계표 + 4.3 분류표 + 4.4 상황 신호 규칙 + 9.3 앱 이름 예시.
5. **후처리 (서버가 최종 보장)**:
   - `level = max(ruleLevel, llmLevel)`
   - signals가 하나라도 있으면 한 단계 올림 (최대 L3) — LLM이 빠뜨려도 서버가 보정
   - category가 `scam` 이면 level은 L3
   - enum 밖 값 → UNKNOWN / none 으로 치환
6. 실패·시간 초과 → 503 대신 **규칙 결과를 그대로 담은 200** 을 줄지, 오류를 줄지 **협의** (앱은 어느 쪽이든 규칙 결과로 진행하므로 영향 없음. 서버 쪽 제안: 오류 반환 + `reason: ai-timeout`, 앱이 무시).

### 5.3 #16 guide

```
요청 { requestId, goal, utterance, slots, history[], screen: { pkg, hash, nodes[≤60] } }
응답 { requestId, type, say, target?, chips?, dir? }
```

처리 순서:

1. 입력 검증: nodes ≤ 60, 각 노드 `t` ≤ 100자, history ≤ 10개.
2. **거부 규칙**: 비밀번호 화면 표시가 있거나, goal이 BANK 이면 LLM을 부르지 않고 `{type:"say"}` 반환 (지침서 5.7 앱 측 규칙을 서버도 이중 확인).
3. 민감 정보 필터(7.4)로 node 글자 마스킹.
4. 캐시 조회(9장).
5. LLM 호출 (구조화 출력 스키마: type enum, say ≤ 60자, target 정수, chips ≤ 4, dir enum).
6. **후처리 검증**:
   - `target` 이 요청 nodes의 `i` 에 실제로 있는지 → 없으면 `{type:"say"}` 로 강등
   - say 길이·존댓말 체크(간단 규칙), 금액·번호 포함 시 제거
   - requestId 그대로 반환 (늦은 응답 버리기는 앱이 함, 지침서 3.2)
7. 실패·초과 → `{ requestId, type:"say", say:"서버가 잠시 바빠요." }`

### 5.4 프롬프트 관리

- 프롬프트 내용 초안은 고령자 앱 담당이 작성(지침서 1.3), 서버는 **버전 관리·배포** 담당.
- 프롬프트는 코드 저장소 `prompts/` 에 파일로 두고 버전 문자열(`guide@v3`)을 로그·캐시 키에 포함 → 프롬프트 바꾸면 캐시가 자연히 갈린다.
- 평가 세트: 지침서 10.1 시연 시나리오 + 4.3 분류표 예문으로 #17 회귀 테스트 세트를 만든다 (프롬프트 변경 시 돌림).

---

## 6. 처리 규칙 상세 (지침서 9.2 → 구현)

| 항목                 | 구현                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 보호자 결정          | `ELDER#<eid>` / `LINK#*` Query → guardianIds. 0명이면 `no_guardians`, 아무것도 쓰지 않음                                                                         |
| sensitive_entry 중복 | `DEDUP#<pkg>` 조건부 Put + 원본 + 알림함 N개를 TransactWriteItems (최대 100개라 충분)                                                                            |
| SOS·stuck            | 중복 방지 없음. 원본 + 알림함 트랜잭션                                                                                                                           |
| Idempotency          | `haebom-idem` 조건부 Put. 같은 키 + 진행 중이면 409 `in-progress` 대신 짧게 대기 후 결과 반환(협의)                                                              |
| 승인 생성            | `PENDING#<action>` 조건부 Put 성공 시 새 승인, 실패 시 기존 aid 조회 → lazy 만료 확인 후 살아 있으면 반환                                                        |
| 승인 응답 #13        | `status = pending AND expiresAt > now AND contains(guardianIds, :me)` 조건부 Update, 성공 시 `PENDING#<action>` 삭제                                             |
| 승인 취소 #10        | `status = pending` 조건부 Update                                                                                                                                 |
| 만료                 | expire-fn: GSI2 Query → 각 항목 조건부 Update(expired), GSI2 속성 제거                                                                                           |
| 연결 코드 #11        | 6자리 난수(crypto) → `CODE#` 조건부 Put(없거나 만료됨), `ACTIVECODE` 갱신 (트랜잭션)                                                                             |
| 코드로 연결 #14      | 트랜잭션: `CODE#` 조건부 Update(미사용·만료 전) + `ACTIVECODE` 일치 확인 + links 생성. 입력 제한: 보호자당 10분 5회, 전체 1분 60회 실패 시 429 too-many-attempts |
| 연결 해제 #12·#15    | links 삭제. S2·S3: 그 보호자 알림함의 해당 어르신 항목 정리, 남은 보호자 없는 pending 승인 cancelled (두 앱 요청)                                                |

---

## 7. 보안

1. **인증·권한**: JWT Authorizer + 함수 내 role 검사 + 리소스 소유 검사(조건식에 elderId/guardianId 포함).
2. **IAM 최소 권한**: 함수별로 필요한 테이블·액션만. ai-fn은 users 읽기·사용량·캐시만.
3. **비밀**: Anthropic 키, FCM 서비스 계정 JSON → Secrets Manager. 콜드 스타트 때 1회 로드 후 메모리 캐시.
4. **민감 정보 필터 (서버 이중 방어)**: 요청 본문에서 다음 패턴을 마스킹(`***`):
   - 주민번호 `\d{6}-?[1-4]\d{6}`, 카드 `\d{4}-?\d{4}-?\d{4}-?\d{4}`, 계좌 형태 긴 숫자열(10~14자리), 금액 표현(`\d[\d,]*원`)
   - 마스킹 발생 건수는 메트릭으로만 남김(값은 남기지 않음) → 앱 쪽 누수 탐지용
5. **로그**: 구조화 JSON. 금지 필드: nodes, fcmToken, 토큰 원문. 보존 30일.
6. **전송**: HTTPS만. 커스텀 도메인 + ACM.
7. **남용 방지**: API Gateway 경로별 스로틀, 어르신별 일일 AI 호출 한도(예: guide 500 / classify 200, **협의**), 초과 시 429 → 앱은 로컬 플래너로 진행.

---

## 8. 운영·관측

- CloudWatch 메트릭(EMF): 엔드포인트별 지연·오류율, AI 지연 p50/p95, 토큰(입력/출력/프롬프트 캐시 읽기), **응답 캐시 적중률**, 마스킹 발생 수, 푸시 실패 수.
- 알람: #16 p95 > 8초, #17 p95 > 3.5초, 5xx 비율 > 2%, FCM 실패 급증, 일일 토큰 비용 임계치.
- FCM 토큰 무효(UNREGISTERED) 응답 시 기기 항목 삭제.
- 비용 대시보드: 일별 LLM 토큰 × 단가, 캐시로 절약한 호출 수.

---

## 9. 캐싱 계층 (자리만 잡음 — 설계는 별도 문서)

> 사용자 설계 문서를 받으면 이 장을 교체한다. 아래는 서버 구조상 **끼워 넣을 지점과 확인할 질문**만 정리한 것.
> 캐시 대신 Opus가 검증한 길로 Claude 없이 안내하는 "지도 안내" 제안: [jev 라우팅 + 스스로 자라는 지도 기획](jev-routing-plan.md) 5.3·8장. 이 장과의 관계는 그 문서 12장 10번.

**끼우는 지점**: `ai-fn` 안, 5.2·5.3 처리 순서의 "캐시 조회" 단계 (민감 정보 필터 **이후**, LLM 호출 **이전**), 그리고 LLM 응답의 후처리 **이후** 저장.

```
요청 → 검증 → 거부 규칙 → 민감정보 필터 → [캐시 조회] ─hit→ 후처리 → 응답
                                              └miss→ LLM → 후처리 → [캐시 저장] → 응답
```

**인터페이스(제안)**: `cache.get(kind, keyInput) → result | null`, `cache.put(kind, keyInput, result, meta)` — 저장소(DynamoDB 테이블 / ElastiCache 등)는 설계에 따름.

**설계 받을 때 맞춰 볼 질문**

- 캐시 키에 들어갈 것: #17은 정규화된 utterance + ruleLevel + signals? #16은 pkg + 화면 지문(hash) + goal + slots + history 일부?
- 화면 지문(지침서 3.3: 글자 + 위치 10% 반올림)을 키로 그대로 쓸지, 서버에서 재계산할지
- 개인 데이터가 섞인 노드(연락처 이름, 검색어)가 다른 어르신에게 재사용되지 않도록 하는 범위 (어르신별 / 전역)
- TTL과 무효화: 프롬프트 버전·모델 변경 시 무효화(키에 버전 포함)
- 캐시된 #16 응답의 `target` 이 현재 nodes와 일치하는지 재검증(후처리 6단계를 hit에도 적용)
- 민감도(#17)는 **캐시 hit여도 max(rule, cached)와 signals 보정은 매번** 다시 적용
- 적중률·절약 토큰 메트릭

---

## 10. 개발 단계 (서버 기준)

| 단계    | 내용                                                                                                                                                             | 앱 연동 시점       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| S0 ✅   | TS 프로젝트 골격(11.1), Terraform bootstrap(state 버킷·OIDC) + dev 환경(DynamoDB, API Gateway + JWT Authorizer, api-fn healthz), Secrets 껍데기, CI 배포         | –                  |
| S0.5 ✅ | **디버그 뷰어** (12장): debug-fn + heartbeat·기기 목록 → 화면 저장·서버 지문 → 뷰어(1초 폴링) → 보관 세션                                                        | 앱 디버그 모드     |
| S1 ✅   | users·devices(#2~#5), 연결 코드·연결·해제(#11·#12·#14·#15·#18·#20), 연결 변경 FCM. 계약: [docs/api/s1-users-links.md](api/s1-users-links.md)                     | 앱 2단계 전환 시작 |
| S2 ✅   | 알림(#6·#7·#8·#21·#22) + push-fn + 중복 방지 + Idempotency. 계약: [docs/api/s2-notifications.md](api/s2-notifications.md)                                        | 시연 SOS·정부24 L1 |
| S3 ✅   | 승인(#9·#10·#13·#19·#23·#24) + 고령자 FCM data + expire-fn. 계약: [docs/api/s3-approvals.md](api/s3-approvals.md)                                                | 시연 정부24 L2     |
| S4      | AI #17 classify (구조화 출력, max 보정, 회귀 세트). jev 앱·목표 라우팅 포함: [기획](jev-routing-plan.md) R2. 계약: [docs/api/s4-classify.md](api/s4-classify.md) | 시연 사기 의심 L3  |
| S5 ✅   | AI #16 guide (target 검증, 거부 규칙, 대체 응답). 계약: [docs/api/s5-guide.md](api/s5-guide.md)                                                                  | 서버 AI 안내       |
| S6      | **캐싱 계층** (사용자 설계 반영) + 비용 메트릭                                                                                                                   | –                  |
| S7      | 하드닝: 레이트 리밋, 알람, 부하 테스트, prod 스테이지                                                                                                            | 시연 전            |

S1~S3은 지침서 1단계에서 앱끼리 검증한 문서 모양을 그대로 응답 스키마로 쓰므로, **앱 1단계가 끝나는 대로** 5.8 규격을 받아 확정한다.

---

## 11. 저장소 구조와 Terraform

### 11.1 저장소 구조 (제안)

```
haebom-server/
├── docs/                     기획·API 문서
├── src/
│   ├── functions/
│   │   ├── api/              api-fn 진입점 + 라우터 (#1~#15, #18~#24)
│   │   ├── ai/               ai-fn 진입점 (#16 guide, #17 classify)
│   │   ├── push/             push-fn (DynamoDB Streams → FCM)
│   │   └── expire/           expire-fn (EventBridge 1분)
│   ├── domain/               연결·알림·승인 규칙 (DB 접근과 분리, 단위 테스트 대상)
│   ├── infra/                DynamoDB 리포지토리, FCM 클라이언트, Secrets 로더
│   ├── ai/                   Anthropic 클라이언트, 스키마(zod), 후처리, 민감정보 필터
│   ├── cache/                9장 캐싱 계층 (설계 받은 뒤)
│   └── shared/               오류 형식, 인증 컨텍스트, 로거, Idempotency
├── viewer/                   디버그 뷰어 웹 (12장, dev 전용)
├── prompts/                  guide@vN.md, classify@vN.md (버전 고정)
├── test/                     단위·통합 테스트, #17 회귀 세트
├── scripts/build.ts          esbuild로 함수별 dist/<fn>.zip 생성
├── infra/                    Terraform (11.2)
├── package.json  tsconfig.json
└── .github/workflows/        CI: lint·test·build → terraform plan/apply
```

- 패키지 매니저: **npm** (확정), Node 24, 테스트는 vitest, 로컬 DynamoDB 테스트는 DynamoDB Local(docker).

### 11.2 Terraform 구성

```
infra/
├── bootstrap/                state 저장용 S3 버킷 (1회만, 로컬 state)
├── modules/
│   ├── dynamodb/             haebom-main(GSI1·GSI2·TTL·Streams), haebom-idem (ai-cache는 9장 후)
│   ├── lambda_function/      함수 1개 = Lambda + 로그 그룹(30일) + IAM 역할 (재사용 모듈)
│   ├── http_api/             API Gateway HTTP API, JWT Authorizer(Firebase), 라우트, 스로틀, 커스텀 도메인
│   ├── events/               EventBridge 1분 규칙 → expire-fn, Streams 이벤트 소스 매핑 → push-fn
│   ├── secrets/              Secrets Manager 항목 (값 없이 껍데기만)
│   ├── monitoring/           CloudWatch 알람·대시보드 (8장, S7에서 추가)
│   └── debug/                debug-fn + haebom-dev-debug 테이블·버킷 + /v1/dev/* 라우트 (12장, envs/dev 에서만 사용)
└── envs/
    ├── dev/   main.tf  backend.tf  variables.tf  terraform.tfvars
    └── prod/  main.tf  backend.tf  variables.tf  terraform.tfvars
```

| 결정           | 내용                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Terraform 버전 | ≥ 1.10, AWS provider ~> 6.x (최신 고정, `.terraform.lock.hcl` 커밋)                                                        |
| state          | S3 backend + `use_lockfile = true` (S3 네이티브 잠금, 별도 DynamoDB 잠금 테이블 불필요). 버킷 버전 관리·암호화·퍼블릭 차단 |
| 환경 분리      | `envs/dev`, `envs/prod` 디렉터리 분리 (workspace 대신 — state·변수가 눈에 보이게)                                          |
| 이름 규칙      | `haebom-<env>-<리소스>` 예: `haebom-dev-main`, `haebom-prod-ai-fn`                                                         |
| 태그           | provider `default_tags`: Project=haebom, Env, ManagedBy=terraform                                                          |
| Lambda 코드    | CI가 `dist/<fn>.zip` 빌드 → Terraform은 `filename` + `source_code_hash` 로 참조. Terraform 안에서 빌드하지 않음            |
| 함수 설정      | arm64, nodejs24.x, 함수별 메모리·타임아웃(2장 표), `reserved_concurrent_executions` 는 ai-fn에 상한(비용 보호)             |
| 테이블         | on-demand(PAY_PER_REQUEST), PITR on(prod), 삭제 보호 on(prod)                                                              |
| 인증           | `http_api` 모듈 변수로 `firebase_project_id` 를 받아 issuer/audience 구성                                                  |

### 11.3 IAM (함수별 최소 권한)

| 함수      | DynamoDB                                                    | 기타                                |
| --------- | ----------------------------------------------------------- | ----------------------------------- |
| api-fn    | main(읽기·쓰기·트랜잭션, GSI 조회), idem(읽기·쓰기)         | –                                   |
| ai-fn     | main의 `USER#`·`USAGE#` 항목, ai-cache                      | Secrets: anthropic-api-key          |
| push-fn   | main Streams 읽기, main(기기 조회·삭제)                     | Secrets: fcm-service-account        |
| expire-fn | main GSI2 조회, 승인 항목 업데이트                          | –                                   |
| debug-fn  | dev-debug 테이블(읽기·쓰기), main의 `USER#` 읽기(role 검사) | S3 dev-debug 버킷(읽기·쓰기), dev만 |

키 단위 제한이 필요하면 `dynamodb:LeadingKeys` 조건을 검토(1차에서는 테이블 단위).

### 11.4 비밀 값 (Anthropic API 키, FCM 서비스 계정)

- Terraform은 `aws_secretsmanager_secret` **껍데기만** 만든다. `aws_secretsmanager_secret_version` 으로 값을 넣지 않는다 → **키가 Terraform state·tfvars·git에 남지 않음**.
- 값은 받은 뒤 한 번만 수동 등록:
  - `haebom-<env>/anthropic-api-key`
  - `haebom-<env>/fcm-service-account` (JSON)
- Lambda는 환경 변수로 **비밀 이름만** 받고, 콜드 스타트 때 Secrets Manager에서 읽어 메모리에 보관.
- dev와 prod는 Anthropic 키(워크스페이스)를 분리하는 것을 권장 → 비용·사용량을 환경별로 볼 수 있음.

### 11.5 배포 흐름

| 환경 | 배포 방법                                                                                    |
| ---- | -------------------------------------------------------------------------------------------- |
| dev  | **로컬**: `npm run dev:plan` / `npm run dev:apply` (빌드 → init → plan/apply → healthz 확인) |
| prod | **GitHub Actions**: main 머지 → 검사 → apply → healthz 확인                                  |

```
PR    : lint → test → build → terraform fmt/validate → plan (prod) 결과를 job summary에
main  : 검사 → terraform apply (prod) (GitHub environment "prod" 승인자 지정 시 승인 후)
dev   : 로컬에서 직접 (GitHub 배포 역할 없음)
```

- CI의 AWS 인증은 GitHub OIDC → IAM 역할 (장기 Access Key 사용 안 함). OIDC 공급자·역할도 `bootstrap/` 에서 Terraform으로 만든다.

---

## 12. 디버그 뷰어 (dev 전용)

> 목적: 고령자 앱이 뽑은 접근성 정보(화면 nodes)를 **서버를 거쳐** 받아 웹 페이지에서 눈으로 확인한다. 처음에는 앱의 노드 추출을 점검하는 데 쓰고, 이어서 9장 캐싱을 위한 **화면 식별(지금 어느 화면인지 = 화면 지문)** 설계·검증에 쓰며, S5 이후에는 #16 LLM 판단(고른 target, say, 지연, 토큰)까지 같은 화면에서 본다.

### 12.1 원칙

- **dev 환경에만 만든다.** prod에는 함수·라우트·테이블·버킷을 아예 만들지 않는다 (Terraform `envs/prod` 에서 `debug` 모듈 미사용).
- 1장 "nodes는 보관하지 않는다"의 **유일한 예외**. 테스트 기기·테스트 계정에서만 쓰고, 저장 전 7.4 민감 정보 마스킹을 그대로 적용하며, 기본 3일 뒤 자동 삭제한다(보관 표시한 세션만 30일, 12.5).
- 요청 모양은 **#16 guide 의 `screen` 과 같게** 한다 → 앱은 같은 직렬화 코드를 쓰고, 뷰어는 S5 이후에도 그대로 쓴다.
- **데이터의 원본은 저장된 기록**(S3·DynamoDB)이다. 실시간 표시는 그 위에 얹는 "새 화면 생김" 알림일 뿐이다 (12.6).

### 12.2 역할 분담: 앱은 보내기만, 폴링은 뷰어가

```
[고령자 앱 · debug 빌드]               [서버 · dev]                        [뷰어 웹 · 브라우저]
 화면 바뀜 ──POST /v1/dev/screens───►  debug-fn ─ 마스킹(7.4) ─ 지문 계산
 5초마다 ───POST /v1/dev/heartbeat──►     ├──► DynamoDB haebom-dev-debug (기기·화면 색인)
                                          └──► S3 haebom-dev-debug (화면 JSON)
                                                     ▲
                                                     └──── GET 1초마다 ("이후 새 화면?") ── 폴링
                                                           ※ 개발자 Google 로그인 + 허용 목록
```

| 주체       | 하는 일                                                                   | 하지 않는 일                          |
| ---------- | ------------------------------------------------------------------------- | ------------------------------------- |
| 고령자 앱  | 화면이 바뀌면 `POST /v1/dev/screens`, 5초마다 `POST /v1/dev/heartbeat`    | 서버에 묻기(폴링)·응답 대기·재시도 큐 |
| `debug-fn` | 마스킹 → 화면 지문 계산 → 저장. 같은 기기 직전 hash와 같으면 저장 생략    | 앱에 푸시                             |
| 뷰어 웹    | 1초마다 새 화면·기기 상태 조회(`since` 커서), 화면 그리기, 세션 보관 표시 | 데이터 원본 보관                      |

- 앱의 전송은 **보내고 잊기**(fire-and-forget): 실패해도 다시 보내지 않고 사용자 흐름에 영향이 없어야 한다. 화면 변경이 빠르게 이어지면 300ms 디바운스 후 마지막 화면만 보낸다.
- **`debug-fn` 을 따로 둔다**: api-fn·ai-fn과 섞지 않아 prod 배포물에 디버그 코드가 들어가지 않고, IAM도 debug 테이블·버킷만 갖는다.
- **#16 이후**: dev 환경의 `ai-fn` 이 #16 요청을 받을 때 화면과 LLM 응답을 같은 저장소에 함께 남긴다 (환경 변수 `DEBUG_CAPTURE=on`, prod는 코드 경로 자체를 끈다). 앱이 같은 화면을 두 번 보낼 필요가 없고, `/v1/dev/screens` 는 "AI를 부르지 않는 화면도 볼 때"용으로 남는다.

### 12.3 디버그 모드 차단 (앱·서버 이중)

| 위치 | 방법                                                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 앱   | 전송 코드를 `BuildConfig.DEBUG`(또는 dev flavor)로 감싸 **release 빌드에는 코드 경로가 없게** 한다. debug 빌드 안에서는 설정 화면의 숨은 토글로 켜고 끈다(기본 켜짐, 제안)                       |
| 앱   | API 주소를 빌드 종류별로 분리: debug → dev, release → prod. release 앱이 dev 서버를 볼 일이 없게 한다                                                                                            |
| 서버 | `/v1/dev/*` 라우트는 **dev 환경에만 존재** → prod에 보내면 404                                                                                                                                   |
| 서버 | 앱용 POST는 로그인만 확인 (**S1에서 users 프로필이 생기면 role=elder 로 좁힘**), 뷰어용 GET/PATCH/PUT은 토큰 `email`(`email_verified`)이 **개발자 허용 목록**(`debug_viewer_emails`)에 있을 때만 |

### 12.4 API (dev 전용, 모두 Firebase 토큰 필요)

> 앱 연동 상세(주소, 요청 예시, 필드 규칙, 응답 코드)는 [debug-viewer-app-guide.md](debug-viewer-app-guide.md).

| 메서드 · 경로                                                   | 호출      | 내용                                                                                                                                                                       |
| --------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST /v1/dev/heartbeat                                          | 고령자 앱 | `{deviceId, model, os, appVersion}` → lastSeenAt 갱신, 처음이면 기기 등록. 응답 `204`                                                                                      |
| POST /v1/dev/screens                                            | 고령자 앱 | `{deviceId, capturedAt, screen: {pkg, hash, width, height, nodes[≤60]}}` → 저장 또는 직전 hash와 같아 생략. 응답 `202`                                                     |
| GET /v1/dev/devices                                             | 뷰어      | 기기 목록 + online 여부 + 마지막 화면 시각 + 화면 수                                                                                                                       |
| PATCH /v1/dev/devices/{deviceId}                                | 뷰어      | `{label}` 예: "시연폰 A"                                                                                                                                                   |
| GET /v1/dev/devices/{deviceId}/screens?since=&from=&to=&cursor= | 뷰어      | `since`: 그 이후 새 화면만(실시간 폴링용, 대부분 빈 응답). `from`+`to`: 구간(보관 세션 보기). 없으면 최신순 페이지(`cursor`). 요약: 시각, pkg, 앱 hash, 서버 지문, 노드 수 |
| GET /v1/dev/devices/{deviceId}/screens/{screenId}               | 뷰어      | 화면 JSON 원본 (S5 이후 #16 응답 포함). screenId = `20261126T070104123Z-1a2b3c` (받은 시각 + 난수, 문자열 정렬 = 시간순)                                                   |
| PUT /v1/dev/devices/{deviceId}/pins                             | 뷰어      | `{from, to, name}` 이 시간 구간의 화면을 "보관 세션"으로 표시 (예: "정부24 L2 흐름 1회차") → 30일 보관                                                                     |
| GET /v1/dev/pins                                                | 뷰어      | 보관 세션 목록                                                                                                                                                             |

- **deviceId**: 앱이 처음 실행할 때 만드는 UUID, #4 `PUT /v1/devices/{deviceId}` 와 같은 값. 재설치로 uid가 바뀌어도 기기를 이어서 볼 수 있다(앱 저장소가 지워지면 새 기기로 보임).
- **노드 필드**: `i`, `t` 외에 bounds(좌표)·클래스·clickable 등은 **앱 실제 샘플을 받아 확정** (14장 #14). 박스를 그리려면 bounds와 화면 크기가 꼭 있어야 한다.

### 12.5 저장과 보관

| 저장소                       | 키                                                  | 내용                                                                  | 수명                   |
| ---------------------------- | --------------------------------------------------- | --------------------------------------------------------------------- | ---------------------- |
| DynamoDB `haebom-dev-debug`  | `DEV#<deviceId>` / `META`                           | uid, model, os, appVersion, label, lastSeenAt, lastScreenAt, lastHash | TTL 30일               |
|                              | `DEV#<deviceId>` / `SCREEN#<capturedAt>#<screenId>` | pkg, 앱 hash, 서버 지문, nodeCount, s3Key, pinned                     | TTL 3일 (보관 시 30일) |
|                              | `PIN#<pinId>` / `META`                              | deviceId, from, to, name, createdBy                                   | TTL 30일               |
| S3 `haebom-dev-debug-<계정>` | `screens/<deviceId>/<capturedAt>-<screenId>.json`   | 마스킹된 screen 전체 (+ S5 이후 #16 응답·지연·토큰)                   | 수명 주기 3일          |
|                              | `pinned/<pinId>/…`                                  | 보관 표시 시 해당 구간 화면을 복사                                    | 수명 주기 30일         |

- 기기 목록은 기기 수가 적어(수 대~수십 대) Scan으로 충분하다.
- main 테이블과 분리해 Streams·push-fn에 영향이 없고, prod에서 빼기도 쉽다.
- **보관 세션이 필요한 이유**: 화면 지문 규칙을 바꿀 때마다 **쌓아 둔 기록에 다시 돌려** 결과를 비교해야 한다(12.7). 시연 흐름(정부24 L1·L2, 사기 의심 L3 등)을 녹화 세트처럼 모아 두는 용도.

### 12.6 실시간: 1초 폴링으로 시작, 소켓으로 바꾸기 쉽게

체감 지연 (폰 조작 → 웹 표시):

| 구간            | 1초 폴링           | 소켓             |
| --------------- | ------------------ | ---------------- |
| 앱 → API → 저장 | 약 0.2~0.4초       | 같음             |
| 저장 → 브라우저 | 평균 0.5, 최대 1초 | 약 0.1초         |
| **합계**        | **약 0.7~1.4초**   | **약 0.3~0.5초** |

- **1차: 1초 폴링.** 뷰어는 기기 상세·화면 뷰어를 열어 둔 동안에만 `?since=<마지막 capturedAt>` 로 조회한다. 응답이 대부분 비어 비용이 거의 없고 추가 인프라가 없다. 기기 목록은 3초 간격이면 충분.
- **online 판정**: `lastSeenAt` 이 15초 이내 (heartbeat 5초 × 3).
- 뷰어는 실시간 수신을 `subscribe(deviceId, onScreen)` 하나로 감싼다 → 폴링 구현을 소켓 구현으로 바꿔도 나머지 코드는 그대로.
- **2차(필요할 때): AWS AppSync Events.** `debug-fn` 이 저장 후 `/devices/<deviceId>` 채널에 HTTP로 발행, 뷰어가 구독. 연결 관리 테이블·`$connect` 함수가 필요 없고 OIDC 인증으로 Firebase 토큰을 그대로 쓴다. API Gateway WebSocket은 연결 ID 테이블·연결별 전송·별도 인증 Lambda(JWT Authorizer 미지원)가 필요해 채택하지 않는다.
- 전환 기준: 폰을 조작하며 웹을 같이 보는 사용에서 1초 지연이 작업을 방해한다고 느껴질 때.

### 12.7 화면 지문 (9장 캐싱 준비)

- `debug-fn` 은 저장할 때 **서버 지문**을 계산해 앱이 보낸 `hash` 와 나란히 저장한다. 지문 함수는 `src/cache/fingerprint.ts` 에 두어 9장 캐싱 계층과 **같은 코드**를 쓴다 (버전 문자열 `fp@vN` 함께 저장).
- 뷰어 표시: 화면마다 "서버 지문 = X (fp@vN), 이 기기에서 이전에 본 화면 #k와 같음/새 화면", 같은 지문끼리 색으로 묶기.
- 지문 품질 확인 항목:
  - 같은 화면에 여러 번 들어갔을 때 지문이 같은가 (시계, 알림 숫자, 스크롤 위치 같은 흔들리는 요소에 영향받지 않는가)
  - 서로 다른 화면이 같은 지문으로 뭉치지 않는가
- **재계산**: 보관 세션(12.5)에 새 지문 버전을 다시 돌려 "같은 화면인데 갈린 수 / 다른 화면인데 합쳐진 수"를 비교하는 스크립트(`scripts/fingerprint-replay.ts`)를 둔다. 정답 라벨은 뷰어에서 화면에 이름을 붙여(예: "정부24 메인") 만든다.

#### 12.7.1 화면 매칭 (시험, match@v1)

fp@v1 은 바뀌는 글자·위치 밀림·목록 항목에 쉽게 갈린다 (dev 207개 화면에서 같은 페이지가 53번 더 갈림). 그래서 "이미 본 어느 **페이지**인지"를 따로 판정해 본다. 코드: 판정 `src/cache/match.ts`, 페이지 저장 `src/debug/pages.ts`.

- 페이지 = 같은 화면으로 판정된 화면들의 묶음 (앱별). 테이블 `PAGE#<pkg>` / `PAGE#<pageId>`: 처음 토큰, 최근 토큰, 지문 집합, 횟수 (마지막으로 본 뒤 30일)
- 토큰: 위치를 뺀 `클래스 | 정규화한 글자`
- 판정 순서: ① 페이지의 지문 집합에 같은 지문 → **exact** ② 같은 앱 페이지와 토큰 겹침(Jaccard, 처음·최근 토큰 중 큰 값) 1등 ≥ 0.5 이고 2등과 0.15 이상 차이 → **similar** ③ 1등 ≥ 0.5 인데 2등과 차이 작음 → **ambiguous** (페이지를 바꾸지 않음) ④ 1등 < 0.5 → **new** (새 페이지)
- 적용: `POST /v1/dev/screens` 와 guide 기록(ai-fn) 모두. 결과는 화면 요약의 `match` 와 screens 응답에 붙는다. 실패해도 화면 저장은 계속한다
- 기존 화면 채우기: `AWS_PROFILE=… npx tsx scripts/match-backfill.ts [--dry-run]` (오래된 화면부터, match 없는 화면만)
- 캐시(S6)에 쓸 때: ambiguous 는 miss. 답은 노드 번호가 아니라 노드 특징(id·클래스·글자)으로 저장하고, 새 화면에서 그 노드를 못 찾으면 버리고 AI 를 부른다
- 다음: 사람이 뷰어에서 "같은 페이지" 정답을 몇 개 붙여 정확도를 잰다 → 기준값(0.5, 0.15)·토큰 규칙 조정 → match@v2

### 12.8 뷰어 웹

- 위치: 이 저장소 `viewer/` (Vite + TypeScript, 프레임워크 최소).
- 접속: **dev CloudFront** `https://<배포>.cloudfront.net` (`terraform output debug`). `/*` 는 비공개 S3(OAC), `/v1/*` 는 API Gateway 로 넘겨 같은 주소에서 API 호출(CORS 불필요). 페이지는 빈 껍데기이고 데이터는 허용 이메일에만 내려간다.
- 올리기: `npm run viewer:deploy` (빌드 → S3 업로드 → index.html 무효화). 로컬 실행은 `npm run viewer`(dev API) / `npm run viewer:mock`(가짜 데이터).
- Firebase 웹 설정(공개 값)은 빌드에 넣지 않고 `/config.json` 에서 읽는다. Terraform 이 `firebase_web_api_key` 로 만든다 → 키가 바뀌어도 다시 빌드할 필요 없음. 로컬은 `viewer/.env.local`.
- Firebase Auth **승인된 도메인**에 CloudFront 도메인을 추가해야 Google 로그인이 된다 (콘솔에서 수동).
- 로그인: Firebase Auth Google 로그인 (같은 Firebase 프로젝트 → JWT Authorizer 그대로 사용).
- 화면 5개:
  1. **기기 목록** — 라벨, 모델, OS, 앱 버전, online 점, 마지막 신호, 화면 수, 라벨 편집
  2. **기기 상세** — 화면 기록 시간순(1초 폴링으로 새 화면이 위에 붙음), 같은 지문 연속은 묶어서, pkg로 거르기, 구간 선택 → "보관 세션" 지정
  3. **화면 뷰어** — 화면 크기 비율의 캔버스에 bounds 박스 + `i` 번호, 마우스를 올리면 노드 속성, 오른쪽에 노드 목록(클릭 시 박스 강조), 서버 지문·같은 화면 이력, 화면 이름 붙이기. S5 이후 LLM이 고른 target 강조 + say·지연·토큰 표시
  4. **보관 세션** — 세션 목록, 세션 안 화면을 지문별로 묶어 보기
  5. **화면 지도** (`#/map`) — 화면 하나 = 점, 같은 화면끼리 선으로 이음, 앱마다 색. 마우스를 올리면 미리 보기, 누르면 화면 뷰어. "같은 화면" 규칙을 페이지 매칭(서버, 기본) / fp@v1 / 위치 빼기 / 누를 수 있는 노드만 으로 바꿔 지문이 얼마나 갈리는지 비교 (S6 캐시 키 정하기용, 규칙은 `viewer/src/fp-rules.ts`)

### 12.9 구현 위치 (S0.5)

| 구분   | 위치                                                                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 함수   | `src/functions/debug/` (debug-fn), 라우트 `src/debug/routes.ts`, 저장 `src/debug/aws-store.ts`                                           |
| 공용   | 마스킹 `src/shared/sensitive.ts`, 화면 지문 `src/cache/fingerprint.ts` (fp@v1), 본문 검증 `src/shared/validate.ts`                       |
| 인프라 | `infra/modules/debug` (테이블·버킷·함수·`ANY /v1/dev/{proxy+}` 라우트), `infra/envs/dev/main.tf` 에서만 사용                             |
| 권한   | bootstrap 의 Lambda 권한 경계·배포 역할에 `haebom-<env>-debug-*` 버킷 권한 추가 → **bootstrap 재적용 필요**                              |
| 뷰어   | `viewer/` (Vite + TypeScript, 프레임워크 없음). 호스팅 `infra/modules/debug/viewer.tf` (S3 + CloudFront), 올리기 `npm run viewer:deploy` |

### 12.10 정할 것

- 노드 JSON 실제 샘플 (bounds 형식, 좌표계, 화면 크기 필드)
- **스크린샷 허용 여부**: 실제 화면 위에 박스를 겹치면 추출 오류가 잘 보이지만 원칙상 화면 캡처는 받지 않는다. 허용한다면 dev 전용 플래그 + S3 presigned URL로 직접 업로드(Lambda 6MB 한도 회피) + 같은 수명
- 화면 전송 시점: 화면 변경 시 자동(제안, 300ms 디바운스 + hash 같으면 생략) vs 디버그 버튼
- 앱 debug 빌드의 전송 토글 기본값 (제안: 켜짐)

---

## 13. 보호자 앱 관점에서 서버가 미리 준비할 것

지침서 2.2 기능 외에 보호자 앱이 커지면 나올 만한 것 (지금은 **구현하지 않고** 데이터만 남겨 둠):

- 어르신별 활동 요약(오늘 도움 받은 횟수, 민감 알림 수) → `USAGE#` 와 알림 원본으로 집계 가능
- 알림 설정(종류별 끄기, 방해 금지 시간) → `USER#<gid>/SETTINGS` 항목 예약
- 여러 보호자 중 누가 응답했는지 표시 → approvals.respondedBy 이미 있음

---

## 14. 협의할 것

| #   | 내용                                                                                                                                     | 상대                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 1   | Firestore 직접 읽기 → GET 엔드포인트(#18~#24) + FCM data 메시지로 대체                                                                   | 고령자 앱 · 보호자 앱 |
| 2   | ~~#14·#15 경로~~ → **확정: `/v1/guardian/links`** ([S1 계약서](api/s1-users-links.md)). 남은 것: #13 승인 응답 경로 (S3)                 | 보호자 앱             |
| 3   | 알림 읽음 처리: `readBy{uid}` → 보호자별 `readAt`                                                                                        | 보호자 앱             |
| 4   | Firebase 프로젝트는 Auth·FCM 용도로 계속 사용 (Firestore는 1단계 테스트 전용)                                                            | 전체                  |
| 5   | ~~서버 언어·IaC~~ → **확정: TypeScript + Terraform**                                                                                     | –                     |
| 6   | ~~LLM 호출 경로~~ → **확정: Anthropic API 직접, Sonnet 5.5**. 남은 것: #17 4초 목표를 Sonnet으로 맞추는지 S4에서 측정 후 재협의          | 서버 팀 · 고령자 앱   |
| 7   | #17 실패 시 응답 형태 (오류 vs 규칙 결과 200)                                                                                            | 고령자 앱             |
| 8   | 어르신별 일일 AI 호출 한도 값                                                                                                            | 전체                  |
| 9   | ~~연결 해제 시 기존 알림·승인 기록 처리~~ → **확정**: 그 보호자 목록에서 삭제, 남은 보호자 없으면 대기 중 승인 취소                      | 보호자 앱             |
| 10  | 캐싱 설계 반영 (9장)                                                                                                                     | 사용자 → 서버 팀      |
| 11  | ~~Anthropic API 키 등록~~ → **dev 등록 완료**. 남은 것: prod 키 (dev와 분리 권장)                                                        | 사용자                |
| 12  | ~~AWS 계정 구성~~ → **확정: dev·prod 한 계정** (이름 접두사 `haebom-<env>-`와 환경별 배포 역할·권한 경계로 분리). 남은 것: 커스텀 도메인 | 서버 팀               |
| 13  | ~~패키지 매니저~~ → **확정: npm**                                                                                                        | 서버 팀               |
| 14  | 디버그 뷰어용 노드 JSON 샘플 (bounds·화면 크기 포함), 디버그 모드 heartbeat·화면 전송 구현 (12장)                                        | 고령자 앱             |
| 15  | 디버그 뷰어 스크린샷 허용 여부 (dev 전용 예외)                                                                                           | 전체                  |
