#!/usr/bin/env bash
# dev 환경 로컬 배포. 사용: npm run dev:plan | npm run dev:apply | npm run dev:destroy
# 현재 AWS 자격 증명(AWS_PROFILE 등)으로 실행한다. infra/bootstrap 을 먼저 apply 해야 한다.
#   예: AWS_PROFILE=<045861054142 계정 프로필> npm run dev:apply
# 추가 인자는 terraform 에 그대로 넘긴다 (예: npm run dev:apply -- -auto-approve).
set -euo pipefail

# haebom 을 배포하는 AWS 계정 (infra/*/versions.tf 의 allowed_account_ids 와 같아야 한다)
expected_account="045861054142"

command="${1:-plan}"
shift || true
case "$command" in
  plan | apply | destroy) ;;
  *)
    echo "usage: $0 plan|apply|destroy" >&2
    exit 2
    ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_dir="$root/infra/envs/dev"

account_id="$(aws sts get-caller-identity --query Account --output text)"
if [ "$account_id" != "$expected_account" ]; then
  echo "현재 AWS 계정은 $account_id 입니다. haebom 은 $expected_account 계정에만 배포합니다." >&2
  echo "AWS_PROFILE 을 $expected_account 계정 프로필로 지정하고 다시 실행하세요." >&2
  exit 1
fi
bucket="haebom-tfstate-${account_id}"
if ! aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
  echo "state 버킷 $bucket 이 없습니다. infra/bootstrap 을 먼저 apply 하세요." >&2
  exit 1
fi

version="$(git -C "$root" rev-parse --short HEAD)"
if ! git -C "$root" diff --quiet HEAD; then
  version="${version}-dirty"
fi

echo "account=$account_id version=$version command=$command"

(cd "$root" && npm run build)

terraform -chdir="$env_dir" init -input=false -reconfigure -backend-config="bucket=$bucket" >/dev/null
# plan 은 입력이 필요 없고, apply·destroy 는 변경 내용을 보여 주고 yes 를 묻는다.
if [ "$command" = "plan" ]; then
  terraform -chdir="$env_dir" plan -input=false -var "app_version=$version" "$@"
else
  terraform -chdir="$env_dir" "$command" -var "app_version=$version" "$@"
fi

if [ "$command" = "apply" ]; then
  endpoint="$(terraform -chdir="$env_dir" output -raw api_endpoint)"
  echo "healthz: $endpoint/v1/healthz"
  curl --fail --silent --show-error --retry 5 --retry-delay 2 --retry-all-errors "$endpoint/v1/healthz"
  echo
fi
