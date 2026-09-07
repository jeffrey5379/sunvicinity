output "public_ip" {
  value = aws_instance.app.public_ip
}

output "app_url" {
  description = "Open this once the instance finishes booting (first boot ~4-6 min)."
  value       = "http://${aws_instance.app.public_ip}/sunvicinity/"
}

output "ssh" {
  value = var.key_name != "" ? "ssh ec2-user@${aws_instance.app.public_ip}" : "no key_name set — use EC2 Instance Connect from the AWS console"
}

output "progress_hint" {
  description = "Watch first-boot progress."
  value       = "tail -f /var/log/sunvicinity-bootstrap.log   then:   journalctl -u sunvicinity -f"
}
