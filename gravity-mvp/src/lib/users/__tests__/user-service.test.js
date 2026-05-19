// Unit regression for the `pickUserById` helper that backs
// `getCurrentUser`. We test the predicate directly because:
//
//   - `getCurrentUser` itself depends on `cookies()` from `next/headers`
//     and `fs.readFile`, which require either a running Next.js server
//     or a TypeScript loader inside the test runner. Both add weight
//     this PR doesn't want.
//   - The interesting property — «anonymous (no/unknown id) MUST resolve
//     to null» — lives entirely in the helper. The cookie-reading half
//     is a single line of glue around it.
//
// Run: `node --test src/lib/users/__tests__/user-service.test.js`
// Zero new dependencies.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { pickUserById } = require('../auth-helpers')

// A tiny fixture that mirrors the real shape (incl. the historically
// dangerous `u3` Руководитель). We use the actual id `'u3'` here on
// purpose — to encode the regression «never accidentally resolve to u3
// in an anonymous case again» as an executable assertion.
const FIXTURE = Object.freeze([
    { id: 'u1', firstName: 'Anna',  lastName: 'Manager', role: 'Менеджер',     status: 'Активен' },
    { id: 'u2', firstName: 'Boris', lastName: 'Manager', role: 'Менеджер',     status: 'Активен' },
    { id: 'u3', firstName: 'Carol', lastName: 'Boss',    role: 'Руководитель', status: 'Активен' },
])

// ── 1. undefined id → null (no cookie at all) ──────────────────────────

test('undefined id resolves to null (anonymous request)', () => {
    assert.equal(pickUserById(FIXTURE, undefined), null)
})

// ── 2. empty string → null (cookie exists but value is "") ─────────────

test('empty string id resolves to null', () => {
    assert.equal(pickUserById(FIXTURE, ''), null)
})

// ── 3. unknown id → null (cookie holds a stale / never-existed id) ─────

test('unknown id resolves to null', () => {
    assert.equal(pickUserById(FIXTURE, 'u9999'), null)
})

// ── 4. known id → the matching user ────────────────────────────────────

test('known id returns the matching user object', () => {
    const u = pickUserById(FIXTURE, 'u1')
    assert.equal(u?.id, 'u1')
    assert.equal(u?.role, 'Менеджер')
})

// ── 5. empty pool + valid-looking id → null ────────────────────────────
// Covers the (admittedly unlikely) edge where `users.json` is missing
// or unparseable. `getUsers` catches the throw and returns `[]`, so the
// helper must not panic on an empty array.

test('empty user pool resolves to null even for a syntactically valid id', () => {
    assert.equal(pickUserById([], 'u3'), null)
})

// ── 6. regression anchor: u3 is NOT a privileged default ───────────────
// The whole point of this PR — there used to be a hard-coded
// `if (!id) id = 'u3'` upstream. Anyone tempted to «just put it back»
// has to remove this test first, which forces them to read the security
// debt note alongside.

test('u3 is NOT picked up from an anonymous (undefined id) request', () => {
    const u = pickUserById(FIXTURE, undefined)
    assert.equal(u, null, 'anonymous must not resolve to any user, including u3')
})
