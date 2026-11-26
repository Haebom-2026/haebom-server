module "http_api" {
  source = "../http_api"

  name                   = "${local.prefix}-api"
  firebase_project_id    = var.firebase_project_id
  throttling_burst_limit = var.api_throttling_burst_limit
  throttling_rate_limit  = var.api_throttling_rate_limit
  log_retention_days     = var.log_retention_days

  functions = {
    api = { function_name = module.api_fn.function_name, invoke_arn = module.api_fn.invoke_arn }
    ai  = { function_name = module.ai_fn.function_name, invoke_arn = module.ai_fn.invoke_arn }
  }

  # 더 구체적인 라우트가 {proxy+} 보다 우선한다.
  routes = {
    "GET /v1/healthz"                         = { function = "api", auth = false }
    "ANY /v1/{proxy+}"                        = { function = "api", auth = true }
    "POST /v1/elder/guide"                    = { function = "ai", auth = true }
    "POST /v1/elder/classify"                 = { function = "ai", auth = true }
    "POST /v1/elder/commands/{commandId}/app" = { function = "ai", auth = true }
  }
}
