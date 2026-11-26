# haebom-server

고령자 스마트폰 도우미 "해봄"의 서버. AWS Lambda(TypeScript) + API Gateway + DynamoDB, Terraform으로 관리한다.
기획은 [docs/server-plan.md](docs/server-plan.md).

## 구조

```
src/functions/{api,ai,push,expire}   Lambda 진입점 4개
src/shared/                          라우터, 오류 형식, 로거, 인증
scripts/build.ts                     esbuild 번들 → dist/<fn>.zip
test/                                vitest
infra/bootstrap/                     state 버킷, GitHub OIDC, 배포 역할, 권한 경계 (1회)
infra/modules/                       dynamodb, lambda_function, http_api, secrets, stack
infra/envs/{dev,prod}/               환경별 진입점 (같은 AWS 계정, 이름 접두사 haebom-<env>-)
.github/workflows/                   ci.yml (검사·plan·배포 트리거), deploy.yml (apply)
```

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

### 1. bootstrap

관리자 권한 AWS 자격 증명으로 실행한다. state는 로컬에 남으므로 `infra/bootstrap/terraform.tfstate`를 안전한 곳에 보관한다 (git에 올라가지 않음).

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

### 3. Firebase 프로젝트 ID

`infra/envs/dev/terraform.tfvars`, `infra/envs/prod/terraform.tfvars`의 `firebase_project_id`를 실제 값으로 바꾼다. 바꾸기 전에는 plan이 실패한다.

### 4. 비밀 값 등록

Terraform은 Secrets Manager 항목만 만들고 값은 넣지 않는다 (키가 state·git에 남지 않도록). 첫 apply 후 한 번 등록한다.

```bash
aws secretsmanager put-secret-value --secret-id haebom-dev/anthropic-api-key --secret-string "$ANTHROPIC_API_KEY"
```

```bash
aws secretsmanager put-secret-value --secret-id haebom-dev/fcm-service-account --secret-string file://firebase-service-account.json
```

prod도 `haebom-prod/...` 로 같게 등록한다.

## 배포 흐름

| 환경 | 방법                                                               |
| ---- | ------------------------------------------------------------------ |
| dev  | **로컬**에서 `npm run dev:plan` / `npm run dev:apply`              |
| prod | **GitHub**: main에 머지 → 검사 → prod `apply` → `/v1/healthz` 확인 |

PR을 올리면 검사와 함께 prod `terraform plan` 결과가 job summary에 남는다.

### dev 로컬 배포

현재 AWS 자격 증명(`AWS_PROFILE` 등)으로 실행한다. 빌드 → `terraform init`(state 버킷은 계정 ID로 자동 계산) → plan/apply까지 한 번에 한다. apply는 Terraform이 변경 내용을 보여 주고 `yes` 입력을 받는다.

```bash
npm run dev:plan
```

```bash
npm run dev:apply
```

apply가 끝나면 `/v1/healthz`를 호출해 확인한다. 배포 버전은 git 커밋 해시이고, 커밋하지 않은 변경이 있으면 `-dirty`가 붙는다. 지울 때는 `npm run dev:destroy`.
