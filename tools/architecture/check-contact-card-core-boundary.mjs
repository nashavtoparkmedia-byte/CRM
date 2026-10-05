#!/usr/bin/env node

// M3A1 boundary: the Contact-owned card core owns Contact facts and nothing
// else. ContactCardSummary.v1 carries no provider external id, no ProviderAccount
// or Transport id, no conversation, delivery or runtime state and no driver or
// task datum; its only database reader touches Contacts-owned models; the
// canonical title comes from ContactDisplayPolicy.v1 rather than a second
// implementation; the client surface imports no database client and no foreign
// domain; nothing probes reachability or selects a provider account; and neither
// the platform shell nor the existing drawer is composed yet.
//
// M3A2 composes the core, and only in one place: the platform_shell Contact Card
// under gravity-mvp/src/infrastructure/ui/contact-card, which the Messaging host
// mounts for exactly `profile=1&card=1` and nothing else. The composition check
// therefore no longer expects zero consumers; it expects exactly the authorized
// card surfaces, and it now scans src/infrastructure too, so a composition there
// cannot go unseen. The card resolves the persisted Chat.id only through
// Messaging's RCQ1 query, reads the summary only for a resolved Contact, and
// fetches, probes, polls and falls back to nothing. The legacy drawer keeps its
// mount as the default branch and its signature.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'

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

// M3A2: the one authorized composition of the core.
const CARD_DIR = 'gravity-mvp/src/infrastructure/ui/contact-card'
const CARD_SHELL = `${CARD_DIR}/ContactCardShell.tsx`
const CARD_ACTION = `${CARD_DIR}/contact-card-actions.ts`
const CARD_SHELL_PROOF = `${CARD_DIR}/ContactCardShell.test.tsx`
const CARD_ACTION_PROOF = `${CARD_DIR}/contact-card-actions.test.ts`
const CARD_MOUNT_PROOF = 'gravity-mvp/src/app/messages/components/MessagesShell.contact-card.test.tsx'
const AUTHORIZED_CORE_CONSUMERS = [CARD_ACTION_PROOF, CARD_ACTION, CARD_SHELL_PROOF, CARD_SHELL].sort()
// Not a file: the repository's actual consumers of the core, one path per line.
const CORE_CONSUMERS = '<core consumers>'
// Every directory a composition of the core could live in.
const CONSUMER_SCAN_ROOTS = [
  'gravity-mvp/src/app', 'gravity-mvp/src/components', 'gravity-mvp/src/modules/platform-shell', 'gravity-mvp/src/infrastructure',
]
// Second paths from a conversation to a Contact, or a guess at one, that the card must never take.
const IDENTITY_FALLBACK = /useConversations|allChatIds|channelMap|searchContactsV1|ContactLookup|resolveContactLineageV1|findContactByPhone|\bphone\b|prisma/u

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

/**
 * The passing-test count from a Vitest summary.
 *
 * Hosted runs decorate stdout with ANSI colour and cursor sequences, so the
 * summary cannot be matched against raw output: locally this control read
 * "Tests  19 passed (19)" and hosted it read the same text wrapped in escape
 * codes, so it reported that no tests had passed while 19 actually had. Stripping
 * terminal control characters first makes one parser serve both.
 */
export function passingProofCount(stdout) {
  const plain = stripVTControlCharacters(String(stdout ?? ''))
  const matched = /Tests\s+(\d+)\s+passed/u.exec(plain)
  return matched === null ? null : Number(matched[1])
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

/** 7. Composition: only the M3A2 Contact Card composes the core, and the drawer keeps its mount. */
function assertCompositionAuthorized(sources) {
  for (const relative of [SUMMARY, ADAPTER, PANEL]) {
    const source = sources[relative]
    for (const name of ['platform-shell', 'ContactProfileDrawer', 'MessagesShell', 'app/messages', 'infrastructure/ui/contact-card', 'ContactCardShell']) {
      assert(!source.includes(name), `${relative} composes ${name}`)
    }
  }
  // Outside the Contacts module the core is consumed by exactly the card surfaces.
  const consumers = sources[CORE_CONSUMERS].split('\n').filter(Boolean).sort()
  assert.deepEqual(consumers, AUTHORIZED_CORE_CONSUMERS, `the core is composed outside the Contact Card: ${consumers.join(', ')}`)
  // The drawer keeps its behaviour and its mount, as the default branch.
  assert(sources[MESSAGES_SHELL].includes('<ContactProfileDrawer chatId={chatId} />'), 'the drawer mount changed')
  assert(sources[DRAWER].includes("export default function ContactProfileDrawer({ chatId }: { chatId: string })"),
    'the drawer signature changed')
}

/** 9. The M3A2 card: exact opt-in, RCQ1-only identity, summary only when resolved, nothing else. */
function assertContactCardShell(sources) {
  const host = withoutComments(MESSAGES_SHELL, sources[MESSAGES_SHELL])
  assert(moduleReferences(MESSAGES_SHELL, sources[MESSAGES_SHELL]).includes('@/infrastructure/ui/contact-card/ContactCardShell'),
    'the host does not mount the Contact Card shell')
  assert(host.includes(`const isContactCardMode = searchParams.get('card') === '1'`), 'the card opt-in is not the exact card=1')
  const mount = /\{isProfileOpen && chatId && \(\s*isContactCardMode\s*\?\s*<ContactCardShell chatId=\{chatId\} onClose=\{\(\) => toggleProfileDrawer\(false\)\}\s*\/>\s*:\s*<ContactProfileDrawer chatId=\{chatId\}\s*\/>\s*\)\}/u
  assert(mount.test(host), 'the card is not an exclusive branch of the profile mount with the drawer as default')
  assert.equal((host.match(/<ContactCardShell\b/gu) ?? []).length, 1, 'the card is mounted more than once')

  const shell = sources[CARD_SHELL]
  assert(shell.startsWith("'use client'"), 'the card shell is not a client component')
  assert.deepEqual(moduleReferences(CARD_SHELL, shell).sort(),
    ['./contact-card-actions', '@/modules/contacts/public/v1/client-ui/ContactCorePanel', 'lucide-react', 'react'],
    'the card shell takes an unexpected dependency')
  const shellCode = withoutComments(CARD_SHELL, shell)
  assert(shellCode.includes('loadContactCardForConversationV1(chatId)'), 'the card shell does not load the exact chat through the composition')
  for (const forbidden of ['fetch(', 'setInterval', 'setTimeout', 'router', 'localStorage']) {
    assert(!shellCode.includes(forbidden), `the card shell does more than compose: ${forbidden}`)
  }

  const action = sources[CARD_ACTION]
  assert(action.startsWith("'use server'"), 'the card composition is not a server action')
  assert.deepEqual(moduleReferences(CARD_ACTION, action).sort(),
    ['@/contracts/messaging/v1', '@/modules/contacts/public/v1', '@/modules/messaging/public/v1'],
    'the card composition takes an unexpected dependency')
  const actionCode = withoutComments(CARD_ACTION, action)
  assert(actionCode.includes('resolveConversationContactV1({ contract: RESOLVE_CONVERSATION_CONTACT_QUERY_V1, chatId })'),
    'the exact Chat.id is not resolved through RCQ1')
  const gate = actionCode.indexOf("if (resolution.status !== 'resolved')")
  const summaryRead = actionCode.indexOf('getContactCardSummaryV1(resolution.contactId)')
  assert(gate >= 0 && summaryRead > gate, 'the summary is read before or without the resolved gate')
  assert.equal((actionCode.match(/getContactCardSummaryV1\(/gu) ?? []).length, 1, 'the summary is read more than once')
  assert(actionCode.includes("return { status: 'failed' }"), 'a failed load does not fail closed')

  for (const [relative, code] of [[CARD_SHELL, shellCode], [CARD_ACTION, actionCode]]) {
    const fallback = IDENTITY_FALLBACK.exec(code)
    assert.equal(fallback, null, `${relative} takes a second path to a Contact: ${fallback?.[0]}`)
    const probing = PROBING.exec(code)
    assert.equal(probing, null, `${relative} probes or selects a provider: ${probing?.[0]}`)
    const leak = PROVIDER_LEAK.exec(code)
    assert.equal(leak, null, `${relative} references provider detail: ${leak?.[0]}`)
  }
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
  ['composition_authorized', assertCompositionAuthorized],
  ['governance_declared', assertGovernanceDeclared],
  ['contact_card_shell', assertContactCardShell],
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
  ['core_composes_shell', 'composition_authorized', (s) => ({ ...s, [PANEL]: s[PANEL].replace('import type { ContactCardChannelSummaryV1', "import { Card } from '@/modules/platform-shell/public/v1'\nimport type { ContactCardChannelSummaryV1") })],
  ['core_imports_card', 'composition_authorized', (s) => ({ ...s, [PANEL]: s[PANEL].replace('import type { ContactCardChannelSummaryV1', "import ContactCardShell from '@/infrastructure/ui/contact-card/ContactCardShell'\nimport type { ContactCardChannelSummaryV1") })],
  ['drawer_mount_changed', 'composition_authorized', (s) => ({ ...s, [MESSAGES_SHELL]: s[MESSAGES_SHELL].replace('<ContactProfileDrawer chatId={chatId} />', '<ContactCorePanel summary={summary} />') })],
  ['core_composed_elsewhere', 'composition_authorized', (s) => ({ ...s, [CORE_CONSUMERS]: `${s[CORE_CONSUMERS]}\ngravity-mvp/src/app/messages/components/ContactProfileDrawer.tsx` })],
  ['core_composed_in_infrastructure', 'composition_authorized', (s) => ({ ...s, [CORE_CONSUMERS]: `${s[CORE_CONSUMERS]}\ngravity-mvp/src/infrastructure/ui/another-card.tsx` })],
  ['card_composition_dropped', 'composition_authorized', (s) => ({ ...s, [CORE_CONSUMERS]: s[CORE_CONSUMERS].split('\n').filter((line) => line !== CARD_SHELL).join('\n') })],
  ['capability_undeclared', 'governance_declared', (s) => ({ ...s, [MANIFEST]: s[MANIFEST].replace('"ContactCardSummary.v1"', '"SomethingElse.v1"') })],
  ['contacts_gains_dependency', 'governance_declared', (s) => ({ ...s, [MANIFEST]: s[MANIFEST].replace('"context": "identity_access"', '"context": "messaging"') })],
  ['card_mode_any_value', 'contact_card_shell', (s) => ({ ...s, [MESSAGES_SHELL]: s[MESSAGES_SHELL].replace(`searchParams.get('card') === '1'`, `searchParams.get('card') !== null`) })],
  ['card_without_profile', 'contact_card_shell', (s) => ({ ...s, [MESSAGES_SHELL]: s[MESSAGES_SHELL].replace('{isProfileOpen && chatId && (', '{chatId && (isProfileOpen || isContactCardMode) && (') })],
  ['card_becomes_default', 'contact_card_shell', (s) => ({ ...s, [MESSAGES_SHELL]: s[MESSAGES_SHELL].replace('isContactCardMode\n                    ?', '!isContactCardMode\n                    ?') })],
  ['card_mounted_twice', 'contact_card_shell', (s) => ({ ...s, [MESSAGES_SHELL]: s[MESSAGES_SHELL].replace('<ChatList', '<ContactCardShell chatId={chatId} onClose={() => {}} />\n            <ChatList') })],
  ['card_closes_differently', 'contact_card_shell', (s) => ({ ...s, [MESSAGES_SHELL]: s[MESSAGES_SHELL].replace('onClose={() => toggleProfileDrawer(false)}', 'onClose={() => router.push(pathname)}') })],
  ['shell_fetches', 'contact_card_shell', (s) => ({ ...s, [CARD_SHELL]: s[CARD_SHELL].replace('export default function ContactCardShell', 'async function probe() { await fetch("/api/contacts/x") }\nexport default function ContactCardShell') })],
  ['shell_polls', 'contact_card_shell', (s) => ({ ...s, [CARD_SHELL]: s[CARD_SHELL].replace('    let current = true\n', '    let current = true\n    setInterval(() => setAttempt((value) => value + 1), 5000)\n') })],
  ['shell_derives_identity_from_conversations', 'contact_card_shell', (s) => ({ ...s, [CARD_SHELL]: s[CARD_SHELL].replace("import { X } from 'lucide-react'", "import { X } from 'lucide-react'\nimport { useConversations } from '@/app/messages/hooks/useConversations'") })],
  ['shell_imports_messaging_runtime', 'contact_card_shell', (s) => ({ ...s, [CARD_SHELL]: s[CARD_SHELL].replace("import { X } from 'lucide-react'", "import { X } from 'lucide-react'\nimport { resolveConversationContactV1 } from '@/modules/messaging/public/v1'") })],
  ['action_not_server', 'contact_card_shell', (s) => ({ ...s, [CARD_ACTION]: s[CARD_ACTION].replace("'use server'\n", '') })],
  ['action_skips_rcq1', 'contact_card_shell', (s) => ({ ...s, [CARD_ACTION]: s[CARD_ACTION].replace('resolveConversationContactV1({ contract: RESOLVE_CONVERSATION_CONTACT_QUERY_V1, chatId })', "{ status: 'resolved' as const, contactId: chatId }") })],
  ['action_reads_summary_unresolved', 'contact_card_shell', (s) => ({ ...s, [CARD_ACTION]: s[CARD_ACTION].replace("if (resolution.status !== 'resolved') return { status: resolution.status }", '') })],
  ['action_falls_back_to_lookup', 'contact_card_shell', (s) => ({ ...s, [CARD_ACTION]: s[CARD_ACTION].replace('    const summary = await', '    await searchContactsV1({ query: chatId })\n    const summary = await') })],
  ['action_reads_chat_directly', 'contact_card_shell', (s) => ({ ...s, [CARD_ACTION]: s[CARD_ACTION].replace('    const summary = await', '    await prisma.chat.findMany({ where: { id: chatId } })\n    const summary = await') })],
  ['action_swallows_into_contact', 'contact_card_shell', (s) => ({ ...s, [CARD_ACTION]: s[CARD_ACTION].replace("return { status: 'failed' }", "return { status: 'unresolved' }") })],
  ['action_probes_reachability', 'contact_card_shell', (s) => ({ ...s, [CARD_ACTION]: s[CARD_ACTION].replace('    const summary = await', "    void '/api/channels/check-reachability'\n    const summary = await") })],
  ['action_imports_messaging_internal', 'contact_card_shell', (s) => ({ ...s, [CARD_ACTION]: s[CARD_ACTION].replace("import { resolveConversationContactV1 } from '@/modules/messaging/public/v1'", "import { resolveConversationContactV1 } from '@/modules/messaging/application/messaging-operations'") })],
]

function main() {
  const relatives = [SUMMARY, ADAPTER, PANEL, SUMMARY_PROOF, PANEL_PROOF, OPERATIONS, PUBLIC_INDEX, DRAWER, MESSAGES_SHELL, MANIFEST,
    CARD_SHELL, CARD_ACTION, CARD_SHELL_PROOF, CARD_ACTION_PROOF, CARD_MOUNT_PROOF]
  const sources = Object.fromEntries(relatives.map((relative) => [relative, read(relative)]))
  const consumers = spawnSync('git', ['-c', 'safe.directory=*', 'grep', '-l', '-E', 'ContactCorePanel|ContactCardSummaryV1', '--',
    ...CONSUMER_SCAN_ROOTS], { cwd: root, encoding: 'utf8' })
  assert(consumers.status === 0 || consumers.status === 1, `the consumer scan failed: ${consumers.stderr}`)
  sources[CORE_CONSUMERS] = consumers.stdout.trim()
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

  // The summary parser is itself load-bearing: when it failed to see an
  // ANSI-decorated hosted summary, this control reported "no passing tests" for a
  // run in which all of them passed. Both shapes are pinned here so that can only
  // regress loudly.
  assert.equal(passingProofCount('\n Test Files  2 passed (2)\n      Tests  19 passed (19)\n'), 19,
    'the plain Vitest summary is no longer parsed')
  assert.equal(passingProofCount('\u001B[2K\u001B[1A\u001B[32m Test Files \u001B[39m 2 passed\u001B[90m (2)\u001B[39m\n\u001B[32m      Tests \u001B[39m 19 passed\u001B[90m (19)\u001B[39m\n'), 19,
    'an ANSI-decorated Vitest summary is not parsed')
  assert.equal(passingProofCount(''), null, 'an empty summary must not be read as a passing run')
  assert.equal(passingProofCount('Tests  no tests'), null, 'a summary without a count must not be read as a passing run')

  // The proofs are what make these invariants behavioural, so this control runs
  // them rather than trusting that something else will.
  const vitest = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'src/modules/contacts/public/v1/contact-card-summary.test.ts',
    'src/modules/contacts/public/v1/client-ui/ContactCorePanel.test.tsx',
    'src/infrastructure/ui/contact-card/contact-card-actions.test.ts',
    'src/infrastructure/ui/contact-card/ContactCardShell.test.tsx',
    'src/app/messages/components/MessagesShell.contact-card.test.tsx',
  ], { cwd: path.join(root, 'gravity-mvp'), encoding: 'utf8' })
  assert.equal(vitest.status, 0, `the contact card core proofs failed:\n${vitest.stdout}\n${vitest.stderr}`)
  const passed = passingProofCount(vitest.stdout)
  assert(passed !== null && passed > 0, `the proofs reported no passing tests:\n${vitest.stdout}`)

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    control: 'contact-card-core-boundary',
    checks: CHECKS.length,
    negative_probes: PROBES.length,
    core_tests: passed,
    summary_fields: SUMMARY_FIELDS.length,
    database_models_read: 4,
    composed_by: AUTHORIZED_CORE_CONSUMERS.filter((relative) => !/\.test\.tsx?$/u.test(relative)),
    card_opt_in: 'profile=1&card=1',
    reachability_probing: 0,
  }, null, 2)}\n`)
}

main()
