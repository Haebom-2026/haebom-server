terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.74"
    }
  }

  # bootstrap 은 state 버킷 자체를 만들므로 로컬 state 를 쓴다.
  # 만든 뒤 terraform.tfstate 는 안전한 곳에 보관한다 (git 에 올리지 않음).
}

provider "aws" {
  region = var.region

  # haebom 은 이 계정에만 배포한다. 다른 계정 자격 증명이면 Terraform 이 거부한다.
  allowed_account_ids = ["045861054142"]

  default_tags {
    tags = {
      Project   = "haebom"
      Env       = "shared"
      ManagedBy = "terraform"
    }
  }
}
