# Autonomous production migration handoff

The final delivery authority accepted the successful Stage 8B1I report and authorized production migration. The checksum-bound invocation is:

    sudo PERSONAL_MAX_ISOLATED_REPORT_SHA256=cc5e55c65469cac191ad5325d8bf576c7fa3fa844a5d6287fc801475d3324afd /bin/bash /home/codexbot/codex-work/crm-personal-max-stage8b2-consolidated-20260728T194422Z/release/personal-max-stage8b2a-production-migration/production-migration.sh 4939ce5a3646cfdaa8c4cc4e42eff24712cfcc338c7622869734a92c3bd8fb43

The invocation binds the accepted isolated report and exact root script SHA. The script independently hard-binds every sourced or executed package helper/filter before first use. `SHA256SUMS` is a complete inventory check, not the trust root.
