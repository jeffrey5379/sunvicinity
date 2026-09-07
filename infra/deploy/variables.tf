variable "region" {
  description = "Must match infra/bootstrap (S3 -> EC2 transfer is free only in-region)."
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = <<-EOT
    Graviton/ARM by default. t4g.2xlarge = 8 vCPU / 32 GB, ~$0.27/hr on-demand:
    32 GB holds the whole 17 GB DB in the OS page cache (the main lever on query
    latency), and 8 vCPUs feed the server's query-worker pool (QUERY_WORKERS,
    default = vCPU count). t4g.xlarge (4 vCPU / 16 GB) is ~half the cost and still
    fine for light use. x86 types (t3.*) also work; the AMI follows the type.
  EOT
  type        = string
  default     = "t4g.2xlarge"
}

variable "root_volume_gb" {
  description = "gp3 root disk. 17 GB DB + node_modules + build + OS + logs; 40 is comfortable."
  type        = number
  default     = 40
}

variable "ssh_ingress_cidr" {
  description = "CIDR allowed to reach port 22. Tighten to \"<your.ip>/32\". Port 80 is always open to the world."
  type        = string
  default     = "0.0.0.0/0"
}

variable "key_name" {
  description = "Existing EC2 key pair name for SSH. Leave \"\" to skip — you can still use EC2 Instance Connect from the console."
  type        = string
  default     = ""
}

variable "repo_url" {
  description = "Git repo the instance clones on boot."
  type        = string
  default     = "https://github.com/jeffrey5379/sunvicinity.git"
}

variable "repo_branch" {
  description = "Branch to deploy. The instance clones this at boot, so commit + push before `terraform apply`."
  type        = string
  default     = "main"
}
