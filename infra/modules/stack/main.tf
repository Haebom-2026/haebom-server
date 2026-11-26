data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  prefix = "haebom-${var.env}"

  # infra/bootstrap 에서 만든 권한 경계 (이름 규칙으로 계산)
  lambda_boundary_arn = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:policy/${local.prefix}-lambda-boundary"

  common_env = {
    APP_ENV     = var.env
    APP_VERSION = var.app_version
    LOG_LEVEL   = var.log_level
    TABLE_MAIN  = module.dynamodb.main_table_name
    TABLE_IDEM  = module.dynamodb.idem_table_name
  }
}

module "dynamodb" {
  source = "../dynamodb"

  name_prefix            = local.prefix
  point_in_time_recovery = var.point_in_time_recovery
  deletion_protection    = var.deletion_protection
}

module "secrets" {
  source = "../secrets"

  name_prefix             = local.prefix
  recovery_window_in_days = var.secret_recovery_window_in_days
  secrets = {
    "anthropic-api-key"   = "Anthropic API key used by ${local.prefix}-ai-fn"
    "fcm-service-account" = "Firebase service account JSON used by ${local.prefix}-push-fn"
  }
}
