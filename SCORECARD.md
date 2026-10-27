# Harness scorecard

Measured 2026-10-27T03:06:57.692Z at `6d44fd15c4b8`. 20 met, 1 breached, 1 unmeasured.

| Skill | Metric | Value | Target | Status |
| --- | --- | --- | --- | --- |
| verify | `verify.main_ci_success_rate` | 1 | >= 0.95 | met |
| verify | `verify.main_ci_runs` | 6 | >= 1 | met |
| deliver | `deliver.gate_pass_rate` | 1 | >= 1 | met |
| deliver | `deliver.waiver_rate` | 0 | <= 0.2 | met |
| security-remediation | `security.oldest_open_days` | 1.13 | <= 14 | met |
| security-remediation | `security.open_critical` | 0 | <= 0 | met |
| security-remediation | `security.fixed_with_tests_rate` | 1 | >= 1 | met |
| security-remediation | `security.median_days_to_fix` | 0 | <= 7 | met |
| meridian-validate | `meridian.integration_failed` | 0 | <= 0 | met |
| meridian-validate | `meridian.phase2_fail` | 0 | <= 0 | met |
| meridian-validate | `meridian.stress_failed_presets` | 0 | <= 0 | met |
| client-onboarding | `clients.profiles_invalid` | 0 | <= 0 | met |
| client-onboarding | `clients.scenario_pass_rate` | 1 | >= 1 | met |
| client-onboarding | `clients.warnings_total` | 0 | <= 0 | met |
| steward | `steward.green_at_merge_rate` | 0.50 | >= 1 | **BREACHED** |
| steward | `steward.unresolved_threads_at_merge` | 0 | <= 0 | met |
| steward | `steward.median_hours_to_merge` | 0.27 | <= 72 | met |
| release-notes | `release.notes_passing_rate` | 1 | >= 1 | met |
| release-notes | `release.decision_prs_with_note_rate` | — | >= 1 | _unmeasured_ |
| deploy | `deploy.checks_passed_rate` | 1 | >= 1 | met |
| deploy | `deploy.time_to_healthy_ms` | 435 | <= 10000 | met |
| harness | `harness.problems` | 0 | <= 0 | met |

Definitions and targets: `tools/harness/metrics.json`. Ladder: `docs/harness/SKILLS.md`.
