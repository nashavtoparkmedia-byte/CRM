#!/usr/bin/env node
// ContactPersonCardQuery.v1 read model boundary (the standalone «Карточка человека»).
//
// The person card a verified principal may see is decided by Contacts for the
// exact canonical Contact id it is asked about, and by nothing else. This control
// pins that the contract accepts only an exact Contact id and answers only the
// five declared states, with the card as the only data and a redirect carrying
// only the canonical id; that the handler asks for the principal first, asks
// access before any Contact read, reads exactly the Contact asked for in one
// snapshot and refuses any other; that the only database reader touches
// Contacts-owned models by exact id in one REPEATABLE READ snapshot and never
// writes; that the production authority is Contacts' read authority
// (ContactReadAuthorityQuery.v1, D2), fed only by Identity Access's verified
// Staff Session and, transitionally, its signed integration-admin principal, in
// an order where a staff cookie decides alone, and never by crm_user_id, a
// cookie or a header read in Contacts;
// that the platform composition reads Fleet and Messaging only after Contacts
// confirmed; and that the capability and this control are declared where the
// machinery reads them. It then runs the proofs that make these invariants
// behavioural.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const readRepo = (relative) => readFileSync(path.join(root, relative), 'utf8')

const CONTRACT = 'gravity-mvp/src/contracts/contacts/v1/contact-person-card-contracts.ts'
const CONTRACT_INDEX = 'gravity-mvp/src/contracts/contacts/v1/index.ts'
const HANDLER = 'gravity-mvp/src/modules/contacts/internal/contact-person-card.ts'
const ADAPTER = 'gravity-mvp/src/modules/contacts/internal/legacy-prisma-contact-person-card-source-adapter.ts'
const AUTHORITY = 'gravity-mvp/src/modules/contacts/internal/identity-access-contact-person-card-authority.ts'
const READ_AUTHORITY = 'gravity-mvp/src/modules/contacts/internal/identity-access-contact-read-authority.ts'
const READ_DECISION = 'gravity-mvp/src/modules/contacts/public/v1/contact-read-authority.ts'
const PEOPLE_PAGE = 'gravity-mvp/src/app/contacts/page.tsx'
const APPLICATION = 'gravity-mvp/src/modules/contacts/application/contact-operations.ts'
const COMPOSITION = 'gravity-mvp/src/modules/platform-shell/application/contact-person-card-composition.ts'
const PAGE = 'gravity-mvp/src/app/contacts/[id]/page.tsx'
const LICENCE_SEARCH = 'gravity-mvp/src/modules/platform-shell/application/contact-licence-search-composition.ts'
const LICENCE_ROUTE = 'gravity-mvp/src/app/contacts/licence-search/route.ts'
const LOOKUP_ROUTE = 'gravity-mvp/src/app/api/contacts/lookup/route.ts'
const MANIFEST = 'architecture/contexts/v1/manifests/contacts.json'
const REGISTRY = 'architecture/contracts/v1/registry.json'
const CAPABILITY = 'ContactPersonCardQuery.v1'
const CONTROL = 'node tools/architecture/check-contact-person-card-read-model-boundary.mjs'
const STATUSES = ['confirmed', 'redirected', 'missing', 'forbidden', 'refused']
const WRITE_VOCABULARY = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\$executeRaw|\$queryRaw|\$executeRawUnsafe|\$queryRawUnsafe/u
const CLIENT_IDENTITY = /crm_user_id|getCurrentUser|user-service|cookies\s*\(|headers\s*\(|getMobileSessionPrincipalV1|hasMobileSessionV1|writeDerivedUiIdentityCookie/u
const FOREIGN_TABLES = /\btx\.(chat|message|driver|park|user|crmUser|telegram\w*|whatsApp\w*|max\w*)\b/u

export function passingProofCount(stdout) {
  const plain = stripVTControlCharacters(String(stdout ?? ''))
  const matched = /Tests\s+(\d+)\s+passed/u.exec(plain)
  return matched === null ? null : Number(matched[1])
}

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

function typeBody(source, name) {
  const start = source.indexOf(`export type ${name} = {`)
  assert(start >= 0, `${name} is not declared as an object type`)
  const end = source.indexOf('\n}', start)
  return source.slice(start, end)
}

function fieldNames(body) {
  return [...body.matchAll(/^\s{2}(\w+)\??:/gmu)].map((match) => match[1]).sort()
}

function order(source, needles, label) {
  let cursor = -1
  for (const needle of needles) {
    const at = source.indexOf(needle, cursor + 1)
    assert(at > cursor, `${label} no longer does ${needle} at its place in the protocol`)
    cursor = at
  }
}

/** 1. The contract: an exact Contact id in, five states out, a redirect that names only the canonical id. */
function assertContractShape(read = readRepo) {
  const contract = withoutComments(read(CONTRACT))
  assert(contract.includes("export const CONTACT_PERSON_CARD_QUERY_V1 = 'contacts.ContactPersonCardQuery.v1' as const"), 'the query contract id changed')
  assert.deepEqual(fieldNames(typeBody(contract, 'ContactPersonCardQueryV1')), ['contactId', 'contract'], 'the query accepts more than an exact Contact id')
  const statusBlock = contract.slice(contract.indexOf('export type ContactPersonCardStatusV1'), contract.indexOf('export type ContactPersonCardResultV1'))
  assert.deepEqual([...statusBlock.matchAll(/'(\w+)'/gu)].map((match) => match[1]), STATUSES, 'the answer states changed')
  assert(/status: 'confirmed'; card: ContactPersonCardV1; licenceView: 'full' \| 'last4' \}/u.test(contract), 'confirmed no longer carries exactly the card and its ВУ view')
  assert(/status: 'redirected'; canonicalContactId: string \}/u.test(contract), 'redirected no longer carries exactly the canonical id')
  assert(/status: Exclude<ContactPersonCardStatusV1, 'confirmed' \| 'redirected'> \}/u.test(contract), 'a non-confirmed answer may carry data')
  assert(contract.includes("key !== 'contract' && key !== 'contactId'"), 'the parser accepts fields beside the Contact id')
  assert(contract.includes('input.contactId.trim() !== input.contactId'), 'the parser no longer rejects a padded Contact id')
  assert(!/\b(chatId|phone:|displayName:|username:)\b/u.test(typeBody(contract, 'ContactPersonCardQueryV1')), 'the query can be steered by something other than the id')
  assert(read(CONTRACT_INDEX).includes("export * from './contact-person-card-contracts'"), 'the contract is not exported')
}

/** 2. The handler protocol: principal, parse, access, one read, exact id, redirect only to a canonical id. */
function assertHandlerProtocol(read = readRepo) {
  const handler = withoutComments(read(HANDLER))
  order(handler, [
    'ports.authority.currentPrincipal()',
    "if (!isPrincipal(principal)) return answer('forbidden')",
    'parseContactPersonCardQueryV1(query)',
    "ports.authority.mayReadContact(principal, contactId) !== true) return answer('forbidden')",
    'ports.cardSource.findContactPersonCardSource(contactId)',
    "if (source === null) return answer('missing')",
    "if (source.id !== contactId) return answer('refused')",
    "status: 'redirected', canonicalContactId: target",
    "if (source.isArchived === true) return answer('missing')",
    "status: 'confirmed',",
    'card: buildContactPersonCardV1(source),',
    "licenceView: principal.licenceView === 'full' ? 'full' : 'last4',",
  ], 'the handler')
  assert(!CLIENT_IDENTITY.test(handler), 'the handler reads a client-held identity')
  assert(!WRITE_VOCABULARY.test(handler), 'the handler writes')
  assert(!/\bprisma\b/u.test(handler), 'the handler imports the database client')
  assert(handler.includes("from '../public/v1/contact-identity-conflict-state'"), 'conflict state is no longer the shared Contacts projection')
  assert(handler.includes('buildProviderNeutralContactDisplayV1('), 'the name no longer comes from the provider-neutral display policy')
  assert(!/\bmatch(es)?\b.*\b(displayName|phone)\b/u.test(handler), 'the handler matches people by name or phone')
}

/** 3. The only reader: Contacts-owned models, exact id, one REPEATABLE READ snapshot, no writes. */
function assertReader(read = readRepo) {
  const adapter = withoutComments(read(ADAPTER))
  assert(adapter.includes('isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead'), 'the Contact is not read in one repeatable-read snapshot')
  assert(adapter.includes('where: { id: contactId }'), 'the Contact is not read by its exact id')
  assert(adapter.includes('createResolveContactLineageHandlerV1(makePrismaContactLineagePortV1(tx))'), 'the lineage is not the existing resolver on the same client')
  assert(!FOREIGN_TABLES.test(adapter), 'the reader touches a table Contacts does not own')
  assert(!WRITE_VOCABULARY.test(adapter), 'the reader writes or runs raw SQL')
  assert(adapter.includes('take: 100'), 'the merge history read is unbounded')
}

/** 4. The authority: Contacts' read authority over Identity Access's verified sessions, never a client-held identity. */
function assertAuthority(read = readRepo) {
  const authority = withoutComments(read(AUTHORITY))
  assert(authority.includes("import { resolveContactReadAuthorityFromIdentityAccessV1 } from './identity-access-contact-read-authority'"), 'the card authority is not Contacts\' read authority')
  assert(authority.includes("new Set(['staff_session', 'integration_admin_session'])"), 'the set of reader principals changed')
  assert(authority.includes("authority.decision === 'allow'"), 'the card authority admits a principal the read authority denied')
  assert(!CLIENT_IDENTITY.test(authority), 'the authority reads a client-held identity')
  const feed = withoutComments(read(READ_AUTHORITY))
  assert(feed.includes("import { getIntegrationAdminPrincipal, getStaffSessionPrincipalV1 } from '@/modules/identity-access/public/v1'"), 'the read authority is not fed by Identity Access')
  assert(feed.includes("} from '@/modules/identity-access/public/v1/staff-session'"), 'the read authority does not read Staff Session state from Identity Access')
  assert(!CLIENT_IDENTITY.test(feed), 'the read authority reads a client-held identity')
  // A staff cookie decides alone: the admin session is read only after the staff
  // branch has returned and the enforcement switch has been asked.
  order(feed, [
    'if (await hasStaffSessionCookieV1()) {',
    'await getStaffSessionPrincipalV1()',
    "staffCookie: 'present'",
    'if (isStaffSessionEnforcedForRequestV1()) {',
    'staffSessionEnforced: true',
    'await getIntegrationAdminPrincipal()',
  ], 'the read authority')
  assert.equal((feed.match(/getIntegrationAdminPrincipal\(\)/gu) ?? []).length, 1, 'the admin session is read more than once')
  const decision = withoutComments(read(READ_DECISION))
  assert(!/from '@\/|from "@\//u.test(decision), 'the read decision is not pure')
  // Owner 2026-11-11 (~10:20): exactly the three reader roles, each with the full ВУ;
  // an unknown role, an empty user or a refused staff cookie is a denial.
  assert(decision.includes("export const CONTACT_READER_ROLES_V1 = ['Администратор', 'Руководитель', 'Менеджер'] as const"), 'the reader roles are no longer exactly Администратор, Руководитель and Менеджер')
  order(decision, [
    "if (staff === null || typeof staff.userId !== 'string' || staff.userId === '' || !isReaderRole(staff.role)) {",
    "return deny('staff_session_refused')",
  ], 'the read decision refusal')
  assert(/export function contactLicenceViewForRoleV1\(_role: ContactReaderRoleV1\): ContactLicenceViewV1 \{\s*return 'full'\s*\}/u.test(decision), 'a staff reader role no longer gets the full ВУ view')
  assert(decision.includes("if (inputs.staffSessionEnforced === true) return deny('transitional_admin_read_disabled')"), 'the enforcement switch no longer ends the transitional admin read')
  assert(decision.includes('licenceView: contactLicenceViewForRoleV1(staff.role),'), 'a staff reader\'s ВУ view no longer comes from the role decision')
  assert(decision.includes("principal: { kind: 'integration_admin_session', transitional: true },"), 'the integration-admin full view is no longer marked transitional')
  assert.equal((decision.match(/licenceView: 'full'/gu) ?? []).length, 1, 'the full ВУ view is granted somewhere besides the transitional admin read')
  assert(authority.includes('{ kind: authority.principal.kind, licenceView: authority.licenceView }'), 'the card principal no longer carries the decided ВУ view')
  const application = withoutComments(read(APPLICATION))
  assert(application.includes('authority: identityAccessContactPersonCardAuthorityV1'), 'the reader is not bound to the Identity Access authority')
  assert(application.includes('cardSource: legacyPrismaContactPersonCardSourcePortV1'), 'the reader is not bound to the Prisma source')
}

/** 5. The composition reads Fleet and Messaging only after Contacts confirmed; the page and the lookup gate on the same principal class. */
function assertComposition(read = readRepo) {
  const composition = withoutComments(read(COMPOSITION))
  order(composition, [
    'deps.readContactPersonCard({ contract: CONTACT_PERSON_CARD_QUERY_V1, contactId })',
    "if (answer.status === 'redirected') return",
    "if (answer.status !== 'confirmed') return { status: answer.status }",
    'deps.readDriverProfilesForContacts(',
    'deps.readContactConversations(',
  ], 'the composition')
  assert(!WRITE_VOCABULARY.test(composition), 'the composition writes')
  assert(!/\bprisma\b/u.test(composition), 'the composition imports the database client')
  // The ВУ view: Contacts' answer passed on unchanged, last-4 unless exactly 'full',
  // and a Fleet answer for another view or with an unmasked ВУ is never shown.
  order(composition, [
    "const licenceView = answer.licenceView === 'full' ? 'full' : 'last4'",
    'deps.readDriverProfilesForContacts({ contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2, licenceView, subjects })',
    '&& profiles.value.licenceView === licenceView',
    '&& profiles.value.entries.every(entry => entry.profiles.every(profile => maskedForView(profile.licence, licenceView)))',
    'if (profiles.ok && profilesShown) {',
    'partial: { driverProfiles: !profilesShown,',
  ], 'the composition ВУ view')
  assert(composition.includes("return licenceView === 'full' || licence === null || licence.startsWith(DRIVER_LICENCE_MASK_V1)"), 'the composition no longer checks Fleet\'s mask for a last-4 reader')
  assert(composition.includes('readDriverProfilesForContacts: readDriverProfilesForContactsV2,'), 'the card is not bound to Fleet\'s masked v2 read')
  assert(!composition.includes('readDriverProfilesForContactsV1'), 'the card still reads Fleet\'s v1 profiles')
  const page = withoutComments(read(PAGE))
  assert(page.includes("if (result.status === 'redirected') redirect("), 'a merged-away id is no longer followed to its canonical Contact')
  assert(page.includes("if (result.status === 'missing') notFound()"), 'a missing Contact is no longer a 404')
  assert(!CLIENT_IDENTITY.test(page), 'the page reads a client-held identity')
  const lookup = withoutComments(read(LOOKUP_ROUTE))
  order(lookup, ['const authority = await resolveContactReadAuthorityV1()', "if (authority.decision !== 'allow') {", 'await searchContactsV1('], 'the lookup route')
  assert(lookup.includes("const NO_STORE = { 'Cache-Control': 'no-store' }"), 'the lookup route has no no-store header')
  assert.equal((lookup.match(/NextResponse\.json\(/gu) ?? []).length, (lookup.match(/headers: NO_STORE/gu) ?? []).length, 'a lookup answer may be cached')
  assert(!CLIENT_IDENTITY.test(lookup), 'the lookup route reads a client-held identity')
  const people = withoutComments(read(PEOPLE_PAGE))
  order(people, ['const authority = await resolveContactReadAuthorityV1()', "authority.decision !== 'allow'", '<ContactsSearchClient />'], 'the «Люди» page')
  assert(!CLIENT_IDENTITY.test(people), 'the «Люди» page reads a client-held identity')
}

/** 5b. The «Люди» ВУ search: authority first, the view passed on, no echo, no unmasked answer, POST only. */
function assertLicenceSearch(read = readRepo) {
  const search = withoutComments(read(LICENCE_SEARCH))
  order(search, [
    'const authority = await deps.resolveReadAuthority()',
    "if (authority.decision !== 'allow') return { status: 'denied' }",
    "const licenceView = authority.licenceView === 'full' ? 'full' : 'last4'",
    'deps.findDriverProfilesByExactLicence({ contract: DRIVER_PROFILES_BY_EXACT_LICENCE_QUERY_V1, licence, licenceView })',
    'if (!answer.profiles.every(profile => maskedForView(profile.licence, licenceView))) {',
    "return { status: 'unavailable' }",
    "status: 'answered',",
  ], 'the ВУ search')
  assert(search.includes("return licenceView === 'full' || licence === null || licence.startsWith(DRIVER_LICENCE_MASK_V1)"), 'the ВУ search no longer checks Fleet\'s mask for a last-4 reader')
  assert(search.includes("console.error('[contact-licence-search] Fleet read failed:', error instanceof Error ? error.name : 'unknown')"), 'the ВУ search logs more than the failure class')
  assert.equal((search.match(/console\.\w+\(/gu) ?? []).length, 2, 'the ВУ search logs somewhere new')
  assert(!/error\.message|String\(error\)|\$\{\s*licence/u.test(search), 'the ВУ search can quote the typed licence or a failure text')
  assert(search.includes('resolveReadAuthority: resolveContactReadAuthorityV1,'), 'the ВУ search is not bound to Contacts\' read authority')
  assert(search.includes('findDriverProfilesByExactLicence: findDriverProfilesByExactLicenceV1,'), 'the ВУ search is not bound to Fleet\'s exact-licence read')
  assert(!WRITE_VOCABULARY.test(search) && !/\bprisma\b/u.test(search), 'the ВУ search writes or reads the database itself')
  const route = withoutComments(read(LICENCE_ROUTE))
  order(route, [
    'export async function POST(req: NextRequest) {',
    'if (!isExactSameOriginMutationRequest(req) || !isJsonMutationRequest(req)) {',
    'await searchPeopleByExactLicenceV1(',
  ], 'the ВУ search route')
  assert(!/export async function (GET|PUT|PATCH|DELETE)\b|searchParams|console\./u.test(route), 'the ВУ search route takes the licence from the URL, answers another method or logs')
  assert(!CLIENT_IDENTITY.test(route), 'the ВУ search route reads a client-held identity')
  assert.equal((route.match(/NextResponse\.json\(/gu) ?? []).length, (route.match(/headers: NO_STORE/gu) ?? []).length, 'a ВУ search answer may be cached')
}

/** 6. Declared where the machinery reads it. */
function assertDeclarations(read = readRepo) {
  const manifest = JSON.parse(read(MANIFEST))
  assert(manifest.public_surface.includes(CAPABILITY), 'the manifest does not list the capability')
  assert(manifest.verification.module_tests.includes(CONTROL), 'the control is not a declared module test')
  const registry = JSON.parse(read(REGISTRY))
  const surface = registry.context_surfaces.find((candidate) => candidate.id === 'contacts.public.v1')
  assert(surface?.capabilities.includes(CAPABILITY), 'the registry does not list the read capability')
}

/** 7. Each ВУ-view rule holds against known mutants («full by default» and its kin). */
const MUTANTS = [
  [READ_DECISION, "staff.userId === '' || !isReaderRole(staff.role)) {", "staff.userId === '') {"],
  [READ_DECISION, "['Администратор', 'Руководитель', 'Менеджер'] as const", "['Администратор', 'Руководитель', 'Менеджер', 'Оператор'] as const"],
  [READ_DECISION, "_role: ContactReaderRoleV1): ContactLicenceViewV1 {\n  return 'full'", "_role: ContactReaderRoleV1): ContactLicenceViewV1 {\n  return _role === 'Администратор' ? 'full' : 'last4'"],
  [READ_DECISION, "return deny('staff_session_refused')", "return deny('no_session')"],
  [READ_DECISION, "if (inputs.staffSessionEnforced === true) return deny('transitional_admin_read_disabled')", "if (false) return deny('transitional_admin_read_disabled')"],
  [READ_DECISION, "principal: { kind: 'integration_admin_session', transitional: true },", "principal: { kind: 'integration_admin_session' },"],
  [HANDLER, "licenceView: principal.licenceView === 'full' ? 'full' : 'last4',", "licenceView: principal.licenceView ?? 'full',"],
  [AUTHORITY, '{ kind: authority.principal.kind, licenceView: authority.licenceView }', "{ kind: authority.principal.kind, licenceView: 'full' }"],
  [COMPOSITION, "const licenceView = answer.licenceView === 'full' ? 'full' : 'last4'", "const licenceView = answer.licenceView ?? 'full'"],
  [COMPOSITION, '&& profiles.value.licenceView === licenceView', ''],
  [COMPOSITION, "return licenceView === 'full' || licence === null || licence.startsWith(DRIVER_LICENCE_MASK_V1)", 'return true'],
  [COMPOSITION, 'readDriverProfilesForContacts: readDriverProfilesForContactsV2,', 'readDriverProfilesForContacts: readDriverProfilesForContactsV1,'],
  [LICENCE_SEARCH, "const licenceView = authority.licenceView === 'full' ? 'full' : 'last4'", "const licenceView = authority.licenceView ?? 'full'"],
  [LICENCE_SEARCH, "if (authority.decision !== 'allow') return { status: 'denied' }", ''],
  [LICENCE_SEARCH, 'if (!answer.profiles.every(profile => maskedForView(profile.licence, licenceView))) {', 'if (false) {'],
  [LICENCE_SEARCH, "error instanceof Error ? error.name : 'unknown'", 'error instanceof Error ? error.message : licence'],
  [LICENCE_ROUTE, 'if (!isExactSameOriginMutationRequest(req) || !isJsonMutationRequest(req)) {', 'if (!isJsonMutationRequest(req)) {'],
  [LICENCE_ROUTE, '{ status: 401, headers: NO_STORE }', '{ status: 401 }'],
  [LOOKUP_ROUTE, "{ status: 401, headers: NO_STORE }", '{ status: 401 }'],
  [LOOKUP_ROUTE, 'NextResponse.json(result, { headers: NO_STORE })', 'NextResponse.json(result)'],
]

function checkAll(read) {
  assertContractShape(read)
  assertHandlerProtocol(read)
  assertReader(read)
  assertAuthority(read)
  assertComposition(read)
  assertLicenceSearch(read)
  assertDeclarations(read)
}

function checkMutants() {
  for (const [file, from, to] of MUTANTS) {
    const original = readRepo(file)
    assert(original.includes(from), `mutant anchor missing in ${file}: ${from}`)
    const mutated = original.replace(from, to)
    let escaped = true
    try {
      checkAll((relative) => (relative === file ? mutated : readRepo(relative)))
    } catch {
      escaped = false
    }
    assert(!escaped, `mutant escaped in ${path.basename(file)}: ${from} -> ${to}`)
  }
  return MUTANTS.length
}

/** 8. The proofs. */
function runProofs() {
  const vitest = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'src/contracts/contacts/v1/contact-person-card-contracts.test.ts',
    'src/modules/contacts/internal/contact-person-card.test.ts',
    'src/modules/platform-shell/application/contact-person-card-composition.test.ts',
    'src/modules/contacts/public/v1/contact-read-authority.test.ts',
    'src/modules/contacts/internal/identity-access-contact-read-authority.test.ts',
    'src/modules/contacts/internal/identity-access-contact-read-authority.staff-session.test.ts',
    'src/app/api/contacts/lookup/route.test.ts',
    'src/modules/platform-shell/application/contact-licence-search-composition.test.ts',
    'src/app/contacts/licence-serialized-responses.test.tsx',
  ], { cwd: path.join(root, 'gravity-mvp'), encoding: 'utf8', env: { ...process.env, CI: '1' } })
  assert.equal(vitest.status, 0, `the person card read model proofs failed:\n${vitest.stdout}\n${vitest.stderr}`)
  const passed = passingProofCount(vitest.stdout)
  assert(passed !== null && passed > 0, `the proofs reported no passing tests:\n${vitest.stdout}`)
  return passed
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkAll(readRepo)
  const mutants = checkMutants()
  const proofs = runProofs()
  process.stdout.write(`${JSON.stringify({ control: 'contact-person-card-read-model-boundary', status: 'PASS', mutants, proofs })}\n`)
}
