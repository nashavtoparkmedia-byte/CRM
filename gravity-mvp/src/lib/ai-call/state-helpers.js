// Pure policy helpers for the `POST /api/ai-calls/sessions/[id]/state`
// endpoint. Lives in `.js` (CommonJS) on purpose — testable via
// `node --test` without a tsx loader or a Next.js runtime, mirroring
// the auth-helpers / health-helpers pattern that landed in the
// auth-trilogy and PR #48.
//
// Two responsibilities:
//
//   1. ALLOWLIST: what states the bridge is permitted to POST into the
//      CRM-canonical state machine. Deliberately narrower than the
//      full Prisma `AiCallSessionStatus` enum:
//
//        permitted   : greeting, active, transferring
//        rejected    : thinking, speaking, listening, idle, starting,
//                      ended, failed
//
//      `starting` is owned by `/api/ai-calls/start/route.ts` (creates
//      the Call row). `ended` / `failed` / `transferring` are owned
//      by `/api/ai-calls/sessions/[id]/finalize/route.ts`. Bridge can
//      only nudge the row INTO `greeting` / `active` / `transferring`;
//      it cannot terminate.
//
//      (`transferring` is in the allowlist as defence-in-depth — even
//      though bridge currently sets it via finalize, future code might
//      transition through it from /state. Both paths converge.)
//
//      `thinking` / `speaking` / `listening` / `idle` are per-turn
//      operational telemetry — they belong in bridge stdout (opsLog),
//      not in the DB.
//
//   2. IDEMPOTENCY: when the same canonical state arrives twice (bridge
//      reconnects, retries, race), the endpoint must not write to the
//      DB. Same applies if the call has already reached a TERMINAL
//      state (`ended` / `failed`) — we don't roll terminal calls back
//      into mid-lifecycle.

'use strict'

/**
 * The exact subset of AiCallSessionStatus that the bridge may set via
 * the lifecycle endpoint. Frozen so a typo in a caller fails loudly.
 */
const ALLOWED_INCOMING_STATES = Object.freeze(['greeting', 'active', 'transferring'])

/**
 * Canonical terminal states. Once a Call reaches one of these, no
 * subsequent state POST may overwrite it — that would mean rolling a
 * finished call back into the middle of its lifecycle.
 */
const TERMINAL_STATES = Object.freeze(['ended', 'failed'])

/**
 * Predicate: is `state` a value bridge is permitted to POST?
 *
 * @param {unknown} state
 * @returns {boolean}
 */
function isAllowedState(state) {
    return typeof state === 'string' && ALLOWED_INCOMING_STATES.includes(state)
}

/**
 * Predicate: SHOULD we skip the DB write?
 *
 * Returns `true` when:
 *   - the target equals the current value (no-op, idempotent), OR
 *   - the current value is terminal (`ended`, `failed`) — we must not
 *     un-finalize a call.
 *
 * Returns `false` when the transition is a real, meaningful change
 * the endpoint should persist.
 *
 * @param {string|null|undefined} current — value already in `Call.aiSessionStatus`
 * @param {string} target  — value the bridge is asking us to set
 * @returns {boolean} true = skip the write
 */
function isIdempotentNoOp(current, target) {
    if (current === target) return true
    if (current && TERMINAL_STATES.includes(current)) return true
    return false
}

module.exports = {
    ALLOWED_INCOMING_STATES,
    TERMINAL_STATES,
    isAllowedState,
    isIdempotentNoOp,
}
