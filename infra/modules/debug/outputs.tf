output "function_name" {
  value = module.debug_fn.function_name
}

output "table_name" {
  value = aws_dynamodb_table.debug.name
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
