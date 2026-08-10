# CRM-ARCH-007R Calling AI agent config selection

Status: `PASS_CONTINUE_SOURCE_GATE`

Base evidence commit: `62b7456391403bf5544fa69cd5533e543a56e6d0`

Source commit: `f61d39832252994b96f4f5aba525c125561c19f2`

Selected a strict Calling owner boundary for all five Configuration-owned
`AiAgentConfig` writes. Four closed v1 commands cover generic singleton saves,
the saved-connection success marker, active-profile selection and extraction
quality selection. The generic save contract is an ordered, duplicate-free
23-field discriminated union; it exposes no physical column, arbitrary
predicate, SQL, transaction or generic data capability.

The legacy `apiKeyEncrypted` input is captured as a frozen empty opaque
reference. Its value exists only in an adapter-private `WeakMap`, is deleted on
first retrieval, never enters a command/result/log/fixture/evidence document,
and a forged empty object is rejected before persistence. The legacy action
does not accept the owner-facing `providerCredential` name, does not return the
credential and redacts credential-bearing persistence errors.

Configuration retains authorization, provider calls, reads, validation,
silent best-effort status handling, action results and revalidation. Calling
owns only persistence. The existing `configuration -> calling.public`
dependency is reused, so the amendment adds exactly four commands and no
dependency.

Strict findings decrease 1,348 to 1,343. Exactly five reviewed fingerprints
retire with zero additions, zero semantic changes to shared exceptions and
zero cycles. This selection was validated through offline source analysis and
unit/static harnesses only; no database, provider, action, runtime, production
or real-secret path was executed.
