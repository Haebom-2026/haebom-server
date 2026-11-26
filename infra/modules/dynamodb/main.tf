# haebom-<env>-main : 도메인 단일 테이블 (docs/server-plan.md 3.2)
# haebom-<env>-idem : Idempotency-Key 응답 저장
# haebom-<env>-ai-cache : #16 guide 응답 캐시 (9장, src/cache/guide-cache.ts)

resource "aws_dynamodb_table" "main" {
  name         = "${var.name_prefix}-main"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }
  attribute {
    name = "GSI1PK"
    type = "S"
  }
  attribute {
    name = "GSI1SK"
    type = "S"
  }
  attribute {
    name = "GSI2PK"
    type = "S"
  }
  attribute {
    name = "GSI2SK"
    type = "S"
  }

  # 보호자 → 연결, 어르신 → 승인 목록
  global_secondary_index {
    name            = "GSI1"
    projection_type = "ALL"

    key_schema {
      attribute_name = "GSI1PK"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "GSI1SK"
      key_type       = "RANGE"
    }
  }

  # sparse: pending 승인만 (GSI2PK="PENDING", GSI2SK=expiresAt) → expire-fn
  global_secondary_index {
    name            = "GSI2"
    projection_type = "KEYS_ONLY"

    key_schema {
      attribute_name = "GSI2PK"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "GSI2SK"
      key_type       = "RANGE"
    }
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  point_in_time_recovery {
    enabled = var.point_in_time_recovery
  }

  deletion_protection_enabled = var.deletion_protection

  server_side_encryption {
    enabled = true
  }
}

resource "aws_dynamodb_table" "idem" {
  name         = "${var.name_prefix}-idem"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "key"

  attribute {
    name = "key"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  deletion_protection_enabled = var.deletion_protection

  server_side_encryption {
    enabled = true
  }
}

resource "aws_dynamodb_table" "ai_cache" {
  name         = "${var.name_prefix}-ai-cache"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "key"

  attribute {
    name = "key"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  # 캐시는 언제든 다시 만들 수 있어서 삭제 보호를 걸지 않는다
  server_side_encryption {
    enabled = true
  }
}
