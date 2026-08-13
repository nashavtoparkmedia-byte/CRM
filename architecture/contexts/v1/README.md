# CRM-ARCH-003 Bounded Contexts and Data Ownership

This directory defines 16 final technical bounded contexts over the 27 modules
mapped by CRM-ARCH-002. The decision input is
`context-decisions.json`; generated, schema-conforming manifests live in
`manifests/`.

Generate and validate:

```text
node tools/architecture/generate-context-manifests.mjs
node tools/architecture/validate-context-manifests.mjs
node --test tools/architecture/__tests__/context-manifests.test.mjs
```

The generator binds every one of the 96 ownership candidates to exactly one
context and gives all 195 non-owner/legacy/ambiguous write sites a reversible
migration plan. Target allowed dependencies are acyclic. Current direct imports
are retained in `dependency-transition-plan.json` as archived baseline migration debt, not
silently accepted as the target architecture.
