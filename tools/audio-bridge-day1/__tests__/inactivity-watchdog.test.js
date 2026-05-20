// Unit regression for the inactivity watchdog used by yandex-stt.js.
//
// The watchdog is pure (setTimeout-based, no I/O), so we can test the
// real timer semantics with very small windows. Tests run under 200 ms
// total.
//
// Run: `node --test __tests__/inactivity-watchdog.test.js`
// Zero new dependencies.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createInactivityWatchdog } = require('../inactivity-watchdog')

// Helper: deterministic «wait this many ms», used to assert the
// watchdog DID or DID NOT fire by a given point in time.
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// ── 1. fires onTimeout after the configured window ────────────────────

test('reset() then no further activity → onTimeout fires once', async () => {
    let fired = 0
    const w = createInactivityWatchdog({ timeoutMs: 30, onTimeout: () => fired++ })
    w.reset()
    await sleep(60)
    assert.equal(fired, 1, 'must fire exactly once after the window')
})

// ── 2. reset() before window elapses extends the deadline ─────────────

test('reset() before window elapses postpones the deadline (real streaming case)', async () => {
    let fired = 0
    const w = createInactivityWatchdog({ timeoutMs: 50, onTimeout: () => fired++ })
    w.reset()
    await sleep(20)        // halfway through the first window
    w.reset()              // simulate a partial/final event arriving
    await sleep(40)        // 60 ms total, but only 40 since the LAST reset
    assert.equal(fired, 0, 'reset must postpone, not fire yet')
    await sleep(20)        // now 60 ms since last reset
    assert.equal(fired, 1, 'fires once the new window elapses')
})

// ── 3. clear() prevents firing ────────────────────────────────────────

test('clear() before window elapses → onTimeout never fires', async () => {
    let fired = 0
    const w = createInactivityWatchdog({ timeoutMs: 30, onTimeout: () => fired++ })
    w.reset()
    await sleep(10)
    w.clear()
    await sleep(60)
    assert.equal(fired, 0, 'clear must prevent the fire')
})

// ── 4. clear() is idempotent ──────────────────────────────────────────

test('clear() is safe to call multiple times', () => {
    const w = createInactivityWatchdog({ timeoutMs: 10_000, onTimeout: () => {} })
    w.reset()
    w.clear()
    w.clear()
    w.clear()      // must not throw
})

// ── 5. reset() after clear() re-arms normally ─────────────────────────

test('reset() after clear() re-arms the timer', async () => {
    let fired = 0
    const w = createInactivityWatchdog({ timeoutMs: 30, onTimeout: () => fired++ })
    w.reset()
    w.clear()
    await sleep(40)
    assert.equal(fired, 0, 'cleared timer must not fire')
    w.reset()
    await sleep(60)
    assert.equal(fired, 1, 're-armed timer must fire')
})

// ── 6. onTimeout fires AT MOST ONCE per arm cycle ─────────────────────

test('onTimeout fires exactly once per arm — no double-fire on long sleep', async () => {
    let fired = 0
    const w = createInactivityWatchdog({ timeoutMs: 20, onTimeout: () => fired++ })
    w.reset()
    await sleep(200)       // 10× the window — exactly one fire expected
    assert.equal(fired, 1, 'one arm → one fire, regardless of elapsed time')
    w.clear()
})

// ── 7. zero-cost when never reset() ───────────────────────────────────
// Edge: caller built the watchdog but never armed it. Should be a no-op
// holding no timer references — Node event loop should exit without it.

test('watchdog with no reset() never fires', async () => {
    let fired = 0
    createInactivityWatchdog({ timeoutMs: 10, onTimeout: () => fired++ })
    await sleep(50)
    assert.equal(fired, 0, 'unarmed watchdog must not fire')
})
