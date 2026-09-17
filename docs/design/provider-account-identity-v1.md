# Provider account identity — model, M1 and M2A1 status (v1)

**Status: PERSON / TRANSPORT SEPARATION ACCEPTED. M1 IMPLEMENTED. COMPANY ACCOUNT MODEL
ACCEPTED (M2A1). WHATSAPP ACCOUNT FOUNDATION PERSISTED BUT INERT (M2A1-S1). Runtime account
attestation, account-scoped routes and live transport fencing remain DEFERRED.** This note
records the model the repository now enforces, what M1 and M2A1-S1 changed, and what a later
milestone must still provide. It is not an implementation plan for backfills or runtime wiring.

## The model

Two chains that must never be merged:

```
PERSON (Contact)
  └── ChannelIdentity            global per channel: (channel, provider user id)

Provider Account                 the company account, as the provider attests it
  └── Transport                  a local, swappable way to reach that account
        └── Conversation Route   one conversation carried by one account/transport
```

| Concept | Owner | Meaning | Keyed by account? |
|---|---|---|---|
| `Contact` | Contacts | the canonical person | no |
| `ChannelIdentity` (`ContactIdentity`) | Contacts | the counterparty as a channel names them | **no** |
| Provider account | channel context | the company account, attested live by the provider | — |
| Transport | channel context | bot token, MTProto session, WhatsApp connection slot, MAX web session | belongs to an account |
| Conversation route | Messaging | one conversation, bound to the transport that carries it | **yes** |

**The invariant.** A provider account, connection or transport is never evidence of who a
person is. It may select a route, attest a transport, detect a route mismatch and record
deliverability. It may not admit, reject, re-parent, merge or conflict a person.

### Why `ChannelIdentity` stays account-independent

An earlier draft of this note required `ChannelIdentity` to gain an account dimension. That
requirement is withdrawn. A Telegram user id and a WhatsApp phone JID are global provider
identifiers of the person: the same human reached through two company accounts is one
person with one channel identity. Scoping the identity by account would split one person
per company account and move the "whichever transport saw them first" problem into the
person layer. Account scope belongs to the conversation route instead. Whether MAX chat ids
are account-independent is not yet proven, so MAX keeps its account guard at conversation
scope (see below).

## Why provider-account authority was deferred

PR #81 briefly used `ContactIdentity.metadata.providerAccountId` as an admission boundary. A
read-only audit showed the stamp had no trustworthy authority on any channel:

- **WhatsApp's account value names a mutable slot, not an account.** It is
  `WhatsAppConnection.id`, an operator-minted cuid created before any pairing. A different
  real WhatsApp number can pair into the same id, and `client.info.wid.user` is written to
  `phoneNumber` on every `ready` without comparison.
- **Telegram has two transports and no canonical account.** The Bot API path reports the
  bot's own user id; the MTProto path reports the logged-in user id from a live `getMe()`.
- **MAX's stored connection value is the literal `max_scraper`** on every row, and its
  per-conversation account evidence is written by the same shared-secret webhook that
  would later claim it.

The general rule: **evidence written by the same credential that asks to be admitted cannot
authorize that admission.**

## What M1 enforces

M1's outcome: **a transport or account problem cannot become a person identity conflict and
block the person, while a genuine identity conflict stays fail-closed.**

1. **Transport collisions are route facts.** The private-conversation ingress chains (Telegram
   Bot API, Telegram MTProto, MAX, and WhatsApp live, sync and import) still reject a
   conversation whose stored transport or account contradicts the incoming one, and record the
   evidence in Messaging's conversation audit (`Chat.metadata.channelIdentityCollisionAudit`,
   written by `appendConversationIdentityCollisionV1` under a row lock, bounded and
   de-duplicated). They no longer write a Contacts person conflict for a transport or account
   reason. WhatsApp group conversations have never carried a transport check, and M1 does not add
   one.
2. **The collision fails closed on its conversation, not beyond it.** The contradicting inbound
   event is refused and audited, and the conversation is never claimed or rebound by the other
   transport. The conversation's own bound route is **not** quarantined for outbound. That is a
   deliberate decision, recorded as an owner decision in the M1 report:
   - A collision only shows that the peer was seen on another transport. That is routine once
     two company numbers or transports share a contact. Syncing a second WhatsApp connection
     alone would record one for every shared contact with history inside the three-month sync
     window.
   - WhatsApp allows one conversation per peer (`Chat.externalChatId` is unique), so blocking
     the bound route would permanently remove the person's only WhatsApp route, with no release
     path.
   - It would not catch the real hazard either: re-pairing the bound slot itself to another
     number records no collision at all.

   The person and the person's other conversations are unaffected either way.
3. **Contacts refuses transport reasons.** `markChannelIdentityConflictV1` rejects every
   transport-class reason, so no caller can record one as a person conflict.
4. **Masked person-level reasons are not lost.** In the Telegram Bot API, MTProto and MAX
   chains the transport or account comparison runs before the peer, sender and chat-kind
   comparisons. Callers now evaluate those later comparisons explicitly and still record a
   person conflict with the person-level reason. Direct genuine contradictions are recorded
   exactly as before M1.

   M2-0 narrowed this for MAX. `isPersonIdentityCollisionEvidenceV1` in Contacts is the one
   classifier, and both the MAX ingress gate and the writer use it. On MAX the stored
   conversation facts count as peer evidence only when three things hold together: the
   admission chain wrote them, it did so for the same concrete account that observed the
   event, and the chat kind is `private`. Earlier writers never stored a chat kind. Their
   sender and Contact link were last-writer values. Another account's chat id may name a
   different dialog.

   So on MAX only two cases are person conflicts: a sender contradicting proven private peer
   evidence, and group traffic into a proven private conversation. The following are route or
   admission uncertainty, and they fail only the conversation closed with a Messaging audit:
   `sender_identity_unproven`, a mismatch against legacy or other-account facts, a key collision
   (`message_chat_mismatch`, `channel_mismatch`), a sender equal to the company account, any
   deletion, and any outgoing echo, which names our own account as sender and therefore carries
   no peer evidence. Readers are unchanged, so an entry written before M2-0 still blocks.
   Production held none when M2-0 was measured.

   Known limitation, accepted for M2-0 and pinned by test. The proof is last-writer state: the
   ingress rewrites `metadata.chatKind` from every admitted event, so an event the scraper
   classified `unknown` (a cold chat cache) downgrades a stored `private` conversation. While a
   conversation sits at `unknown`, a genuine same-account sender contradiction is refused and
   audited but records no person conflict. The durable fix is to stop the patch from downgrading
   a stored concrete chat kind, which is a chatKind write change and outside M2-0.
5. **Readers distinguish, conservatively.** Outbound preparation, reachability recording and
   the Telegram driver link ignore only an open `channel_identity_collision` entry that its
   own recorded details prove to be transport-only
   (`isProvenTransportOnlyIdentityConflictV1`). Every other open conflict — every other
   type, every person-level reason, and every historical transport entry whose details
   cannot prove that no masked comparison contradicted — keeps blocking. The identity-level
   `conflictState: 'conflicted'` flag keeps blocking unconditionally. Two other readers are
   unchanged and still count any open entry, a proven transport-only historical one included:
   automatic merge policy and the contact card. Driver person confirmation reads only its own
   driver-contradiction conflict types and never counted channel collisions. No transport
   collision has been written as a person conflict since M1, so this conservatism affects
   history only.
6. **The identity account stamp no longer gates conversations or identity evidence.**
   Messaging's contact conversation adapter, the platform-shell orchestrator and the Telegram
   driver-link authority no longer compare a conversation's account with the identity's
   first-writer stamp, and a missing stamp is no longer a rejection. Contacts' provider-alias
   attachment (`attachProviderIdentityAliasV1`) no longer refuses an alias because the
   identity's stamp differs or is absent. That gate refused every production WhatsApp
   identity, all of them unstamped, and so silently skipped the conversation link,
   reachability and driver match for LID peers. It also no longer ignores another Contact's
   identity that owns the alias under a different stamp, which used to hide a genuine
   cross-person collision. Alias values are global per channel, like the identity's unique
   primary external id.

### Account checks that remain, because they are route safety

| Check | Why it stays |
|---|---|
| MAX ingress `provider_account_mismatch` / `provider_account_unproven` | MAX chat ids are not proven account-independent; another or unattested account may not append to or silently claim a conversation |
| Telegram `transport_connection_mismatch`, WhatsApp `transport_mismatch` / `transport_unbound` | an event may not enter a conversation through a transport it is not bound to |
| Outbound transport binding and requested-transport mismatch | a bound conversation may only send through its bound transport. The single-carrier fallback for a Telegram conversation with no binding applies only to rows already recorded as private; legacy rows without `chatKind` are refused as not private before it runs |
| Send-time account checks: tg-bot compares the live bot account with the requested one, MAX requires the scraper to echo the route account, and MTProto sends through the session stored on the connection row whose id is the account's `getMe` user id | a reply through these transports cannot leave from another company account. The MTProto guarantee rests on login keying the session row by account id, and no control pins that |
| Telegram driver-link route binding (Chat account and connection unchanged under the lock) | the proof conversation cannot be rebound between preparation and write |
| Reachability check account echo | a check persists only when it ran under the account it names. The contact card still passes the identity's first-writer stamp as that account, so an unstamped identity, or one stamped by another transport, never persists a check result |

## Company accounts (M2A1)

M2A1 accepted the target model for company accounts and their transports. Its first slice,
S1, persists the WhatsApp foundation with its database invariants and nothing that uses it.

### Accepted model

- **An account is not a transport, and not a person.** A company account is the provider
  account as the provider identifies it. A transport is a runtime way to act as that account:
  a WhatsApp slot and its pairing, an MTProto session, a bot process, a MAX web session.
  Neither `Contact` nor `ChannelIdentity` has a relation to an account, in either direction.
  Business modules must never target a slot id, provider account id, connection id or JID.
- **Each channel owns its own account model.** There is no generic provider-account table.
  WhatsApp Channel owns the WhatsApp account, its keys, bindings, attestation and trust, and
  the capability lease foundation. Telegram and MAX get their own models in later slices.
- **One account may have several transports.** Exclusivity is decided per capability, not per
  account: `inbound`, `outbound` and `history_import` each have at most one lease holder per
  account. The earlier "one account, one live transport" rule is not accepted.
- **Lifecycle and trust are separate axes.** Lifecycle is operator intent, stored on the
  account. Trust is attestation, stored on each transport binding. Stale is never stored: a
  binding is stale once its `attestedUntil` is at or before the database clock.
- **A WhatsApp account is identified by its provider key set, `{PN user, LID user}`,** in exact
  provider form with no `+7` or other phone normalization. An account is created only with both
  keys, a key belongs to one account forever, and a partial attestation never creates or extends
  an identity. A transport binding becomes verified only when the complete key set is attested:
  a PN or LID alone may be kept as a claim while the binding is pending, but is never attested
  evidence and never verifies it, so a re-paired number that keeps the old PN and presents a
  different LID cannot verify against the old account. Re-pairing a slot opens a new binding on a strictly newer generation. It cannot
  redefine the identity an older binding attested.
- **Lifecycle:** `pending_approval → active | rejected`, `active → disabled`,
  `disabled → active | retired`, `rejected → pending_approval`. `disabled` is the reversible
  temporary shutdown and may repeat. `retired` is terminal (owner decision OD2), and a retired
  account's provider keys stay reserved.
- **Pause, disable and delete history are three different actions.** Pausing message
  processing changes no lifecycle, trust or identity. Disabling or disconnecting an account
  deletes no chats, messages, contacts, channel identities, historical evidence or account
  identity: the same account can be re-enabled, and history sync stays available after it
  reconnects. Deleting history is a separate action and is not part of M2A1.
- **History import is its own capability.** Its modes stay: only new messages, available
  history, last N days. Reconnecting the same account imports what is available and fills gaps
  without duplicates; a repeated import is idempotent and keeps existing history. A slot paired
  to a different WhatsApp account never attaches that history to the previous account.
- **Live transport fencing is not part of S1.** The per-transport `TransportLease` is deferred.
  No runtime acquires a capability lease, so S1 fences no live WhatsApp transport.

### What S1 persists and enforces

S1 adds four tables owned by WhatsApp Channel through one expand-only migration. No existing
table, row, route or code path changes, and nothing in the runtime reads or writes the new
tables.

| Table | Holds | Database invariants |
|---|---|---|
| `WhatsAppAccount` | opaque account id, kind, lifecycle with its version, time, actor and reason | identity immutable; only the transitions above, `retired` terminal; created only with the complete key set; activation needs both keys; cannot leave `active` while a lease is held; cannot retire while a binding is open |
| `WhatsAppAccountKey` | one PN or LID value in exact provider form | one owner forever; one PN and one LID per account, with different values; never updated |
| `WhatsAppTransportBinding` | slot locator (no foreign key, so slot delete paths are unchanged), generation, per-slot sequence, trust state, attestation origin, attested PN and LID values, claimed PN and LID values, attesting instance, operator confirmation, attestation window, close reason | account, slot, generation and sequence immutable; one open binding per slot; per slot the sequence is contiguous and every new binding has a strictly greater generation; trust `pending → verified, mismatched, revoked or closed` and `verified → mismatched, revoked or closed`, with closed rows frozen; `verified` needs both attested values and is reached only by an insert or update that records a fresh attestation; attested values are recorded only as a complete pair inside an attestation, and each attested or claimed value is recorded at most once; a verified binding never carries a claim that differs from what it attested; a `transport_asserted` binding cannot become verified without operator confirmation, which is possible only for a complete claimed key set, and its attested values must equal its claim; the window only moves forward and spans at most one hour; a binding cannot close or leave `verified` while it holds a lease |
| `WhatsAppCapabilityLease` | epoch, version, holder binding and instance, state, heartbeat, lease end, quarantine end, last release | acquire, renew and takeover need an active account and an open, verified, fresh binding of that account; the first acquisition is epoch 1; each write advances version by one; epoch stays or advances by one; the holder is fixed within an epoch; a released epoch is never revived; takeover only after release or expiry and after the quarantine; a renew never shortens the granted window; a release the holder does not declare quarantines the old lease window; lease length is capped per capability (outbound 1 minute, inbound 2 minutes, history import 5 minutes) and outbound is capped at the holder's attestation window |

No row of the four tables can be removed and none of them can be truncated. Times come from
the database clock, and these history-order rules hold. A binding's attestation and
operator confirmation are never older than the binding itself: an operator confirmation is
stamped when its statement runs, and an attestation from a transaction that started before the
binding opened, or before its latest attestation, is refused. So is a claim from a transaction
that started before the binding opened, so an observation made before a re-pair cannot be
recorded on the next generation. A close is never older than the
opening, attestation or confirmation it ends. A lifecycle change from a transaction that started
before the latest lifecycle change is refused, and so is a new binding from a transaction that
started before its account was created. A lease write from a transaction that started before the
latest heartbeat is refused, and a renew never shortens a window that is already granted: ending
a lease early is a release, which quarantines the old window unless the holder declares it.
Other recorded times are not compared with each other and only affect audit timestamps: for
example a lease heartbeat is not compared with the account activation or with the holder
binding's opening or attestation, an attestation is not compared with an operator confirmation,
and an account leaving `active` is not compared with the last lease release. `attestedUntil` and
`leaseUntil` are expiries the caller requests within bounds the database enforces. The account,
binding and lease guards lock the account row first and refuse any isolation level other than
READ COMMITTED, because an older REPEATABLE READ or SERIALIZABLE snapshot would not see the write
the lock waited for. The deferred key-set check reads only keys written by the transaction that
inserts the account, which the account guard has already held to READ COMMITTED. A trigger can take the account lock only
after PostgreSQL has locked the lease or binding row being written, so the writer lock order
(account, then leases by capability, then bindings) holds only when a writer locks the account row
itself before its first lease or binding write; a bare single-statement write stays correct but
can deadlock against an ordered writer. A holder declares itself for a release by setting
`yoko.whatsapp_lease_holder` to its `holderInstanceId`, a colon and the current transaction id, so
the declaration counts only in the transaction whose id it carries, and a value left over from an
earlier transaction, including one set at session scope on a pooled connection, never counts.
The declaration is cooperative: it marks a release as made by the holder and does not
authenticate the caller.

**The persisted key-set proof.** A binding stores both attested provider values,
`attestedPnValue` and `attestedLidValue`, next to two kind columns that a CHECK fixes to
`whatsapp_pn_user` and `whatsapp_lid_user`. Each value has its own composite foreign key
`(kind, value, accountId)` to `WhatsAppAccountKey`, so the database itself proves that the PN
value is the PN key and the LID value is the LID key of the binding's own account. A wrong value
for either half, or halves that belong to different accounts, violates the foreign key of that
half. The two values are recorded only together
(`WhatsAppTransportBinding_attested_key_pair_check`), only with an attestation window, and only
by the update or insert that records that attestation, so one attestation always carries the
complete pair. A verified binding with one half missing therefore violates that pair check, which
PostgreSQL evaluates first because it checks CHECK constraints in name order, and a verified
binding with both halves missing violates `WhatsAppTransportBinding_verified_key_set_check`. Both
kind columns are `NOT NULL`, because a NULL kind would skip that half's foreign key. A binding becomes verified only by an insert or update whose attestation window is
fresh on the database clock. While a binding is pending, a pair it already holds can be carried
into a new attestation window, possibly by another attesting instance, or verified only while its
current window is still live. Once that window lapses the pair can never be carried forward or
verified; the binding can still record claims and an operator confirmation, and its only
remaining trust transitions are to `mismatched`, `revoked` or `closed`. An account's PN and LID
must be different values, so one observed value cannot fill both halves. Keys are immutable and
never removed, so the proof cannot decay after it is written.

**Name resolution.** Every function in the migration keeps the `search_path` of the migration
session (`SET search_path FROM CURRENT`), so a caller's `search_path` cannot redirect the tables,
functions or operators a guard uses. That stored path can name more than one schema:
`prisma migrate deploy` without a `schema` parameter, which is how production deploys, stores
`"$user", public`, and PostgreSQL expands `"$user"` each time a guard runs. Each guard therefore
first refuses unless the effective path is exactly the schema of the table that fired it, using
only schema-qualified built-ins for that check, so a schema named after a writing role, or any
other schema added to the path, makes every guarded write fail instead of redirecting a name.
PostgreSQL still looks relations and types up in the session temp schema first, so each guard
also checks that the foundation table names resolve to the tables in the schema of the table
that fired it, every read of a foundation table uses `FROM ONLY` so rows of a session temp child
table created with `INHERITS` are never counted, and function bodies name types only through SQL
keywords such as `TIMESTAMP WITH TIME ZONE`, which always mean the built-in types. A session temp
table, temp child table or temp type therefore cannot stand in for a guarded table, add rows to
what a guard reads, or run code inside a guard. Objects in the foundation schema itself are
trusted like the table owner: a role that can create a function or operator there can already
disable or replace the guards, so the guards do not defend against it.

**Slot generations.** Per `(transportKind, transportRef)` the trigger accepts a new binding only
if, in one statement and therefore one snapshot, its `bindingSeq` is exactly one more than the
highest existing `bindingSeq` and its `transportGeneration` is greater than the highest existing
generation, and while no binding on the slot is open. `bindingSeq` starts at 1, and
`transportGeneration` is at least 1 and only has to exceed every earlier generation on the slot.
A generation that repeats or goes down is
refused, and so is a new binding while its predecessor is still open, including a predecessor
closed by a transaction that has not yet committed. Unique indexes on
`(transportKind, transportRef, bindingSeq)` and `(transportKind, transportRef,
transportGeneration)` back this under concurrency. Two pairings for the same account are
serialized by the account row lock. Two pairings for different accounts that both read the same
history need the same `bindingSeq`, so the later one collides on the index. A successor committed
before the read raises the highest generation the new binding must exceed. The same statement also
refuses a new binding whose transaction started before the latest opening, closing or attestation
already recorded on the slot, so an observation made before a re-pair cannot open the next
generation.

`WhatsAppAccountKey` records no first attesting binding, and the binding trigger does not look
up the slot in `WhatsAppConnection`. The binding's composite foreign keys to the keys it attested
already record provenance, and reading the credential-bearing slot table would tie the inert
foundation to credential governance.

The isolated PostgreSQL suite
`gravity-mvp/src/modules/whatsapp-channel/internal/company-account/whatsapp-account-foundation.postgres.test.ts`
proves these rules with a negative case for each, including two-connection races run in both
orders, writes from older transactions, isolation levels, session state, temp-object shadowing
and guards pinned to the production migration path.

## What a later milestone must still provide

1. **Provider-authoritative account records** owned by each channel context, whose identity
   is immutable while lifecycle and trust change; re-pairing, token rotation or session
   replacement changes the transport, never the account. WhatsApp has the persisted
   foundation (M2A1-S1) but no attestation writer yet. Telegram and MAX have neither.
2. **An explicit conversation route** in Messaging, keyed by account, replacing the
   first-writer `Chat.metadata.connectionId` / `providerAccountId` stamps and the globally
   unique `Chat.externalChatId`. The dormant account-scoped MAX route tables are the
   precedent to adopt or retire.
3. **Multiple transports per account as first class**, so Telegram Bot API and MTProto can
   both carry conversations with the same person without either locking the other out. Until
   then, the two share the single `telegram:<userId>` conversation and its first-writer binding.
   If MTProto created a driver's conversation, the bot's inbound for that driver is refused and
   the bot driver actions return `DRIVER_TELEGRAM_CURRENT_AUTHORITY_REQUIRED`. The refusal is
   route-level and never a person conflict.
4. **Deliverability per route**, distinct from the person-level reachability summary.
5. **Account attestation for WhatsApp sends.** A WhatsApp connection id names a pairing slot that
   can be re-paired to another number, and neither ingress nor sending compares the live
   `client.info.wid` with the number a conversation was carried by. Until a route records its
   company account and sends verify it, a reply on a re-paired slot can leave from another
   company number. This predates M1 and no collision can detect it. M2A1-S1 does not change
   it: the account tables exist, but no send path reads them.
6. **A controlled answer for unprovable history**: legacy conversations without transport or
   account provenance, and historical conflict entries that cannot be classified, are
   reconciled only by an explicit, audited milestone — never silently unblocked, attributed
   or deleted.
