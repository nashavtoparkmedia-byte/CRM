# Autonomous dormant rollout handoff

The prepared future rollout template is:

    sudo PERSONAL_MAX_ISOLATED_REPORT_SHA256=cc5e55c65469cac191ad5325d8bf576c7fa3fa844a5d6287fc801475d3324afd PERSONAL_MAX_MIGRATION_REPORT_SHA256=<accepted-migration-report-sha256> /bin/bash /home/codexbot/codex-work/crm-personal-max-stage8b2-consolidated-20260728T194422Z/release/personal-max-stage8b2b-dormant-gateway/dormant-rollout.sh fabc5068c07a2e5cfc2c8c2f47d8417a52bc2a0a18c56d92b53a3f1f1fd5151d

The separately authorized rollback template is:

    sudo /bin/bash /home/codexbot/codex-work/crm-personal-max-stage8b2-consolidated-20260728T194422Z/release/personal-max-stage8b2b-dormant-gateway/dormant-rollback.sh 7dd4d63d3939ec263bbe9579d9ec5a0fc906b4a32234d5af935c0b37118b480e

Both script SHA values are exact for this package. Each root script independently hard-binds every helper, filter, Compose definition, and rollback artifact it consumes before first use; `SHA256SUMS` is a complete inventory check, not the trust root. Rollback additionally requires the installed runtime Compose file to match the hard-bound source digest and the exact Stage 8B2B labels/resources. A rollback failure produces a no-clobber `root:codexbot:0640` handoff with its original exit/phase/classification and tri-state observations; it never retries or cleans automatically. Final-delivery authority permits rollout after the production migration report is accepted and rollback on any critical failure.
