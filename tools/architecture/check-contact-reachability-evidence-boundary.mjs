#!/usr/bin/env node

// M3A5 boundary: the Contacts-owned reachability EVIDENCE read stays evidence.
//
// It pins the exact public field sets; that the public vocabulary is `recorded_*`
// and carries no availability, readiness or usability word; that no provider,
// transport, session, runtime or foreign-domain value can reach the contract or
// leave the adapter; that only one Contacts-owned adapter reads a database and only
// Contact plus ContactIdentity; that the projection writes nothing and probes
// nothing; that the canonical conflict semantic is NOT imported here, so this slice
// cannot become a second conflict interpretation; that the existing
// ContactReachability.v1 WRITE facade still exposes exactly one capability and the
// runtime writer is byte-identical; and that no schema, migration or UI surface moves.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const MODULE_DIR = 'gravity-mvp/src/modules/contacts/public/v1'
const VIEW = `${MODULE_DIR}/contact-reachability-evidence-view.ts`
const ADAPTER = `${MODULE_DIR}/legacy-prisma-contact-reachability-evidence-view-adapter.ts`
const PROOF = `${MODULE_DIR}/contact-reachability-evidence-view.test.ts`
const WRITE_FACADE = `${MODULE_DIR}/contact-reachability.ts`
const RUNTIME_WRITER = 'gravity-mvp/src/lib/ReachabilityService.ts'
const OPERATIONS = 'gravity-mvp/src/modules/contacts/application/contact-operations.ts'
const PUBLIC_INDEX = `${MODULE_DIR}/index.ts`
const MANIFEST = 'architecture/contexts/v1/manifests/contacts.json'

// The exact public contract. Anything else is a boundary change.
const VIEW_FIELDS = ['contactId', 'identities', 'channels']
const IDENTITY_FIELDS = ['identityId', 'channel', 'identityState', 'evidenceStatus', 'evidenceAt']
const CHANNEL_FIELDS = [
  'channel', 'identityCount', 'activeIdentityCount',
  'recordedConfirmedCount', 'recordedUnreachableCount', 'noEvidenceCount', 'latestEvidenceAt',
]
// The exact public evidence vocabulary.
const EVIDENCE_STATUSES = ['recorded_confirmed', 'recorded_unreachable', 'no_evidence']

// "unreachable" is the persisted fact's own word and part of the mandated naming;
// strip it before scanning so the scan cannot forbid the required vocabulary.
const SANCTIONED = /recorded_unreachable|recordedUnreachableCount|unreachable/giu
// Words that would assert availability, readiness or permission. Compared against
// identifier WORDS rather than as substrings: a regex with word boundaries misses
// `ContactChannelAvailableV1`, and a bare substring match would flag the legitimate
// `reachability`/`already`. Identifiers are split on case and underscore first.
const AVAILABILITY_WORDS = new Set([
  'available', 'availability', 'reachable', 'ready', 'readiness',
  'deliverable', 'online', 'sendable', 'usable', 'permitted',
])

function identifierWords(source) {
  const words = new Set()
  for (const [token] of source.matchAll(/[A-Za-z_][A-Za-z0-9_]*/gu)) {
    for (const part of token.split(/_+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/u)) {
      if (part) words.add(part.toLowerCase())
    }
  }
  return words
}

function firstAvailabilityClaim(source) {
  for (const word of identifierWords(source)) {
    if (AVAILABILITY_WORDS.has(word)) return word
  }
  return null
}
// Provider, transport and session vocabulary.
const PROVIDER_LEAK = /\bexternalId\b|\bexternalUserId\b|\bprovider(?:User|Account|Target)Id\b|\btransport(?:Ref|ConnectionId|Generation)\b|\bconnectionId\b|\bsessionId\b|\bbotToken\b/u
// Foreign-domain state.
const FOREIGN_STATE = /\bchatId\b|\bmessageId\b|\bconversation(?:Id|Route)\b|\bdeliveryStatus\b|\bdriverId\b|\btaskId\b|\bcallId\b|\bwsConnected\b/u
const PROBING = /check-reachability|\bliveReachability\b|fetch\(|axios|https?:\/\//u
const PRISMA = /@prisma\/client|@\/lib\/prisma|prisma\./u
const FOREIGN_IMPORT = /@\/modules\/(?:messaging|calling|work-management|fleet-operations|telegram-channel|max-channel|whatsapp-channel|platform-shell)\b/u
// The canonical conflict semantic must not be consumed here.
const CONFLICT_SEMANTIC = /resolveContactIdentityConflictStateV1|contact-identity-conflict-state|ContactIdentityConflictView|hasPersonBlockingIdentityConflictV1|isPersonBlockingIdentityConflictEntryV1|identityConflicts/u

function parse(relative, source) {
  return ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function withoutComments(relative, source) {
  return ts.createPrinter({ removeComments: true }).printFile(parse(relative, source))
}

function moduleReferences(relative, source) {
  const references = []
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      references.push(node.moduleSpecifier.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(relative, source))
  return references
}

function typeMembers(relative, source, typeName) {
  const file = parse(relative, source)
  let members = null
  const visit = (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName && ts.isTypeLiteralNode(node.type)) {
      members = node.type.members.map((member) => member.name?.getText(file)).filter(Boolean)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert(members !== null, `type not found or not a literal: ${typeName}`)
  return members
}

function typeText(relative, source, names) {
  const stripped = withoutComments(relative, source)
  const file = parse(relative, stripped)
  let text = ''
  const visit = (node) => {
    if (ts.isTypeAliasDeclaration(node) && names.includes(node.name.text)) text += `\n${node.getText(file)}`
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert(text !== '', `no contract types found among ${names.join(', ')}`)
  return text
}

export function passingProofCount(stdout) {
  const plain = stripVTControlCharacters(String(stdout ?? ''))
  const matched = /Tests\s+(\d+)\s+passed/u.exec(plain)
  return matched === null ? null : Number(matched[1])
}

/** 1. The contract is exactly the declared field set, with no availability verdict. */
function assertContractShape(sources) {
  assert.deepEqual(typeMembers(VIEW, sources[VIEW], 'ContactReachabilityEvidenceViewV1').sort(),
    [...VIEW_FIELDS].sort(), 'ContactReachabilityEvidenceView.v1 field set changed')
  assert.deepEqual(typeMembers(VIEW, sources[VIEW], 'ContactReachabilityIdentityEvidenceV1').sort(),
    [...IDENTITY_FIELDS].sort(), 'the identity evidence field set changed')
  assert.deepEqual(typeMembers(VIEW, sources[VIEW], 'ContactReachabilityChannelEvidenceV1').sort(),
    [...CHANNEL_FIELDS].sort(), 'the channel evidence field set changed')
  // A channel-level verdict is exactly what this contract must never gain.
  for (const forbidden of ['evidenceSummary', 'channelStatus', 'summary', 'verdict']) {
    assert(!typeMembers(VIEW, sources[VIEW], 'ContactReachabilityChannelEvidenceV1').includes(forbidden),
      `the channel aggregate gained a verdict field: ${forbidden}`)
  }
}

/** 2. The public vocabulary is recorded_*, and nothing claims availability. */
function assertEvidenceVocabulary(sources) {
  const view = withoutComments(VIEW, sources[VIEW])
  const statuses = typeText(VIEW, sources[VIEW], ['ContactReachabilityEvidenceStatusV1'])
  for (const status of EVIDENCE_STATUSES) {
    assert(statuses.includes(`'${status}'`), `the evidence vocabulary is missing ${status}`)
  }
  // Exactly three members, so no fourth status can appear unreviewed.
  assert.equal((statuses.match(/'/gu) ?? []).length / 2, EVIDENCE_STATUSES.length,
    'the evidence status union changed size')
  for (const banned of ['confirmed_evidence', 'unreachable_evidence', "'confirmed'", "'unreachable'", "'unknown'"]) {
    assert(!statuses.includes(banned), `the public vocabulary leaks a stored or superseded spelling: ${banned}`)
  }
  // No availability claim anywhere in the module or its contract.
  const claim = firstAvailabilityClaim(view.replace(SANCTIONED, ''))
  assert.equal(claim, null, `the evidence read claims availability: ${claim}`)
  // identityState is Contacts lifecycle only.
  assert.deepEqual(typeText(VIEW, sources[VIEW], ['ContactReachabilityIdentityStateV1']).match(/'[a-z_]+'/gu).sort(),
    ["'active'", "'inactive'"], 'identityState is no longer Contacts lifecycle only')
}

/** 3. No provider, foreign-domain or runtime value in the contract; timestamp only. */
function assertNoLeak(sources) {
  const contract = typeText(VIEW, sources[VIEW], [
    'ContactReachabilityEvidenceViewV1',
    'ContactReachabilityIdentityEvidenceV1',
    'ContactReachabilityChannelEvidenceV1',
  ])
  for (const [kind, pattern] of [['provider detail', PROVIDER_LEAK], ['foreign-domain state', FOREIGN_STATE]]) {
    const hit = pattern.exec(contract)
    assert.equal(hit, null, `the contract carries ${kind}: ${hit?.[0]}`)
  }
  // Timestamp only: no TTL, no derived age, no freshness enum.
  for (const forbidden of ['ageMs', 'freshness', 'isFresh', 'isStale', 'ttl', 'maxAge', 'checkedAt']) {
    assert(!contract.includes(forbidden), `the contract exposes a freshness or check-time notion: ${forbidden}`)
  }
  assert(contract.includes('evidenceAt'), 'the contract does not expose evidenceAt')
}

/** 4. The conflict semantic is not consumed here. */
function assertNoConflictDuplication(sources) {
  for (const relative of [VIEW, ADAPTER]) {
    const hit = CONFLICT_SEMANTIC.exec(withoutComments(relative, sources[relative]))
    assert.equal(hit, null, `${relative} consumes or re-derives conflict semantics: ${hit?.[0]}`)
  }
  for (const reference of moduleReferences(VIEW, sources[VIEW])) {
    assert(!reference.includes('conflict'), `the evidence read imports a conflict module: ${reference}`)
  }
}

/** 5. One Contacts-owned reader, two models, no probing, no write. */
function assertPersistenceOwnership(sources) {
  const view = withoutComments(VIEW, sources[VIEW])
  assert.equal(PRISMA.exec(view), null, 'the projection reaches a database')
  assert.equal(FOREIGN_IMPORT.exec(view), null, 'the projection imports a foreign domain')
  assert.equal(PROBING.exec(view), null, 'the projection probes a provider')
  assert.deepEqual(moduleReferences(VIEW, sources[VIEW]), [],
    'the projection gained a dependency; it must stay self-contained')

  const adapter = withoutComments(ADAPTER, sources[ADAPTER])
  assert.equal(FOREIGN_IMPORT.exec(adapter), null, 'the adapter imports a foreign domain')
  assert.equal(PROBING.exec(adapter), null, 'the adapter probes a provider')
  const models = [...adapter.matchAll(/prisma\.([a-zA-Z]+)\./gu)].map((match) => match[1])
  assert(models.length > 0, 'the adapter reads nothing')
  for (const model of models) {
    assert(['contact', 'contactIdentity'].includes(model),
      `the adapter reads a model this view does not own: prisma.${model}`)
  }
  for (const forbidden of ['prisma.chat', 'prisma.message', 'prisma.driver', 'prisma.task', 'prisma.call']) {
    assert(!adapter.includes(forbidden), `the adapter reads ${forbidden}`)
  }
  // A read capability may not write, and may not select a provider target.
  for (const write of ['.update(', '.create(', '.delete(', '.upsert(', '.updateMany(', '.deleteMany(']) {
    assert(!adapter.includes(write), `the adapter writes: ${write}`)
    assert(!view.includes(write), `the projection writes: ${write}`)
  }
  for (const forbidden of ['externalId', 'metadata']) {
    assert(!adapter.includes(forbidden), `the adapter selects ${forbidden}, which the projection does not need`)
  }
}

/** 6. The composition is wired to the Contacts-owned port and on the public surface. */
function assertComposition(sources) {
  assert(withoutComments(OPERATIONS, sources[OPERATIONS])
    .includes('createContactReachabilityEvidenceViewHandlerV1(legacyPrismaContactReachabilityEvidenceViewPortV1)'),
    'the operation is not wired to the Contacts-owned port')
  assert(sources[OPERATIONS].includes('getContactReachabilityEvidenceViewV1'), 'the public operation is missing')
  assert(sources[PUBLIC_INDEX].includes('buildContactReachabilityEvidenceViewV1'),
    'the evidence read is not on the public surface')
}

/** 7. The existing WRITE facade and runtime writer are untouched. */
function assertWriterIsolation(sources) {
  // ContactReachability.v1 stays exactly one capability: a read must not widen it.
  const facade = withoutComments(WRITE_FACADE, sources[WRITE_FACADE])
  const exported = [...facade.matchAll(/^\s{4}([a-zA-Z]+):/gmu)].map((match) => match[1])
  assert.deepEqual(exported, ['recordExactProviderReachability'],
    `the ContactReachability.v1 write facade no longer exposes exactly one capability: ${exported.join(', ')}`)
  assert(!facade.includes('EvidenceView'), 'the read capability was folded into the write facade')
  // The runtime writer is byte-identical to the reviewed bytes.
  assert.equal(
    createHash('sha256').update(sources[RUNTIME_WRITER]).digest('hex'),
    'a3935cadbcdcd743814b8dd08c01cefcf2947a1ca830beba3f35b1c32dd79970',
    'ReachabilityService.ts changed; M3A5 must not touch the runtime reachability writer',
  )
}

/** 8. No schema, migration or UI surface moved. */
function assertNoSchemaOrUi() {
  const dirty = spawnSync('git', ['-c', 'safe.directory=*', 'status', '--porcelain', '--',
    'gravity-mvp/prisma',
    'gravity-mvp/src/modules/contacts/public/v1/client-ui',
    'gravity-mvp/src/app/messages',
    'gravity-mvp/src/modules/platform-shell',
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(dirty.stdout.trim(), '',
    `this slice touches schema, migrations or a UI surface: ${dirty.stdout.trim()}`)
}

/** 9. The Contacts manifest declares the capability and the control. */
function assertGovernanceDeclared(sources) {
  const manifest = JSON.parse(sources[MANIFEST])
  assert(manifest.public_surface.includes('ContactReachabilityEvidenceView.v1'), 'the capability is not declared')
  assert(manifest.verification.module_tests.includes('node tools/architecture/check-contact-reachability-evidence-boundary.mjs'),
    'the control is not a declared module test')
  assert.deepEqual(manifest.allowed_dependencies.map((entry) => entry.context).sort(), ['identity_access'],
    'Contacts gained a dependency: the evidence read must not aggregate other domains')
}

const CHECKS = [
  ['contract_shape', assertContractShape],
  ['evidence_vocabulary', assertEvidenceVocabulary],
  ['no_leak', assertNoLeak],
  ['no_conflict_duplication', assertNoConflictDuplication],
  ['persistence_ownership', assertPersistenceOwnership],
  ['composition', assertComposition],
  ['writer_isolation', assertWriterIsolation],
  ['no_schema_or_ui', assertNoSchemaOrUi],
  ['governance_declared', assertGovernanceDeclared],
]

const PROBES = [
  ['view_gains_field', 'contract_shape', (s) => ({ ...s, [VIEW]: s[VIEW].replace('  contactId: string\n  identities', '  contactId: string\n  reachable: boolean\n  identities') })],
  ['identity_gains_field', 'contract_shape', (s) => ({ ...s, [VIEW]: s[VIEW].replace('  evidenceStatus: ContactReachabilityEvidenceStatusV1\n', '  evidenceStatus: ContactReachabilityEvidenceStatusV1\n  externalId: string\n') })],
  ['channel_gains_verdict', 'contract_shape', (s) => ({ ...s, [VIEW]: s[VIEW].replace('  latestEvidenceAt: string | null\n}', '  latestEvidenceAt: string | null\n  evidenceSummary: string\n}') })],
  ['status_renamed_to_confirmed_evidence', 'evidence_vocabulary', (s) => ({ ...s, [VIEW]: s[VIEW].replace("'recorded_confirmed'", "'confirmed_evidence'") })],
  ['status_leaks_stored_spelling', 'evidence_vocabulary', (s) => ({ ...s, [VIEW]: s[VIEW].replace("| 'no_evidence'", "| 'no_evidence'\n  | 'unknown'") })],
  ['module_claims_availability', 'evidence_vocabulary', (s) => ({ ...s, [VIEW]: s[VIEW].replace('export type ContactReachabilityEvidenceStatusV1', 'export type ContactChannelAvailableV1 = boolean\nexport type ContactReachabilityEvidenceStatusV1') })],
  ['identity_state_absorbs_conflict', 'evidence_vocabulary', (s) => ({ ...s, [VIEW]: s[VIEW].replace("export type ContactReachabilityIdentityStateV1 = 'active' | 'inactive'", "export type ContactReachabilityIdentityStateV1 = 'active' | 'inactive' | 'conflicted'") })],
  ['contract_carries_provider_target', 'no_leak', (s) => ({ ...s, [VIEW]: s[VIEW].replace('  channel: string\n  identityState', '  providerTargetId: string\n  channel: string\n  identityState') })],
  ['contract_carries_chat_id', 'no_leak', (s) => ({ ...s, [VIEW]: s[VIEW].replace('  evidenceAt: string | null\n}', '  evidenceAt: string | null\n  chatId: string\n}') })],
  ['contract_adds_age', 'no_leak', (s) => ({ ...s, [VIEW]: s[VIEW].replace('  latestEvidenceAt: string | null\n}', '  latestEvidenceAt: string | null\n  ageMs: number\n}') })],
  ['contract_adds_freshness', 'no_leak', (s) => ({ ...s, [VIEW]: s[VIEW].replace('  evidenceAt: string | null\n}', "  evidenceAt: string | null\n  freshness: 'fresh' | 'stale'\n}") })],
  ['view_imports_conflict_state', 'no_conflict_duplication', (s) => ({ ...s, [VIEW]: s[VIEW].replace('export type ContactReachabilityEvidenceStatusV1', "import { resolveContactIdentityConflictStateV1 } from './contact-identity-conflict-state'\n\nexport type ContactReachabilityEvidenceStatusV1") })],
  ['adapter_reads_conflict_journal', 'no_conflict_duplication', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('        id: true,\n        identities', '        id: true,\n        customFields: true,\n        identities') .replace('      id: contact.id,', '      id: contact.id,\n      identityConflicts: true,') })],
  ['view_reaches_database', 'persistence_ownership', (s) => ({ ...s, [VIEW]: s[VIEW].replace('export type ContactReachabilityEvidenceStatusV1', "import { prisma } from '@/lib/prisma'\n\nexport type ContactReachabilityEvidenceStatusV1") })],
  ['adapter_reads_chat', 'persistence_ownership', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('if (!contact) return null', 'if (!contact) return null\n    await prisma.chat.findMany({ where: { contactId } })') })],
  ['adapter_selects_external_id', 'persistence_ownership', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('            id: true,\n            channel: true,', '            id: true,\n            externalId: true,\n            channel: true,') })],
  ['adapter_writes', 'persistence_ownership', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('if (!contact) return null', 'if (!contact) return null\n    await prisma.contactIdentity.update({ where: { id: contact.id }, data: {} })') })],
  ['view_probes_provider', 'persistence_ownership', (s) => ({ ...s, [VIEW]: s[VIEW].replace('export type ContactReachabilityEvidenceStatusV1', 'const probe = () => fetch("/api/channels/check-reachability")\n\nexport type ContactReachabilityEvidenceStatusV1') })],
  ['operation_unwired', 'composition', (s) => ({ ...s, [OPERATIONS]: s[OPERATIONS].replace('createContactReachabilityEvidenceViewHandlerV1(legacyPrismaContactReachabilityEvidenceViewPortV1)', 'createContactReachabilityEvidenceViewHandlerV1({ findContactReachabilityEvidenceSource: async () => null })') })],
  ['write_facade_widened', 'writer_isolation', (s) => ({ ...s, [WRITE_FACADE]: s[WRITE_FACADE].replace('    recordExactProviderReachability: (', '    getEvidenceView: () => null,\n    recordExactProviderReachability: (') })],
  ['runtime_writer_changed', 'writer_isolation', (s) => ({ ...s, [RUNTIME_WRITER]: `${s[RUNTIME_WRITER]}\n// touched\n` })],
  ['capability_undeclared', 'governance_declared', (s) => ({ ...s, [MANIFEST]: s[MANIFEST].replace('"ContactReachabilityEvidenceView.v1"', '"SomethingElse.v1"') })],
  ['contacts_gains_dependency', 'governance_declared', (s) => ({ ...s, [MANIFEST]: s[MANIFEST].replace('"context": "identity_access"', '"context": "messaging"') })],
]

function main() {
  const relatives = [VIEW, ADAPTER, PROOF, WRITE_FACADE, RUNTIME_WRITER, OPERATIONS, PUBLIC_INDEX, MANIFEST]
  const sources = Object.fromEntries(relatives.map((relative) => [relative, read(relative)]))
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

  assert.equal(passingProofCount('\n      Tests  27 passed (27)\n'), 27, 'the plain Vitest summary is no longer parsed')
  assert.equal(passingProofCount('\u001B[32m      Tests \u001B[39m 27 passed\u001B[90m (27)\u001B[39m\n'), 27,
    'an ANSI-decorated Vitest summary is not parsed')
  assert.equal(passingProofCount(''), null, 'an empty summary must not be read as a passing run')

  const vitest = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'src/modules/contacts/public/v1/contact-reachability-evidence-view.test.ts',
  ], { cwd: path.join(root, 'gravity-mvp'), encoding: 'utf8' })
  assert.equal(vitest.status, 0, `the reachability evidence proofs failed:\n${vitest.stdout}\n${vitest.stderr}`)
  const passed = passingProofCount(vitest.stdout)
  assert(passed !== null && passed > 0, `the proofs reported no passing tests:\n${vitest.stdout}`)

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    control: 'contact-reachability-evidence-boundary',
    checks: CHECKS.length,
    negative_probes: PROBES.length,
    evidence_view_tests: passed,
    view_fields: VIEW_FIELDS.length,
    evidence_statuses: EVIDENCE_STATUSES.length,
    database_models_read: 2,
    write_facade_capabilities: 1,
    runtime_writer_unchanged: true,
    conflict_semantic_imported: false,
  }, null, 2)}\n`)
}

main()
