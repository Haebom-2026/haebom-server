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
}
