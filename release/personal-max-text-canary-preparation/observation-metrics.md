# Sanitized observation metrics

All labels use salted `account_hash` and `conversation_hash`; raw account IDs, conversation keys, route IDs, message text, payload bodies, contact data, credentials, and browser-profile data are forbidden.

| Metric | Meaning |
| --- | --- |
| `personal_max_owner_acquisitions_total` | New account owner fences acquired |
| `personal_max_owner_renewals_total` | Current-fence heartbeats accepted |
| `personal_max_owner_takeovers_total` | Expired/released fences replaced |
| `personal_max_stale_fence_rejects_total` | Stale/mismatched authority refused |
| `personal_max_shadow_planned_total` | Append-only shadow artifacts evaluated |
| `personal_max_shadow_refused_total` | Shadow refusals by safe reason |
| `personal_max_synthetic_boundary_calls_total` | Synthetic adapter calls; physical provider calls remain zero before canary |
| `personal_max_idempotent_duplicates_total` | Duplicate attempt/key requests returning prior outcomes |
| `personal_max_unknown_outcomes_total` | Honest unknown outcomes requiring reconciliation |
| `personal_max_wrong_account_total` | Wrong-account requests, expected zero |
| `personal_max_route_conflicts_total` | Exact route conflicts that stop canary |
| `personal_max_fifo_lag_commands` | Current immutable FIFO depth by hashed conversation |
| `personal_max_oldest_command_age_seconds` | Age only; no command content |
| `personal_max_canary_state` | Disabled, shadow, synthetic, contact-a, contact-a-b, stopped |

Reports aggregate low-cardinality safe reasons and counts. They never export fencing-token values, authentication material, nonces, raw identifiers, or text hashes that could become a message oracle.
