import { PrismaRawEventJournal } from '../../src/journal/PrismaRawEventJournal.ts'
import type { JsonValue, SanitizedObservationInput } from '../../src/journal/types.ts'
import type { PrismaDispatchLedger } from '../../src/dispatch/PrismaDispatchLedger.ts'
import type { CreateDispatchResult, DispatchTransitionResult } from '../../src/dispatch/types.ts'
import type { PrismaPerConversationOutboundActor } from '../../src/outbound/PrismaPerConversationOutboundActor.ts'
import { createDispatchFixture } from './dispatchHarness.ts'
import { runId, type RealPrismaClient } from './realPostgres.ts'

const baseTime = new Date('2026-07-27T01:00:00.000Z')

export interface ConfirmationEventFixture {
  readonly eventKind?: 'message' | 'reaction' | 'receipt' | 'route_evidence' | 'unsupported'
  readonly direction?: 'inbound' | 'outbound_echo' | 'system' | 'unknown'
  readonly origin?: 'live' | 'history' | 'replay' | 'unknown'
  readonly providerMessageId?: string | null
  readonly providerUserId?: string | null
  readonly protocolChatId?: string | null
  readonly webRouteId?: string | null
  readonly clientMessageId?: string | null
  readonly targetProviderMessageId?: string | null
  readonly normalizedPayload?: JsonValue
  readonly providerOccurredAt?: Date | null
}

function observation(accountId: string, origin: string): SanitizedObservationInput {
  return {
    accountId,
    observedAt: baseTime,
    sourceTransport: 'max_synthetic_fixture',
    sourceOrigin: 'stage6-real-postgres',
    historyLive: origin === 'history' ? 'history' : 'live',
    payloadEncoding: 'json',
    sanitizedPayload: { kind: 'synthetic_confirmation_fixture' },
    payloadSha256: 'b'.repeat(64),
    payloadSizeBytes: 1,
    replayAvailability: 'available',
    sanitizerVersion: 'stage6-sanitizer-v1',
    captureAdapterVersion: 'stage6-capture-v1',
    schemaVersion: 1,
    redactionMetadata: { sanitizerVersion: 'stage6-sanitizer-v1', categories: [], paths: [] },
    quarantineEligible: true,
    parserVersion: 'stage6-synthetic-parser-v1',
  }
}

export async function appendNormalizedConfirmationEvent(
  client: RealPrismaClient,
  accountId: string,
  fixture: ConfirmationEventFixture,
): Promise<any> {
  const journal = new PrismaRawEventJournal(client as any)
  const origin = fixture.origin ?? 'live'
  const observationId = await journal.append(observation(accountId, origin))
  const raw = await client.maxRawTransportEvent.findUniqueOrThrow({ where: { observationId } })
  const normalizationResultId = runId('s6_result')
  const normalizedEventId = runId('s6_event')
  return client.$transaction(async transaction => {
    await transaction.maxInboundNormalizationResult.create({
      data: {
        normalizationResultId, accountId, sourceObservationId: observationId,
        sourceJournalSequence: raw.journalSequence, parserVersion: 'stage6-synthetic-parser-v1',
        envelopeVersion: 'max-normalized-envelope-v1', status: 'normalized', eventCount: 1,
        startedAt: baseTime, completedAt: new Date(baseTime.valueOf() + 1),
      },
    })
    return transaction.maxInboundNormalizedEvent.create({
      data: {
        normalizedEventId, normalizationResultId, accountId, sourceObservationId: observationId,
        sourceJournalSequence: raw.journalSequence, parserVersion: 'stage6-synthetic-parser-v1',
        envelopeVersion: 'max-normalized-envelope-v1', eventOrdinal: 0,
        eventKind: fixture.eventKind ?? 'message', direction: fixture.direction ?? 'outbound_echo',
        origin, providerMessageId: fixture.providerMessageId ?? null,
        providerUserId: fixture.providerUserId ?? null, protocolChatId: fixture.protocolChatId ?? null,
        webRouteId: fixture.webRouteId ?? null, clientMessageId: fixture.clientMessageId ?? null,
        targetProviderMessageId: fixture.targetProviderMessageId ?? null,
        providerOccurredAt: fixture.providerOccurredAt ?? baseTime,
        normalizedPayload: fixture.normalizedPayload ?? {}, semanticSha256: 'c'.repeat(64),
      },
    })
  })
}

export async function appendManyNormalizedConfirmationEvents(
  client: RealPrismaClient,
  accountId: string,
  fixtures: readonly ConfirmationEventFixture[],
): Promise<any[]> {
  const rows = fixtures.map((fixture, index) => ({
    fixture,
    observationId: runId(`s6_bulk_observation_${index}`),
    normalizationResultId: runId(`s6_bulk_result_${index}`),
    normalizedEventId: runId(`s6_bulk_event_${index}`),
  }))
  await client.maxRawTransportEvent.createMany({
    data: rows.map(({ fixture, observationId }) => ({
      observationId, accountId, observedAt: baseTime, sourceTransport: 'max_synthetic_fixture',
      sourceOrigin: 'stage6-bulk-real-postgres', historyLive: fixture.origin === 'history' ? 'history' : 'live',
      payloadEncoding: 'json', sanitizedPayload: { kind: 'synthetic_confirmation_fixture' },
      payloadSha256: 'd'.repeat(64), payloadSizeBytes: 1, replayAvailability: 'available',
      sanitizerVersion: 'stage6-sanitizer-v1', captureAdapterVersion: 'stage6-capture-v1', schemaVersion: 1,
      redactionMetadata: { sanitizerVersion: 'stage6-sanitizer-v1', categories: [], paths: [] },
      quarantineEligible: true,
    })),
  })
  const rawRows = await client.maxRawTransportEvent.findMany({
    where: { observationId: { in: rows.map(row => row.observationId) } },
  })
  const rawById = new Map<string, any>(rawRows.map((row: any) => [row.observationId, row]))
  await client.$transaction(async transaction => {
    await transaction.maxInboundNormalizationResult.createMany({
      data: rows.map(row => ({
        normalizationResultId: row.normalizationResultId, accountId, sourceObservationId: row.observationId,
        sourceJournalSequence: rawById.get(row.observationId)!.journalSequence,
        parserVersion: 'stage6-synthetic-parser-v1', envelopeVersion: 'max-normalized-envelope-v1',
        status: 'normalized', eventCount: 1, startedAt: baseTime, completedAt: new Date(baseTime.valueOf() + 1),
      })),
    })
    await transaction.maxInboundNormalizedEvent.createMany({
      data: rows.map(row => ({
        normalizedEventId: row.normalizedEventId, normalizationResultId: row.normalizationResultId,
        accountId, sourceObservationId: row.observationId,
        sourceJournalSequence: rawById.get(row.observationId)!.journalSequence,
        parserVersion: 'stage6-synthetic-parser-v1', envelopeVersion: 'max-normalized-envelope-v1', eventOrdinal: 0,
        eventKind: row.fixture.eventKind ?? 'message', direction: row.fixture.direction ?? 'outbound_echo',
        origin: row.fixture.origin ?? 'live', providerMessageId: row.fixture.providerMessageId ?? null,
        providerUserId: row.fixture.providerUserId ?? null, protocolChatId: row.fixture.protocolChatId ?? null,
        webRouteId: row.fixture.webRouteId ?? null, clientMessageId: row.fixture.clientMessageId ?? null,
        targetProviderMessageId: row.fixture.targetProviderMessageId ?? null,
        providerOccurredAt: row.fixture.providerOccurredAt ?? baseTime,
        normalizedPayload: row.fixture.normalizedPayload ?? {}, semanticSha256: 'e'.repeat(64),
      })),
    })
  })
  return client.maxInboundNormalizedEvent.findMany({
    where: { normalizedEventId: { in: rows.map(row => row.normalizedEventId) } },
    orderBy: [{ sourceJournalSequence: 'asc' }, { eventOrdinal: 'asc' }],
  })
}

export interface PreparedDispatch {
  readonly created: CreateDispatchResult
  readonly begun: Awaited<ReturnType<PrismaDispatchLedger['beginAttempt']>>
  readonly current: DispatchTransitionResult | Awaited<ReturnType<PrismaDispatchLedger['beginAttempt']>>
  readonly attemptCorrelationId: string
  readonly clientMessageId: string
}

export async function prepareDispatch(
  client: RealPrismaClient,
  actor: PrismaPerConversationOutboundActor,
  ledger: PrismaDispatchLedger,
  accountId: string,
  conversationKey: string,
  target: 'prepared' | 'physical_started' | 'client_accepted' | 'awaiting' | 'reconciliation' = 'awaiting',
  text = 'synthetic identical message',
): Promise<PreparedDispatch> {
  const created = await createDispatchFixture(actor, ledger, accountId, conversationKey, 'actor-owner', text)
  const command = await client.maxOutboundCommand.findUniqueOrThrow({ where: { commandId: created.dispatch.commandId } })
  const attemptCorrelationId = runId('attempt_correlation')
  const begun = await ledger.beginAttempt({
    attemptId: runId('attempt'), accountId, conversationKey, dispatchId: created.dispatch.dispatchId,
    expectedStateVersion: created.dispatch.stateVersion, senderOwnerId: 'stage6-sender-owner',
    senderFencingEpoch: 41, senderProofTimestamp: baseTime, attemptCorrelationId,
    transitionIdempotencyKey: runId('attempt_begin'), now: baseTime,
  })
  if (target === 'prepared') return { created, begun, current: begun, attemptCorrelationId, clientMessageId: command.clientMessageId }
  const physical = await ledger.markPhysicalActionStarted({
    accountId, conversationKey, dispatchId: created.dispatch.dispatchId, attemptId: begun.attempt.attemptId,
    expectedStateVersion: begun.dispatch.stateVersion, expectedAttemptVersion: begun.attempt.attemptVersion,
    transitionIdempotencyKey: runId('physical_started'), evidenceReference: runId('physical_evidence'), now: new Date(baseTime.valueOf() + 10),
  })
  if (target === 'physical_started') return { created, begun, current: physical, attemptCorrelationId, clientMessageId: command.clientMessageId }
  const accepted = await ledger.recordClientActionAccepted({
    accountId, conversationKey, dispatchId: created.dispatch.dispatchId, attemptId: begun.attempt.attemptId,
    expectedStateVersion: physical.dispatch.stateVersion, expectedAttemptVersion: physical.attempt!.attemptVersion,
    transitionIdempotencyKey: runId('client_accepted'), evidenceReference: runId('client_evidence'), now: new Date(baseTime.valueOf() + 20),
  })
  if (target === 'client_accepted') return { created, begun, current: accepted, attemptCorrelationId, clientMessageId: command.clientMessageId }
  const awaiting = await ledger.markAwaitingConfirmation({
    accountId, conversationKey, dispatchId: created.dispatch.dispatchId, attemptId: begun.attempt.attemptId,
    expectedStateVersion: accepted.dispatch.stateVersion, expectedAttemptVersion: accepted.attempt!.attemptVersion,
    transitionIdempotencyKey: runId('awaiting'), evidenceReference: attemptCorrelationId, now: new Date(baseTime.valueOf() + 30),
  })
  if (target === 'awaiting') return { created, begun, current: awaiting, attemptCorrelationId, clientMessageId: command.clientMessageId }
  const reconciliation = await ledger.recordUnknownOutcome({
    accountId, conversationKey, dispatchId: created.dispatch.dispatchId, attemptId: begun.attempt.attemptId,
    expectedStateVersion: awaiting.dispatch.stateVersion, expectedAttemptVersion: awaiting.attempt!.attemptVersion,
    transitionIdempotencyKey: runId('unknown'), evidenceReference: runId('unknown_evidence'),
    reason: 'timeout', now: new Date(baseTime.valueOf() + 40),
  })
  return { created, begun, current: reconciliation, attemptCorrelationId, clientMessageId: command.clientMessageId }
}
