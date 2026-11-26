variable "name_prefix" {
  description = "리소스 이름 접두사 (예: haebom-dev)"
  type        = string
}

variable "point_in_time_recovery" {
  description = "PITR 사용 여부"
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "테이블 삭제 보호"
  type        = bool
  default     = false
}
