# Persistent state that must OUTLIVE the deploy/destroy cycle: a private S3
# bucket holding the ~17 GB stardata.db. Everything in ../deploy is created
# by `terraform apply` and removed by `terraform destroy`; this bucket is
# the one thing that stays between sessions (S3 Standard for 17 GB is
# ~$0.40/month), so the instance can re-pull the DB on each fresh boot
# instead of you re-uploading 17 GB every time.
#
# Run once:
#   terraform init && terraform apply
#   <then run the `upload_command` output, once, ~17 GB one-time upload>
# You only ever come back here to change the DB (rebuild -> re-upload) or to
# tear the bucket down for good (`terraform destroy`).

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.0" }
  }
}

provider "aws" {
  region = var.region
}

# S3 bucket names are global; the random suffix avoids collisions.
resource "random_id" "suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "artifacts" {
  bucket = "sunvicinity-${random_id.suffix.hex}"
  # Lets `terraform destroy` remove the bucket even with stardata.db still
  # in it — there's no backup to protect (you have the source DB locally).
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
