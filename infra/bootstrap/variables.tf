variable "region" {
  description = "AWS 리전"
  type        = string
  default     = "ap-northeast-2"
}

variable "github_repository" {
  description = "OIDC 로 배포를 허용할 GitHub 저장소 (owner/name)"
  type        = string
  default     = "Haebom-2026/haebom-server"
}

variable "environments" {
  description = "Lambda 권한 경계를 만들 환경 목록. 한 계정 안에서 이름 접두사(haebom-<env>-)로 권한을 나눈다."
  type        = set(string)
  default     = ["dev", "prod"]
}

variable "github_deploy_environments" {
  description = "GitHub Actions 배포 역할을 만들 환경. dev 는 로컬에서 배포하므로 prod 만."
  type        = set(string)
  default     = ["prod"]

  validation {
    condition     = length(setsubtract(var.github_deploy_environments, var.environments)) == 0
    error_message = "github_deploy_environments 는 environments 안의 값이어야 합니다."
  }
}

variable "create_github_oidc_provider" {
  description = "GitHub OIDC provider 를 새로 만들지 여부. 계정에 이미 있으면 false (기존 것을 참조)."
  type        = bool
  default     = true
}
