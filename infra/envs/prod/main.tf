module "stack" {
  source = "../../modules/stack"

  env                 = "prod"
  firebase_project_id = var.firebase_project_id
  dist_dir            = "${path.root}/../../../dist"
  app_version         = var.app_version
  log_level           = "info"

  point_in_time_recovery         = true
  deletion_protection            = true
  secret_recovery_window_in_days = 7
  log_retention_days             = 30

  # LLM 비용 보호. 계정 동시성 한도를 올린 뒤 값을 정한다 (docs/server-plan.md 7장).
  ai_reserved_concurrency = null
}
