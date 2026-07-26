import { randomUUID } from 'node:crypto'
import type { RawEventJournal } from '../journal/RawEventJournal.ts'
import type { JsonValue, RawTransportObservation } from '../journal/types.ts'
import {
  MAX_INBOUND_BATCH_LIMIT,
} from './constants.ts'
import {
  asInboundDatabaseError,
  InboundNormalizationError,
  normalizationErrorCode,
} from './errors.ts'
import type {
  InboundNormalizer,
  NormalizationOutcome,
  NormalizationResult,
  NormalizeBatchInput,
  NormalizeBatchResult,
  NormalizedEventPage,
  NormalizedPayload,
  NormalizedStreamCursor,
  NormalizedTransportEvent,
  NormalizeObservationInput,
  NormalizeObservationResult,
  ShadowInboundNormalizationProcessor,
} from './types.ts'

interface RawRecord {
  observationId: string
  journalSequence: bigint
  accountId: string
  observedAt: Date
  persistedAt: Date
  sourceTransport: string
  sourceOrigin: string
  historyLive: string
  payloadEncoding: string
  sanitizedPayload: JsonValue
  payloadSha256: string
  captureAdapterVersion: string
  replayAvailability: string
  quarantineReason: string | null
  opcode: number | null
  eventType: string | null
}

interface ResultRecord {
  normalizationResultId: string
  accountId: string
  sourceObservationId: string
  sourceJournalSequence: bigint
  parserVersion: string
  envelopeVersion: string
  status: string
  eventCount: number
  issueCode: string | null
  safeIssueSummary: string | null
  startedAt: Date
  completedAt: Date
  createdAt: Date
}

interface EventRecord {
  normalizedEventId: string
  normalizationResultId: string
  accountId: string
  sourceObservationId: string
  sourceJournalSequence: bigint
  parserVersion: string
  envelopeVersion: string
  eventOrdinal: number
  eventKind: string
  direction: string
  origin: string
  providerMessageId: string | null
  providerUserId: string | null
  protocolChatId: string | null
  webRouteId: string | null
  clientMessageId: string | null
  targetProviderMessageId: string | null
  providerOccurredAt: Date | null
  normalizedPayload: JsonValue
  semanticSha256: string
  createdAt: Date
}

interface RawDelegate {
  findUnique(args: { where: Record<string, unknown> }): Promise<RawRecord | null>
}

interface ResultDelegate {
  create(args: { data: Record<string, unknown> }): Promise<ResultRecord>
  findUnique(args: { where: Record<string, unknown> }): Promise<ResultRecord | null>
}

interface EventDelegate {
  create(args: { data: Record<string, unknown> }): Promise<EventRecord>
  findMany(args: { where: Record<string, unknown>; orderBy: unknown; take?: number }): Promise<EventRecord[]>
}

interface ProcessingDelegate {
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
}

export interface InboundNormalizationPrismaTransaction {
  readonly maxInboundNormalizationResult: ResultDelegate
  readonly maxInboundNormalizedEvent: EventDelegate
  readonly maxRawTransportProcessing: ProcessingDelegate
}

export interface InboundNormalizationPrismaClient extends InboundNormalizationPrismaTransaction {
  readonly maxRawTransportEvent: RawDelegate
  $transaction<T>(operation: (transaction: InboundNormalizationPrismaTransaction) => Promise<T>): Promise<T>
}

export interface PrismaShadowInboundNormalizationProcessorOptions {
  readonly idGenerator?: () => string
  readonly leaseMilliseconds?: number
  readonly clock?: () => Date
}

function required(value: string, field: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new InboundNormalizationError('INVALID_INPUT', `${field} is required and must be exact`)
  }
}

function mapResult(record: ResultRecord): NormalizationResult {
  if (record.status !== 'normalized' && record.status !== 'unsupported' && record.status !== 'quarantined') {
    throw new InboundNormalizationError('DATABASE_FAILURE', 'Stored normalization status is invalid')
  }
  return { ...record, status: record.status }
}

function mapEvent(record: EventRecord): NormalizedTransportEvent {
  return {
    normalizedEventId: record.normalizedEventId,
    normalizationResultId: record.normalizationResultId,
    accountId: record.accountId,
    sourceObservationId: record.sourceObservationId,
    sourceJournalSequence: record.sourceJournalSequence,
    parserVersion: record.parserVersion,
    envelopeVersion: record.envelopeVersion,
    eventOrdinal: record.eventOrdinal,
    eventKind: record.eventKind as NormalizedTransportEvent['eventKind'],
    direction: record.direction as NormalizedTransportEvent['direction'],
    origin: record.origin as NormalizedTransportEvent['origin'],
    providerMessageId: record.providerMessageId,
    providerUserId: record.providerUserId,
    protocolChatId: record.protocolChatId,
    webRouteId: record.webRouteId,
    clientMessageId: record.clientMessageId,
    targetProviderMessageId: record.targetProviderMessageId,
    providerOccurredAt: record.providerOccurredAt,
    normalizedPayload: record.normalizedPayload as unknown as NormalizedPayload,
    semanticSha256: record.semanticSha256,
    createdAt: record.createdAt,
  }
}

function terminalProcessingState(outcome: NormalizationOutcome): 'completed' | 'quarantined' {
  return outcome.status === 'quarantined' ? 'quarantined' : 'completed'
}

function toNormalizerInput(raw: RawRecord, parserVersion: string) {
  return {
    accountId: raw.accountId,
    observationId: raw.observationId,
    journalSequence: raw.journalSequence,
    observedAt: raw.observedAt,
    sourceTransport: raw.sourceTransport,
    sourceOrigin: raw.sourceOrigin,
    historyLive: raw.historyLive as RawTransportObservation['historyLive'],
    payloadEncoding: raw.payloadEncoding,
    sanitizedPayload: raw.sanitizedPayload,
    payloadSha256: raw.payloadSha256,
    captureAdapterVersion: raw.captureAdapterVersion,
    parserVersion,
    opcode: raw.opcode ?? undefined,
    eventType: raw.eventType ?? undefined,
    replayAvailability: raw.replayAvailability as 'available' | 'quarantined',
    quarantineReason: raw.quarantineReason ?? undefined,
  }
}

function asProcessorError(error: unknown): InboundNormalizationError {
  if (error instanceof InboundNormalizationError) return error
  const code = normalizationErrorCode(error)
  if (code === 'CLAIM_CONFLICT') return new InboundNormalizationError('CLAIM_CONFLICT', 'Observation processing is claimed by another worker', { cause: error })
  if (code === 'ACCOUNT_MISMATCH') return new InboundNormalizationError('ACCOUNT_MISMATCH', 'Raw observation account mismatch', { cause: error })
  if (code === 'NOT_FOUND') return new InboundNormalizationError('NOT_FOUND', 'Raw observation was not found', { cause: error })
  if (code === 'STALE_WORKER') return new InboundNormalizationError('STALE_WORKER', 'Processing lease is stale', { cause: error })
  if (code === 'CURSOR_CONFLICT') return new InboundNormalizationError('CURSOR_CONFLICT', 'Cursor was advanced concurrently', { cause: error })
  return asInboundDatabaseError(error)
}

export class PrismaShadowInboundNormalizationProcessor implements ShadowInboundNormalizationProcessor {
  readonly #client: InboundNormalizationPrismaClient
  readonly #journal: RawEventJournal
  readonly #normalizer: InboundNormalizer
  readonly #idGenerator: () => string
  readonly #leaseMilliseconds: number
  readonly #clock: () => Date

  constructor(
    client: InboundNormalizationPrismaClient,
    journal: RawEventJournal,
    normalizer: InboundNormalizer,
    options: PrismaShadowInboundNormalizationProcessorOptions = {},
  ) {
    this.#client = client
    this.#journal = journal
    this.#normalizer = normalizer
    this.#idGenerator = options.idGenerator ?? randomUUID
    this.#leaseMilliseconds = options.leaseMilliseconds ?? 30_000
    this.#clock = options.clock ?? (() => new Date())
    if (!Number.isSafeInteger(this.#leaseMilliseconds) || this.#leaseMilliseconds < 1) {
      throw new InboundNormalizationError('INVALID_INPUT', 'leaseMilliseconds must be positive')
    }
  }

  async getNormalizationResult(
    accountId: string,
    observationId: string,
    parserVersion: string,
  ): Promise<NormalizeObservationResult | null> {
    required(accountId, 'accountId')
    required(observationId, 'observationId')
    required(parserVersion, 'parserVersion')
    try {
      const record = await this.#client.maxInboundNormalizationResult.findUnique({
        where: { accountId_sourceObservationId_parserVersion: { accountId, sourceObservationId: observationId, parserVersion } },
      })
      if (record === null) return null
      const events = await this.#client.maxInboundNormalizedEvent.findMany({
        where: { accountId, normalizationResultId: record.normalizationResultId },
        orderBy: { eventOrdinal: 'asc' },
      })
      return { result: mapResult(record), events: events.map(mapEvent), idempotent: true }
    } catch (error) {
      throw asProcessorError(error)
    }
  }

  async normalizeObservation(input: NormalizeObservationInput): Promise<NormalizeObservationResult> {
    required(input.accountId, 'accountId')
    required(input.observationId, 'observationId')
    required(input.parserVersion, 'parserVersion')
    required(input.workerId, 'workerId')
    const existing = await this.getNormalizationResult(input.accountId, input.observationId, input.parserVersion)
    if (existing !== null) return existing

    const startedAt = input.now ?? this.#clock()
    const leaseUntil = new Date(startedAt.valueOf() + this.#leaseMilliseconds)
    let claim
    try {
      claim = await this.#journal.claimProcessing({
        accountId: input.accountId,
        observationId: input.observationId,
        parserVersion: input.parserVersion,
        workerId: input.workerId,
        now: startedAt,
        leaseUntil,
      })
    } catch (error) {
      const raced = await this.getNormalizationResult(input.accountId, input.observationId, input.parserVersion)
      if (raced !== null) return raced
      throw asProcessorError(error)
    }

    let raw: RawRecord | null
    try {
      raw = await this.#client.maxRawTransportEvent.findUnique({
        where: { accountId_observationId: { accountId: input.accountId, observationId: input.observationId } },
      })
    } catch (error) {
      throw asProcessorError(error)
    }
    if (raw === null) throw new InboundNormalizationError('NOT_FOUND', 'Raw observation was not found for this account')
    const outcome = this.#normalizer.normalizeRawObservation(toNormalizerInput(raw, input.parserVersion))
    const completedAt = this.#clock()
    const normalizationResultId = this.#idGenerator()

    try {
      const stored = await this.#client.$transaction(async transaction => {
        const result = await transaction.maxInboundNormalizationResult.create({
          data: {
            normalizationResultId,
            accountId: input.accountId,
            sourceObservationId: input.observationId,
            sourceJournalSequence: raw!.journalSequence,
            parserVersion: input.parserVersion,
            envelopeVersion: outcome.envelopeVersion,
            status: outcome.status,
            eventCount: outcome.events.length,
            issueCode: outcome.issueCode,
            safeIssueSummary: outcome.safeIssueSummary,
            startedAt,
            completedAt,
          },
        })
        const events: EventRecord[] = []
        for (const event of outcome.events) {
          events.push(await transaction.maxInboundNormalizedEvent.create({
            data: {
              normalizedEventId: this.#idGenerator(),
              normalizationResultId,
              accountId: input.accountId,
              sourceObservationId: input.observationId,
              sourceJournalSequence: raw!.journalSequence,
              parserVersion: input.parserVersion,
              envelopeVersion: outcome.envelopeVersion,
              eventOrdinal: event.eventOrdinal,
              eventKind: event.eventKind,
              direction: event.direction,
              origin: event.origin,
              providerMessageId: event.providerMessageId,
              providerUserId: event.providerUserId,
              protocolChatId: event.protocolChatId,
              webRouteId: event.webRouteId,
              clientMessageId: event.clientMessageId,
              targetProviderMessageId: event.targetProviderMessageId,
              providerOccurredAt: event.providerOccurredAt,
              normalizedPayload: event.normalizedPayload,
              semanticSha256: event.semanticSha256,
            },
          }))
        }
        const processing = await transaction.maxRawTransportProcessing.updateMany({
          where: {
            observationId: input.observationId,
            parserVersion: input.parserVersion,
            claimedBy: input.workerId,
            leaseVersion: claim.leaseVersion,
            rawObservation: { accountId: input.accountId },
          },
          data: {
            state: terminalProcessingState(outcome),
            completedAt,
            lastErrorCode: outcome.issueCode,
            lastErrorSummary: outcome.safeIssueSummary,
            quarantineReason: outcome.status === 'quarantined' ? outcome.issueCode : null,
            replayMetadata: {
              normalizationResultId,
              parserVersion: input.parserVersion,
              envelopeVersion: outcome.envelopeVersion,
              normalizationStatus: outcome.status,
              eventCount: outcome.events.length,
            },
          },
        })
        if (processing.count !== 1) {
          throw new InboundNormalizationError('STALE_WORKER', 'Processing state changed before terminal transaction')
        }
        return { result, events }
      })
      return { result: mapResult(stored.result), events: stored.events.map(mapEvent), idempotent: false }
    } catch (error) {
      if (normalizationErrorCode(error) === 'P2002' || normalizationErrorCode(error) === 'CLAIM_CONFLICT') {
        const raced = await this.getNormalizationResult(input.accountId, input.observationId, input.parserVersion)
        if (raced !== null) return raced
      }
      throw asProcessorError(error)
    }
  }

  async normalizeBatch(input: NormalizeBatchInput): Promise<NormalizeBatchResult> {
    required(input.accountId, 'accountId')
    required(input.consumerId, 'consumerId')
    required(input.parserVersion, 'parserVersion')
    required(input.workerId, 'workerId')
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_INBOUND_BATCH_LIMIT) {
      throw new InboundNormalizationError('INVALID_INPUT', `limit must be between 1 and ${MAX_INBOUND_BATCH_LIMIT}`)
    }
    let cursor = await this.#journal.getCursor(input.consumerId, input.accountId, input.parserVersion)
    const page = await this.#journal.readAfter(input.accountId, cursor?.lastJournalSequence ?? 0n, input.limit)
    let normalized = 0
    let unsupported = 0
    let quarantined = 0
    let idempotent = 0
    for (const observation of page.observations) {
      const result = await this.normalizeObservation({
        accountId: input.accountId,
        observationId: observation.observationId,
        parserVersion: input.parserVersion,
        workerId: input.workerId,
      })
      if (result.result.status === 'normalized') normalized += 1
      else if (result.result.status === 'unsupported') unsupported += 1
      else quarantined += 1
      if (result.idempotent) idempotent += 1
      try {
        cursor = await this.#journal.advanceCursor({
          consumerId: input.consumerId,
          accountId: input.accountId,
          parserVersion: input.parserVersion,
          lastJournalSequence: observation.journalSequence,
          expectedVersion: cursor?.version ?? 0,
        })
      } catch (error) {
        throw asProcessorError(error)
      }
    }
    return {
      processed: page.observations.length,
      normalized,
      unsupported,
      quarantined,
      idempotent,
      lastJournalSequence: cursor?.lastJournalSequence ?? 0n,
    }
  }

  async readNormalizedAfter(
    accountId: string,
    parserVersion: string,
    cursor: NormalizedStreamCursor,
    limit: number,
  ): Promise<NormalizedEventPage> {
    required(accountId, 'accountId')
    required(parserVersion, 'parserVersion')
    if (cursor.sourceJournalSequence < 0n || !Number.isSafeInteger(cursor.eventOrdinal) || cursor.eventOrdinal < -1) {
      throw new InboundNormalizationError('INVALID_INPUT', 'Normalized cursor is invalid')
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_INBOUND_BATCH_LIMIT) {
      throw new InboundNormalizationError('INVALID_INPUT', `limit must be between 1 and ${MAX_INBOUND_BATCH_LIMIT}`)
    }
    try {
      const records = await this.#client.maxInboundNormalizedEvent.findMany({
        where: {
          accountId,
          parserVersion,
          OR: [
            { sourceJournalSequence: { gt: cursor.sourceJournalSequence } },
            { sourceJournalSequence: cursor.sourceJournalSequence, eventOrdinal: { gt: cursor.eventOrdinal } },
          ],
        },
        orderBy: [{ sourceJournalSequence: 'asc' }, { eventOrdinal: 'asc' }],
        take: limit,
      })
      const events = records.map(mapEvent)
      const last = events.at(-1)
      return {
        events,
        nextCursor: last === undefined
          ? cursor
          : { sourceJournalSequence: last.sourceJournalSequence, eventOrdinal: last.eventOrdinal },
      }
    } catch (error) {
      throw asProcessorError(error)
    }
  }
}
