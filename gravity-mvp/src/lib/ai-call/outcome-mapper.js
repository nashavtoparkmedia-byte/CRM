// Deterministic mapper: bridge finalize payload → structured outcome.
//
// Why this exists
// ───────────────
// Before this module, AI-call qualification was opaque LLM output stored
// as `Call.aiAnalysis Json`. SQL analytics couldn't query "how many
// qualified leads from Moscow this week" without parsing JSON. A/B
// testing was impossible because there was no canonical success metric
// at the row level.
//
// This module is the FIRST mapping step:
//   bridge finalize body  →  AiOutcome enum + slug reason
//                         →  Call.aiOutcome / .aiOutcomeReason
//
// Combined with `scenario-schema.js` (which structures lead_data into
// canonical-keyed fields), the AI-call result becomes a first-class
// row, queryable by Prisma / SQL.
//
// Outcome semantics (architect-defined, exactly these 6 values)
// ─────────────────────────────────────────────────────────────
//   qualified           — LLM reached end_call(qualification_status=qualified)
//   not_qualified       — LLM reached end_call(qualification_status=not_qualified)
//   unclear_engaged     — lead engaged but qualification unclear; OR LLM
//                         requested human transfer. Manager task may exist.
//   dropped_mid_call    — lead spoke at least once then hung up before
//                         the LLM could end the call (no qualification_status)
//   dropped_no_input    — silence dominant; lead never gave real speech
//                         (silence-timeout path OR pre-greeting hangup)
//   error               — bridge / STT / LLM technical failure
//
// The `reason` slug is short, machine-friendly, snake_case. NOT a
// human-readable summary — that lives in `lead_summary` / `aiSummary`.
// Used for filtering ("WHERE aiOutcomeReason = 'llm_transferred_to_manager'").
//
// Out of scope
// ────────────
// - Lead-data structuring (see scenario-schema.js)
// - Qualification score computation (LLM returns it; we just persist)
// - Manager-task creation logic (stays in finalize route.ts)
// - Forensic preservation of raw aiAnalysis (stays in finalize route.ts)

'use strict'

const OUTCOME_VALUES = Object.freeze([
    'qualified',
    'not_qualified',
    'unclear_engaged',
    'dropped_mid_call',
    'dropped_no_input',
    'error',
])

/**
 * Compute the structured outcome from a finalize call's inputs.
 *
 * Pure function — no DB access, no logging, no side effects. Caller
 * persists the returned values via the appropriate Prisma update.
 *
 * Inputs
 * ──────
 *   @param {Object | null} aiAnalysis
 *     The `result` object the bridge sent in the finalize body (already
 *     normalised by route.ts into aiAnalysisPayload shape). Null when
 *     the bridge had no LLM final result (lead hung up before end_call).
 *     Keys we read: `qualification_status`, `transfer_reason`.
 *
 *   @param {string} reason
 *     The bridge's reason string: 'completed' | 'transferred' | 'closed'
 *     | 'failed' | other.
 *
 *   @param {string} sessionStatus
 *     AiCallSessionStatus already computed from reason ('ended' /
 *     'transferring' / 'failed'). Doubled-up signal lets us catch
 *     `failed` even if `reason` is something we don't know.
 *
 *   @param {number} realUserUtterances
 *     How many *real* STT-derived user turns happened. Synthetic
 *     bridge-side wake-up messages (silence-timeout injection) are
 *     NOT counted here — they live in `messages` but not in this
 *     counter. Bridge sends this field. Undefined / missing is
 *     treated as 0 for back-compat with pre-PR bridges.
 *
 * Returns { outcome, reason } where outcome ∈ OUTCOME_VALUES and reason
 * is a short snake_case slug.
 */
function computeOutcome({ aiAnalysis, reason, sessionStatus, realUserUtterances }) {
    // Hard failure first — never reinterpret a bridge/transport error
    // as a business outcome.
    if (sessionStatus === 'failed' || reason === 'failed') {
        return { outcome: 'error', reason: 'bridge_failed' }
    }

    const qStatus = aiAnalysis?.qualification_status
    const transferReason = aiAnalysis?.transfer_reason
    const hadSpeech = (realUserUtterances ?? 0) > 0

    // Explicit LLM verdict paths.
    if (qStatus === 'qualified') {
        return { outcome: 'qualified', reason: 'llm_qualified' }
    }
    if (qStatus === 'not_qualified') {
        return { outcome: 'not_qualified', reason: 'llm_not_qualified' }
    }

    // `unclear` from LLM splits into three different operational states
    // depending on WHY it's unclear. Manager wants to see these
    // separately in the queue.
    if (qStatus === 'unclear') {
        if (transferReason) {
            // Lead asked for human (or LLM hit transfer_to_manager).
            // A manager task is already created by finalize route.
            return { outcome: 'unclear_engaged', reason: 'llm_transferred_to_manager' }
        }
        if (hadSpeech) {
            // LLM gave up — questions didn't yield a clear answer.
            return { outcome: 'unclear_engaged', reason: 'llm_unclear_after_engagement' }
        }
        // qStatus='unclear' WITHOUT user speech happens on the silence-
        // timeout path: the bridge synthesises a "long silence" message,
        // the model dutifully calls end_call(unclear), but no real STT
        // final ever fired. This is a dropout, not engagement.
        return { outcome: 'dropped_no_input', reason: 'silence_after_no_speech' }
    }

    // No LLM verdict — lead hung up before end_call was reached.
    if (hadSpeech) {
        return { outcome: 'dropped_mid_call', reason: 'user_hangup_mid_call' }
    }
    return { outcome: 'dropped_no_input', reason: 'no_user_speech_detected' }
}

/**
 * Append a validation-issues tag to the outcome reason so an SQL
 * query can find rows where the LLM returned lead_data that didn't
 * conform to the scenario's outcomeSchema.
 *
 *   tagWithValidationIssues('llm_qualified', 0)
 *     → 'llm_qualified'
 *   tagWithValidationIssues('llm_qualified', 3)
 *     → 'llm_qualified;validation_issues=3'
 *
 * Kept tiny on purpose — operators write `WHERE aiOutcomeReason
 * LIKE '%validation_issues=%'` to find rows worth manual review.
 */
function tagWithValidationIssues(reason, issueCount) {
    if (!issueCount || issueCount <= 0) return reason
    return `${reason};validation_issues=${issueCount}`
}

/**
 * Clamp the LLM-provided qualification score into the storable
 * 0–100 integer range. Returns null for non-numeric / out-of-band
 * inputs so the DB column stays null rather than carrying garbage.
 */
function normalizeQualificationScore(raw) {
    if (raw === null || raw === undefined) return null
    const num = Number(raw)
    if (!Number.isFinite(num)) return null
    const int = Math.round(num)
    if (int < 0) return 0
    if (int > 100) return 100
    return int
}

module.exports = {
    computeOutcome,
    tagWithValidationIssues,
    normalizeQualificationScore,
    OUTCOME_VALUES,
}
