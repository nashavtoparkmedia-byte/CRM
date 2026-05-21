// Unit regression for the Greeting Optimization Layer v1 (PR #62).
//
// Locks: deterministic hashing, uniform bucketing, no-variants falls
// through to legacy LLM path, malformed variants skipped.
//
// Run: `node --test __tests__/greeting-variants.test.js`

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('crypto')

const { pickGreetingVariant, hashStringToInt } = require('../greeting-variants')

// ════════════════════════════════════════════════════════════════════
// hashStringToInt — deterministic + non-negative
// ════════════════════════════════════════════════════════════════════

test('hashStringToInt: same input → same output (deterministic)', () => {
    const id = 'cmpcge1tc0000vpwksi2kumg6'
    assert.equal(hashStringToInt(id), hashStringToInt(id))
})

test('hashStringToInt: empty / non-string → 0', () => {
    assert.equal(hashStringToInt(''), 0)
    assert.equal(hashStringToInt(null), 0)
    assert.equal(hashStringToInt(undefined), 0)
    assert.equal(hashStringToInt(42), 0)
})

test('hashStringToInt: always non-negative (no two\'s-complement leak)', () => {
    // Generate a bunch of UUIDs; assert all hashes are ≥ 0.
    for (let i = 0; i < 200; i++) {
        const h = hashStringToInt(randomUUID())
        assert.ok(h >= 0, `hash for UUID was negative: ${h}`)
    }
})

// ════════════════════════════════════════════════════════════════════
// pickGreetingVariant — null-path (legacy LLM greeting)
// ════════════════════════════════════════════════════════════════════

test('pickGreetingVariant: no scenario → null', () => {
    assert.equal(pickGreetingVariant({ callUuid: 'x' }), null)
    assert.equal(pickGreetingVariant({ callUuid: 'x', scenario: null }), null)
})

test('pickGreetingVariant: scenario without greetingVariants → null', () => {
    assert.equal(pickGreetingVariant({ callUuid: 'x', scenario: { id: 's1', name: 'demo' } }), null)
})

test('pickGreetingVariant: empty variants array → null', () => {
    assert.equal(pickGreetingVariant({
        callUuid: 'x', scenario: { greetingVariants: [] },
    }), null)
})

test('pickGreetingVariant: greetingVariants not an array → null', () => {
    assert.equal(pickGreetingVariant({
        callUuid: 'x', scenario: { greetingVariants: 'oops' },
    }), null)
})

test('pickGreetingVariant: all variants malformed → null', () => {
    const scenario = {
        greetingVariants: [
            { id: '', text: 'hi' },              // missing id
            { id: 'A', text: '' },               // empty text
            { id: 'B', text: '   ' },            // whitespace text
            { foo: 'bar' },                      // missing both
        ],
    }
    assert.equal(pickGreetingVariant({ callUuid: 'x', scenario }), null)
})

// ════════════════════════════════════════════════════════════════════
// pickGreetingVariant — happy path
// ════════════════════════════════════════════════════════════════════

test('pickGreetingVariant: single valid variant → always that variant', () => {
    const scenario = { greetingVariants: [{ id: 'A', text: 'Здравствуйте!' }] }
    for (let i = 0; i < 50; i++) {
        const r = pickGreetingVariant({ callUuid: randomUUID(), scenario })
        assert.equal(r.id, 'A')
        assert.equal(r.text, 'Здравствуйте!')
    }
})

test('pickGreetingVariant: same callUuid → same variant (idempotent)', () => {
    const scenario = {
        greetingVariants: [
            { id: 'A', text: 'one' },
            { id: 'B', text: 'two' },
            { id: 'C', text: 'three' },
        ],
    }
    const uuid = 'cmp01-stable-call-id'
    const first = pickGreetingVariant({ callUuid: uuid, scenario })
    for (let i = 0; i < 10; i++) {
        assert.deepEqual(
            pickGreetingVariant({ callUuid: uuid, scenario }),
            first,
            'same UUID → same variant on each call',
        )
    }
})

test('pickGreetingVariant: 3 variants → all 3 used over many UUIDs (uniform-ish)', () => {
    const scenario = {
        greetingVariants: [
            { id: 'A', text: 'one' },
            { id: 'B', text: 'two' },
            { id: 'C', text: 'three' },
        ],
    }
    const buckets = { A: 0, B: 0, C: 0 }
    for (let i = 0; i < 300; i++) {
        const v = pickGreetingVariant({ callUuid: randomUUID(), scenario })
        buckets[v.id] += 1
    }
    // Each bucket should have ≥ 15% of the 300 (i.e., ≥ 45) — loose
    // bound to avoid CI flake while still detecting a degenerate hash.
    for (const id of ['A', 'B', 'C']) {
        assert.ok(buckets[id] >= 45,
            `bucket ${id} got ${buckets[id]} / 300 — distribution too skewed`)
    }
    // All variants saw traffic.
    assert.equal(buckets.A + buckets.B + buckets.C, 300)
})

test('pickGreetingVariant: malformed-mixed-with-valid → skips bad rows', () => {
    const scenario = {
        greetingVariants: [
            { id: 'BAD', text: '' },      // skipped (empty text)
            { id: 'A',   text: 'one' },
            { id: 'B',   text: 'two' },
        ],
    }
    const ids = new Set()
    for (let i = 0; i < 50; i++) {
        ids.add(pickGreetingVariant({ callUuid: randomUUID(), scenario }).id)
    }
    assert.ok(ids.has('A'))
    assert.ok(ids.has('B'))
    assert.ok(!ids.has('BAD'), 'malformed row should never be returned')
})

// ════════════════════════════════════════════════════════════════════
// Defensive: never throws on weird inputs
// ════════════════════════════════════════════════════════════════════

test('pickGreetingVariant: NEVER throws on weird inputs', () => {
    pickGreetingVariant()
    pickGreetingVariant({})
    pickGreetingVariant({ callUuid: null, scenario: { greetingVariants: null } })
    pickGreetingVariant({ callUuid: 42, scenario: { greetingVariants: [{ id: 'A', text: 'x' }] } })
    // No assertions — the absence of a thrown exception IS the test.
})
