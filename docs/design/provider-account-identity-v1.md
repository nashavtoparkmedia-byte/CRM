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
   exactly as before M1. The person-level reasons include MAX `sender_identity_unproven`:
   missing sender proof on a person-linked conversation, which is a gap in identity evidence
   rather than a contradiction. It stayed person-level, as it was before M1.
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
6. **The identity account stamp no longer gates conversations.** Messaging's contact
   conversation adapter, the platform-shell orchestrator and the Telegram driver-link
   authority no longer compare a conversation's account with the identity's first-writer
   stamp, and a missing stamp is no longer a rejection.

### Account checks that remain, because they are route safety

| Check | Why it stays |
|---|---|
| MAX ingress `provider_account_mismatch` / `provider_account_unproven` | MAX chat ids are not proven account-independent; another or unattested account may not append to or silently claim a conversation |
| Telegram `transport_connection_mismatch`, WhatsApp `transport_mismatch` / `transport_unbound` | an event may not enter a conversation through a transport it is not bound to |
| Outbound transport binding and requested-transport mismatch | a bound conversation may only send through its bound transport. The single-carrier fallback for a Telegram conversation with no binding applies only to rows already recorded as private; legacy rows without `chatKind` are refused as not private before it runs |
| Send-time account checks: tg-bot compares the live bot account with the requested one, MAX requires the scraper to echo the route account, and MTProto sends through the session stored on the connection row whose id is the account's `getMe` user id | a reply through these transports cannot leave from another company account. The MTProto guarantee rests on login keying the session row by account id, and no control pins that |
| Telegram driver-link route binding (Chat account and connection unchanged under the lock) | the proof conversation cannot be rebound between preparation and write |
| Reachability check account echo | a check persists only when it ran under the account it names. The contact card still passes the identity's first-writer stamp as that account, so an unstamped identity, or one stamped by another transport, never persists a check result |

## What a later milestone must still provide

1. **Provider-authoritative account records** owned by each channel context, persisted at
   attestation and immutable; re-pairing, token rotation or session replacement changes the
   transport, never the account.
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
   company number. This predates M1 and no collision can detect it.
6. **A controlled answer for unprovable history**: legacy conversations without transport or
   account provenance, and historical conflict entries that cannot be classified, are
   reconciled only by an explicit, audited milestone — never silently unblocked, attributed
   or deleted.
