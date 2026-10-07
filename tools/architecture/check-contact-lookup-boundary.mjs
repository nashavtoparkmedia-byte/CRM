#!/usr/bin/env node

// M3A6A boundary: the reusable Contacts lookup answers "which Contact is this?"
// and cannot answer anything else.
//
// It pins the exact public field set; that the capability materialized is the
// already-declared ContactLookup.v1 and that no duplicate ContactSelector.v1
// public capability appears; that a provider external id can reach neither the
// contract, the adapter's select, nor a human-readable output value, because the
// provider-neutral display projection — not a caller convention — removes that
// fallback; that the canonical display, confirmed-person and phone-evidence rules
// are reused rather than reimplemented; that rank precedence is decided before
// truncation; that only one Contacts-owned adapter reads a database and only
// Contact, ContactPhone and ContactIdentity; that no reachability, conflict,
// provider or runtime semantic is introduced; that the legacy search route and
// hook stay byte-identical; and that no schema, migration or Messaging import moves.
//
// M3A6B extends it to the client presentation of the same capability,
// ContactSelector, rather than adding a second control with no new ownership
// boundary: the selector is a client component living only in Contacts client-ui,
// importing nothing but React and ContactLookup.v1, owning no transport, gating
// queries with contactLookupCriteriaV1, rendering the lookup title as given and
// reimplementing no ranking, ordering, phone or display policy; it is not
// re-exported through the server-oriented barrel.
//
// M3A6C adds the browser transport and the first adopter. GET
// /api/contacts/lookup and createHttpContactLookupClientV1 are pass-throughs to
// searchContactsV1 with no Prisma, ranking, display or provider semantics of
// their own; the client keeps only the declared item fields. The only authorized
// consumer is the ContactProfileDrawer merge picker, which reaches the lookup
// through that client and no longer through the legacy search hook; its merge
// direction, confirmation, command and refresh are proven by its focused test,
// which this control runs.
//
// M3A6D moves the client request lifecycle (debounce, sequencing, stale answers)
// out of ContactSelector into one shared Contacts state machine,
// useContactLookupV1, which now carries the criteria gate and every transport,
// policy and vocabulary ban the selector carried; the selector keeps its public
// API and no timer or sequence of its own. NewChatPopover and ChatList are the
// only other adopters of that hook. Neither keeps the legacy search hook, the
// legacy route or `hasChat`, neither sorts what the lookup returned, and neither
// reads Messaging's conversation answer except through Messaging's own
// useContactConversations helpers, which fail closed: only a proven absence
// starts a conversation, and only a complete answer proves a Contact extra.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const MODULE_DIR = 'gravity-mvp/src/modules/contacts/public/v1'
const LOOKUP = `${MODULE_DIR}/contact-lookup.ts`
const ADAPTER = `${MODULE_DIR}/legacy-prisma-contact-lookup-adapter.ts`
const PROOF = `${MODULE_DIR}/contact-lookup.test.ts`
const POLICY = `${MODULE_DIR}/contact-display-policy.ts`
const POLICY_PROOF = `${MODULE_DIR}/contact-display-policy.test.ts`
const OPERATIONS = 'gravity-mvp/src/modules/contacts/application/contact-operations.ts'
const PUBLIC_INDEX = `${MODULE_DIR}/index.ts`
const MANIFEST = 'architecture/contexts/v1/manifests/contacts.json'
const LEGACY_ROUTE = 'gravity-mvp/src/app/api/contacts/search/route.ts'
const LEGACY_HOOK = 'gravity-mvp/src/app/messages/hooks/useContactSearch.ts'
const CLIENT_UI_DIR = `${MODULE_DIR}/client-ui`
const SELECTOR = `${CLIENT_UI_DIR}/ContactSelector.tsx`
const SELECTOR_PROOF = `${CLIENT_UI_DIR}/ContactSelector.test.tsx`
// Every tracked file under gravity-mvp/src, outside Contacts client-ui, that names
// the selector. Held with the sources so a probe can simulate an early adopter.
const SELECTOR_CONSUMERS = '<git-grep:ContactSelector outside contacts client-ui>'
const LOOKUP_ROUTE = 'gravity-mvp/src/app/api/contacts/lookup/route.ts'
const LOOKUP_ROUTE_PROOF = 'gravity-mvp/src/app/api/contacts/lookup/route.test.ts'
const HTTP_CLIENT = `${CLIENT_UI_DIR}/http-contact-lookup-client.ts`
const HTTP_CLIENT_PROOF = `${CLIENT_UI_DIR}/http-contact-lookup-client.test.ts`
const DRAWER = 'gravity-mvp/src/app/messages/components/ContactProfileDrawer.tsx'
const DRAWER_PROOF = 'gravity-mvp/src/app/messages/components/ContactProfileDrawer.merge-picker.test.tsx'
// The only authorized adopters of the selector: the merge picker and its proof.
const AUTHORIZED_SELECTOR_CONSUMERS = [DRAWER_PROOF, DRAWER].sort()
// M3A6D: the one client lookup state machine and its authorized adopters.
const LOOKUP_HOOK = `${CLIENT_UI_DIR}/use-contact-lookup.ts`
const LOOKUP_HOOK_PROOF = `${CLIENT_UI_DIR}/use-contact-lookup.test.ts`
const NEW_CHAT = 'gravity-mvp/src/app/messages/components/NewChatPopover.tsx'
const NEW_CHAT_PROOF = 'gravity-mvp/src/app/messages/components/NewChatPopover.contact-lookup.test.tsx'
const CHAT_LIST = 'gravity-mvp/src/app/messages/components/ChatList.tsx'
const CHAT_LIST_PROOF = 'gravity-mvp/src/app/messages/components/ChatList.contact-lookup.test.tsx'
const CONVERSATIONS_HOOK = 'gravity-mvp/src/app/messages/hooks/useContactConversations.ts'
const CONVERSATIONS_HOOK_PROOF = 'gravity-mvp/src/app/messages/hooks/useContactConversations.test.ts'
// Every tracked file under gravity-mvp/src, outside Contacts client-ui, that names the shared hook.
const LOOKUP_HOOK_CONSUMERS = '<git-grep:useContactLookupV1 outside contacts client-ui>'
const AUTHORIZED_LOOKUP_HOOK_CONSUMERS = [CHAT_LIST, NEW_CHAT].sort()
// Transport, server and foreign state no Contacts client lookup surface may own.
const CLIENT_SURFACE_FORBIDDEN = [
  'fetch(', '/api/', 'axios', 'XMLHttpRequest', 'useContactSearch', '@/lib/prisma', 'prisma.', 'server-only',
  '@/modules/', '@/infrastructure', 'app/messages', 'platform-shell',
]
// ContactLookup.v1 policy no client surface may reimplement.
const CLIENT_POLICY_FORBIDDEN = [
  'stripToDigits', 'formatContactPhone', 'isTechnicalProviderName', 'buildProviderNeutralContactDisplayV1',
  'buildCanonicalContactSummary', 'contactLookupSortKeyV1', 'localeCompare', "normalize('NFKC')", '.sort(',
  'phone_exact', 'phone_substring', 'name_prefix', 'name_substring', 'CONTACT_LOOKUP_MAX_LIMIT_V1',
  'replace(/\\D', 'canonicalPinnedAt', 'displayNameSource',
]

// The exact public contract. Anything else is a boundary change.
const ITEM_FIELDS = ['contactId', 'displayName', 'displayTitle', 'primaryPhone', 'channels']
const RESULT_FIELDS = ['items', 'total', 'truncated']
// Precedence order is part of the contract: a lower class must never hide a higher one.
const RANK_CLASSES = ['phone_exact', 'phone_substring', 'name_prefix', 'name_substring']
// The legacy compatibility surface M3A6A must not touch.
const LEGACY_DIGESTS = {
  [LEGACY_ROUTE]: 'd7b43e72156d',
  [LEGACY_HOOK]: '0bd94c493b10',
}

const FOREIGN_MODELS = [
  'prisma.chat', 'prisma.message', 'prisma.driver', 'prisma.task', 'prisma.call',
  'prisma.providerAccount', 'prisma.transport', 'prisma.contactMerge',
]
// Vocabulary that would turn a lookup row into a communication claim.
const FORBIDDEN_VOCABULARY = [
  'externalId', 'providerAccountId', 'providerTargetId', 'transportConnectionId',
  'conversationRoute', 'chatId', 'hasChat', 'reachabilityStatus', 'reachability',
  'conflictState', 'identityConflicts', 'sendable', 'deliverable', 'readiness',
  'available', 'metadata',
]

export function passingProofCount(stdout) {
  const plain = stripVTControlCharacters(String(stdout ?? ''))
  const matched = /Tests\s+(\d+)\s+passed/u.exec(plain)
  return matched === null ? null : Number(matched[1])
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

/** Source with comments removed, so prose about an exclusion is never read as the thing. */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

/** The body of one exported type literal, by name. */
function typeBlock(source, name) {
  const start = source.indexOf(`export type ${name} = {`)
  assert(start >= 0, `${name} is not an exported object type`)
  const end = source.indexOf('\n}', start)
  assert(end > start, `${name} has no closing brace`)
  return source.slice(start, end)
}

/** 1. The contract is exactly the declared provider-neutral field set. */
function assertContractShape(sources) {
  const lookup = sources[LOOKUP]
  for (const [name, fields] of [['ContactLookupItemV1', ITEM_FIELDS], ['ContactLookupResultV1', RESULT_FIELDS]]) {
    const block = typeBlock(lookup, name)
    const declared = [...block.matchAll(/^ {2}([a-zA-Z]+)[?]?:/gmu)].map((match) => match[1])
    assert.deepEqual([...declared].sort(), [...fields].sort(), `${name} is not the declared field set`)
  }
  assert(lookup.includes('total: number'), 'the result does not report a bounded total')
  assert(!/count\s*\(|\.count\(/u.test(lookup), 'the contract performs an unbounded count')
}

/** 2. No provider, chat, reachability or conflict vocabulary in the contract or adapter. */
function assertNoForeignVocabulary(sources) {
  for (const relative of [LOOKUP, ADAPTER]) {
    const source = sources[relative]
      // The prose that states what is excluded must not be read as a leak.
      .replace(/\/\/[^\n]*/gu, '')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
    for (const forbidden of FORBIDDEN_VOCABULARY) {
      assert(!source.includes(forbidden), `${relative} carries ${forbidden}`)
    }
  }
}

/** 3. The canonical Contacts rules are reused, never reimplemented. */
function assertCanonicalReuse(sources) {
  const lookup = sources[LOOKUP]
  assert(lookup.includes("from './contact-display-policy'"), 'the lookup does not reuse the display policy')
  assert(lookup.includes('buildProviderNeutralContactDisplayV1'),
    'the lookup does not use the provider-neutral display projection')
  assert(lookup.includes('confirmedPersonNameV1'), 'the lookup does not reuse the confirmed-person accessor')
  assert(lookup.includes('phoneEvidenceState'), 'the lookup does not reuse phone evidence')
  assert(lookup.includes('stripToDigits'), 'the lookup does not reuse phone normalization')
  // A second name precedence or a second primary-phone rule would diverge.
  assert(!/formatContactPhone|isTechnicalProviderName/u.test(lookup),
    'the lookup reimplements a display rule it must delegate')
  assert(!/canonicalPinnedAt\s*===|displayNameSource\s*===/u.test(lookup),
    'the lookup reimplements the canonical name precedence')
}

/** 4. The provider-neutral projection owns the invariant, inside the display policy. */
function assertProviderNeutralPolicy(sources) {
  const policy = sources[POLICY]
  assert(policy.includes('export function buildProviderNeutralContactDisplayV1'),
    'the provider-neutral projection does not live in ContactDisplayPolicy')
  const code = withoutComments(policy)
  const neutral = code.slice(code.indexOf('export function buildProviderNeutralContactDisplayV1'),
    code.indexOf('export function buildCanonicalContactSummary'))
  assert(neutral.length > 0, 'the provider-neutral projection is not declared before the canonical summary')
  assert(!neutral.includes('stableProviderId'),
    'the provider-neutral cascade still admits the provider external id')
  // The canonical summary keeps its legacy fallback: this slice does not change it.
  const canonical = code.slice(code.indexOf('export function buildCanonicalContactSummary'))
  assert(/\|\| providerName\s*\n\s*\|\| stableProviderId/u.test(canonical),
    'the canonical summary lost its documented legacy provider-id fallback')
  // One shared precedence, not two.
  assert(code.includes('function contactDisplayNameCandidates'),
    'the display precedence is not computed in one shared place')
  assert.equal(code.match(/\|\| GENERIC_CONTACT_DISPLAY_NAME/gu)?.length, 2,
    'the generic fallback is not shared by exactly the two projections')
}

/** 5. Rank precedence is decided before truncation. */
function assertRankingBeforeTruncation(sources) {
  const lookup = withoutComments(sources[LOOKUP])
  const declared = [...typeBlockArray(lookup, 'CONTACT_LOOKUP_RANK_CLASSES_V1')]
  assert.deepEqual(declared, RANK_CLASSES, 'the rank classes are not the declared precedence')
  // One bounded query per class, asked highest-first, stopping at limit + 1.
  assert(/for \(const \[rank, rankClass\] of classes\.entries\(\)\)/u.test(lookup),
    'the handler does not iterate rank classes in precedence order')
  assert(lookup.includes('limit + 1'), 'the handler cannot prove truncation')
  assert(/if \(seen\.size > limit\) break/u.test(lookup),
    'the handler does not stop collecting once one extra candidate is known')
  assert(/left\.rank !== right\.rank/u.test(lookup), 'the final order ignores the rank class')
  // Determinism must not depend on the ambient locale.
  assert(!lookup.includes('localeCompare'), 'the lookup orders by an ambient locale')
  assert(lookup.includes("normalize('NFKC')"), 'the sort key is not normalized deterministically')
}

function typeBlockArray(source, name) {
  const start = source.indexOf(`export const ${name} = [`)
  assert(start >= 0, `${name} is not an exported array`)
  const end = source.indexOf(']', start)
  return [...source.slice(start, end).matchAll(/'([a-z_]+)'/gu)].map((match) => match[1])
}

/** 6. Only Contacts-owned models are read, and only by the one adapter. */
function assertPersistenceOwnership(sources) {
  assert(!sources[LOOKUP].includes('@/lib/prisma'), 'the lookup contract reaches a database')
  const adapter = sources[ADAPTER]
  const models = [...adapter.matchAll(/prisma\.([a-zA-Z]+)\./gu)].map((match) => match[1])
  assert(models.length > 0, 'the adapter reads nothing')
  for (const model of models) {
    assert(['contact', 'contactPhone', 'contactIdentity'].includes(model),
      `the adapter reads a model this capability does not own: prisma.${model}`)
  }
  for (const forbidden of FOREIGN_MODELS) {
    assert(!adapter.includes(forbidden), `the adapter reads ${forbidden}`)
  }
  // A read-only capability writes nothing.
  for (const write of ['.update(', '.create(', '.delete(', '.upsert(', '.updateMany(', '.deleteMany(', '$executeRaw']) {
    assert(!adapter.includes(write), `the adapter performs a write: ${write}`)
  }
  // Hydration is one bounded query, never per row.
  assert.equal(adapter.match(/findMany\(/gu)?.length, 3,
    'the adapter is not exactly one query per rank-class family plus one hydration')
  assert(adapter.includes('isArchived: false'), 'the adapter can return an archived Contact')
}

/** 7. No Messaging, no foreign domain, no provider runtime anywhere in the slice. */
function assertNoForeignDependency(sources) {
  for (const relative of [LOOKUP, ADAPTER]) {
    const source = sources[relative]
    for (const forbidden of [
      '@/modules/messaging', '@/modules/telegram-channel', '@/modules/whatsapp-channel',
      '@/modules/max-channel', '@/modules/calling', '@/modules/fleet-operations',
      '@/modules/work-management', '@/modules/platform-shell', 'app/messages',
    ]) {
      assert(!source.includes(forbidden), `${relative} imports ${forbidden}`)
    }
    assert(!/fetch\(|axios|http\./u.test(source), `${relative} performs a network call`)
  }
  const manifest = JSON.parse(sources[MANIFEST])
  assert.deepEqual(manifest.allowed_dependencies.map((entry) => entry.context).sort(), ['identity_access'],
    'Contacts gained a dependency: the lookup must not aggregate other domains')
}

/** 8. The already-declared capability is materialized, with no duplicate concept. */
function assertGovernanceDeclared(sources) {
  const manifest = JSON.parse(sources[MANIFEST])
  assert(manifest.public_surface.includes('ContactLookup.v1'), 'ContactLookup.v1 is not declared')
  assert(!manifest.public_surface.includes('ContactSelector.v1'),
    'a duplicate ContactSelector.v1 public capability was introduced')
  assert(manifest.verification.module_tests.includes('node tools/architecture/check-contact-lookup-boundary.mjs'),
    'the control is not a declared module test')
  assert(sources[PUBLIC_INDEX].includes('createSearchContactsHandlerV1'),
    'the capability is not exported from the Contacts public surface')
  assert(sources[OPERATIONS].includes('createSearchContactsHandlerV1(legacyPrismaContactLookupPortV1)'),
    'the capability is not wired to its Contacts adapter')
  assert(!/ContactSelector/u.test(sources[LOOKUP] + sources[ADAPTER] + sources[OPERATIONS]),
    'the implementation names a ContactSelector capability')
}

/** 9. The legacy compatibility surface is byte-identical. */
function assertLegacyUnchanged(sources) {
  for (const [relative, expected] of Object.entries(LEGACY_DIGESTS)) {
    assert.equal(digest(sources[relative]), expected, `${relative} changed in this slice`)
  }
  // The legacy route keeps the operator-only external-id search this slice refuses.
  assert(sources[LEGACY_ROUTE].includes('prisma.contactIdentity.findMany'),
    'the legacy operator external-id search was removed')
}

/** 10. A read-only capability touches no schema, migration or raw SQL. */
function assertNoSchemaSurface(sources) {
  for (const relative of [LOOKUP, ADAPTER]) {
    const source = sources[relative]
    for (const forbidden of [
      'prisma/migrations', 'prisma/schema.prisma', '$executeRaw', '$queryRaw',
      'ALTER TABLE', 'CREATE TABLE', 'migrate deploy',
    ]) {
      assert(!source.includes(forbidden), `${relative} reaches schema or raw SQL: ${forbidden}`)
    }
  }
}

/** 11. The selector is a Contacts client surface that owns no transport and no foreign state. */
function assertSelectorClientSurface(sources) {
  const selector = sources[SELECTOR]
  assert(selector.startsWith('"use client"'), 'ContactSelector is not a client component')
  const specifiers = [...new Set([...selector.matchAll(/\bfrom\s+'([^']+)'/gu)].map((match) => match[1]))].sort()
  assert.deepEqual(specifiers, ['../contact-lookup', './use-contact-lookup', 'react'],
    `ContactSelector imports something other than React, ContactLookup.v1 and the shared lookup hook: ${specifiers.join(', ')}`)
  const code = withoutComments(selector)
  // The criteria gate and the request lifecycle live in the one shared state machine.
  assert(code.includes('useContactLookupV1(lookup'), 'ContactSelector does not use the shared lookup state machine')
  for (const owned of ['setTimeout', 'clearTimeout', 'timerRef', 'sequenceRef', 'mountedRef']) {
    assert(!code.includes(owned), `ContactSelector keeps a second lookup state machine: ${owned}`)
  }
  assert(code.includes('ContactLookupItemV1'), 'ContactSelector does not consume the ContactLookup.v1 item type')
  for (const forbidden of CLIENT_SURFACE_FORBIDDEN) {
    assert(!code.includes(forbidden), `ContactSelector owns transport, server or foreign state: ${forbidden}`)
  }
  assert(!sources[PUBLIC_INDEX].includes('ContactSelector'),
    'the client selector is re-exported through the server-oriented Contacts barrel')
  const consumers = sources[SELECTOR_CONSUMERS].split('\n').map((line) => line.trim()).filter(Boolean).sort()
  assert.deepEqual(consumers, AUTHORIZED_SELECTOR_CONSUMERS,
    `ContactSelector is adopted outside the authorized merge picker: ${consumers.join(', ')}`)
}

/** 12. The selector reimplements no lookup, ranking, ordering, phone or display policy. */
function assertSelectorNoPolicy(sources) {
  const code = withoutComments(sources[SELECTOR])
  for (const forbidden of CLIENT_POLICY_FORBIDDEN) {
    assert(!code.includes(forbidden), `ContactSelector reimplements a ContactLookup.v1 policy: ${forbidden}`)
  }
  // The lookup owns the title; the selector renders it and never composes one.
  assert(code.includes('{item.displayTitle}'), 'ContactSelector does not render the lookup title')
  assert(!/\.primaryPhone\b/u.test(code), 'ContactSelector reads primaryPhone to compose its own text')
  assert(!/\.displayName\b/u.test(code), 'ContactSelector reads displayName to compose its own text')
}

/** 13. No provider, chat, reachability or availability vocabulary reaches the selector. */
function assertSelectorVocabulary(sources) {
  const code = withoutComments(sources[SELECTOR])
  for (const forbidden of FORBIDDEN_VOCABULARY) {
    assert(!code.includes(forbidden), `ContactSelector carries ${forbidden}`)
  }
  for (const claim of ['Доступен', 'доступен', 'Онлайн', 'онлайн', 'Написать', 'Доставлено', 'online', 'ready']) {
    assert(!code.includes(claim), `ContactSelector makes a communication claim: ${claim}`)
  }
}

/** 14. The single-select combobox semantics are present, not just tested. */
function assertSelectorAccessibility(sources) {
  const code = withoutComments(sources[SELECTOR])
  for (const required of [
    'role="combobox"', 'aria-autocomplete="list"', 'aria-expanded=', 'aria-controls=', 'aria-activedescendant=',
    'role="listbox"', 'role="option"', 'aria-selected=', 'role="status"', 'aria-live="polite"', 'role="alert"',
    'htmlFor=', "'ArrowDown'", "'ArrowUp'", "'Home'", "'End'", "'Enter'", "'Escape'",
  ]) {
    assert(code.includes(required), `ContactSelector lost combobox semantics: ${required}`)
  }
  // Tab and blur must keep native behaviour: no handler may select on them.
  assert(!/case 'Tab'/u.test(code), 'ContactSelector intercepts Tab')
  assert(!/onBlur=\{[^}]*select\(/u.test(code), 'ContactSelector selects on blur')
}

/** 15. The browser transport is a pass-through to searchContactsV1 and nothing more. */
function assertLookupTransport(sources) {
  const route = withoutComments(sources[LOOKUP_ROUTE])
  const routeSpecifiers = [...new Set([...route.matchAll(/\bfrom\s+'([^']+)'/gu)].map((match) => match[1]))].sort()
  assert.deepEqual(routeSpecifiers, ['@/modules/contacts/public/v1', 'next/server'],
    `the lookup route imports something other than the Contacts public surface: ${routeSpecifiers.join(', ')}`)
  assert(route.includes('searchContactsV1({ query, limit })'), 'the lookup route does not delegate to searchContactsV1')
  assert(/export async function GET\(/u.test(route), 'the lookup route is not a GET read')
  assert(!/export async function (POST|PUT|PATCH|DELETE)\b/u.test(route), 'the lookup route exposes a mutation')
  const client = withoutComments(sources[HTTP_CLIENT])
  const clientSpecifiers = [...new Set([...client.matchAll(/\bfrom\s+'([^']+)'/gu)].map((match) => match[1]))].sort()
  assert.deepEqual(clientSpecifiers, ['../contact-lookup', './ContactSelector'],
    `the lookup client imports something other than the ContactLookup contract: ${clientSpecifiers.join(', ')}`)
  assert(!/^import (?!type )/mu.test(client), 'the lookup client imports runtime code instead of types only')
  assert(client.includes("CONTACT_LOOKUP_ENDPOINT_V1 = '/api/contacts/lookup'"), 'the lookup client targets another endpoint')
  assert.equal(client.match(/\/api\//gu)?.length, 1, 'the lookup client reaches more than the lookup endpoint')
  for (const source of [route, client]) {
    for (const forbidden of [
      'prisma', '.sort(', 'localeCompare', 'stripToDigits', 'formatContactPhone', 'isTechnicalProviderName',
      'buildProviderNeutralContactDisplayV1', 'contactLookupSortKeyV1', '/api/contacts/search', '@/modules/messaging',
      'app/messages', ...FORBIDDEN_VOCABULARY,
    ]) {
      assert(!source.includes(forbidden), `the lookup transport carries ${forbidden}`)
    }
  }
}

/** 16. The authorized merge picker reaches the lookup only through the Contacts client. */
function assertMergePickerAdoption(sources) {
  const drawer = withoutComments(sources[DRAWER])
  assert(drawer.includes("from '@/modules/contacts/public/v1/client-ui/ContactSelector'"),
    'the merge picker does not use ContactSelector')
  assert(drawer.includes("from '@/modules/contacts/public/v1/client-ui/http-contact-lookup-client'"),
    'the merge picker does not reach the lookup through the Contacts client')
  assert(!drawer.includes('useContactSearch'), 'the merge picker still uses the legacy contact search hook')
  assert(!drawer.includes('/api/contacts/search'), 'the merge picker calls the legacy contact search route')
  assert(drawer.includes('selected.contactId === currentContactId'),
    'the merge picker does not refuse the current Contact as its own target')
  assert(sources[DRAWER_PROOF].includes('ContactSelector'), 'the merge picker proof is missing')
}

/** 17. One Contacts client lookup state machine: the criteria gate, the stale guard, no transport, no policy. */
function assertSharedLookupHook(sources) {
  const hook = sources[LOOKUP_HOOK]
  const specifiers = [...new Set([...hook.matchAll(/\bfrom\s+'([^']+)'/gu)].map((match) => match[1]))].sort()
  assert.deepEqual(specifiers, ['../contact-lookup', 'react'],
    `the shared lookup hook imports something other than React and ContactLookup.v1: ${specifiers.join(', ')}`)
  const code = withoutComments(hook)
  assert(code.includes('export function useContactLookupV1('), 'the shared lookup hook is not declared')
  assert(code.includes('if (contactLookupCriteriaV1(query) === null) return false'),
    'the shared lookup hook does not gate queries with contactLookupCriteriaV1')
  assert(code.includes('ContactLookupResultV1'), 'the shared lookup hook does not consume the ContactLookup.v1 result type')
  assert(code.includes('sequence !== sequenceRef.current') && code.includes('!mountedRef.current'),
    'the shared lookup hook can apply a stale or unmounted answer')
  assert.equal(code.match(/setTimeout\(/gu)?.length, 1, 'the shared lookup hook keeps more than one timer')
  for (const forbidden of CLIENT_SURFACE_FORBIDDEN) {
    assert(!code.includes(forbidden), `the shared lookup hook owns transport, server or foreign state: ${forbidden}`)
  }
  for (const forbidden of CLIENT_POLICY_FORBIDDEN) {
    assert(!code.includes(forbidden), `the shared lookup hook reimplements a ContactLookup.v1 policy: ${forbidden}`)
  }
  for (const forbidden of FORBIDDEN_VOCABULARY) {
    assert(!code.includes(forbidden), `the shared lookup hook carries ${forbidden}`)
  }
  assert(!/use-contact-lookup|useContactLookupV1/u.test(sources[PUBLIC_INDEX]),
    'the client lookup hook is re-exported through the server-oriented Contacts barrel')
  // The selector's public debounce stays one value, owned by the shared machine.
  assert(withoutComments(sources[SELECTOR]).includes('export const CONTACT_SELECTOR_DEBOUNCE_MS = CONTACT_LOOKUP_DEBOUNCE_MS'),
    'ContactSelector keeps a second debounce value')
  const consumers = sources[LOOKUP_HOOK_CONSUMERS].split('\n').map((line) => line.trim()).filter(Boolean).sort()
  assert.deepEqual(consumers, AUTHORIZED_LOOKUP_HOOK_CONSUMERS,
    `the shared lookup hook is adopted outside NewChatPopover and ChatList: ${consumers.join(', ')}`)
}

/** 18. NewChatPopover and ChatList: ContactLookup.v1 for people, Messaging's fail-closed context for conversations. */
function assertConversationConsumers(sources) {
  for (const relative of [NEW_CHAT, CHAT_LIST]) {
    const code = withoutComments(sources[relative])
    assert(code.includes("from '@/modules/contacts/public/v1/client-ui/use-contact-lookup'") || code.includes('from "@/modules/contacts/public/v1/client-ui/use-contact-lookup"'),
      `${relative} does not use the shared Contacts lookup hook`)
    assert(code.includes('client-ui/http-contact-lookup-client'), `${relative} does not reach the lookup through the Contacts client`)
    assert(code.includes('from "../hooks/useContactConversations"'), `${relative} does not take conversation context from Messaging`)
    for (const forbidden of ['useContactSearch', '/api/contacts/search', 'hasChat', '@/lib/prisma', 'prisma.',
      'readContactConversationsAction', '.entries.get(', '.entries.values(', 'ContactSearchResult']) {
      assert(!code.includes(forbidden), `${relative} bypasses the lookup or the conversation context: ${forbidden}`)
    }
    // What the lookup returned is used in the order received.
    assert(/contactLookup\.status === 'success' \? contactLookup\.result\?\.items \?\? \[\] : \[\]/u.test(code),
      `${relative} does not take its Contacts from the settled lookup answer`)
    assert(!/\b(?:results|contactResults|extraContacts)\b[^\n;]*\.sort\(/u.test(code), `${relative} re-orders the lookup answer`)
  }
  const newChat = withoutComments(sources[NEW_CHAT])
  assert(newChat.includes('contactChannelDecisionV1(conversations, contact.contactId, dbChannel)'),
    'NewChatPopover does not decide open/start through the Messaging decision')
  assert(newChat.includes(".kind === 'start'"), 'NewChatPopover shows «новый чат» on something other than a proven absence')
  assert(newChat.includes('new Set<string>(focusedContact?.channels || [])'),
    'NewChatPopover channel identity marks no longer come from ContactLookup alone')
  const chatList = withoutComments(sources[CHAT_LIST])
  for (const helper of ['isExtraContactV1(', 'foundContactConversationsV1(', 'hasProvenNoConversationV1(']) {
    assert(chatList.includes(helper), `ChatList does not use the fail-closed Messaging helper ${helper}`)
  }
  // The Messaging helpers themselves fail closed.
  const conversations = withoutComments(sources[CONVERSATIONS_HOOK])
  const specifiers = [...new Set([...conversations.matchAll(/\bfrom\s+'([^']+)'/gu)].map((match) => match[1]))].sort()
  assert.deepEqual(specifiers, ['../contact-conversations-actions', '@/contracts/messaging/v1/contact-conversations-query', 'react'],
    `the conversation hook reaches something other than the landed Messaging transport: ${specifiers.join(', ')}`)
  for (const forbidden of ['prisma', 'fetch(', '/api/', 'startByContact', 'create']) {
    assert(!conversations.includes(forbidden), `the conversation hook reads or writes outside its transport: ${forbidden}`)
  }
  assert(conversations.includes('contactChannelConversationsV1(entry, channel)'),
    'the conversation decision does not use the contract helper')
  assert.equal(conversations.match(/return \{ kind: 'start'/gu)?.length, 1, 'more than one path starts a conversation')
  assert(conversations.includes("if (lookup.kind === 'absent') return { kind: 'start'"),
    'a conversation may start on something other than a proven absence')
  assert(conversations.includes('return entry.truncated === false\n}'), 'an extra Contact may be shown on a truncated answer')
  assert(conversations.includes("if (state.status !== 'ready') return false"), 'an extra Contact may be shown without an answer')
  assert(conversations.includes('entry.truncated === false && entry.latestConversationId === null'),
    '«новый чат» may be shown on an incomplete answer')
}

const CHECKS = [
  ['contract_shape', assertContractShape],
  ['no_foreign_vocabulary', assertNoForeignVocabulary],
  ['canonical_reuse', assertCanonicalReuse],
  ['provider_neutral_policy', assertProviderNeutralPolicy],
  ['ranking_before_truncation', assertRankingBeforeTruncation],
  ['persistence_ownership', assertPersistenceOwnership],
  ['no_foreign_dependency', assertNoForeignDependency],
  ['governance_declared', assertGovernanceDeclared],
  ['legacy_unchanged', assertLegacyUnchanged],
  ['no_schema_surface', assertNoSchemaSurface],
  ['selector_client_surface', assertSelectorClientSurface],
  ['selector_no_policy', assertSelectorNoPolicy],
  ['selector_vocabulary', assertSelectorVocabulary],
  ['selector_accessibility', assertSelectorAccessibility],
  ['lookup_transport', assertLookupTransport],
  ['merge_picker_adoption', assertMergePickerAdoption],
  ['shared_lookup_hook', assertSharedLookupHook],
  ['conversation_consumers', assertConversationConsumers],
]

const PROBES = [
  ['item_gains_field', 'contract_shape', (s) => ({ ...s, [LOOKUP]: s[LOOKUP].replace('  /** Channel names of ACTIVE Contacts identities, sorted and deduplicated. */\n  channels: string[]', '  channels: string[]\n  hasChat: boolean') })],
  ['result_loses_truncated', 'contract_shape', (s) => ({ ...s, [LOOKUP]: s[LOOKUP].replace('  /** True when at least one further unique candidate existed beyond `limit`. */\n  truncated: boolean', '') })],
  ['contract_counts_table', 'contract_shape', (s) => ({ ...s, [LOOKUP]: s[LOOKUP].replace('const EMPTY_RESULT', 'const unbounded = (p) => p.count()\n\nconst EMPTY_RESULT') })],
  ['contract_leaks_external_id', 'no_foreign_vocabulary', (s) => ({ ...s, [LOOKUP]: s[LOOKUP].replace('  channels: string[]\n}', '  channels: string[]\n  externalId: string\n}') })],
  ['contract_leaks_reachability', 'no_foreign_vocabulary', (s) => ({ ...s, [LOOKUP]: s[LOOKUP].replace('  channels: string[]\n}', "  channels: string[]\n  reachabilityStatus: 'confirmed'\n}") })],
  ['adapter_selects_metadata', 'no_foreign_vocabulary', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('          select: { channel: true, isActive: true, displayName: true },', '          select: { channel: true, isActive: true, displayName: true, metadata: true },') })],
  ['lookup_reimplements_name_rule', 'canonical_reuse', (s) => ({ ...s, [LOOKUP]: s[LOOKUP].replace('const EMPTY_RESULT', 'const localName = (c) => isTechnicalProviderName(c.displayName) ? null : c.displayName\n\nconst EMPTY_RESULT') })],
  ['lookup_drops_display_policy', 'canonical_reuse', (s) => ({ ...s, [LOOKUP]: s[LOOKUP].replace("from './contact-display-policy'", "from './contact-display-policy-missing'") })],
  ['lookup_drops_confirmed_person', 'canonical_reuse', (s) => ({ ...s, [LOOKUP]: s[LOOKUP].replace('confirmedPersonNameV1(source.customFields)', 'null') .replace('import { confirmedPersonNameV1, contactAutomationState, phoneEvidenceState }', 'import { contactAutomationState, phoneEvidenceState }') })],
  ['neutral_policy_admits_provider_id', 'provider_neutral_policy', (s) => ({ ...s, [POLICY]: s[POLICY].replace('    || candidates.providerName\n    || GENERIC_CONTACT_DISPLAY_NAME\n  return {', '    || candidates.providerName\n    || candidates.stableProviderId\n    || GENERIC_CONTACT_DISPLAY_NAME\n  return {') })],
  ['neutral_policy_removed', 'provider_neutral_policy', (s) => ({ ...s, [POLICY]: s[POLICY].replace('export function buildProviderNeutralContactDisplayV1', 'function buildProviderNeutralContactDisplayV1') })],
  ['canonical_summary_altered', 'provider_neutral_policy', (s) => ({ ...s, [POLICY]: s[POLICY].replace('    || providerName\n    || stableProviderId\n', '    || providerName\n') })],
  ['rank_classes_reordered', 'ranking_before_truncation', (s) => ({ ...s, [LOOKUP]: s[LOOKUP].replace("  'phone_exact',\n  'phone_substring',", "  'phone_substring',\n  'phone_exact',") })],
  ['truncation_before_ranking', 'ranking_before_truncation', (s) => ({ ...s, [LOOKUP]: s[LOOKUP].replaceAll('if (seen.size > limit) break', 'if (false) break') })],
  ['collection_is_unbounded', 'ranking_before_truncation', (s) => ({ ...s, [LOOKUP]: s[LOOKUP].replaceAll('limit + 1', 'limit') })],
  ['ordering_uses_locale', 'ranking_before_truncation', (s) => ({ ...s, [LOOKUP]: s[LOOKUP].replace("return String(value ?? '').normalize('NFKC').toLowerCase()", "return String(value ?? '').toLowerCase()") })],
  ['rank_ignored_in_order', 'ranking_before_truncation', (s) => ({ ...s, [LOOKUP]: s[LOOKUP].replace('.sort((left, right) => (left.rank !== right.rank\n        ? left.rank - right.rank\n        : compareBySortKeyThenId(left, right)))', '.sort((left, right) => compareBySortKeyThenId(left, right))') })],
  ['contract_reaches_database', 'persistence_ownership', (s) => ({ ...s, [LOOKUP]: s[LOOKUP].replace('export const CONTACT_LOOKUP_DEFAULT_LIMIT_V1', "import { prisma } from '@/lib/prisma'\n\nexport const CONTACT_LOOKUP_DEFAULT_LIMIT_V1") })],
  ['adapter_reads_chat', 'persistence_ownership', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('    if (contactIds.length === 0) return []', '    if (contactIds.length === 0) return []\n    await prisma.chat.findMany({ where: { contactId: { in: [...contactIds] } } })') })],
  ['adapter_reads_driver', 'persistence_ownership', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('    if (contactIds.length === 0) return []', '    if (contactIds.length === 0) return []\n    await prisma.driver.findFirst({ where: { contactId: { in: [...contactIds] } } })') })],
  ['adapter_writes', 'persistence_ownership', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('    if (contactIds.length === 0) return []', '    if (contactIds.length === 0) return []\n    await prisma.contact.update({ where: { id: contactIds[0] }, data: {} })') })],
  ['adapter_hydrates_per_row', 'persistence_ownership', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('    return contacts.map(contact => ({', '    await prisma.contactPhone.findMany({ where: { contactId: contacts[0]?.id } })\n    return contacts.map(contact => ({') })],
  ['adapter_admits_archived', 'persistence_ownership', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('const LIVE_CONTACT = { isArchived: false } as const', 'const LIVE_CONTACT = {} as const') })],
  ['lookup_imports_messaging', 'no_foreign_dependency', (s) => ({ ...s, [LOOKUP]: s[LOOKUP].replace('export const CONTACT_LOOKUP_DEFAULT_LIMIT_V1', "import { x } from '@/modules/messaging/public/v1'\n\nexport const CONTACT_LOOKUP_DEFAULT_LIMIT_V1") })],
  ['lookup_probes_provider', 'no_foreign_dependency', (s) => ({ ...s, [LOOKUP]: s[LOOKUP].replace('export const CONTACT_LOOKUP_DEFAULT_LIMIT_V1', 'const probe = () => fetch("/api/channels/check-reachability")\n\nexport const CONTACT_LOOKUP_DEFAULT_LIMIT_V1') })],
  ['contacts_gains_dependency', 'no_foreign_dependency', (s) => ({ ...s, [MANIFEST]: s[MANIFEST].replace('"context": "identity_access"', '"context": "messaging"') })],
  ['duplicate_capability_declared', 'governance_declared', (s) => ({ ...s, [MANIFEST]: s[MANIFEST].replace('"ContactLookup.v1",', '"ContactLookup.v1",\n    "ContactSelector.v1",') })],
  ['control_undeclared', 'governance_declared', (s) => ({ ...s, [MANIFEST]: s[MANIFEST].replace('node tools/architecture/check-contact-lookup-boundary.mjs', 'node tools/architecture/check-something-else.mjs') })],
  ['operation_unwired', 'governance_declared', (s) => ({ ...s, [OPERATIONS]: s[OPERATIONS].replace('createSearchContactsHandlerV1(legacyPrismaContactLookupPortV1)', 'createSearchContactsHandlerV1({ findContactLookupCandidateIds: async () => [], findContactLookupSources: async () => [] })') })],
  ['legacy_route_touched', 'legacy_unchanged', (s) => ({ ...s, [LEGACY_ROUTE]: `${s[LEGACY_ROUTE]}\n// touched\n` })],
  ['legacy_hook_touched', 'legacy_unchanged', (s) => ({ ...s, [LEGACY_HOOK]: `${s[LEGACY_HOOK]}\n// touched\n` })],
  ['adapter_runs_raw_sql', 'no_schema_surface', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('    if (contactIds.length === 0) return []', '    if (contactIds.length === 0) return []\n    await prisma.$queryRaw`select 1`') })],
  ['selector_server_component', 'selector_client_surface', (s) => ({ ...s, [SELECTOR]: s[SELECTOR].replace('"use client"\n', '') })],
  ['selector_fetches_legacy_route', 'selector_client_surface', (s) => ({ ...s, [SELECTOR]: s[SELECTOR].replace('  const { status, result, request, reset } = useContactLookupV1(', "  const legacy = (q: string) => fetch('/api/contacts/search?q=' + q)\n  const { status, result, request, reset } = useContactLookupV1(") })],
  ['selector_bypasses_shared_hook', 'selector_client_surface', (s) => ({ ...s, [SELECTOR]: s[SELECTOR].replace('useContactLookupV1(lookup, { onSettled })', "({ status: 'idle' as const, result: null, request: (q: string) => q.length > 1, reset: () => {} })") })],
  ['selector_owns_second_timer', 'selector_client_surface', (s) => ({ ...s, [SELECTOR]: s[SELECTOR].replace('  const items = result?.items ?? []', '  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)\n  const items = result?.items ?? []') })],
  ['selector_uses_legacy_hook', 'selector_client_surface', (s) => ({ ...s, [SELECTOR]: s[SELECTOR].replace("} from '../contact-lookup'", "} from '../contact-lookup'\nimport { useContactSearch } from '../../../../../app/messages/hooks/useContactSearch'") })],
  ['selector_imports_prisma', 'selector_client_surface', (s) => ({ ...s, [SELECTOR]: s[SELECTOR].replace("} from '../contact-lookup'", "} from '../contact-lookup'\nimport { prisma } from '@/lib/prisma'") })],
  ['selector_imports_messaging', 'selector_client_surface', (s) => ({ ...s, [SELECTOR]: s[SELECTOR].replace("} from '../contact-lookup'", "} from '../contact-lookup'\nimport { searchConversations } from '@/modules/messaging/public/v1'") })],
  ['lookup_hook_skips_criteria', 'shared_lookup_hook', (s) => ({ ...s, [LOOKUP_HOOK]: s[LOOKUP_HOOK].replace('if (contactLookupCriteriaV1(query) === null) return false', 'if (query.trim().length < 2) return false') })],
  ['lookup_hook_fetches_legacy_route', 'shared_lookup_hook', (s) => ({ ...s, [LOOKUP_HOOK]: s[LOOKUP_HOOK].replace('  const runLookup = useCallback(', "  const legacy = (q: string) => fetch('/api/contacts/search?q=' + q)\n  const runLookup = useCallback(") })],
  ['lookup_hook_applies_stale_answer', 'shared_lookup_hook', (s) => ({ ...s, [LOOKUP_HOOK]: s[LOOKUP_HOOK].replaceAll('if (!mountedRef.current || sequence !== sequenceRef.current) return', 'if (!mountedRef.current) return') })],
  ['lookup_hook_sorts_results', 'shared_lookup_hook', (s) => ({ ...s, [LOOKUP_HOOK]: s[LOOKUP_HOOK].replace('const receivedItems = Array.isArray(received?.items) ? received.items : []', 'const receivedItems = Array.isArray(received?.items) ? [...received.items].sort() : []') })],
  ['lookup_hook_normalizes_phone', 'shared_lookup_hook', (s) => ({ ...s, [LOOKUP_HOOK]: s[LOOKUP_HOOK].replace('  const request = useCallback((query: string) => {', "  const digitsOnly = (q: string) => q.replace(/\\D/g, '')\n  const request = useCallback((query: string) => {") })],
  ['lookup_hook_imports_messaging', 'shared_lookup_hook', (s) => ({ ...s, [LOOKUP_HOOK]: s[LOOKUP_HOOK].replace("import { contactLookupCriteriaV1, type ContactLookupResultV1 } from '../contact-lookup'", "import { contactLookupCriteriaV1, type ContactLookupResultV1 } from '../contact-lookup'\nimport { contactConversationsV1 } from '@/modules/messaging/public/v1'") })],
  ['lookup_hook_reexported_from_barrel', 'shared_lookup_hook', (s) => ({ ...s, [PUBLIC_INDEX]: `${s[PUBLIC_INDEX]}\nexport { useContactLookupV1 } from './client-ui/use-contact-lookup'\n` })],
  ['lookup_hook_second_debounce', 'shared_lookup_hook', (s) => ({ ...s, [SELECTOR]: s[SELECTOR].replace('export const CONTACT_SELECTOR_DEBOUNCE_MS = CONTACT_LOOKUP_DEBOUNCE_MS', 'export const CONTACT_SELECTOR_DEBOUNCE_MS = 250') })],
  ['lookup_hook_adopted_elsewhere', 'shared_lookup_hook', (s) => ({ ...s, [LOOKUP_HOOK_CONSUMERS]: `${s[LOOKUP_HOOK_CONSUMERS]}gravity-mvp/src/app/tasks/components/TaskContactSearch.tsx\n` })],
  ['lookup_hook_adopter_dropped', 'shared_lookup_hook', (s) => ({ ...s, [LOOKUP_HOOK_CONSUMERS]: `${CHAT_LIST}\n` })],
  ['consumer_keeps_legacy_hook', 'conversation_consumers', (s) => ({ ...s, [NEW_CHAT]: s[NEW_CHAT].replace('import { useStartConversation } from "../hooks/useStartConversation"', 'import { useStartConversation } from "../hooks/useStartConversation"\nimport { useContactSearch } from "../hooks/useContactSearch"') })],
  ['consumer_fetches_legacy_route', 'conversation_consumers', (s) => ({ ...s, [CHAT_LIST]: s[CHAT_LIST].replace('const CONTACT_LOOKUP_LIMIT = 8', "const CONTACT_LOOKUP_LIMIT = 8\nconst legacy = (q: string) => fetch('/api/contacts/search?q=' + q)") })],
  ['consumer_restores_has_chat', 'conversation_consumers', (s) => ({ ...s, [CHAT_LIST]: s[CHAT_LIST].replace('const entry = foundContactConversationsV1(contactConversations, contact.contactId)', 'const entry = foundContactConversationsV1(contactConversations, contact.contactId)\n        const hasChat = entry?.channels.length') })],
  ['consumer_sorts_lookup_answer', 'conversation_consumers', (s) => ({ ...s, [NEW_CHAT]: s[NEW_CHAT].replace('                        {results.map(contact => {', '                        {[...results].sort((a, b) => a.displayName.localeCompare(b.displayName)).map(contact => {') })],
  ['consumer_reads_conversation_entries', 'conversation_consumers', (s) => ({ ...s, [NEW_CHAT]: s[NEW_CHAT].replace('const knownChannels = new Set<string>(focusedContact?.channels || [])', "const knownChannels = new Set<string>(focusedContact?.channels || [])\n                if (conversations.status === 'ready') for (const entry of conversations.entries.values()) void entry") })],
  ['consumer_calls_transport_directly', 'conversation_consumers', (s) => ({ ...s, [CHAT_LIST]: s[CHAT_LIST].replace('const CONTACT_LOOKUP_LIMIT = 8', "const CONTACT_LOOKUP_LIMIT = 8\nimport { readContactConversationsAction } from '../contact-conversations-actions'") })],
  ['consumer_hint_on_unknown', 'conversation_consumers', (s) => ({ ...s, [NEW_CHAT]: s[NEW_CHAT].replace("contactChannelDecisionV1(conversations, contact.contactId, dbChannel).kind === 'start'", "contactChannelDecisionV1(conversations, contact.contactId, dbChannel).kind !== 'open'") })],
  ['consumer_extra_without_messaging', 'conversation_consumers', (s) => ({ ...s, [CHAT_LIST]: s[CHAT_LIST].replace('return contactResults.filter(contact => isExtraContactV1(contactConversations, contact.contactId, visibleChatIds))', 'return contactResults') })],
  ['conversations_unknown_starts', 'conversation_consumers', (s) => ({ ...s, [CONVERSATIONS_HOOK]: s[CONVERSATIONS_HOOK].replace("    return { kind: lookup.kind }", "    if (lookup.kind === 'unknown') return { kind: 'start', canonicalContactId: contactId }\n    return { kind: lookup.kind }") })],
  ['conversations_extra_on_truncated', 'conversation_consumers', (s) => ({ ...s, [CONVERSATIONS_HOOK]: s[CONVERSATIONS_HOOK].replace('    return entry.truncated === false\n}', '    return true\n}') })],
  ['conversations_extra_without_answer', 'conversation_consumers', (s) => ({ ...s, [CONVERSATIONS_HOOK]: s[CONVERSATIONS_HOOK].replace("    if (state.status !== 'ready') return false\n    const entry = state.entries.get(contactId)\n    if (!entry || entry.status !== 'found') return false\n    if (knownConversationIdsV1", "    if (state.status !== 'ready') return true\n    const entry = state.entries.get(contactId)\n    if (!entry || entry.status !== 'found') return false\n    if (knownConversationIdsV1") })],
  ['conversations_hint_on_truncated', 'conversation_consumers', (s) => ({ ...s, [CONVERSATIONS_HOOK]: s[CONVERSATIONS_HOOK].replace('entry.truncated === false && entry.latestConversationId === null', 'entry.latestConversationId === null') })],
  ['conversations_hook_reads_chat', 'conversation_consumers', (s) => ({ ...s, [CONVERSATIONS_HOOK]: s[CONVERSATIONS_HOOK].replace("import { readContactConversationsAction } from '../contact-conversations-actions'", "import { readContactConversationsAction } from '../contact-conversations-actions'\nimport { prisma } from '@/lib/prisma'") })],
  ['selector_reexported_from_barrel', 'selector_client_surface', (s) => ({ ...s, [PUBLIC_INDEX]: `${s[PUBLIC_INDEX]}\nexport { default as ContactSelector } from './client-ui/ContactSelector'\n` })],
  ['selector_adopted_by_consumer', 'selector_client_surface', (s) => ({ ...s, [SELECTOR_CONSUMERS]: `${s[SELECTOR_CONSUMERS]}gravity-mvp/src/app/messages/components/NewChatPopover.tsx\n` })],
  ['selector_adopter_dropped', 'selector_client_surface', (s) => ({ ...s, [SELECTOR_CONSUMERS]: `${DRAWER_PROOF}\n` })],
  ['selector_sorts_results', 'selector_no_policy', (s) => ({ ...s, [SELECTOR]: s[SELECTOR].replace('  const items = result?.items ?? []', '  const items = [...(result?.items ?? [])].sort()') })],
  ['selector_normalizes_phone', 'selector_no_policy', (s) => ({ ...s, [SELECTOR]: s[SELECTOR].replace('    setInputText(text)\n    resetLookup()', "    const digits = text.replace(/\\D/g, '')\n    setInputText(text)\n    resetLookup()") })],
  ['selector_composes_title', 'selector_no_policy', (s) => ({ ...s, [SELECTOR]: s[SELECTOR].replace('{item.displayTitle}</span>', '{item.displayName} · {item.primaryPhone}</span>') })],
  ['selector_reads_phone', 'selector_no_policy', (s) => ({ ...s, [SELECTOR]: s[SELECTOR].replace('{item.displayTitle}</span>', '{item.displayTitle}{item.primaryPhone}</span>') })],
  ['selector_shows_reachability', 'selector_vocabulary', (s) => ({ ...s, [SELECTOR]: s[SELECTOR].replace('{item.displayTitle}</span>', '{item.displayTitle}{(item as any).reachabilityStatus}</span>') })],
  ['selector_claims_availability', 'selector_vocabulary', (s) => ({ ...s, [SELECTOR]: s[SELECTOR].replace('{item.displayTitle}</span>', '{item.displayTitle} — Доступен</span>') })],
  ['selector_drops_combobox_role', 'selector_accessibility', (s) => ({ ...s, [SELECTOR]: s[SELECTOR].replace('role="combobox"', '') })],
  ['selector_drops_live_region', 'selector_accessibility', (s) => ({ ...s, [SELECTOR]: s[SELECTOR].replace('aria-live="polite"', '') })],
  ['selector_drops_active_descendant', 'selector_accessibility', (s) => ({ ...s, [SELECTOR]: s[SELECTOR].replace('aria-activedescendant={activeDescendant}', '') })],
  ['selector_selects_on_tab', 'selector_accessibility', (s) => ({ ...s, [SELECTOR]: s[SELECTOR].replace("      case 'Escape': {", "      case 'Tab': {\n        if (items[0]) select(items[0])\n        return\n      }\n      case 'Escape': {") })],
  ['route_reads_prisma', 'lookup_transport', (s) => ({ ...s, [LOOKUP_ROUTE]: s[LOOKUP_ROUTE].replace("import { searchContactsV1 } from '@/modules/contacts/public/v1'", "import { searchContactsV1 } from '@/modules/contacts/public/v1'\nimport { prisma } from '@/lib/prisma'") })],
  ['route_skips_capability', 'lookup_transport', (s) => ({ ...s, [LOOKUP_ROUTE]: s[LOOKUP_ROUTE].replace('searchContactsV1({ query, limit })', 'searchContactsV1({ query })') })],
  ['route_filters_results', 'lookup_transport', (s) => ({ ...s, [LOOKUP_ROUTE]: s[LOOKUP_ROUTE].replace('return NextResponse.json(result)', 'return NextResponse.json({ ...result, items: [...result.items].sort() })') })],
  ['route_accepts_mutation', 'lookup_transport', (s) => ({ ...s, [LOOKUP_ROUTE]: `${s[LOOKUP_ROUTE]}\nexport async function POST() { return new Response(null) }\n` })],
  ['route_imports_messaging', 'lookup_transport', (s) => ({ ...s, [LOOKUP_ROUTE]: s[LOOKUP_ROUTE].replace("import { searchContactsV1 } from '@/modules/contacts/public/v1'", "import { searchContactsV1 } from '@/modules/contacts/public/v1'\nimport { listConversations } from '@/modules/messaging/public/v1'") })],
  ['client_targets_legacy_search', 'lookup_transport', (s) => ({ ...s, [HTTP_CLIENT]: s[HTTP_CLIENT].replace("CONTACT_LOOKUP_ENDPOINT_V1 = '/api/contacts/lookup'", "CONTACT_LOOKUP_ENDPOINT_V1 = '/api/contacts/search'") })],
  ['client_imports_runtime', 'lookup_transport', (s) => ({ ...s, [HTTP_CLIENT]: s[HTTP_CLIENT].replace("import type { ContactLookupItemV1, ContactLookupResultV1 } from '../contact-lookup'", "import { contactLookupCriteriaV1, type ContactLookupItemV1, type ContactLookupResultV1 } from '../contact-lookup'") })],
  ['client_passes_extra_fields', 'lookup_transport', (s) => ({ ...s, [HTTP_CLIENT]: s[HTTP_CLIENT].replace('    channels: [...record.channels],\n  }', '    channels: [...record.channels],\n    externalId: record.externalId,\n  }') })],
  ['client_sorts_results', 'lookup_transport', (s) => ({ ...s, [HTTP_CLIENT]: s[HTTP_CLIENT].replace('const valid = items as ContactLookupItemV1[]', 'const valid = (items as ContactLookupItemV1[]).sort()') })],
  ['picker_keeps_legacy_hook', 'merge_picker_adoption', (s) => ({ ...s, [DRAWER]: s[DRAWER].replace("import ContactSelector from '@/modules/contacts/public/v1/client-ui/ContactSelector'", "import ContactSelector from '@/modules/contacts/public/v1/client-ui/ContactSelector'\nimport { useContactSearch } from \"../hooks/useContactSearch\"") })],
  ['picker_drops_selector', 'merge_picker_adoption', (s) => ({ ...s, [DRAWER]: s[DRAWER].replace("import ContactSelector from '@/modules/contacts/public/v1/client-ui/ContactSelector'\n", '') })],
  ['picker_bypasses_client', 'merge_picker_adoption', (s) => ({ ...s, [DRAWER]: s[DRAWER].replace("import { createHttpContactLookupClientV1 } from '@/modules/contacts/public/v1/client-ui/http-contact-lookup-client'\n", '') })],
  ['picker_allows_self_target', 'merge_picker_adoption', (s) => ({ ...s, [DRAWER]: s[DRAWER].replace('selected.contactId === currentContactId', 'false') })],
]

function main() {
  const relatives = [LOOKUP, ADAPTER, PROOF, POLICY, POLICY_PROOF, OPERATIONS, PUBLIC_INDEX, MANIFEST,
    LEGACY_ROUTE, LEGACY_HOOK, SELECTOR, SELECTOR_PROOF, LOOKUP_ROUTE, LOOKUP_ROUTE_PROOF, HTTP_CLIENT,
    HTTP_CLIENT_PROOF, DRAWER, DRAWER_PROOF, LOOKUP_HOOK, LOOKUP_HOOK_PROOF, NEW_CHAT, NEW_CHAT_PROOF,
    CHAT_LIST, CHAT_LIST_PROOF, CONVERSATIONS_HOOK, CONVERSATIONS_HOOK_PROOF]
  const sources = Object.fromEntries(relatives.map((relative) => [relative, read(relative)]))
  // git grep exits 1 when nothing matches; only a status above 1 is a failure.
  const consumers = spawnSync('git', ['-c', 'safe.directory=*', 'grep', '-l', 'ContactSelector', '--',
    'gravity-mvp/src', `:(exclude)${CLIENT_UI_DIR}`], { cwd: root, encoding: 'utf8' })
  assert(consumers.status === 0 || consumers.status === 1, `the selector consumer scan failed: ${consumers.stderr}`)
  sources[SELECTOR_CONSUMERS] = consumers.stdout
  const hookConsumers = spawnSync('git', ['-c', 'safe.directory=*', 'grep', '-l', 'useContactLookupV1', '--',
    'gravity-mvp/src', `:(exclude)${CLIENT_UI_DIR}`], { cwd: root, encoding: 'utf8' })
  assert(hookConsumers.status === 0 || hookConsumers.status === 1, `the lookup hook consumer scan failed: ${hookConsumers.stderr}`)
  sources[LOOKUP_HOOK_CONSUMERS] = hookConsumers.stdout
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

  assert.equal(passingProofCount('\n      Tests  28 passed (28)\n'), 28, 'the plain Vitest summary is no longer parsed')
  assert.equal(passingProofCount('\u001B[32m      Tests \u001B[39m 28 passed\u001B[90m (28)\u001B[39m\n'), 28,
    'an ANSI-decorated Vitest summary is not parsed')
  assert.equal(passingProofCount(''), null, 'an empty summary must not be read as a passing run')

  // The proofs are what make these invariants behavioural, so this control runs
  // them rather than trusting that something else will. The display-policy proofs
  // are included because the provider-id refusal lives there, and the selector
  // proofs because its race, keyboard, accessibility and leak guarantees are
  // behaviour, not text.
  const vitest = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'src/modules/contacts/public/v1/contact-lookup.test.ts',
    'src/modules/contacts/public/v1/contact-display-policy.test.ts',
    'src/modules/contacts/public/v1/client-ui/ContactSelector.test.tsx',
    'src/modules/contacts/public/v1/client-ui/http-contact-lookup-client.test.ts',
    'src/app/api/contacts/lookup/route.test.ts',
    'src/app/messages/components/ContactProfileDrawer.merge-picker.test.tsx',
    'src/modules/contacts/public/v1/client-ui/use-contact-lookup.test.ts',
    'src/app/messages/hooks/useContactConversations.test.ts',
    'src/app/messages/components/NewChatPopover.contact-lookup.test.tsx',
    'src/app/messages/components/ChatList.contact-lookup.test.tsx',
  ], { cwd: path.join(root, 'gravity-mvp'), encoding: 'utf8' })
  assert.equal(vitest.status, 0, `the contact lookup proofs failed:\n${vitest.stdout}\n${vitest.stderr}`)
  const passed = passingProofCount(vitest.stdout)
  assert(passed !== null && passed > 0, `the proofs reported no passing tests:\n${vitest.stdout}`)

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    control: 'contact-lookup-boundary',
    checks: CHECKS.length,
    negative_probes: PROBES.length,
    lookup_tests: passed,
    item_fields: ITEM_FIELDS.length,
    rank_classes: RANK_CLASSES.length,
    database_models_read: 3,
    provider_id_display_fallback: false,
    duplicate_capability: false,
    legacy_search_surface_unchanged: true,
    selector_client_surface: true,
    selector_owns_transport: false,
    selector_consumers: AUTHORIZED_SELECTOR_CONSUMERS.length - 1,
    lookup_transport_pass_through: true,
    merge_picker_on_lookup: true,
    shared_lookup_state_machines: 1,
    lookup_hook_consumers: AUTHORIZED_LOOKUP_HOOK_CONSUMERS.length,
    conversation_context_fail_closed: true,
  }, null, 2)}\n`)
}

main()
