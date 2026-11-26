output "api_id" {
  value = aws_apigatewayv2_api.this.id
}

output "endpoint" {
  description = "기본 호출 주소 (커스텀 도메인 전)"
  value       = aws_apigatewayv2_api.this.api_endpoint
}

output "execution_arn" {
  value = aws_apigatewayv2_api.this.execution_arn
}

output "authorizer_id" {
  description = "Firebase JWT Authorizer (다른 모듈이 라우트를 붙일 때 사용, 예: debug)"
  value       = aws_apigatewayv2_authorizer.firebase.id
}
