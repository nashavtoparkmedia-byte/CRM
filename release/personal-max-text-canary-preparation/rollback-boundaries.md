# Rollback boundaries

Schema rollback is retention-aware and separately approved. The additive SessionOwner and shadow-plan tables may remain dormant; no automatic `DROP`, row deletion, fencing-token reset, or destructive down migration is allowed.

Dormant gateway rollback uses only its separately checksum-bound accepted rollback package. It must preserve production PostgreSQL, the existing scraper, profile, networks, and user-visible state.

Scraper rollback is blocked until runtime metadata proves exact current image/config/user/entrypoint/command/workdir/env-name/mount/network/health/security recreation and profile UID compatibility. Never run old and new profile owners concurrently.

Capture disable, sender disable, and canary disable are independent. Capture can return to account-scoped off without touching durable journal data. Sender disable must stop new physical boundary entries while preserving unknown outcomes for reconciliation. Canary disable clears no ledger, fence, dispatch, confirmation, or provider evidence.

An unknown outcome, route conflict, wrong-account attempt, stale-fence threshold, repeated restart, or exceeded limit triggers sender/canary disable. It never triggers blind retry or destructive database rollback.
