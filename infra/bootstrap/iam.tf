# 역할 구성
#   haebom-gha-plan        : PR 에서 terraform plan (읽기 전용 + state 잠금 파일)
#   haebom-gha-deploy-<env>: GitHub environment "<env>" 에서만 assume, haebom-<env>-* 리소스만 변경
#                            github_deploy_environments 기본값은 prod 만 (dev 는 로컬 배포)
#                            (github_deploy_environments, 기본 prod 만. dev 는 로컬 배포)

locals {
  repo_sub_prefix = "repo:${var.github_repository}"
}

# ---------------------------------------------------------------------------
# plan 역할 (pull_request)
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "plan_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = ["${local.repo_sub_prefix}:pull_request"]
    }
  }
}

resource "aws_iam_role" "plan" {
  name                 = "haebom-gha-plan"
  assume_role_policy   = data.aws_iam_policy_document.plan_trust.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "plan_readonly" {
  role       = aws_iam_role.plan.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/ReadOnlyAccess"
}

data "aws_iam_policy_document" "plan_state" {
  statement {
    sid       = "StateRead"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.tfstate.arn]
  }
  statement {
    sid       = "StateObjectsRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.tfstate.arn}/envs/*"]
  }
  statement {
    sid       = "StateLockFile"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.tfstate.arn}/envs/*.tflock"]
  }
}

resource "aws_iam_role_policy" "plan_state" {
  name   = "terraform-state"
  role   = aws_iam_role.plan.id
  policy = data.aws_iam_policy_document.plan_state.json
}

# ---------------------------------------------------------------------------
# 배포 역할 (환경별)
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "deploy_trust" {
  for_each = var.github_deploy_environments

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = ["${local.repo_sub_prefix}:environment:${each.key}"]
    }
  }
}

data "aws_iam_policy_document" "deploy" {
  for_each = var.github_deploy_environments

  # state: 자기 환경 키만
  statement {
    sid       = "StateList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.tfstate.arn]
  }
  statement {
    sid       = "StateObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.tfstate.arn}/envs/${each.key}/*"]
  }

  # 이름으로 범위를 좁힐 수 있는 서비스
  statement {
    sid     = "DynamoDB"
    actions = ["dynamodb:*"]
    resources = [
      "arn:${local.partition}:dynamodb:${var.region}:${local.account_id}:table/haebom-${each.key}-*",
    ]
  }
  statement {
    sid     = "Lambda"
    actions = ["lambda:*"]
    resources = [
      "arn:${local.partition}:lambda:${var.region}:${local.account_id}:function:haebom-${each.key}-*",
    ]
  }
  statement {
    sid     = "LambdaEventSourceMappings"
    actions = ["lambda:*EventSourceMapping*", "lambda:ListTags", "lambda:TagResource", "lambda:UntagResource"]
    resources = [
      "arn:${local.partition}:lambda:${var.region}:${local.account_id}:event-source-mapping:*",
    ]
  }
  statement {
    sid       = "LambdaAccountWide"
    actions   = ["lambda:GetAccountSettings", "lambda:ListEventSourceMappings", "lambda:CreateEventSourceMapping"]
    resources = ["*"]
  }
  statement {
    sid     = "Logs"
    actions = ["logs:*"]
    resources = [
      "arn:${local.partition}:logs:${var.region}:${local.account_id}:log-group:/aws/lambda/haebom-${each.key}-*",
      "arn:${local.partition}:logs:${var.region}:${local.account_id}:log-group:/aws/lambda/haebom-${each.key}-*:*",
      "arn:${local.partition}:logs:${var.region}:${local.account_id}:log-group:/aws/apigateway/haebom-${each.key}-*",
      "arn:${local.partition}:logs:${var.region}:${local.account_id}:log-group:/aws/apigateway/haebom-${each.key}-*:*",
    ]
  }
  statement {
    sid       = "LogsDescribe"
    actions   = ["logs:DescribeLogGroups", "logs:ListTagsForResource"]
    resources = ["*"]
  }
  # HTTP API 접근 로그 설정에 필요한 계정 단위 권한
  statement {
    sid = "LogsDelivery"
    actions = [
      "logs:CreateLogDelivery",
      "logs:GetLogDelivery",
      "logs:UpdateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutResourcePolicy",
      "logs:DescribeResourcePolicies",
    ]
    resources = ["*"]
  }
  statement {
    sid     = "Events"
    actions = ["events:*"]
    resources = [
      "arn:${local.partition}:events:${var.region}:${local.account_id}:rule/haebom-${each.key}-*",
    ]
  }
  statement {
    sid = "Secrets"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:DeleteSecret",
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetResourcePolicy",
      "secretsmanager:TagResource",
      "secretsmanager:UntagResource",
      "secretsmanager:UpdateSecret",
      "secretsmanager:RestoreSecret",
    ]
    # 값 읽기(GetSecretValue)는 주지 않는다 → 배포 역할로 API 키를 읽을 수 없음
    resources = [
      "arn:${local.partition}:secretsmanager:${var.region}:${local.account_id}:secret:haebom-${each.key}/*",
    ]
  }
  # Lambda 실행 역할: 권한 경계(permissions boundary)를 단 역할만 만들거나 정책을 넣을 수 있다.
  # → 배포 역할이 자기보다 넓은 권한의 역할을 만들어 우회하는 것(권한 상승)을 막는다.
  statement {
    sid = "IamRolesManage"
    actions = [
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:ListRoleTags",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription",
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
    ]
    resources = ["arn:${local.partition}:iam::${local.account_id}:role/haebom-${each.key}-*"]
  }
  statement {
    sid       = "IamRolesBounded"
    actions   = ["iam:CreateRole", "iam:PutRolePolicy", "iam:PutRolePermissionsBoundary"]
    resources = ["arn:${local.partition}:iam::${local.account_id}:role/haebom-${each.key}-*"]
    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [aws_iam_policy.lambda_boundary[each.key].arn]
    }
  }
  statement {
    sid       = "IamBoundaryRead"
    actions   = ["iam:GetPolicy", "iam:GetPolicyVersion"]
    resources = [aws_iam_policy.lambda_boundary[each.key].arn]
  }
  statement {
    sid       = "IamPassRole"
    actions   = ["iam:PassRole"]
    resources = ["arn:${local.partition}:iam::${local.account_id}:role/haebom-${each.key}-*"]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
  }
  statement {
    sid       = "CloudWatch"
    actions   = ["cloudwatch:*Alarm*", "cloudwatch:*Dashboard*", "cloudwatch:TagResource", "cloudwatch:UntagResource", "cloudwatch:ListTagsForResource"]
    resources = ["*"]
  }

  # API Gateway 는 ARN 에 이름이 없어(ID 기반) 이름으로 범위를 좁힐 수 없다.
  statement {
    sid       = "ApiGateway"
    actions   = ["apigateway:*"]
    resources = ["arn:${local.partition}:apigateway:${var.region}::/*"]
  }
}

resource "aws_iam_role" "deploy" {
  for_each = var.github_deploy_environments

  name                 = "haebom-gha-deploy-${each.key}"
  assume_role_policy   = data.aws_iam_policy_document.deploy_trust[each.key].json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "deploy" {
  for_each = var.github_deploy_environments

  name   = "terraform-deploy"
  role   = aws_iam_role.deploy[each.key].id
  policy = data.aws_iam_policy_document.deploy[each.key].json
}
