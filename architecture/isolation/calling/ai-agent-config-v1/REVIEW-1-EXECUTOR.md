# Review 1 — executor

Status: `PASS_WITH_SCOPE_CONFIRMED`

Source tip `f61d39832252994b96f4f5aba525c125561c19f2` implements the
reviewed Calling D4 migration. All five Configuration `AiAgentConfig` writes
cross the Calling public boundary through four exact versioned commands. The
contract and persistence port expose no Prisma client, raw SQL, transaction,
model/table/column selector, arbitrary predicate or arbitrary data capability.

The caller retains authorization, provider calls, saved-key reads, tier
validation, best-effort success-marker handling, results and revalidation. The
save path retains an empty no-op, a separate nontransactional existence read,
insert-race visibility and update zero-row success. Active-profile selection
retains truthy lookup, its exact error and Prisma upsert payload.

The generic patch is an ordered strict 23-field union. The physical credential
input becomes a frozen empty adapter reference; its value is private, deleted
on retrieval and absent from commands, results, logs, fixtures and evidence.
Forged references fail before persistence, the owner field name is rejected by
the legacy action, save results omit the credential and credential-bearing
errors are redacted.

The adapter has five analyzer-visible owner writes: four fixed raw statements
and one exact Prisma upsert. The full fixed UPDATE deliberately self-assigns
omitted columns; this accepted bounded source drift avoids dynamic SQL while
retaining DB `NOW()`, zero-row and race behavior.

Focused checks pass 9/9, 9/9 and 10/10; parser 29/29, aggregate contracts
143/143, manifests, strict enforcement and all 135 current architecture
test/check scripts pass. TypeScript retains the identical 28 inherited
diagnostics hash and focused ESLint is zero-error/zero-warning.

Strict comparison is 1,348 to 1,343 findings. Only the exact five reviewed
fingerprints retire; additions, semantic shared exception changes, dependency
additions and cycles are zero. No database, server action, deployed runtime,
provider, provider test, production or real-secret path was used.
