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

variable "api_endpoint" {
  description = "HTTP API 기본 주소 (https://...). CloudFront 가 /v1/* 를 여기로 넘긴다."
  type        = string
}

variable "firebase_project_id" {
  type = string
}

variable "firebase_web_api_key" {
  description = "Firebase 웹 앱 apiKey (공개 값). 비어 있으면 뷰어가 설정 안내를 띄운다."
  type        = string
  default     = ""
}

variable "ai_role_name" {
  description = "guide 요청을 디버그 저장소에 기록할 ai-fn 실행 역할 이름. 비우면 권한을 붙이지 않는다."
  type        = string
  default     = ""
}
