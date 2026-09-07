# The disposable half. `terraform apply` brings the whole app up on one
# EC2 instance (~4-6 min for first boot: install Node/Caddy, clone, pull the
# 17 GB DB from S3, npm ci, vite build); `terraform destroy` removes
# everything here. Nothing in this stack is billed once destroyed — only
# the bootstrap bucket persists.
#
#   cd infra/deploy
#   terraform init
#   terraform apply      # -> open the app_url output once it responds
#   terraform destroy    # when you're done for the day

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = var.region
}

# Bucket name / key come straight from the bootstrap stack's state — no
# copy-pasting. `terraform apply` here fails clearly if bootstrap hasn't run.
data "terraform_remote_state" "bootstrap" {
  backend = "local"
  config  = { path = "${path.module}/../bootstrap/terraform.tfstate" }
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  db_bucket = data.terraform_remote_state.bootstrap.outputs.db_bucket
  db_key    = data.terraform_remote_state.bootstrap.outputs.db_key

  # Pick the matching Amazon Linux 2023 AMI for the instance's architecture.
  is_arm  = length(regexall("^(t4g|m6g|m7g|c6g|c7g|r6g|r7g|a1|im4gn|is4gen)\\.", var.instance_type)) > 0
  ami_ssm = local.is_arm ? "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64" : "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

data "aws_ssm_parameter" "ami" {
  name = local.ami_ssm
}

# --- Minimal dedicated network (destroys cleanly, no dependency on the
#     account's default VPC) ---------------------------------------------------

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "sunvicinity" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "sunvicinity" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.0.0/24"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true
  tags                    = { Name = "sunvicinity-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "sunvicinity-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "app" {
  name        = "sunvicinity"
  description = "sunvicinity: HTTP from anywhere, SSH from ssh_ingress_cidr"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.ssh_ingress_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "sunvicinity" }
}

# --- IAM: instance may read only the one DB object -------------------------

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "sunvicinity-ec2"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "s3_read" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::${local.db_bucket}/${local.db_key}"]
  }
}

resource "aws_iam_role_policy" "s3_read" {
  name   = "db-read"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.s3_read.json
}

resource "aws_iam_instance_profile" "app" {
  name = "sunvicinity-ec2"
  role = aws_iam_role.app.name
}

# --- The instance --------------------------------------------------------------

resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.ami.value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.app.name
  key_name               = var.key_name != "" ? var.key_name : null

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    db_bucket   = local.db_bucket
    db_key      = local.db_key
    repo_url    = var.repo_url
    repo_branch = var.repo_branch
  })
  # Editing the bootstrap script recreates the instance on next apply.
  user_data_replace_on_change = true

  root_block_device {
    volume_size = var.root_volume_gb
    volume_type = "gp3"
  }

  tags = { Name = "sunvicinity" }
}
