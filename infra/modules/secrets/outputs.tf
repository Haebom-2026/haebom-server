output "ids" {
  description = "비밀 이름 → 전체 이름 (Lambda 환경 변수로 전달)"
  value       = { for key, secret in aws_secretsmanager_secret.this : key => secret.name }
}

output "arns" {
  value = { for key, secret in aws_secretsmanager_secret.this : key => secret.arn }
}
