# Provider account identity — deferred model (v1)

**Status: DEFERRED. Explicitly out of scope for PR #81.** This note records why, and
what a real design would have to provide. It is not an implementation plan and no
schema, migration or backfill belongs to it yet.

## Why this is deferred

PR #81 briefly carried a "provider account stamp" on `ContactIdentity.metadata.providerAccountId`
and used it as an authorization and admission boundary. A read-only audit proved the
stamp had no trustworthy authority behind it on any channel, so the enforcement was
removed and the concept deferred.

The decisive findings, each measured against the tree and the live database:

- **There was no boundary to preserve.** `origin/main` has no cross-account guard at
  all. `SafeContactResolutionExecutor.ts`, `assertPrivateWhatsAppConversationConnectionV1`
  and `markChannelIdentityConflictV1` do not exist there, and main resolves an identity
  by `(channel, externalId)` alone. Production's 1,057 channel identities carry no
  account provenance because the concept never existed when they were written.

- **WhatsApp's account value names a mutable slot, not an account.** The stamp was
  `WhatsAppConnection.id`, an operator-minted cuid created *before* any pairing exists.
  `refreshWhatsAppQR` clears `sessionData` on that same row, so a different real
  WhatsApp account can pair into the same id. The one live-attested value,
  `client.info.wid.user`, is written blind to `phoneNumber` on every `ready` with no
  comparison to the previous value, and no guard reads it.

- **Telegram has two transports and no canonical account.** The Bot API path reports
  the bot's own user id; the MTProto path reports the authenticated user id from a live
  `getMe()`. They are different values in the same numeric namespace, and the MTProto
  one is persisted nowhere — it lives only in an in-memory map. `TelegramConnection.id`
  is a decoy: numeric, shaped like an account id, and explicitly forbidden as one.

- **MAX's stored connection value is the literal `max_scraper`**, identical on every
  row, and its only per-identity evidence is written by the same shared-secret webhook
  that would later claim it.

The general rule the audit produced: **evidence written by the same credential that
asks to be admitted cannot authorize that admission.**

## What a real model must provide

Three concepts that the current schema collapses into one, and must not:

| Concept | Meaning | Stability |
|---|---|---|
| `ProviderAccount` | The account as the *provider* identifies it, proven by provider attestation | Immutable for the life of the account |
| `TransportBinding` | A local, swappable way of reaching that account: a WhatsApp connection slot, a bot token, an MTProto session | Mutable, replaceable, may be several per account |
| `ChannelIdentity` | The counterparty, as seen on a channel | Independent of which account observed it |

Requirements any accepted design has to meet:

1. **The account identity is provider-authoritative.** It comes from the provider
   (a verified WhatsApp number or wid, a Telegram user id from `getMe()`, a MAX account
   id from an authenticated session), is persisted at attestation time, and is never
   inferred from an application row id.

2. **The account identity is immutable.** Re-pairing, rotating a token or replacing a
   session changes the `TransportBinding`, never the `ProviderAccount`.

3. **Evidence is independent of the admitting event.** Whatever proves an identity
   belongs to an account must not be writable by the credential that wants to use it.

4. **`ChannelIdentity` gains an account dimension.** Its current key,
   `@@unique([channel, externalId])`, has no account column, so one row is shared by
   every account that ever talks to that counterparty. Any isolation claim needs that
   key widened, which is a migration and a backfill, which is why it is deferred.

5. **Multiple transports per account are first class.** Telegram Bot API and MTProto can
   legitimately observe the same counterparty for the same organisation. A model that
   lets whichever transport arrives first claim the identity permanently locks the other
   out, which is what the abandoned lazy-adoption design would have done.

6. **Migration has an answer for unprovable history.** 1,057 existing identities have no
   provenance and most cannot be attributed from repository evidence. A design must say
   what happens to them rather than assuming they can be backfilled.

## What PR #81 does instead

It delivers canonical contact and channel-identity semantics without claiming
provider-account isolation: one person to one canonical contact to many channel
identities, deterministic resolution, ambiguous matches failing closed, contact and
identity integrity with race safety, and retention semantics. Account-shaped fields
remain as non-authoritative telemetry and future migration metadata. They do not change
runtime authorization.
