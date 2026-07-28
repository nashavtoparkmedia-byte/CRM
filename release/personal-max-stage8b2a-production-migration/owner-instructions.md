# Owner handoff — not authorized in this autonomous cycle

This package is prepared but must not be run until the architect accepts a successful Stage 8B1I report and separately authorizes production migration. The checksum-bound template is:

    sudo PERSONAL_MAX_ISOLATED_REPORT_SHA256=<architect-accepted-report-sha256> /bin/bash /home/codexbot/codex-work/crm-personal-max-stage8b2-consolidated-20260728T194422Z/release/personal-max-stage8b2a-production-migration/production-migration.sh f054d48ab8b5a93911057c9a9dd6123c48fc91720dd50dcb32c833d3718b9560

The isolated report SHA remains deliberately unresolved until proof acceptance. The owner binds the exact root script SHA; that script independently hard-binds every sourced or executed package helper/filter before first use. `SHA256SUMS` is a complete inventory check, not the trust root. This is not the next authorized command.
