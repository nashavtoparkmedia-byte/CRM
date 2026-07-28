# Owner handoff — rollout not authorized

The prepared future rollout template is:

    sudo PERSONAL_MAX_ISOLATED_REPORT_SHA256=<accepted-isolated-report-sha256> PERSONAL_MAX_MIGRATION_REPORT_SHA256=<accepted-migration-report-sha256> /bin/bash /opt/codex-work/crm-personal-max-stage8b2-autonomous-20260728T122700Z/release/personal-max-stage8b2b-dormant-gateway/dormant-rollout.sh b911aadacba8d3d6226dfd6b6a9e0445da02cc560d36e2be8b14984fb7dc35f5

The separately authorized rollback template is:

    sudo /bin/bash /opt/codex-work/crm-personal-max-stage8b2-autonomous-20260728T122700Z/release/personal-max-stage8b2b-dormant-gateway/dormant-rollback.sh d1260c5ad1eda416607ad87e0972d37d2cfaacb61117312a75c017e829a6f090

Both script SHA values are exact for this package. Each root script independently hard-binds every helper, filter, Compose definition, and rollback artifact it consumes before first use; `SHA256SUMS` is a complete inventory check, not the trust root. Rollback additionally requires the installed runtime Compose file to match the hard-bound source digest and the exact Stage 8B2B labels/resources. A rollback failure produces a no-clobber `root:codexbot:0640` handoff with its original exit/phase/classification and tri-state observations; it never retries or cleans automatically. Rollback still needs separate authorization. Neither command is authorized by this package.
