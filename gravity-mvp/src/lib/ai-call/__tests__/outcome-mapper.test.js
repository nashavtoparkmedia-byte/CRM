// Unit regression for the AI-call outcome mapper.
//
// Covers every branch of the architect-defined decision tree:
//   qualified / not_qualified / unclear_engaged (engaged & transferred)
//   / dropped_mid_call / dropped_no_input / error
//
// Pure function, no async, no DB — fast suite.
//
// Run: `node --test src/lib/ai-call/__tests__/outcome-mapper.test.js`

import test from 'node:test'
import assert from 'node:assert/strict'
import outcomeMapper from '../outcome-mapper.js'

const {
    computeOutcome,
    tagWithValidationIssues,
    normalizeQualificationScore,
    OUTCOME_VALUES,
} = outcomeMapper

// ════════════════════════════════════════════════════════════════════
// Enum surface
// ════════════════════════════════════════════════════════════════════

test('OUTCOME_VALUES is exactly the 6 architect-defined values, frozen', () => {
    assert.deepEqual([...OUTCOME_VALUES], [
        'qualified',
        'not_qualified',
        'unclear_engaged',
        'dropped_mid_call',
        'dropped_no_input',
        'error',
    ])
    assert.equal(Object.isFrozen(OUTCOME_VALUES), true)
})

// ════════════════════════════════════════════════════════════════════
// Error path takes precedence over LLM output
// ════════════════════════════════════════════════════════════════════

test('sessionStatus=failed → error, never reinterpreted', () => {
    const r = computeOutcome({
        aiAnalysis: { qualification_status: 'qualified' },
        reason: 'completed',
        sessionStatus: 'failed',
        realUserUtterances: 5,
    })
    assert.equal(r.outcome, 'error')
    assert.equal(r.reason, 'bridge_failed')
})

test('reason=failed → error', () => {
    const r = computeOutcome({
        aiAnalysis: null,
        reason: 'failed',
        sessionStatus: 'ended',
        realUserUtterances: 0,
    })
    assert.equal(r.outcome, 'error')
})

// ════════════════════════════════════════════════════════════════════
// Explicit LLM verdict paths
// ════════════════════════════════════════════════════════════════════

test('qualification_status=qualified → qualified / llm_qualified', () => {
    const r = computeOutcome({
        aiAnalysis: { qualification_status: 'qualified' },
        reason: 'completed',
        sessionStatus: 'ended',
        realUserUtterances: 7,
    })
    assert.equal(r.outcome, 'qualified')
    assert.equal(r.reason, 'llm_qualified')
})

test('qualification_status=not_qualified → not_qualified / llm_not_qualified', () => {
    const r = computeOutcome({
        aiAnalysis: { qualification_status: 'not_qualified' },
        reason: 'completed',
        sessionStatus: 'ended',
        realUserUtterances: 3,
    })
    assert.equal(r.outcome, 'not_qualified')
    assert.equal(r.reason, 'llm_not_qualified')
})

// ════════════════════════════════════════════════════════════════════
// unclear — splits three ways
// ════════════════════════════════════════════════════════════════════

test('unclear + transfer_reason → unclear_engaged / llm_transferred_to_manager', () => {
    const r = computeOutcome({
        aiAnalysis: {
            qualification_status: 'unclear',
            transfer_reason: 'клиент попросил человека',
        },
        reason: 'transferred',
        sessionStatus: 'transferring',
        realUserUtterances: 4,
    })
    assert.equal(r.outcome, 'unclear_engaged')
    assert.equal(r.reason, 'llm_transferred_to_manager')
})

test('unclear, no transfer_reason, had speech → unclear_engaged / llm_unclear_after_engagement', () => {
    const r = computeOutcome({
        aiAnalysis: { qualification_status: 'unclear' },
        reason: 'completed',
        sessionStatus: 'ended',
        realUserUtterances: 2,
    })
    assert.equal(r.outcome, 'unclear_engaged')
    assert.equal(r.reason, 'llm_unclear_after_engagement')
})

test('unclear, no transfer_reason, NO real speech → dropped_no_input', () => {
    // This is the silence-timeout path: bridge synthesizes a fake user
    // turn, LLM dutifully end_calls with unclear, but no real STT
    // final ever fired. We classify as drop, not engagement.
    const r = computeOutcome({
        aiAnalysis: { qualification_status: 'unclear' },
        reason: 'completed',
        sessionStatus: 'ended',
        realUserUtterances: 0,
    })
    assert.equal(r.outcome, 'dropped_no_input')
    assert.equal(r.reason, 'silence_after_no_speech')
})

// ════════════════════════════════════════════════════════════════════
// Lead hung up before end_call
// ════════════════════════════════════════════════════════════════════

test('no aiAnalysis, had speech → dropped_mid_call / user_hangup_mid_call', () => {
    const r = computeOutcome({
        aiAnalysis: null,
        reason: 'closed',
        sessionStatus: 'ended',
        realUserUtterances: 3,
    })
    assert.equal(r.outcome, 'dropped_mid_call')
    assert.equal(r.reason, 'user_hangup_mid_call')
})

test('no aiAnalysis, no speech → dropped_no_input / no_user_speech_detected', () => {
    const r = computeOutcome({
        aiAnalysis: null,
        reason: 'closed',
        sessionStatus: 'ended',
        realUserUtterances: 0,
    })
    assert.equal(r.outcome, 'dropped_no_input')
    assert.equal(r.reason, 'no_user_speech_detected')
})

test('aiAnalysis present but no qualification_status, had speech → dropped_mid_call', () => {
    // Bridge edge case: result object exists but qualification_status
    // is missing (malformed LLM output). Treat as "no verdict".
    const r = computeOutcome({
        aiAnalysis: { lead_summary: 'something' },
        reason: 'closed',
        sessionStatus: 'ended',
        realUserUtterances: 2,
    })
    assert.equal(r.outcome, 'dropped_mid_call')
})

// ════════════════════════════════════════════════════════════════════
// Defensive: undefined / missing inputs
// ════════════════════════════════════════════════════════════════════

test('realUserUtterances undefined → treated as 0', () => {
    const r = computeOutcome({
        aiAnalysis: null,
        reason: 'closed',
        sessionStatus: 'ended',
        // realUserUtterances intentionally omitted
    })
    assert.equal(r.outcome, 'dropped_no_input')
})

test('aiAnalysis undefined and aiAnalysis null map identically', () => {
    const a = computeOutcome({ aiAnalysis: undefined, reason: 'closed', sessionStatus: 'ended', realUserUtterances: 1 })
    const b = computeOutcome({ aiAnalysis: null,      reason: 'closed', sessionStatus: 'ended', realUserUtterances: 1 })
    assert.deepEqual(a, b)
})

// Reason slugs are all machine-friendly (snake_case, lower, no spaces).
test('all returned reason slugs are snake_case machine slugs', () => {
    const cases = [
        { aiAnalysis: { qualification_status: 'qualified' },     realUserUtterances: 1 },
        { aiAnalysis: { qualification_status: 'not_qualified' }, realUserUtterances: 1 },
        { aiAnalysis: { qualification_status: 'unclear', transfer_reason: 'x' }, realUserUtterances: 1 },
        { aiAnalysis: { qualification_status: 'unclear' },       realUserUtterances: 2 },
        { aiAnalysis: { qualification_status: 'unclear' },       realUserUtterances: 0 },
        { aiAnalysis: null, realUserUtterances: 2 },
        { aiAnalysis: null, realUserUtterances: 0 },
    ]
    for (const c of cases) {
        const r = computeOutcome({ ...c, reason: 'completed', sessionStatus: 'ended' })
        assert.match(r.reason, /^[a-z][a-z0-9_]*$/, `slug='${r.reason}'`)
    }
})

// ════════════════════════════════════════════════════════════════════
// tagWithValidationIssues
// ════════════════════════════════════════════════════════════════════

test('tagWithValidationIssues: 0 issues → unchanged', () => {
    assert.equal(tagWithValidationIssues('llm_qualified', 0), 'llm_qualified')
})

test('tagWithValidationIssues: positive count → appended', () => {
    assert.equal(tagWithValidationIssues('llm_qualified', 3),
                 'llm_qualified;validation_issues=3')
})

test('tagWithValidationIssues: null/undefined safe', () => {
    assert.equal(tagWithValidationIssues('x', null), 'x')
    assert.equal(tagWithValidationIssues('x', undefined), 'x')
})

// ════════════════════════════════════════════════════════════════════
// normalizeQualificationScore
// ════════════════════════════════════════════════════════════════════

test('normalizeQualificationScore: integer in range passes', () => {
    assert.equal(normalizeQualificationScore(0), 0)
    assert.equal(normalizeQualificationScore(50), 50)
    assert.equal(normalizeQualificationScore(100), 100)
})

test('normalizeQualificationScore: clamps out-of-range', () => {
    assert.equal(normalizeQualificationScore(-10), 0)
    assert.equal(normalizeQualificationScore(200), 100)
})

test('normalizeQualificationScore: rounds floats', () => {
    assert.equal(normalizeQualificationScore(72.3), 72)
    assert.equal(normalizeQualificationScore(72.7), 73)
})

test('normalizeQualificationScore: numeric string', () => {
    assert.equal(normalizeQualificationScore('85'), 85)
})

test('normalizeQualificationScore: null / undefined / NaN → null', () => {
    assert.equal(normalizeQualificationScore(null), null)
    assert.equal(normalizeQualificationScore(undefined), null)
    assert.equal(normalizeQualificationScore('abc'), null)
    assert.equal(normalizeQualificationScore(NaN), null)
})
