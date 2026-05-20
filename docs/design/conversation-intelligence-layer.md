# Conversation Intelligence Layer — Design

**Status:** design proposal (no code / no migration in this PR)
**Predecessor:** PR #57 (Structured Outcome Layer) — outcomes are now measurable.
**This PR:** make the **trajectory** measurable. Every AI-call becomes a timeline of events.

---

## 1. Why this exists

PR #57 made the **outcome** of an AI-call queryable: `aiOutcome` enum, `qualificationScore`, structured `leadDataStructured`. We can now answer "how many qualified leads in Moscow this week."

What we still cannot answer:

- **Where in the call did the lead disengage?**
- **Did STT corrupt the dialog, and how often?**
- **Why does `transfer_to_manager` never fire in production?**
- **Which scenario phase produces the highest drop-off?**

The 49-call production sample analyzed during the assessment phase surfaced concrete failure clusters:

| failure cluster | rate (n=49) | currently observable? |
|---|---|---|
| Unclear outcome (LLM gave up) | 49% (24/49) | only as terminal state |
| Pre-greeting hangup (no analysis) | 29% (14/49) | not at all |
| STT garbage hallucinations (subtitle credits, echo) | ≥10% observed | only by reading raw transcript |
| `transfer_to_manager` invoked | **0/49** | dead silence — no signal at all |
| Qualified outcome | 18% (9/49) | yes (PR #57) |

These are not theoretical risks. They are production-resident. The Outcome Layer tells us *what happened*. The Conversation Intelligence Layer tells us *where it broke*.

---

## 2. Goals

- **Measurable conversations** — every dialog state transition and signal-bearing moment becomes a queryable row.
- **Event-based funnel** — explicit stages with explicit triggers; drop-off is computable per stage rather than inferred from outcome.
- **Replay reasoning** — for any past call, reconstruct the timeline of bot/lead/STT/LLM/tool actions in order.
- **Conversion diagnostics** — when conversion is lost, the operator can identify which event (or absence of event) signals the loss.

## 3. Non-goals

The architect has been explicit; restating to bound scope hard:

- ❌ **Analytics platform.** No Looker / Metabase / Grafana / Superset.
- ❌ **BI engine.** No materialized views, no OLAP cube, no warehouse pipeline.
- ❌ **ML pipeline.** No classifier training, no embedding store, no model registry.
- ❌ **Realtime streaming analytics.** No Kafka, no event bus, no streaming SQL.

This layer is a **single Postgres table + 7 emit points in the bridge** for Priority 1. Nothing more.

---

## 4. Event taxonomy

### 4.1 Priority 1 — ship in first implementation PR

These 7 events cover the assessment's full failure-cluster map. They emit at natural transition points already present in the bridge (per the code survey in the assessment). Each comes with the architect-mandated annotation surface.

---

#### `call_completed`

| field | value |
|---|---|
| **Why this exists** | Every call has exactly one terminal event. Foundation for funnel math. Without it, no aggregation can count "completed calls" deterministically. |
| **Business signal** | Final outcome + duration + hangup cause + completion path (LLM end_call vs WS close vs error). The terminal slice of the trajectory. |
| **Future query** | `SELECT COUNT(*) FROM AiCallEvent WHERE type='call_completed' AND payload->>'outcome'='qualified' AND ...` — drop rate by hangup cause, completion-path distribution. |
| **Volume** | 1 per call. ~100% of finalized AI-calls. |
| **Payload** | `{ outcome: AiOutcome, hangup_cause: string?, total_ms: int, completed_via: 'llm_end_call' \| 'llm_transfer_to_manager' \| 'silence_timeout' \| 'ws_close' \| 'bridge_error', validation_issues_count: int }` |
| **Emitted / derived** | Emitted from the CRM finalize route handler. Same write transaction as the existing `Call.aiOutcome` update — guarantees event row and outcome row never diverge. |
| **Natural code site** | `gravity-mvp/src/app/api/ai-calls/sessions/[id]/finalize/route.ts` post-update (after PR #57's `aiOutcome` write). |

---

#### `greeting_started`

| field | value |
|---|---|
| **Why this exists** | Marks the moment bot begins speaking. All time-to-X metrics are relative to this anchor. |
| **Business signal** | Engagement clock starts. Pairs with `first_real_user_speech` for the most important latency metric in the system: time-to-engage. |
| **Future query** | `SELECT AVG(s.occurredAt - g.occurredAt)` joining `greeting_started` to `first_real_user_speech` — gives avg time-to-first-speech, the leading indicator of pre-greeting drop. |
| **Volume** | ~100% of accepted AI-calls (everything that reaches the bridge). |
| **Payload** | `{ scenario_id: string, scenario_name: string, greeting_text_head: string }` (first ~120 chars of greeting for debugging-time replay) |
| **Emitted / derived** | Emitted from the bridge at `_setState('greeting')` transition (`tools/audio-bridge-day1/call-session.js:209`). |

---

#### `first_real_user_speech`

**The single highest-signal event in this proposal.** Splits the 29% pre-greeting drop cliff from genuinely engaged calls.

| field | value |
|---|---|
| **Why this exists** | Distinguishes calls that even got to "the lead is talking back" from calls that did not. The biggest single conversion-leak in the assessment data lives on this boundary. |
| **Business signal** | The lead engaged. Combined with timestamp delta to `greeting_started`, it tells us how patient leads are with the greeting. Combined with absence (no such event for a call), it tells us "lead hung up before/during greeting." |
| **Future query** | Pre-greeting drop rate: `COUNT(c) WHERE NOT EXISTS(SELECT 1 FROM AiCallEvent WHERE callId=c.id AND type='first_real_user_speech')`. Time-to-first-speech histogram. |
| **Volume** | ~70% of AI-calls (per assessment 29% pre-greeting drop). |
| **Payload** | `{ delay_ms_since_greeting: int, stt_confidence: float?, first_phrase_head: string }` (first ~80 chars) |
| **Emitted / derived** | Emitted from the bridge in `_onSttFinal` (`call-session.js:252-258`) — specifically guarded by PR #57's `realUserUtterances` counter incrementing from 0 to 1. Synthetic silence-timeout wake-up messages do NOT trigger this event. |

Critical correctness condition: this event must NEVER fire for the bridge-synthesized "(лид молчит)" messages. The `realUserUtterances` counter introduced in PR #57 already makes this distinction; this event hooks the `0 → 1` transition.

---

#### `silence_strike`

| field | value |
|---|---|
| **Why this exists** | Distinguishes mute from think from hangup. Currently three operationally different states get conflated into a single `unclear` outcome. |
| **Business signal** | "Lead is on the line but not producing speech." Strike count 1 = brief pause. Strike count 2 = silent dropout (call ends per existing logic). |
| **Future query** | Outcome conditional on strike-count: `SELECT outcome, AVG(strike_count) GROUP BY outcome` — does strike 1 predict outcome quality? Recovery rate: of calls with strike 1, how many produce another `save_lead_data_emitted` after? |
| **Volume** | Variable; assessment data suggests silence-timeout fires on a meaningful fraction of unclear calls. Estimate 30-50% of calls fire ≥1 strike. |
| **Payload** | `{ strike_n: 1 \| 2, time_since_last_real_speech_ms: int, state_at_strike: 'greeting' \| 'listening' \| 'thinking' \| 'speaking' }` |
| **Emitted / derived** | Emitted from the bridge in `_onSilenceTimeout` (`call-session.js:144`). One event per timer fire; max 2 per call (matches existing `MAX_SILENT_STRIKES=2`). |

---

#### `manager_requested`

**This event currently has zero historical fires — its emptiness is itself the signal.**

| field | value |
|---|---|
| **Why this exists** | Tool exists in `llm-client.js:104-121`, but production data shows 0/49 invocations. Instrumenting this event makes the gap **measurable**: every call where the LLM **should** have transferred but did not is a missed escalation. |
| **Business signal** | When (if ever) LLM decides to escalate. Zero rate after one week = scenario prompt does not adequately encourage transfers OR leads do not produce out-of-scenario inputs. Either is fixable; this event measures the fix. |
| **Future query** | `SELECT COUNT(*) FROM AiCallEvent WHERE type='manager_requested' GROUP BY DATE(occurredAt)` — currently 0/day; tracks any change. Cross-reference: of all `unclear_engaged` outcomes, how many fired `manager_requested`? |
| **Volume** | Currently 0%. Post scenario tuning, target unknown but >5% expected for a healthy escalation channel. |
| **Payload** | `{ tool_reason: string, lead_data_collected_so_far: object, turn_n: int }` |
| **Emitted / derived** | Emitted from the bridge in `_dispatchTool` when `name === 'transfer_to_manager'` (`call-session.js:351`). |

---

#### `save_lead_data_emitted`

| field | value |
|---|---|
| **Why this exists** | Each canonical field captured during dialog. Lets us see *which* fields fill in *what order* — predictive of scenario quality. |
| **Business signal** | Progress through the qualification. A call that fires 5× `save_lead_data_emitted` (all canonical keys) before dropping is qualitatively different from one that fires 0. |
| **Future query** | A/B scenario comparison: avg fields filled before terminal event, per scenario. Partial-completion patterns: which canonical key gets dropped most frequently right before drop? |
| **Volume** | 0-6 per call; per assessment data, qualified calls average ~5, unclear calls ~1, drops ~0. |
| **Payload** | `{ canonical_key: string, value_raw: string, value_typed: string \| number \| boolean \| null, validation_pass: boolean, turn_n: int }` |
| **Emitted / derived** | Emitted from the bridge in `_dispatchTool` when `name === 'save_lead_data'` (`call-session.js:337`). The `validation_pass` boolean reuses PR #57's `scenario-schema.js` coercion result inline. |

---

#### `stt_suspicious_pattern`

**Production-critical. Failure mode #1 from the assessment.**

| field | value |
|---|---|
| **Why this exists** | The 49-call sample showed Yandex STT producing **structured garbage** (subtitle credit hallucinations, exact echo of bot's last word) that the bot accepts as a genuine lead utterance, then loops on. This is silent conversation corruption — invisible to the existing outcome layer. |
| **Business signal** | "This call has at least one STT result we should not trust." Per-call rate over time tracks STT health. Per-pattern frequency surfaces which hallucinations dominate (informs future garbage filter). |
| **Future query** | `SELECT pattern_name, COUNT(*) FROM AiCallEvent WHERE type='stt_suspicious_pattern' GROUP BY pattern_name` — top hallucinations. Correlate with outcome: do calls with `stt_suspicious_pattern` skew toward `unclear`? (assessment data suggests yes). |
| **Volume** | Estimated ≥10% of calls fire ≥1 event; the dominant pattern (`subtitle_credits`) is ~5% per the assessment sample. |
| **Payload** | `{ pattern_name: string, matched_text: string, stt_confidence: float?, source: 'final' \| 'partial' }` |
| **Emitted / derived** | Emitted from the bridge in `_onSttFinal` after a pattern-detection check runs against the incoming STT text. Pattern catalog lives in `docs/research/stt-garbage-patterns.md` (sibling doc). |

This event is the prerequisite for any future STT-garbage filter (separate PR). Without instrumenting first, any filter intervention is unmeasurable.

---

### 4.2 Priority 2 — later, lazy/post-hoc

These add granularity but are not required for the first funnel report.

---

#### `stt_low_confidence`

| field | value |
|---|---|
| **Why this exists** | Granular STT quality observability beyond the binary suspicious-or-not split. |
| **Business signal** | Which individual utterances STT didn't trust (confidence < threshold, e.g., 0.6). |
| **Future query** | Avg confidence per scenario; correlation of low-confidence count with outcome quality. |
| **Volume** | Variable; ~20% of STT finals likely fall under a 0.6 threshold. **High volume — only emit when below threshold to keep table size bounded.** |
| **Payload** | `{ confidence: float, text_head: string }` |
| **Emitted / derived** | Emitted from `_onSttFinal` when `confidence < threshold`. The threshold is hardcoded (default 0.6) — not configurable, audited at PR review like PR #54's retry policy. |

---

#### `pre_greeting_hangup`

| field | value |
|---|---|
| **Why this exists** | Quantifies the 29% drop cliff explicitly so the funnel view has a named slice. |
| **Business signal** | Lead hung up before greeting completed OR before any user speech. |
| **Future query** | `SELECT COUNT(*) FROM AiCallEvent WHERE type='pre_greeting_hangup'` — daily count; trend over time as scenario greeting evolves. |
| **Volume** | ~29% per assessment. |
| **Payload** | `{ time_to_hangup_ms: int, greeting_text_played_fraction: float }` (0.0 = hangup before any audio; 1.0 = full greeting played) |
| **Emitted / derived** | **DERIVED at finalize time** in the CRM, NOT emitted from the bridge. Condition: `call_completed` event fires before any `first_real_user_speech` event. The CRM finalize route synthesizes this row as part of its existing structured-outcome write. No bridge change needed for this event. |

---

#### `objection_detected`

| field | value |
|---|---|
| **Why this exists** | Lead pushback patterns (price questions, "already work elsewhere", "not interested"). |
| **Business signal** | Which scenarios surface which objections; objection-to-outcome correlation. |
| **Future query** | `SELECT objection_type, COUNT(*), AVG(... outcome rate) FROM AiCallEvent JOIN Call ...` |
| **Volume** | Variable. Per assessment data, current LLM rarely classifies (the system prompt encourages `transfer_to_manager` for objections, but transfer fires 0× — see `manager_requested` above). Expect low volume until LLM is retuned. |
| **Payload** | `{ objection_type: string, lead_phrase: string, confidence: float? }` |
| **Emitted / derived** | Two options, both viable later: (a) **emitted** from a new dedicated LLM tool call (would require bridge tool schema change, ~ PR #57 sized), (b) **derived** from post-hoc transcript analysis (cheap; runs in `analyzeWorker.ts`). Recommended path: option (b) first, option (a) only if signal is too weak. |

---

#### `qualification_started`

| field | value |
|---|---|
| **Why this exists** | Marks the post-greeting question loop beginning. |
| **Business signal** | Phase transition. Lets the funnel distinguish "engaged but never started qualifying" from "started qualifying." |
| **Future query** | Time-from-greeting-to-qualification by scenario; correlation with outcome. |
| **Volume** | ~70% of calls (anything past greeting). |
| **Payload** | `{ first_question_idx: int, time_since_greeting_ms: int }` |
| **Emitted / derived** | **DERIVED** from the first `save_lead_data_emitted` for the call. CRM materializes this either as a synthesized event row or as a computed-on-read view. Either is fine; trade-off is row count vs query cost. Recommended: synthesize at finalize time (write-once, query-many). |

---

## 5. `AiCallEvent` schema proposal

```prisma
/// Conversation Intelligence Layer (post-PR #57). One row per signal-bearing
/// moment in an AI-call's lifecycle. Cleared with the Call (onDelete: Cascade).
///
/// Events live alongside — NOT replacing — AiCallMessage. See "Tradeoffs"
/// below for the rationale.
///
/// Volume budget: ~7-12 events per AI-call on average (~5 save_lead_data +
/// greeting_started + first_real_user_speech + call_completed + occasional
/// silence_strike / suspicious_pattern). At current production load this is
/// a small fraction of message-row volume.
model AiCallEvent {
  id          String       @id @default(cuid())
  callId      String

  /// Discriminated event type. Each value has a documented payload schema
  /// (see docs/design/conversation-intelligence-layer.md §4).
  type        AiCallEventType

  /// Wall-clock timestamp of emission. Used for cross-event delta queries
  /// (time-to-first-speech, silence interval, etc.).
  occurredAt  DateTime     @default(now())

  /// Monotonic per-call ordinal. Resolves same-millisecond ties (the bridge
  /// can fire two events within one event loop tick when tool_call dispatch
  /// chains). Assigned by the bridge at emission time.
  seq         Int

  /// Type-specific payload. Schemas documented per type in the design doc;
  /// validated in code via a discriminated TypeScript union at write time.
  payload     Json?

  call        Call         @relation(fields: [callId], references: [id], onDelete: Cascade)

  /// Primary access pattern: timeline reconstruction for one call.
  @@index([callId, seq])
  /// Secondary access pattern: aggregations across calls by event type.
  @@index([type, occurredAt(sort: Desc)])
}

enum AiCallEventType {
  // Priority 1 (first implementation PR)
  call_completed
  greeting_started
  first_real_user_speech
  silence_strike
  manager_requested
  save_lead_data_emitted
  stt_suspicious_pattern

  // Priority 2 (later)
  stt_low_confidence
  pre_greeting_hangup
  objection_detected
  qualification_started
}
```

### 5.1 Tradeoffs — why a separate table

**Why separate semantic layer (not extending `AiCallMessage`):**

`AiCallMessage` is per-utterance: each row corresponds to one finalized chunk of speech (STT final, LLM reply, or tool dispatch). It is a transcript table. Events are categorically different:

- Events include non-message moments (`silence_strike`, `stt_suspicious_pattern`, `pre_greeting_hangup`) that have no utterance.
- Events carry **structured** payloads typed per event; messages carry free-form `content` text.
- Events are **discriminable by `type` enum**; messages are discriminable by `role` (3-way) and `toolName` (string-typed, not enum).

Cramming events into `AiCallMessage` would require:

- A new `eventType` column on `AiCallMessage` that is null for messages — semantic null-bloat.
- Queries that union message and event semantics with `WHERE eventType IS NOT NULL OR (role = 'tool' AND toolName = ...)`.
- A loose contract for what the `content` field means when the row is "really" an event.

A separate table costs one join in cross-cutting queries but keeps both surfaces clean.

**Why lower query complexity:**

Timeline reconstruction for one call becomes one declarative statement:
```sql
SELECT type, occurredAt, payload FROM "AiCallEvent" WHERE "callId" = $1 ORDER BY seq;
```

Funnel aggregations follow from there. With a unified table, every query carries a `WHERE eventType IS NOT NULL` predicate plus the union of message-vs-event conditions. The schema cost (one extra table) is repaid every time someone writes an analytics query.

**Why easier funnel aggregation:**

Funnel queries (see §6) repeatedly ask "did event X occur for call C?" — a single-table `EXISTS` against an indexed `(callId, type)` predicate. With a unified table, the same predicate needs to also filter on `eventType IS NOT NULL` (or whatever the discriminator is), and the index becomes harder to keep tight.

### 5.2 Tradeoffs — why NOT event-sourcing / Kafka / append-only blob

**Why NOT event-sourcing:**

Event-sourcing implies that the `Call` row's *current state* is derived by replaying events. We are doing the opposite: the `Call` row is the canonical state (with the `aiOutcome` enum, `qualificationScore`, etc. from PR #57), and events are an **observability sidecar**. Mixing the two paradigms would require either:

- Treating `Call` columns as a materialized view of events (write amplification + ordering complexity + bridge becomes more complex), or
- Treating events as the only source of truth (drops PR #57's structured outcome columns — a regression).

The split — Call row = state, AiCallEvent = trajectory — is correct for our scale (~50 calls/week to maybe ~5000/week) and keeps the bridge simple.

**Why NOT Kafka / streaming event bus:**

Kafka makes sense when:
- Multiple consumers need to subscribe to events in real time.
- Throughput exceeds what Postgres can ingest synchronously.
- Replay requires a durable, long-retention log.

None of these apply. There is one consumer (the CRM analytics layer). Throughput is ≤1 event per ~5 seconds at current scale. Replay is already free from the table (`SELECT ... ORDER BY seq`).

A Kafka deployment would add: one new service to operate, one new failure mode, one new at-least-once-delivery semantics to reconcile against the at-most-once Postgres write. Net negative.

**Why NOT append-only giant blob:**

The temptation is to store the entire timeline as a JSONB array on the `Call` row: `Call.events: [...]`. Reasons against:

- **No indexing.** Cannot do `WHERE type='manager_requested' GROUP BY DATE` without scanning every blob.
- **Update contention.** Each event emission becomes a `Call` row update — last-writer-wins risk for events from different code paths (bridge + finalize route + analyzeWorker).
- **Size unbounded.** A 5-minute call can fire 20+ events; a JSONB blob grows unboundedly.

A normalized table with two indices solves all three and costs ~50 bytes per event row.

---

## 6. Funnel model

The funnel is a sequence of named **stages** through which every AI-call advances (or fails to). Each stage transition is triggered by exactly one event (or by the absence of one).

```
                 (Call row created — Call.startedAt)
                          │
                          ▼
                  ┌────────────────┐
                  │   originated   │  (no event emitted yet; bridge has not yet established greeting)
                  └────────┬───────┘
                  greeting_started fires │
                          ▼
                  ┌────────────────────┐
                  │  greeting_in_flight│
                  └────────┬───────────┘
                           │
       ┌───────────────────┴────────────────────────┐
       │                                            │
 call_completed fires                first_real_user_speech fires
 (without first_real_user_speech)                   │
       │                                            ▼
       ▼                                  ┌──────────────────┐
 ┌──────────────────┐                     │      engaged     │
 │  pre_greeting_   │                     └────────┬─────────┘
 │     dropped      │                              │
 │   (terminal)     │             ┌────────────────┴─────────────────┐
 └──────────────────┘             │                                  │
                          save_lead_data_emitted             silence_strike (×N) → call_completed
                          fires (any canonical key)                    │
                                  │                                    ▼
                                  ▼                          ┌────────────────────┐
                         ┌──────────────────┐                │  silence_dropped   │
                         │    qualifying    │                │     (terminal)     │
                         └────────┬─────────┘                └────────────────────┘
                                  │
                  ┌───────────────┼────────────────────┐
                  │               │                    │
        manager_requested  call_completed         call_completed
        fires            with outcome=qualified   with outcome=
        (LLM tool)       or not_qualified          unclear_engaged
                  │               │                    │
                  ▼               ▼                    ▼
        ┌──────────────────┐  ┌────────────────┐  ┌──────────────────┐
        │ manager_         │  │ qualification_ │  │  ambiguous_      │
        │ escalated        │  │ complete       │  │  engagement      │
        │ (terminal)       │  │ (terminal)     │  │  (terminal)      │
        └──────────────────┘  └────────────────┘  └──────────────────┘
```

### 6.1 Stage definitions and triggers

| stage | entered when | exited when | terminal? |
|---|---|---|---|
| `originated` | `Call` row created | `greeting_started` fires | no |
| `greeting_in_flight` | `greeting_started` fires | `first_real_user_speech` fires OR `call_completed` fires | no |
| `engaged` | `first_real_user_speech` fires | first `save_lead_data_emitted` OR `silence_strike` 2 OR `call_completed` | no |
| `qualifying` | first `save_lead_data_emitted` fires | `manager_requested` OR `call_completed` | no |
| `pre_greeting_dropped` | `call_completed` without earlier `first_real_user_speech` | (terminal) | yes |
| `silence_dropped` | strike 2 → `call_completed` with `dropped_no_input` outcome | (terminal) | yes |
| `manager_escalated` | `manager_requested` → `call_completed` | (terminal) | yes |
| `qualification_complete` | `call_completed` with outcome in (qualified, not_qualified) | (terminal) | yes |
| `ambiguous_engagement` | `call_completed` with outcome `unclear_engaged` and no `manager_requested` | (terminal) | yes |

### 6.2 Each call's terminal stage is computable

For a given call, the terminal stage is determined by:
1. Did `first_real_user_speech` fire? If no → `pre_greeting_dropped`.
2. Did `manager_requested` fire? If yes → `manager_escalated`.
3. Outcome `qualified` or `not_qualified` → `qualification_complete`.
4. Outcome `dropped_no_input` → `silence_dropped`.
5. Outcome `unclear_engaged` without `manager_requested` → `ambiguous_engagement`.
6. Outcome `error` → reported separately (technical failure, not a funnel position).

This deterministic mapping is the basis of all funnel queries in §7.

---

## 7. Query examples

These queries are syntactically valid against the post-PR-57 + post-AiCallEvent schema. They are the practical proof that this layer is queryable, not theoretical.

### 7.1 Pre-greeting drop rate (last 7 days)

```sql
WITH ai_calls AS (
  SELECT c.id, c."startedAt",
         EXISTS (
           SELECT 1 FROM "AiCallEvent" e
            WHERE e."callId" = c.id AND e."type" = 'first_real_user_speech'
         ) AS engaged
    FROM "Call" c
   WHERE c."isAi" = true AND c."startedAt" >= NOW() - INTERVAL '7 days'
)
SELECT COUNT(*)                         AS total_ai_calls,
       COUNT(*) FILTER (WHERE NOT engaged) AS pre_greeting_drops,
       ROUND(100.0 * COUNT(*) FILTER (WHERE NOT engaged)
             / NULLIF(COUNT(*), 0), 1)  AS drop_pct
  FROM ai_calls;
```

Expected output (per assessment baseline): `drop_pct ≈ 29`.

### 7.2 Average time-to-first-speech (engaged calls only)

```sql
WITH delays AS (
  SELECT g."callId",
         EXTRACT(EPOCH FROM (s."occurredAt" - g."occurredAt")) * 1000 AS delay_ms
    FROM "AiCallEvent" g
    JOIN "AiCallEvent" s
      ON s."callId" = g."callId" AND s."type" = 'first_real_user_speech'
    JOIN "Call" c ON c.id = g."callId"
   WHERE g."type" = 'greeting_started'
     AND c."startedAt" >= NOW() - INTERVAL '7 days'
)
SELECT AVG(delay_ms)::int                                              AS avg_ms,
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY delay_ms)::int     AS p50_ms,
       percentile_cont(0.9)  WITHIN GROUP (ORDER BY delay_ms)::int     AS p90_ms,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY delay_ms)::int     AS p99_ms
  FROM delays;
```

Interpretation: a p90 of >5000 ms suggests the greeting itself is too long; a p50 of <300 ms suggests echo (lead's "speech" is actually the bot's tail being misheard — pair with `stt_suspicious_pattern` to confirm).

### 7.3 Silence-strike distribution

```sql
SELECT (payload->>'strike_n')::int        AS strike_n,
       (payload->>'state_at_strike')      AS state_at_strike,
       COUNT(*)                            AS occurrences
  FROM "AiCallEvent"
 WHERE "type" = 'silence_strike'
   AND "occurredAt" >= NOW() - INTERVAL '7 days'
 GROUP BY strike_n, state_at_strike
 ORDER BY strike_n, occurrences DESC;
```

Splits "lead silent during greeting" from "lead silent during listening" — different operational fixes.

### 7.4 Manager escalation frequency (per day)

```sql
SELECT DATE(c."startedAt") AS day,
       COUNT(DISTINCT c.id) AS total_ai_calls,
       COUNT(DISTINCT e."callId") AS escalations,
       ROUND(100.0 * COUNT(DISTINCT e."callId")
             / NULLIF(COUNT(DISTINCT c.id), 0), 2) AS rate_pct
  FROM "Call" c
  LEFT JOIN "AiCallEvent" e
    ON e."callId" = c.id AND e."type" = 'manager_requested'
 WHERE c."isAi" = true
   AND c."startedAt" >= NOW() - INTERVAL '30 days'
 GROUP BY day
 ORDER BY day DESC;
```

**Pre-intervention baseline expected: `rate_pct = 0` every day.** This query is the measurement instrument for whatever scenario-prompt change eventually unblocks the transfer path.

### 7.5 STT suspicious-pattern rate (and top patterns)

```sql
SELECT (payload->>'pattern_name')        AS pattern_name,
       COUNT(*)                          AS occurrences,
       COUNT(DISTINCT "callId")          AS distinct_calls,
       ROUND(100.0 * COUNT(DISTINCT "callId")
             / NULLIF((SELECT COUNT(*) FROM "Call"
                        WHERE "isAi" = true
                          AND "startedAt" >= NOW() - INTERVAL '7 days'), 0), 2)
                                          AS pct_of_calls
  FROM "AiCallEvent"
 WHERE "type" = 'stt_suspicious_pattern'
   AND "occurredAt" >= NOW() - INTERVAL '7 days'
 GROUP BY pattern_name
 ORDER BY occurrences DESC;
```

Output structure makes the dominant pattern visible immediately; informs which pattern to filter first in the future STT-garbage-filter PR.

### 7.6 Outcome by first-response delay (engagement-quality slicing)

```sql
WITH delays AS (
  SELECT c.id, c."aiOutcome",
         EXTRACT(EPOCH FROM (s."occurredAt" - g."occurredAt")) * 1000 AS delay_ms
    FROM "Call" c
    JOIN "AiCallEvent" g ON g."callId" = c.id AND g."type" = 'greeting_started'
    JOIN "AiCallEvent" s ON s."callId" = c.id AND s."type" = 'first_real_user_speech'
   WHERE c."isAi" = true AND c."startedAt" >= NOW() - INTERVAL '30 days'
), buckets AS (
  SELECT id, "aiOutcome",
         CASE WHEN delay_ms <  1000 THEN '<1s'
              WHEN delay_ms <  3000 THEN '1-3s'
              WHEN delay_ms <  5000 THEN '3-5s'
              WHEN delay_ms < 10000 THEN '5-10s'
              ELSE                       '10s+'
         END AS delay_bucket
    FROM delays
)
SELECT delay_bucket,
       "aiOutcome"::text AS outcome,
       COUNT(*)          AS n
  FROM buckets
 GROUP BY delay_bucket, "aiOutcome"
 ORDER BY delay_bucket, n DESC;
```

Hypothesis the data should test: extremely fast first-response (<1s) skews toward `unclear` because it's echo-mishearing, not genuine engagement. If true, paired with §7.5, motivates the STT garbage filter as a conversion-recovery lever.

---

## 8. Out of scope (explicit, by architect's brief)

- ❌ No Prisma migration in this PR (design only)
- ❌ No bridge code changes
- ❌ No CRM route changes
- ❌ No new UI / pages / dashboards
- ❌ No charts / visualization library
- ❌ No analytics infra (no Looker / Metabase / Grafana)
- ❌ No event bus / Kafka / streaming
- ❌ No ML pipeline / classifier training
- ❌ No realtime SSE / WebSocket fan-out of events
- ❌ No event-sourcing of `Call` state
- ❌ STT garbage filter itself (instrumentation comes first; filter is a separate later PR motivated by the data this layer produces)

---

## 9. After this PR

This document is the contract. The next PR (implementation) will:

1. Add the `AiCallEvent` Prisma model + enum (per §5) + migration.
2. Add the bridge emission points for the 7 Priority 1 events (per §4.1 file:line anchors).
3. Add the CRM-side derived emissions (`pre_greeting_hangup` derived at finalize) — Priority 2 #1.
4. Add a thin write helper (`gravity-mvp/src/lib/ai-call/event-emitter.js`, mirroring PR #54's pure-CommonJS helper pattern) so the bridge and CRM both write events through one validated path.
5. Add `stt_suspicious_pattern` matcher (per `docs/research/stt-garbage-patterns.md` regex catalog).
6. Funnel report SQL view + one read-only page rendering §6 stages — small, no charting library.
7. Unit tests on the pattern matcher (the only logic with branches) and the funnel-stage classifier.

Estimated scope: similar size to PR #57 (~1500-2000 lines, mostly tests + matcher logic; the Prisma migration and event-emitter are small).

The architect approves the scope of each implementation PR separately. This document does not commit to that.

---

## 10. Strategic note

After this layer ships:

| before | after |
|---|---|
| "качество звонков улучшилось" — feeling | "drop rate dropped 4 pp" — measurement |
| "AI кажется тупит на STT" — anecdote | "subtitle-credit pattern fired 6% last week" — diagnosable |
| "может быть стоит транферить чаще" — guess | "manager_requested rate is 0% — provably broken channel" — actionable |
| "не ясно где теряем" — fog | "pre_greeting_dropped is the largest terminal slice" — visible cliff |
| "сравнить два сценария?" — qualitative | "funnel-stage retention by scenario" — quantitative A/B |

This is the maturity leap from runtime engineering to product engineering. Every subsequent AI improvement becomes measurable by event delta, not by anecdote.
