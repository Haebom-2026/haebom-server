# DynamoDB Streams → push-fn
resource "aws_lambda_event_source_mapping" "push" {
  event_source_arn                   = module.dynamodb.main_stream_arn
  function_name                      = module.push_fn.function_arn
  starting_position                  = "LATEST"
  batch_size                         = 50
  maximum_batching_window_in_seconds = 0
  maximum_retry_attempts             = 3
  bisect_batch_on_function_error     = true
  function_response_types            = ["ReportBatchItemFailures"]
}

# 1분마다 expire-fn
resource "aws_cloudwatch_event_rule" "expire" {
  name                = "${local.prefix}-expire-approvals"
  description         = "Expire pending approvals"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "expire" {
  rule = aws_cloudwatch_event_rule.expire.name
  arn  = module.expire_fn.function_arn
}

resource "aws_lambda_permission" "expire_schedule" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.expire_fn.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.expire.arn
}
