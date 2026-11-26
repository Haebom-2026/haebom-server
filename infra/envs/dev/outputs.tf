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
    viewer_url    = module.debug.viewer_url
  }
}

# scripts/viewer-deploy.sh 가 읽는다
output "viewer_bucket" {
  value = module.debug.viewer_bucket
}

output "viewer_distribution_id" {
  value = module.debug.viewer_distribution_id
}
