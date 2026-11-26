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

  # guide 요청·AI 판단을 디버그 뷰어에 기록 (dev 전용)
  ai_extra_environment = {
    DEBUG_TABLE  = module.debug.table_name
    DEBUG_BUCKET = module.debug.bucket_name
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
