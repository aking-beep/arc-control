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

variable "oidc" {
  description = <<-EOT
    Your identity provider. Set this and operators sign in individually: the ID
    token's signature is verified against the provider's published keys, and
    roles come from a verified claim rather than from a request header. ARC
    Control then refuses the shared token outright, so a deployment cannot hold
    the door open behind its own single sign-on.

    Leave it null and the module falls back to the shared token below, which
    records every approval as assurance `claimed` — honest, and weaker than it
    reads. See docs/TRUST_MODEL.md.

    redirect_uri must be the address a *browser* reaches, and must be
    registered with the provider exactly as given. role_map translates provider
    groups into ARC Control roles; without it operators sign in with no roles
    and so can approve nothing.
  EOT

  type = object({
    issuer        = string
    client_id     = string
    client_secret = string
    redirect_uri  = string
    role_claim    = optional(string, "groups")
    role_map      = optional(map(list(string)), {})
  })

  default   = null
  sensitive = true
}

variable "public_api_base" {
  description = <<-EOT
    Where a browser reaches the API, for the sign-in redirect the console hands
    to a visitor rather than following itself.

    This is not the address the console uses: that one is a ClusterIP Service
    name, which resolves inside the cluster and nowhere else, so sending a
    browser there sends it nowhere. Required when oidc is set.
  EOT
  type        = string
  default     = null
}

variable "public_console_base" {
  description = <<-EOT
    Where people reach the console, used by notifications to say where to act
    on what they report.

    Without it a notification can say an approval is waiting but not where to
    decide it, which is most of its value.
  EOT
  type        = string
  default     = null
}

variable "session_secret" {
  description = <<-EOT
    Signs the server-side session cookie. Leave null to have one generated and
    held in state. Only used when oidc is set.

    The browser holds the session id; the session itself never leaves the
    deployment. Rotating this signs every operator out, which is the point.
  EOT
  type        = string
  default     = null
  sensitive   = true
}

variable "operator_token" {
  description = <<-EOT
    Shared operator token: one token for everyone, with identity taken from a
    request header, so anyone holding it can claim any identity. A fallback for
    a deployment with no identity provider yet, and accepted only while oidc is
    unset.

    Leave null to have one generated and held in state. Set it to "" to
    configure none at all — with neither this nor oidc, the API still governs
    agents but every operator endpoint refuses every request.

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
    Identity the console records against approvals, for the shared-token
    fallback only.

    Ignored when oidc is set, because identity then comes from the signed-in
    session and the console does not name its own operator.
  EOT
  type        = string
  default     = "operator@cluster.local"
}

variable "operator_roles" {
  description = <<-EOT
    Roles the console presents, matched against policy approver selectors. For
    the shared-token fallback only; with oidc set, roles come from the
    provider's claim via oidc.role_map.
  EOT
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
