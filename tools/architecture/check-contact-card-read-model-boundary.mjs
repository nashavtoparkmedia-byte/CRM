#!/usr/bin/env node

// CC-1 Contact Card read model boundary (contacts.ContactCardForConversationQuery.v1).
//
// The card a verified principal may see for one conversation is decided by
// Contacts for exactly the Contact Messaging's RCQ1 names, and by nothing else.
// This control pins that the contract accepts only an exact Chat.id and answers
// only the six declared states, with the minimal card as the only data; that
// the handler asks for the principal first, asks access before RCQ1 and before
// any Contact read, reads exactly the Contact RCQ1 named, and asks RCQ1 again
// after the read; that the only database reader touches Contacts-owned models by
// exact id in one REPEATABLE READ snapshot, never selects a provider external id
// and never writes; that the production authority comes only from Identity
// Access's signed integration-admin principal and never from crm_user_id, a
// cookie or a header; that the handler, its ports and its bindings stay
// internal so no composition can substitute a weaker authority; and that the
// capability and this control are declared where the machinery reads them. It
// then runs the proofs that make these invariants behavioural.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const CONTRACTS = 'gravity-mvp/src/contracts/contacts/v1/contact-card-for-conversation-contracts.ts'
const CONTRACTS_INDEX = 'gravity-mvp/src/contracts/contacts/v1/index.ts'
const INTERNAL_DIR = 'gravity-mvp/src/modules/contacts/internal'
const HANDLER = `${INTERNAL_DIR}/contact-card-for-conversation.ts`
const ADAPTER = `${INTERNAL_DIR}/legacy-prisma-contact-card-source-adapter.ts`
const AUTHORITY = `${INTERNAL_DIR}/identity-access-contact-card-authority.ts`
const OPERATIONS = 'gravity-mvp/src/modules/contacts/application/contact-operations.ts'
const PUBLIC_INDEX = 'gravity-mvp/src/modules/contacts/public/v1/index.ts'
const MANIFEST = 'architecture/contexts/v1/manifests/contacts.json'
const REGISTRY = 'architecture/contracts/v1/registry.json'
const INTERNAL_IMPORTERS = '<git grep: importers of the card internals outside Contacts>'
const CONSUMERS = '<git grep: consumers of the card reader outside Contacts>'
const ALLOWLIST = '<the allowlisted consumers of the card reader>'
const consumerKey = (relative) => `<consumer source: ${relative}>`

// The runtime files outside Contacts that may use the card reader. EMPTY in CC-1:
// any file that references the reader is a failure until it is added here AND
// its content satisfies the exact binding contract below (assertConsumerBinding).
// A composition is admitted by its own reviewed change (CC-2), never by a count.
const ALLOWED_CONSUMERS = []

const CAPABILITY = 'ContactCardForConversationQuery.v1'
const CONTROL = 'node tools/architecture/check-contact-card-read-model-boundary.mjs'
const STATUSES = ['confirmed', 'unresolved', 'conflict', 'refused', 'missing', 'forbidden']
const CARD_FIELDS = ['channels', 'contactId', 'displayName', 'hasOpenIdentityConflict', 'mergedFromCount', 'phoneCount', 'primaryPhone']
const CHANNEL_FIELDS = ['channel', 'hasActiveIdentity', 'hasOpenIdentityConflict', 'identityCount']
const PROVIDER_VOCABULARY = /\b(externalId|providerAccount\w*|transport\w*|connectionId|conversationId|messageId|driverId|mainDriver\w*|yandex\w*)\b/iu
const WRITE_VOCABULARY = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\$executeRaw|\$queryRaw|\$executeRawUnsafe|\$queryRawUnsafe/u
const CLIENT_IDENTITY = /crm_user_id|getCurrentUser|user-service|cookies\s*\(|headers\s*\(|getMobileSessionPrincipalV1|hasMobileSessionV1|writeDerivedUiIdentityCookie/u
const INTERNAL_NAMES = [
  'createContactCardForConversationHandlerV1',
  'buildContactCardV1',
  'ContactCardAuthorityPortV1',
  'ContactCardSourcePortV1',
  'ContactCardSourceV1',
  'ContactCardPrincipalV1',
  'makePrismaContactCardSourcePortV1',
  'legacyPrismaContactCardSourcePortV1',
  'identityAccessContactCardAuthorityV1',
]

export function passingProofCount(stdout) {
  const plain = stripVTControlCharacters(String(stdout ?? ''))
  const matched = /Tests\s+(\d+)\s+passed/u.exec(plain)
  return matched === null ? null : Number(matched[1])
}

/** Source with comments removed, so prose about an exclusion is never read as the thing. */
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

/** 1. The contract accepts only an exact Chat.id and answers only the six states and the minimal card. */
function assertContractShape(sources) {
  const contract = withoutComments(sources[CONTRACTS])
  assert(contract.includes("export const CONTACT_CARD_FOR_CONVERSATION_QUERY_V1 = 'contacts.ContactCardForConversationQuery.v1' as const"),
    'the query contract id changed')
  assert.deepEqual(fieldNames(typeBody(contract, 'ContactCardForConversationQueryV1')), ['chatId', 'contract'], 'the query accepts more than an exact Chat.id')
  assert.deepEqual(fieldNames(typeBody(contract, 'ContactCardV1')), CARD_FIELDS, 'the card field set changed')
  assert.deepEqual(fieldNames(typeBody(contract, 'ContactCardChannelV1')), CHANNEL_FIELDS, 'the channel field set changed')
  const statusBlock = contract.slice(contract.indexOf('export type ContactCardForConversationStatusV1'), contract.indexOf('export type ContactCardForConversationResultV1'))
  assert.deepEqual([...statusBlock.matchAll(/'(\w+)'/gu)].map((match) => match[1]), STATUSES, 'the answer states changed')
  assert(/status: 'confirmed'; card: ContactCardV1 \}/u.test(contract), 'confirmed no longer carries exactly the card')
  assert(/status: Exclude<ContactCardForConversationStatusV1, 'confirmed'> \}/u.test(contract), 'a non-confirmed answer may carry data')
  assert(!PROVIDER_VOCABULARY.test(contract), 'provider, transport, conversation or driver vocabulary reached the contract')
  assert(contract.includes("key !== 'contract' && key !== 'chatId'"), 'the parser accepts fields beside the Chat.id')
  assert(contract.includes('input.chatId.trim() !== input.chatId'), 'the parser no longer rejects a padded Chat.id')
  assert(sources[CONTRACTS_INDEX].includes("export * from './contact-card-for-conversation-contracts'"), 'the contract is not exported')
}

function order(source, needles) {
  let cursor = -1
  for (const needle of needles) {
    const at = source.indexOf(needle, cursor + 1)
    assert(at > cursor, `the handler no longer does ${needle} at its place in the protocol`)
    cursor = at
  }
}

/** 2. The handler's protocol: principal, parse, conversation access, RCQ1, Contact access, one read, RCQ1 again. */
function assertHandlerProtocol(sources) {
  const handler = withoutComments(sources[HANDLER])
  order(handler, [
    'ports.authority.currentPrincipal()',
    'if (!isPrincipal(principal)) return answer(\'forbidden\')',
    'parseContactCardForConversationQueryV1(query)',
    'ports.authority.mayReadConversation(principal, chatId) !== true) return answer(\'forbidden\')',
    'readResolution(await ports.resolveConversation(chatId))',
    "if (first.status !== 'resolved') return answer('refused')",
    'ports.authority.mayReadContact(principal, contactId) !== true) return answer(\'forbidden\')',
    'ports.cardSource.findContactCardSource(contactId)',
    'readResolution(await ports.resolveConversation(chatId))',
    "second.contactId !== contactId) return answer('refused')",
    "status: 'confirmed', card: buildContactCardV1(source)",
  ])
  assert.equal((handler.match(/findContactCardSource\(/gu) ?? []).length, 2, 'the Contact is read more than once or by another key')
  assert.equal((handler.match(/ports\.resolveConversation\(/gu) ?? []).length, 2, 'RCQ1 is not asked exactly twice')
  const imports = [...handler.matchAll(/from '([^']+)'/gu)].map((match) => match[1]).sort()
  assert.deepEqual(imports, ['../public/v1/contact-display-policy', '../public/v1/contact-evidence-state', '@/contracts/contacts/v1'],
    'the handler gained a dependency (a foreign module, a database client or a resolver)')
  assert(!/externalId/u.test(handler), 'the handler reads a provider external id')
}

/** 3. The only database reader: Contacts-owned models, exact id, one snapshot, no external id, no write. */
function assertSingleSnapshotRead(sources) {
  const adapter = withoutComments(sources[ADAPTER])
  assert(adapter.includes('isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead'), 'the Contact is not read in one REPEATABLE READ snapshot')
  const models = [...adapter.matchAll(/\btx\.(\w+)\.(\w+)\(/gu)].map((match) => `${match[1]}.${match[2]}`).sort()
  assert.deepEqual(models, ['contact.findUnique', 'contactMerge.count'], 'the reader touches another model or method')
  assert(adapter.includes('where: { id: contactId }'), 'the Contact is not read by its exact id')
  assert(!/\bexternalId\b/u.test(adapter), 'the reader selects a provider external id')
  assert(!/\b(chat|message|driver|mainDriver|telegram\w*|whatsapp\w*|max\w*Connection)\b\s*:/u.test(adapter), 'the reader selects a foreign relation')
  assert(!WRITE_VOCABULARY.test(adapter), 'the reader writes or runs raw SQL')
}

/** 4. The production authority is Identity Access's signed principal and nothing a client holds. */
function assertAuthorityBinding(sources) {
  const authority = withoutComments(sources[AUTHORITY])
  const imports = [...authority.matchAll(/from '([^']+)'/gu)].map((match) => match[1]).sort()
  assert.deepEqual(imports, ['./contact-card-for-conversation', '@/modules/identity-access/public/v1'], 'the authority gained a dependency')
  assert(authority.includes("import { getIntegrationAdminPrincipal } from '@/modules/identity-access/public/v1'"), 'the authority no longer reads the signed principal')
  assert(authority.includes("new Set(['integration_admin_session'])"), 'the set of unrestricted principals changed')
  assert(!CLIENT_IDENTITY.test(authority), 'the authority reads a client-held identity')
}

/** 5. Only the bound reader is public; the handler, ports and bindings are internal to Contacts. */
function assertInternalExposure(sources) {
  const index = withoutComments(sources[PUBLIC_INDEX])
  assert(index.includes('createContactCardForConversationReaderV1,'), 'the bound reader is not public')
  for (const name of INTERNAL_NAMES) assert(!new RegExp(`\\b${name}\\b`, 'u').test(index), `${name} is exported publicly`)
  const operations = withoutComments(sources[OPERATIONS])
  assert(/authority: identityAccessContactCardAuthorityV1,\s*resolveConversation,\s*cardSource: legacyPrismaContactCardSourcePortV1,/u.test(operations),
    'the reader is not bound to the Identity Access authority and the Contacts reader')
  assert.equal(sources[INTERNAL_IMPORTERS].trim(), '', `a file outside Contacts imports the card internals:\n${sources[INTERNAL_IMPORTERS]}`)
}

/** 6. The capability and this control are declared where the machinery reads them. */
function assertGovernanceDeclared(sources) {
  const manifest = JSON.parse(sources[MANIFEST])
  assert(manifest.public_surface.includes(CAPABILITY), `${CAPABILITY} is not declared`)
  assert(manifest.verification.module_tests.includes(CONTROL), 'the control is not a declared module test')
  assert.deepEqual(manifest.allowed_dependencies.map((entry) => entry.context).sort(), ['identity_access'], 'Contacts gained a dependency')
  const registry = JSON.parse(sources[REGISTRY])
  const surface = registry.context_surfaces.find((entry) => entry.owner_context === 'contacts')
  assert(surface?.capabilities.includes(CAPABILITY), 'the registry does not list the read capability')
}

// The one binding a consumer may write: the reader is built over Messaging's RCQ1
// with RCQ1's own query contract, forwarding the exact Chat.id the reader hands it
// (which is the query's exact, untrimmed chatId), and nothing else.
const EXACT_BINDING = /createContactCardForConversationReaderV1\(\s*\(?\s*chatId\s*\)?\s*=>\s*resolveConversationContactV1\(\s*\{\s*contract:\s*RESOLVE_CONVERSATION_CONTACT_QUERY_V1\s*,\s*chatId\s*,?\s*\}\s*\)\s*,?\s*\)/u
// A reader call: the card query contract and a Chat.id that is an identifier or a
// property path, never computed (no call, no trim, no fallback operator, no literal).
const READER_CALL = /^\(\s*\{\s*contract:\s*CONTACT_CARD_FOR_CONVERSATION_QUERY_V1\s*,\s*chatId(?:\s*:\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)?\s*,?\s*\}\s*\)/u
const REQUIRED_IMPORTS = [
  [/^import \{[^}]*\bcreateContactCardForConversationReaderV1\b[^}]*\} from '@\/modules\/contacts\/public\/v1'$/mu, 'the reader is not imported from the Contacts public surface'],
  [/^import \{[^}]*\bresolveConversationContactV1\b[^}]*\} from '@\/modules\/messaging\/public\/v1'$/mu, 'RCQ1 is not imported from the Messaging public surface'],
  [/^import \{[^}]*\bRESOLVE_CONVERSATION_CONTACT_QUERY_V1\b[^}]*\} from '@\/contracts\/messaging\/v1'$/mu, "RCQ1's query contract is not imported from the Messaging contracts"],
  [/^import \{[^}]*\bCONTACT_CARD_FOR_CONVERSATION_QUERY_V1\b[^}]*\} from '@\/contracts\/contacts\/v1'$/mu, "the card query contract is not imported from the Contacts contracts"],
]
// Identity fallbacks and side channels a consumer may never touch: a phone or
// name lookup, another Contact resolver, a client-supplied or derived Contact id,
// a provider id, a direct database read, a client-held operator identity.
const CONSUMER_FORBIDDEN = [
  [/\b(resolveContactByPhoneV1|resolveContactV1|resolveChannelContact\w*|findContactByPhone\w*|lookupContact\w*|contactLookup\w*|ContactLookup\w*|searchContacts?\w*|useContactSearch)\b/u, 'a Contact lookup or resolver other than RCQ1'],
  [/\b\w*[Pp]hone\w*\s*\(/u, 'a phone lookup'],
  [/\b(externalId|providerAccount\w*|providerUserId|telegramId|telegramUserId|whatsappId|maxUserId|username)\b/u, 'a provider id or username'],
  [/\bcontactId\b/u, 'a Contact id that does not come from the confirmed card'],
  [/\bprisma\b|\$queryRaw|\$executeRaw|\bfetch\s*\(/u, 'a direct database read or a network call'],
  [/crm_user_id|getCurrentUser|user-service|cookies\s*\(|headers\s*\(/u, 'a client-held identity'],
]

/** One consumer's content against the binding contract. Throws with the reason. */
function assertConsumerBinding(relative, source) {
  const code = withoutComments(source)
  for (const [pattern, reason] of REQUIRED_IMPORTS) assert(pattern.test(code), `${relative}: ${reason}`)
  const imports = code.match(/^import\b[\s\S]*?\bfrom\s+'[^']+'/gmu) ?? []
  assert(!imports.some((statement) => /\bas\s+[A-Za-z_$]/u.test(statement)), `${relative}: an import is aliased`)
  for (const name of ['resolveConversationContactV1', 'RESOLVE_CONVERSATION_CONTACT_QUERY_V1', 'createContactCardForConversationReaderV1', 'CONTACT_CARD_FOR_CONVERSATION_QUERY_V1']) {
    assert(!new RegExp(`\\b(const|let|var|function|class)\\s+${name}\\b`, 'u').test(code), `${relative}: ${name} is redefined locally`)
  }
  assert.equal((code.match(/createContactCardForConversationReaderV1\s*\(/gu) ?? []).length, 1, `${relative}: the reader must be built exactly once`)
  assert(EXACT_BINDING.test(code), `${relative}: the reader is not bound to RCQ1 on the exact Chat.id`)
  const declared = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*createContactCardForConversationReaderV1\s*\(/u.exec(code)
  assert(declared !== null, `${relative}: the bound reader is not held in a const`)
  const reader = declared[1]
  const uses = [...code.matchAll(new RegExp(`\\b${reader.replace(/\$/gu, '\\$')}\\b`, 'gu'))]
  assert(uses.length >= 2, `${relative}: the bound reader is never called`)
  for (const use of uses.slice(1)) {
    const rest = code.slice(use.index + reader.length)
    assert(READER_CALL.test(rest), `${relative}: the reader is passed on or called without an exact card query (Chat.id provenance)`)
  }
  const scrubbed = code.replace(/\.card\.contactId\b/gu, '.card.<id>')
  for (const [pattern, reason] of CONSUMER_FORBIDDEN) assert(!pattern.test(scrubbed), `${relative}: ${reason}`)
}

/** 7. The reader's consumers fail closed: none unless allowlisted, and every one bound exactly. */
function assertConsumersFailClosed(sources) {
  const allowlist = JSON.parse(sources[ALLOWLIST])
  const consumers = sources[CONSUMERS].trim().split('\n').filter(Boolean).sort()
  for (const consumer of consumers) {
    assert(allowlist.includes(consumer), `${consumer} uses the card reader but is not an allowlisted consumer`)
  }
  for (const allowed of allowlist) {
    assert(consumers.includes(allowed), `the allowlisted consumer ${allowed} does not use the card reader (stale allowlist)`)
    const source = sources[consumerKey(allowed)]
    assert(typeof source === 'string', `the allowlisted consumer ${allowed} could not be read`)
    assertConsumerBinding(allowed, source)
  }
}

const CHECKS = [
  ['contract_shape', assertContractShape],
  ['handler_protocol', assertHandlerProtocol],
  ['single_snapshot_read', assertSingleSnapshotRead],
  ['authority_binding', assertAuthorityBinding],
  ['internal_exposure', assertInternalExposure],
  ['governance_declared', assertGovernanceDeclared],
  ['consumers_fail_closed', assertConsumersFailClosed],
]

// Isolated consumer fixtures for the binding contract. No real consumer exists in
// CC-1, so these prove now that a future composition is held to it.
const FIXTURE_PATH = 'gravity-mvp/src/infrastructure/ui/contact-card/contact-card-actions.ts'
const VALID_CONSUMER = [
  "'use server'",
  "import { CONTACT_CARD_FOR_CONVERSATION_QUERY_V1 } from '@/contracts/contacts/v1'",
  "import { RESOLVE_CONVERSATION_CONTACT_QUERY_V1 } from '@/contracts/messaging/v1'",
  "import { createContactCardForConversationReaderV1 } from '@/modules/contacts/public/v1'",
  "import { resolveConversationContactV1 } from '@/modules/messaging/public/v1'",
  '',
  'const readContactCard = createContactCardForConversationReaderV1(chatId => resolveConversationContactV1({ contract: RESOLVE_CONVERSATION_CONTACT_QUERY_V1, chatId }))',
  '',
  'export async function loadContactCardV1(chatId: string) {',
  '  const result = await readContactCard({ contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, chatId })',
  '  return result.status === \'confirmed\' ? { open: result.card.contactId } : { open: null }',
  '}',
  '',
].join('\n')
const BINDING = 'createContactCardForConversationReaderV1(chatId => resolveConversationContactV1({ contract: RESOLVE_CONVERSATION_CONTACT_QUERY_V1, chatId }))'
const READ = 'readContactCard({ contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, chatId })'
const swap = (from, to) => {
  assert(VALID_CONSUMER.includes(from), `fixture anchor missing: ${from}`)
  return VALID_CONSUMER.replace(from, to)
}
const BINDING_FIXTURES = [
  ['phone_lookup_resolver', swap(BINDING, "createContactCardForConversationReaderV1(async chatId => ({ status: 'resolved', contactId: (await resolveContactByPhoneV1(chatId)).id }))"), 'not bound to RCQ1'],
  ['client_contact_id_resolver', swap(BINDING, "createContactCardForConversationReaderV1(async () => ({ status: 'resolved', contactId: body.contactId }))"), 'not bound to RCQ1'],
  ['provider_id_resolver', swap(BINDING, "createContactCardForConversationReaderV1(async chatId => ({ status: 'resolved', contactId: await byExternalId(externalId) }))"), 'not bound to RCQ1'],
  ['rcq1_on_another_chat', swap(BINDING, 'createContactCardForConversationReaderV1(chatId => resolveConversationContactV1({ contract: RESOLVE_CONVERSATION_CONTACT_QUERY_V1, chatId: otherChatId }))'), 'not bound to RCQ1'],
  ['rcq1_on_trimmed_chat', swap(BINDING, 'createContactCardForConversationReaderV1(chatId => resolveConversationContactV1({ contract: RESOLVE_CONVERSATION_CONTACT_QUERY_V1, chatId: chatId.trim() }))'), 'not bound to RCQ1'],
  ['rcq1_with_fallback', swap(BINDING, "createContactCardForConversationReaderV1(chatId => resolveConversationContactV1({ contract: RESOLVE_CONVERSATION_CONTACT_QUERY_V1, chatId }).then(r => r.status === 'resolved' ? r : lookupContactByName(chatId)))"), 'not bound to RCQ1'],
  ['named_resolver', swap(BINDING, 'createContactCardForConversationReaderV1(anyResolver)'), 'not bound to RCQ1'],
  ['literal_contract', swap(BINDING, "createContactCardForConversationReaderV1(chatId => resolveConversationContactV1({ contract: 'messaging.ResolveConversationContactQuery.v1', chatId }))"), 'not bound to RCQ1'],
  ['rcq1_redefined', `${VALID_CONSUMER}\nconst resolveConversationContactV1 = async () => ({ status: 'resolved', contactId: 'someone' })\n`, 'redefined locally'],
  ['rcq1_from_elsewhere', swap("from '@/modules/messaging/public/v1'", "from './fake-rcq1'"), 'RCQ1 is not imported'],
  ['aliased_reader', swap('import { createContactCardForConversationReaderV1 }', 'import { createContactCardForConversationReaderV1 as make }'), 'aliased'],
  ['second_reader', `${VALID_CONSUMER}\nconst rogue = createContactCardForConversationReaderV1(byPhone)\n`, 'built exactly once'],
  ['chat_id_from_lookup', swap(READ, 'readContactCard({ contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, chatId: await chatOfPhone(phone) })'), 'Chat.id provenance'],
  ['chat_id_trimmed', swap(READ, 'readContactCard({ contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, chatId: chatId.trim() })'), 'Chat.id provenance'],
  ['chat_id_fallback', swap(READ, 'readContactCard({ contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, chatId: chatId || lastChatId })'), 'Chat.id provenance'],
  ['reader_passed_on', swap(READ, 'readContactCard({ contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, chatId })\n  export const leak = readContactCard'), 'Chat.id provenance'],
  ['client_contact_id_used', swap("{ open: result.card.contactId }", '{ open: request.contactId }'), 'Contact id that does not come from the confirmed card'],
  ['provider_id_used', swap("{ open: null }", '{ open: identity.externalId }'), 'provider id'],
  ['phone_lookup_beside', swap("{ open: null }", '{ open: await findByPhone(result) }'), 'phone lookup'],
  ['database_read', swap("{ open: null }", '{ open: await prisma.chat.findFirst({}) }'), 'direct database read'],
  ['client_identity', swap("{ open: null }", "{ open: (await cookies()).get('crm_user_id') }"), 'client-held identity'],
]
const fixture = (name) => {
  const found = BINDING_FIXTURES.find(([fixtureName]) => fixtureName === name)
  assert(found !== undefined, `unknown fixture ${name}`)
  return found[1]
}

const PROBES = [
  ['query_accepts_contact_id', 'contract_shape', (s) => ({ ...s, [CONTRACTS]: s[CONTRACTS].replace("  chatId: string\n}", '  chatId: string\n  contactId?: string\n}') })],
  ['card_leaks_identity_id', 'contract_shape', (s) => ({ ...s, [CONTRACTS]: s[CONTRACTS].replace('  mergedFromCount: number\n}', '  mergedFromCount: number\n  identityIds: string[]\n}') })],
  ['card_carries_external_id', 'contract_shape', (s) => ({ ...s, [CONTRACTS]: s[CONTRACTS].replace('  channel: string\n', '  channel: string\n  externalId: string\n') })],
  ['refused_carries_data', 'contract_shape', (s) => ({ ...s, [CONTRACTS]: s[CONTRACTS].replace("status: Exclude<ContactCardForConversationStatusV1, 'confirmed'> }", "status: Exclude<ContactCardForConversationStatusV1, 'confirmed'>; card?: ContactCardV1 }") })],
  ['extra_status', 'contract_shape', (s) => ({ ...s, [CONTRACTS]: s[CONTRACTS].replace("  | 'forbidden'\n", "  | 'forbidden'\n  | 'guessed'\n") })],
  ['parser_trims', 'contract_shape', (s) => ({ ...s, [CONTRACTS]: s[CONTRACTS].replace('input.chatId.trim() !== input.chatId', 'false') })],
  ['no_second_resolution', 'handler_protocol', (s) => ({ ...s, [HANDLER]: s[HANDLER].replace('const second = readResolution(await ports.resolveConversation(chatId))', 'const second = first') })],
  ['contact_access_after_read', 'handler_protocol', (s) => ({ ...s, [HANDLER]: s[HANDLER].replace("    if (await ports.authority.mayReadContact(principal, contactId) !== true) return answer('forbidden')\n\n", '') })],
  ['principal_after_parse', 'handler_protocol', (s) => ({ ...s, [HANDLER]: s[HANDLER].replace('    const principal = await ports.authority.currentPrincipal()\n    if (!isPrincipal(principal)) return answer(\'forbidden\')\n\n', '').replace("const { chatId } = parseContactCardForConversationQueryV1(query)\n", "const { chatId } = parseContactCardForConversationQueryV1(query)\n    const principal = await ports.authority.currentPrincipal()\n    if (!isPrincipal(principal)) return answer('forbidden')\n") })],
  ['handler_imports_messaging', 'handler_protocol', (s) => ({ ...s, [HANDLER]: s[HANDLER].replace("import { buildCanonicalContactSummary }", "import { resolveConversationContactV1 } from '@/modules/messaging/public/v1'\nimport { buildCanonicalContactSummary }") })],
  ['handler_reads_phone_fallback', 'handler_protocol', (s) => ({ ...s, [HANDLER]: s[HANDLER].replace('    const source = await ports.cardSource.findContactCardSource(contactId)', '    const source = await ports.cardSource.findContactCardSource(contactId) ?? await ports.cardSource.findContactCardSource(chatId)') })],
  ['reader_without_snapshot', 'single_snapshot_read', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead', 'isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted') })],
  ['reader_selects_external_id', 'single_snapshot_read', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('select: { id: true, channel: true,', 'select: { id: true, externalId: true, channel: true,') })],
  ['reader_reads_chat', 'single_snapshot_read', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('const mergedFromCount = await tx.contactMerge.count', 'const chats = await tx.chat.findMany({ where: { contactId } })\n        const mergedFromCount = await tx.contactMerge.count') })],
  ['reader_writes', 'single_snapshot_read', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('if (contact === null) return null', "if (contact === null) return null\n        await tx.contact.update({ where: { id: contactId }, data: {} })") })],
  ['reader_by_phone', 'single_snapshot_read', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('where: { id: contactId }', 'where: { primaryPhoneId: contactId }') })],
  ['authority_reads_crm_user_id', 'authority_binding', (s) => ({ ...s, [AUTHORITY]: s[AUTHORITY].replace('const principal = await getIntegrationAdminPrincipal()', "const principal = (await cookies()).get('crm_user_id') ? { kind: 'integration_admin_session' } : await getIntegrationAdminPrincipal()") })],
  ['authority_accepts_mobile', 'authority_binding', (s) => ({ ...s, [AUTHORITY]: s[AUTHORITY].replace("new Set(['integration_admin_session'])", "new Set(['integration_admin_session', 'mobile_session'])") })],
  ['authority_uses_user_service', 'authority_binding', (s) => ({ ...s, [AUTHORITY]: s[AUTHORITY].replace("import { getIntegrationAdminPrincipal } from '@/modules/identity-access/public/v1'", "import { getIntegrationAdminPrincipal } from '@/modules/identity-access/public/v1'\nimport { getCurrentUser } from '@/lib/users/user-service'") })],
  ['handler_exported', 'internal_exposure', (s) => ({ ...s, [PUBLIC_INDEX]: s[PUBLIC_INDEX].replace('    createContactCardForConversationReaderV1,\n', '    createContactCardForConversationReaderV1,\n    createContactCardForConversationHandlerV1,\n') })],
  ['reader_unbound', 'internal_exposure', (s) => ({ ...s, [OPERATIONS]: s[OPERATIONS].replace('authority: identityAccessContactCardAuthorityV1,', 'authority: undefined as never,') })],
  ['foreign_internal_import', 'internal_exposure', (s) => ({ ...s, [INTERNAL_IMPORTERS]: 'gravity-mvp/src/infrastructure/ui/contact-card/actions.ts\n' })],
  ['capability_undeclared', 'governance_declared', (s) => ({ ...s, [MANIFEST]: s[MANIFEST].replace(`"${CAPABILITY}"`, '"ContactSomethingElse.v1"') })],
  ['control_undeclared', 'governance_declared', (s) => ({ ...s, [MANIFEST]: s[MANIFEST].replace(CONTROL, 'node tools/architecture/check-something-else.mjs') })],
  // A correctly bound consumer is still refused while it is not allowlisted: counting is not admission.
  ['unknown_valid_consumer', 'consumers_fail_closed', (s) => ({ ...s, [CONSUMERS]: `${FIXTURE_PATH}\n`, [consumerKey(FIXTURE_PATH)]: VALID_CONSUMER })],
  ['unknown_rogue_consumer', 'consumers_fail_closed', (s) => ({ ...s, [CONSUMERS]: 'gravity-mvp/src/app/api/contact-card/route.ts\n' })],
  ['stale_allowlist', 'consumers_fail_closed', (s) => ({ ...s, [ALLOWLIST]: JSON.stringify([FIXTURE_PATH]) })],
  ['allowlisted_phone_resolver', 'consumers_fail_closed', (s) => ({ ...s, [ALLOWLIST]: JSON.stringify([FIXTURE_PATH]), [CONSUMERS]: `${FIXTURE_PATH}\n`, [consumerKey(FIXTURE_PATH)]: fixture('phone_lookup_resolver') })],
  ['allowlisted_client_contact_id', 'consumers_fail_closed', (s) => ({ ...s, [ALLOWLIST]: JSON.stringify([FIXTURE_PATH]), [CONSUMERS]: `${FIXTURE_PATH}\n`, [consumerKey(FIXTURE_PATH)]: fixture('client_contact_id_resolver') })],
  ['allowlisted_chat_id_rewritten', 'consumers_fail_closed', (s) => ({ ...s, [ALLOWLIST]: JSON.stringify([FIXTURE_PATH]), [CONSUMERS]: `${FIXTURE_PATH}\n`, [consumerKey(FIXTURE_PATH)]: fixture('chat_id_fallback') })],
  ['allowlisted_provider_id', 'consumers_fail_closed', (s) => ({ ...s, [ALLOWLIST]: JSON.stringify([FIXTURE_PATH]), [CONSUMERS]: `${FIXTURE_PATH}\n`, [consumerKey(FIXTURE_PATH)]: fixture('provider_id_used') })],
]

function gitGrep(args) {
  // git grep exits 1 when nothing matches; only a status above 1 is a failure.
  // --untracked: a file that is not yet committed is still source the control must see.
  const result = spawnSync('git', ['-c', 'safe.directory=*', 'grep', '-l', '--untracked', ...args], { cwd: root, encoding: 'utf8' })
  assert(result.status === 0 || result.status === 1, `a repository scan failed: ${result.stderr}`)
  return result.stdout
}

function main() {
  const relatives = [CONTRACTS, CONTRACTS_INDEX, HANDLER, ADAPTER, AUTHORITY, OPERATIONS, PUBLIC_INDEX, MANIFEST, REGISTRY]
  const sources = Object.fromEntries(relatives.map((relative) => [relative, read(relative)]))
  sources[INTERNAL_IMPORTERS] = gitGrep(['-E',
    'contacts/internal/(contact-card-for-conversation|legacy-prisma-contact-card-source-adapter|identity-access-contact-card-authority)',
    '--', 'gravity-mvp/src', ':(exclude)gravity-mvp/src/modules/contacts'])
  // Every runtime file outside Contacts that names the reader, its resolver type,
  // the card query or the Contacts application module is a consumer.
  sources[CONSUMERS] = gitGrep(['-E',
    'createContactCardForConversationReaderV1|ContactCardConversationResolverV1|ContactCardForConversationQuery|CONTACT_CARD_FOR_CONVERSATION_QUERY_V1|contacts/application/contact-operations',
    '--', 'gravity-mvp/src', ':(exclude)gravity-mvp/src/modules/contacts', ':(exclude)gravity-mvp/src/contracts/contacts',
    ':(exclude)*.test.ts', ':(exclude)*.test.tsx'])
  sources[ALLOWLIST] = JSON.stringify(ALLOWED_CONSUMERS)
  for (const allowed of ALLOWED_CONSUMERS) sources[consumerKey(allowed)] = read(allowed)
  const checks = new Map(CHECKS)
  for (const [, check] of CHECKS) check(sources)

  for (const [name, checkName, mutate] of PROBES) {
    const check = checks.get(checkName)
    assert(check !== undefined, `probe ${name} names an unknown check`)
    const mutated = mutate(sources)
    assert.notDeepEqual(mutated, sources, `probe ${name} changed nothing`)
    let caught = false
    try { check(mutated) } catch { caught = true }
    assert(caught, `probe ${name} was not caught by ${checkName}`)
  }

  // The binding contract against isolated consumer fixtures: the correct binding
  // passes, and every bypass fails for its own reason.
  assertConsumerBinding(FIXTURE_PATH, VALID_CONSUMER)
  for (const [name, source, reason] of BINDING_FIXTURES) {
    let message = null
    try { assertConsumerBinding(FIXTURE_PATH, source) } catch (error) { message = String(error?.message ?? error) }
    assert(message !== null, `binding fixture ${name} was accepted`)
    assert(message.includes(reason), `binding fixture ${name} failed for the wrong reason: ${message}`)
  }

  assert.equal(passingProofCount('\n      Tests  28 passed (28)\n'), 28, 'the plain Vitest summary is no longer parsed')
  assert.equal(passingProofCount(''), null, 'an empty summary must not be read as a passing run')

  // The proofs are what make these invariants behavioural, so this control runs
  // them rather than trusting that something else will. RCQ1's own proofs run
  // beside them: the card's answers are only as exact as RCQ1's.
  const vitest = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'src/contracts/contacts/v1/contact-card-for-conversation-contracts.test.ts',
    'src/modules/contacts/internal/contact-card-for-conversation.test.ts',
    'src/modules/contacts/internal/contact-card-for-conversation.rcq1.test.ts',
    'src/modules/contacts/internal/legacy-prisma-contact-card-source-adapter.test.ts',
    'src/modules/contacts/internal/identity-access-contact-card-authority.test.ts',
    'src/modules/contacts/public/v1/contact-evidence-state.test.ts',
    'src/modules/messaging/public/v1/resolve-conversation-contact.test.ts',
  ], { cwd: path.join(root, 'gravity-mvp'), encoding: 'utf8' })
  assert.equal(vitest.status, 0, `the contact card read model proofs failed:\n${vitest.stdout}\n${vitest.stderr}`)
  const passed = passingProofCount(vitest.stdout)
  assert(passed !== null && passed > 0, `the proofs reported no passing tests:\n${vitest.stdout}`)

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    control: 'contact-card-read-model-boundary',
    checks: CHECKS.length,
    negative_probes: PROBES.length,
    proofs: passed,
    postgres_proof: 'none_in_this_control',
    answer_states: STATUSES.length,
    card_fields: CARD_FIELDS.length,
    unrestricted_principal_kinds: ['integration_admin_session'],
    internal_names_exported: 0,
    consumers_allowlist: ALLOWED_CONSUMERS,
    consumers_outside_contacts: sources[CONSUMERS].trim().split('\n').filter(Boolean).length,
    consumer_binding_fixtures: { valid: 1, rejected: BINDING_FIXTURES.length },
  }, null, 2)}\n`)
}

main()
