# AI call lifecycle and transcript v1

Calling owns the canonical AI-call record. The aggregate is the existing
`Call`; this design does not add a session or outcome model. `Call.status` is
the telephony-leg projection, `Call.aiSessionStatus` is the AI-dialog
projection, and bounded receipts in `Call.metadata` fence their mutations.

`AiCallEvent` remains the best-effort conversation-intelligence signal stream.
It is not the durable lifecycle ledger.

## Current status mapping

| Current projection | Product meaning | Legal predecessor(s) in the AI lifecycle | Terminal | Source |
| --- | --- | --- | --- | --- |
| `Call.status=ringing`, `aiSessionStatus=starting` | outbound row exists; originate/dial is starting | none (initial persisted state) | no | Calling start operation |
| `aiSessionStatus=greeting` | the AI greeting has started | `starting` | no | authenticated Audio Bridge callback |
| `Call.status=active`, `aiSessionStatus=active` | real two-way dialog has begun | `starting` or `greeting` | no | first accepted final STT item through Audio Bridge |
| `aiSessionStatus=transferring` | manager transfer is in progress, or a finalized AI leg handed off to a manager | `greeting` or `active`; terminal finalization may confirm `transferring` | only when the Stage 4 finalization receipt marks it terminal | Audio Bridge / Calling finalization |
| `Call.status=completed`, `aiSessionStatus=ended` | accepted normal terminal outcome | `starting`, `greeting`, `active`, `transferring` | yes | Calling finalization |
| `Call.status=completed`, `aiSessionStatus=failed` | the telephony row was terminalized but the AI dialog/provider failed | `starting`, `greeting`, `active`, `transferring` | yes | Calling finalization |
| `Call.status=cancelled`, `aiSessionStatus=failed` | outbound call cancelled before completion | any non-terminal AI state | yes | Calling lifecycle operation |
| `Call.status=no_answer`, `aiSessionStatus=failed` | outbound answer timeout | any non-terminal AI state | yes | Calling lifecycle operation |
| `Call.status=failed`, `aiSessionStatus=failed` | provider/technical failure | any non-terminal AI state | yes | Calling lifecycle operation |
| `Call.status=missed`, `busy`, or `rejected` | existing telephony-leg terminal reason | existing ESL/call status policy | yes for the leg | Calling telephony adapter |

The accepted current enum vocabulary is preserved. No broad status-enum
rewrite or parallel lifecycle state column is introduced.

## Durable lifecycle receipts

`Call.metadata.aiCallLifecycleV1` stores a bounded (maximum 32) Calling-owned
journal. Each normalized event contains a stable event identity, a source
classification, a source sequence, a kind and a target. Its SHA-256
fingerprint is derived only from those provider-neutral values. Wall-clock
time is not logical identity.

Every lifecycle, transcript and finalization aggregate identity is checked
against the locked `Call.id`; deterministic transcript row identities are
also checked and every row read is scoped by `callId`. A valid journal copied
from another Call therefore fails closed instead of contaminating either
aggregate.

The Call row is locked before every transition. Exact replay is a no-op; an
identity reused with a different fingerprint fails closed; lower/equal source
sequence is recorded as stale without changing either projection. A valid
terminal receipt fences every later non-duplicate transition. Because the
Stage 4 terminal fields, finalization journal and lifecycle terminal receipt
are written under the same row lock, first-valid-terminal-wins remains the
authoritative policy.

The Bridge has only monotonic current lifecycle facts: greeting (sequence 1),
conversation active (2), transfer started (3). `active` is legal directly from
`starting` so a lost greeting callback does not strand a live call; a later
greeting is then deterministically stale.

## Canonical transcript

`AiCallMessage` is the canonical content/role row. The bounded
`Call.metadata.aiCallTranscriptV1` journal stores stable segment identity,
deterministic ordinal, row identity, current segment revision, payload
fingerprint, source, finality, aggregate revision and a bounded accepted-
revision receipt set. The existing schema therefore supports corrections
without adding another transcript table or migration.

`segmentRevision` is monotonic per segment. Exact replay is a no-op; a known
lower revision is stale; the same segment/revision with a different payload
fails closed. A higher revision updates the one stable `AiCallMessage` row
under the locked Call. Ordinal, role and source cannot change. Interim-to-final
is legal; final-to-interim is not. Out-of-order segments converge by ordinal.

Before terminal acceptance, Calling reconciles the terminal payload, reads the
complete canonical snapshot under the Call lock, and fingerprints its ordered
segment identities, revisions, payload fingerprints and finality. Finalization
includes that snapshot in its own payload identity. The finalization adapter
rechecks the transcript aggregate revision and snapshot SHA while holding the
same Call lock used to commit terminal state. If a transcript update won the
race, the bounded wrapper refreshes the snapshot and retries acceptance.

After first terminal acceptance, an exact segment replay and an older known
revision remain harmless, but a new segment or higher correction is rejected
with `terminal_snapshot`. This freezes the transcript used by outcome and
follow-up derivation instead of silently changing a finalized result.

`Call.transcript` remains a compatibility projection rendered from sorted
canonical rows. When a historical AI Call has no transcript journal, Calling
lazily normalizes existing structured rows and parses labelled (`[Лид]` /
`[AI]`) or plain legacy transcript text into canonical rows in the same
transaction. Existing structured content wins, while legacy chunks not already
represented are preserved as extra canonical segments. Replay does not append
duplicate lines. New writes are canonical; there is no permanent dual-write
source of truth and no unrelated bulk backfill.

The Bridge's legacy terminal transcript array is derived from these same
final-only receipts. Synthetic LLM prompts and tool-call history are not
canonical transcript content.

Calling does not write Messaging `Chat` or `Message` persistence.

## Indexed durable finalization recovery

When terminal state and a pending follow-up are first accepted, the same
database transaction appends the deterministic
`calling.AiCallFinalizationFollowUpRequested.v1` event. The already authorized
`DomainOutboxEvent` projection provides a unique `eventId` and the composite
`(status, availableAt, createdAt)` selection index. Its publisher claims at
most 25 due rows with compare-and-set, recovers stale claims, applies bounded
backoff and moves exhausted poison rows to visible `dead_letter` state.

The validated Calling consumer recovers only the Call/finalization fingerprint
named by that event. The existing Call row lock and monotonic inner lease token
fence concurrent follow-up workers; Work Management's deterministic
idempotency key fences a lost command response. Retryable inner results are
returned to the outbox retry lane. A permanent owner-command failure remains
visible in `Call.metadata.aiCallFinalizationV1.followUp.terminal_failure` and
the wake-up can settle without a retry storm.

This path covers process death after terminal commit, after inner claim, and
after Work Management acceptance without relying on another Bridge callback.
There is no metadata JSON recovery query, full-Call scan or application-side
filter. No schema migration is needed because the required indexed durable
projection, uniqueness, retry and poison-state semantics already exist.
