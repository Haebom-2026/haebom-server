resource "aws_apigatewayv2_api" "this" {
  name          = var.name
  protocol_type = "HTTP"
}

# Firebase ID 토큰 검증: 서명(JWKS)·만료·iss·aud 를 API Gateway 가 확인한다.
resource "aws_apigatewayv2_authorizer" "firebase" {
  api_id           = aws_apigatewayv2_api.this.id
  name             = "firebase"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    issuer   = "https://securetoken.google.com/${var.firebase_project_id}"
    audience = [var.firebase_project_id]
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  for_each = var.functions

  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = each.value.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "this" {
  for_each = var.routes

  api_id             = aws_apigatewayv2_api.this.id
  route_key          = each.key
  target             = "integrations/${aws_apigatewayv2_integration.lambda[each.value.function].id}"
  authorization_type = each.value.auth ? "JWT" : "NONE"
  authorizer_id      = each.value.auth ? aws_apigatewayv2_authorizer.firebase.id : null
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${var.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = var.throttling_burst_limit
    throttling_rate_limit  = var.throttling_rate_limit
  }

  # 요청 본문·헤더(토큰)는 남기지 않는다.
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format = jsonencode({
      requestId          = "$context.requestId"
      routeKey           = "$context.routeKey"
      status             = "$context.status"
      latencyMs          = "$context.responseLatency"
      integrationLatency = "$context.integrationLatency"
      authorizerError    = "$context.authorizer.error"
      integrationError   = "$context.integrationErrorMessage"
      uid                = "$context.authorizer.claims.sub"
      time               = "$context.requestTime"
    })
  }
}

resource "aws_lambda_permission" "invoke" {
  for_each = var.functions

  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = each.value.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}
