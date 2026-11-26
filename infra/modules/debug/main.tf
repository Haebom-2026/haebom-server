# 디버그 뷰어 (docs/server-plan.md 12장) — envs/dev 에서만 사용한다. prod 에는 만들지 않는다.
#   debug-fn  : /v1/dev/* 처리
#   테이블    : <prefix>-debug (기기·화면 색인·보관 세션, TTL)
#   버킷      : <prefix>-debug-<계정> (screens/ 3일, pinned/ 30일)

data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------------------
# 저장소
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "debug" {
  name         = "${var.prefix}-debug"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  server_side_encryption {
    enabled = true
  }
}

resource "aws_s3_bucket" "debug" {
  bucket        = "${var.prefix}-debug-${data.aws_caller_identity.current.account_id}"
  force_destroy = true # 디버그 데이터: 환경을 내릴 때 같이 지운다
}

resource "aws_s3_bucket_public_access_block" "debug" {
  bucket                  = aws_s3_bucket.debug.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "debug" {
  bucket = aws_s3_bucket.debug.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "debug" {
  bucket = aws_s3_bucket.debug.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "debug" {
  bucket = aws_s3_bucket.debug.id

  rule {
    id     = "screens-3d"
    status = "Enabled"
    filter {
      prefix = "screens/"
    }
    expiration {
      days = 3
    }
  }

  rule {
    id     = "pinned-30d"
    status = "Enabled"
    filter {
      prefix = "pinned/"
    }
    expiration {
      days = 30
    }
  }
}

# ---------------------------------------------------------------------------
# 함수
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "debug" {
  statement {
    sid = "DebugTable"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
      "dynamodb:Scan",
    ]
    resources = [aws_dynamodb_table.debug.arn]
  }
  statement {
    sid       = "DebugObjects"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.debug.arn}/screens/*", "${aws_s3_bucket.debug.arn}/pinned/*"]
  }
}

module "debug_fn" {
  source = "../lambda_function"

  name        = "${var.prefix}-debug-fn"
  description = "Debug viewer API (/v1/dev/*), dev only"
  zip_path    = var.zip_path
  memory_size = 512
  timeout     = 15
  environment = merge(var.environment, {
    DEBUG_TABLE         = aws_dynamodb_table.debug.name
    DEBUG_BUCKET        = aws_s3_bucket.debug.bucket
    DEBUG_VIEWER_EMAILS = join(",", var.viewer_emails)
  })
  policy_json              = data.aws_iam_policy_document.debug.json
  permissions_boundary_arn = var.permissions_boundary_arn
  log_retention_days       = var.log_retention_days
}

# ---------------------------------------------------------------------------
# 라우트: /v1/dev/* 는 ANY /v1/{proxy+} 보다 구체적이라 우선한다
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_integration" "debug" {
  api_id                 = var.api_id
  integration_type       = "AWS_PROXY"
  integration_uri        = module.debug_fn.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "debug" {
  api_id             = var.api_id
  route_key          = "ANY /v1/dev/{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.debug.id}"
  authorization_type = "JWT"
  authorizer_id      = var.authorizer_id
}

resource "aws_lambda_permission" "invoke" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.debug_fn.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${var.api_execution_arn}/*/*"
}

# ai-fn 이 guide 요청·AI 판단을 디버그 저장소에 기록하는 권한 (src/debug/guide-trace.ts)
data "aws_iam_policy_document" "ai_trace" {
  statement {
    sid       = "DebugTableWrite"
    actions   = ["dynamodb:UpdateItem", "dynamodb:PutItem", "dynamodb:Scan"]
    resources = [aws_dynamodb_table.debug.arn]
  }
  statement {
    sid       = "DebugScreensWrite"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.debug.arn}/screens/*"]
  }
}

resource "aws_iam_role_policy" "ai_trace" {
  count = var.ai_role_name == "" ? 0 : 1

  name   = "debug-trace"
  role   = var.ai_role_name
  policy = data.aws_iam_policy_document.ai_trace.json
}
