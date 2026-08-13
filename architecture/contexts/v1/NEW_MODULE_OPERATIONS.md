# New module operation guide

Create a candidate only through the repository scaffold:

```sh
node tools/architecture/create-module-scaffold.mjs /tmp/crm-module customer_rewards CustomerRewards
```

The scaffold produces a complete `yoko.crm.module-manifest.v1` *candidate*,
four executable verification entrypoints, and
`architecture/contexts/v1/candidates/<id>.integration.json` plus companion
instructions. It deliberately does **not** add the candidate to the live
context index, decisions, ownership inventory, or dependency artifacts.

Move it into the repository only after the context decision, technical-module
and data ownership assignments, public contract, allowed-dependency closure,
and (where needed) foreign-write plan are reviewed together. Follow the
generated candidate integration instructions to update the decisions, index
hashes, dependency transition/final dependency artifacts, and fresh write and
credential inventories as one change.

A public `vN` facade may expose business operations and types, but it may not
import or re-export `internal/**`, Prisma, transaction handles, provider
clients, or write capabilities. Bind persistence and provider adapters from an
owner-local composition root. Declare provider imports and credential environment
names before use; values never cross the public contract.

Before review, run `node tools/architecture/test-module-scaffold.mjs`, then the
four generated commands from the candidate manifest. Also run
`node tools/architecture/test-architecture-enforcement.mjs`,
`node tools/architecture/validate-context-manifests.mjs`,
`node tools/architecture/validate-contract-registry.mjs`,
`node tools/architecture/check-typescript-baseline.mjs`, and the authoritative
write and credential inventory controls. The scaffold test instantiates the
candidate in a temporary directory, validates it against the repository
module-manifest schema equivalent, runs all generated entrypoints, and proves
private imports, foreign writes, unauthorized provider imports, and undeclared
credential environments fail.
