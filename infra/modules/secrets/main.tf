# 비밀 "껍데기"만 만든다. 값(secret_version)은 Terraform 으로 넣지 않는다
# → API 키가 state·tfvars·git 에 남지 않는다. 값은 README 의 절차로 한 번만 수동 등록.

resource "aws_secretsmanager_secret" "this" {
  for_each = var.secrets

  name                    = "${var.name_prefix}/${each.key}"
  description             = each.value
  recovery_window_in_days = var.recovery_window_in_days
}
