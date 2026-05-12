# 1. Provider & Region
provider "aws" {
  region = "eu-central-1"
}

# Provider für das Zertifikat (MUSS us-east-1 sein für CloudFront)
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

# --- Zertifikat & Validierung ---
resource "aws_acm_certificate" "cert" {
  provider          = aws.us_east_1
  domain_name       = "high-definition.net"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "cert_validation" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.cert.arn
}

# --- 2. S3 Buckets ---

# Bucket für das statische Frontend
resource "aws_s3_bucket" "website_bucket" {
  bucket = "highdefinition-galleries-ft-aviationlove"
}

# Bucket für die Medien (Bilder, CSVs)
resource "aws_s3_bucket" "media_bucket" {
  bucket = "hd-media-highdefinition-galleries-ft-aviationlove"
}

resource "aws_s3_bucket_cors_configuration" "media_cors" {
  bucket = aws_s3_bucket.media_bucket.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST"]
    allowed_origins = ["*"]
    max_age_seconds = 3000
  }
}

# --- 3. CloudFront Setup ---

resource "aws_cloudfront_origin_access_control" "default" {
  name                              = "s3-hosting-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "s3_distribution" {
  depends_on = [aws_acm_certificate_validation.cert_validation]

  origin {
    domain_name              = aws_s3_bucket.website_bucket.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.default.id
    origin_id                = "S3Origin"
  }

  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  aliases             = ["high-definition.net"]

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "S3Origin"
    viewer_protocol_policy = "redirect-to-https"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate.cert.arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_s3_bucket_policy" "allow_cloudfront_access" {
  bucket = aws_s3_bucket.website_bucket.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontServicePrincipalReadOnly"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.website_bucket.arn}/*"
        Condition = {
          StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.s3_distribution.arn }
        }
      }
    ]
  })
}

# --- 4. Datenbank (DynamoDB) ---

resource "aws_dynamodb_table" "gallery_table" {
  name           = "UserGalleries"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key        = "UserId"
  range_key       = "GalleryId"

  attribute {
    name = "UserId"
    type = "S"
  }

  attribute {
    name = "GalleryId"
    type = "S"
  }
}

# --- 5. IAM & Lambda Setup ---

resource "aws_iam_role" "iam_for_lambda" {
  name = "my_lambda_role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.iam_for_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "lambda_dynamo_read" {
  role       = aws_iam_role.iam_for_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonDynamoDBReadOnlyAccess"
}

# Lambda 1: Galerie Daten abrufen
data "archive_file" "lambda_zip" {
  type        = "zip"
  source_file = "${path.module}/../backend/get_gallery_data.py"
  output_path = "${path.module}/../backend/get_gallery_data.zip"
}

resource "aws_lambda_function" "api_lambda" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "get_gallery_data"
  handler          = "get_gallery_data.handler" 
  role             = aws_iam_role.iam_for_lambda.arn
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  runtime          = "python3.9"
}

# Lambda 2: Bildverarbeitung
data "archive_file" "process_image_zip" {
  type        = "zip"
  source_file = "${path.module}/../backend/process_image.py"
  output_path = "${path.module}/../backend/process_image_payload.zip"
}

resource "aws_lambda_function" "process_image_lambda" {
  filename         = data.archive_file.process_image_zip.output_path
  function_name    = "process_image_handler"
  role             = aws_iam_role.iam_for_lambda.arn
  handler          = "process_image.handler"
  source_code_hash = data.archive_file.process_image_zip.output_base64sha256
  runtime          = "python3.9"
}

# S3 Trigger für Bildverarbeitung
resource "aws_lambda_permission" "allow_s3" {
  statement_id  = "AllowExecutionFromS3Bucket"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.process_image_lambda.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.media_bucket.arn
}

resource "aws_s3_bucket_notification" "bucket_notification" {
  bucket = aws_s3_bucket.media_bucket.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.process_image_lambda.arn
    events              = ["s3:ObjectCreated:*"]
  }
  depends_on = [aws_lambda_permission.allow_s3]
}

# --- 6. API Gateway ---

resource "aws_apigatewayv2_api" "http_api" {
  name          = "v0-api"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST"]
  }
}

resource "aws_apigatewayv2_integration" "lambda_integration" {
  api_id           = aws_apigatewayv2_api.http_api.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.api_lambda.invoke_arn
}

resource "aws_apigatewayv2_route" "gallery_route" {
  api_id    = aws_apigatewayv2_api.http_api.id
  route_key = "GET /gallery"
  target    = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}

resource "aws_apigatewayv2_stage" "default_stage" {
  api_id      = aws_apigatewayv2_api.http_api.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "api_gw" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api_lambda.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http_api.execution_arn}/*/*"
}

# --- 7. Outputs ---

output "cloudfront_url" {
  value = aws_cloudfront_distribution.s3_distribution.domain_name
}

output "api_url" {
  value = "${aws_apigatewayv2_api.http_api.api_endpoint}/gallery"
}

resource "aws_route53_zone" "main" {
  name = "high-definition.net"
}

resource "aws_route53_record" "www" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "high-definition.net"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.s3_distribution.domain_name
    zone_id                = aws_cloudfront_distribution.s3_distribution.hosted_zone_id
    evaluate_target_health = false
  }
}