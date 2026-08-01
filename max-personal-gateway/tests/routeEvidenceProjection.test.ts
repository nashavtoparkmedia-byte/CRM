import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_INBOUND_NORMALIZER_VERSION } from '../src/inbound/constants.ts'
import { MaxInboundNormalizer } from '../src/inbound/MaxInboundNormalizer.ts'
import { PrismaShadowInboundNormalizationProcessor } from '../src/inbound/PrismaShadowInboundNormalizationProcessor.ts'
import { PrismaRawEventJournal } from '../src/journal/PrismaRawEventJournal.ts'
import type { JsonValue, SanitizedObservationInput } from '../src/journal/types.ts'
import { PrismaRouteEvidenceProjectionProcessor } from '../src/route/PrismaRouteEvidenceProjectionProcessor.ts'
import type { RouteRegistry } from '../src/route/RouteRegistry.ts'
import type {
  ConflictPage,
  ObserveRouteEvidenceInput,
  ObserveRouteEvidenceResult,
  ResolveConflictInput,
  RetireConversationInput,
  RouteConflict,
  RouteSnapshot,
  SendableRouteSnapshot,
  SupersedeIdentityInput,
} from '../src/route/types.ts'
import { FakePrismaClient } from './support/FakePrisma.ts'

const now = new Date('2026-08-01T21:30:00.000Z')

function ids(prefix: string): () => string {
  let value = 0
  return () => `${prefix}-${++value}`
}

function payloadSha(value: unknown): string {
  const serialized = JSON.stringify(value)
  let hash = 0
  for (const char of serialized) hash = (hash + char.charCodeAt(0)) % 16
  return hash.toString(16).repeat(64)
}

function observation(accountId: string, payload: JsonValue): SanitizedObservationInput {
  return {
    accountId,
    observedAt: now,
    sourceTransport: 'max_synthetic_fixture',
    sourceOrigin: 'protocol',
    historyLive: 'live',
    payloadEncoding: 'json',
    sanitizedPayload: payload,
    payloadSha256: payloadSha(payload),
    payloadSizeBytes: 1,
    replayAvailability: 'available',
    sanitizerVersion: 'test-sanitizer-v1',
    captureAdapterVersion: 'test-capture-v1',
    schemaVersion: 1,
    redactionMetadata: { sanitizerVersion: 'test-sanitizer-v1', categories: [], paths: [] },
    quarantineEligible: true,
    parserVersion: MAX_INBOUND_NORMALIZER_VERSION,
  }
}

class RecordingRouteRegistry implements RouteRegistry {
  readonly inputs: ObserveRouteEvidenceInput[] = []
  readonly seen = new Set<string>()

  async observeRouteEvidence(input: ObserveRouteEvidenceInput): Promise<ObserveRouteEvidenceResult> {
    this.inputs.push(input)
    const idempotent = this.seen.has(input.sourceEvidenceKey)
    this.seen.add(input.sourceEvidenceKey)
    return {
      accountId: input.accountId,
      conversationKey: `conv-${input.identities.find(identity => identity.kind === 'protocol_chat_id')?.value ?? input.identities[0]?.value}`,
      routeVersion: 1,
      state: input.identities.some(identity => identity.kind === 'protocol_chat_id') ? 'active' : 'unresolved',
      routeObservationIds: input.identities.map(identity => `route-${identity.kind}-${identity.value}`),
      processingResults: input.identities.map(() => idempotent ? 'confirmed' : 'created'),
      idempotent,
      semanticChange: !idempotent,
    }
  }

  async getRouteSnapshot(): Promise<RouteSnapshot | null> { return null }
  async getSendableRouteSnapshot(): Promise<SendableRouteSnapshot> { throw new Error('not implemented') }
  async resolveByIdentity(): Promise<RouteSnapshot | null> { return null }
  async listOpenConflicts(): Promise<ConflictPage> { return { conflicts: [] } }
  async supersedeIdentity(_input: SupersedeIdentityInput): Promise<RouteSnapshot> { throw new Error('not implemented') }
  async resolveConflict(_input: ResolveConflictInput): Promise<RouteConflict> { throw new Error('not implemented') }
  async retireConversation(_input: RetireConversationInput): Promise<RouteSnapshot> { throw new Error('not implemented') }
}

function harness() {
  const client = new FakePrismaClient()
  const journal = new PrismaRawEventJournal(client, { idGenerator: ids('journal') })
  const normalizer = new PrismaShadowInboundNormalizationProcessor(
    client,
    journal,
    new MaxInboundNormalizer(),
    { idGenerator: ids('normalizer'), clock: () => now },
  )
  const routes = new RecordingRouteRegistry()
  const projection = new PrismaRouteEvidenceProjectionProcessor(journal, normalizer, routes, { clock: () => now })
  return { client, journal, routes, projection }
}

test('normalized route evidence is projected into one aggregated durable route observation per raw event', async () => {
  const { journal, routes, projection } = harness()
  await journal.append(observation('account-a', {
    kind: 'message',
    direction: 'inbound',
    text: 'privacy-safe synthetic',
    providerOccurredAt: now.toISOString(),
    routeEvidence: [
      { identityKind: 'provider_user_id', identityValue: 'provider-1' },
      { identityKind: 'protocol_chat_id', identityValue: 'protocol-1' },
      { identityKind: 'web_route_id', identityValue: 'web-1' },
    ],
  }))

  const result = await projection.projectBatch({
    accountId: 'account-a',
    parserVersion: MAX_INBOUND_NORMALIZER_VERSION,
    workerId: 'worker-a',
    limit: 10,
  })

  assert.equal(result.processed, 1)
  assert.equal(result.applied, 1)
  assert.equal(result.routeObservations, 3)
  assert.equal(result.skipped, 0)
  assert.equal(routes.inputs.length, 1)
  assert.deepEqual(routes.inputs[0]?.identities, [
    { kind: 'protocol_chat_id', value: 'protocol-1' },
    { kind: 'provider_user_id', value: 'provider-1' },
    { kind: 'web_route_id', value: 'web-1' },
  ])
  assert.equal(routes.inputs[0]?.evidenceAuthority, 'protocol_exact')
  assert.equal((routes.inputs[0]?.evidence as Record<string, unknown>).sourceJournalSequence, '1')
  assert.doesNotMatch(JSON.stringify(routes.inputs[0]?.evidence), /privacy-safe synthetic/)
})

test('projection has its own cursor and replay is idempotent by stable source evidence key', async () => {
  const { journal, routes, projection } = harness()
  await journal.append(observation('account-a', {
    kind: 'route_evidence',
    evidence: [
      { identityKind: 'protocol_chat_id', identityValue: 'protocol-replay' },
      { identityKind: 'provider_user_id', identityValue: 'provider-replay' },
    ],
  }))

  const first = await projection.projectBatch({
    accountId: 'account-a',
    parserVersion: MAX_INBOUND_NORMALIZER_VERSION,
    workerId: 'worker-a',
    limit: 10,
  })
  const noWork = await projection.projectBatch({
    accountId: 'account-a',
    parserVersion: MAX_INBOUND_NORMALIZER_VERSION,
    workerId: 'worker-b',
    limit: 10,
  })
  const replay = await projection.projectBatch({
    accountId: 'account-a',
    parserVersion: MAX_INBOUND_NORMALIZER_VERSION,
    workerId: 'worker-c',
    consumerId: 'route-registry-replay-test',
    limit: 10,
  })

  assert.equal(first.applied, 1)
  assert.equal(noWork.processed, 0)
  assert.equal(replay.applied, 1)
  assert.equal(replay.idempotent, 1)
  assert.equal(routes.inputs[0]?.sourceEvidenceKey, routes.inputs[1]?.sourceEvidenceKey)
})

test('projection is account isolated and skips contradictory same-kind evidence without route mutation', async () => {
  const { journal, routes, projection } = harness()
  await journal.append(observation('account-a', {
    kind: 'route_evidence',
    evidence: [
      { identityKind: 'protocol_chat_id', identityValue: 'protocol-a-1' },
      { identityKind: 'protocol_chat_id', identityValue: 'protocol-a-2' },
    ],
  }))
  await journal.append(observation('account-b', {
    kind: 'route_evidence',
    evidence: [
      { identityKind: 'protocol_chat_id', identityValue: 'protocol-b' },
    ],
  }))

  const accountA = await projection.projectBatch({
    accountId: 'account-a',
    parserVersion: MAX_INBOUND_NORMALIZER_VERSION,
    workerId: 'worker-a',
    limit: 10,
  })
  const accountB = await projection.projectBatch({
    accountId: 'account-b',
    parserVersion: MAX_INBOUND_NORMALIZER_VERSION,
    workerId: 'worker-b',
    limit: 10,
  })

  assert.equal(accountA.processed, 1)
  assert.equal(accountA.applied, 0)
  assert.equal(accountA.skipped, 1)
  assert.equal(accountB.processed, 1)
  assert.equal(accountB.applied, 1)
  assert.equal(routes.inputs.length, 1)
  assert.equal(routes.inputs[0]?.accountId, 'account-b')
  assert.deepEqual(routes.inputs[0]?.identities, [{ kind: 'protocol_chat_id', value: 'protocol-b' }])
})
