#!/usr/bin/env node

// M3A1 boundary: the Contact-owned card core owns Contact facts and nothing
// else. ContactCardSummary.v1 carries no provider external id, no ProviderAccount
// or Transport id, no conversation, delivery or runtime state and no driver or
// task datum; its only database reader touches Contacts-owned models; the
// canonical title comes from ContactDisplayPolicy.v1 rather than a second
// implementation; the client surface imports no database client and no foreign
// domain; nothing probes reachability or selects a provider account; and neither
// the platform shell nor the existing drawer is composed yet.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const MODULE_DIR = 'gravity-mvp/src/modules/contacts/public/v1'
const SUMMARY = `${MODULE_DIR}/contact-card-summary.ts`
const ADAPTER = `${MODULE_DIR}/legacy-prisma-contact-card-summary-adapter.ts`
const PANEL = `${MODULE_DIR}/client-ui/ContactCorePanel.tsx`
const SUMMARY_PROOF = `${MODULE_DIR}/contact-card-summary.test.ts`
const PANEL_PROOF = `${MODULE_DIR}/client-ui/ContactCorePanel.test.tsx`
const OPERATIONS = 'gravity-mvp/src/modules/contacts/application/contact-operations.ts'
const PUBLIC_INDEX = `${MODULE_DIR}/index.ts`
const DRAWER = 'gravity-mvp/src/app/messages/components/ContactProfileDrawer.tsx'
const MESSAGES_SHELL = 'gravity-mvp/src/app/messages/components/MessagesShell.tsx'
const MANIFEST = 'architecture/contexts/v1/manifests/contacts.json'

// The exact ContactCardSummary.v1 field set. Anything else is a boundary change.
const SUMMARY_FIELDS = [
  'contactId', 'displayName', 'displayTitle', 'primaryPhone', 'phoneCount',
  'channels', 'hasIdentityConflict', 'source', 'lineage',
]
const CHANNEL_FIELDS = ['channel', 'identityCount', 'hasActiveIdentity', 'conflictState']

// Provider identity, provider account and transport vocabulary may never appear
// in the contract or in the panel.
const PROVIDER_LEAK = /\bexternalId\b|\bprovider(?:User|Account)Id\b|\btransportRef\b|\btransportGeneration\b|\bbindingId\b|\bbotToken\b|\b_myUserId\b|\busername\b/u
// Foreign-domain state the card core must never carry.
const FOREIGN_STATE = /\bchatId\b|\bconversation(?:Id|Route)?\b|\bmessageId\b|\bdeliveryStatus\b|\blastOutbound\b|\bunreadCount\b|\bdriverId\b|\bfullName\b|\bsegment\b|\bscore\b|\btaskId\b|\bcallId\b|\breadiness\b|\bwsConnected\b/u
// Reachability probing and provider selection.
const PROBING = /check-reachability|\breachabilityStatus\b|\bliveReachability\b|providerAccountId/u
const PRISMA = /@prisma\/client|@\/lib\/prisma|prisma\./u
// Foreign domains a Contacts-owned surface may not import.
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

/** Members of one type alias, so the contract's shape is asserted, not grepped. */
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

/** 1. The contract is exactly the declared provider-neutral field set. */
function assertSummaryShape(sources) {
  assert.deepEqual(
    typeMembers(SUMMARY, sources[SUMMARY], 'ContactCardSummaryV1').sort(),
    [...SUMMARY_FIELDS].sort(),
    'ContactCardSummary.v1 field set changed',
  )
  assert.deepEqual(
    typeMembers(SUMMARY, sources[SUMMARY], 'ContactCardChannelSummaryV1').sort(),
    [...CHANNEL_FIELDS].sort(),
    'the channel summary field set changed',
  )
}

/** 2. No provider identity, account or transport vocabulary in the contract. */
function assertNoProviderLeak(sources) {
  const summary = withoutComments(SUMMARY, sources[SUMMARY])
  const file = parse(SUMMARY, summary)
  let contract = null
  const visit = (node) => {
    if (ts.isTypeAliasDeclaration(node)
      && ['ContactCardSummaryV1', 'ContactCardChannelSummaryV1'].includes(node.name.text)) {
      contract = `${contract ?? ''}\n${node.getText(file)}`
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert(contract !== null, 'the contract types are missing')
  const providerLeak = PROVIDER_LEAK.exec(contract)
  assert.equal(providerLeak, null, `the summary contract carries provider detail: ${providerLeak?.[0]}`)
  const foreign = FOREIGN_STATE.exec(contract)
  assert.equal(foreign, null, `the summary contract carries foreign-domain state: ${foreign?.[0]}`)
  // The panel renders the contract, so it cannot render what the contract lacks.
  const panel = withoutComments(PANEL, sources[PANEL])
  const panelLeak = PROVIDER_LEAK.exec(panel)
  assert.equal(panelLeak, null, `the core panel references provider detail: ${panelLeak?.[0]}`)
}

/** 3. The projection reuses the canonical display policy. */
function assertDisplayPolicyReuse(sources) {
  const references = moduleReferences(SUMMARY, sources[SUMMARY])
  assert(references.includes('./contact-display-policy'), 'the projection does not reuse ContactDisplayPolicy.v1')
  const summary = withoutComments(SUMMARY, sources[SUMMARY])
  assert(summary.includes('buildCanonicalContactSummary('), 'the canonical summary builder is not called')
  // A second title/phone implementation is exactly what this slice must avoid.
  for (const duplicated of ['isTechnicalProviderName', 'SEGMENT_LABELS', 'formatContactPhone(', /\.replace\(\/\\D\/g/u]) {
    const pattern = duplicated instanceof RegExp ? duplicated : new RegExp(duplicated.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u')
    assert.equal(pattern.exec(summary), null, `display rules are duplicated: ${duplicated}`)
  }
}

/** 4. Only Contacts-owned models are read, and only by the one adapter. */
function assertProjectionOwnership(sources) {
  const summary = withoutComments(SUMMARY, sources[SUMMARY])
  assert.equal(PRISMA.exec(summary), null, 'the projection reaches a database')
  assert.equal(FOREIGN_IMPORT.exec(summary), null, 'the projection imports a foreign domain')
  const adapter = withoutComments(ADAPTER, sources[ADAPTER])
  assert.equal(FOREIGN_IMPORT.exec(adapter), null, 'the adapter imports a foreign domain')
  const models = [...adapter.matchAll(/prisma\.([a-zA-Z]+)\./gu)].map((match) => match[1])
  assert(models.length > 0, 'the adapter reads nothing')
  for (const model of models) {
    assert(['contact', 'contactPhone', 'contactIdentity', 'contactMerge'].includes(model),
      `the adapter reads a model Contacts does not own: prisma.${model}`)
  }
  for (const forbidden of ['prisma.chat', 'prisma.message', 'prisma.driver', 'prisma.task', 'prisma.call']) {
    assert(!adapter.includes(forbidden), `the adapter reads ${forbidden}`)
  }
  // One read path only: nothing else in the module may implement this contract.
  const wiring = withoutComments(OPERATIONS, sources[OPERATIONS])
  assert(wiring.includes('createContactCardSummaryHandlerV1(legacyPrismaContactCardSummaryPortV1)'),
    'the operation is not wired to the Contacts-owned port')
  assert(sources[PUBLIC_INDEX].includes('getContactCardSummaryV1'), 'the operation is not on the public surface')
}

/** 5. The client surface is free of databases and foreign domains. */
function assertClientSurfaceIsolated(sources) {
  const panel = sources[PANEL]
  assert(panel.startsWith('"use client"'), 'the core panel is not a client component')
  assert.equal(PRISMA.exec(withoutComments(PANEL, panel)), null, 'the core panel reaches a database')
  for (const reference of moduleReferences(PANEL, panel)) {
    assert.equal(FOREIGN_IMPORT.exec(reference), null, `the core panel imports a foreign domain: ${reference}`)
    assert(reference.startsWith('.') || reference === 'react' || reference.startsWith('react/'),
      `the core panel takes an unexpected dependency: ${reference}`)
  }
  const stripped = withoutComments(PANEL, panel)
  for (const forbidden of ['fetch(', 'useEffect', 'useState', 'setInterval', 'setTimeout']) {
    assert(!stripped.includes(forbidden), `the core panel is not purely presentational: ${forbidden}`)
  }
}

/** 6. No reachability probing and no provider-account selection anywhere. */
function assertNoProbing(sources) {
  for (const relative of [SUMMARY, ADAPTER, PANEL]) {
    const probing = PROBING.exec(withoutComments(relative, sources[relative]))
    assert.equal(probing, null, `${relative} probes or selects a provider: ${probing?.[0]}`)
  }
}

/** 7. No composition: the shell and the old drawer are untouched by this slice. */
function assertNoCompositionYet(sources) {
  for (const relative of [SUMMARY, ADAPTER, PANEL]) {
    const source = sources[relative]
    for (const name of ['platform-shell', 'ContactProfileDrawer', 'MessagesShell', 'app/messages']) {
      assert(!source.includes(name), `${relative} composes ${name}`)
    }
  }
  // Nothing outside the Contacts module may consume the core panel yet.
  const consumers = spawnSync('git', ['-c', 'safe.directory=*', 'grep', '-l', '-E', 'ContactCorePanel|ContactCardSummaryV1', '--',
    'gravity-mvp/src/app', 'gravity-mvp/src/components', 'gravity-mvp/src/modules/platform-shell'], { cwd: root, encoding: 'utf8' })
  assert.equal(consumers.stdout.trim(), '', `the core is already composed: ${consumers.stdout.trim()}`)
  // The drawer keeps its behaviour and its mount in this slice.
  assert(sources[MESSAGES_SHELL].includes('<ContactProfileDrawer chatId={chatId} />'), 'the drawer mount changed')
  assert(sources[DRAWER].includes("export default function ContactProfileDrawer({ chatId }: { chatId: string })"),
    'the drawer signature changed')
}

/** 8. The Contacts manifest declares the capability and the control. */
function assertGovernanceDeclared(sources) {
  const manifest = JSON.parse(sources[MANIFEST])
  assert(manifest.public_surface.includes('ContactCardSummary.v1'), 'the capability is not declared')
  assert(manifest.verification.module_tests.includes('node tools/architecture/check-contact-card-core-boundary.mjs'),
    'the control is not a declared module test')
  assert.deepEqual(manifest.allowed_dependencies.map((entry) => entry.context).sort(), ['identity_access'],
    'Contacts gained a dependency: the card core must not aggregate other domains')
}

const CHECKS = [
  ['summary_shape', assertSummaryShape],
  ['no_provider_leak', assertNoProviderLeak],
  ['display_policy_reuse', assertDisplayPolicyReuse],
  ['projection_ownership', assertProjectionOwnership],
  ['client_surface_isolated', assertClientSurfaceIsolated],
  ['no_probing', assertNoProbing],
  ['no_composition_yet', assertNoCompositionYet],
  ['governance_declared', assertGovernanceDeclared],
]

const PROBES = [
  ['summary_gains_external_id', 'summary_shape', (s) => ({ ...s, [SUMMARY]: s[SUMMARY].replace('  contactId: string\n', '  contactId: string\n  externalId: string\n') })],
  ['channel_gains_field', 'summary_shape', (s) => ({ ...s, [SUMMARY]: s[SUMMARY].replace('  identityCount: number\n', '  identityCount: number\n  providerAccountId: string\n') })],
  ['summary_carries_provider_account', 'no_provider_leak', (s) => ({ ...s, [SUMMARY]: s[SUMMARY].replace('  hasIdentityConflict: boolean\n  source: string', '  hasIdentityConflict: boolean\n  providerAccountId: string\n  source: string') })],
  ['summary_carries_conversation', 'no_provider_leak', (s) => ({ ...s, [SUMMARY]: s[SUMMARY].replace('  phoneCount: number\n', '  phoneCount: number\n  conversationId: string\n') })],
  ['summary_carries_driver', 'no_provider_leak', (s) => ({ ...s, [SUMMARY]: s[SUMMARY].replace('  source: string\n', '  source: string\n  fullName: string\n') })],
  ['panel_shows_username', 'no_provider_leak', (s) => ({ ...s, [PANEL]: s[PANEL].replace('{summary.displayTitle}', '{summary.displayTitle}{summary.username}') })],
  ['policy_not_reused', 'display_policy_reuse', (s) => ({ ...s, [SUMMARY]: s[SUMMARY].replace("import { buildCanonicalContactSummary } from './contact-display-policy'", 'const buildCanonicalContactSummary = (input) => input') })],
  ['phone_formatting_duplicated', 'display_policy_reuse', (s) => ({ ...s, [SUMMARY]: s[SUMMARY].replace('const REMOVED_PHONE_LIFECYCLES', "const digits = (value) => String(value).replace(/\\D/g, '')\nconst REMOVED_PHONE_LIFECYCLES") })],
  ['projection_reaches_database', 'projection_ownership', (s) => ({ ...s, [SUMMARY]: s[SUMMARY].replace("import { buildCanonicalContactSummary }", "import { prisma } from '@/lib/prisma'\nimport { buildCanonicalContactSummary }") })],
  ['adapter_reads_chat', 'projection_ownership', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('const mergedFromCount = await prisma.contactMerge.count({', 'const chats = await prisma.chat.findMany({ where: { contactId } })\n    const mergedFromCount = await prisma.contactMerge.count({') })],
  ['adapter_reads_driver', 'projection_ownership', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('if (!contact) return null', 'if (!contact) return null\n    await prisma.driver.findFirst({ where: { contactId } })') })],
  ['operation_unwired', 'projection_ownership', (s) => ({ ...s, [OPERATIONS]: s[OPERATIONS].replace('createContactCardSummaryHandlerV1(legacyPrismaContactCardSummaryPortV1)', 'createContactCardSummaryHandlerV1({ findContactCardSummarySource: async () => null })') })],
  ['panel_takes_prisma', 'client_surface_isolated', (s) => ({ ...s, [PANEL]: s[PANEL].replace('import type { ContactCardChannelSummaryV1', "import { prisma } from '@/lib/prisma'\nimport type { ContactCardChannelSummaryV1") })],
  ['panel_imports_messaging', 'client_surface_isolated', (s) => ({ ...s, [PANEL]: s[PANEL].replace('import type { ContactCardChannelSummaryV1', "import { x } from '@/modules/messaging/public/v1'\nimport type { ContactCardChannelSummaryV1") })],
  ['panel_fetches', 'client_surface_isolated', (s) => ({ ...s, [PANEL]: s[PANEL].replace('export default function ContactCorePanel', 'async function load() { await fetch("/api/x") }\nexport default function ContactCorePanel') })],
  ['panel_probes_reachability', 'no_probing', (s) => ({ ...s, [PANEL]: s[PANEL].replace('export default function ContactCorePanel', 'const probe = () => "/api/channels/check-reachability"\nexport default function ContactCorePanel') })],
  ['adapter_selects_provider_account', 'no_probing', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('mergedFromCount,', 'mergedFromCount,\n      providerAccountId: contact.identities[0]?.metadata,') })],
  ['core_composes_shell', 'no_composition_yet', (s) => ({ ...s, [PANEL]: s[PANEL].replace('import type { ContactCardChannelSummaryV1', "import { Card } from '@/modules/platform-shell/public/v1'\nimport type { ContactCardChannelSummaryV1") })],
  ['drawer_mount_changed', 'no_composition_yet', (s) => ({ ...s, [MESSAGES_SHELL]: s[MESSAGES_SHELL].replace('<ContactProfileDrawer chatId={chatId} />', '<ContactCorePanel summary={summary} />') })],
  ['capability_undeclared', 'governance_declared', (s) => ({ ...s, [MANIFEST]: s[MANIFEST].replace('"ContactCardSummary.v1"', '"SomethingElse.v1"') })],
  ['contacts_gains_dependency', 'governance_declared', (s) => ({ ...s, [MANIFEST]: s[MANIFEST].replace('"context": "identity_access"', '"context": "messaging"') })],
]

function main() {
  const relatives = [SUMMARY, ADAPTER, PANEL, SUMMARY_PROOF, PANEL_PROOF, OPERATIONS, PUBLIC_INDEX, DRAWER, MESSAGES_SHELL, MANIFEST]
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

  // The proofs are what make these invariants behavioural, so this control runs
  // them rather than trusting that something else will.
  const vitest = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'src/modules/contacts/public/v1/contact-card-summary.test.ts',
    'src/modules/contacts/public/v1/client-ui/ContactCorePanel.test.tsx',
  ], { cwd: path.join(root, 'gravity-mvp'), encoding: 'utf8' })
  assert.equal(vitest.status, 0, `the contact card core proofs failed:\n${vitest.stdout}\n${vitest.stderr}`)
  const passed = /Tests\s+(\d+) passed/u.exec(vitest.stdout)
  assert(passed !== null && Number(passed[1]) > 0, `the proofs reported no passing tests:\n${vitest.stdout}`)

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    control: 'contact-card-core-boundary',
    checks: CHECKS.length,
    negative_probes: PROBES.length,
    core_tests: Number(passed[1]),
    summary_fields: SUMMARY_FIELDS.length,
    database_models_read: 4,
    composed_yet: false,
    reachability_probing: 0,
  }, null, 2)}\n`)
}

main()
