# 환경별 Lambda 실행 역할의 권한 경계.
# Lambda 역할에 어떤 인라인 정책이 붙어도 실제 권한은 이 범위를 넘지 못한다.

data "aws_iam_policy_document" "lambda_boundary" {
  for_each = var.environments

  statement {
    sid       = "DynamoDB"
    actions   = ["dynamodb:*"]
    resources = ["arn:${local.partition}:dynamodb:${var.region}:${local.account_id}:table/haebom-${each.key}-*"]
  }
  statement {
    sid     = "Logs"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "arn:${local.partition}:logs:${var.region}:${local.account_id}:log-group:/aws/lambda/haebom-${each.key}-*:*",
    ]
  }
  statement {
    sid       = "Secrets"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = ["arn:${local.partition}:secretsmanager:${var.region}:${local.account_id}:secret:haebom-${each.key}/*"]
  }
}

resource "aws_iam_policy" "lambda_boundary" {
  for_each = var.environments

  name        = "haebom-${each.key}-lambda-boundary"
  description = "Permissions boundary for haebom-${each.key} Lambda execution roles"
  policy      = data.aws_iam_policy_document.lambda_boundary[each.key].json
}
