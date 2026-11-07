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
// writes; that the production authority comes only from Identity Access's signed
// integration-admin principal and never from crm_user_id, a cookie or a header;
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
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const CONTRACT = 'gravity-mvp/src/contracts/contacts/v1/contact-person-card-contracts.ts'
const CONTRACT_INDEX = 'gravity-mvp/src/contracts/contacts/v1/index.ts'
const HANDLER = 'gravity-mvp/src/modules/contacts/internal/contact-person-card.ts'
const ADAPTER = 'gravity-mvp/src/modules/contacts/internal/legacy-prisma-contact-person-card-source-adapter.ts'
const AUTHORITY = 'gravity-mvp/src/modules/contacts/internal/identity-access-contact-person-card-authority.ts'
const APPLICATION = 'gravity-mvp/src/modules/contacts/application/contact-operations.ts'
const COMPOSITION = 'gravity-mvp/src/modules/platform-shell/application/contact-person-card-composition.ts'
const PAGE = 'gravity-mvp/src/app/contacts/[id]/page.tsx'
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
function assertContractShape() {
  const contract = withoutComments(read(CONTRACT))
  assert(contract.includes("export const CONTACT_PERSON_CARD_QUERY_V1 = 'contacts.ContactPersonCardQuery.v1' as const"), 'the query contract id changed')
  assert.deepEqual(fieldNames(typeBody(contract, 'ContactPersonCardQueryV1')), ['contactId', 'contract'], 'the query accepts more than an exact Contact id')
  const statusBlock = contract.slice(contract.indexOf('export type ContactPersonCardStatusV1'), contract.indexOf('export type ContactPersonCardResultV1'))
  assert.deepEqual([...statusBlock.matchAll(/'(\w+)'/gu)].map((match) => match[1]), STATUSES, 'the answer states changed')
  assert(/status: 'confirmed'; card: ContactPersonCardV1 \}/u.test(contract), 'confirmed no longer carries exactly the card')
  assert(/status: 'redirected'; canonicalContactId: string \}/u.test(contract), 'redirected no longer carries exactly the canonical id')
  assert(/status: Exclude<ContactPersonCardStatusV1, 'confirmed' \| 'redirected'> \}/u.test(contract), 'a non-confirmed answer may carry data')
  assert(contract.includes("key !== 'contract' && key !== 'contactId'"), 'the parser accepts fields beside the Contact id')
  assert(contract.includes('input.contactId.trim() !== input.contactId'), 'the parser no longer rejects a padded Contact id')
  assert(!/\b(chatId|phone:|displayName:|username:)\b/u.test(typeBody(contract, 'ContactPersonCardQueryV1')), 'the query can be steered by something other than the id')
  assert(read(CONTRACT_INDEX).includes("export * from './contact-person-card-contracts'"), 'the contract is not exported')
}

/** 2. The handler protocol: principal, parse, access, one read, exact id, redirect only to a canonical id. */
function assertHandlerProtocol() {
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
    "status: 'confirmed', card: buildContactPersonCardV1(source)",
  ], 'the handler')
  assert(!CLIENT_IDENTITY.test(handler), 'the handler reads a client-held identity')
  assert(!WRITE_VOCABULARY.test(handler), 'the handler writes')
  assert(!/\bprisma\b/u.test(handler), 'the handler imports the database client')
  assert(handler.includes("from '../public/v1/contact-identity-conflict-state'"), 'conflict state is no longer the shared Contacts projection')
  assert(handler.includes('buildProviderNeutralContactDisplayV1('), 'the name no longer comes from the provider-neutral display policy')
  assert(!/\bmatch(es)?\b.*\b(displayName|phone)\b/u.test(handler), 'the handler matches people by name or phone')
}

/** 3. The only reader: Contacts-owned models, exact id, one REPEATABLE READ snapshot, no writes. */
function assertReader() {
  const adapter = withoutComments(read(ADAPTER))
  assert(adapter.includes('isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead'), 'the Contact is not read in one repeatable-read snapshot')
  assert(adapter.includes('where: { id: contactId }'), 'the Contact is not read by its exact id')
  assert(adapter.includes('createResolveContactLineageHandlerV1(makePrismaContactLineagePortV1(tx))'), 'the lineage is not the existing resolver on the same client')
  assert(!FOREIGN_TABLES.test(adapter), 'the reader touches a table Contacts does not own')
  assert(!WRITE_VOCABULARY.test(adapter), 'the reader writes or runs raw SQL')
  assert(adapter.includes('take: 100'), 'the merge history read is unbounded')
}

/** 4. The authority: only Identity Access's verified integration-admin principal, never a client-held identity. */
function assertAuthority() {
  const authority = withoutComments(read(AUTHORITY))
  assert(authority.includes("import { getIntegrationAdminPrincipal } from '@/modules/identity-access/public/v1'"), 'the authority no longer comes from Identity Access')
  assert(authority.includes("new Set(['integration_admin_session'])"), 'the set of unrestricted principals changed')
  assert(!CLIENT_IDENTITY.test(authority), 'the authority reads a client-held identity')
  const application = withoutComments(read(APPLICATION))
  assert(application.includes('authority: identityAccessContactPersonCardAuthorityV1'), 'the reader is not bound to the Identity Access authority')
  assert(application.includes('cardSource: legacyPrismaContactPersonCardSourcePortV1'), 'the reader is not bound to the Prisma source')
}

/** 5. The composition reads Fleet and Messaging only after Contacts confirmed; the page and the lookup gate on the same principal class. */
function assertComposition() {
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
  const page = withoutComments(read(PAGE))
  assert(page.includes("if (result.status === 'redirected') redirect("), 'a merged-away id is no longer followed to its canonical Contact')
  assert(page.includes("if (result.status === 'missing') notFound()"), 'a missing Contact is no longer a 404')
  assert(!CLIENT_IDENTITY.test(page), 'the page reads a client-held identity')
  const lookup = withoutComments(read(LOOKUP_ROUTE))
  assert(lookup.includes('if (await getIntegrationAdminPrincipal() === null)'), 'the lookup route no longer requires the verified principal')
}

/** 6. Declared where the machinery reads it. */
function assertDeclarations() {
  const manifest = JSON.parse(read(MANIFEST))
  assert(manifest.public_surface.includes(CAPABILITY), 'the manifest does not list the capability')
  assert(manifest.verification.module_tests.includes(CONTROL), 'the control is not a declared module test')
  const registry = JSON.parse(read(REGISTRY))
  const surface = registry.context_surfaces.find((candidate) => candidate.id === 'contacts.public.v1')
  assert(surface?.capabilities.includes(CAPABILITY), 'the registry does not list the read capability')
}

/** 7. The proofs. */
function runProofs() {
  const vitest = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'src/contracts/contacts/v1/contact-person-card-contracts.test.ts',
    'src/modules/contacts/internal/contact-person-card.test.ts',
    'src/modules/platform-shell/application/contact-person-card-composition.test.ts',
  ], { cwd: path.join(root, 'gravity-mvp'), encoding: 'utf8', env: { ...process.env, CI: '1' } })
  assert.equal(vitest.status, 0, `the person card read model proofs failed:\n${vitest.stdout}\n${vitest.stderr}`)
  const passed = passingProofCount(vitest.stdout)
  assert(passed !== null && passed > 0, `the proofs reported no passing tests:\n${vitest.stdout}`)
  return passed
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertContractShape()
  assertHandlerProtocol()
  assertReader()
  assertAuthority()
  assertComposition()
  assertDeclarations()
  const proofs = runProofs()
  process.stdout.write(`${JSON.stringify({ control: 'contact-person-card-read-model-boundary', status: 'PASS', proofs })}\n`)
}
