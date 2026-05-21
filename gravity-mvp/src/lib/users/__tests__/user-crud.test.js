// Unit regression for the predicates that back the user-CRUD server
// actions (`addUser` / `updateUser` / `deleteUser`).
//
// All four predicates are pure functions in `auth-helpers.js`. The
// server-action wrappers in `user-service.ts` are thin: read cookie,
// resolve user, call predicate, throw on denial. The interesting
// behaviour lives in the helpers — testing them covers the policy
// exhaustively without needing to mock cookies / fs / Next.js.
//
// Run: `node --test src/lib/users/__tests__/user-crud.test.js`
// Zero new dependencies.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
    canManageUsers,
    isValidRole,
    wouldDeleteLastPrivileged,
    wouldDemoteLastPrivileged,
    PRIVILEGED_ROLES,
    VALID_ROLES,
} = require('../auth-helpers')

// ════════════════════════════════════════════════════════════════════
// canManageUsers — the role-tier policy
// ════════════════════════════════════════════════════════════════════

test('canManageUsers: anonymous (null) is denied', () => {
    assert.equal(canManageUsers(null), false)
})

test('canManageUsers: Менеджер is denied', () => {
    assert.equal(canManageUsers({ id: 'u1', role: 'Менеджер' }), false)
})

test('canManageUsers: Руководитель is allowed', () => {
    assert.equal(canManageUsers({ id: 'u3', role: 'Руководитель' }), true)
})

test('canManageUsers: Администратор is allowed', () => {
    assert.equal(canManageUsers({ id: 'u2', role: 'Администратор' }), true)
})

test('canManageUsers: unknown future role is denied (defense-in-depth)', () => {
    assert.equal(canManageUsers({ id: 'u99', role: 'Owner' }), false)
})

// ════════════════════════════════════════════════════════════════════
// isValidRole — the role-allowlist gate
// ════════════════════════════════════════════════════════════════════

test('isValidRole: accepts all three known roles', () => {
    for (const role of VALID_ROLES) {
        assert.equal(isValidRole(role), true, `role=${role}`)
    }
})

test('isValidRole: rejects unknown strings', () => {
    for (const bad of ['Owner', 'admin', 'РУКОВОДИТЕЛЬ', '', 'Manager']) {
        assert.equal(isValidRole(bad), false, `bad=${JSON.stringify(bad)}`)
    }
})

test('isValidRole: rejects non-string / prototype-poisoning shapes', () => {
    for (const bad of [undefined, null, 42, true, {}, [], { toString: () => 'Менеджер' }]) {
        assert.equal(isValidRole(bad), false, `bad=${JSON.stringify(bad)}`)
    }
})

// ════════════════════════════════════════════════════════════════════
// wouldDeleteLastPrivileged — invariant: ≥1 privileged operator must
// remain after the mutation.
// ════════════════════════════════════════════════════════════════════

// Fixture variants exercised below.
const SINGLE_PRIV = [
    { id: 'u1', role: 'Менеджер' },
    { id: 'u2', role: 'Администратор' },   // the only privileged user
]
const SINGLE_PRIV_SUPERVISOR = [
    { id: 'u1', role: 'Менеджер' },
    { id: 'u3', role: 'Руководитель' },    // the only privileged user
]
const MULTI_PRIV = [
    { id: 'u1', role: 'Менеджер' },
    { id: 'u2', role: 'Администратор' },
    { id: 'u3', role: 'Руководитель' },
]

test('wouldDeleteLastPrivileged: blocks deleting the only Администратор', () => {
    assert.equal(wouldDeleteLastPrivileged(SINGLE_PRIV, 'u2'), true)
})

test('wouldDeleteLastPrivileged: blocks deleting the only Руководитель', () => {
    assert.equal(wouldDeleteLastPrivileged(SINGLE_PRIV_SUPERVISOR, 'u3'), true)
})

test('wouldDeleteLastPrivileged: allows when another privileged user remains', () => {
    // Deleting u2 (Администратор) is fine — u3 (Руководитель) still
    // remains.
    assert.equal(wouldDeleteLastPrivileged(MULTI_PRIV, 'u2'), false)
})

test('wouldDeleteLastPrivileged: deleting a Менеджер is always safe', () => {
    assert.equal(wouldDeleteLastPrivileged(SINGLE_PRIV, 'u1'), false)
    assert.equal(wouldDeleteLastPrivileged(MULTI_PRIV, 'u1'), false)
})

// ════════════════════════════════════════════════════════════════════
// wouldDemoteLastPrivileged — same invariant, applied to role changes.
// ════════════════════════════════════════════════════════════════════

test('wouldDemoteLastPrivileged: blocks demoting the only Администратор to Менеджер', () => {
    assert.equal(
        wouldDemoteLastPrivileged(SINGLE_PRIV, 'u2', 'Менеджер'),
        true,
    )
})

test('wouldDemoteLastPrivileged: allows Администратор→Руководитель (still privileged)', () => {
    assert.equal(
        wouldDemoteLastPrivileged(SINGLE_PRIV, 'u2', 'Руководитель'),
        false,
    )
})

test('wouldDemoteLastPrivileged: allows demotion when another privileged user remains', () => {
    // Demoting u2 (Администратор) to Менеджер is fine — u3
    // (Руководитель) still privileged.
    assert.equal(
        wouldDemoteLastPrivileged(MULTI_PRIV, 'u2', 'Менеджер'),
        false,
    )
})

test('wouldDemoteLastPrivileged: no-op patches are not blocked', () => {
    // No role change in the patch.
    assert.equal(wouldDemoteLastPrivileged(SINGLE_PRIV, 'u2', undefined), false)
    assert.equal(wouldDemoteLastPrivileged(SINGLE_PRIV, 'u2', null), false)
})

test('wouldDemoteLastPrivileged: patching a Менеджер cannot break the invariant', () => {
    // Менеджер isn't privileged to begin with — demoting (or no-op-ing)
    // them can never reduce the privileged count.
    assert.equal(
        wouldDemoteLastPrivileged(SINGLE_PRIV, 'u1', 'Менеджер'),
        false,
    )
})

test('wouldDemoteLastPrivileged: unknown target id is a no-op', () => {
    // Update on a missing id won't actually mutate anything; the helper
    // should NOT block such a call (the caller's own update path is a
    // no-op too).
    assert.equal(
        wouldDemoteLastPrivileged(SINGLE_PRIV, 'u9999', 'Менеджер'),
        false,
    )
})

// ════════════════════════════════════════════════════════════════════
// Sanity: exported constants are what guards rely on.
// ════════════════════════════════════════════════════════════════════

test('PRIVILEGED_ROLES contains exactly Администратор and Руководитель', () => {
    assert.deepEqual([...PRIVILEGED_ROLES].sort(), ['Администратор', 'Руководитель'].sort())
})

test('VALID_ROLES contains all three known roles, nothing more', () => {
    assert.deepEqual(
        [...VALID_ROLES].sort(),
        ['Администратор', 'Менеджер', 'Руководитель'].sort(),
    )
})
