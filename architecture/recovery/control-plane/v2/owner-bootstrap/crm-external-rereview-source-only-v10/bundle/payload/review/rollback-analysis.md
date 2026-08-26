# Rollback analysis

Before any release-profile invocation, a post-`dpkg` bootstrap failure
reinstalls exact predecessor-observability package `b97642ff…` from source
`2b881128…` for profile `crm-08b9145945b2-gravity-source-v1` and proves its
wrapper, core, observer, policy, install manifest, sudoers, profile, self-check,
capabilities, audit, content-addressed store and unchanged application
provenance. The historical package `6865eab3…` is not this bootstrap's direct
rollback target. Power-loss
recovery is handled by rerunning the same checksum-pinned Owner command; the
root guard remains fail closed until exact reconciliation succeeds.

After installation, application rollback belongs only to the new finite
profile. It can first import only the exact sealed `08b91459…`
`ROLLBACK_INTENT`, then restores both the pinned Gravity `sha256:baf442f8…` predecessor
and the pinned Telegram `sha256:0849c4…` predecessor in one fixed two-service
Compose operation, keeps the database unchanged, verifies both services plus
the exact Telegram baseline file, and records terminal `ROLLED_BACK` state.
Every mixed/crash-recovery state converges to that pair rollback. The terminal
state cannot be reused to admit a different source archive.
