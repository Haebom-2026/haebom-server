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
  description = "배포 역할을 만들 환경 목록. 한 계정 안에서 이름 접두사(haebom-<env>-)로 권한을 나눈다."
  type        = set(string)
  default     = ["dev", "prod"]
}
