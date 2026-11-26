variable "firebase_project_id" {
  description = "Firebase 프로젝트 ID (terraform.tfvars)"
  type        = string

  validation {
    condition     = var.firebase_project_id != "REPLACE_ME" && length(var.firebase_project_id) > 0
    error_message = "terraform.tfvars 에 firebase_project_id 를 실제 값으로 넣어 주세요."
  }
}

variable "app_version" {
  description = "배포 버전 (CI 가 -var app_version=<git sha> 로 넘김)"
  type        = string
  default     = "local"
}
