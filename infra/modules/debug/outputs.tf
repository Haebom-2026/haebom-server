output "function_name" {
  value = module.debug_fn.function_name
}

output "table_name" {
  value = aws_dynamodb_table.debug.name
}

output "bucket_name" {
  value = aws_s3_bucket.debug.bucket
}
