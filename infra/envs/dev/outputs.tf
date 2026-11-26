output "api_endpoint" {
  value = module.stack.api_endpoint
}

output "secret_ids" {
  value = module.stack.secret_ids
}

output "function_names" {
  value = module.stack.function_names
}

output "debug" {
  value = {
    function_name = module.debug.function_name
    table_name    = module.debug.table_name
    bucket_name   = module.debug.bucket_name
  }
}
