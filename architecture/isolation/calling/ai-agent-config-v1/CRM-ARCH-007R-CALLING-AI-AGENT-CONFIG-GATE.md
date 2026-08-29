# CRM-ARCH-007R Calling AI agent config source gate

Status: `PASS_CONTINUE_SOURCE_GATE`

The source tip at `f61d39832252994b96f4f5aba525c125561c19f2`
implements the reviewed Calling AI agent config isolation on sealed evidence
base `62b7456391403bf5544fa69cd5533e543a56e6d0`.

Four closed `calling` v1 commands own the five legacy `AiAgentConfig` writes.
Configuration retains authorization, provider calls and key reads, validation,
silent success-marker recovery, action results and revalidation. The owner
boundary exposes no generic persistence or transaction capability.

The generic save is an ordered strict 23-field union. Credential material is
replaced by a frozen empty one-shot reference backed by an adapter-private
`WeakMap`; it is deleted on retrieval, omitted from results and logs, and
forged references are rejected. The legacy owner field name is not accepted.

The adapter contains four fixed raw writes and one exact Prisma upsert. Generic
save retains its separate existence read, insert race, DB `NOW()` and update
zero-row semantics. Saved-connection status, active-profile and extraction-tier
flows retain their caller ordering and failure policy. Omitted-column
self-assignment in the full fixed UPDATE is the explicitly accepted bounded
source drift.

Strict enforcement passes across 1,015 files and 16 contexts with 1,343 exact
findings/exceptions: 48 foreign writes, 38 provider accesses, 374 internal
imports, 530 non-public imports and 353 undeclared dependencies. Exactly five
reviewed fingerprints retire. Additions, dependency additions, shared semantic
changes and cycles are zero; the deterministic digest is
`3197e670d4b6d3a0a7a65a754577b5abc4c3399f459014a948e36fe10d1ef59b`.
The effective graph remains 106 relationships and zero cycles.

Focused checks pass 9/9, 9/9 and 10/10; parser 29/29, contract controls
143/143 and all 135 current architecture test/check scripts pass. TypeScript's
28 inherited diagnostics retain normalized hash
`2d3847300874a4cc5b419e22e9b1d4b53dc9d3d56a9576f49f2ec37b32db5245`.
Focused ESLint has zero errors and warnings.

This is a source-only technical gate. No database, provider, provider test,
server action, deployed runtime, service, deployment, production or real-secret
path was accessed or mutated.
