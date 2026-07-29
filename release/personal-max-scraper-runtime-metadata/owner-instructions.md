# Owner instructions

Status: `AUTHORIZED_FOR_FINAL_DELIVERY`. The probe has not yet been executed; final-delivery authority permits the single checksum-bound root command.

The owner must independently compare the published script SHA-256 with the expected value in the handoff. The script requires that SHA as its only argument, verifies itself and all package checksums, refuses an existing result path, discovers exactly one running scraper by Compose labels `crm` / `max-web-scraper`, and writes only `/var/tmp/personal-max-scraper-runtime-metadata.json` as `root:codexbot:0640`.

The command shape is:

```text
sudo /bin/bash /home/codexbot/codex-work/crm-personal-max-stage8b2-consolidated-20260728T194422Z/release/personal-max-scraper-runtime-metadata/scraper-runtime-metadata.sh <EXPECTED_SCRIPT_SHA256>
```

Do not remove or overwrite a prior report and do not redirect output to a report. The probe remains read-only and does not deploy, migrate, restart, launch a browser, or contact MAX/provider.
