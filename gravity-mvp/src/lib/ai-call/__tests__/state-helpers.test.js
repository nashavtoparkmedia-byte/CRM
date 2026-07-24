// Unit regression for the pure policy helpers that back the
// /api/ai-calls/sessions/[id]/state endpoint. Per the architect's
// scope: helper-level tests only, no route-level framework coupling.
//
// Run: `node --test src/lib/ai-call/__tests__/state-helpers.test.js`
// Zero new dependencies.

import test from 'node:test'
import assert from 'node:assert/strict'
import stateHelpers from '../state-helpers.js'

const {
    ALLOWED_INCOMING_STATES,
    TERMINAL_STATES,
    isAllowedState,
    isIdempotentNoOp,
} = stateHelpers

// ────────────────────────────────────────────────────────────────────
// Allowlist policy
// ────────────────────────────────────────────────────────────────────

test('isAllowedState: greeting / active / transferring are accepted', () => {
    for (const s of ['greeting', 'active', 'transferring']) {
        assert.equal(isAllowedState(s), true, `state=${s} must be allowed`)
    }
})

test('isAllowedState: per-turn telemetry states are rejected', () => {
    // thinking / speaking / listening / idle are bridge-local; they
    // must never make it into Call.aiSessionStatus.
    for (const s of ['thinking', 'speaking', 'listening', 'idle']) {
        assert.equal(isAllowedState(s), false, `state=${s} must be rejected`)
    }
})

test('isAllowedState: terminal / pre-start states are rejected', () => {
    // starting is owned by /api/ai-calls/start; ended / failed by finalize.
    // /state endpoint must not let bridge usurp those transitions.
    for (const s of ['starting', 'ended', 'failed']) {
        assert.equal(isAllowedState(s), false, `state=${s} must be rejected`)
    }
})

test('isAllowedState: non-string / prototype-poisoning shapes are rejected', () => {
    for (const bad of [undefined, null, 42, true, {}, [], { toString: () => 'active' }]) {
        assert.equal(isAllowedState(bad), false, `bad=${JSON.stringify(bad)}`)
    }
})

// ────────────────────────────────────────────────────────────────────
// Idempotency policy
// ────────────────────────────────────────────────────────────────────

test('isIdempotentNoOp: same-state POST is a no-op (bridge retry / reconnect)', () => {
    assert.equal(isIdempotentNoOp('active', 'active'), true)
    assert.equal(isIdempotentNoOp('greeting', 'greeting'), true)
})

test('isIdempotentNoOp: terminal states cannot be rolled back', () => {
    // Once finalize has set ended/failed, no late /state POST from a
    // bridge that didn't realise the call was already over may write.
    assert.equal(isIdempotentNoOp('ended', 'active'), true,
        'ended → active must be skipped')
    assert.equal(isIdempotentNoOp('failed', 'active'), true,
        'failed → active must be skipped')
    assert.equal(isIdempotentNoOp('ended', 'greeting'), true)
    assert.equal(isIdempotentNoOp('failed', 'greeting'), true)
})

test('isIdempotentNoOp: real transitions are NOT skipped', () => {
    // The interesting transitions that this PR exists to capture:
    assert.equal(isIdempotentNoOp('starting', 'greeting'), false,
        'starting → greeting must write')
    assert.equal(isIdempotentNoOp('greeting', 'active'), false,
        'greeting → active must write')
    assert.equal(isIdempotentNoOp('active', 'transferring'), false,
        'active → transferring must write')
})

test('isIdempotentNoOp: null / undefined current is NOT terminal', () => {
    // Edge: Call row exists but aiSessionStatus has not yet been set.
    // First state-POST in that scenario must write — `null` is not a
    // terminal value.
    assert.equal(isIdempotentNoOp(null, 'greeting'), false)
    assert.equal(isIdempotentNoOp(undefined, 'greeting'), false)
})

// ────────────────────────────────────────────────────────────────────
// Frozen exports — guard against accidental policy widening
// ────────────────────────────────────────────────────────────────────

test('ALLOWED_INCOMING_STATES is exactly {greeting, active, transferring}', () => {
    assert.deepEqual(
        [...ALLOWED_INCOMING_STATES].sort(),
        ['active', 'greeting', 'transferring'].sort(),
    )
})

test('TERMINAL_STATES is exactly {ended, failed}', () => {
    assert.deepEqual(
        [...TERMINAL_STATES].sort(),
        ['ended', 'failed'].sort(),
    )
})
