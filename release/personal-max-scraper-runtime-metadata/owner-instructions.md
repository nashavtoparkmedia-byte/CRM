# Owner instructions

Status: `READY_NOT_AUTHORIZED`. The probe has not been executed. Architecture approval is required before the single checksum-bound root command is used.

The owner must independently compare the published script SHA-256 with the expected value in the handoff. The script requires that SHA as its only argument, verifies itself and all package checksums, refuses an existing result path, discovers exactly one running scraper by Compose labels `crm` / `max-web-scraper`, and writes only `/var/tmp/personal-max-scraper-runtime-metadata.json` as `root:codexbot:0640`.

The command shape is:

```text
sudo /bin/bash /home/codexbot/codex-work/crm-personal-max-stage8b2-consolidated-20260728T194422Z/release/personal-max-scraper-runtime-metadata/scraper-runtime-metadata.sh <EXPECTED_SCRIPT_SHA256>
```

This command is not authorized by package preparation. Do not remove or overwrite a prior report, do not redirect output to a report, and do not run any Docker, deployment, migration, restart, browser, MAX, or provider command around it.
