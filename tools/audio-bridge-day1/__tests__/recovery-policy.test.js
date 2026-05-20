// Unit regression for the Conversation Recovery policy (PR #61).
//
// Locks the contract: bounded attempts, deterministic actions per
// trigger, tight ambiguous-short heuristic, no FP on valid short
// Russian responses.
//
// Run: `node --test __tests__/recovery-policy.test.js`

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
    decideRecoveryAction,
    isAmbiguousShort,
    MAX_RECOVERY_ATTEMPTS,
    PHRASES,
    TRIGGERS,
    ACTIONS,
} = require('../recovery-policy')

// ════════════════════════════════════════════════════════════════════
// Surface contract
// ════════════════════════════════════════════════════════════════════

test('MAX_RECOVERY_ATTEMPTS is 2 (architect-mandated cap)', () => {
    assert.equal(MAX_RECOVERY_ATTEMPTS, 2)
})

test('PHRASES are frozen, non-empty short strings (single sentence)', () => {
    assert.equal(Object.isFrozen(PHRASES), true)
    for (const [name, phrase] of Object.entries(PHRASES)) {
        assert.equal(typeof phrase, 'string', name)
        assert.ok(phrase.length > 0 && phrase.length < 80,
            `${name} should be 1 short sentence, got ${phrase.length} chars`)
    }
})

test('TRIGGERS / ACTIONS sets are frozen', () => {
    assert.equal(Object.isFrozen(TRIGGERS), true)
    assert.equal(Object.isFrozen(ACTIONS), true)
    assert.deepEqual([...TRIGGERS].sort(), [
        'ambiguous_short',
        'garbage',
        'silence_after_greeting',
    ])
    assert.deepEqual([...ACTIONS].sort(), [
        'reengage',
        'retry_short',
    ])
})

// ════════════════════════════════════════════════════════════════════
// Hard cap — MAX_RECOVERY_ATTEMPTS
// ════════════════════════════════════════════════════════════════════

test('attempts ≥ MAX → exhausted=true, action=null (across all triggers)', () => {
    for (const trigger of TRIGGERS) {
        const r = decideRecoveryAction({
            trigger,
            consecutiveGarbage: 5,
            recoveryAttempts: MAX_RECOVERY_ATTEMPTS,
        })
        assert.equal(r.action, null, trigger)
        assert.equal(r.phrase, null, trigger)
        assert.equal(r.exhausted, true, trigger)
    }
})

test('attempts > MAX → still exhausted', () => {
    const r = decideRecoveryAction({
        trigger: 'silence_after_greeting',
        recoveryAttempts: 5,
    })
    assert.equal(r.exhausted, true)
})

// ════════════════════════════════════════════════════════════════════
// Trigger: garbage
// ════════════════════════════════════════════════════════════════════

test('garbage, consecutive=1 → no-op (single drop ignored)', () => {
    const r = decideRecoveryAction({
        trigger: 'garbage',
        consecutiveGarbage: 1,
        recoveryAttempts: 0,
    })
    assert.equal(r.action, null)
    assert.equal(r.exhausted, false)
})

test('garbage, consecutive=2 → retry_short with garbage phrase', () => {
    const r = decideRecoveryAction({
        trigger: 'garbage',
        consecutiveGarbage: 2,
        recoveryAttempts: 0,
    })
    assert.equal(r.action, 'retry_short')
    assert.equal(r.phrase, PHRASES.retry_short_garbage)
    assert.equal(r.exhausted, false)
})

test('garbage, consecutive=3 → still retry_short', () => {
    const r = decideRecoveryAction({
        trigger: 'garbage',
        consecutiveGarbage: 3,
        recoveryAttempts: 0,
    })
    assert.equal(r.action, 'retry_short')
})

test('garbage, consecutive=0 / undefined → no-op', () => {
    assert.equal(decideRecoveryAction({ trigger: 'garbage', consecutiveGarbage: 0, recoveryAttempts: 0 }).action, null)
    assert.equal(decideRecoveryAction({ trigger: 'garbage', recoveryAttempts: 0 }).action, null)
})

// ════════════════════════════════════════════════════════════════════
// Trigger: silence_after_greeting
// ════════════════════════════════════════════════════════════════════

test('silence_after_greeting → reengage with reengage phrase', () => {
    const r = decideRecoveryAction({
        trigger: 'silence_after_greeting',
        recoveryAttempts: 0,
    })
    assert.equal(r.action, 'reengage')
    assert.equal(r.phrase, PHRASES.reengage)
    assert.equal(r.exhausted, false)
})

test('silence_after_greeting, attempts=1 → still allowed (< MAX)', () => {
    const r = decideRecoveryAction({
        trigger: 'silence_after_greeting',
        recoveryAttempts: 1,
    })
    assert.equal(r.action, 'reengage')
})

// ════════════════════════════════════════════════════════════════════
// Trigger: ambiguous_short
// ════════════════════════════════════════════════════════════════════

test('ambiguous_short → retry_short with ambiguous phrase', () => {
    const r = decideRecoveryAction({
        trigger: 'ambiguous_short',
        recoveryAttempts: 0,
    })
    assert.equal(r.action, 'retry_short')
    assert.equal(r.phrase, PHRASES.retry_short_ambiguous)
    assert.equal(r.exhausted, false)
})

// ════════════════════════════════════════════════════════════════════
// Defensive
// ════════════════════════════════════════════════════════════════════

test('unknown trigger → no-op, not exhausted', () => {
    const r = decideRecoveryAction({ trigger: 'foo', recoveryAttempts: 0 })
    assert.equal(r.action, null)
    assert.equal(r.phrase, null)
    assert.equal(r.exhausted, false)
})

test('no arguments → no-op', () => {
    const r = decideRecoveryAction({})
    assert.equal(r.action, null)
    assert.equal(r.exhausted, false)
})

test('undefined arguments → no-op', () => {
    const r = decideRecoveryAction()
    assert.equal(r.action, null)
})

test('NEVER throws on weird inputs', () => {
    // None of these should throw — recovery policy must be safe to call
    // from any code path including error handlers.
    decideRecoveryAction({ trigger: null })
    decideRecoveryAction({ trigger: 42 })
    decideRecoveryAction({ trigger: 'garbage', consecutiveGarbage: 'abc' })
    decideRecoveryAction({ trigger: 'garbage', recoveryAttempts: 'abc' })
    decideRecoveryAction({ trigger: 'garbage', recoveryAttempts: -1 })
})

// ════════════════════════════════════════════════════════════════════
// isAmbiguousShort — narrow heuristic, zero FP on Russian responses
// ════════════════════════════════════════════════════════════════════

test('isAmbiguousShort: single Cyrillic letter → true', () => {
    for (const s of ['э', 'м', 'у', 'а', 'ы', 'Э']) {
        assert.equal(isAmbiguousShort(s), true, s)
    }
})

test('isAmbiguousShort: single Latin letter → true', () => {
    assert.equal(isAmbiguousShort('A'), true)
})

test('isAmbiguousShort: with trailing punctuation → still single-letter → true', () => {
    assert.equal(isAmbiguousShort('э.'), true)
    assert.equal(isAmbiguousShort('у?'), true)
    assert.equal(isAmbiguousShort('а!!!'), true)
})

test('isAmbiguousShort: empty / whitespace → true (0 letters)', () => {
    assert.equal(isAmbiguousShort(''), true)
    assert.equal(isAmbiguousShort('   '), true)
    assert.equal(isAmbiguousShort('   ...   '), true)
})

test('isAmbiguousShort: valid short Russian responses → FALSE', () => {
    // FP floor: these are real lead responses that MUST pass through.
    for (const s of ['да', 'нет', 'ну', 'хм', 'ОК', 'OK', 'yes', 'no']) {
        assert.equal(isAmbiguousShort(s), false, s)
    }
})

test('isAmbiguousShort: longer Russian utterances → FALSE', () => {
    for (const s of [
        'есть права',
        'я водитель',
        'удобно говорить',
        'Здравствуйте',
        'я',  // wait — this is 1 letter
    ]) {
        if (s === 'я') {
            // Single "я" is technically 1 letter — heuristic flags it.
            // Documented behavior: 1-letter standalone IS ambiguous in
            // a phone-call context. Real-life "я" alone almost always
            // precedes more speech that STT bundled into a later final.
            assert.equal(isAmbiguousShort(s), true, s)
        } else {
            assert.equal(isAmbiguousShort(s), false, s)
        }
    }
})

test('isAmbiguousShort: digits-only → true (no letters)', () => {
    // STT shouldn't typically output bare digits, but if it does
    // (e.g., "123"), treat as ambiguous.
    assert.equal(isAmbiguousShort('123'), true)
})

test('isAmbiguousShort: non-string → false (defensive)', () => {
    assert.equal(isAmbiguousShort(null), false)
    assert.equal(isAmbiguousShort(undefined), false)
    assert.equal(isAmbiguousShort(42), false)
})
