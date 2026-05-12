# Provider für das Zertifikat (muss us-east-1 sein)
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

resource "aws_acm_certificate" "cert" {
  provider          = aws.us_east_1
  domain_name       = "high-definition.net"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}