module "api_fn" {
  source = "../lambda_function"

  name                     = "${local.prefix}-api-fn"
  description              = "REST API (#1-#15, #18-#24)"
  zip_path                 = "${var.dist_dir}/api.zip"
  memory_size              = 512
  timeout                  = 10
  environment              = local.common_env
  policy_json              = data.aws_iam_policy_document.api.json
  permissions_boundary_arn = local.lambda_boundary_arn
  log_retention_days       = var.log_retention_days
}

module "ai_fn" {
  source = "../lambda_function"

  name        = "${local.prefix}-ai-fn"
  description = "AI guide (#16) and classify (#17)"
  zip_path    = "${var.dist_dir}/ai.zip"
  memory_size = 1024
  timeout     = 12
  environment = merge(local.common_env, {
    ANTHROPIC_SECRET_ID = module.secrets.ids["anthropic-api-key"]
    ANTHROPIC_MODEL     = var.anthropic_model
  })
  policy_json              = data.aws_iam_policy_document.ai.json
  permissions_boundary_arn = local.lambda_boundary_arn
  reserved_concurrency     = var.ai_reserved_concurrency
  log_retention_days       = var.log_retention_days
}

module "push_fn" {
  source = "../lambda_function"

  name        = "${local.prefix}-push-fn"
  description = "DynamoDB stream to FCM push"
  zip_path    = "${var.dist_dir}/push.zip"
  memory_size = 256
  timeout     = 30
  environment = merge(local.common_env, {
    FCM_SECRET_ID       = module.secrets.ids["fcm-service-account"]
    FIREBASE_PROJECT_ID = var.firebase_project_id
  })
  policy_json              = data.aws_iam_policy_document.push.json
  permissions_boundary_arn = local.lambda_boundary_arn
  log_retention_days       = var.log_retention_days
}

module "expire_fn" {
  source = "../lambda_function"

  name                     = "${local.prefix}-expire-fn"
  description              = "Expire pending approvals every minute"
  zip_path                 = "${var.dist_dir}/expire.zip"
  memory_size              = 256
  timeout                  = 60
  environment              = local.common_env
  policy_json              = data.aws_iam_policy_document.expire.json
  permissions_boundary_arn = local.lambda_boundary_arn
  log_retention_days       = var.log_retention_days
}
