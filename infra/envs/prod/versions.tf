terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.74"
    }
  }

  # bucket 은 계정 ID 가 들어가므로 init 때 넘긴다:
  #   terraform init -backend-config="bucket=haebom-tfstate-<account_id>"
  backend "s3" {
    key          = "envs/prod/terraform.tfstate"
    region       = "ap-northeast-2"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "ap-northeast-2"

  default_tags {
    tags = {
      Project   = "haebom"
      Env       = "prod"
      ManagedBy = "terraform"
    }
  }
}
