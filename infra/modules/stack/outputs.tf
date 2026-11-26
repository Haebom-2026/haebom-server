output "api_endpoint" {
  value = module.http_api.endpoint
}

output "main_table_name" {
  value = module.dynamodb.main_table_name
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
