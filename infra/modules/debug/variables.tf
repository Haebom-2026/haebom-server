variable "prefix" {
  description = "리소스 이름 접두사 (예: haebom-dev). dev 에서만 이 모듈을 쓴다."
  type        = string
}

variable "api_id" {
  description = "라우트를 붙일 HTTP API ID"
  type        = string
}

variable "api_execution_arn" {
  type = string
}

variable "authorizer_id" {
  description = "Firebase JWT Authorizer ID"
  type        = string
}

variable "zip_path" {
  description = "dist/debug.zip"
  type        = string
}

variable "permissions_boundary_arn" {
  type = string
}

variable "environment" {
  description = "공통 환경 변수 (APP_ENV, LOG_LEVEL 등)"
  type        = map(string)
  default     = {}
}

variable "viewer_emails" {
  description = "디버그 뷰어를 쓸 수 있는 개발자 Google 계정 이메일"
  type        = list(string)
}

variable "log_retention_days" {
  type    = number
  default = 14
}
