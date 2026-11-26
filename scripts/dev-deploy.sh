#!/usr/bin/env bash
# dev 환경 로컬 배포. 사용: npm run dev:plan | npm run dev:apply | npm run dev:destroy
# 현재 AWS 자격 증명(AWS_PROFILE 등)으로 실행한다. infra/bootstrap 을 먼저 apply 해야 한다.
set -euo pipefail

command="${1:-plan}"
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
terraform -chdir="$env_dir" "$command" -input=false -var "app_version=$version"

if [ "$command" = "apply" ]; then
  endpoint="$(terraform -chdir="$env_dir" output -raw api_endpoint)"
  echo "healthz: $endpoint/v1/healthz"
  curl --fail --silent --show-error --retry 5 --retry-delay 2 --retry-all-errors "$endpoint/v1/healthz"
  echo
fi
