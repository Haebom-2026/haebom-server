output "state_bucket" {
  description = "envs/* 의 terraform init -backend-config=\"bucket=...\" 에 넣을 값 (GitHub 변수 TF_STATE_BUCKET)"
  value       = aws_s3_bucket.tfstate.bucket
}

output "plan_role_arn" {
  description = "GitHub 변수 AWS_PLAN_ROLE_ARN"
  value       = aws_iam_role.plan.arn
}

output "deploy_role_arns" {
  description = "GitHub environment 별 변수 AWS_DEPLOY_ROLE_ARN"
  value       = { for env, role in aws_iam_role.deploy : env => role.arn }
}

output "lambda_boundary_arns" {
  description = "envs/<env> 의 lambda_permissions_boundary_arn 변수에 넣을 값"
  value       = { for env, policy in aws_iam_policy.lambda_boundary : env => policy.arn }
}
