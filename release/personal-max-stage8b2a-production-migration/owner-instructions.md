# Owner handoff — not authorized in this autonomous cycle

This package is prepared but must not be run until the architect accepts a successful Stage 8B1I report and separately authorizes production migration. The checksum-bound template is:

    sudo PERSONAL_MAX_ISOLATED_REPORT_SHA256=<architect-accepted-report-sha256> /bin/bash /opt/codex-work/crm-personal-max-stage8b2-autonomous-20260728T122700Z/release/personal-max-stage8b2a-production-migration/production-migration.sh bf707cca672b350317717c2f611a371ca705fcc58c8eba8d6d0830e3715fe740

The isolated report SHA remains deliberately unresolved until proof acceptance. The owner binds the exact root script SHA; that script independently hard-binds every sourced or executed package helper/filter before first use. `SHA256SUMS` is a complete inventory check, not the trust root. This is not the next authorized command.
