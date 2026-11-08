# Communication Workspace Core V1: Отток as the first host

Status: the first vertical slice is built and tested. It is waiting for Owner Preview (:3002 candidate queue) and for an architecture decision on context placement (see the last section).

## What a module says, and what Communication Workspace does

The business module says **who and why**: the host integration contract `communication-workspace.HostAudienceSubmission.v1`. Each member carries:

- a canonical `contactId`;
- a reason;
- a `sourceRef`;
- an immutable business context.

The snapshot carries one `snapshotRef`, plus the trigger key and version. No chat, provider, phone, account or route crosses the contract. Документы plugs in the same way: its own trigger, then the same submission.

Communication Workspace decides **what scenario to run**. Messaging and Calling perform the effects through their own contracts.

| Owner | Owns, in this slice |
|---|---|
| Отток (Fleet) | `fleet.churn.no_orders_days` v1: `Driver.lastOrderAt` ≥ N days ago, not dismissed; drivers without a Contact are reported, not hidden |
| Contacts | canonical Contact, lineage, global permission (`message`, `voice`); deny wins |
| Messaging | `SendToContact` (the requestId identity, at most one provider effect) |
| Calling | the call effect. Main has no public "call this Contact" contract yet: the call is a provider-neutral port, simulated; live answers `unavailable` |
| Communication Workspace | projects, Flow, Run, audience snapshot, admission, execution, waits, suppression and cooldown, audit trail, reporting |

## Flow V1 (the same engine in Sandbox and live)

1. The trigger is evaluated on the server, never taken from the client.
2. An audience snapshot is taken. Admission runs in a fixed order:
   1. duplicate in the snapshot;
   2. the Sandbox allowlist;
   3. Contacts permission;
   4. the same person under two ids;
   5. project policy, which can only narrow;
   6. the cross-project guard: one active participation per Contact and scope, then a cooldown.
3. A Run and a ParticipantExecution are created. There is one Run per snapshot (idempotency key) and one execution per canonical Contact per Run.
4. Permission is read again, then the message is sent through SendToContact. The requestId `cw-<participant>-message-1` is permanent.
5. Wait for a reply. A Sandbox may replace the wait.
6. A reply stops all further automatic contact. Reply evidence is also checked right before the call.
7. No reply: if the Flow and the project policy allow a call, the voice permission is read again, then the call is requested. Its requestId `cw-<participant>-call-1` is permanent.
8. Outcome, guard release with cooldown, audit events, report.

**An unknown provider outcome** (message or call) ends in `needs_review`. It is never resent or redialled. Missing reply evidence never leads to a call.

**Workers** lease due executions (`FOR UPDATE SKIP LOCKED`). They move an execution only from the version they read, and they write its audit events and guard release in the same transaction. A worker that dies is replaced after its lease expires. The repeated effect request reuses the same requestId, so there is no second effect.

## Sandbox = a mode, not a product

- **Same core.** The test configuration only narrows and accelerates: an allowlist of up to 20 test Contacts, shorter waits and cooldowns, and deterministic simulated provider outcomes.
- **Allowlist enforced twice.** Admission enforces it, and so does the effects boundary, right before any effect is requested.
- **No live effects by default.** Effects are **simulated** unless `COMMUNICATION_WORKSPACE_EFFECTS` is exactly `live`. Simulated effects are recorded once per requestId in the Run's own audit trail and never reach a provider. The Preview (`preview.env`) does not set the variable, so no message or call can leave :3002, including from background jobs or retries.
- **Live Runs refused.** A live Run is refused while effects are simulated.

## Reporting = the execution evidence

The metrics and drill-down come only from the Run's audience, executions and audit events:

- matched, excluded (per reason), admitted;
- messages requested and accepted;
- replied, waiting, moved to a call, call outcomes;
- failed, needs review, completed;
- outcomes.

**Delivered and read** show "—" unless a provider proved them. They are never shown as 0 or invented.

**Drill-down** goes Metric → Contacts → Contact → full timeline, with every decision and its reason.

## Owner walkthrough (CRM :3002, candidate slot)

1. Open **Отток** (`/analytics/churn`). The banner reads «Режим исполнения: симуляция». The trigger "не выполнял заказы ≥ 5 дней" lists the demo drivers «Отток: … (демо)». The driver active 2 days ago is not in the list.
2. Tick five test Contacts:
   - «ответит» and «не ответит»: leave «Сообщение принято»;
   - «не ответит»: set «Звонок: не ответит»;
   - «исход отправки неизвестен»: set «Исход неизвестен»;
   - «не беспокоить» and «уже в «Документах»».

   Leave «не тестовый» unticked. Waiting ≈ 20 s. Press **Запустить в Sandbox**. Pressing it twice gives the same Run.
3. On the Run page, keep «Автоматически» on.
   - Expected: matched 6; excluded 3 (Не беспокоить, Уже в другом сценарии, Не тестовый контакт); admitted 3.
   - Messages: requested 3, accepted 2. «исход неизвестен» goes to «Нужна проверка» and is not resent.
4. While «ответит» is waiting, press **Симулировать ответ** for it. That Contact ends «Ответил». No call is made, and the timeline says so.
5. After about 20 s, «не ответит» moves to the call and ends «Звонок: не ответил».
6. Click any metric to see the Contacts behind it. Click a Contact for its full timeline: trigger, admission, permission rechecks, message request, simulation, wait, reply or call, outcome.

## Future batch release (not deployed; no production action taken)

- **Migration:** `20261108190000_add_communication_workspace_core`, expand-only and source-only. It adds six new tables with CHECK vocabularies and touches no existing object. Rollback before use: drop the six tables, since no other table references them.
- **Runtime dependencies:**
  - Contacts' permission query, which needs production migration `20261007180000` applied;
  - Messaging SendToContact (#183), which needs `20261027090000`;
  - the Prisma client.

  There is no new service, queue, cron or credential.
- **Activation / OFF state:**
  - Effects are simulated by default, so production stays OFF for real effects until `COMMUNICATION_WORKSPACE_EFFECTS=live` is set deliberately.
  - Live Runs are refused until then.
  - The pages need the integration-admin session.
  - Steps advance only while a Run page is open (manual or auto stepping); there is no unattended worker yet.
- **Security:**
  - Server actions re-check the integration-admin session.
  - The audience is always re-evaluated on the server.
  - No client-supplied people.
  - No provider ids in the contracts.
  - Contacts DND and voice/message restrictions are re-read before every physical action.
- **Live E2E remaining:**
  - bind the Calling contract once C4 lands;
  - bind reply evidence from Messaging (a read query) so live no-reply branching is possible; without it, live branching stops at `needs_review`, never calls;
  - an unattended worker trigger (cron route).
- **Recovery:** all state is in the six tables. A restart resumes from leases and versions. `needs_review` rows are listed per Run for a person to decide.

## Open architecture decision

Mandate 12 gives Communication Workspace its own ownership, so the slice is written as its own module (`src/modules/communication-workspace`, `src/contracts/communication-workspace`).

Making it a 17th bounded context means extending the sealed 2026-08-09 baseline evidence: `module-inventory.json` and `data-ownership-candidates.json`, sealed by `architecture/evidence/v1/SHA256SUMS` and a source-snapshot digest. Alternatively, the tooling needs an amendment mechanism for new contexts. Both need the architect or Product Curator.

The alternative supported today is a technical module under an existing context through an isolation amendment. That blurs the approved CW / Messaging split.
