#!/usr/bin/env bash
# 디버그 뷰어를 dev CloudFront 에 올린다. 사용: npm run viewer:deploy
# infra/envs/dev 가 먼저 apply 돼 있어야 한다 (버킷·배포 ID 를 terraform output 에서 읽음).
# config.json(Firebase 웹 설정)은 Terraform 이 관리하므로 여기서 건드리지 않는다.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_dir="$root/infra/envs/dev"

bucket="$(terraform -chdir="$env_dir" output -raw viewer_bucket)"
distribution="$(terraform -chdir="$env_dir" output -raw viewer_distribution_id)"

(cd "$root/viewer" && npm ci --no-audit --no-fund >/dev/null && npm run build)

# 해시가 붙은 assets 는 1년 캐시, index.html 은 매번 확인
aws s3 sync "$root/viewer/dist/assets" "s3://$bucket/assets" --delete \
  --cache-control "public, max-age=31536000, immutable"
aws s3 cp "$root/viewer/dist/index.html" "s3://$bucket/index.html" \
  --cache-control "no-cache" --content-type "text/html; charset=utf-8"

aws cloudfront create-invalidation --distribution-id "$distribution" --paths "/index.html" "/" \
  --query 'Invalidation.Id' --output text >/dev/null

echo "viewer: $(terraform -chdir="$env_dir" output -json debug | python3 -c 'import json,sys; print(json.load(sys.stdin)["viewer_url"])')"
