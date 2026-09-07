variable "region" {
  description = "Must match infra/bootstrap (S3 -> EC2 transfer is free only in-region)."
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = <<-EOT
    Graviton/ARM by default (cheapest for this workload). t4g.large = 2 vCPU / 8 GB,
    ~$0.067/hr on-demand. Bump to t4g.xlarge (16 GB) if query latency is poor — more
    of the 17 GB DB stays in the OS page cache. x86 types (t3.*) also work; the AMI
    architecture follows the type automatically.
  EOT
  type        = string
  default     = "t4g.large"
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
