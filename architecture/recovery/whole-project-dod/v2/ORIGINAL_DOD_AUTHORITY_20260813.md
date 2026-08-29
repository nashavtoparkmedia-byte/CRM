# Original Definition of Done authority

This record resolves the `19 / 22 / 23` denominator ambiguity raised by the
2026-08-12 independent external re-review. It is an authority and provenance
record, not a new Definition of Done.

## Controlling source

The controlling source is the original Architecture Lead advance-authorization
execution contract:

- original path:
  `/home/codexbot/.codex/attachments/ba69e9a6-64e4-440c-9365-9b9ac60025e3/pasted-text.txt`
- captured: `2026-08-09T05:09:32.454509110Z`
- bytes: `42342`
- SHA-256:
  `0f06b9369c107f970e3ff702b4e59c78614f991fde7eaace4ffd4ae7548d1f03`
- authoritative section: `# 60. DEFINITION OF DONE — WHOLE PROJECT`
- denominator: exactly `22`

Exact authoritative text:

> The project is complete only when all materially relevant conditions are proven.
>
> 1. Each major domain has explicit owner.
>
> 2. Data ownership is formalized.
>
> 3. Foreign writes are eliminated or isolated behind an approved compatibility layer with explicit retirement plan.
>
> 4. Cross-module interactions use declared versioned contracts.
>
> 5. Provider implementations are isolated.
>
> 6. Arbitrary domain modules do not read provider credentials.
>
> 7. Critical async flows use reliable event/outbox mechanisms where justified.
>
> 8. Reporting/read models are separated from write ownership.
>
> 9. Architecture boundaries are automatically enforced.
>
> 10. Forbidden imports/writes fail CI.
>
> 11. Each major module can be developed in an isolated worktree.
>
> 12. Parallel Codex tasks do not require one shared mutable workspace.
>
> 13. Build/test pipelines are sufficiently isolated.
>
> 14. Messages remains functionally stable.
>
> 15. AI Calls active development is preserved.
>
> 16. Production remains operational through incremental migration.
>
> 17. No Big Bang cutover occurred.
>
> 18. New modules can follow a standard module template.
>
> 19. A change to Module A has a provably bounded blast radius.
>
> 20. Architecture exists in code/CI, not only documents.
>
> 21. Permanent project operator supports routine project-scoped privileged work without Owner SSH.
>
> 22. Production source/artifact authority remains traceable.

## Chronology and scope

1. The original contract above was supplied on 2026-08-09. Its section 59
   forbids silently changing the modular-monolith target, no-Big-Bang rule,
   protected-module treatment, one-owner data, versioned contracts, provider
   isolation, credential boundary, or architecture enforcement.
2. `architecture/reviews/crm-arch-007r-final/ACCEPTANCE_CHECKLIST.md` was
   committed on 2026-08-10 as a 23-checkbox CRM-ARCH-007R source-gate
   checklist. It is not a competing whole-project DoD. Its final three entries
   leave Architecture Lead source-gate acceptance, production/preview
   validation, and whole-project Owner acceptance open. The companion
   Architecture Lead review expressly scopes CRM-ARCH-007R to a foreign-write
   source gate.
3. ADR-0067 retained those open whole-project obligations. ADR-0068 then
   accepted the first external `NOT READY` verdict and explicitly retained the
   original whole-project Definition of Done. Neither ADR adds, removes, or
   rewrites an original requirement.
4. The recovery contract supplied on 2026-08-10 has SHA-256
   `f2279bbaa7793b8625e98d64d6cca2953d2eff5b2f15aa28aeab5303d7c632cc`.
   It governs recovery execution and supersedes the prior internal-ready
   operating state, but its paraphrased closure directions are not a
   replacement acceptance denominator.
5. `ORIGINAL_DOD_RECOMPUTE_20260812.json` contains 19 `FINAL-DOD-*` rows. Those
   rows are the split taxonomy of the first external review findings. They were
   never a 22-to-19 consolidation and therefore cannot be used as the original
   acceptance denominator.
6. The 2026-08-12 external re-review prompt asserted that a historical handoff
   contained 23 whole-project requirements. An exhaustive repository/history,
   attachment, and session search recovered no separate artifact with that
   title. The only recovered 23-entry artifact is the narrow source-gate
   checklist described above. The assertion is retained as provenance, but it
   cannot supersede the exact, hash-pinned original contract without the
   alleged document or its text.

## Supersession decision

The current canonical acceptance contract is the conservative union of all
requirements from sources that are demonstrated to be authoritative or
superseding. That union is the original 22 requirements: the source-gate
checklist is narrower historical evidence, the recovery contract retains the
original scope, ADR-0068 expressly retains it, and the 19-row recompute is a
review-gap ledger. No recovered authoritative source contributes a 23rd
requirement.

The machine-readable authority, source hashes, exact requirement text,
crosswalk, evidence, and current statuses are in
`ORIGINAL_DOD_CANONICAL_MAPPING.json`. A deterministic validator rejects any
denominator change, missing source ordinal, missing or multiple canonical
mapping, altered exact text/hash, duplicate canonical id, or evidence-free
canonical row.
