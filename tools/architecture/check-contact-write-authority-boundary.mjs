#!/usr/bin/env node
// ContactWriteAuthorityQuery.v1 boundary (Contact Identity V2, Security W1–W8).
//
// Who may change a person's links in Contacts is decided by Contacts' write
// authority, and the actor every change records is the one that authority
// answered. This control pins that:
// - the decision is pure, admits exactly the three staff reader roles with a
//   plain user id, records them as 'staff:<userId>', ends the transitional
//   integration-admin writer under Staff Session enforcement and records that
//   writer only as its one constant actor;
// - its feed reads Identity Access in the read authority's order (a staff
//   cookie decides alone, the admin session is read once and only after the
//   enforcement switch), and never reads a mobile session, crm_user_id, a
//   cookie or a header itself;
// - every mutating handler under /api/contacts and /api/contact-merges asks it
//   right after the same-origin check and before reading anything, answers 401
//   on a denial, and records only the answered actor; a new mutating route
//   without that gate fails here, and the two routes that write nothing are
//   pinned to staying that way.
// It then runs the proofs that make these invariants behavioural.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const readRepo = (relative) => readFileSync(path.join(root, relative), 'utf8')

const DECISION = 'gravity-mvp/src/modules/contacts/public/v1/contact-write-authority.ts'
const FEED = 'gravity-mvp/src/modules/contacts/internal/identity-access-contact-write-authority.ts'
const APPLICATION = 'gravity-mvp/src/modules/contacts/application/contact-operations.ts'
const MANIFEST = 'architecture/contexts/v1/manifests/contacts.json'
const CONTROL = 'node tools/architecture/check-contact-write-authority-boundary.mjs'
const ROUTE_ROOTS = ['gravity-mvp/src/app/api/contacts', 'gravity-mvp/src/app/api/contact-merges', 'gravity-mvp/src/app/contacts']
const API = 'gravity-mvp/src/app/api'
/** Every mutating Contacts route, each gated by the write authority. */
const WRITE_ROUTES = [
  `${API}/contact-merges/[id]/recover/route.ts`,
  `${API}/contacts/[id]/chats/route.ts`,
  `${API}/contacts/[id]/communication-policy/route.ts`,
  `${API}/contacts/[id]/driver-person/route.ts`,
  `${API}/contacts/[id]/identities/[identityId]/phone/route.ts`,
  `${API}/contacts/[id]/merge-to/[targetId]/route.ts`,
  `${API}/contacts/[id]/parks/route.ts`,
  `${API}/contacts/[id]/phones/[phoneId]/route.ts`,
  `${API}/contacts/[id]/phones/route.ts`,
  `${API}/contacts/[id]/route.ts`,
  // «Проверить» (W5) sits beside the card page: Contacts may not import Messaging.
  'gravity-mvp/src/app/contacts/[id]/reachability/route.ts',
]
/** POST routes that only read, under Contacts' read authority (the ВУ search; pinned by the person-card control). */
const READ_POST_ROUTES = ['gravity-mvp/src/app/contacts/licence-search/route.ts']
/** Mutating routes that write nothing; each is pinned to its inert shape below. */
const INERT_MERGE_ROUTE = `${API}/contacts/[id]/merge/route.ts`
const INERT_START_ROUTE = `${API}/contacts/start-conversation/route.ts`
const ORCHESTRATOR = 'gravity-mvp/src/modules/platform-shell/internal/contact-conversation-orchestrator.ts'
const MUTATING = /export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\s*\(|export\s+const\s+(POST|PUT|PATCH|DELETE)\s*=/gu
const CLIENT_IDENTITY = /crm_user_id|getCurrentUser|user-service|cookies\s*\(|headers\s*\(|getMobileSessionPrincipalV1|hasMobileSessionV1|MOBILE_SESSION_COOKIE|writeDerivedUiIdentityCookie/u
const ROUTE_IDENTITY = /crm_user_id|getCurrentUser|user-service|cookies\s*\(|getIntegrationAdminPrincipal|getStaffSessionPrincipalV1|getMobileSessionPrincipalV1|CONTACT_TRANSITIONAL_ADMIN_ACTOR_V1|identity-access:integration-admin-session/u
const ACTOR_FIELD = /\b(actor|requestedBy|confirmedBy|mergedBy|verifiedBy|createdBy|changedBy|performedBy)\s*:\s*([^,\n}]+)/gu
const SAME_ORIGIN_PREAMBLE = /^\s*if \(!isExactSameOriginMutationRequest\((\w+)\)(?: \|\| !isJsonMutationRequest\(\1\))?\) \{\s*return NextResponse\.json\(\{ error: 'Forbidden' \}, \{ status: 403 \}\)\s*\}\s*$/u
const GATE = /^(?:const (\w+) = await resolveContactWriteAuthorityV1\(\)\s*if \(\1\.decision !== 'allow'\) \{|if \(\(await resolveContactWriteAuthorityV1\(\)\)\.decision !== 'allow'\) \{)\s*return NextResponse\.json\(\{ error: 'Unauthorized' \}, \{ status: 401 \}\)\s*\}/u

export function passingProofCount(stdout) {
  const plain = stripVTControlCharacters(String(stdout ?? ''))
  const matched = /Tests\s+(\d+)\s+passed/u.exec(plain)
  return matched === null ? null : Number(matched[1])
}

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1')
}

function order(source, needles, label) {
  let cursor = -1
  for (const needle of needles) {
    const at = source.indexOf(needle, cursor + 1)
    assert(at > cursor, `${label} no longer does ${needle} at its place in the protocol`)
    cursor = at
  }
}

/** The body of each exported mutating handler: the balanced braces after its parameter list. */
export function mutatingHandlers(source) {
  const handlers = []
  for (const match of source.matchAll(MUTATING)) {
    const method = match[1] ?? match[2]
    let at = match.index + match[0].length - 1
    if (source[at] === '(') {
      let depth = 0
      for (; at < source.length; at += 1) {
        if (source[at] === '(') depth += 1
        else if (source[at] === ')') { depth -= 1; if (depth === 0) break }
      }
    }
    const open = source.indexOf('{', at)
    let depth = 0
    let end = open
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1
      else if (source[end] === '}') { depth -= 1; if (depth === 0) break }
    }
    handlers.push({ method, body: source.slice(open + 1, end) })
  }
  return handlers
}

function routeFiles() {
  const found = []
  const walk = (relative) => {
    for (const name of readdirSync(path.join(root, relative))) {
      const child = `${relative}/${name}`
      if (statSync(path.join(root, child)).isDirectory()) walk(child)
      else if (/^route\.(ts|tsx|js|mjs)$/u.test(name)) found.push(child)
    }
  }
  for (const start of ROUTE_ROOTS) walk(start)
  return found.sort()
}

/** 1. The decision is pure and non-elevating. */
function assertDecision(read = readRepo) {
  const decision = withoutComments(read(DECISION))
  assert(!/from '@\/|from "@\//u.test(decision), 'the write decision is not pure')
  assert(decision.includes("import { CONTACT_READER_ROLES_V1, type ContactReaderRoleV1 } from './contact-read-authority'"), 'the writer roles are no longer the reader roles')
  assert(decision.includes("export const CONTACT_TRANSITIONAL_ADMIN_ACTOR_V1 = 'identity-access:integration-admin-session' as const"), 'the transitional actor constant changed')
  assert(decision.includes('const STAFF_USER_ID = /^[A-Za-z0-9_-]{1,64}$/u'), 'a staff user id is no longer a plain id')
  order(decision, [
    "if (inputs.staffCookie === 'present') {",
    "if (staff === null || typeof staff.userId !== 'string' || !STAFF_USER_ID.test(staff.userId)",
    '|| !(CONTACT_READER_ROLES_V1 as readonly string[]).includes(staff.role)) {',
    "return deny('staff_session_refused')",
    "principal: { kind: 'staff_session', userId: staff.userId, role: staff.role as ContactReaderRoleV1 },",
    'actor: `staff:${staff.userId}`,',
    "if (inputs.staffSessionEnforced === true) return deny('transitional_admin_write_disabled')",
    "if (inputs.integrationAdminVerified !== true) return deny('no_session')",
    "principal: { kind: 'integration_admin_session', transitional: true },",
    'actor: CONTACT_TRANSITIONAL_ADMIN_ACTOR_V1,',
  ], 'the write decision')
  const body = decision.slice(decision.indexOf('export function decideContactWriteAuthorityV1('))
  assert.equal((body.match(/decision: 'allow'/gu) ?? []).length, 2, 'the write decision allows somewhere besides the staff and transitional branches')
  assert.equal((body.match(/\bactor: /gu) ?? []).length, 2, 'the write decision answers an actor from somewhere else')
  assert.equal((body.match(/CONTACT_TRANSITIONAL_ADMIN_ACTOR_V1/gu) ?? []).length, 1, 'the transitional actor is used beyond its one branch')
}

/** 2. The feed reads Identity Access in the read authority's order and nothing client-held. */
function assertFeed(read = readRepo) {
  const feed = withoutComments(read(FEED))
  assert(feed.includes("import { getIntegrationAdminPrincipal, getStaffSessionPrincipalV1 } from '@/modules/identity-access/public/v1'"), 'the write authority is not fed by Identity Access')
  assert(feed.includes("} from '@/modules/identity-access/public/v1/staff-session'"), 'the write authority does not read Staff Session state from Identity Access')
  assert(!CLIENT_IDENTITY.test(feed), 'the write authority reads a client-held or mobile identity')
  order(feed, [
    'if (await hasStaffSessionCookieV1()) {',
    'await getStaffSessionPrincipalV1()',
    "staffCookie: 'present'",
    'if (isStaffSessionEnforcedForRequestV1()) {',
    'staffSessionEnforced: true',
    'await getIntegrationAdminPrincipal()',
    'integrationAdminVerified: admin !== null,',
  ], 'the write authority feed')
  assert.equal((feed.match(/getIntegrationAdminPrincipal\(\)/gu) ?? []).length, 1, 'the admin session is read more than once')
  assert.equal((feed.match(/integrationAdminVerified: true/gu) ?? []).length, 0, 'the feed asserts an admin session it did not verify')
  const application = withoutComments(read(APPLICATION))
  assert(application.includes('export const resolveContactWriteAuthorityV1 = () => resolveContactWriteAuthorityFromIdentityAccessV1()'), 'the write authority is not bound to its Identity Access feed')
}

/** 3. Every mutating Contacts route asks the authority first and records only its actor. */
function assertRoutes(read = readRepo, discovered = routeFiles()) {
  const mutating = discovered.filter((file) => mutatingHandlers(withoutComments(read(file))).length > 0)
  assert.deepEqual(mutating, [...WRITE_ROUTES, ...READ_POST_ROUTES, INERT_MERGE_ROUTE, INERT_START_ROUTE].sort(), 'the mutating Contacts routes changed; gate the new one with the write authority')
  for (const file of READ_POST_ROUTES) {
    const source = withoutComments(read(file))
    // Its composition asks Contacts' read authority first (pinned by check-contact-person-card-read-model-boundary).
    assert(source.includes('await searchPeopleByExactLicenceV1(') && !/\.(create|update|upsert|delete)\w*\(|\$executeRaw|setContactCommunicationPolicyV1|resolveContactWriteAuthorityV1/u.test(source), `${file} is no longer only the ВУ search read`)
  }
  for (const file of WRITE_ROUTES) {
    const source = withoutComments(read(file))
    assert(source.includes("import { resolveContactWriteAuthorityV1 } from '@/modules/contacts/public/v1'") || /import \{[^}]*\bresolveContactWriteAuthorityV1\b[^}]*\} from '@\/modules\/contacts\/public\/v1'/u.test(source), `${file} does not take the write authority from Contacts' public surface`)
    assert(!ROUTE_IDENTITY.test(source), `${file} reads an identity or names an actor itself`)
    const gateVariables = new Set()
    const handlers = mutatingHandlers(source)
    for (const { method, body } of handlers) {
      const gate = body.search(/const \w+ = await resolveContactWriteAuthorityV1\(\)|if \(\(await resolveContactWriteAuthorityV1\(\)\)/u)
      assert(gate >= 0, `${file} ${method} does not ask the write authority`)
      assert(SAME_ORIGIN_PREAMBLE.test(body.slice(0, gate)), `${file} ${method} does something besides the same-origin check before the write authority`)
      const matched = GATE.exec(body.slice(gate))
      assert(matched !== null, `${file} ${method} does not answer 401 on a write-authority denial`)
      if (matched[1]) gateVariables.add(matched[1])
    }
    for (const [, field, value] of handlers.flatMap(({ body }) => [...body.matchAll(ACTOR_FIELD)])) {
      const actor = value.trim()
      if (actor === 'true' || actor === 'false') continue // a Prisma select, not a recorded actor
      assert([...gateVariables].some((name) => actor === `${name}.actor`), `${file} records ${field} from ${actor}, not from the write authority`)
    }
    for (const call of source.matchAll(/mergeContactToContact\(([^)]*)\)/gu)) {
      assert([...gateVariables].some((name) => call[1].trim().endsWith(`${name}.actor`)), `${file} merges with an actor that is not the write authority's`)
    }
  }
  const merge = withoutComments(read(INERT_MERGE_ROUTE))
  assert.deepEqual([...merge.matchAll(/from '([^']+)'/gu)].map((m) => m[1]), ['next/server'], 'the retired merge route imports something that could write')
  assert(merge.includes("code: 'DRIVER_PERSON_CONFIRMATION_REQUIRED',") && merge.includes('{ status: 409 },'), 'the retired merge route no longer refuses')
  const start = withoutComments(read(INERT_START_ROUTE))
  assert.deepEqual([...start.matchAll(/from '([^']+)'/gu)].map((m) => m[1]).sort(), ['@/modules/contacts/public/v1/phone-identity', '@/modules/platform-shell/internal/contact-conversation-orchestrator', 'next/server'], 'the phone-start route imports something that could write')
  const orchestrator = withoutComments(read(ORCHESTRATOR))
  assert(/async function startContactConversationByPhoneV1\(\s*input: StartContactConversationByPhoneInputV1,\s*\): Promise<StartContactConversationByPhoneResultV1> \{\s*void input\s*return \{ status: 'provider_identity_required' \}\s*\}/u.test(orchestrator), 'a phone-only conversation start now does something; it needs the write authority')
}

function assertDeclarations(read = readRepo) {
  const manifest = JSON.parse(read(MANIFEST))
  assert(manifest.verification.module_tests.includes(CONTROL), 'the control is not a declared module test')
}

/** 4. Each rule holds against known mutants (Security W7). */
const PHONES = `${API}/contacts/[id]/phones/route.ts`
const MERGE_TO = `${API}/contacts/[id]/merge-to/[targetId]/route.ts`
const PATCH_ROUTE = `${API}/contacts/[id]/route.ts`
const RECOVER = `${API}/contact-merges/[id]/recover/route.ts`
const MUTANTS = [
  // The authority skipped, its denial ignored, or something read before it.
  [PHONES, 'const authority = await resolveContactWriteAuthorityV1()', "const authority = { decision: 'allow', actor: 'staff:anyone' } as const"],
  [PHONES, "if (authority.decision !== 'allow') {", 'if (false) {'],
  [PATCH_ROUTE, "if ((await resolveContactWriteAuthorityV1()).decision !== 'allow') {\n    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })\n  }", ''],
  [PHONES, 'const authority = await resolveContactWriteAuthorityV1()', 'const early = await req.json().catch(() => null)\n  void early\n  const authority = await resolveContactWriteAuthorityV1()'],
  [PHONES, "return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })", "return NextResponse.json({ error: 'Unauthorized' }, { status: 200 })"],
  // The actor taken from the request or named by the route.
  [PHONES, 'actor: authority.actor,', 'actor: body.actor ?? authority.actor,'],
  [MERGE_TO, 'authority.actor)', "'identity-access:integration-admin-session')"],
  [RECOVER, 'requestedBy: authority.actor,', 'requestedBy: req.headers.get(\'x-actor\') ?? authority.actor,'],
  [PHONES, 'const authority = await resolveContactWriteAuthorityV1()', "const cookie = req.cookies.get('crm_user_id')\n  void cookie\n  const authority = await resolveContactWriteAuthorityV1()"],
  // The admin session consulted beside a staff cookie, or a mobile session admitted.
  [FEED, 'if (await hasStaffSessionCookieV1()) {', 'if ((await getIntegrationAdminPrincipal()) === null && await hasStaffSessionCookieV1()) {'],
  [FEED, 'export async function resolveContactWriteAuthorityFromIdentityAccessV1(): Promise<ContactWriteAuthorityV1> {', "export async function resolveContactWriteAuthorityFromIdentityAccessV1(): Promise<ContactWriteAuthorityV1> {\n  if (await hasMobileSessionV1()) return decideContactWriteAuthorityV1({ staffCookie: 'absent', staffSessionEnforced: false, integrationAdminVerified: true })"],
  [FEED, 'integrationAdminVerified: admin !== null,', 'integrationAdminVerified: true,'],
  // Enforcement ignored.
  [FEED, 'if (isStaffSessionEnforcedForRequestV1()) {', 'if (false) {'],
  [DECISION, "if (inputs.staffSessionEnforced === true) return deny('transitional_admin_write_disabled')", "if (false) return deny('transitional_admin_write_disabled')"],
  // The staff branch widened or its actor changed.
  [DECISION, '|| !(CONTACT_READER_ROLES_V1 as readonly string[]).includes(staff.role)) {', '|| false) {'],
  [DECISION, 'const STAFF_USER_ID = /^[A-Za-z0-9_-]{1,64}$/u', 'const STAFF_USER_ID = /^.+$/u'],
  [DECISION, 'actor: `staff:${staff.userId}`,', 'actor: CONTACT_TRANSITIONAL_ADMIN_ACTOR_V1,'],
  [DECISION, "principal: { kind: 'integration_admin_session', transitional: true },", "principal: { kind: 'integration_admin_session' } as never,"],
  [DECISION, "if (inputs.integrationAdminVerified !== true) return deny('no_session')", ''],
  // «Проверить» taking a number from the request (W5).
  ['gravity-mvp/src/app/contacts/[id]/reachability/route.ts', 'const authority = await resolveContactWriteAuthorityV1()', "const phone = (await req.clone().json()).phone\n  void phone\n  const authority = await resolveContactWriteAuthorityV1()"],
  // The binding swapped.
  [APPLICATION, 'export const resolveContactWriteAuthorityV1 = () => resolveContactWriteAuthorityFromIdentityAccessV1()', "export const resolveContactWriteAuthorityV1 = async () => ({ decision: 'allow', actor: 'identity-access:integration-admin-session' }) as never"],
]

function checkAll(read, discovered) {
  assertDecision(read)
  assertFeed(read)
  assertRoutes(read, discovered)
  assertDeclarations(read)
}

function checkMutants() {
  const discovered = routeFiles()
  for (const [file, from, to] of MUTANTS) {
    const original = readRepo(file)
    assert(original.includes(from), `mutant anchor missing in ${file}: ${from}`)
    const mutated = original.replace(from, to)
    let escaped = true
    try {
      checkAll((relative) => (relative === file ? mutated : readRepo(relative)), discovered)
    } catch {
      escaped = false
    }
    assert(!escaped, `mutant escaped in ${path.basename(file)}: ${from} -> ${to}`)
  }
  // A new mutating route that does not ask the authority.
  const added = `${API}/contacts/[id]/notes/route.ts`
  let escaped = true
  try {
    checkAll((relative) => (relative === added ? "export async function POST() { return new Response(null, { status: 204 }) }\n" : readRepo(relative)), [...discovered, added].sort())
  } catch {
    escaped = false
  }
  assert(!escaped, 'a new ungated mutating Contacts route escaped')
  return MUTANTS.length + 1
}

/** 5. The proofs. */
function runProofs() {
  const vitest = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'src/modules/contacts/public/v1/contact-write-authority.test.ts',
    'src/modules/contacts/internal/identity-access-contact-read-authority.staff-session.test.ts',
    ...WRITE_ROUTES.map((file) => file.replace('gravity-mvp/', '').replace(/route\.ts$/u, 'route.test.ts')),
    'src/modules/contacts/internal/legacy-prisma-contact-reachability-target-adapter.test.ts',
    INERT_MERGE_ROUTE.replace('gravity-mvp/', '').replace(/route\.ts$/u, 'route.test.ts'),
  ], { cwd: path.join(root, 'gravity-mvp'), encoding: 'utf8', env: { ...process.env, CI: '1' } })
  assert.equal(vitest.status, 0, `the write authority proofs failed:\n${vitest.stdout}\n${vitest.stderr}`)
  const passed = passingProofCount(vitest.stdout)
  assert(passed !== null && passed > 0, `the proofs reported no passing tests:\n${vitest.stdout}`)
  return passed
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkAll(readRepo, routeFiles())
  const mutants = checkMutants()
  const proofs = process.argv.includes('--no-proofs') ? 0 : runProofs()
  process.stdout.write(`${JSON.stringify({ control: 'contact-write-authority-boundary', status: 'PASS', mutants, proofs })}\n`)
}
