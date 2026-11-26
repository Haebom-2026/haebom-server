variable "name" {
  description = "API 이름 (예: haebom-dev-api)"
  type        = string
}

variable "firebase_project_id" {
  description = "Firebase 프로젝트 ID. ID 토큰의 iss/aud 검증에 쓴다."
  type        = string
}

variable "functions" {
  description = "통합 대상 Lambda (키 → 이름·invoke ARN)"
  type = map(object({
    function_name = string
    invoke_arn    = string
  }))
}

variable "routes" {
  description = "라우트 키(\"GET /v1/healthz\") → 대상 함수 키와 인증 여부"
  type = map(object({
    function = string
    auth     = bool
  }))
}

variable "throttling_burst_limit" {
  type    = number
  default = 100
}

variable "throttling_rate_limit" {
  type    = number
  default = 50
}

variable "log_retention_days" {
  type    = number
  default = 30
}
