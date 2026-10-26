# ARC Control on Kubernetes.
#
# This module deploys the same shape as infrastructure/kubernetes, for teams
# whose clusters are managed with Terraform. The API is a single replica with
# a ReadWriteOnce volume because the v0.1 store is single-node: two writers on
# one volume would interleave appends and fork the audit hash chain.
#
# What this module deliberately does NOT do: decide which pods may reach which
# systems. That is the control which makes ARC Control's guarantee true — if an
# agent can reach Stripe directly, policy and evidence are decoration — and it
# depends on how the cluster is segmented. See
# infrastructure/kubernetes/networkpolicy.yaml for the shape it needs to take.

locals {
  name = "arc-control"

  common_labels = merge(
    {
      "app.kubernetes.io/name"    = local.name
      "app.kubernetes.io/part-of" = local.name
      "app.kubernetes.io/version" = "0.1.0"
    },
    var.labels,
  )

  api_labels     = merge(local.common_labels, { "app.kubernetes.io/component" = "api" })
  console_labels = merge(local.common_labels, { "app.kubernetes.io/component" = "console" })

  sso_enabled = var.oidc != null

  # The fallback token. Only generated where it can still be used: with single
  # sign-on configured the API refuses it, so minting one would put a live
  # credential in Terraform state to no purpose.
  operator_token = local.sso_enabled ? "" : coalesce(var.operator_token, random_password.operator_token.result)

  session_secret = local.sso_enabled ? coalesce(var.session_secret, random_password.session_secret.result) : ""

  # Provider groups to ARC Control roles, in the form the API parses:
  #   arc-finance=finance-manager|approver,arc-admin=admin
  role_map = local.sso_enabled ? join(",", [
    for group, roles in var.oidc.role_map : "${group}=${join("|", roles)}"
  ]) : ""
}

resource "random_password" "operator_token" {
  length  = 64
  special = false
}

resource "random_password" "session_secret" {
  length  = 64
  special = false
}

resource "kubernetes_namespace_v1" "arc_control" {
  metadata {
    name = var.namespace

    labels = merge(local.common_labels, {
      # The control plane decides whether agent actions happen, so it should
      # not share a namespace with the agents it governs.
      "pod-security.kubernetes.io/enforce" = "restricted"
      "pod-security.kubernetes.io/audit"   = "restricted"
      "pod-security.kubernetes.io/warn"    = "restricted"
    })
  }
}

resource "kubernetes_secret_v1" "operator" {
  metadata {
    name      = "${local.name}-operator"
    namespace = kubernetes_namespace_v1.arc_control.metadata[0].name
    labels    = local.common_labels
  }

  data = {
    "operator-token"     = local.operator_token
    "session-secret"     = local.session_secret
    "oidc-client-secret" = local.sso_enabled ? var.oidc.client_secret : ""
  }

  type = "Opaque"

  lifecycle {
    # Caught at plan time rather than by an operator staring at a sign-in page
    # that will not load. The console redirects a visitor with no session to
    # the API, and the address it uses itself is a ClusterIP name a browser
    # cannot resolve.
    precondition {
      condition     = var.oidc == null || var.public_api_base != null
      error_message = "public_api_base is required when oidc is set: it is the API address a browser reaches, and the sign-in redirect goes there."
    }

    # Roles are what approver selectors match. Sign everyone in with none and
    # the approval queue is unanswerable.
    precondition {
      condition     = var.oidc == null || length(var.oidc.role_map) > 0
      error_message = "oidc.role_map is empty, so every operator would sign in with no roles and could approve nothing."
    }
  }
}

resource "kubernetes_persistent_volume_claim_v1" "data" {
  metadata {
    name      = "${local.name}-data"
    namespace = kubernetes_namespace_v1.arc_control.metadata[0].name
    labels    = merge(local.common_labels, { "app.kubernetes.io/component" = "storage" })
  }

  spec {
    access_modes       = ["ReadWriteOnce"]
    storage_class_name = var.storage_class

    resources {
      requests = {
        storage = var.storage_size
      }
    }
  }

  # The audit chain and every evidence record live here. Terraform destroying
  # this claim destroys the record, so deletion is a deliberate act.
  lifecycle {
    prevent_destroy = true
  }
}

resource "kubernetes_deployment_v1" "api" {
  metadata {
    name      = "${local.name}-api"
    namespace = kubernetes_namespace_v1.arc_control.metadata[0].name
    labels    = local.api_labels
  }

  spec {
    # Exactly one. The v0.1 store is single-node; see the module comment.
    replicas = 1

    strategy {
      # A rolling update would briefly run two pods against the same
      # ReadWriteOnce volume.
      type = "Recreate"
    }

    selector {
      match_labels = {
        "app.kubernetes.io/name"      = local.name
        "app.kubernetes.io/component" = "api"
      }
    }

    template {
      metadata {
        labels = local.api_labels
      }

      spec {
        security_context {
          run_as_non_root = true
          run_as_user     = 1000
          run_as_group    = 1000
          fs_group        = 1000

          seccomp_profile {
            type = "RuntimeDefault"
          }
        }

        container {
          name    = "api"
          image   = var.image
          command = ["node", "apps/control-api/dist/main.js"]

          port {
            name           = "http"
            container_port = 8787
          }

          env {
            name  = "ARC_HOST"
            value = "0.0.0.0"
          }

          env {
            name  = "ARC_PORT"
            value = "8787"
          }

          env {
            name  = "ARC_DATA_DIR"
            value = "/var/lib/arc-control"
          }

          env {
            name  = "ARC_CONSOLE_URL"
            value = coalesce(var.public_console_base, "")
          }

          # Assessments, approval expiry and sweeps run unattended. Without
          # this an approval queue can rot with nobody told.
          env {
            name  = "ARC_SCHEDULE"
            value = "true"
          }

          # Single sign-on, when configured. Empty reads as unset, so the
          # fallback below stays in force until all of these are set.
          env {
            name  = "ARC_OIDC_ISSUER"
            value = local.sso_enabled ? var.oidc.issuer : ""
          }

          env {
            name  = "ARC_OIDC_CLIENT_ID"
            value = local.sso_enabled ? var.oidc.client_id : ""
          }

          env {
            name  = "ARC_OIDC_REDIRECT_URI"
            value = local.sso_enabled ? var.oidc.redirect_uri : ""
          }

          env {
            name  = "ARC_OIDC_ROLE_CLAIM"
            value = local.sso_enabled ? var.oidc.role_claim : ""
          }

          env {
            name  = "ARC_OIDC_ROLE_MAP"
            value = local.role_map
          }

          env {
            name = "ARC_OIDC_CLIENT_SECRET"

            value_from {
              secret_key_ref {
                name = kubernetes_secret_v1.operator.metadata[0].name
                key  = "oidc-client-secret"
              }
            }
          }

          env {
            name = "ARC_SESSION_SECRET"

            value_from {
              secret_key_ref {
                name = kubernetes_secret_v1.operator.metadata[0].name
                key  = "session-secret"
              }
            }
          }

          # Terminate TLS in front of the Service. The session cookie is then
          # never sent in clear.
          env {
            name  = "ARC_SECURE_COOKIES"
            value = "true"
          }

          # The fallback. Accepted only while single sign-on is unset, and
          # empty here whenever it is set.
          env {
            name = "ARC_OPERATOR_TOKEN"

            value_from {
              secret_key_ref {
                name = kubernetes_secret_v1.operator.metadata[0].name
                key  = "operator-token"
              }
            }
          }

          volume_mount {
            name       = "data"
            mount_path = "/var/lib/arc-control"
          }

          readiness_probe {
            http_get {
              path = "/health"
              port = "http"
            }

            initial_delay_seconds = 3
            period_seconds        = 10
          }

          liveness_probe {
            http_get {
              path = "/health"
              port = "http"
            }

            initial_delay_seconds = 10
            period_seconds        = 30
          }

          resources {
            requests = {
              cpu    = "100m"
              memory = "128Mi"
            }

            limits = {
              cpu    = "1"
              memory = "512Mi"
            }
          }

          security_context {
            allow_privilege_escalation = false
            read_only_root_filesystem  = true

            capabilities {
              drop = ["ALL"]
            }
          }
        }

        volume {
          name = "data"

          persistent_volume_claim {
            claim_name = kubernetes_persistent_volume_claim_v1.data.metadata[0].name
          }
        }

        # Long enough for the SIGTERM handler to close the listener and flush.
        termination_grace_period_seconds = 30
      }
    }
  }
}

resource "kubernetes_service_v1" "api" {
  metadata {
    name      = "${local.name}-api"
    namespace = kubernetes_namespace_v1.arc_control.metadata[0].name
    labels    = local.api_labels
  }

  spec {
    type = "ClusterIP"

    selector = {
      "app.kubernetes.io/name"      = local.name
      "app.kubernetes.io/component" = "api"
    }

    port {
      name        = "http"
      port        = 8787
      target_port = "http"
    }
  }
}

resource "kubernetes_deployment_v1" "console" {
  metadata {
    name      = "${local.name}-console"
    namespace = kubernetes_namespace_v1.arc_control.metadata[0].name
    labels    = local.console_labels
  }

  spec {
    # The console holds no state of its own — it reads everything through the
    # API with the operator credential — so it scales freely.
    replicas = var.console_replicas

    selector {
      match_labels = {
        "app.kubernetes.io/name"      = local.name
        "app.kubernetes.io/component" = "console"
      }
    }

    template {
      metadata {
        labels = local.console_labels
      }

      spec {
        security_context {
          run_as_non_root = true
          run_as_user     = 1000
          run_as_group    = 1000

          seccomp_profile {
            type = "RuntimeDefault"
          }
        }

        container {
          name    = "console"
          image   = var.image
          command = ["node", "apps/control-console/dist/main.js"]

          port {
            name           = "http"
            container_port = 8788
          }

          env {
            name  = "ARC_CONSOLE_HOST"
            value = "0.0.0.0"
          }

          env {
            name  = "ARC_CONSOLE_PORT"
            value = "8788"
          }

          env {
            name  = "ARC_API_BASE"
            value = "http://${kubernetes_service_v1.api.metadata[0].name}:8787"
          }

          # Where a browser reaches the API, for the sign-in redirect. Not the
          # Service name above: send a visitor to a ClusterIP and you send
          # them nowhere.
          env {
            name  = "ARC_PUBLIC_API_BASE"
            value = coalesce(var.public_api_base, "")
          }

          # Under single sign-on the console carries no credential of its own:
          # it forwards the visitor's session, asks the API who that is, and
          # shows that answer, so the name on an approval is the one the API
          # verified. These three are the fallback path, and are empty
          # whenever single sign-on is configured.
          env {
            name  = "ARC_OPERATOR_TOKEN"
            value = local.sso_enabled ? "" : local.operator_token
          }

          env {
            name  = "ARC_OPERATOR_IDENTITY"
            value = local.sso_enabled ? "" : var.operator_identity
          }

          env {
            name  = "ARC_OPERATOR_ROLES"
            value = local.sso_enabled ? "" : join(",", var.operator_roles)
          }

          readiness_probe {
            http_get {
              path = "/healthz"
              port = "http"
            }

            initial_delay_seconds = 3
            period_seconds        = 10
          }

          resources {
            requests = {
              cpu    = "50m"
              memory = "96Mi"
            }

            limits = {
              cpu    = "500m"
              memory = "256Mi"
            }
          }

          security_context {
            allow_privilege_escalation = false
            read_only_root_filesystem  = true

            capabilities {
              drop = ["ALL"]
            }
          }
        }
      }
    }
  }
}

resource "kubernetes_service_v1" "console" {
  metadata {
    name      = "${local.name}-console"
    namespace = kubernetes_namespace_v1.arc_control.metadata[0].name
    labels    = local.console_labels
  }

  spec {
    type = "ClusterIP"

    selector = {
      "app.kubernetes.io/name"      = local.name
      "app.kubernetes.io/component" = "console"
    }

    port {
      name        = "http"
      port        = 8788
      target_port = "http"
    }
  }
}
