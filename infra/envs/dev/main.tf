module "stack" {
  source = "../../modules/stack"

  env                 = "dev"
  firebase_project_id = var.firebase_project_id
  dist_dir            = "${path.root}/../../../dist"
  app_version         = var.app_version
  log_level           = "debug"

  # dev 는 지워도 되는 환경
  point_in_time_recovery         = false
  deletion_protection            = false
  secret_recovery_window_in_days = 0
  log_retention_days             = 14

  # jev 앱·목표 고르기 (docs/jev-routing-plan.md). 키: Secrets haebom-dev/openrouter-api-key
  route_enabled = true

  # guide 요청·AI 판단을 디버그 뷰어에 기록 (dev 전용)
  ai_extra_environment = {
    DEBUG_TABLE  = module.debug.table_name
    DEBUG_BUCKET = module.debug.bucket_name
    # 지도 안내 (docs/jev-routing-plan.md 5장, R4). 사람이 승인한 길만 (scripts/map-seed.ts)
    MAP_GUIDE_ENABLED = "true"
  }
}

# 디버그 뷰어 (docs/server-plan.md 12장) — dev 전용. prod 에는 이 블록을 두지 않는다.
module "debug" {
  source = "../../modules/debug"

  prefix                   = "haebom-dev"
  api_id                   = module.stack.http_api.id
  api_execution_arn        = module.stack.http_api.execution_arn
  authorizer_id            = module.stack.http_api.authorizer_id
  zip_path                 = "${path.root}/../../../dist/debug.zip"
  permissions_boundary_arn = module.stack.lambda_boundary_arn
  environment              = module.stack.common_env
  viewer_emails            = var.debug_viewer_emails
  api_endpoint             = module.stack.api_endpoint
  firebase_project_id      = var.firebase_project_id
  firebase_web_api_key     = var.firebase_web_api_key
  log_retention_days       = 14
  ai_role_name             = module.stack.ai_role_name
}

# 끝난 명령의 Opus 검토 (docs/jev-routing-plan.md 7장, R3) — dev 전용, 판정만
module "review" {
  source = "../../modules/review"

  prefix                   = "haebom-dev"
  zip_path                 = "${path.root}/../../../dist/review.zip"
  permissions_boundary_arn = module.stack.lambda_boundary_arn
  environment              = module.stack.common_env
  main_table_arn           = module.stack.main_table_arn
  main_stream_arn          = module.stack.main_stream_arn
  debug_table_name         = module.debug.table_name
  debug_table_arn          = module.debug.table_arn
  debug_bucket_name        = module.debug.bucket_name
  debug_bucket_arn         = module.debug.bucket_arn
  anthropic_secret_id      = module.stack.secret_ids["anthropic-api-key"]
  anthropic_secret_arn     = module.stack.secret_arns["anthropic-api-key"]
  log_retention_days       = 14
}

# 지도 안내 (R4, dev 전용): ai-fn 이 지도 파티션(PK=MAP)을 Query 로 읽는다. 다른 파티션 Query 는 주지 않는다
data "aws_iam_policy_document" "ai_map_read" {
  statement {
    sid       = "MapPartitionQuery"
    actions   = ["dynamodb:Query"]
    resources = [module.stack.main_table_arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["MAP"]
    }
  }
}

resource "aws_iam_role_policy" "ai_map_read" {
  name   = "map-read"
  role   = module.stack.ai_role_name
  policy = data.aws_iam_policy_document.ai_map_read.json
}
