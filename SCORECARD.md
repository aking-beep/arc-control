# Harness scorecard

Measured 2026-10-29T15:10:00.055Z at `09ce57634a05`. 23 met, 0 breached, 0 unmeasured.

| Skill | Metric | Value | Target | Status |
| --- | --- | --- | --- | --- |
| verify | `verify.main_ci_success_rate` | 1 | >= 0.95 | met |
| verify | `verify.main_ci_runs` | 12 | >= 1 | met |
| deliver | `deliver.gate_pass_rate` | 1 | >= 1 | met |
| deliver | `deliver.waiver_rate` | 0 | <= 0.2 | met |
| security-remediation | `security.oldest_open_days` | 0 | <= 14 | met |
| security-remediation | `security.open_critical` | 0 | <= 0 | met |
| security-remediation | `security.fixed_with_tests_rate` | 1 | >= 1 | met |
| security-remediation | `security.median_days_to_fix` | 0 | <= 7 | met |
| meridian-validate | `meridian.integration_failed` | 0 | <= 0 | met |
| meridian-validate | `meridian.phase2_fail` | 0 | <= 0 | met |
| meridian-validate | `meridian.stress_failed_presets` | 0 | <= 0 | met |
| client-onboarding | `clients.profiles_invalid` | 0 | <= 0 | met |
| client-onboarding | `clients.scenario_pass_rate` | 1 | >= 1 | met |
| client-onboarding | `clients.warnings_total` | 0 | <= 0 | met |
| steward | `steward.green_at_merge_rate` | 1 | >= 1 | met |
| steward | `steward.unresolved_threads_at_merge` | 0 | <= 0 | met |
| steward | `steward.median_hours_to_merge` | 5.85 (was 4.88) | <= 72 | met |
| release-notes | `release.notes_passing_rate` | 1 | >= 1 | met |
| release-notes | `release.decision_prs_with_note_rate` | 1 | >= 1 | met |
| deploy | `deploy.checks_passed_rate` | 1 | >= 1 | met |
| deploy | `deploy.time_to_healthy_ms` | 253 (was 436) | <= 10000 | met |
| harness | `harness.problems` | 0 | <= 0 | met |
| verify | `verify.claim_problems` | 0 | <= 0 | met |

Definitions and targets: `tools/harness/metrics.json`. Ladder: `docs/harness/SKILLS.md`.
