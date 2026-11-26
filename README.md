# haebom-server

고령자 스마트폰 도우미 "해봄"의 서버. AWS Lambda(TypeScript) + API Gateway + DynamoDB, Terraform으로 관리한다.
기획은 [docs/server-plan.md](docs/server-plan.md).

## 구조

```
src/functions/{api,ai,push,expire,debug}  Lambda 진입점 5개 (debug 는 dev 전용)
src/core/                                 S1 사용자·기기·연결 (라우트, 저장소, 프로필)
src/ai/                                   #16 guide (Claude Sonnet 5.5 호출, 프롬프트, 후처리)
src/push/                                 FCM 발송, 연결 변경 알림
src/debug/                                디버그 뷰어 API (/v1/dev/*)
src/cache/                                화면 지문 (캐싱 계층 준비)
src/shared/                               라우터, 오류 형식, 로거, 인증, 검증, 마스킹, 비밀 값, Idempotency
scripts/build.ts                          esbuild 번들 → dist/<fn>.zip
scripts/dev-deploy.sh                     dev 로컬 배포 (npm run dev:*)
scripts/viewer-deploy.sh                  디버그 뷰어 웹 업로드 (npm run viewer:deploy)
scripts/adb-capture/                      앱 없이 실제 폰 화면을 뷰어로 보내기 (npm run capture)
viewer/                                   디버그 뷰어 웹 (Vite, dev 전용)
test/                                     vitest
infra/bootstrap/                          state 버킷, GitHub OIDC, 배포 역할, 권한 경계 (1회)
infra/modules/                            dynamodb, lambda_function, http_api, secrets, stack, debug
infra/envs/{dev,prod}/                    환경별 진입점 (같은 AWS 계정, 이름 접두사 haebom-<env>-)
.github/workflows/                        ci.yml (검사·plan·배포 트리거), deploy.yml (apply)
```

## 문서

| 문서                                                             | 내용                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------ |
| [docs/server-plan.md](docs/server-plan.md)                       | 서버 기획 전체 (아키텍처, 데이터, API 목록, 개발 단계) |
| [docs/api/s1-users-links.md](docs/api/s1-users-links.md)         | S1 사용자·기기·연결 API 계약서 (앱 연동용)             |
| [docs/api/s5-guide.md](docs/api/s5-guide.md)                     | #16 guide API 계약서 (앱 연동용)                       |
| [docs/debug-viewer-app-guide.md](docs/debug-viewer-app-guide.md) | 디버그 뷰어 앱 연동 가이드                             |
| [docs/adb-capture.md](docs/adb-capture.md)                       | adb 캡처 사용법                                        |

## 현재 dev 주소

| 용도           | 주소                                                          |
| -------------- | ------------------------------------------------------------- |
| API (Base URL) | `https://qq829otaql.execute-api.ap-northeast-2.amazonaws.com` |
| 디버그 뷰어    | `https://dv888sh4vt1v6.cloudfront.net`                        |

주소는 `terraform -chdir=infra/envs/dev output` 으로도 볼 수 있다.

## 로컬 개발

Node 24, npm.

```bash
npm ci
```

```bash
npm run check
```

`check` = lint → typecheck → test → build.

## 처음 배포 (한 번만)

> **AWS 계정: `045861054142` (서울 `ap-northeast-2`)**. Terraform의 `allowed_account_ids`와 `scripts/dev-deploy.sh`가 다른 계정 자격 증명이면 실행을 거부한다. 기본 프로필이 다른 계정이면 `AWS_PROFILE`을 이 계정 프로필로 지정한다.

### 1. bootstrap

`045861054142` 계정의 관리자 권한 자격 증명으로 실행한다 (예: `AWS_PROFILE=<프로필> terraform -chdir=infra/bootstrap apply`). state는 로컬에 남으므로 `infra/bootstrap/terraform.tfstate`를 안전한 곳에 보관한다 (git에 올라가지 않음).

```bash
terraform -chdir=infra/bootstrap init
```

```bash
terraform -chdir=infra/bootstrap apply
```

출력값: `state_bucket`, `plan_role_arn`, `deploy_role_arns` (prod만).

### 2. GitHub 설정 (prod 배포용)

- Repository variables: `TF_STATE_BUCKET`, `AWS_PLAN_ROLE_ARN`
- Environment `prod` 생성, environment variable `AWS_DEPLOY_ROLE_ARN` (bootstrap 출력의 prod 값)
- (선택) `prod` environment에 Required reviewers를 지정하면 main 머지 후 승인해야 배포된다
- `TF_STATE_BUCKET`이 없으면 PR plan과 prod 배포 job은 건너뛰고 검사만 돈다. 설정하는 순간부터 main 머지 때 prod에 배포된다

### 3. Firebase 프로젝트 ID

dev·prod 모두 `copilot-demo-c9a74` 로 설정돼 있다 (`infra/envs/*/terraform.tfvars`). 프로젝트를 바꾸면 이 값을 고친다.

### 4. 비밀 값 등록

Terraform은 Secrets Manager 항목만 만들고 값은 넣지 않는다 (키가 state·git에 남지 않도록). 첫 apply 후 한 번 등록한다.

키가 셸 기록에 남지 않도록 `read -s` 로 입력받는다.

```bash
read -rs ANTHROPIC_API_KEY && aws secretsmanager put-secret-value --region ap-northeast-2 --secret-id haebom-dev/anthropic-api-key --secret-string "$ANTHROPIC_API_KEY" && unset ANTHROPIC_API_KEY
```

```bash
aws secretsmanager put-secret-value --region ap-northeast-2 --secret-id haebom-dev/fcm-service-account --secret-string file://firebase-service-account.json
```

등록한 뒤 서비스 계정 JSON 파일은 지운다. dev는 두 값 모두 등록돼 있다. prod는 첫 배포 뒤 `haebom-prod/...` 로 같게 등록한다.

jev 앱·목표 고르기([docs/jev-routing-plan.md](docs/jev-routing-plan.md))를 쓸 때는 OpenRouter 키도 등록한다. 아직 ai-fn 이 쓰지 않으므로(`ROUTE_ENABLED=false`) 등록하지 않아도 동작에는 영향이 없다.

```bash
read -rs OPENROUTER_API_KEY && aws secretsmanager put-secret-value --region ap-northeast-2 --secret-id haebom-dev/openrouter-api-key --secret-string "$OPENROUTER_API_KEY" && unset OPENROUTER_API_KEY
```

회귀 측정(`npx tsx scripts/route-eval.ts`)은 로컬에서 환경 변수 `OPENROUTER_API_KEY` 또는 `~/.config/haebom/openrouter.key` 의 키로 jev 를 직접 부른다 (말 98개 × 지도 하나 ≈ $0.005~0.012).

## 배포 흐름

| 환경 | 방법                                                               |
| ---- | ------------------------------------------------------------------ |
| dev  | **로컬**에서 `npm run dev:plan` / `npm run dev:apply`              |
| prod | **GitHub**: main에 머지 → 검사 → prod `apply` → `/v1/healthz` 확인 |

PR을 올리면 검사와 함께 prod `terraform plan` 결과가 job summary에 남는다.

### dev 로컬 배포

현재 AWS 자격 증명(`AWS_PROFILE` 등)으로 실행하고, 계정이 `045861054142`가 아니면 멈춘다. `npm run dev:apply -- -auto-approve`처럼 뒤에 붙인 인자는 Terraform에 그대로 넘어간다. 빌드 → `terraform init`(state 버킷은 계정 ID로 자동 계산) → plan/apply까지 한 번에 한다. apply는 Terraform이 변경 내용을 보여 주고 `yes` 입력을 받는다.

```bash
AWS_PROFILE=<045861054142 계정 프로필> npm run dev:plan
```

```bash
AWS_PROFILE=<045861054142 계정 프로필> npm run dev:apply
```

apply가 끝나면 `/v1/healthz`를 호출해 확인한다. 배포 버전은 git 커밋 해시이고, 커밋하지 않은 변경이 있으면 `-dirty`가 붙는다. 지울 때는 `npm run dev:destroy`.

dev는 **main 기준으로 배포**한다. 아직 머지하지 않은 브랜치로 dev 전체를 apply하면, 다른 브랜치에서 올린 기능이 되돌아간다.

디버그 뷰어 웹을 바꿨으면 dev apply 뒤에 따로 올린다.

```bash
AWS_PROFILE=<045861054142 계정 프로필> npm run viewer:deploy
```
