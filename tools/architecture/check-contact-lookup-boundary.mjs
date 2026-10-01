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
]

function main() {
  const relatives = [LOOKUP, ADAPTER, PROOF, POLICY, POLICY_PROOF, OPERATIONS, PUBLIC_INDEX, MANIFEST,
    LEGACY_ROUTE, LEGACY_HOOK]
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

  assert.equal(passingProofCount('\n      Tests  28 passed (28)\n'), 28, 'the plain Vitest summary is no longer parsed')
  assert.equal(passingProofCount('\u001B[32m      Tests \u001B[39m 28 passed\u001B[90m (28)\u001B[39m\n'), 28,
    'an ANSI-decorated Vitest summary is not parsed')
  assert.equal(passingProofCount(''), null, 'an empty summary must not be read as a passing run')

  // The proofs are what make these invariants behavioural, so this control runs
  // them rather than trusting that something else will. The display-policy proofs
  // are included because the provider-id refusal lives there.
  const vitest = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'src/modules/contacts/public/v1/contact-lookup.test.ts',
    'src/modules/contacts/public/v1/contact-display-policy.test.ts',
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
  }, null, 2)}\n`)
}

main()
