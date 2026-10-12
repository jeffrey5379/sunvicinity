output "instance_id" {
  value = aws_instance.app.id
}

output "public_ip" {
  value = aws_instance.app.public_ip
}

output "app_url" {
  description = "Open this once the instance finishes booting (first boot ~4-6 min)."
  value       = "http://${aws_instance.app.public_ip}/sunvicinity/"
}

output "ssh" {
  description = "Ready-to-run command to connect to this instance."
  value       = var.key_name != "" ? "ssh ec2-user@${aws_instance.app.public_ip}" : "aws ec2-instance-connect ssh --instance-id ${aws_instance.app.id} --os-user ec2-user --region ${var.region}"
}

output "progress_hint" {
  description = "Watch first-boot progress."
  value       = "tail -f /var/log/sunvicinity-bootstrap.log   then:   journalctl -u sunvicinity -f"
}
