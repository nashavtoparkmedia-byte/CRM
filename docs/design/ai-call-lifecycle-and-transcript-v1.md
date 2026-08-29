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
`Call.metadata.aiCallTranscriptV1` journal stores only the stable message
identity, deterministic ordinal, row identity, fingerprint, source, finality
and reconciliation revision needed to order and fence those rows.

The current Bridge emits finalized STT/user and LLM/assistant items only. It
does not expose partial hypotheses, so partial callbacks fail validation
instead of inventing replacement semantics. Each live callback and the
terminal reconciliation payload carry the same identity and ordinal. Exact
retry is a no-op; identity/content or ordinal collisions fail closed;
out-of-order delivery converges by ordinal. A row lock serializes concurrent
final items.

A final message may arrive after terminalization because the live transcript
request and terminal request can race. It is accepted only as a new immutable
identity/ordinal, increments transcript revision, and is marked
`acceptedAfterTerminal=true`; it never overwrites an accepted row or reopens
terminal Call fields. The terminal callback reconciles its complete receipt
set before finalization, which normally closes this race before the terminal
write.

`Call.transcript` remains a compatibility projection rendered from sorted
canonical rows. It is never parsed back into canonical truth, and replay does
not append duplicate lines. Current UI, analysis and knowledge consumers can
continue reading it. A later bounded stage can move those consumers to a
Calling-owned structured transcript query and then remove the projection only
after usage reaches zero.

The Bridge's legacy terminal transcript array is derived from these same
final-only receipts. Synthetic LLM prompts and tool-call history are not
canonical transcript content.

Calling does not write Messaging `Chat` or `Message` persistence.

## Stage 4 finalization recovery

The finalization-specific runtime runs once at application startup and every
30 seconds. A bounded batch (25) query discovers `pending`, due `retry_wait`
and expired-lease `in_progress` journals directly from
`Call.metadata.aiCallFinalizationV1`. It atomically reclaims each Call and
replays the deterministic Work Management command. `completed` and
`not_required` are excluded. `terminal_failure` is counted for operator
visibility and never claimed.

Recovery therefore does not require a fresh Bridge callback. Multiple CRM
processes are safe because row locks, monotonic lease tokens and Work
Management's idempotency key fence duplicate execution.

The bounded JSON query is correct without a new table or migration. It is an
unindexed scan today. If AI-call volume makes the 30-second scan material, add
a Calling-owned indexed recovery projection in a later expand-only migration;
that is a performance optimization, not a correctness prerequisite for this
stage.
