# Provider account identity — model and M1 status (v1)

**Status: PERSON / TRANSPORT SEPARATION ACCEPTED. M1 IMPLEMENTED. Provider-account
entities and account-scoped routes remain DEFERRED.** This note records the model the
repository now enforces, what M1 changed, and what a later milestone must still provide.
It is not an implementation plan for tables, migrations or backfills.

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

1. **Transport collisions are route facts.** Each ingress chain still rejects a conversation
   whose stored transport or account contradicts the incoming one, and records the evidence
   in Messaging's conversation audit (`Chat.metadata.channelIdentityCollisionAudit`, written
   by `appendConversationIdentityCollisionV1` under a row lock, bounded and de-duplicated).
   It no longer writes a Contacts person conflict for a transport or account reason.
2. **Contacts refuses transport reasons.** `markChannelIdentityConflictV1` rejects every
   transport-class reason, so no caller can record one as a person conflict.
3. **Masked person contradictions are not lost.** In the Telegram MTProto and MAX chains the
   transport or account comparison runs before the peer, sender and chat-kind comparisons.
   Callers now evaluate those later comparisons explicitly and still record a person
   conflict, with the person-level reason, when they contradict.
4. **Readers distinguish, conservatively.** Outbound preparation, reachability recording and
   the Telegram driver link ignore only an open `channel_identity_collision` entry that its
   own recorded details prove to be transport-only
   (`isProvenTransportOnlyIdentityConflictV1`). Every other open conflict — every other
   type, every person-level reason, and every historical transport entry whose details
   cannot prove that no masked comparison contradicted — keeps blocking. The identity-level
   `conflictState: 'conflicted'` flag keeps blocking unconditionally.
5. **The identity account stamp no longer gates conversations.** Messaging's contact
   conversation adapter, the platform-shell orchestrator and the Telegram driver-link
   authority no longer compare a conversation's account with the identity's first-writer
   stamp, and a missing stamp is no longer a rejection.

### Account checks that remain, because they are route safety

| Check | Why it stays |
|---|---|
| MAX ingress `provider_account_mismatch` / `provider_account_unproven` | MAX chat ids are not proven account-independent; another or unattested account may not append to or silently claim a conversation |
| Telegram `transport_connection_mismatch`, WhatsApp `transport_mismatch` / `transport_unbound` | an event may not enter a conversation through a transport it is not bound to |
| Outbound transport binding and requested-transport mismatch | a message may only leave through the conversation's bound transport |
| Live attestation: Telegram `getMe`, tg-bot account echo, MAX scraper account echo | an unattested or wrong account cannot send |
| Telegram driver-link route binding (Chat account and connection unchanged under the lock) | the proof conversation cannot be rebound between preparation and write |
| Reachability check account echo | the check must have run on the transport the operator selected |

## What a later milestone must still provide

1. **Provider-authoritative account records** owned by each channel context, persisted at
   attestation and immutable; re-pairing, token rotation or session replacement changes the
   transport, never the account.
2. **An explicit conversation route** in Messaging, keyed by account, replacing the
   first-writer `Chat.metadata.connectionId` / `providerAccountId` stamps and the globally
   unique `Chat.externalChatId`. The dormant account-scoped MAX route tables are the
   precedent to adopt or retire.
3. **Multiple transports per account as first class**, so Telegram Bot API and MTProto can
   both carry conversations with the same person without either locking the other out.
4. **Deliverability per route**, distinct from the person-level reachability summary.
5. **A controlled answer for unprovable history**: legacy conversations without transport or
   account provenance, and historical conflict entries that cannot be classified, are
   reconciled only by an explicit, audited milestone — never silently unblocked, attributed
   or deleted.
