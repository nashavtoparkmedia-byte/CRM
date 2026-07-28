# Owner handoff — observation not yet authorized

The future root observer is checksum-bound and read-only. It requires accepted Stage 8B2A migration evidence, accepted Stage 8B2B dormant-rollout evidence, an exact target/window, and a target-specific account scope. It obtains gateway and scraper image IDs, configured references, repository digests, source-revision labels, Docker health, restart counts, network/port/mount/user/restart-policy/Compose identity, and the exact profile-mount shape from runtime inspection; hardcoded accepted references are comparison contracts, not observed runtime values.

```bash
sudo env \
  PERSONAL_MAX_MIGRATION_REPORT_SHA256='<accepted-migration-report-sha256>' \
  PERSONAL_MAX_DORMANT_REPORT_SHA256='<accepted-dormant-rollout-report-sha256>' \
  PERSONAL_MAX_OBSERVATION_ACCOUNT_IDS='<empty-or-exact-one/two-account-ids>' \
  PERSONAL_MAX_OBSERVATION_SPOOL_LIMIT_BYTES='<active-target-only-expected-limit-or-empty>' \
  PERSONAL_MAX_OBSERVER_SHA256='a1e754f7ccde6d639c8e3df0f9624ea37f629a0c7d8deac3b998313acd91ef17' \
  PERSONAL_MAX_OBSERVER_TARGET='<dormant|default-off|one-account|ab>' \
  PERSONAL_MAX_OBSERVER_WINDOW='<5m|30m|2h|24h>' \
  /bin/bash -ceu '
observer_source=/home/codexbot/codex-work/crm-personal-max-stage8b2-consolidated-20260728T194422Z/release/personal-max-stage8b2-shadow-observation/observe-readonly.sh
snapshot=$(mktemp /var/tmp/personal-max-shadow-observer.snapshot.XXXXXXXX)
trap '"'"'rm -f -- "$snapshot"'"'"' EXIT
test -f "$observer_source"
test ! -L "$observer_source"
timeout 5 cp --no-preserve=mode,ownership -- "$observer_source" "$snapshot"
chown root:root "$snapshot"
chmod 0700 "$snapshot"
read -r observed_sha _ < <(sha256sum -- "$snapshot")
test "$observed_sha" = "$PERSONAL_MAX_OBSERVER_SHA256"
/bin/bash "$snapshot" "$PERSONAL_MAX_OBSERVER_SHA256" "$PERSONAL_MAX_OBSERVER_TARGET" "$PERSONAL_MAX_OBSERVER_WINDOW"
'
```

This is a template, not an authorized next command. Direct root execution from the codexbot-writable package path is prohibited: the outer command first copies the reviewed bytes into a root-owned `0700` snapshot, verifies the exact expected SHA on that snapshot, and executes only the snapshot. The observer rejects any other launch path or ownership. It writes only root-owned, `root:codexbot:0640` sanitized success/failure reports under `/var/tmp`, does not inspect container environment values, and does not mutate Docker or PostgreSQL. The evaluator classifies and freezes; it never performs rollback, deploy, restart, browser, MAX, or provider actions.

The accepted migration binding is intentionally `prismaDiffEmpty=false` with `prismaDiffStatus=ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS`. Replacing that accepted legacy-drift fact with a false empty-diff claim fails closed.

The supplied Stage 8B2A/8B2B report SHAs are not sufficient by themselves: the observer also requires their embedded checksum-bound script SHAs and complete sanitized evidence contracts to match exact package constants, including the PostgreSQL identity-fenced credential binding, and requires the dormant report to cross-bind the supplied migration SHA and the same isolated-proof SHA. Any mismatch produces an explicit failure report before production observation.
