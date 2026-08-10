# YOKO CRM Modular Architecture Transformation — Independent External Review

## Immutable review identity

- Verdict: `YOKO CRM MODULAR ARCHITECTURE TRANSFORMATION NOT READY`
- Reviewer task: `019feb29-bac2-7a51-84ff-df013bed1a93`
- Reviewer turn: `019feb29-e0e4-7d62-8116-b347afda47f5`
- Reviewer message: `msg_071c129ba3b53e1d016a79a7a1141c8191b9f3cd49e1266a26`
- Reviewer output timestamp: `2026-08-10T10:28:16.651Z`
- Exact reviewer output SHA-256 (without an added newline): `4d0f743ca44d31f634924fa0e6c5fdfa46305310e5686c58bc44d1f78e89c2f6`
- Original session JSONL: `/home/codexbot/.codex/sessions/2026/08/10/rollout-2026-08-10T10-13-28-019feb29-bac2-7a51-84ff-df013bed1a93.jsonl`
- Original session JSONL SHA-256: `210870a2aa7eb613ba4d46b2aaabaa4ee273dd2ed544296e8566ded4737dccce`
- Reviewer prompt: `/home/codexbot/.codex/attachments/e8046f09-dd43-4e17-b6f9-d5d5cf55df1d/pasted-text.txt`
- Reviewer prompt SHA-256: `11e2100a5a80c9247d51d99d1ce92bae6aa590ac4cfadcf60775a70874a18b77`
- Reviewed worktree: `/opt/codex-work/crm-arch-007r-final-hardening`
- Reviewed commit: `0b61ba296ba2734738d4a21b9d00ce8b110d63cf`
- Review mode: read-only; no tracked files changed
- Preserved at: `2026-08-10T10:54:17Z`

The text below is the complete final answer returned by the independent reviewer.

---

YOKO CRM MODULAR ARCHITECTURE TRANSFORMATION NOT READY

## Technical gap

- The `foreign writes = 0` result is a false zero. The analyzer misses delegate-cast writes such as `(prisma.chat as any).create(...)`; these remain throughout Telegram, MAX, WhatsApp, and Messaging code—for example [tg-actions.ts](/opt/codex-work/crm-arch-007r-final-hardening/gravity-mvp/src/app/tg-actions.ts:357) and [MAX webhook](/opt/codex-work/crm-arch-007r-final-hardening/gravity-mvp/src/app/api/webhook/max/route.ts:131). The parser pattern causing the miss is visible in [enforce-architecture.mjs](/opt/codex-work/crm-arch-007r-final-hardening/tools/architecture/enforce-architecture.mjs:625).

- The scan excludes `gravity-mvp/scripts` and other tracked operational surfaces through its configured roots ([policy.json](/opt/codex-work/crm-arch-007r-final-hardening/architecture/enforcement/v1/policy.json:4)). Independent inventory found 166 direct Prisma-write call lines across 47 excluded scripts, including cross-domain Driver/Task/TaskEvent writes in [import-churn-from-excel.js](/opt/codex-work/crm-arch-007r-final-hardening/gravity-mvp/scripts/import-churn-from-excel.js:102).

- Approved infrastructure writers are allowed by file/model rather than exact write site. Because enforcement checks only `file|model`, an unrelated `Chat.deleteMany` added to the approved Contacts adapter passed an isolated negative probe ([policy.json](/opt/codex-work/crm-arch-007r-final-hardening/architecture/enforcement/v1/policy.json:37), [enforcer](/opt/codex-work/crm-arch-007r-final-hardening/tools/architecture/enforce-architecture.mjs:1060)).

- Credential enforcement checks environment-variable names only; it does not govern database credential reads ([enforce-architecture.mjs](/opt/codex-work/crm-arch-007r-final-hardening/tools/architecture/enforce-architecture.mjs:1049)). Messaging directly reads Calling-owned `AiAgentConfig.apiKeyEncrypted` and passes it to an LLM ([improve-draft-actions.ts](/opt/codex-work/crm-arch-007r-final-hardening/gravity-mvp/src/app/messages/improve-draft-actions.ts:22)). A production-scanned debug endpoint also returns complete `WhatsAppConnection` rows, including `sessionData` ([route.ts](/opt/codex-work/crm-arch-007r-final-hardening/gravity-mvp/src/app/api/debug-db/list-connections/route.ts:4), [schema.prisma](/opt/codex-work/crm-arch-007r-final-hardening/gravity-mvp/prisma/schema.prisma:95)).

- The architecture candidate is not reconciled with protected Messages production authority. The baseline explicitly says the architecture substrate is not complete production source and Messages remains a per-file production composite ([authoritative-baseline.json](/opt/codex-work/crm-arch-007r-final-hardening/architecture/baseline/v1/authoritative-baseline.json:5), [Messages authority](/opt/codex-work/crm-arch-007r-final-hardening/architecture/baseline/v1/authoritative-baseline.json:215)). Candidate WhatsApp code still publishes runtime maps globally only outside production ([candidate](/opt/codex-work/crm-arch-007r-final-hardening/gravity-mvp/src/lib/whatsapp/WhatsAppService.ts:24)), while authoritative production contains the required always-global behavior and other recovery fixes ([production](/opt/crm/gravity-mvp/src/lib/whatsapp/WhatsAppService.ts:24)). Deploying the candidate as-is would discard known production behavior.

## Production/deployment gap

- The candidate is explicitly source-only and undeployed ([AUTHORITATIVE_SOURCE_MAP.json](/opt/codex-work/crm-arch-007r-final-hardening/architecture/reviews/crm-arch-007r-final/AUTHORITATIVE_SOURCE_MAP.json:16)). The production ledger records zero deployments, database mutations, rollbacks, or service operations ([PRODUCTION_CHANGE_LEDGER.json](/opt/codex-work/crm-architecture-state/PRODUCTION_CHANGE_LEDGER.json:4)). No remote-tracking, integration, release branch, or tag contains review commit `0b61ba296ba2734738d4a21b9d00ce8b110d63cf`.

- The transactional outbox remains inactive. Preview PostgreSQL execution, production database identity, backup, rollback target, and health gates are pending ([production-activation-gate.json](/opt/codex-work/crm-arch-007r-final-hardening/architecture/events/v1/production-activation-gate.json:4)).

- The privileged runtime has no enabled release-activation, configuration-activation, database-migration, or rollback profiles ([policy.v2.json](/usr/local/share/yoko-privileged-runtime/policy.v2.json:129)). Therefore the declared finite ABI cannot yet perform the required incremental release safely.

## Architecture gap

- `1295/1295 PASS` means 1,295 live violations are exactly exception-covered—not that boundaries are satisfied: 374 internal imports, 530 non-public cross-context imports, 353 undeclared dependencies, and 38 direct provider-transport accesses ([verification.json](/opt/codex-work/crm-arch-007r-final-hardening/architecture/reviews/crm-arch-007r-final/verification.json:13)). These directly contradict the required public-contract and provider-isolation Definition of Done.

- Provider leakage remains operational code, for example Messaging directly loading WhatsApp and MAX transport actions in [MessageService.ts](/opt/codex-work/crm-arch-007r-final-hardening/gravity-mvp/src/lib/MessageService.ts:623).

- Contract and blast-radius metadata are incomplete. The central contract registry still contains only two Work Management entries ([registry.json](/opt/codex-work/crm-arch-007r-final-hardening/architecture/contracts/v1/registry.json:10)); module manifests contain no owned build/test mapping ([module-manifest.schema.json](/opt/codex-work/crm-arch-007r-final-hardening/architecture/contexts/v1/module-manifest.schema.json:6)); and CI omits most later CRM-ARCH-007R/MAX/WA/TG successor controls ([architecture-enforcement.yml](/opt/codex-work/crm-arch-007r-final-hardening/.github/workflows/architecture-enforcement.yml:44)).

## Evidence gap

- The `80/80`, `64/64`, and `1614/1614` checksums reproduce, but they seal a selected source-gate package whose analyzer has the coverage and parser defects above. They do not establish complete repository ownership or deployed behavior.

- The advertised source identity is split: `02468059…` is the last application-source commit, but at that commit the registry still contained 48 foreign-write findings. The zero-write registry was committed later; only the complete `0b61ba29…` tree reproduces the final enforcement state. The source map does not make `02468059…` a standalone reproducer ([AUTHORITATIVE_SOURCE_MAP.json](/opt/codex-work/crm-arch-007r-final-hardening/architecture/reviews/crm-arch-007r-final/AUTHORITATIVE_SOURCE_MAP.json:23)).

- Messages evidence never exercised provider transports, webhooks, database behavior, or deployed services. The final checklist itself leaves deployment and whole-project acceptance open ([ACCEPTANCE_CHECKLIST.md](/opt/codex-work/crm-arch-007r-final-hardening/architecture/reviews/crm-arch-007r-final/ACCEPTANCE_CHECKLIST.md:23)).

- Privileged-runtime evidence seals version `2.0.0-3`, while the installed runtime is `2.0.0-5`; CRM-ARCH-007R explicitly did not refresh runtime observation ([CONTROL_PLANE_VERIFICATION.json](/opt/codex-work/crm-arch-000-evidence/crm-arch-000r/20260809T123041Z-v2-live-reconciliation/CONTROL_PLANE_VERIFICATION.json:5), [source map](/opt/codex-work/crm-arch-007r-final-hardening/architecture/reviews/crm-arch-007r-final/AUTHORITATIVE_SOURCE_MAP.json:14)).

## Business decision

- The Architecture Lead/Owner must choose between accepting only the narrower CRM-ARCH-007R foreign-write source milestone or retaining the original complete modular-transformation Definition of Done. The durable decision record explicitly separated the 1,295 remaining boundary violations, deployment, and Owner acceptance into future work ([ADR-0067](/opt/codex-work/crm-architecture-state/ARCHITECTURE_DECISIONS.md:842)). Under the original Definition of Done, Owner acceptance is not supportable.
