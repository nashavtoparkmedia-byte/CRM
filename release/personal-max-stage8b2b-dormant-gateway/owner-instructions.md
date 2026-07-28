# Owner handoff — rollout not authorized

The prepared future rollout template is:

    sudo PERSONAL_MAX_ISOLATED_REPORT_SHA256=<accepted-isolated-report-sha256> PERSONAL_MAX_MIGRATION_REPORT_SHA256=<accepted-migration-report-sha256> /bin/bash /opt/codex-work/crm-personal-max-stage8b2-autonomous-20260728T122700Z/release/personal-max-stage8b2b-dormant-gateway/dormant-rollout.sh <rollout-script-sha256>

Rollback is a separate checksum-bound action and needs separate authorization. Neither command is authorized by this package. The only next candidate manual action remains the corrected Stage 8B1I isolated probe.
