variable "name" {
  description = "함수 이름 (예: haebom-dev-api-fn). 역할·로그 그룹 이름에도 쓴다."
  type        = string
}

variable "description" {
  type    = string
  default = ""
}

variable "zip_path" {
  description = "배포 zip (dist/<fn>.zip). npm run build 후에 존재한다."
  type        = string
}

variable "handler" {
  type    = string
  default = "index.handler"
}

variable "runtime" {
  type    = string
  default = "nodejs24.x"
}

variable "memory_size" {
  type = number
}

variable "timeout" {
  description = "초"
  type        = number
}

variable "environment" {
  description = "환경 변수 (비밀 값은 넣지 말고 Secrets Manager 이름만)"
  type        = map(string)
  default     = {}
}

variable "policy_json" {
  description = "실행 역할에 붙일 인라인 정책 (로그 권한은 모듈이 따로 붙인다)"
  type        = string
  default     = null
}

variable "permissions_boundary_arn" {
  description = "실행 역할의 권한 경계 (infra/bootstrap 에서 생성)"
  type        = string
}

variable "reserved_concurrency" {
  description = "예약 동시성. null 이면 설정 안 함 (새 계정은 동시성 한도가 낮아 설정 시 실패할 수 있음)"
  type        = number
  default     = null
}

variable "log_retention_days" {
  type    = number
  default = 30
}
