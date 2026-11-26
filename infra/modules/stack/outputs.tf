output "api_endpoint" {
  value = module.http_api.endpoint
}

output "main_table_name" {
  value = module.dynamodb.main_table_name
}

# 스택 밖 모듈(review)이 명령 항목·Stream 을 읽을 때
output "main_table_arn" {
  value = module.dynamodb.main_table_arn
}

output "main_stream_arn" {
  value = module.dynamodb.main_stream_arn
}

output "secret_arns" {
  value = module.secrets.arns
}

output "secret_ids" {
  description = "값을 수동으로 등록해야 하는 비밀 이름"
  value       = module.secrets.ids
}

output "function_names" {
  value = {
    api    = module.api_fn.function_name
    ai     = module.ai_fn.function_name
    push   = module.push_fn.function_name
    expire = module.expire_fn.function_name
  }
}

# 스택 밖에서 같은 API 에 라우트를 붙이는 모듈(debug)용
output "http_api" {
  value = {
    id            = module.http_api.api_id
    execution_arn = module.http_api.execution_arn
    authorizer_id = module.http_api.authorizer_id
  }
}

output "lambda_boundary_arn" {
  value = local.lambda_boundary_arn
}

output "common_env" {
  value = local.common_env
}

# 디버그 모듈이 ai-fn 에 기록 권한을 붙일 때 쓴다
output "ai_role_name" {
  value = module.ai_fn.role_name
}
