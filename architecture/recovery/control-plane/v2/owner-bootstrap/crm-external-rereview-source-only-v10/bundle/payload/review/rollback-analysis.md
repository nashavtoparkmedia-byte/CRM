# Rollback analysis

Before any release-profile invocation, a post-`dpkg` bootstrap failure
reinstalls exact immediate predecessor package `e8162918…` from source
`26429c49…` for profile `crm-26429c49ff80-gravity-source-v1` and proves its
wrapper, core, observer, policy, install manifest, sudoers, profile, self-check,
capabilities, audit, content-addressed store and unchanged application
provenance. Historical packages are not this bootstrap's direct rollback
target. Power-loss
recovery is handled by rerunning the same checksum-pinned Owner command; the
root guard remains fail closed until exact reconciliation succeeds.

After installation, application rollback belongs only to the new finite
profile. It never imports historical profile state as current; after a completed
preflight it restores both the pinned Gravity `sha256:baf442f8…` predecessor
and the pinned Telegram `sha256:0849c4…` predecessor in one fixed two-service
Compose operation, keeps the database unchanged, verifies both services plus
the exact Telegram baseline file, and records terminal `ROLLED_BACK` state.
Every mixed/crash-recovery state converges to that pair rollback. The terminal
state cannot be reused to admit a different source archive.
