variable "env" {
  description = "환경 이름 (dev | prod). 모든 리소스 이름이 haebom-<env>- 로 시작한다."
  type        = string
}

variable "firebase_project_id" {
  description = "Firebase 프로젝트 ID (Auth·FCM)"
  type        = string
}

variable "dist_dir" {
  description = "npm run build 결과 디렉터리 (함수별 하위 디렉터리)"
  type        = string
}

variable "app_version" {
  description = "배포 버전 (CI 에서 git SHA). healthz 응답에 나온다."
  type        = string
  default     = "local"
}

variable "log_level" {
  type    = string
  default = "info"
}

variable "anthropic_model" {
  description = "ai-fn 이 호출할 Claude 모델"
  type        = string
  default     = "claude-sonnet-5-5"
}

variable "route_enabled" {
  description = "jev 앱·목표 고르기 기능 스위치 (docs/jev-routing-plan.md 9장). R1 에서는 아무도 쓰지 않음"
  type        = bool
  default     = false
}

variable "ai_reserved_concurrency" {
  description = "ai-fn 동시 실행 상한 (LLM 비용 보호). null 이면 설정 안 함."
  type        = number
  default     = null
}

variable "point_in_time_recovery" {
  type    = bool
  default = false
}

variable "deletion_protection" {
  type    = bool
  default = false
}

variable "secret_recovery_window_in_days" {
  type    = number
  default = 7
}

variable "api_throttling_burst_limit" {
  type    = number
  default = 100
}

variable "api_throttling_rate_limit" {
  type    = number
  default = 50
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "ai_extra_environment" {
  description = "ai-fn 에만 더할 환경 변수 (dev: 디버그 뷰어 기록용 DEBUG_TABLE·DEBUG_BUCKET)"
  type        = map(string)
  default     = {}
}
