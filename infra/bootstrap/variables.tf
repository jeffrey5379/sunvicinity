variable "region" {
  description = "AWS region. Keep it the same in ../deploy — S3 -> EC2 transfer is only free in-region."
  type        = string
  default     = "us-east-1"
}
