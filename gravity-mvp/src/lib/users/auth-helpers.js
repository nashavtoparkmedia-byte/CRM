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

module.exports = { pickUserById }
