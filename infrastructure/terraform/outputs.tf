output "namespace" {
  description = "Namespace ARC Control was deployed into."
  value       = kubernetes_namespace_v1.arc_control.metadata[0].name
}

output "api_endpoint" {
  description = "In-cluster base URL for the control API. This is what agents call."
  value       = "http://${kubernetes_service_v1.api.metadata[0].name}.${kubernetes_namespace_v1.arc_control.metadata[0].name}.svc.cluster.local:8787"
}

output "console_endpoint" {
  description = "In-cluster base URL for the console. Expose this through something that authenticates humans."
  value       = "http://${kubernetes_service_v1.console.metadata[0].name}.${kubernetes_namespace_v1.arc_control.metadata[0].name}.svc.cluster.local:8788"
}

output "operator_token" {
  description = "The shared operator token. Held in Terraform state, so encrypt the backend."
  value       = local.operator_token
  sensitive   = true
}

output "data_volume_claim" {
  description = "Claim holding the audit chain and evidence. Back it up; it is marked prevent_destroy."
  value       = kubernetes_persistent_volume_claim_v1.data.metadata[0].name
}
