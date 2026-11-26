# 디버그 뷰어 정적 호스팅 (docs/server-plan.md 12.8) — dev 전용
#   CloudFront ─┬─ /*     → S3 (비공개 버킷, OAC 로만 읽기)
#               └─ /v1/*  → API Gateway (같은 주소에서 API 호출 → CORS 불필요)
# 화면 데이터는 여기 없다. 페이지는 빈 껍데기이고, 데이터는 /v1/dev/* 가 허용 이메일에만 준다.
# 파일 업로드는 scripts/viewer-deploy.sh (npm run viewer:deploy).

resource "aws_s3_bucket" "viewer" {
  bucket        = "${var.prefix}-debug-viewer-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "viewer" {
  bucket                  = aws_s3_bucket.viewer.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "viewer" {
  bucket = aws_s3_bucket.viewer.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "viewer" {
  bucket = aws_s3_bucket.viewer.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Firebase 웹 설정 (공개 값). 빌드에 넣지 않고 실행 시 읽는다 → 키가 바뀌어도 다시 빌드할 필요 없음
resource "aws_s3_object" "viewer_config" {
  bucket        = aws_s3_bucket.viewer.id
  key           = "config.json"
  content_type  = "application/json"
  cache_control = "no-cache"
  content = jsonencode({
    firebase = {
      apiKey     = var.firebase_web_api_key
      authDomain = "${var.firebase_project_id}.firebaseapp.com"
      projectId  = var.firebase_project_id
    }
  })
}

resource "aws_cloudfront_origin_access_control" "viewer" {
  name                              = "${var.prefix}-debug-viewer"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

data "aws_cloudfront_response_headers_policy" "security" {
  name = "Managed-SecurityHeadersPolicy"
}

locals {
  api_domain = replace(var.api_endpoint, "https://", "")
}

resource "aws_cloudfront_distribution" "viewer" {
  enabled             = true
  comment             = "${var.prefix} debug viewer"
  default_root_object = "index.html"
  price_class         = "PriceClass_200" # 한국 포함
  http_version        = "http2and3"

  origin {
    origin_id                = "viewer-s3"
    domain_name              = aws_s3_bucket.viewer.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.viewer.id
  }

  origin {
    origin_id   = "api"
    domain_name = local.api_domain
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id           = "viewer-s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id
  }

  # API: 캐시하지 않고 Authorization 헤더·쿼리·본문을 그대로 넘긴다 (Host 는 API Gateway 것으로)
  ordered_cache_behavior {
    path_pattern             = "/v1/*"
    target_origin_id         = "api"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

data "aws_iam_policy_document" "viewer_bucket" {
  statement {
    sid       = "CloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.viewer.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.viewer.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "viewer" {
  bucket     = aws_s3_bucket.viewer.id
  policy     = data.aws_iam_policy_document.viewer_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.viewer]
}
