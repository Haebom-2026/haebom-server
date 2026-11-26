output "api_id" {
  value = aws_apigatewayv2_api.this.id
}

output "endpoint" {
  description = "기본 호출 주소 (커스텀 도메인 전)"
  value       = aws_apigatewayv2_api.this.api_endpoint
}
