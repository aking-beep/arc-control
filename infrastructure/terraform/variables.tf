variable "namespace" {
  description = "Namespace to deploy ARC Control into. Created by this module."
  type        = string
  default     = "arc-control"
}

variable "image" {
  description = "Container image holding the API and the console."
  type        = string
  default     = "ghcr.io/arc-transformation-group/arc-control:0.1.0"
}

variable "storage_size" {
  description = "Size of the volume holding the audit chain and evidence. It only grows."
  type        = string
  default     = "20Gi"
}

variable "storage_class" {
  description = "StorageClass for the data volume. Null uses the cluster default."
  type        = string
  default     = null
}

variable "operator_token" {
  description = <<-EOT
    Shared operator token. Leave null to have one generated and held in state.

    Operator endpoints refuse every request when this is unset, which is the
    correct default: an unauthenticated control plane is worse than none,
    because people believe it.

    Generated or supplied, the token ends up in Terraform state, so the state
    backend must be encrypted and access-controlled. Passing a reference to an
    existing secret manager is better where one is available.
  EOT
  type        = string
  default     = null
  sensitive   = true
}

variable "operator_identity" {
  description = <<-EOT
    Identity the console records against approvals.

    v0.1 does not authenticate operators individually — this is configuration,
    not a verified claim — so put an identity-aware proxy in front of the
    console. See docs/TRUST_MODEL.md.
  EOT
  type        = string
  default     = "operator@cluster.local"
}

variable "operator_roles" {
  description = "Roles the console presents, matched against policy approver selectors."
  type        = list(string)
  default     = ["finance-manager", "platform-oncall"]
}

variable "console_replicas" {
  description = "Console replicas. It is stateless, so this is free to raise."
  type        = number
  default     = 2

  validation {
    condition     = var.console_replicas >= 1
    error_message = "At least one console replica is required."
  }
}

variable "labels" {
  description = "Extra labels applied to every resource."
  type        = map(string)
  default     = {}
}
