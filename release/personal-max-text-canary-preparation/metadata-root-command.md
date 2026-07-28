# Scraper metadata root command

Status: `READY_NOT_AUTHORIZED`. This is the only root command shape carried by the preparation package. It must not be executed without a later explicit architecture authorization and independent SHA verification.

```text
sudo /bin/bash /home/codexbot/codex-work/crm-personal-max-stage8b2-consolidated-20260728T194422Z/release/personal-max-scraper-runtime-metadata/scraper-runtime-metadata.sh ab0a6249f58a02e827b407351df73ca05d3074feee621c16729b0bc68500538f
```

Expected behavior is the package's bounded, read-only, no-clobber sanitized metadata handoff. This document does not authorize that behavior. There are no migration, rollout, rollback, deploy, restart, sender, canary, browser, MAX, or provider commands in this package.
