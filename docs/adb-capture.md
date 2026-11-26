# adb 캡처 — 앱 없이 실제 폰 화면을 디버그 뷰어로 보내기 (dev 전용)

고령자 앱이 붙기 전에도 서버·뷰어·화면 지문(fp@v1)을 **실제 폰 화면**으로 확인하기 위한 도구.
노트북에서 `adb` 로 폰(또는 에뮬레이터)의 접근성 트리를 읽어, 앱이 보낼 것과 같은 형식으로 `/v1/dev/*` 에 보낸다.

- 코드: `scripts/adb-capture/` (`parse.ts` 변환, `index.ts` 실행)
- 보내는 형식: [debug-viewer-app-guide.md](debug-viewer-app-guide.md) 3·4장과 같다
- 폰에는 아무것도 설치하지 않는다 (USB 디버깅만)

## 준비

1. Android SDK platform-tools (`adb`). Android Studio 가 있으면 `~/Library/Android/sdk/platform-tools/adb` 를 자동으로 찾는다 (`ANDROID_HOME` 도 인식).
2. 기기 연결
   - 실제 폰: 개발자 옵션 → USB 디버깅 켜기 → USB 연결 → 폰에서 "허용"
   - 에뮬레이터: Android Studio Device Manager 에서 실행
   - 확인: `adb devices` 에 `device` 로 나와야 한다
3. dev 가 배포돼 있어야 한다 (API 주소·Firebase 웹 apiKey 를 `infra/envs/dev` 에서 읽음)
   - 다른 값을 쓰려면 `HAEBOM_API_URL`, `HAEBOM_FIREBASE_API_KEY` 환경 변수

## 실행

```bash
npm run capture
```

```
[16:53:35] 기기 emulator-5554 (sdk_gphone64_arm64, Android 14) → deviceId adb-emulator-5554
[16:53:37] API https://9a2sj8hqlb.execute-api.ap-northeast-2.amazonaws.com
[16:53:54] 화면 저장 com.android.settings 노드 27개 지문 7ceef2272d6b3dd2
[16:54:08] 화면 저장 com.android.settings 노드 20개 지문 d43044b59d99137f
```

- 5초마다 heartbeat, 1.5초마다 화면을 읽어 바뀌었을 때만 보낸다. `Ctrl+C` 로 끝낸다.
- 뷰어(`https://d3jcc37k40jy8z.cloudfront.net`)에 `adb-<시리얼>` 기기로 나타난다. 이름을 붙여 두면 구분하기 쉽다.

| 옵션                | 뜻                                                        |
| ------------------- | --------------------------------------------------------- |
| `--serial <시리얼>` | 기기가 여러 대일 때 고르기 (`adb devices` 의 첫 열)       |
| `--interval <ms>`   | 화면 읽는 간격 (기본 1500, 최소 500)                      |
| `--once`            | 한 번만 읽어 보내고 끝                                    |
| `--dry-run`         | 보내지 않고 보낼 JSON 만 출력 (앱 팀에 형식 예시로 줄 때) |

```bash
npm run capture -- --serial emulator-5554 --interval 1000
npm run capture -- --dry-run > sample.json
```

## 노드를 고르는 규칙 (`parse.ts`)

고령자 앱이 보낼 법한 노드만 남긴다.

- 남김: 글자(`text`)·설명(`content-desc`)이 있거나, 누를 수 있거나(`clickable`/`long-clickable`), 입력(`EditText`)·스크롤할 수 있는 **보이는** 노드
- 뺌: 크기 0 노드, 의미 없는 컨테이너, 시스템 UI(`com.android.systemui`: 상태바·내비게이션 바)
- 60개를 넘으면 (누를 수 있고 글자 있음) > (글자 있음) > (누를 수만 있음) 순으로 남기고, 화면 순서대로 `i` 를 다시 매긴다
- **비밀번호 칸**(`password="true"`)은 글자를 보내지 않고 `password: true` 표시만 남긴다
- 추가 필드: `id`(resource-id 의 마지막 부분), `clickable`, `editable`, `scrollable`, `checkable`, `checked`, `selected`, `focused`
- `pkg` 는 남은 노드에서 가장 많은 패키지, 화면 크기는 가장 큰 노드 영역

## 로그인

- Firebase **익명 로그인**(REST)으로 토큰을 받는다 — 고령자 앱과 같은 방식.
- refreshToken 을 `~/.haebom-adb-capture.json` (권한 600)에 보관해 실행할 때마다 같은 uid 를 쓴다. 지우면 새 익명 사용자가 생긴다.

## 한계 (adb 방식이라서)

| 한계                       | 내용                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 계속 바뀌는 화면은 못 읽음 | 동영상, 진행 표시, 일부 설정 화면(예: 휴대전화 정보)에서 `uiautomator` 가 "could not get idle state" 로 거부한다. 로그에 한 번 알리고 건너뛴다 |
| 실시간이 아님              | 화면 이벤트가 아니라 1.5초 간격으로 읽는다. 한 번 읽는 데 0.1~수 초                                                                            |
| 앱과 필터가 다를 수 있음   | 같은 접근성 트리를 읽지만 고령자 앱의 노드 선택 규칙과 다를 수 있다 → 앱이 붙으면 앱이 보낸 것을 기준으로 본다                                 |

이 한계는 고령자 앱의 AccessibilityService 에는 없다. 이벤트 즉시 반응까지 확인해야 할 때는 앱으로 본다.
