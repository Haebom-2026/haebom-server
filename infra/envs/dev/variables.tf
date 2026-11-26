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

variable "debug_viewer_emails" {
  description = "디버그 뷰어를 쓸 개발자 Google 계정 이메일 (terraform.tfvars)"
  type        = list(string)
  default     = []
}

variable "firebase_web_api_key" {
  description = "Firebase 웹 앱 apiKey (공개 값, 디버그 뷰어 로그인용). Firebase 콘솔 → 프로젝트 설정 → 내 앱 → 웹"
  type        = string
  default     = ""
}
