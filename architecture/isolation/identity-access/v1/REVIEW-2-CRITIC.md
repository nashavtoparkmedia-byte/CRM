# CRM-ARCH-007 Identity Access review 2 — Adversarial critic

Result: `PASS_CONTINUE_SOURCE_GATE`

The critic attempted to falsify compatibility, security and isolation:

- anonymous current-user resolution remains null; the former privileged-default regression stays blocked;
- manager escalation, unknown identities, invalid roles and removal/demotion of the last privileged user remain covered by 33 unchanged tests;
- v2 identifiers, unknown fields and empty target identities fail before the owner port is invoked;
- owner failures propagate rather than being converted into false success;
- the compatibility adapter maps every existing `UserItem` field and is the only new file importing the internal user service;
- TopBar keeps reload-after-selection and redirect-after-logout behavior;
- all six prior TopBar Identity allowances are absent and no replacement finding appears;
- source scanning rises from 766 to 775 files with zero unclassified or contract-version findings;
- the full project retains 28 inherited TypeScript diagnostics with zero counted signature differences;
- inherited Work Management contract, outbox and 93 protected Calling tests remain green.

Residual scope is deliberate. This source slice does not redesign weak trusted-app authentication, signed cookies or users.json persistence, and does not deploy. Those would materially broaden security/product behavior. Other Identity consumers remain on exact expiring legacy exceptions and will migrate consumer-by-consumer. The rollback is a source revert; no schema, data or runtime rollback is needed.
