# 끝난 명령의 Opus 검토 (docs/jev-routing-plan.md 7장, R3) — dev 전용.
# main 테이블 Stream 에서 명령 항목에 끝 신호(done·stopped_safe)가 처음 붙은 변경만 받는다.
# 검토 결과는 판정만 저장하고 지도에 반영하지 않는다.

data "aws_iam_policy_document" "review" {
  statement {
    sid = "MainStream"
    actions = [
      "dynamodb:DescribeStream",
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
      "dynamodb:ListStreams",
    ]
    resources = [var.main_stream_arn]
  }
  statement {
    sid       = "MainTableCommands"
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [var.main_table_arn]
  }
  statement {
    sid       = "DebugScreensRead"
    actions   = ["dynamodb:GetItem", "dynamodb:Query"]
    resources = [var.debug_table_arn, "${var.debug_table_arn}/index/*"]
  }
  statement {
    sid       = "DebugScreenObjects"
    actions   = ["s3:GetObject"]
    resources = ["${var.debug_bucket_arn}/*"]
  }
  statement {
    sid       = "AnthropicKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.anthropic_secret_arn]
  }
}

module "review_fn" {
  source = "../lambda_function"

  name        = "${var.prefix}-review-fn"
  description = "Opus review of finished commands (dev, judgement only)"
  zip_path    = var.zip_path
  memory_size = 512
  timeout     = 120
  environment = merge(var.environment, {
    DEBUG_TABLE         = var.debug_table_name
    DEBUG_BUCKET        = var.debug_bucket_name
    ANTHROPIC_SECRET_ID = var.anthropic_secret_id
    REVIEW_MODEL        = var.review_model
  })
  policy_json              = data.aws_iam_policy_document.review.json
  permissions_boundary_arn = var.permissions_boundary_arn
  # Opus 비용 보호: 한 번에 하나씩
  reserved_concurrency = 1
  log_retention_days   = var.log_retention_days
}

resource "aws_lambda_event_source_mapping" "review" {
  event_source_arn                   = var.main_stream_arn
  function_name                      = module.review_fn.function_arn
  starting_position                  = "LATEST"
  batch_size                         = 1
  maximum_batching_window_in_seconds = 0
  maximum_retry_attempts             = 2
  bisect_batch_on_function_error     = true
  function_response_types            = ["ReportBatchItemFailures"]

  # 명령 항목이 MODIFY 되면서 끝 결과가 done·stopped_safe 인 것만 (이미 끝난 명령의 변경은 함수가 거름)
  filter_criteria {
    filter {
      pattern = jsonencode({
        eventName = ["MODIFY"]
        dynamodb = {
          NewImage = {
            type      = { S = ["command"] }
            endResult = { S = ["done", "stopped_safe"] }
          }
        }
      })
    }
  }
}
