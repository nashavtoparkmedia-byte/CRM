#!/usr/bin/env node

// Contact communication restrictions foundation boundary.
//
// The Contacts-owned standing restriction of a canonical Contact answers one
// provider-neutral question — may the company message or call this person at
// all — and nothing else. This control pins that the read contract is exactly
// the declared fail-closed shape and class list; that no provider, channel,
// transport, conversation or reachability vocabulary reaches the contract, the
// domain or the adapter; that Contact.customFields is never policy authority;
// that canonicalization is the existing lineage handler and never a second
// walk; that the mutation runs under the Contacts ownership transaction with
// the Contact's rows locked, decides replay before anything else, compares and
// sets the version and never upserts or deletes; that exactly one Contacts
// store persists the two policy models and nothing outside Contacts can reach
// the mutation path at all; that a merge composes deny-wins and records the
// evidence recovery needs; that recovery reverses a composition only when the
// append-only event chain proves nothing newer was decided, at a new version;
// that the migration carries the version-chain and append-only guards and
// cascades only with the owning Contact; and that the capability, ownership and
// migration are declared where the machinery reads them. It then runs the
// proofs that make these invariants behavioural.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const CONTRACTS = 'gravity-mvp/src/contracts/contacts/v1/contact-communication-policy-contracts.ts'
const CONTRACTS_PROOF = 'gravity-mvp/src/contracts/contacts/v1/contact-communication-policy-contracts.test.ts'
const CONTRACTS_INDEX = 'gravity-mvp/src/contracts/contacts/v1/index.ts'
const MODULE_DIR = 'gravity-mvp/src/modules/contacts/public/v1'
const DOMAIN = `${MODULE_DIR}/contact-communication-policy.ts`
const DOMAIN_PROOF = `${MODULE_DIR}/contact-communication-policy.test.ts`
const INTERNAL_DIR = 'gravity-mvp/src/modules/contacts/internal'
// The persistence bindings are internal: a Prisma-importing file under public/
// may export only object-literal adapters, and the store is a factory.
const ADAPTER = `${INTERNAL_DIR}/legacy-prisma-contact-communication-policy-adapter.ts`
const ADAPTER_PROOF = `${INTERNAL_DIR}/legacy-prisma-contact-communication-policy-adapter.test.ts`
const LINEAGE_ADAPTER = `${MODULE_DIR}/legacy-prisma-contact-lineage-adapter.ts`
const LINEAGE_PORT = `${INTERNAL_DIR}/prisma-contact-lineage-port.ts`
const MERGE_HANDLER = `${MODULE_DIR}/contact-merge-handler.ts`
const MERGE_HANDLER_PROOF = `${MODULE_DIR}/contact-merge-handler.test.ts`
const MERGE_ADAPTER = `${MODULE_DIR}/legacy-prisma-contact-merge-adapter.ts`
const MERGE_ADAPTER_PROOF = `${MODULE_DIR}/legacy-prisma-contact-merge-adapter.test.ts`
const RECOVERY_HANDLER = `${MODULE_DIR}/automated-contact-merge-recovery.ts`
const RECOVERY_ADAPTER = 'gravity-mvp/src/modules/contacts/internal/legacy-prisma-automated-merge-recovery-adapter.ts'
const RECOVERY_ADAPTER_PROOF = 'gravity-mvp/src/modules/contacts/internal/legacy-prisma-automated-merge-recovery-adapter.test.ts'
const POSTGRES_PROOF = 'gravity-mvp/src/modules/contacts/internal/contact-communication-policy.postgres.test.ts'
const OPERATIONS = 'gravity-mvp/src/modules/contacts/application/contact-operations.ts'
const PUBLIC_INDEX = `${MODULE_DIR}/index.ts`
const MIGRATION = 'gravity-mvp/prisma/migrations/20261007180000_add_contact_communication_policy_foundation/migration.sql'
const SCHEMA = 'gravity-mvp/prisma/schema.prisma'
const MANIFEST = 'architecture/contexts/v1/manifests/contacts.json'
const REGISTRY = 'architecture/contracts/v1/registry.json'
const AMENDMENT = 'architecture/isolation/contacts/communication-policy-foundation-v1/module-manifest-amendments.json'
const POLICY = 'architecture/enforcement/v1/policy.json'
const PENDING = 'architecture/migrations/v1/pending-source-migrations.json'
// Held with the sources: every tracked non-test file under gravity-mvp/src that
// names a policy delegate, and every one outside Contacts that names the mutation path.
const DELEGATE_WRITERS = '<git-grep:policy delegates in non-test source>'
const MUTATION_CONSUMERS = '<git-grep:mutation path outside Contacts>'

const QUERY_FIELDS = ['contract', 'contactId', 'communicationClass']
const COMMAND_FIELDS = ['contract', 'requestId', 'contactId', 'expectedVersion', 'restriction', 'actor', 'reason']
const RESTRICTION_FLAGS = ['denyAll', 'denyMessage', 'denyVoice']
const CLASSES = ['message', 'voice']
const REASONS = [
  'no_restriction', 'restricted_all', 'restricted_message', 'restricted_voice', 'contact_unknown',
  'contact_archived', 'unsupported_communication_class', 'lineage_unsafe', 'policy_unavailable',
]
const EVENT_FIELDS = [
  'contactId', 'cause', 'version', 'previousVersion', 'before', 'after', 'actor', 'reason',
  'mutationRequestId', 'requestDigest', 'mergeId', 'sourceContactId',
]
const CAUSES = ['mutation', 'merge', 'merge_recovery']
const MIGRATION_NAME = '20261007180000_add_contact_communication_policy_foundation'
const MODELS = ['ContactCommunicationPolicy', 'ContactCommunicationPolicyEvent']
// Vocabulary that would turn a standing restriction into a channel, provider,
// transport, conversation or reachability claim, or make customFields its authority.
const FORBIDDEN_VOCABULARY = [
  'providerAccountId', 'ProviderAccount', 'Transport', 'ConversationRoute', 'ChannelIdentity', 'externalId',
  'reachability', 'Reachability', 'chatId', 'conversationId', 'telegram', 'whatsapp', 'maxChannel', 'customFields',
  'sendMessage', 'placeCall', 'deliverable', 'sendable',
]
const FOREIGN_IMPORTS = [
  '@/modules/messaging', '@/modules/telegram-channel', '@/modules/whatsapp-channel', '@/modules/max-channel',
  '@/modules/calling', '@/modules/fleet-operations', '@/modules/work-management', '@/modules/platform-shell',
  'app/messages', 'communication-orchestration',
]
const MUTATION_PATH_NAMES = [
  'setContactCommunicationPolicyV1', 'createSetContactCommunicationPolicyHandlerV1',
  'legacyPrismaContactCommunicationPolicyMutationPortV1', 'ContactCommunicationPolicyMutationPortV1',
  'ContactCommunicationPolicyLockedScopeV1', 'SET_CONTACT_COMMUNICATION_POLICY_COMMAND_V1',
  'SetContactCommunicationPolicyCommand', 'makePrismaContactCommunicationPolicyStoreV1',
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

function sqlWithoutComments(source) {
  return source.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n')
}

/** The body of one exported object type, by name. */
function typeBlock(source, name) {
  const start = source.indexOf(`export type ${name} = {`)
  assert(start >= 0, `${name} is not an exported object type`)
  const end = source.indexOf('\n}', start)
  assert(end > start, `${name} has no closing brace`)
  return source.slice(start, end)
}

function declaredFields(block) {
  return [...block.matchAll(/^ {2}(?:\/\*\*[^\n]*\*\/\n {2})?([a-zA-Z]+)[?]?:/gmu)].map((match) => match[1])
}

function stringList(source, constantName) {
  const start = source.indexOf(`export const ${constantName} = [`)
  assert(start >= 0, `${constantName} is not an exported array`)
  const end = source.indexOf(']', start)
  return [...source.slice(start, end).matchAll(/'([a-z_]+)'/gu)].map((match) => match[1])
}

function indexOfAll(source, needle) {
  const indexes = []
  for (let cursor = source.indexOf(needle); cursor >= 0; cursor = source.indexOf(needle, cursor + 1)) indexes.push(cursor)
  return indexes
}

/** 1. The contracts are exactly the declared provider-neutral shapes. */
function assertContractShape(sources) {
  const contracts = sources[CONTRACTS]
  assert.deepEqual(declaredFields(typeBlock(contracts, 'ContactCommunicationPermissionQueryV1')), QUERY_FIELDS,
    'the query is not the declared field set')
  assert.deepEqual(declaredFields(typeBlock(contracts, 'SetContactCommunicationPolicyCommandV1')), COMMAND_FIELDS,
    'the command is not the declared field set')
  assert.deepEqual(declaredFields(typeBlock(contracts, 'ContactCommunicationRestrictionStateV1')), RESTRICTION_FLAGS,
    'the restriction state is not exactly the three V1 flags')
  assert.deepEqual(stringList(contracts, 'CONTACT_COMMUNICATION_CLASSES_V1'), CLASSES, 'the effect classes are not exactly message and voice')
  const reasons = [...contracts.slice(contracts.indexOf('export type ContactCommunicationPermissionReasonV1'), contracts.indexOf('export type ContactCommunicationPermissionResultV1'))
    .matchAll(/'([a-z_]+)'/gu)].map((match) => match[1])
  assert.deepEqual(reasons, REASONS, 'the deny/allow reason vocabulary changed')
  const result = typeBlock(contracts, 'ContactCommunicationPermissionResultV1')
  assert(result.includes("decision: 'allow' | 'deny'") && result.includes('retryable: boolean'), 'the result lost its decision or retryable field')
  assert(result.includes('canonicalContactId: string | null') && result.includes('policyVersion: number | null'),
    'the result lost its canonical Contact or version evidence')
  // The parsers refuse any field they do not declare: no override, bypass, force or channel can be smuggled.
  const code = withoutComments(contracts)
  assert(code.includes('function exactFields('), 'the contracts do not enforce an exact field set')
  assert.equal(code.match(/exactFields\(value, \[/gu)?.length, 3, 'not every contract object is checked for an exact field set')
  assert(!/override|bypass|force\b/u.test(code), 'the contracts admit an override vocabulary')
}

/** 2. No channel, provider, transport, conversation, reachability or customFields vocabulary. */
function assertNoForeignVocabulary(sources) {
  for (const relative of [CONTRACTS, DOMAIN, ADAPTER]) {
    const code = withoutComments(sources[relative])
    for (const forbidden of FORBIDDEN_VOCABULARY) {
      assert(!code.includes(forbidden), `${relative} carries ${forbidden}`)
    }
  }
}

/** 3. Canonicalization is the existing lineage handler, never a second walk. */
function assertLineageReuse(sources) {
  const domain = withoutComments(sources[DOMAIN])
  assert(domain.includes("from './contact-lineage-handler'"), 'the domain does not depend on the lineage handler contract')
  assert(!domain.includes('mergedIntoContactId'), 'the domain walks merge redirects itself')
  const adapter = withoutComments(sources[ADAPTER])
  assert(adapter.includes('createResolveContactLineageHandlerV1(makePrismaContactLineagePortV1(tx))'),
    'the adapter does not bind the existing lineage handler to its transaction client')
  assert.equal(adapter.match(/createResolveContactLineageHandlerV1\(makePrismaContactLineagePortV1\(tx\)\)/gu)?.length, 2,
    'the read and the mutation do not both use the existing lineage handler')
  assert(!adapter.includes('mergedIntoContactId'), 'the adapter walks merge redirects itself')
  // The transaction-bound port reads exactly what the public lineage port
  // reads: the same redirect field through the same accessor, the same merge
  // edge query. Two bindings of one resolver, never two resolvers.
  const port = withoutComments(sources[LINEAGE_PORT])
  const publicPort = withoutComments(sources[LINEAGE_ADAPTER])
  assert(port.includes('export function makePrismaContactLineagePortV1('), 'the transaction-bound lineage port factory is missing')
  assert(publicPort.includes('export const legacyPrismaContactLineagePortV1: ContactLineagePersistencePortV1 = {'),
    'the public lineage port is no longer the object-literal binding')
  for (const binding of [
    'select: { id: true, customFields: true },',
    'mergedIntoContactId: contactAutomationState(contact.customFields).mergedIntoContactId',
    "where: { survivorId, action: 'merge' },",
    'select: { mergedId: true },',
    "orderBy: { id: 'asc' },",
  ]) {
    assert(port.includes(binding) && publicPort.includes(binding), `the two lineage port bindings diverge on: ${binding}`)
  }
  assert(!port.includes('@/lib/prisma'), 'the transaction-bound lineage port binds the shared client itself')
}

/** 4. The permission read fails closed in every branch and allows exactly once. */
function assertFailClosedRead(sources) {
  const domain = withoutComments(sources[DOMAIN])
  const handler = domain.slice(domain.indexOf('export function createContactCommunicationPermissionQueryHandlerV1'), domain.indexOf('export type ContactCommunicationPolicyMutationEventV1'))
  const unsupported = handler.indexOf("deny('unsupported_communication_class', false)")
  const read = handler.indexOf('await port.readPermissionState(parsed.contactId)')
  assert(unsupported >= 0 && read > unsupported, 'an unsupported class is not refused before the store is read')
  assert(/catch \(error\) \{\s*return deny\(isLineageUnsafeError\(error\) \? 'lineage_unsafe' : 'policy_unavailable', true\)/u.test(handler),
    'a failed store or lineage read is not a retryable deny')
  assert(handler.includes("if (state.kind === 'unknown') return deny('contact_unknown', false)"), 'an unknown Contact is not a non-retryable deny')
  assert(handler.includes("if (state.isArchived) return deny('contact_archived', false"), 'an archived canonical Contact is not denied')
  assert(handler.includes('if (verdict.restricted) return deny(verdict.reason, false'), 'a restriction is not a non-retryable deny')
  assert.equal(handler.match(/decision: 'allow'/gu)?.length, 1, 'the read has more than one allow path')
  const evaluate = domain.slice(domain.indexOf('export function evaluateContactCommunicationRestrictionV1'), domain.indexOf('export function composeContactCommunicationPolicyV1'))
  assert(evaluate.indexOf("if (state === null) return { restricted: false") < evaluate.indexOf("if (state.denyAll === true) return { restricted: true, reason: 'restricted_all' }"),
    'denyAll does not win before the class flags')
  assert(evaluate.indexOf("reason: 'restricted_all'") < evaluate.indexOf("reason: 'restricted_message'"), 'the class flags are consulted before denyAll')
}

/** 5. The mutation decides replay first, then lineage, then version, then writes exactly once. */
function assertMutationOrder(sources) {
  const domain = withoutComments(sources[DOMAIN])
  const handler = domain.slice(domain.indexOf('export function createSetContactCommunicationPolicyHandlerV1'))
  const order = [
    'scope.findMutationEvent(parsed.requestId)',
    "status: 'replayed'",
    "status: 'idempotency_conflict'",
    'scope.resolveLineage(parsed.contactId)',
    "status: 'contact_not_canonical'",
    'scope.readContact(parsed.contactId)',
    "reason: 'archived_without_redirect'",
    'scope.readPolicy(parsed.contactId)',
    "status: 'version_conflict'",
    'scope.writePolicy({',
    'scope.appendEvent({',
    "status: 'applied'",
  ].map((needle) => {
    const index = handler.indexOf(needle)
    assert(index >= 0, `the mutation lost its step: ${needle}`)
    return index
  })
  for (let step = 1; step < order.length; step += 1) assert(order[step] > order[step - 1], `the mutation decision order changed at step ${step}`)
  assert(handler.includes('previousRequest.requestDigest === digest && previousRequest.contactId === parsed.contactId'),
    'a replay is not decided on the exact request semantics')
  assert(handler.includes('if (parsed.expectedVersion !== currentVersion)'), 'a stale expected version is not refused')
  assert(handler.includes('const version = currentVersion + 1'), 'the version does not advance by exactly one')
  assert.equal(handler.match(/scope\.writePolicy\(/gu)?.length, 1, 'the mutation writes the policy more than once')
  assert.equal(handler.match(/scope\.appendEvent\(/gu)?.length, 1, 'the mutation records more or fewer than one event')
  const digest = domain.slice(domain.indexOf('export function contactCommunicationPolicyRequestDigestV1'), domain.indexOf('export function contactCommunicationPolicyActorV1'))
  for (const field of ['actor: command.actor', 'contactId: command.contactId', 'expectedVersion: command.expectedVersion', 'reason: command.reason', 'denyAll:', 'denyMessage:', 'denyVoice:']) {
    assert(digest.includes(field), `the request digest ignores ${field}`)
  }
  assert(digest.includes("createHash('sha256')"), 'the request digest is not a sha256')
}

/** 6. The mutation runs under the Contacts ownership transaction and compares-and-sets. */
function assertMutationUnderOwnership(sources) {
  const adapter = withoutComments(sources[ADAPTER])
  assert(/import \{[^}]*runContactOwnershipTransaction[^}]*\} from '\.\/contact-ownership-coordinator'/u.test(adapter)
    && /import \{[^}]*lockContactOwnershipRows[^}]*\} from '\.\/contact-ownership-coordinator'/u.test(adapter),
    'the adapter does not use the Contacts ownership coordinator')
  const port = adapter.slice(adapter.indexOf('export const legacyPrismaContactCommunicationPolicyMutationPortV1'))
  const run = port.indexOf('runContactOwnershipTransaction(async tx => {')
  const lock = port.indexOf('await lockContactOwnershipRows(tx, { contactIds: [contactId] })')
  const work = port.indexOf('return work(scope)')
  assert(run >= 0 && lock > run && work > lock, 'the mutation does not lock the Contact ownership rows before working')
  const store = adapter.slice(adapter.indexOf('export function makePrismaContactCommunicationPolicyStoreV1'), adapter.indexOf('export function makePrismaContactCommunicationPolicyReadPortV1'))
  assert(store.includes('where: { contactId: input.contactId, version: input.expectedVersion }'), 'the policy update is not a compare-and-set on the version')
  assert(store.includes('if (updated.count !== 1)'), 'a compare-and-set that missed is not refused')
  assert(store.includes('if (input.expectedVersion === 0)') && store.includes('version: 1,'), 'the first version is not created at 1')
  assert(!/upsert\(/u.test(adapter), 'the adapter upserts the policy row')
  assert(!/\.delete(?:Many)?\(/u.test(adapter), 'the adapter deletes policy state')
  // Every write is on a receiver the architecture scanner attributes.
  for (const write of adapter.matchAll(/([A-Za-z_]+)\.contactCommunicationPolicy(?:Event)?\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/gu)) {
    assert.equal(write[1], 'tx', `a policy write is on an unattributed receiver: ${write[0]}`)
  }
  assert(adapter.includes('isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead'), 'the permission read is not one repeatable-read snapshot')
  assert(/const POLICY_SELECT = \{\s*contactId: true,\s*denyAll: true,\s*denyMessage: true,\s*denyVoice: true,\s*version: true,\s*\} as const/u.test(adapter)
    && adapter.includes('select: POLICY_SELECT,'),
    'the policy read does not select an explicit column list')
}

/** 7. Exactly one Contacts store persists the two models, and nothing outside Contacts reaches the mutation path. */
function assertSingleStoreAndContainedMutation(sources) {
  const writers = sources[DELEGATE_WRITERS].split('\n').map((line) => line.trim()).filter(Boolean).sort()
  assert.deepEqual(writers, [ADAPTER], `the policy delegates are reached outside the one Contacts store: ${writers.join(', ')}`)
  const consumers = sources[MUTATION_CONSUMERS].split('\n').map((line) => line.trim()).filter(Boolean).sort()
  assert.deepEqual(consumers, [], `the Contacts mutation path is reachable outside Contacts: ${consumers.join(', ')}`)
  const index = withoutComments(sources[PUBLIC_INDEX])
  for (const name of MUTATION_PATH_NAMES) {
    assert(!index.includes(name), `the public Contacts surface exports the mutation path: ${name}`)
  }
  assert(index.includes('getContactCommunicationPermissionV1') && index.includes('createContactCommunicationPermissionQueryHandlerV1'),
    'the permission read is not exported from the Contacts public surface')
  assert(!/legacyPrisma|PortV1|AdapterV1/u.test(index.slice(index.indexOf("from './contact-communication-policy'") - 1200, index.length)
    .split('\n').filter((line) => /CommunicationPolicy|CommunicationPermission|CommunicationRestriction/u.test(line)).join('\n')),
    'the public surface re-exports a persistence binding of the policy')
  for (const relative of [MERGE_ADAPTER, RECOVERY_ADAPTER]) {
    assert(sources[relative].includes('makePrismaContactCommunicationPolicyStoreV1'), `${relative} does not go through the Contacts policy store`)
  }
}

/** 8. A merge composes deny-wins, in both full-merge paths, and records the evidence. */
function assertMergeDenyWins(sources) {
  const domain = withoutComments(sources[DOMAIN])
  const compose = domain.slice(domain.indexOf('export function composeContactCommunicationPolicyV1'), domain.indexOf('export function contactCommunicationPolicyRequestDigestV1'))
  assert(compose.includes('if (source === null && survivor === null) return null'), 'a merge of two unrestricted Contacts would write a row')
  for (const flag of RESTRICTION_FLAGS) {
    assert(compose.includes(`${flag}: source?.${flag} === true || survivor?.${flag} === true`), `the composition is not deny-wins for ${flag}`)
  }
  const handler = withoutComments(sources[MERGE_HANDLER])
  const compositions = indexOfAll(handler, 'await contacts.composeCommunicationPolicy(loser.id, winner.id, {')
  assert.equal(compositions.length, 2, 'the merge does not compose the policy in both full-merge paths')
  const states = indexOfAll(handler, 'await contacts.composeContactState(loser.id, winner.id, identityRemaps)')
  const records = indexOfAll(handler, 'await contacts.recordMerge({')
  assert.equal(states.length, 2, 'the merge paths changed shape')
  for (const [index, at] of compositions.entries()) {
    assert(at > states[index] && at < records[index], `policy composition ${index} is not between state composition and the merge record`)
  }
  assert.equal(handler.match(/mergeId: plannedMergeRecordId,/gu)?.length, 2, 'the merge event does not name the planned merge record')
  assert.equal(handler.match(/id: plannedMergeRecordId,/gu)?.length, 2, 'the merge record is not written under the planned id')
  assert.equal(handler.match(/\n\s+communicationPolicy,\n/gu)?.length, 2, 'the merge record does not carry the policy evidence')
  assert(handler.includes('contactCommunicationPolicyActorV1(parsed.mergedBy, CONTACT_COMMUNICATION_MERGE_ACTOR_FALLBACK_V1)'),
    'the merge actor is not bounded before it reaches the event store')
  const adapter = withoutComments(sources[MERGE_ADAPTER])
  const composeMethod = adapter.slice(adapter.indexOf('async composeCommunicationPolicy('), adapter.indexOf('async recordMerge('))
  assert(composeMethod.includes('composeContactCommunicationPolicyV1(sourceBefore, survivorBefore)'), 'the merge adapter does not use the deny-wins composition')
  assert(composeMethod.includes('contactId: targetContactId,') && !composeMethod.includes('contactId: sourceContactId'),
    'the merge adapter writes the merged-away Contact row')
  assert(composeMethod.includes("cause: 'merge',") && composeMethod.includes('reason: `contact_merge:${input.mergeId}`'), 'the merge event is not recorded as a merge')
  assert(composeMethod.includes('return { sourceBefore, survivorBefore, composed: { ...composedState, version } }'), 'the merge evidence is incomplete')
  assert(adapter.includes('communicationPolicy: input.communicationPolicy,'), 'the merge record does not persist the policy evidence')
}

/** 9. Recovery reverses the composition only when the event chain proves it is still current, at a new version. */
function assertRecoveryReversible(sources) {
  const domain = withoutComments(sources[DOMAIN])
  const decide = domain.slice(domain.indexOf('export function decideContactCommunicationPolicyRecoveryV1'), domain.indexOf('export type ContactCommunicationPermissionStateV1'))
  for (const needle of [
    "if (input.evidence.kind === 'malformed') return blocked('communication_policy_evidence_invalid')",
    ": blocked('communication_policy_without_merge_evidence')",
    "return blocked('source_policy_changed_after_merge')",
    "if (!sameRestrictionStateV1(input.survivorCurrent, evidence.composed)) return blocked('communication_policy_changed_after_merge')",
    "if (event.cause === 'merge_recovery') {",
    "if (openMerges.length > 0 || input.survivorCurrent.version !== version) return blocked('communication_policy_changed_after_merge')",
  ]) {
    assert(decide.includes(needle), `the recovery rule lost: ${needle}`)
  }
  // A mutation event, or any cause that is not a reversed merge, falls through to a block.
  assert(/if \(event\.cause === 'merge_recovery'\) \{[\s\S]*?\}\s*return blocked\('communication_policy_changed_after_merge'\)/u.test(decide),
    'a post-merge mutation event does not block recovery')
  const adapter = withoutComments(sources[RECOVERY_ADAPTER])
  const inspect = adapter.slice(adapter.indexOf('async inspect(mergeId)'), adapter.indexOf('async restore(plan)'))
  const lastExistingBlocker = inspect.indexOf("reason: 'primary_phone_state_changed'")
  const policyDecision = inspect.indexOf('decideContactCommunicationPolicyRecoveryV1({')
  assert(lastExistingBlocker >= 0 && policyDecision > lastExistingBlocker, 'the policy decision does not come after every existing recovery blocker')
  assert(inspect.includes("return { status: 'blocked', reason: policyDecision.reason, eligibleAttempt: true }"),
    'a blocked policy decision does not route into manual reconciliation')
  assert(inspect.includes('parseContactMergeCommunicationPolicyEvidenceV1(metadata.communicationPolicy)'), 'the recorded evidence is not what recovery reads')
  const restore = adapter.slice(adapter.indexOf('async restore(plan)'), adapter.indexOf('async markManualReconciliation('))
  assert(restore.includes('const version = policyRestore.currentVersion + 1'), 'recovery does not restore at a new version')
  assert(restore.includes('expectedVersion: policyRestore.currentVersion,'), 'recovery does not compare-and-set the current version')
  assert(restore.includes("cause: 'merge_recovery',") && restore.includes('actor: CONTACT_COMMUNICATION_MERGE_RECOVERY_ACTOR_V1'),
    'recovery does not record its own event')
  const policyWrites = [...restore.matchAll(/policyStore\.(?:writePolicy|appendEvent)\(\{\s*contactId: ([a-zA-Z.]+),/gu)].map((match) => match[1])
  assert.deepEqual(policyWrites, ['plan.survivorId', 'plan.survivorId'], 'recovery writes a policy row other than the survivor\'s')
  const handler = withoutComments(sources[RECOVERY_HANDLER])
  assert(handler.indexOf('await contacts.restore(plan)') < handler.indexOf('await contacts.markRecovered({'), 'the recovery handler call order changed')
  assert(!handler.includes('communicationPolicy'), 'the recovery handler took on policy semantics that belong to the adapter')
}

/** 10. Every policy write leaves one event with before, after, version chain and cause. */
function assertEventEvidence(sources) {
  const domain = withoutComments(sources[DOMAIN])
  assert.deepEqual(declaredFields(typeBlock(sources[DOMAIN], 'ContactCommunicationPolicyEventInputV1')), EVENT_FIELDS, 'the event evidence changed shape')
  const causes = [...domain.slice(domain.indexOf('export type ContactCommunicationPolicyEventCauseV1'), domain.indexOf('export type ContactCommunicationPolicyEventInputV1'))
    .matchAll(/'([a-z_]+)'/gu)].map((match) => match[1])
  assert.deepEqual(causes, CAUSES, 'the event causes are not exactly mutation, merge and merge_recovery')
  const adapter = withoutComments(sources[ADAPTER])
  for (const column of ['beforeDenyAll', 'beforeDenyMessage', 'beforeDenyVoice', 'afterDenyAll', 'afterDenyMessage', 'afterDenyVoice', 'previousVersion', 'mutationRequestId', 'requestDigest', 'mergeId', 'sourceContactId']) {
    assert(adapter.includes(`${column}:`), `the event store drops ${column}`)
  }
}

/** 11. The migration carries the invariants the adapters depend on and cascades only with the Contact. */
function assertMigrationContract(sources) {
  const sql = sqlWithoutComments(sources[MIGRATION])
  assert(/(?:^|\n)BEGIN;\n/u.test(sql) && sql.trim().endsWith('COMMIT;'), 'the migration is not one explicit transaction')
  const touched = [...sql.matchAll(/(?:CREATE TABLE|ALTER TABLE)\s+"([A-Za-z]+)"/gu)].map((match) => match[1])
  assert.deepEqual([...new Set(touched)].sort(), MODELS, 'the migration touches a table other than the two policy tables')
  const referenced = [...sql.matchAll(/REFERENCES\s+"([A-Za-z]+)"/gu)].map((match) => match[1])
  assert.deepEqual([...new Set(referenced)], ['Contact'], 'the policy relates to something other than the Contact')
  assert.equal(sql.match(/REFERENCES "Contact"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/gu)?.length, 2, 'the policy rows do not cascade with the owning Contact')
  for (const [label, pattern] of [
    ['event cause vocabulary', /"cause" IN \('mutation', 'merge', 'merge_recovery'\)/u],
    ['gapless version chain', /\("previousVersion" IS NULL AND "version" = 1\)\s*OR \("previousVersion" IS NOT NULL AND "previousVersion" = "version" - 1\)/u],
    ['before-state exactly with a predecessor', /\("previousVersion" IS NULL\) = \("beforeDenyAll" IS NULL\)/u],
    ['mutation carries its request identity', /\("mutationRequestId" IS NOT NULL\) = \("cause" = 'mutation'\)/u],
    ['merge carries its merge identity', /\("mergeId" IS NOT NULL\) = \("cause" <> 'mutation'\)/u],
    ['version starts at one', /ContactCommunicationPolicy starts at version 1/u],
    ['version advances by exactly one', /version must advance by exactly one per write/u],
    ['identity immutable', /ContactCommunicationPolicy identity is immutable/u],
    ['no direct delete of a restriction', /ContactCommunicationPolicy rows cannot be deleted directly/u],
    ['events cannot be updated', /append-only evidence and cannot be updated/u],
    ['events cannot be deleted directly', /append-only evidence and cannot be deleted directly/u],
    ['cascade exemption', /pg_trigger_depth\(\) <= 1/u],
    ['schema-pinned guards', /SET search_path FROM CURRENT/u],
    ['unique request id', /CREATE UNIQUE INDEX "ContactCommunicationPolicyEvent_mutationRequestId_key"/u],
    ['unique version per contact', /CREATE UNIQUE INDEX "ContactCommunicationPolicyEvent_contactId_version_key"/u],
  ]) {
    assert.match(sql, pattern, `the migration no longer carries: ${label}`)
  }
  assert.equal(sql.match(/pg_trigger_depth\(\) <= 1/gu)?.length, 2, 'both tables do not refuse a direct delete')
  assert(!/BEFORE TRUNCATE/u.test(sql), 'a TRUNCATE guard would break TRUNCATE "Contact" CASCADE')
  assert(!/^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\s/mu.test(sql), 'the foundation migration carries a data statement')
  assert(!/(?:^|\n)ALTER TABLE "Contact"\b/u.test(sql), 'the migration alters the Contact table')
  const schema = sources[SCHEMA]
  for (const model of MODELS) {
    const start = schema.indexOf(`model ${model} {`)
    assert(start >= 0, `the ${model} model is missing from the schema`)
    const block = schema.slice(start, schema.indexOf('\n}\n', start))
    assert(block.includes('@relation(fields: [contactId], references: [id], onDelete: Cascade)'), `${model} does not cascade with the Contact`)
    assert(!/\bContactIdentity\b|\bContactPhone\b|\bChat\b|\bDriver\b|\bMessage\b|\bProviderAccount\b|\bTransport\b/u.test(block),
      `${model} relates to something other than the Contact`)
  }
  assert(schema.includes('communicationPolicy       ContactCommunicationPolicy?'), 'the Contact lost its policy relation')
}

/** 12. The capability, ownership and migration are declared where the machinery reads them. */
function assertGovernanceDeclared(sources) {
  const manifest = JSON.parse(sources[MANIFEST])
  assert(manifest.public_surface.includes('ContactCommunicationPermissionQuery.v1'), 'ContactCommunicationPermissionQuery.v1 is not declared')
  assert(!manifest.commands.some((command) => /CommunicationPolicy/u.test(command)), 'the mutation is declared as a cross-context command')
  assert(manifest.verification.module_tests.includes('node tools/architecture/check-contact-communication-policy-boundary.mjs'),
    'the control is not a declared module test')
  assert.deepEqual(manifest.allowed_dependencies.map((entry) => entry.context).sort(), ['identity_access'], 'Contacts gained a dependency')
  const registry = JSON.parse(sources[REGISTRY])
  const surface = registry.context_surfaces.find((entry) => entry.owner_context === 'contacts')
  assert(surface?.capabilities.includes('ContactCommunicationPermissionQuery.v1'), 'the registry does not list the read capability')
  assert(!surface.commands.some((command) => /CommunicationPolicy/u.test(command)), 'the registry lists the mutation as a command')
  const amendment = JSON.parse(sources[AMENDMENT])
  const owned = amendment.amendments.find((entry) => entry.context === 'contacts')?.add_owned_infrastructure_state ?? []
  assert.deepEqual([...owned].sort(), MODELS.map((model) => `gravity-mvp/prisma/schema.prisma:${model}`),
    'the two policy models are not declared as Contacts-owned state')
  assert(JSON.parse(sources[POLICY]).manifest_amendments.includes(AMENDMENT), 'the ownership amendment is not registered in the enforcement policy')
  const pending = JSON.parse(sources[PENDING])
  const row = pending.migrations.find((entry) => entry.name === MIGRATION_NAME)
  assert(row, 'the foundation migration is not a registered pending source migration')
  assert.equal(row.owner_context, 'contacts', 'the migration is not owned by Contacts')
  assert.deepEqual([...row.creates.tables].sort(), MODELS, 'the migration row does not declare exactly the two tables')
  assert.equal(row.migration_test, POSTGRES_PROOF, 'the migration row does not name the isolated PostgreSQL proof')
  assert(pending.authorized_owner_contexts.includes('contacts'), 'Contacts is not an authorized migration owner')
  const operations = withoutComments(sources[OPERATIONS])
  assert(operations.includes('createContactCommunicationPermissionQueryHandlerV1(legacyPrismaContactCommunicationPolicyReadPortV1)'),
    'the permission read is not wired to its Contacts adapter')
  assert(operations.includes('createSetContactCommunicationPolicyHandlerV1(legacyPrismaContactCommunicationPolicyMutationPortV1)'),
    'the mutation is not wired to its locked Contacts adapter')
  assert(sources[CONTRACTS_INDEX].includes("export * from './contact-communication-policy-contracts'"), 'the contracts are not exported')
}

/** 13. No Messaging, Calling, Orchestration or other foreign domain anywhere in the slice. */
function assertNoForeignDependency(sources) {
  for (const relative of [CONTRACTS, DOMAIN, ADAPTER, POSTGRES_PROOF]) {
    const source = sources[relative]
    for (const forbidden of FOREIGN_IMPORTS) {
      assert(!source.includes(forbidden), `${relative} imports ${forbidden}`)
    }
    assert(!/fetch\(|axios|http\./u.test(source), `${relative} performs a network call`)
  }
}

const CHECKS = [
  ['contract_shape', assertContractShape],
  ['no_foreign_vocabulary', assertNoForeignVocabulary],
  ['lineage_reuse', assertLineageReuse],
  ['fail_closed_read', assertFailClosedRead],
  ['mutation_order', assertMutationOrder],
  ['mutation_under_ownership', assertMutationUnderOwnership],
  ['single_store_contained_mutation', assertSingleStoreAndContainedMutation],
  ['merge_deny_wins', assertMergeDenyWins],
  ['recovery_reversible', assertRecoveryReversible],
  ['event_evidence', assertEventEvidence],
  ['migration_contract', assertMigrationContract],
  ['governance_declared', assertGovernanceDeclared],
  ['no_foreign_dependency', assertNoForeignDependency],
]

const PROBES = [
  ['query_gains_channel', 'contract_shape', (s) => ({ ...s, [CONTRACTS]: s[CONTRACTS].replace('  communicationClass: string\n}', '  communicationClass: string\n  channel: string\n}') })],
  ['command_gains_override', 'contract_shape', (s) => ({ ...s, [CONTRACTS]: s[CONTRACTS].replace('  reason: string\n}\n\nexport type SetContactCommunicationPolicyResultV1', '  reason: string\n  override: boolean\n}\n\nexport type SetContactCommunicationPolicyResultV1') })],
  ['classes_gain_provider', 'contract_shape', (s) => ({ ...s, [CONTRACTS]: s[CONTRACTS].replace("['message', 'voice'] as const", "['message', 'voice', 'telegram'] as const") })],
  ['restriction_gains_channel_flag', 'contract_shape', (s) => ({ ...s, [CONTRACTS]: s[CONTRACTS].replace('  denyVoice: boolean\n}', '  denyVoice: boolean\n  denyTelegram: boolean\n}') })],
  ['parser_ignores_extra_fields', 'contract_shape', (s) => ({ ...s, [CONTRACTS]: s[CONTRACTS].replace("exactFields(value, ['contract', 'requestId', 'contactId', 'expectedVersion', 'restriction', 'actor', 'reason'], 'command')", '') })],
  ['domain_reads_custom_fields', 'no_foreign_vocabulary', (s) => ({ ...s, [DOMAIN]: s[DOMAIN].replace('export const CONTACT_COMMUNICATION_NO_RESTRICTION_V1', 'const legacy = (contact) => contact.customFields.denyAll\n\nexport const CONTACT_COMMUNICATION_NO_RESTRICTION_V1') })],
  ['adapter_selects_external_id', 'no_foreign_vocabulary', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('  version: true,\n} as const', '  version: true,\n  externalId: true,\n} as const') })],
  ['domain_walks_redirects', 'lineage_reuse', (s) => ({ ...s, [DOMAIN]: s[DOMAIN].replace('export const CONTACT_COMMUNICATION_NO_RESTRICTION_V1', 'const redirect = (fields) => fields.mergedIntoContactId\n\nexport const CONTACT_COMMUNICATION_NO_RESTRICTION_V1') })],
  ['adapter_drops_lineage_handler', 'lineage_reuse', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('resolveLineage: createResolveContactLineageHandlerV1(makePrismaContactLineagePortV1(tx)),', 'resolveLineage: async (id) => ({ requestedContactId: id, canonicalContactId: id, contactIds: [id] }),') })],
  ['lineage_port_bindings_diverge', 'lineage_reuse', (s) => ({ ...s, [LINEAGE_PORT]: s[LINEAGE_PORT].replace('select: { id: true, customFields: true },', 'select: { id: true, customFields: true, isArchived: true },') })],
  ['lineage_port_reads_redirect_differently', 'lineage_reuse', (s) => ({ ...s, [LINEAGE_PORT]: s[LINEAGE_PORT].replace("where: { survivorId, action: 'merge' },", 'where: { survivorId },') })],
  ['unsupported_class_reaches_store', 'fail_closed_read', (s) => {
    const refusal = "    if (!isContactCommunicationClassV1(parsed.communicationClass)) {\n      return deny('unsupported_communication_class', false)\n    }\n"
    const source = s[DOMAIN].replace(refusal, '')
    return { ...s, [DOMAIN]: source.replace("    if (state.kind === 'unknown') return deny('contact_unknown', false)", `${refusal}    if (state.kind === 'unknown') return deny('contact_unknown', false)`) }
  }],
  ['store_failure_allows', 'fail_closed_read', (s) => ({ ...s, [DOMAIN]: s[DOMAIN].replace("return deny(isLineageUnsafeError(error) ? 'lineage_unsafe' : 'policy_unavailable', true)", "return { ...base, decision: 'allow', retryable: false, reason: 'no_restriction', canonicalContactId: null, policyVersion: null }") })],
  ['unknown_contact_allows', 'fail_closed_read', (s) => ({ ...s, [DOMAIN]: s[DOMAIN].replace("if (state.kind === 'unknown') return deny('contact_unknown', false)", "if (state.kind === 'unknown') return { ...base, decision: 'allow', retryable: false, reason: 'no_restriction', canonicalContactId: null, policyVersion: null }") })],
  ['archived_contact_allowed', 'fail_closed_read', (s) => ({ ...s, [DOMAIN]: s[DOMAIN].replace("if (state.isArchived) return deny('contact_archived', false, state.canonicalContactId, policyVersion)\n", '') })],
  ['class_flag_before_deny_all', 'fail_closed_read', (s) => ({ ...s, [DOMAIN]: s[DOMAIN].replace("  if (state.denyAll === true) return { restricted: true, reason: 'restricted_all' }\n  if (communicationClass === 'message' && state.denyMessage === true) return { restricted: true, reason: 'restricted_message' }", "  if (communicationClass === 'message' && state.denyMessage === true) return { restricted: true, reason: 'restricted_message' }\n  if (state.denyAll === true) return { restricted: true, reason: 'restricted_all' }") })],
  ['replay_after_lineage', 'mutation_order', (s) => {
    const source = s[DOMAIN]
    const replayStart = source.indexOf('      const previousRequest = await scope.findMutationEvent(parsed.requestId)')
    const replayEnd = source.indexOf('      let lineage: ContactLineageV1 | null', replayStart)
    const replay = source.slice(replayStart, replayEnd)
    const withoutReplay = source.slice(0, replayStart) + source.slice(replayEnd)
    return { ...s, [DOMAIN]: withoutReplay.replace('      const current = await scope.readPolicy(parsed.contactId)', `${replay}      const current = await scope.readPolicy(parsed.contactId)`) }
  }],
  ['version_check_removed', 'mutation_order', (s) => ({ ...s, [DOMAIN]: s[DOMAIN].replace('if (parsed.expectedVersion !== currentVersion) {', 'if (false) {') })],
  ['digest_ignores_actor', 'mutation_order', (s) => ({ ...s, [DOMAIN]: s[DOMAIN].replace('    actor: command.actor,\n    contactId: command.contactId,', '    contactId: command.contactId,') })],
  ['replay_ignores_contact', 'mutation_order', (s) => ({ ...s, [DOMAIN]: s[DOMAIN].replace('previousRequest.requestDigest === digest && previousRequest.contactId === parsed.contactId', 'previousRequest.requestDigest === digest') })],
  ['mutation_outside_lock', 'mutation_under_ownership', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('      await lockContactOwnershipRows(tx, { contactIds: [contactId] })\n', '') })],
  ['policy_upserted', 'mutation_under_ownership', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('const updated = await tx.contactCommunicationPolicy.updateMany({', 'await tx.contactCommunicationPolicy.upsert({ where: { contactId: input.contactId }, create: {}, update: {} })\n      const updated = await tx.contactCommunicationPolicy.updateMany({') })],
  ['cas_miss_ignored', 'mutation_under_ownership', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('if (updated.count !== 1) {', 'if (false) {') })],
  ['cas_without_version', 'mutation_under_ownership', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('where: { contactId: input.contactId, version: input.expectedVersion },', 'where: { contactId: input.contactId },') })],
  ['policy_row_deleted', 'mutation_under_ownership', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('    async readPolicy(contactId) {', '    async clear(contactId) { await tx.contactCommunicationPolicy.delete({ where: { contactId } }) },\n    async readPolicy(contactId) {') })],
  ['write_on_unattributed_receiver', 'mutation_under_ownership', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('await tx.contactCommunicationPolicyEvent.create({', 'await (tx as never as { client: typeof tx }).client.contactCommunicationPolicyEvent.create({').replace('export function makePrismaContactCommunicationPolicyStoreV1(tx', 'export function makePrismaContactCommunicationPolicyStoreV1(client') .replace('const updated = await tx.contactCommunicationPolicy.updateMany({', 'const updated = await client.contactCommunicationPolicy.updateMany({') })],
  ['read_not_snapshot', 'mutation_under_ownership', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace(', { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })', ')') })],
  ['second_writer_appears', 'single_store_contained_mutation', (s) => ({ ...s, [DELEGATE_WRITERS]: `${s[DELEGATE_WRITERS]}gravity-mvp/src/modules/messaging/internal/policy-shortcut.ts\n` })],
  ['mutation_imported_by_messaging', 'single_store_contained_mutation', (s) => ({ ...s, [MUTATION_CONSUMERS]: 'gravity-mvp/src/modules/messaging/application/messaging-operations.ts\n' })],
  ['mutation_exported_publicly', 'single_store_contained_mutation', (s) => ({ ...s, [PUBLIC_INDEX]: `${s[PUBLIC_INDEX]}\nexport { setContactCommunicationPolicyV1 } from '../../application/contact-operations'\n` })],
  ['mutation_factory_exported_publicly', 'single_store_contained_mutation', (s) => ({ ...s, [PUBLIC_INDEX]: s[PUBLIC_INDEX].replace('    createContactCommunicationPermissionQueryHandlerV1,\n', '    createContactCommunicationPermissionQueryHandlerV1,\n    createSetContactCommunicationPolicyHandlerV1,\n') })],
  ['merge_adapter_bypasses_store', 'single_store_contained_mutation', (s) => ({ ...s, [MERGE_ADAPTER]: s[MERGE_ADAPTER].replaceAll('makePrismaContactCommunicationPolicyStoreV1', 'makeLocalStore') })],
  ['composition_is_and', 'merge_deny_wins', (s) => ({ ...s, [DOMAIN]: s[DOMAIN].replace('denyAll: source?.denyAll === true || survivor?.denyAll === true,', 'denyAll: source?.denyAll === true && survivor?.denyAll === true,') })],
  ['composition_prefers_survivor', 'merge_deny_wins', (s) => ({ ...s, [DOMAIN]: s[DOMAIN].replace('denyMessage: source?.denyMessage === true || survivor?.denyMessage === true,', 'denyMessage: survivor?.denyMessage === true,') })],
  ['merge_skips_composition', 'merge_deny_wins', (s) => ({ ...s, [MERGE_HANDLER]: s[MERGE_HANDLER].replace("      const communicationPolicy = await contacts.composeCommunicationPolicy(loser.id, winner.id, {\n        mergeId: plannedMergeRecordId,\n        actor: contactCommunicationPolicyActorV1(parsed.mergedBy, CONTACT_COMMUNICATION_MERGE_ACTOR_FALLBACK_V1),\n      })\n      const composedYandexDriverId", '      const communicationPolicy = { sourceBefore: null, survivorBefore: null, composed: null }\n      const composedYandexDriverId') })],
  ['merge_composes_after_record', 'merge_deny_wins', (s) => {
    const source = s[MERGE_HANDLER]
    const call = "      const communicationPolicy = await contacts.composeCommunicationPolicy(loser.id, winner.id, {\n        mergeId: plannedMergeRecordId,\n        actor: contactCommunicationPolicyActorV1(parsed.mergedBy, CONTACT_COMMUNICATION_MERGE_ACTOR_FALLBACK_V1),\n      })\n"
    const index = source.lastIndexOf(call)
    const moved = source.slice(0, index) + source.slice(index + call.length)
    return { ...s, [MERGE_HANDLER]: moved.replace('      await contacts.archiveContact(loser.id)\n      await contacts.setMergedRedirect(loser.id, winner.id)\n      await contacts.verifyOwnershipPostconditions()\n      log(\n        `[ContactMergeService] Contact merge', `${call}      await contacts.archiveContact(loser.id)\n      await contacts.setMergedRedirect(loser.id, winner.id)\n      await contacts.verifyOwnershipPostconditions()\n      log(\n        \`[ContactMergeService] Contact merge`) }
  }],
  ['merge_actor_unbounded', 'merge_deny_wins', (s) => ({ ...s, [MERGE_HANDLER]: s[MERGE_HANDLER].replaceAll('contactCommunicationPolicyActorV1(parsed.mergedBy, CONTACT_COMMUNICATION_MERGE_ACTOR_FALLBACK_V1)', 'parsed.mergedBy') })],
  ['merge_writes_source_row', 'merge_deny_wins', (s) => ({ ...s, [MERGE_ADAPTER]: s[MERGE_ADAPTER].replace('        await store.writePolicy({\n          contactId: targetContactId,', '        await store.writePolicy({\n          contactId: sourceContactId,') })],
  ['merge_evidence_dropped', 'merge_deny_wins', (s) => ({ ...s, [MERGE_ADAPTER]: s[MERGE_ADAPTER].replace('            communicationPolicy: input.communicationPolicy,\n', '') })],
  ['recovery_ignores_mutation_events', 'recovery_reversible', (s) => ({ ...s, [DOMAIN]: s[DOMAIN].replace("    if (event.cause === 'merge_recovery') {\n      if (event.mergeId === null || openMerges.pop() !== event.mergeId) return blocked('communication_policy_changed_after_merge')\n      continue\n    }\n    return blocked('communication_policy_changed_after_merge')", "    if (event.cause === 'merge_recovery') {\n      if (event.mergeId === null || openMerges.pop() !== event.mergeId) return blocked('communication_policy_changed_after_merge')\n      continue\n    }\n    continue") })],
  ['recovery_ignores_open_merges', 'recovery_reversible', (s) => ({ ...s, [DOMAIN]: s[DOMAIN].replace("if (openMerges.length > 0 || input.survivorCurrent.version !== version) return blocked('communication_policy_changed_after_merge')", "if (input.survivorCurrent.version !== version) return blocked('communication_policy_changed_after_merge')") })],
  ['legacy_merge_overwrites_policy', 'recovery_reversible', (s) => ({ ...s, [DOMAIN]: s[DOMAIN].replace("    return input.survivorCurrent === null\n      ? { kind: 'nothing_to_restore' }\n      : blocked('communication_policy_without_merge_evidence')", "    return { kind: 'nothing_to_restore' }") })],
  ['recovery_restores_in_place', 'recovery_reversible', (s) => ({ ...s, [RECOVERY_ADAPTER]: s[RECOVERY_ADAPTER].replace('const version = policyRestore.currentVersion + 1', 'const version = policyRestore.currentVersion') })],
  ['recovery_blocks_silently_recover', 'recovery_reversible', (s) => ({ ...s, [RECOVERY_ADAPTER]: s[RECOVERY_ADAPTER].replace("return { status: 'blocked', reason: policyDecision.reason, eligibleAttempt: true }", 'policyRestore = null') })],
  ['recovery_before_existing_blockers', 'recovery_reversible', (s) => {
    const source = s[RECOVERY_ADAPTER]
    const start = source.indexOf('      const policyStore = makePrismaContactCommunicationPolicyStoreV1(transaction)')
    const end = source.indexOf('      recoveryPlan = {', start)
    const block = source.slice(start, end)
    const removed = source.slice(0, start) + source.slice(end)
    return { ...s, [RECOVERY_ADAPTER]: removed.replace('      const sourceIdentityIds = snapshot.identities.map(identity => identity.id)', `${block}      const sourceIdentityIds = snapshot.identities.map(identity => identity.id)`) }
  }],
  ['recovery_writes_source_row', 'recovery_reversible', (s) => ({ ...s, [RECOVERY_ADAPTER]: s[RECOVERY_ADAPTER].replace('        await policyStore.writePolicy({\n          contactId: plan.survivorId,', '        await policyStore.writePolicy({\n          contactId: plan.mergedId,') })],
  ['event_loses_before_state', 'event_evidence', (s) => ({ ...s, [DOMAIN]: s[DOMAIN].replace('  before: ContactCommunicationRestrictionStateV1 | null\n  after:', '  after:') })],
  ['event_gains_fourth_cause', 'event_evidence', (s) => ({ ...s, [DOMAIN]: s[DOMAIN].replace("export type ContactCommunicationPolicyEventCauseV1 = 'mutation' | 'merge' | 'merge_recovery'", "export type ContactCommunicationPolicyEventCauseV1 = 'mutation' | 'merge' | 'merge_recovery' | 'import'") })],
  ['migration_drops_version_guard', 'migration_contract', (s) => ({ ...s, [MIGRATION]: s[MIGRATION].replace("    IF NEW.\"version\" <> OLD.\"version\" + 1 THEN\n        RAISE EXCEPTION 'ContactCommunicationPolicy version must advance by exactly one per write';\n    END IF;\n", '') })],
  ['migration_allows_event_update', 'migration_contract', (s) => ({ ...s, [MIGRATION]: s[MIGRATION].replace("        RAISE EXCEPTION 'ContactCommunicationPolicyEvent rows are append-only evidence and cannot be updated';", '        RETURN NEW;') })],
  ['migration_allows_direct_delete', 'migration_contract', (s) => ({ ...s, [MIGRATION]: s[MIGRATION].replace("        IF pg_trigger_depth() <= 1 THEN\n            RAISE EXCEPTION 'ContactCommunicationPolicy rows cannot be deleted directly';\n        END IF;\n", '') })],
  ['migration_restricts_instead_of_cascading', 'migration_contract', (s) => ({ ...s, [MIGRATION]: s[MIGRATION].replace('ALTER TABLE "ContactCommunicationPolicy" ADD CONSTRAINT "ContactCommunicationPolicy_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;', 'ALTER TABLE "ContactCommunicationPolicy" ADD CONSTRAINT "ContactCommunicationPolicy_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;') })],
  ['migration_gains_truncate_guard', 'migration_contract', (s) => ({ ...s, [MIGRATION]: s[MIGRATION].replace('\nCOMMIT;', '\nCREATE TRIGGER "x" BEFORE TRUNCATE ON "ContactCommunicationPolicy" FOR EACH STATEMENT EXECUTE FUNCTION "contact_communication_policy_guard"();\n\nCOMMIT;') })],
  ['migration_touches_contact', 'migration_contract', (s) => ({ ...s, [MIGRATION]: s[MIGRATION].replace('\nCOMMIT;', '\nALTER TABLE "Contact" ADD COLUMN "denyAll" BOOLEAN;\n\nCOMMIT;') })],
  ['migration_backfills', 'migration_contract', (s) => ({ ...s, [MIGRATION]: s[MIGRATION].replace('\nCOMMIT;', '\nINSERT INTO "ContactCommunicationPolicy" ("contactId", "version", "updatedBy") SELECT id, 1, \'backfill\' FROM "Contact";\n\nCOMMIT;') })],
  ['schema_binds_identity', 'migration_contract', (s) => ({ ...s, [SCHEMA]: s[SCHEMA].replace('  contact     Contact  @relation(fields: [contactId], references: [id], onDelete: Cascade)\n}\n\n/// Append-only', '  contact     Contact  @relation(fields: [contactId], references: [id], onDelete: Cascade)\n  identityId  String?\n  identity    ContactIdentity? @relation(fields: [identityId], references: [id])\n}\n\n/// Append-only') })],
  ['capability_undeclared', 'governance_declared', (s) => ({ ...s, [MANIFEST]: s[MANIFEST].replace('"ContactCommunicationPermissionQuery.v1"', '"ContactSomethingElse.v1"') })],
  ['mutation_declared_as_command', 'governance_declared', (s) => ({ ...s, [MANIFEST]: s[MANIFEST].replace('"commands": [\n', '"commands": [\n    "SetContactCommunicationPolicyCommand.v1",\n') })],
  ['control_undeclared', 'governance_declared', (s) => ({ ...s, [MANIFEST]: s[MANIFEST].replace('node tools/architecture/check-contact-communication-policy-boundary.mjs', 'node tools/architecture/check-something-else.mjs') })],
  ['ownership_undeclared', 'governance_declared', (s) => ({ ...s, [AMENDMENT]: s[AMENDMENT].replace('"gravity-mvp/prisma/schema.prisma:ContactCommunicationPolicyEvent"', '"gravity-mvp/prisma/schema.prisma:ContactCommunicationPolicyLog"') })],
  ['amendment_unregistered', 'governance_declared', (s) => ({ ...s, [POLICY]: s[POLICY].replace(AMENDMENT, 'architecture/isolation/contacts/missing/module-manifest-amendments.json') })],
  ['migration_unregistered', 'governance_declared', (s) => ({ ...s, [PENDING]: s[PENDING].replace(`"name": "${MIGRATION_NAME}"`, '"name": "20261007180000_add_something_else"') })],
  ['migration_owner_changed', 'governance_declared', (s) => ({ ...s, [PENDING]: s[PENDING].replace('"owner_context": "contacts",', '"owner_context": "messaging",') })],
  ['migration_proof_renamed', 'governance_declared', (s) => ({ ...s, [PENDING]: s[PENDING].replace(`"migration_test": "${POSTGRES_PROOF}"`, '"migration_test": "gravity-mvp/src/modules/contacts/internal/something-else.postgres.test.ts"') })],
  ['read_unwired', 'governance_declared', (s) => ({ ...s, [OPERATIONS]: s[OPERATIONS].replace('createContactCommunicationPermissionQueryHandlerV1(legacyPrismaContactCommunicationPolicyReadPortV1)', 'createContactCommunicationPermissionQueryHandlerV1({ readPermissionState: async () => ({ kind: \'unknown\' }) })') })],
  ['mutation_unlocked_wiring', 'governance_declared', (s) => ({ ...s, [OPERATIONS]: s[OPERATIONS].replace('createSetContactCommunicationPolicyHandlerV1(legacyPrismaContactCommunicationPolicyMutationPortV1)', 'createSetContactCommunicationPolicyHandlerV1({ runLocked: (id, work) => work({} as never) })') })],
  ['domain_imports_messaging', 'no_foreign_dependency', (s) => ({ ...s, [DOMAIN]: s[DOMAIN].replace('export const CONTACT_COMMUNICATION_NO_RESTRICTION_V1', "import { x } from '@/modules/messaging/public/v1'\n\nexport const CONTACT_COMMUNICATION_NO_RESTRICTION_V1") })],
  ['adapter_probes_provider', 'no_foreign_dependency', (s) => ({ ...s, [ADAPTER]: s[ADAPTER].replace('export const legacyPrismaContactCommunicationPolicyReadPortV1', 'const probe = () => fetch("/api/channels/check")\n\nexport const legacyPrismaContactCommunicationPolicyReadPortV1') })],
]

function gitGrep(args) {
  // git grep exits 1 when nothing matches; only a status above 1 is a failure.
  // --untracked: a file that is not yet committed is still source the control must see.
  const result = spawnSync('git', ['-c', 'safe.directory=*', 'grep', '-l', '--untracked', ...args], { cwd: root, encoding: 'utf8' })
  assert(result.status === 0 || result.status === 1, `a repository scan failed: ${result.stderr}`)
  return result.stdout
}

function main() {
  const relatives = [CONTRACTS, CONTRACTS_PROOF, CONTRACTS_INDEX, DOMAIN, DOMAIN_PROOF, ADAPTER, ADAPTER_PROOF, LINEAGE_ADAPTER, LINEAGE_PORT,
    MERGE_HANDLER, MERGE_HANDLER_PROOF, MERGE_ADAPTER, MERGE_ADAPTER_PROOF, RECOVERY_HANDLER, RECOVERY_ADAPTER, RECOVERY_ADAPTER_PROOF,
    POSTGRES_PROOF, OPERATIONS, PUBLIC_INDEX, MIGRATION, SCHEMA, MANIFEST, REGISTRY, AMENDMENT, POLICY, PENDING]
  const sources = Object.fromEntries(relatives.map((relative) => [relative, read(relative)]))
  sources[DELEGATE_WRITERS] = gitGrep(['-E', '\\.contactCommunicationPolicy(Event)?\\.', '--', 'gravity-mvp/src',
    ':(exclude)*.test.ts', ':(exclude)*.test.tsx'])
  sources[MUTATION_CONSUMERS] = gitGrep(['-E', MUTATION_PATH_NAMES.join('|'), '--', 'gravity-mvp/src',
    ':(exclude)gravity-mvp/src/modules/contacts', ':(exclude)gravity-mvp/src/contracts/contacts', ':(exclude)*.test.ts', ':(exclude)*.test.tsx'])
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
  assert.equal(passingProofCount(''), null, 'an empty summary must not be read as a passing run')

  // The proofs are what make these invariants behavioural, so this control runs
  // them rather than trusting that something else will. The isolated-PostgreSQL
  // proof runs only where an isolated database is provided; it is reported, never
  // silently counted.
  const postgresProofEnabled = process.env.YOKO_CONTACT_COMMUNICATION_POLICY_POSTGRES_PROOF === '1'
  const vitest = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'src/contracts/contacts/v1/contact-communication-policy-contracts.test.ts',
    'src/modules/contacts/public/v1/contact-communication-policy.test.ts',
    'src/modules/contacts/internal/legacy-prisma-contact-communication-policy-adapter.test.ts',
    'src/modules/contacts/public/v1/legacy-prisma-contact-merge-adapter.test.ts',
    'src/modules/contacts/internal/legacy-prisma-automated-merge-recovery-adapter.test.ts',
    'src/modules/contacts/public/v1/contact-merge-handler.test.ts',
    ...(postgresProofEnabled ? ['src/modules/contacts/internal/contact-communication-policy.postgres.test.ts'] : []),
  ], { cwd: path.join(root, 'gravity-mvp'), encoding: 'utf8' })
  assert.equal(vitest.status, 0, `the contact communication policy proofs failed:\n${vitest.stdout}\n${vitest.stderr}`)
  const passed = passingProofCount(vitest.stdout)
  assert(passed !== null && passed > 0, `the proofs reported no passing tests:\n${vitest.stdout}`)

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    control: 'contact-communication-policy-boundary',
    checks: CHECKS.length,
    negative_probes: PROBES.length,
    policy_tests: passed,
    postgres_proof: postgresProofEnabled ? 'ran' : 'skipped_not_enabled',
    communication_classes: CLASSES.length,
    restriction_flags: RESTRICTION_FLAGS.length,
    deny_reasons: REASONS.length - 1,
    policy_store_files: 1,
    mutation_consumers_outside_contacts: 0,
    mutation_exported_publicly: false,
    merge_composition: 'deny_wins',
    recovery: 'event_chain_proof_new_version',
    migration_truncate_guard: false,
  }, null, 2)}\n`)
}

main()
