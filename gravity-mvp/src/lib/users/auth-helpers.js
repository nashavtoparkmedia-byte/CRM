// Pure user-resolution helper.
//
// Lives in a plain `.js` (CommonJS) — deliberately not a `'use server'`
// module — so a `node:test` unit-test can `require()` it directly without
// a tsx loader. There is no Next.js / cookies / fs side-effect inside;
// this is just the predicate "given a list of users and a candidate id,
// return the matching user or null".
//
// Why a separate file:
//   - user-service.ts is annotated `'use server'`, so every export there
//     gets registered as a server action by Next.js. A pure helper has
//     no business being a server action — and bundling pure logic with
//     `cookies()` makes the surface non-trivial to unit-test.
//   - Keeping this in `.js` avoids needing a TypeScript loader at test
//     time. The user-service caller still gets the type narrowing it
//     needs because TS infers the union from how the result is consumed.

'use strict'

/**
 * Resolve a user from the loaded users list by id.
 *
 * Anonymous (`undefined` / empty / unknown id) maps to `null` — this is
 * the production-safety property that replaces the historical
 * `if (!id) id = 'u3'` fallback in `getCurrentUser`. Callers MUST handle
 * the null branch explicitly (typically `if (!user) return 401`).
 *
 * @param {Array<{id: string}>} users — already-loaded user records.
 * @param {string|undefined|null} id — candidate id from the cookie.
 * @returns {object|null} matching user object or null.
 */
function pickUserById(users, id) {
    if (!id) return null
    return users.find(u => u.id === id) || null
}

/**
 * Authoritative predicate for the `login(targetUserId)` server action.
 *
 * Background
 * ──────────
 * The CRM has no real authentication today — `login(id)` simply writes a
 * cookie with the chosen user id. Without any guard, a Менеджер sitting
 * in a session could invoke `login('u3')` from DevTools and silently
 * become Руководитель. We don't want to redesign auth yet; we just want
 * to close the «authenticated escalation» vector while keeping the
 * legitimate flows working:
 *
 *   - Anonymous (no cookie) → can pick any identity. This is the
 *     intentional onboarding/demo flow. Closing it requires real auth
 *     (email/password / OAuth / one-time link) — separate scope.
 *   - Администратор → can switch to any identity (multi-role QA).
 *   - Руководитель → can switch to any identity (operational role,
 *     legitimately reviews from a manager's perspective).
 *   - Менеджер → may only re-login as themselves (cookie refresh /
 *     recovery flow). Any cross-id login from a manager session is the
 *     escalation we block.
 *
 * Returns a tagged verdict so `login()` can produce a structured
 * forensic-friendly log line («[auth] blocked login escalation
 * current=u1 role=Менеджер target=u3 reason=manager_escalation_blocked»)
 * without leaking stack traces.
 *
 * @param {Object}   args
 * @param {Object|null} args.currentUser  — resolved user from cookie, or null.
 * @param {string}   args.targetUserId   — id requested for the new cookie.
 * @param {Array<{id: string}>} args.allUsers — pool to validate target against.
 * @returns {{ allowed: boolean, reason: string|null }}
 */
function canLogin({ currentUser, targetUserId, allUsers }) {
    // Never write a non-existent id into the cookie — even if the role
    // check below would let it through, the result is a session that
    // resolves to `null` (since pickUserById misses) which masquerades
    // as anonymous. Reject early.
    if (!targetUserId) {
        return { allowed: false, reason: 'empty_target' }
    }
    const target = allUsers.find(u => u.id === targetUserId)
    if (!target) {
        return { allowed: false, reason: 'unknown_target' }
    }

    // Anonymous → any identity. Intentional: this is the onboarding /
    // initial-login flow. Closing it requires real authentication
    // (out of scope for this PR — see security_debt.md).
    if (!currentUser) {
        return { allowed: true, reason: null }
    }

    // Privileged operational roles → any identity. Admins switch users
    // for QA; supervisors legitimately review from a manager's
    // perspective. Both are treated as trusted within the CRM's current
    // «trusted internal app» model.
    if (currentUser.role === 'Администратор' || currentUser.role === 'Руководитель') {
        return { allowed: true, reason: null }
    }

    // Менеджер → only their own id (cookie refresh / recovery). Any
    // cross-id login from a manager session is the escalation vector
    // this whole helper exists to block.
    if (currentUser.role === 'Менеджер') {
        if (currentUser.id === targetUserId) {
            return { allowed: true, reason: null }
        }
        return { allowed: false, reason: 'manager_escalation_blocked' }
    }

    // Defense-in-depth: any future role we don't recognise here is
    // denied by default rather than silently allowed.
    return { allowed: false, reason: 'unknown_current_role' }
}

module.exports = { pickUserById, canLogin }
