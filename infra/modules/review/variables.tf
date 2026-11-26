variable "prefix" {
  description = "이름 앞부분 (haebom-dev)"
  type        = string
}

variable "zip_path" {
  type = string
}

variable "permissions_boundary_arn" {
  type = string
}

variable "environment" {
  description = "공통 환경 변수 (TABLE_MAIN 등)"
  type        = map(string)
}

variable "main_table_arn" {
  type = string
}

variable "main_stream_arn" {
  type = string
}

variable "debug_table_name" {
  type = string
}

variable "debug_table_arn" {
  type = string
}

variable "debug_bucket_name" {
  type = string
}

variable "debug_bucket_arn" {
  type = string
}

variable "anthropic_secret_id" {
  type = string
}

variable "anthropic_secret_arn" {
  type = string
}

variable "review_model" {
  description = "검토에 쓸 Claude 모델"
  type        = string
  default     = "claude-opus-5-5"
}

variable "log_retention_days" {
  type    = number
  default = 14
}
