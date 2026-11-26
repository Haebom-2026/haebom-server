output "function_name" {
  value = module.debug_fn.function_name
}

output "table_name" {
  value = aws_dynamodb_table.debug.name
}

output "table_arn" {
  value = aws_dynamodb_table.debug.arn
}

output "bucket_arn" {
  value = aws_s3_bucket.debug.arn
}

output "bucket_name" {
  value = aws_s3_bucket.debug.bucket
}

output "viewer_url" {
  value = "https://${aws_cloudfront_distribution.viewer.domain_name}"
}

output "viewer_bucket" {
  value = aws_s3_bucket.viewer.bucket
}

output "viewer_distribution_id" {
  value = aws_cloudfront_distribution.viewer.id
}

# envs/dev 가 main 테이블 읽기 권한(지도·명령 검토)을 붙일 때 쓴다
output "role_name" {
  value = module.debug_fn.role_name
}
