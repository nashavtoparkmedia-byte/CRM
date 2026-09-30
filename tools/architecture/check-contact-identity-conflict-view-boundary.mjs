#!/usr/bin/env node

// M3A4 S1 boundary: Contacts owns ONE identity-conflict semantic, and every
// consumer projects from it.
//
// It pins that the canonical projection is the only place either conflict store
// is interpreted; that ContactCardSummary and ContactIdentityConflictView.v1 both
// read it rather than carrying a rule of their own; that the shared blocking
// primitives live in ContactEvidenceState so the read model cannot disagree with
// the deny paths; that the existing runtime person-blocking call contract is
// untouched; that no provider, transport, runtime or infrastructure value can
// reach the public view or the panel; that only one Contacts-owned adapter reads a
// database, and only Contacts-owned models; and that this slice implements
// neither the journal dedup repair (S3) nor the fail-closed dangling join (S4).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const MODULE_DIR = 'gravity-mvp/src/modules/contacts/public/v1'
const STATE = `${MODULE_DIR}/contact-identity-conflict-state.ts`
const VIEW = `${MODULE_DIR}/contact-identity-conflict-view.ts`
const ADAPTER = `${MODULE_DIR}/legacy-prisma-contact-identity-conflict-view-adapter.ts`
const PANEL = `${MODULE_DIR}/client-ui/ContactChannelStatePanel.tsx`
const SUMMARY = `${MODULE_DIR}/contact-card-summary.ts`
const SUMMARY_ADAPTER = `${MODULE_DIR}/legacy-prisma-contact-card-summary-adapter.ts`
const EVIDENCE = `${MODULE_DIR}/contact-evidence-state.ts`
const DRIVER = `${MODULE_DIR}/driver-person-confirmation.ts`
const COMPOSER = 'gravity-mvp/src/modules/contacts/internal/contact-merge-state-composer.ts'
const REACHABILITY = 'gravity-mvp/src/lib/ReachabilityService.ts'
const CONVERSATION = `${MODULE_DIR}/legacy-prisma-contact-conversation-adapter.ts`
const TELEGRAM_AUTHORITY = 'gravity-mvp/src/modules/telegram-channel/public/v1/manual-driver-telegram-link-authority.ts'
const OPERATIONS = 'gravity-mvp/src/modules/contacts/application/contact-operations.ts'
const PUBLIC_INDEX = `${MODULE_DIR}/index.ts`
const MANIFEST = 'architecture/contexts/v1/manifests/contacts.json'
const STATE_PROOF = `${MODULE_DIR}/contact-identity-conflict-state.test.ts`
const VIEW_PROOF = `${MODULE_DIR}/contact-identity-conflict-view.test.ts`
const PANEL_PROOF = `${MODULE_DIR}/client-ui/ContactChannelStatePanel.test.tsx`

// The exact public contract of the view. Anything else is a boundary change.
const VIEW_FIELDS = [
  'contactId', 'hasOpenConflict', 'hasPersonBlockingConflict',
  'closedConflictCount', 'channels', 'conflicts',
]
const ENTRY_FIELDS = [
  'identityId', 'channel', 'conflictClass', 'scope',
  'blocksPersonOperations', 'identityState', 'detectedAt',
]
const CHANNEL_FIELDS = ['channel', 'openConflictCount', 'personBlockingCount']
// ContactCardSummary.v1 must not grow a field while its conflict source changes.
const SUMMARY_FIELDS = [
  'contactId', 'displayName', 'displayTitle', 'primaryPhone', 'phoneCount',
  'channels', 'hasIdentityConflict', 'source', 'lineage',
]
const SUMMARY_CHANNEL_FIELDS = ['channel', 'identityCount', 'hasActiveIdentity', 'conflictState']

// Provider, transport and session vocabulary may never appear in a public
// contract or in the panel.
const PROVIDER_LEAK = /\bexternalId\b|\bexternalUserId\b|\bprovider(?:User|Account)Id\b|\btransport(?:Ref|ConnectionId|Generation)\b|\bconnectionId\b|\bsenderId\b|\bpeerId\b|\bbotToken\b|\busername\b|\bsessionId\b/u
// Stored private payloads and infrastructure detail.
const PRIVATE_PAYLOAD_LEAK = /\bevidenceRoot\b|\bdetails\b|\breason\b|\bresolution\b|\bresolvedAt\b|\bruntimeVersion\b|\breleaseCandidate\b|\botherContactIds?\b|\bnormalizedPhone\b/u
// Foreign-domain state the Contacts conflict read must never carry.
const FOREIGN_STATE = /\bchatId\b|\bconversation(?:Id|Route)?\b|\bmessageId\b|\bdeliveryStatus\b|\bunreadCount\b|\bdriverIds?\b|\bprofileClusterKey\b|\bfullName\b|\btaskId\b|\bcallId\b|\breadiness\b|\bwsConnected\b/u
const PROBING = /check-reachability|\breachabilityStatus\b|\bliveReachability\b|providerAccountId/u
const PRISMA = /@prisma\/client|@\/lib\/prisma|prisma\./u
const FOREIGN_IMPORT = /@\/modules\/(?:messaging|calling|work-management|fleet-operations|telegram-channel|max-channel|whatsapp-channel|platform-shell)\b/u

function parse(relative, source) {
  return ts.createSourceFile(
    relative, source, ts.ScriptTarget.Latest, true,
    relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
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

/** Members of one type alias, so a contract is asserted rather than grepped. */
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

/** 1. The view contract is exactly the declared provider-neutral field set. */
function assertViewShape(sources) {
  assert.deepEqual(
    typeMembers(VIEW, sources[VIEW], 'ContactIdentityConflictViewV1').sort(),
    [...VIEW_FIELDS].sort(),
    'ContactIdentityConflictView.v1 field set changed',
  )
  assert.deepEqual(
    typeMembers(VIEW, sources[VIEW], 'ContactIdentityConflictViewEntryV1').sort(),
    [...ENTRY_FIELDS].sort(),
    'the conflict entry field set changed',
  )
  assert.deepEqual(
    typeMembers(VIEW, sources[VIEW], 'ContactIdentityConflictViewChannelV1').sort(),
    [...CHANNEL_FIELDS].sort(),
    'the channel rollup field set changed',
  )
  // Stored status is deliberately absent: every returned entry is open.
  assert(!typeMembers(VIEW, sources[VIEW], 'ContactIdentityConflictViewEntryV1').includes('status'),
    'the public entry exposes stored status even though only open entries are returned')
}

/** 2. ContactCardSummary.v1 keeps its exact shipped field set. */
function assertSummaryShapeUnchanged(sources) {
  assert.deepEqual(
    typeMembers(SUMMARY, sources[SUMMARY], 'ContactCardSummaryV1').sort(),
    [...SUMMARY_FIELDS].sort(),
    'ContactCardSummary.v1 field set changed',
  )
  assert.deepEqual(
    typeMembers(SUMMARY, sources[SUMMARY], 'ContactCardChannelSummaryV1').sort(),
    [...SUMMARY_CHANNEL_FIELDS].sort(),
    'the summary channel field set changed',
  )
}

/** 3. No provider, private-payload or foreign-domain vocabulary in public contracts or the panel. */
function assertNoLeak(sources) {
  const viewContract = typeText(VIEW, sources[VIEW], [
    'ContactIdentityConflictViewV1',
    'ContactIdentityConflictViewEntryV1',
    'ContactIdentityConflictViewChannelV1',
  ])
  const summaryContract = typeText(SUMMARY, sources[SUMMARY], [
    'ContactCardSummaryV1', 'ContactCardChannelSummaryV1',
  ])
  for (const [label, contract] of [['view', viewContract], ['summary', summaryContract]]) {
    for (const [kind, pattern] of [
      ['provider detail', PROVIDER_LEAK],
      ['a private stored payload', PRIVATE_PAYLOAD_LEAK],
      ['foreign-domain state', FOREIGN_STATE],
    ]) {
      const hit = pattern.exec(contract)
      assert.equal(hit, null, `the ${label} contract carries ${kind}: ${hit?.[0]}`)
    }
  }
  // The panel renders the contract, so it cannot render what the contract lacks.
  const panel = withoutComments(PANEL, sources[PANEL])
  for (const [kind, pattern] of [
    ['provider detail', PROVIDER_LEAK],
    ['a private stored payload', PRIVATE_PAYLOAD_LEAK],
    ['foreign-domain state', FOREIGN_STATE],
  ]) {
    const hit = pattern.exec(panel)
    assert.equal(hit, null, `the channel-state panel references ${kind}: ${hit?.[0]}`)
  }
}

/** 4. One canonical semantic, and it is the only interpreter of either store. */
function assertOneCanonicalSemantic(sources) {
  const state = withoutComments(STATE, sources[STATE])
  assert(state.includes('export function resolveContactIdentityConflictStateV1('),
    'the canonical conflict projection is missing')
  // It reuses the shared blocking rules rather than restating them. The call form
  // is required, not the identifier: an import that nothing calls proves nothing.
  for (const call of [
    'isPersonBlockingIdentityConflictEntryV1(record, identity)',
    'isProvenTransportOnlyIdentityConflictV1(record, identity)',
    'hasOpenDriverPersonContradictionV1(input.customFields)',
    'identityEvidenceState(identity.metadata)',
  ]) {
    assert(state.includes(call), `the canonical projection does not call ${call}`)
  }
  assert(moduleReferences(STATE, sources[STATE]).includes('./contact-evidence-state'),
    'the canonical projection does not source its rules from ContactEvidenceState')

  // No consumer may reach either stored conflict store, or call a blocking rule,
  // on its own. Selecting already-classified entries out of the canonical state is
  // not a rule; reading raw JSON or re-deciding what blocks is.
  const RAW_STORE_ACCESS = /\bidentityConflicts\b|\bconflictType\b|isProvenTransportOnlyIdentityConflictV1|isPersonBlockingIdentityConflictEntryV1|hasPersonBlockingIdentityConflictV1|hasOpenDriverPersonContradictionV1|identityEvidenceState/u
  for (const relative of [VIEW, SUMMARY, PANEL, ADAPTER, SUMMARY_ADAPTER]) {
    const hit = RAW_STORE_ACCESS.exec(withoutComments(relative, sources[relative]))
    assert.equal(hit, null, `${relative} interprets conflict state itself: ${hit?.[0]}`)
  }
  // Both consumers read the canonical state.
  for (const relative of [VIEW, SUMMARY]) {
    assert(withoutComments(relative, sources[relative]).includes('resolveContactIdentityConflictStateV1('),
      `${relative} does not consume the canonical conflict state`)
  }
  // The view selects open entries from that state rather than from stored JSON.
  assert(withoutComments(VIEW, sources[VIEW]).includes("state.entries\n        .filter(entry => entry.status === 'open')")
    || /state\.entries[\s\S]{0,80}entry\.status === 'open'/u.test(withoutComments(VIEW, sources[VIEW])),
    'the view does not select open conflicts from the canonical state')
  assert(withoutComments(SUMMARY, sources[SUMMARY]).includes('hasIdentityConflict: conflictState.hasOpenConflict'),
    'ContactCardSummary.hasIdentityConflict is not the canonical open-conflict answer')
}

/** 5. The shared primitives exist and the runtime call contract is intact. */
function assertRuntimeContractIntact(sources) {
  const evidence = sources[EVIDENCE]
  assert.match(evidence, /export function isPersonBlockingIdentityConflictEntryV1\(\n\s+conflict: unknown,\n\s+identity: PersonBlockingIdentityV1,\n\): boolean \{/u,
    'the entry-level blocking primitive is missing or reshaped')
  assert.match(evidence, /export function hasOpenDriverPersonContradictionV1\(customFields: unknown\): boolean \{/u,
    'the contact-scoped driver predicate is missing or reshaped')
  // The aggregate keeps its exact signature AND is expressed through the primitive.
  assert.match(evidence, /export function hasPersonBlockingIdentityConflictV1\(\n\s+customFields: unknown,\n\s+identity: PersonBlockingIdentityV1,\n\): boolean \{/u,
    'hasPersonBlockingIdentityConflictV1 changed signature; the runtime deny paths bind it')
  assert.match(evidence, /conflicts\.some\(item => isPersonBlockingIdentityConflictEntryV1\(item, identity\)\)/u,
    'the aggregate does not delegate to the entry-level primitive')
  // The three deny paths must still call the same shape.
  assert.match(sources[REACHABILITY], /identityEvidenceState\(identity\.metadata\)\.conflictState === 'conflicted'\n\s+\|\| hasPersonBlockingIdentityConflictV1\(identity\.contact\.customFields, identity\)/u,
    'the reachability deny path changed shape')
  assert(sources[CONVERSATION].includes('hasPersonBlockingIdentityConflictV1(contact.customFields, {'),
    'the contact conversation deny path changed shape')
  assert(sources[TELEGRAM_AUTHORITY].includes('hasPersonBlockingIdentityConflictV1(contact?.customFields, {'),
    'the Telegram driver link deny path changed shape')
  // The driver authority reads the shared predicate, not a fourth inline copy.
  assert(sources[DRIVER].includes('hasOpenDriverPersonContradictionV1(contact.customFields)'),
    'the driver confirmation authority does not use the shared predicate')
  const driverInline = /conflict\.conflictType === 'confirmed_driver_cluster_contradiction'/u
    .exec(withoutComments(DRIVER, sources[DRIVER]))
  assert.equal(driverInline, null, 'the driver confirmation authority still carries an inline copy of the rule')
}

/** 6. Only Contacts-owned models are read, by the one adapter, from one composition. */
function assertProjectionOwnership(sources) {
  for (const relative of [STATE, VIEW, PANEL]) {
    const source = withoutComments(relative, sources[relative])
    assert.equal(PRISMA.exec(source), null, `${relative} reaches a database`)
    assert.equal(FOREIGN_IMPORT.exec(source), null, `${relative} imports a foreign domain`)
    assert.equal(PROBING.exec(source), null, `${relative} probes or selects a provider`)
  }
  const adapter = withoutComments(ADAPTER, sources[ADAPTER])
  assert.equal(FOREIGN_IMPORT.exec(adapter), null, 'the adapter imports a foreign domain')
  const models = [...adapter.matchAll(/prisma\.([a-zA-Z]+)\./gu)].map((match) => match[1])
  assert(models.length > 0, 'the adapter reads nothing')
  for (const model of models) {
    assert(['contact', 'contactIdentity'].includes(model),
      `the adapter reads a model this view does not own: prisma.${model}`)
  }
  for (const forbidden of ['prisma.chat', 'prisma.message', 'prisma.driver', 'prisma.task', 'prisma.call']) {
    assert(!adapter.includes(forbidden), `the adapter reads ${forbidden}`)
  }
  const wiring = withoutComments(OPERATIONS, sources[OPERATIONS])
  assert(wiring.includes('createContactIdentityConflictViewHandlerV1(legacyPrismaContactIdentityConflictViewPortV1)'),
    'the operation is not wired to the Contacts-owned port')
  assert(sources[PUBLIC_INDEX].includes('buildContactIdentityConflictViewV1'),
    'the view is not on the public surface')
  assert(sources[OPERATIONS].includes('getContactIdentityConflictViewV1'),
    'the public operation is missing')
}

/** 7. The client surface is presentational, isolated, and offers no action. */
function assertClientSurfaceIsolated(sources) {
  const panel = sources[PANEL]
  assert(panel.startsWith('"use client"'), 'the channel-state panel is not a client component')
  for (const reference of moduleReferences(PANEL, panel)) {
    assert.equal(FOREIGN_IMPORT.exec(reference), null, `the panel imports a foreign domain: ${reference}`)
    assert(reference.startsWith('.') || reference === 'react' || reference.startsWith('react/'),
      `the panel takes an unexpected dependency: ${reference}`)
  }
  const stripped = withoutComments(PANEL, panel)
  for (const forbidden of ['fetch(', 'useEffect', 'useState', 'setInterval', 'setTimeout', 'onClick', '<button', '<form', '<a ']) {
    assert(!stripped.includes(forbidden), `the panel is not purely presentational or offers an action: ${forbidden}`)
  }
  // It must never collapse the four distinct channel states into one. Rendered
  // text only: the comments may name the wording precisely in order to forbid it.
  for (const forbidden of ['недоступ', 'не доставл', 'офлайн']) {
    assert(!stripped.includes(forbidden), `the panel claims channel/delivery availability: ${forbidden}`)
  }
}

/** 8. Neither S3 nor S4 is implemented, and no schema moves. */
function assertNoAdjacentSliceWork(sources) {
  // S3 would change the merge journal union / dedup key.
  assert.match(sources[COMPOSER], /const key = typeof record\.id === 'string'\n\s+\? `id:\$\{record\.id\}`\n\s+: `value:\$\{JSON\.stringify\(item\)\}:\$\{index\}`/u,
    'the merge journal dedup key changed: that is S3, not S1')
  // S4 would make the dangling join fail closed inside the deny rule.
  assert.match(sources[EVIDENCE], /return record\.status === 'open'\n\s+&& record\.identityId === identity\.id\n\s+&& !isProvenTransportOnlyIdentityConflictV1\(record, identity\)/u,
    'the person-blocking rule changed: a fail-closed dangling join is S4, not S1')
  // The view must report the weakness, never repair it.
  assert(withoutComments(STATE, sources[STATE]).includes("'missing'"),
    'the canonical projection cannot express an unresolved identity reference')
  const schema = spawnSync('git', ['-c', 'safe.directory=*', 'status', '--porcelain', '--',
    'gravity-mvp/prisma'], { cwd: root, encoding: 'utf8' })
  assert.equal(schema.stdout.trim(), '', `this slice touches Prisma schema or migrations: ${schema.stdout.trim()}`)
}

/** 9. The Contacts manifest declares the capability and the control. */
function assertGovernanceDeclared(sources) {
  const manifest = JSON.parse(sources[MANIFEST])
  assert(manifest.public_surface.includes('ContactIdentityConflictView.v1'), 'the capability is not declared')
  assert(manifest.verification.module_tests.includes('node tools/architecture/check-contact-identity-conflict-view-boundary.mjs'),
    'the control is not a declared module test')
  assert.deepEqual(manifest.allowed_dependencies.map((entry) => entry.context).sort(), ['identity_access'],
    'Contacts gained a dependency: the conflict view must not aggregate other domains')
}

const CHECKS = [
  ['view_shape', assertViewShape],
  ['summary_shape_unchanged', assertSummaryShapeUnchanged],
  ['no_leak', assertNoLeak],
  ['one_canonical_semantic', assertOneCanonicalSemantic],
  ['runtime_contract_intact', assertRuntimeContractIntact],
  ['projection_ownership', assertProjectionOwnership],
  ['client_surface_isolated', assertClientSurfaceIsolated],
  ['no_adjacent_slice_work', assertNoAdjacentSliceWork],
  ['governance_declared', assertGovernanceDeclared],
]

const PROBES = [
  ['view_gains_field', 'view_shape', (s) => ({ ...s, [VIEW]: s[VIEW].replace('  contactId: string\n', '  contactId: string\n  providerAccountId: string\n') })],
  ['entry_gains_status', 'view_shape', (s) => ({ ...s, [VIEW]: s[VIEW].replace('  identityId: string | null\n  channel: string | null\n  conflictClass', '  identityId: string | null\n  status: string\n  channel: string | null\n  conflictClass') })],
  ['channel_rollup_gains_field', 'view_shape', (s) => ({ ...s, [VIEW]: s[VIEW].replace('  openConflictCount: number\n', '  openConflictCount: number\n  externalId: string\n') })],
  ['summary_gains_field', 'summary_shape_unchanged', (s) => ({ ...s, [SUMMARY]: s[SUMMARY].replace('  hasIdentityConflict: boolean\n', '  hasIdentityConflict: boolean\n  openConflictCount: number\n') })],
  ['view_carries_external_id', 'no_leak', (s) => ({ ...s, [VIEW]: s[VIEW].replace('  channel: string | null\n  conflictClass', '  externalId: string\n  channel: string | null\n  conflictClass') })],
  ['view_carries_raw_details', 'no_leak', (s) => ({ ...s, [VIEW]: s[VIEW].replace('  detectedAt: string | null\n}', '  detectedAt: string | null\n  details: unknown\n}') })],
  ['view_carries_resolution', 'no_leak', (s) => ({ ...s, [VIEW]: s[VIEW].replace('  closedConflictCount: number\n', '  closedConflictCount: number\n  resolution: unknown\n') })],
  ['view_carries_driver_id', 'no_leak', (s) => ({ ...s, [VIEW]: s[VIEW].replace('  scope: ContactIdentityConflictScopeV1\n', '  scope: ContactIdentityConflictScopeV1\n  driverId: string\n') })],
  ['panel_shows_sender_id', 'no_leak', (s) => ({ ...s, [PANEL]: s[PANEL].replace('{channelLabel(conflict.channel)}', '{channelLabel(conflict.channel)}{conflict.senderId}') })],
  ['summary_keeps_own_rule', 'one_canonical_semantic', (s) => ({ ...s, [SUMMARY]: s[SUMMARY].replace('hasIdentityConflict: conflictState.hasOpenConflict', "hasIdentityConflict: channels.some(channel => channel.conflictState === 'conflicted')") })],
  ['view_reads_raw_journal', 'one_canonical_semantic', (s) => ({ ...s, [VIEW]: s[VIEW].replace('const state = resolveContactIdentityConflictStateV1({', 'const raw = (source.customFields as { identityConflicts?: unknown[] })?.identityConflicts ?? []\n  const state = resolveContactIdentityConflictStateV1({') })],
  ['summary_reads_the_latch_itself', 'one_canonical_semantic', (s) => ({ ...s, [SUMMARY]: s[SUMMARY].replace('const conflictState = resolveContactIdentityConflictStateV1({', 'const latched = source.identities.some(identity => identityEvidenceState(identity.metadata).conflictState === \'conflicted\')\n  const conflictState = resolveContactIdentityConflictStateV1({') })],
  ['state_stops_reusing_primitive', 'one_canonical_semantic', (s) => ({ ...s, [STATE]: s[STATE].replace('isPersonBlockingIdentityConflictEntryV1(record, identity)', "record.status === 'open'") })],
  ['state_stops_reusing_transport_proof', 'one_canonical_semantic', (s) => ({ ...s, [STATE]: s[STATE].replace('isProvenTransportOnlyIdentityConflictV1(record, identity)', 'false') })],
  ['aggregate_signature_changed', 'runtime_contract_intact', (s) => ({ ...s, [EVIDENCE]: s[EVIDENCE].replace('export function hasPersonBlockingIdentityConflictV1(\n  customFields: unknown,\n  identity: PersonBlockingIdentityV1,\n): boolean {', 'export function hasPersonBlockingIdentityConflictV1(\n  customFields: unknown,\n  identity: PersonBlockingIdentityV1,\n  identities: readonly PersonBlockingIdentityV1[],\n): boolean {') })],
  ['aggregate_stops_delegating', 'runtime_contract_intact', (s) => ({ ...s, [EVIDENCE]: s[EVIDENCE].replace('conflicts.some(item => isPersonBlockingIdentityConflictEntryV1(item, identity))', "conflicts.some(item => jsonRecord(item).status === 'open')") })],
  ['driver_authority_reverts_to_inline', 'runtime_contract_intact', (s) => ({ ...s, [DRIVER]: s[DRIVER].replace('hasOpenDriverPersonContradictionV1(contact.customFields)', "identityConflicts.some(item => { const conflict = fields(item as Prisma.JsonValue); return conflict.conflictType === 'confirmed_driver_cluster_contradiction' })") })],
  ['state_reaches_database', 'projection_ownership', (s) => ({ ...s, [STATE]: s[STATE].replace("import {\n  hasOpenDriverPersonContradictionV1,", "import { prisma } from '@/lib/prisma'\nimport {\n  hasOpenDriverPersonContradictionV1,") })],
  ['adapter_reads_chat', 'projection_ownership', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('if (!contact) return null', 'if (!contact) return null\n    await prisma.chat.findMany({ where: { contactId } })') })],
  ['adapter_reads_driver', 'projection_ownership', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('if (!contact) return null', 'if (!contact) return null\n    await prisma.driver.findFirst({ where: { contactId } })') })],
  ['operation_unwired', 'projection_ownership', (s) => ({ ...s, [OPERATIONS]: s[OPERATIONS].replace('createContactIdentityConflictViewHandlerV1(legacyPrismaContactIdentityConflictViewPortV1)', 'createContactIdentityConflictViewHandlerV1({ findContactIdentityConflictSource: async () => null })') })],
  ['panel_fetches', 'client_surface_isolated', (s) => ({ ...s, [PANEL]: s[PANEL].replace('export default function ContactChannelStatePanel', 'async function load() { await fetch("/api/x") }\nexport default function ContactChannelStatePanel') })],
  ['panel_offers_an_action', 'client_surface_isolated', (s) => ({ ...s, [PANEL]: s[PANEL].replace('{view.hasPersonBlockingConflict', '{<button>Устранить</button>}{view.hasPersonBlockingConflict') })],
  ['panel_imports_messaging', 'client_surface_isolated', (s) => ({ ...s, [PANEL]: s[PANEL].replace("import type {\n  ContactIdentityConflictViewEntryV1,", "import { x } from '@/modules/messaging/public/v1'\nimport type {\n  ContactIdentityConflictViewEntryV1,") })],
  ['panel_claims_unavailable', 'client_surface_isolated', (s) => ({ ...s, [PANEL]: s[PANEL].replace('Конфликтов идентичности нет', 'Канал недоступен') })],
  ['s3_dedup_key_changed', 'no_adjacent_slice_work', (s) => ({ ...s, [COMPOSER]: s[COMPOSER].replace(': `value:${JSON.stringify(item)}:${index}`', ': `value:${JSON.stringify(item)}`') })],
  ['s4_fail_closed_join', 'no_adjacent_slice_work', (s) => ({ ...s, [EVIDENCE]: s[EVIDENCE].replace("  return record.status === 'open'\n    && record.identityId === identity.id\n", "  return record.status === 'open'\n    && (record.identityId === identity.id || record.identityId === undefined)\n") })],
  ['capability_undeclared', 'governance_declared', (s) => ({ ...s, [MANIFEST]: s[MANIFEST].replace('"ContactIdentityConflictView.v1"', '"SomethingElse.v1"') })],
  ['contacts_gains_dependency', 'governance_declared', (s) => ({ ...s, [MANIFEST]: s[MANIFEST].replace('"context": "identity_access"', '"context": "messaging"') })],
]

function main() {
  const relatives = [
    STATE, VIEW, ADAPTER, PANEL, SUMMARY, SUMMARY_ADAPTER, EVIDENCE, DRIVER, COMPOSER,
    REACHABILITY, CONVERSATION, TELEGRAM_AUTHORITY, OPERATIONS, PUBLIC_INDEX, MANIFEST,
    STATE_PROOF, VIEW_PROOF, PANEL_PROOF,
  ]
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

  assert.equal(passingProofCount('\n Test Files  3 passed (3)\n      Tests  54 passed (54)\n'), 54,
    'the plain Vitest summary is no longer parsed')
  assert.equal(passingProofCount('\u001B[32m      Tests \u001B[39m 54 passed\u001B[90m (54)\u001B[39m\n'), 54,
    'an ANSI-decorated Vitest summary is not parsed')
  assert.equal(passingProofCount(''), null, 'an empty summary must not be read as a passing run')

  // The proofs are what make these invariants behavioural, so this control runs
  // them rather than trusting that something else will.
  const vitest = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'src/modules/contacts/public/v1/contact-identity-conflict-state.test.ts',
    'src/modules/contacts/public/v1/contact-identity-conflict-view.test.ts',
    'src/modules/contacts/public/v1/client-ui/ContactChannelStatePanel.test.tsx',
    'src/modules/contacts/public/v1/contact-card-summary.test.ts',
  ], { cwd: path.join(root, 'gravity-mvp'), encoding: 'utf8' })
  assert.equal(vitest.status, 0, `the conflict view proofs failed:\n${vitest.stdout}\n${vitest.stderr}`)
  const passed = passingProofCount(vitest.stdout)
  assert(passed !== null && passed > 0, `the proofs reported no passing tests:\n${vitest.stdout}`)

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    control: 'contact-identity-conflict-view-boundary',
    checks: CHECKS.length,
    negative_probes: PROBES.length,
    conflict_view_tests: passed,
    view_fields: VIEW_FIELDS.length,
    database_models_read: 2,
    canonical_semantic_consumers: 2,
    s3_implemented: false,
    s4_implemented: false,
  }, null, 2)}\n`)
}

main()
