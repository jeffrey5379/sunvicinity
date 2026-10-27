output "instance_id" {
  value = aws_instance.app.id
}

output "public_ip" {
  value = aws_instance.app.public_ip
}

output "elastic_ip" {
  description = "Stable address associated with the instance — point the domain's A record here."
  value       = var.elastic_ip
}

output "app_url" {
  description = "Open this once the instance finishes booting (first boot ~4-6 min; TLS cert issuance adds a bit more on first boot with a domain set)."
  value       = var.domain_name != "" ? "https://${var.domain_name}/" : "http://${var.elastic_ip}/"
}

output "ssh" {
  description = "Ready-to-run command to connect to this instance."
  value       = var.key_name != "" ? "ssh ec2-user@${var.elastic_ip}" : "aws ec2-instance-connect ssh --instance-id ${aws_instance.app.id} --os-user ec2-user --region ${var.region}"
}

output "progress_hint" {
  description = "Watch first-boot progress."
  value       = "tail -f /var/log/sunvicinity-bootstrap.log   then:   journalctl -u sunvicinity -f"
}
