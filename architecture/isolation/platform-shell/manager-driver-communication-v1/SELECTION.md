# CRM-ARCH-007R manager-driver communication selection

Status: `PASS_CONTINUE_SOURCE_GATE`

Base commit: `6abb89a99984fa01d97aa335df11525a6c022a81`

Source commit: `b817a5f522c7c8ffde7bc083e33c1ae426fe6e34`

Selected the next accepted low-risk topology slice: move the five live manager
call or message logging invocations out of legacy Fleet actions and one
historical Inbox compatibility facade into Platform Shell orchestration over
two narrow Fleet Operations v1 commands.
The four browser consumers retain event propagation, state transitions and
success ordering while crossing a relative same-origin JSON endpoint.

Fleet Operations continues to own the exact `DriverDaySummary` update.
Fleet Operations owns both driver activity and the exact `CommunicationEvent` insert. Platform Shell contains
neither Prisma nor provider transport. The historical Fleet manager-call
contract and pure handler remain available, while their obsolete runtime
facade and the two legacy action functions retire. No dependency amendment is
needed because Platform Shell already has effective public dependencies on
both owners.

Strict findings decrease 1,373->1,369: the two foreign
`CommunicationEvent.create` writes and the two Risk dashboard imports that
bypassed Fleet's public surface retire. There are zero additions and zero
semantic changes among shared entries.

This is a source-only gate verified by offline analysis and isolated unit
tests. No database, provider, webhook, deployed application runtime, service,
deployment, production or secret-bearing path was accessed or mutated.
