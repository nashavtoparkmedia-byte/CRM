// Conversation Recovery Layer v1 (PR #61).
//
// Why this exists
// ───────────────
// PR #60 ships STT garbage suppression: a known-garbage final no longer
// pollutes the LLM dialog. But suppression alone leaves the lead in a
// silence vacuum — the bot stops, the lead waits, the silence-timer
// eventually fires its second strike, and the call dies as
// `dropped_no_input` or `unclear`. Same for cases the bot didn't see
// any user speech after the greeting, or where STT returned a
// single-letter / fragment final.
//
// This module is a tiny deterministic policy: WHICH short recovery
// phrase (if any) should the bridge play, given WHAT triggered the
// recovery and HOW MANY recovery attempts have already happened?
//
// Pure function. No state, no async, no I/O. Caller (CallSession)
// owns the counter and the TTS speak side-effect.
//
// What this is NOT
// ────────────────
//   ❌ giant recovery framework
//   ❌ dialogue planner
//   ❌ behavior tree
//   ❌ probabilistic recovery engine
//   ❌ intent classifier
//   ❌ LLM memory layer
//   ❌ fuzzy heuristics explosion
//
// 50 lines of branch-and-return.
//
// Hard bounds
// ───────────
// Maximum 2 recoveries per call. Past that, the policy returns null
// action — the caller falls through to the existing silence-timer /
// end_call machinery and the call terminates naturally as
// `dropped_no_input` or `unclear_engaged`. Recovery is purely
// additive — it gives the dialog one or two chances to find footing;
// it does NOT replace existing terminal-state handling.
//
// Triggers + actions (v1)
// ───────────────────────
//   trigger                       → action          phrase
//   garbage (≥2 consecutive)      → retry_short     "Связь немного прерывается. ..."
//   silence_after_greeting        → reengage        "Вас слышно? ..."
//   ambiguous_short               → retry_short     "Не расслышал, повторите?"
//
// Adding more triggers / actions in a future PR is two lines plus a
// payload assertion — keep the action vocabulary tight.

'use strict'

const MAX_RECOVERY_ATTEMPTS = 2

const PHRASES = Object.freeze({
    retry_short_garbage:   'Связь немного прерывается. Повторите, пожалуйста.',
    retry_short_ambiguous: 'Не расслышал, повторите?',
    reengage:              'Вас слышно? Удобно говорить?',
})

const TRIGGERS = Object.freeze(new Set([
    'garbage',
    'silence_after_greeting',
    'ambiguous_short',
]))

const ACTIONS = Object.freeze(new Set([
    'retry_short',
    'reengage',
]))

/**
 * Decide what (if any) recovery action to take.
 *
 * Inputs:
 *   trigger             — see TRIGGERS
 *   consecutiveGarbage  — current run length of consecutive garbage
 *                         drops (only meaningful for trigger='garbage')
 *   recoveryAttempts    — how many recoveries have already fired on
 *                         this call. Caller increments BEFORE the next
 *                         call so this value reflects history at decision time.
 *
 * Output:
 *   { action, phrase, exhausted }
 *     action: 'retry_short' | 'reengage' | null
 *     phrase: string | null   (null when action is null)
 *     exhausted: boolean — true when recoveryAttempts ≥ MAX (caller
 *                           should NOT speak; let silence-timer take over)
 *
 * Pure function. NEVER throws. Safe to call from any code path.
 */
function decideRecoveryAction({ trigger, consecutiveGarbage, recoveryAttempts } = {}) {
    const attempts = typeof recoveryAttempts === 'number' ? recoveryAttempts : 0

    // Hard cap: after MAX attempts, recovery is exhausted. The call
    // falls through to silence-timer → graceful end_call unclear.
    if (attempts >= MAX_RECOVERY_ATTEMPTS) {
        return { action: null, phrase: null, exhausted: true }
    }

    if (trigger === 'garbage') {
        // First garbage drop is rare enough that silence-timer can
        // handle naturally. Only react after the SECOND consecutive
        // drop — that's a strong signal STT is corrupted and the
        // bot is in a dead zone.
        const consec = typeof consecutiveGarbage === 'number' ? consecutiveGarbage : 0
        if (consec >= 2) {
            return {
                action: 'retry_short',
                phrase: PHRASES.retry_short_garbage,
                exhausted: false,
            }
        }
        return { action: null, phrase: null, exhausted: false }
    }

    if (trigger === 'silence_after_greeting') {
        return {
            action: 'reengage',
            phrase: PHRASES.reengage,
            exhausted: false,
        }
    }

    if (trigger === 'ambiguous_short') {
        return {
            action: 'retry_short',
            phrase: PHRASES.retry_short_ambiguous,
            exhausted: false,
        }
    }

    // Unknown trigger — defensive no-op. Adding a new trigger is two
    // lines above; reaching here means a caller passed something we
    // didn't expect.
    return { action: null, phrase: null, exhausted: false }
}

/**
 * Detect ambiguous-short STT final.
 *
 * Heuristic: after stripping every non-letter character, the remaining
 * letter count is ≤ 1. This catches single-letter fillers ("э", "м",
 * "у", "а", "ы") and bare punctuation, but leaves valid short Russian
 * responses untouched ("да" 2 letters; "ОК" 2 letters; "нет" 3).
 *
 * Pure function. Returns boolean.
 *
 * Out of scope: NLP / semantic plausibility / confidence-based scoring.
 * If the final passes the existing garbage classifier (subtitle credits,
 * emoji, pure-non-Cyrillic > 3) AND has > 1 letter, the dialog
 * processes it normally even if it sounds odd to a human reader.
 */
function isAmbiguousShort(text) {
    if (typeof text !== 'string') return false
    const letters = text.replace(/[^A-Za-zА-Яа-яЁё]/gu, '')
    return letters.length <= 1
}

module.exports = {
    decideRecoveryAction,
    isAmbiguousShort,
    MAX_RECOVERY_ATTEMPTS,
    PHRASES,
    TRIGGERS,
    ACTIONS,
}
