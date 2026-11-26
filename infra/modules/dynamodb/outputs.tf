output "main_table_name" {
  value = aws_dynamodb_table.main.name
}

output "main_table_arn" {
  value = aws_dynamodb_table.main.arn
}

output "main_stream_arn" {
  value = aws_dynamodb_table.main.stream_arn
}

output "idem_table_name" {
  value = aws_dynamodb_table.idem.name
}

output "idem_table_arn" {
  value = aws_dynamodb_table.idem.arn
}
