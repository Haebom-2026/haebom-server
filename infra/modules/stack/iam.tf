# 함수별 최소 권한 (docs/server-plan.md 11.3)

locals {
  main_table_resources = [
    module.dynamodb.main_table_arn,
    "${module.dynamodb.main_table_arn}/index/*",
  ]
}

data "aws_iam_policy_document" "api" {
  statement {
    sid = "MainTable"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:ConditionCheckItem",
    ]
    resources = local.main_table_resources
  }
  statement {
    sid       = "IdempotencyTable"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [module.dynamodb.idem_table_arn]
  }
}

data "aws_iam_policy_document" "ai" {
  statement {
    sid       = "MainTableProfileAndUsage"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [module.dynamodb.main_table_arn]
  }
  statement {
    sid       = "AnthropicKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [module.secrets.arns["anthropic-api-key"]]
  }
}

data "aws_iam_policy_document" "push" {
  statement {
    sid = "MainStream"
    actions = [
      "dynamodb:DescribeStream",
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
      "dynamodb:ListStreams",
    ]
    resources = [module.dynamodb.main_stream_arn]
  }
  statement {
    sid       = "MainTableDevices"
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:DeleteItem"]
    resources = [module.dynamodb.main_table_arn]
  }
  statement {
    sid       = "FcmServiceAccount"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [module.secrets.arns["fcm-service-account"]]
  }
}

data "aws_iam_policy_document" "expire" {
  statement {
    sid       = "PendingIndex"
    actions   = ["dynamodb:Query"]
    resources = ["${module.dynamodb.main_table_arn}/index/GSI2"]
  }
  statement {
    sid       = "Approvals"
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [module.dynamodb.main_table_arn]
  }
}
