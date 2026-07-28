# Owner handoff — rollout not authorized

The prepared future rollout template is:

    sudo PERSONAL_MAX_ISOLATED_REPORT_SHA256=<accepted-isolated-report-sha256> PERSONAL_MAX_MIGRATION_REPORT_SHA256=<accepted-migration-report-sha256> /bin/bash /home/codexbot/codex-work/crm-personal-max-stage8b2-consolidated-20260728T194422Z/release/personal-max-stage8b2b-dormant-gateway/dormant-rollout.sh bc8ee9ac2012f04d66113db604ea13ce204bd3400fa6eedb7f22531be25cb6f3

The separately authorized rollback template is:

    sudo /bin/bash /home/codexbot/codex-work/crm-personal-max-stage8b2-consolidated-20260728T194422Z/release/personal-max-stage8b2b-dormant-gateway/dormant-rollback.sh 41a6e1962ae38c4946c0e2e1a82ae84dd08fae06dac934b8d2b95a3f519b2a7d

Both script SHA values are exact for this package. Each root script independently hard-binds every helper, filter, Compose definition, and rollback artifact it consumes before first use; `SHA256SUMS` is a complete inventory check, not the trust root. Rollback additionally requires the installed runtime Compose file to match the hard-bound source digest and the exact Stage 8B2B labels/resources. A rollback failure produces a no-clobber `root:codexbot:0640` handoff with its original exit/phase/classification and tri-state observations; it never retries or cleans automatically. Rollback still needs separate authorization. Neither command is authorized by this package.
