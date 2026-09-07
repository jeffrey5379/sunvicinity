output "db_bucket" {
  description = "Bucket name — ../deploy reads this automatically from this stack's state file."
  value       = aws_s3_bucket.artifacts.bucket
}

output "db_key" {
  description = "Object key the instance downloads stardata.db from."
  value       = "stardata.db"
}

output "upload_command" {
  description = "Run once from infra/bootstrap/ after apply. ~17 GB, one-time (repeat only when you rebuild the DB)."
  value       = "aws s3 cp ../../scripts/stardata.db s3://${aws_s3_bucket.artifacts.bucket}/stardata.db"
}
