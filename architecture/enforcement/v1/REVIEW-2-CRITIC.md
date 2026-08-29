# CRM-ARCH-006 Internal Review 2 — Adversarial Critic

Result: `PASS_CONTINUE_SOURCE_GATE`

The critic attempted to admit new debt, reuse old allowances and weaken high-value rules:

- a finding with no exception fails;
- a removed finding leaves a stale exception and fails, preventing latent reintroduction capacity;
- expired, duplicate, malformed and identity-mismatched exceptions fail;
- manifest drift, dependency cycles, unresolved/unclassified source and contract-version violations cannot be excepted;
- a changed finding set fails the signed registry digest even if counts happen to match;
- direct provider SDK use and imports of provider-path modules are checked separately;
- comments and string examples do not create findings, while executable code following nested templates remains visible;
- foreign model writes, raw SQL, internal imports, non-public imports, undeclared dependencies, credential access and provider transport all have mutation fixtures;
- the five supplemental write sites must continue to resolve to the same exact current findings;
- registry generation refuses unexceptionable rules and unreviewed finding categories.

Residual limitations are explicit. This is a static source gate, not proof of runtime request behavior. It recognizes literal static/require/dynamic import specifiers and the repository's Prisma call forms; generated code and test/build outputs are intentionally excluded. The current repository has no production non-literal dynamic import. Any scanner extension changes fingerprints and therefore forces a reviewed registry regeneration rather than silently inheriting old capacity.

Inherited behavior remains stable: 11 contract tests, 16 outbox tests, 14 contract controls, 14 outbox controls and 93 protected Calling tests pass. Project TypeScript remains at the inherited 28 diagnostics with identical counted file/line/code signatures and zero new diagnostics. No production, runtime, database, deployment or protected-worktree mutation occurred.
