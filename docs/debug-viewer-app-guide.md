# 디버그 뷰어 앱 연동 가이드 (고령자 앱, dev 전용)

- 대상: 고령자 앱(Kotlin) debug 빌드
- 목적: 앱이 읽은 접근성 정보(화면 노드)를 서버로 보내 웹 뷰어에서 실시간으로 확인
- 배경·설계: [server-plan.md 12장](server-plan.md#12-디버그-뷰어-dev-전용)
- 상태: **노드 필드는 임시** — 실제로 보내 보고 확정한다 (server-plan.md 14장 #14)

---

## 1. 주소

| 용도     | 주소                                                          |
| -------- | ------------------------------------------------------------- |
| 앱 → API | `https://qq829otaql.execute-api.ap-northeast-2.amazonaws.com` |
| 웹 뷰어  | `https://dv888sh4vt1v6.cloudfront.net`                        |

- 앱은 **API Gateway 주소를 직접** 쓴다. 뷰어 주소의 `/v1/*` 도 같은 API로 이어지지만, 그건 뷰어 페이지용 통로다.
- 주소는 dev 환경을 지우고 다시 만들 때만 바뀐다. 확인: `terraform -chdir=infra/envs/dev output`

## 2. 공통 헤더

```
Authorization: Bearer <Firebase ID 토큰>
Content-Type: application/json
```

- 고령자 앱의 **익명 로그인 토큰**이면 된다 (`FirebaseAuth.getInstance().currentUser?.getIdToken(false)`).
- 토큰은 SDK가 만료 전에 알아서 새로 받는다. 401이 오면 `getIdToken(true)` 로 강제 갱신 후 다음 주기에 보낸다.

## 3. 엔드포인트

### 3.1 heartbeat — 5초마다

```http
POST /v1/dev/heartbeat
```

```json
{
  "deviceId": "9b2f0c1e-4d7a-4c55-9a51-2f0b8e6c1d33",
  "model": "SM-S928N",
  "os": "Android 15",
  "appVersion": "0.3.1"
}
```

응답: `204` (본문 없음)

- 뷰어는 마지막 heartbeat가 **15초 안**이면 기기를 온라인(초록 점)으로 표시한다.
- `model`·`os`·`appVersion` 은 생략 가능 (빈 문자열로 저장).

### 3.2 screens — 화면이 바뀔 때

```http
POST /v1/dev/screens
```

```json
{
  "deviceId": "9b2f0c1e-4d7a-4c55-9a51-2f0b8e6c1d33",
  "capturedAt": "2026-11-26T07:30:00.123Z",
  "screen": {
    "pkg": "kr.go.gov24",
    "hash": "앱이 계산한 화면 지문 (없으면 생략)",
    "width": 1080,
    "height": 2400,
    "nodes": [
      { "i": 0, "t": "민원 신청", "c": "Button", "b": [100, 500, 500, 600], "clickable": true },
      { "i": 1, "d": "뒤로 가기", "c": "ImageButton", "b": [0, 80, 120, 200], "clickable": true }
    ]
  }
}
```

응답: `202`

```json
{ "status": "saved", "screenId": "20261126T073000456Z-1a2b3c", "fingerprint": "82ef3d69b100f485" }
```

또는 직전 화면과 같아 저장하지 않았을 때:

```json
{ "status": "unchanged" }
```

- "같은 화면" 판단: `pkg` + `hash`(앱이 보낸 경우) 또는 서버 지문. 같은 화면을 여러 번 보내도 한 번만 저장된다.
- 이 요청 모양은 앞으로 붙일 #16 `POST /v1/elder/guide` 의 `screen` 과 같게 맞춘다 → 직렬화 코드를 같이 쓴다.

## 4. 필드 규칙

| 필드              | 값                                                                       | 제한·비고                                                                 |
| ----------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `deviceId`        | 앱이 처음 실행할 때 `UUID.randomUUID()` 로 만들어 저장한 값              | `[A-Za-z0-9_-]` 8~64자. 이후 #4 `PUT /v1/devices/{deviceId}` 에도 같은 값 |
| `capturedAt`      | 화면을 읽은 시각, ISO 8601 UTC (`Instant.now().toString()`)              | 시간대 포함 필수                                                          |
| `screen.pkg`      | 현재 화면 앱 패키지                                                      | 1~200자                                                                   |
| `screen.hash`     | 앱이 계산한 화면 지문 (지침서 3.3)                                       | 선택, 128자까지                                                           |
| `screen.width`    | 화면 가로(px)                                                            | 박스 위치 계산 기준. 1~10000                                              |
| `screen.height`   | 화면 세로(px)                                                            | 1~10000                                                                   |
| `screen.nodes`    | 노드 배열                                                                | **최대 60개**                                                             |
| `nodes[].i`       | 노드 번호                                                                | 0 이상 정수. #16 guide 응답의 `target` 과 같은 번호                       |
| `nodes[].t`       | `node.text`                                                              | 선택, 100자까지                                                           |
| `nodes[].d`       | `node.contentDescription`                                                | 선택, 100자까지                                                           |
| `nodes[].c`       | `node.className` 의 마지막 부분 (`android.widget.Button` → `Button`)     | 선택, 100자까지                                                           |
| `nodes[].b`       | `getBoundsInScreen()` 의 `[left, top, right, bottom]` (정수 px)          | 선택이지만 **없으면 뷰어에 박스가 안 그려진다**                           |
| 그 밖의 노드 필드 | `clickable`, `editable`, `checked`, `scrollable`, `selected` 등 자유롭게 | 그대로 저장되고 뷰어 속성 창에 표시된다                                   |

## 5. 앱에서 지킬 것

1. **debug 빌드에서만**: 전송 코드를 `BuildConfig.DEBUG`(또는 dev flavor)로 감싸 release 빌드에는 코드가 아예 없게 한다. API 주소도 빌드 종류별로 분리한다(debug → dev, release → prod).
2. **보내고 끝**(fire-and-forget): 백그라운드 코루틴에서 보내고, 실패해도 재시도하지 않는다. 사용자 흐름을 기다리게 하지 않는다.
3. **디바운스**: 화면 변경 이벤트가 몰리면 300ms 기다렸다가 마지막 화면만 보낸다. 같은 화면은 서버가 거르므로 앱에서 정교하게 막을 필요는 없다.
4. **민감 화면**: 비밀번호 입력 화면 등은 지금처럼 앱에서 먼저 거른다. 서버도 저장 전에 주민번호·카드번호·계좌번호(10자리 이상 숫자)·금액(`…원`)을 `***` 로 한 번 더 가린다.
5. **스크린샷은 보내지 않는다** (원칙상 화면 캡처 미수신, server-plan.md 12.10).

## 6. 응답 코드

| 코드 | `error.reason`     | 뜻·대응                                            |
| ---- | ------------------ | -------------------------------------------------- |
| 204  | –                  | heartbeat 정상                                     |
| 202  | –                  | screens 정상 (`saved` / `unchanged`)               |
| 400  | `invalid-argument` | 형식 오류. `error.message` 에 어느 필드인지 나온다 |
| 401  | –                  | 토큰 없음·만료 → `getIdToken(true)` 로 갱신        |
| 5xx  | `internal` 등      | 무시하고 다음 주기에 보낸다                        |

오류 본문 형식: `{ "error": { "reason": "invalid-argument", "message": "screen.nodes: Too big: expected array to have <=60 items" } }`

## 7. 연결 확인

1. 앱 debug 빌드에서 heartbeat 시작
2. 뷰어(`https://dv888sh4vt1v6.cloudfront.net`)에 로그인 → **5초 안에 기기 목록에 초록 점**으로 나타난다
3. 기기 이름(예: "시연폰 A")을 붙여 두면 여러 기기를 구분하기 쉽다
4. 폰에서 화면을 옮기면 기기 상세 왼쪽에 기록이 쌓이고, **"실시간 따라가기"** 를 켜 두면 1초 안에 오른쪽에 박스로 그려진다
5. 같은 화면은 같은 색 지문 칩으로 묶인다. 같은 화면인데 색이 갈리면 지문 규칙(fp@v1)의 개선 대상이다

뷰어 접근은 허용 목록에 있는 Google 계정만 가능하다 (`infra/envs/dev/terraform.tfvars` 의 `debug_viewer_emails`).

## 7.5 guide 요청도 뷰어에서 보기 (dev)

dev에서 `POST /v1/elder/guide`를 부르면, 서버가 그 요청을 디버그 뷰어에 **화면 하나로** 남깁니다. 목록에 `AI highlight` 같은 표시가 붙고, 화면을 누르면 다음이 보입니다.

- 앱이 보낸 접근성 화면 (마스킹 후), AI가 고른 요소는 빨간 테두리
- 앱 요청: `goal`, 한 말, `slots`, `history`
- AI 호출: 모델·프롬프트 버전, 상태(`ok`/`refusal`/`invalid`/`error` 또는 "모델 호출 안 함"), 지연, 토큰(캐시 포함)
- 모델 원래 출력과 앱에 보낸 최종 응답. 서버가 후처리로 바꿨으면 "서버가 고침" 표시
- AI에 보낸 입력 전체 (위치 %·상태 포함, 펼쳐서 보기)

어느 기기 아래에 쌓일지는 이 순서로 정합니다.

1. guide 요청 본문의 `deviceId` (디버그 모드에서 쓰는 것과 같은 값을 넣으면 화면 전송과 한 줄로 이어짐)
2. 없으면 같은 계정(uid)이 heartbeat로 등록한 가장 최근 기기
3. 그것도 없으면 `uid-<uid>` 기기

## 8. 데이터 보관

| 대상                      | 보관 기간           |
| ------------------------- | ------------------- |
| 화면 기록 (기본)          | 3일                 |
| 보관 세션으로 지정한 구간 | 30일                |
| 기기 정보                 | 마지막 신호 후 30일 |

dev 환경에만 존재하며 prod에는 이 엔드포인트가 없다(호출 시 404).
