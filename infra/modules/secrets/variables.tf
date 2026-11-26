variable "name_prefix" {
  description = "비밀 이름 접두사 (예: haebom-dev → haebom-dev/anthropic-api-key)"
  type        = string
}

variable "secrets" {
  description = "비밀 이름 → 설명"
  type        = map(string)
}

variable "recovery_window_in_days" {
  type    = number
  default = 7
}
