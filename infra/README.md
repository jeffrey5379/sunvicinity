# Deploying sunvicinity to AWS (ad-hoc, pay only while running)

One EC2 instance runs both the API (`server/index.js`) and a Caddy reverse
proxy serving the built frontend. The ~17 GB `stardata.db` lives in a private
S3 bucket and is pulled onto the instance on every boot, so the deploy stack
holds **no persistent state** — bring it up for a few hours, then destroy it.

```
infra/
  bootstrap/   run once. Creates the S3 bucket. ~$0.40/month, forever.
  deploy/      apply = whole app up on one EC2 box. destroy = $0.
```

## Prerequisites

- Terraform >= 1.5, AWS CLI, credentials with EC2 / VPC / IAM / S3 permissions.
- The app must be pushed to the Git repo/branch in `deploy/variables.tf`
  (`repo_url` / `repo_branch`, default `main`) — the instance clones it at boot.
  **Commit and push before every `terraform apply`.**

## One-time setup

```sh
cd infra/bootstrap
terraform init
terraform apply
# then run the printed `upload_command`, once (~17 GB, a few minutes):
aws s3 cp ../../scripts/stardata.db s3://sunvicinity-XXXXXXXX/stardata.db
```

Re-run the `aws s3 cp` only when you rebuild the DB locally.

## Each deploy session

```sh
cd infra/deploy
terraform init          # first time only
terraform apply         # ~30s to create; instance then boots for ~4-6 min
```

Open the `app_url` output (`http://<public-ip>/sunvicinity/`). First boot
installs Node + Caddy, clones the repo, downloads the DB, runs `npm ci` and
`vite build`, so the URL 404s/refuses until that finishes. To watch:

```sh
ssh ec2-user@<public-ip>            # needs key_name set; else EC2 Instance Connect
tail -f /var/log/sunvicinity-bootstrap.log
journalctl -u sunvicinity -f
```

When done:

```sh
terraform destroy
```

That removes the instance, EBS volume, VPC, IAM role, security group — billing
for this stack goes to zero. The S3 bucket (bootstrap) stays.

## Cost

| When | What's billed | Approx |
|---|---|---|
| Idle (destroyed) | S3 Standard, 17 GB | **~$0.40 / month** |
| Running | `t4g.large` + 40 GB gp3 | **~$0.072 / hour** (≈ $0.29 for a 4h session) |
| Running | data transfer out | a few GB/session → cents |

`us-east-1`, on-demand. A 1-year Compute Savings Plan would cut the hourly
rate ~35%, but for occasional few-hour sessions on-demand is simpler and the
absolute cost is tiny.

## Options

- **Slow queries?** Set `instance_type = "t4g.xlarge"` (16 GB) so more of the
  17 GB DB stays in the OS page cache. First few queries after boot are always
  colder.
- **Lock down SSH:** set `ssh_ingress_cidr = "<your.ip>/32"`. Port 80 is always
  open to the world (public read-only app).
- **HTTPS:** needs a domain. Point it at the instance IP, then change the Caddy
  site address in `deploy/user_data.sh.tftpl` from `:80` to that hostname —
  Caddy provisions a cert automatically. (No Route 53 resources here by design.)
- **x86 instead of Graviton:** set `instance_type = "t3.large"` — the AMI
  architecture follows automatically.

## Notes / limitations

- Single instance: it's a point of failure and there's downtime while it boots.
  Fine for ad-hoc use; not a production HA setup.
- `terraform destroy` in `deploy/` leaves the S3 bucket. To remove that too:
  `cd infra/bootstrap && terraform destroy` (bucket has `force_destroy = true`).
- No backups (by request) — the source of truth for `stardata.db` is your
  local copy / the build scripts.
