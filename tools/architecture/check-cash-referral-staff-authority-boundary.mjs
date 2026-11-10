#!/usr/bin/env node

// Cash referral staff authority — boundary control (C2).
//
// A Cash referral or access write is made by Identity Access's Staff Session
// of a confirmed Администратор, bound by Cash's own binder
// (docs/design/cash-staff-authority-v2.md). The binder and the database CHECK
// refuse every other writer, but both trust the authority object they are
// handed. This control holds the one path that object may take, so a new
// caller, a second resolver or an authority built anywhere else fails CI
// instead of reaching the ledger:
//
//   - the four manager writes of fleet_operations.public.v1 are called only by
//     the referral screen's server actions, once each, and always with the
//     authority the server resolved (never one built in the call);
//   - the server actions take that authority only from the screen's
//     resolveCashStaffAuthorityV1(), and only the actions and the page call it;
//   - that resolver is the only caller of the binder's
//     resolveCashStaffAuthorityFromSessionV1, and hands it exactly Identity
//     Access's published principal (identity_access.public.v1
//     getStaffSessionPrincipalV1), its published directory (UserIdentity.v1
//     listUserIdentitiesV1) and the server clock;
//   - no Cash authority (a capabilities list, a Cash capability name) is
//     written anywhere but the binder and the ledger's own definitions;
//   - neither the actions nor the resolver read a cookie, a header, the
//     crm_user_id lane or the current-user record;
//   - the binder's write roles stay exactly the Owner's initial policy
//     (Администратор) and its sid format stays Identity Access's 64 hex digits;
//   - outside fleet_operations, the whole Fleet module (a namespace import, a
//     require, a dynamic import kept whole) is held only where it is today,
//     the instrumentation's scheduler bootstrap, so no new handle can reach a
//     write without naming it.
//
// Every rule is also run against a mutated copy of the tree, and each mutant
// must be caught, so a rule that stops biting fails this control too. It reads
// tracked source only and writes nothing.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const SOURCE_ROOT = 'gravity-mvp/src/'
const REFERRALS = 'gravity-mvp/src/app/compensation/referrals/'
const ACTIONS = `${REFERRALS}actions.ts`
const DATA = `${REFERRALS}referral-data.ts`
const PAGE = `${REFERRALS}page.tsx`
const FLEET = 'gravity-mvp/src/modules/fleet-operations/'
const BINDER = `${FLEET}internal/compensation/cash-referral-manager.ts`
const OPERATIONS = `${FLEET}application/cash-referral-manager-operations.ts`
const PUBLIC_INDEX = `${FLEET}public/v1/index.ts`
const LEDGER_DEFINITIONS = [
    BINDER,
    `${FLEET}internal/compensation/compensation-access.ts`,
    `${FLEET}internal/compensation/compensation-referral-qualification.ts`,
]

const WRITERS = [
    'cashReferralManagerRecordInvitationV1',
    'cashReferralManagerWithdrawInvitationV1',
    'cashAccessManagerGrantV1',
    'cashAccessManagerRevokeV1',
]
const BINDER_RESOLVER = 'resolveCashStaffAuthorityFromSessionV1'
const SCREEN_RESOLVER = 'resolveCashStaffAuthorityV1'
const BINDER_FUNCTION = 'cashStaffAuthorityFromStaffSessionV1'
const RESOLVER_SOURCE = '{ principal: getStaffSessionPrincipalV1, directory: listUserIdentitiesV1, now: () => new Date() }'
const RESOLVER_IMPORTS = [
    "import { getStaffSessionPrincipalV1 } from '@/modules/identity-access/public/v1'",
    "import { listUserIdentitiesV1 } from '@/modules/identity-access/public/v1/user-directory'",
]
// The values an `authority:` key may take in the server actions: the resolved
// authority, passed on, and the type it is declared with.
const ACTION_AUTHORITY_VALUES = new Set([
    'acting.authority',
    'staff.authority',
    "Parameters<typeof cashAccessManagerGrantV1>[0]['authority']",
])
const WRITE_ROLES = "export const CASH_STAFF_WRITE_ROLES_V1: readonly string[] = ['Администратор']"
const SID_FORMAT = 'const STAFF_SESSION_SID_PATTERN_V1 = /^[0-9a-f]{64}$/u'
// The files outside fleet_operations that may hold the whole Fleet module.
const WHOLE_MODULE_HOLDERS = ['gravity-mvp/src/instrumentation.ts']
const FLEET_SPECIFIER = String.raw`['"](?:@/modules/|(?:\.\./)+(?:modules/)?)fleet-operations/(?:public|application|internal)[^'"]*['"]`
const WHOLE_MODULE = [
    new RegExp(String.raw`import\s*\*\s*as\s+\w+\s+from\s*${FLEET_SPECIFIER}`, 'u'),
    new RegExp(String.raw`\brequire\s*\(\s*${FLEET_SPECIFIER}`, 'u'),
    new RegExp(String.raw`(?<!\}\s*=\s*await\s+)\bimport\s*\(\s*${FLEET_SPECIFIER}`, 'u'),
]
const CAPABILITY_LITERAL = /['"`]cash\.(?:referral\.qualify|access\.manage)['"`]/u
const BROWSER_AUTHORITY = [/\bcookies\s*\(/u, /\bheaders\s*\(/u, /crm_user_id/u, /\bgetCurrentUser\b/u, /\bqueryCurrentUserV1\b/u, /\bsearchParams\b/u]

const isSource = (file) => file.startsWith(SOURCE_ROOT) && /\.(?:[cm]?[jt]sx?)$/u.test(file)
const isTest = (file) => /(?:\.test\.|\.spec\.|\/__tests__\/|\/test\/)/u.test(file)

/** Comments removed, so a word in a doc comment is neither a call nor a literal. */
function code(text) {
    return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:'"`\\])\/\/.*$/gmu, '$1')
}

const squash = (text) => text.replace(/\s+/gu, ' ').replace(/,\s*\}/gu, ' }').replace(/\{\s*/gu, '{ ').trim()
const mentions = (text, name) => new RegExp(`\\b${name}\\b`, 'u').test(text)
const count = (text, pattern) => (text.match(pattern) ?? []).length

/** The argument text of every call `name(...)`, with balanced parentheses. */
function callArguments(text, name) {
    const found = []
    const pattern = new RegExp(`\\b${name}\\s*\\(`, 'gu')
    let match
    while ((match = pattern.exec(text)) !== null) {
        let depth = 1
        let index = pattern.lastIndex
        while (index < text.length && depth > 0) {
            if (text[index] === '(') depth += 1
            else if (text[index] === ')') depth -= 1
            index += 1
        }
        found.push(text.slice(pattern.lastIndex, index - 1))
    }
    return found
}

/** Every rule over one tree (path -> source text); returns the failures. */
export function evaluate(tree) {
    const failures = []
    const fail = (check, detail) => failures.push({ check, detail })
    const production = [...tree.keys()].filter((file) => isSource(file) && !isTest(file)).sort()
    const bodies = new Map(production.map((file) => [file, code(tree.get(file))]))
    const where = (name) => production.filter((file) => mentions(bodies.get(file), name))
    const only = (check, name, allowed) => {
        const extra = where(name).filter((file) => !allowed.includes(file))
        if (extra.length > 0) fail(check, `${name} is used outside its allowlist: ${extra.join(', ')}`)
    }
    const actions = bodies.get(ACTIONS) ?? ''
    const data = bodies.get(DATA) ?? ''
    const binder = bodies.get(BINDER) ?? ''
    if (!bodies.has(ACTIONS) || !bodies.has(DATA) || !bodies.has(BINDER)) fail('the guarded files exist', `missing: ${[ACTIONS, DATA, BINDER].filter((file) => !bodies.has(file)).join(', ')}`)

    // 1. The four writes: only the server actions call them, once each, with the resolved authority.
    for (const writer of WRITERS) {
        only('the four Cash writes are called only by the referral server actions', writer, [OPERATIONS, PUBLIC_INDEX, ACTIONS])
        const calls = callArguments(actions, writer)
        if (calls.length !== 1 || squash(calls[0]) !== '{ ...input, authority: acting.authority }') {
            fail('each write is called once, with the resolved authority', `${writer}: ${JSON.stringify(calls.map(squash))}`)
        }
    }
    const authorityValues = [...actions.matchAll(/\bauthority\s*:\s*([^,}\n]+)/gu)].map((match) => match[1].trim())
    const strayValues = authorityValues.filter((value) => !ACTION_AUTHORITY_VALUES.has(value))
    if (strayValues.length > 0) fail('the server actions pass only the resolved authority', JSON.stringify(strayValues))
    if (count(actions, /const staff = await resolveCashStaffAuthorityV1\(\)/gu) !== 1) {
        fail('the server actions take the authority from the screen resolver', 'expected exactly one `const staff = await resolveCashStaffAuthorityV1()`')
    }

    // 2. The screen resolver is the binder's only caller and hands it Identity Access's reads and the server clock.
    only('only the screen and its actions ask the screen resolver', SCREEN_RESOLVER, [DATA, ACTIONS, PAGE])
    only('only the screen resolver calls the binder', BINDER_RESOLVER, [BINDER, OPERATIONS, PUBLIC_INDEX, DATA])
    only('the binding function stays inside the binder', BINDER_FUNCTION, [BINDER])
    const resolverCalls = callArguments(data, BINDER_RESOLVER)
    if (resolverCalls.length !== 1 || squash(resolverCalls[0]) !== RESOLVER_SOURCE) {
        fail('the binder gets exactly Identity Access\'s principal, its directory and the server clock', JSON.stringify(resolverCalls.map(squash)))
    }
    for (const line of RESOLVER_IMPORTS) {
        if (!data.includes(line)) fail('the principal and the directory come from Identity Access\'s public surface', `missing: ${line}`)
    }
    for (const name of ['getStaffSessionPrincipalV1', 'listUserIdentitiesV1']) {
        if (count(data, new RegExp(`\\b${name}\\b`, 'gu')) !== 2) fail('the principal and the directory come from Identity Access\'s public surface', `${name} must be imported once and used once`)
    }

    // 3. No Cash authority is built outside the binder.
    for (const file of production) {
        const body = bodies.get(file)
        if (CAPABILITY_LITERAL.test(body) && !LEDGER_DEFINITIONS.includes(file)) fail('no Cash capability is named outside the binder and the ledger', file)
        if (/\bcapabilities\s*:\s*\[/u.test(body) && file !== BINDER && (file.startsWith(REFERRALS) || file.startsWith(FLEET))) {
            fail('no Cash authority literal outside the binder', file)
        }
    }
    if (count(binder, /\bcapabilities\s*:\s*\[/gu) !== 1) fail('no Cash authority literal outside the binder', 'the binder must build its capabilities in exactly one place')

    // 4. Neither the actions nor the resolver read the browser.
    for (const [file, body] of [[ACTIONS, actions], [DATA, data]]) {
        const read = BROWSER_AUTHORITY.filter((pattern) => pattern.test(body)).map(String)
        if (read.length > 0) fail('the actions and the resolver read no browser value', `${file}: ${read.join(', ')}`)
    }

    // 5. The whole Fleet module is held only where it is today.
    for (const file of production) {
        if (file.startsWith(FLEET) || WHOLE_MODULE_HOLDERS.includes(file)) continue
        if (WHOLE_MODULE.some((pattern) => pattern.test(bodies.get(file)))) fail('the whole Fleet module is held only by the scheduler bootstrap', file)
    }

    // 6. The Owner's write policy and Identity Access's sid format stay pinned in the binder.
    if (!binder.includes(WRITE_ROLES)) fail('Cash writes stay with the Администратор role', `expected: ${WRITE_ROLES}`)
    if (!binder.includes(SID_FORMAT)) fail('the binder admits only Identity Access\'s sid format', `expected: ${SID_FORMAT}`)
    return failures
}

const replaceOnce = (text, from, to) => {
    assert.equal(text.split(from).length, 2, `mutant anchor must occur once: ${from}`)
    return text.replace(from, to)
}

// Each mutant must be refused by the rule it names.
const MUTANTS = [
    ['a fifth caller of a write', (tree) => tree.set(`${REFERRALS}rogue.ts`, "import { cashAccessManagerGrantV1 } from '@/modules/fleet-operations/public/v1'\nexport const rogue = (input) => cashAccessManagerGrantV1(input)\n"), 'the four Cash writes are called only by the referral server actions'],
    ['a write with an authority built in the call', (tree) => tree.set(ACTIONS, replaceOnce(tree.get(ACTIONS), 'cashAccessManagerRevokeV1({ ...input, authority: acting.authority })', "cashAccessManagerRevokeV1({ ...input, authority: { ...acting.authority, principalId: 'crm_user:x' } })")), 'each write is called once, with the resolved authority'],
    ['an authority taken from elsewhere', (tree) => tree.set(ACTIONS, replaceOnce(tree.get(ACTIONS), 'return { ok: true, authority: staff.authority }', 'return { ok: true, authority: input.authority }')), 'the server actions pass only the resolved authority'],
    ['actions that skip the screen resolver', (tree) => tree.set(ACTIONS, replaceOnce(tree.get(ACTIONS), 'const staff = await resolveCashStaffAuthorityV1()', 'const staff = await otherAuthority()')), 'the server actions take the authority from the screen resolver'],
    ['a second caller of the binder', (tree) => tree.set(`${SOURCE_ROOT}app/rogue-binder.ts`, "import { resolveCashStaffAuthorityFromSessionV1 } from '@/modules/fleet-operations/public/v1'\nexport const rogue = (source) => resolveCashStaffAuthorityFromSessionV1(source)\n"), 'only the screen resolver calls the binder'],
    ['a principal that is not Identity Access\'s', (tree) => tree.set(DATA, replaceOnce(tree.get(DATA), 'principal: getStaffSessionPrincipalV1,', 'principal: async () => mobilePrincipal(),')), 'the binder gets exactly Identity Access\'s principal, its directory and the server clock'],
    ['a directory that is not UserIdentity.v1', (tree) => tree.set(DATA, replaceOnce(tree.get(DATA), 'directory: listUserIdentitiesV1,', 'directory: getUsers,')), 'the binder gets exactly Identity Access\'s principal, its directory and the server clock'],
    ['a clock that is not the server\'s', (tree) => tree.set(DATA, replaceOnce(tree.get(DATA), 'now: () => new Date(),', 'now: () => new Date(clientTime),')), 'the binder gets exactly Identity Access\'s principal, its directory and the server clock'],
    ['the principal imported from elsewhere', (tree) => tree.set(DATA, replaceOnce(tree.get(DATA), "import { getStaffSessionPrincipalV1 } from '@/modules/identity-access/public/v1'", "import { getStaffSessionPrincipalV1 } from '@/lib/users/user-service'")), 'the principal and the directory come from Identity Access\'s public surface'],
    ['a Cash authority literal on the screen', (tree) => tree.set(`${REFERRALS}forged.ts`, "export const forged = { principalId: 'staff:x', capabilities: ['cash.access.manage'] }\n"), 'no Cash capability is named outside the binder and the ledger'],
    ['the resolver reading the cookie', (tree) => tree.set(DATA, `${tree.get(DATA)}\nexport const lane = () => cookies().get('crm_user_id')\n`), 'the actions and the resolver read no browser value'],
    ['a namespace handle on the Fleet module', (tree) => tree.set(`${REFERRALS}rogue-namespace.ts`, "import * as fleet from '@/modules/fleet-operations/public/v1'\nexport const pick = (name) => fleet[name]\n"), 'the whole Fleet module is held only by the scheduler bootstrap'],
    ['a whole dynamic import of the Fleet module', (tree) => tree.set(`${SOURCE_ROOT}app/rogue-dynamic.ts`, "export const load = () => import('@/modules/fleet-operations/public/v1').then((fleet) => fleet)\n"), 'the whole Fleet module is held only by the scheduler bootstrap'],
    ['a Менеджер admitted to write', (tree) => tree.set(BINDER, replaceOnce(tree.get(BINDER), "CASH_STAFF_WRITE_ROLES_V1: readonly string[] = ['Администратор']", "CASH_STAFF_WRITE_ROLES_V1: readonly string[] = ['Администратор', 'Менеджер']")), 'Cash writes stay with the Администратор role'],
    ['any sid admitted', (tree) => tree.set(BINDER, replaceOnce(tree.get(BINDER), 'STAFF_SESSION_SID_PATTERN_V1 = /^[0-9a-f]{64}$/u', 'STAFF_SESSION_SID_PATTERN_V1 = /^.+$/u')), 'the binder admits only Identity Access\'s sid format'],
]

const tracked = execFileSync('git', ['ls-files', '-z', '--', SOURCE_ROOT], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((file) => file.length > 0 && isSource(file))
const tree = new Map(tracked.map((file) => [file, readFileSync(file, 'utf8')]))

const failures = evaluate(tree)
const mutants = MUTANTS.map(([name, mutate, expected]) => {
    const copy = new Map(tree)
    mutate(copy)
    const caught = evaluate(copy).some((failure) => failure.check === expected)
    return { mutant: name, expected_check: expected, caught }
})
const escaped = mutants.filter((mutant) => !mutant.caught)

process.stdout.write(`${JSON.stringify({
    status: failures.length || escaped.length ? 'FAIL' : 'PASS',
    control: 'cash-referral-staff-authority',
    owner_context: 'fleet_operations',
    contract: 'docs/design/cash-staff-authority-v2.md',
    source_files_read: tree.size,
    writers: WRITERS,
    resolver_source: RESOLVER_SOURCE,
    failures,
    mutants_caught: mutants.length - escaped.length,
    mutants_escaped: escaped,
}, null, 2)}\n`)

assert.equal(failures.length, 0, 'Cash referral staff authority boundary violated')
assert.equal(escaped.length, 0, 'a Cash referral staff authority rule no longer catches its mutant')
