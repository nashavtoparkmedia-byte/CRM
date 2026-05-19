// Unit regression for the `canLogin` policy that backs the `login()`
// server action. Tests the pure predicate; `login()` itself is a thin
// wrapper that reads the cookie, resolves the current user, calls this
// predicate, and either writes a cookie or throws.
//
// Run: `node --test src/lib/users/__tests__/login.test.js`
// Zero new dependencies.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { canLogin } = require('../auth-helpers')

// Fixture matches the shape of `src/data/users.json`. We deliberately
// include all three roles + Менеджер `u4` so we can exercise the
// «manager self-relogin allowed» branch with a non-u3 target as well.
const FIXTURE = Object.freeze([
    { id: 'u1', role: 'Менеджер',     firstName: 'Anna',  lastName: 'M', status: 'Активен' },
    { id: 'u2', role: 'Администратор', firstName: 'Boris', lastName: 'A', status: 'Активен' },
    { id: 'u3', role: 'Руководитель', firstName: 'Carol', lastName: 'S', status: 'Активен' },
    { id: 'u4', role: 'Менеджер',     firstName: 'Diana', lastName: 'M', status: 'Активен' },
])

// ── 1. anonymous → any identity allowed ────────────────────────────────

test('anonymous can login to any identity (onboarding flow stays open)', () => {
    for (const target of FIXTURE) {
        const v = canLogin({ currentUser: null, targetUserId: target.id, allUsers: FIXTURE })
        assert.equal(v.allowed, true, `anonymous → ${target.id} should be allowed`)
    }
})

// ── 2. admin → any identity allowed ────────────────────────────────────

test('Администратор can switch to any identity (multi-role QA)', () => {
    const admin = FIXTURE.find(u => u.role === 'Администратор')
    for (const target of FIXTURE) {
        const v = canLogin({ currentUser: admin, targetUserId: target.id, allUsers: FIXTURE })
        assert.equal(v.allowed, true, `admin ${admin.id} → ${target.id} should be allowed`)
    }
})

// ── 3. supervisor → any identity allowed ───────────────────────────────

test('Руководитель can switch to any identity (operational review)', () => {
    const supervisor = FIXTURE.find(u => u.role === 'Руководитель')
    for (const target of FIXTURE) {
        const v = canLogin({ currentUser: supervisor, targetUserId: target.id, allUsers: FIXTURE })
        assert.equal(v.allowed, true, `supervisor ${supervisor.id} → ${target.id} should be allowed`)
    }
})

// ── 4. manager → self-login allowed (cookie refresh / recovery) ────────

test('Менеджер can re-login as themselves (cookie refresh / recovery)', () => {
    const manager = FIXTURE.find(u => u.id === 'u1')
    const v = canLogin({ currentUser: manager, targetUserId: 'u1', allUsers: FIXTURE })
    assert.equal(v.allowed, true)
    assert.equal(v.reason, null)
})

// ── 5. manager → any other identity blocked ────────────────────────────

test('Менеджер cannot login as another user (escalation blocked)', () => {
    const manager = FIXTURE.find(u => u.id === 'u1')
    // u3 — Руководитель: classic escalation vector
    const v1 = canLogin({ currentUser: manager, targetUserId: 'u3', allUsers: FIXTURE })
    assert.equal(v1.allowed, false)
    assert.equal(v1.reason, 'manager_escalation_blocked')

    // u2 — Администратор: also blocked
    const v2 = canLogin({ currentUser: manager, targetUserId: 'u2', allUsers: FIXTURE })
    assert.equal(v2.allowed, false)
    assert.equal(v2.reason, 'manager_escalation_blocked')

    // u4 — peer Менеджер: still blocked. Even «sideways» moves between
    // managers are denied — we don't have a use case for one Менеджер
    // impersonating another, and the safer policy is «self only».
    const v3 = canLogin({ currentUser: manager, targetUserId: 'u4', allUsers: FIXTURE })
    assert.equal(v3.allowed, false)
    assert.equal(v3.reason, 'manager_escalation_blocked')
})

// ── 6. unknown target id blocked (regardless of current role) ──────────

test('unknown target id is rejected (never writes garbage into the cookie)', () => {
    // Even as an admin you can't login to a non-existent user — the
    // cookie would later resolve to `null` (since pickUserById misses)
    // and silently masquerade as anonymous.
    const admin = FIXTURE.find(u => u.role === 'Администратор')
    const v = canLogin({ currentUser: admin, targetUserId: 'u9999', allUsers: FIXTURE })
    assert.equal(v.allowed, false)
    assert.equal(v.reason, 'unknown_target')

    // From anonymous too: prevents typo-induced ghost sessions.
    const va = canLogin({ currentUser: null, targetUserId: 'u9999', allUsers: FIXTURE })
    assert.equal(va.allowed, false)
    assert.equal(va.reason, 'unknown_target')
})

// ── bonus: empty / undefined target id is rejected ─────────────────────
// Not in the explicit 6-case list, but covers an obvious mis-call shape
// (typo in caller, race during page-load, etc.). The reason tag is
// distinct from `unknown_target` so logs can differentiate.

test('empty or undefined target id is rejected', () => {
    const admin = FIXTURE.find(u => u.role === 'Администратор')
    for (const bad of [undefined, '', null]) {
        const v = canLogin({ currentUser: admin, targetUserId: bad, allUsers: FIXTURE })
        assert.equal(v.allowed, false)
        assert.equal(v.reason, 'empty_target', `bad=${JSON.stringify(bad)}`)
    }
})
