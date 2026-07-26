import { randomUUID } from 'node:crypto'
import { JournalError, asJournalDatabaseError } from './errors.ts'
import type { RawEventJournal } from './RawEventJournal.ts'
import type {
  AdvanceCursorInput,
  ClaimProcessingInput,
  ConsumerCursor,
  JournalPage,
  JsonValue,
  MarkProcessingInput,
  ProcessingState,
  ProcessingStateName,
  QuarantineReason,
  RawTransportObservation,
  RedactionEvidence,
  ReplayAvailability,
  SanitizedObservationInput,
} from './types.ts'

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024
const MAX_READ_LIMIT = 1000

interface RawRecord {
  observationId: string
  journalSequence: bigint
  accountId: string
  observedAt: Date
  persistedAt: Date
  sourceTransport: string
  sourceOrigin: string
  historyLive: string
  socketGeneration: string | null
  frameId: string | null
  providerEventId: string | null
  transportSequence: string | null
  opcode: number | null
  eventType: string | null
  payloadEncoding: string
  sanitizedPayload: JsonValue
  payloadSha256: string
  payloadSizeBytes: number
  replayAvailability: string
  quarantineReason: string | null
  sanitizerVersion: string
  captureAdapterVersion: string
  schemaVersion: number
  correlationMetadata: JsonValue | null
  redactionMetadata: RedactionEvidence
  quarantineEligible: boolean
}

interface ProcessingRecord {
  id: string
  observationId: string
  parserVersion: string
  state: string
  attempts: number
  claimedBy: string | null
  claimedAt: Date | null
  leaseUntil: Date | null
  leaseVersion: number
  completedAt: Date | null
  lastErrorCode: string | null
  lastErrorSummary: string | null
  quarantineReason: string | null
  replayMetadata: JsonValue | null
}

interface CursorRecord {
  id: string
  consumerId: string
  accountId: string
  parserVersion: string
  lastJournalSequence: bigint
  version: number
  updatedAt: Date
}

interface RawDelegate {
  create(args: { data: Record<string, unknown> }): Promise<RawRecord>
  findMany(args: { where: Record<string, unknown>; orderBy: Record<string, 'asc'>; take: number }): Promise<RawRecord[]>
  findUnique(args: { where: Record<string, unknown> }): Promise<RawRecord | null>
}

interface ProcessingDelegate {
  create(args: { data: Record<string, unknown> }): Promise<ProcessingRecord>
  upsert(args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }): Promise<ProcessingRecord>
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
  findUnique(args: { where: Record<string, unknown> }): Promise<ProcessingRecord | null>
}

interface CursorDelegate {
  create(args: { data: Record<string, unknown> }): Promise<CursorRecord>
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
  findUnique(args: { where: Record<string, unknown> }): Promise<CursorRecord | null>
}

export interface RawJournalPrismaTransaction {
  readonly maxRawTransportEvent: RawDelegate
  readonly maxRawTransportProcessing: ProcessingDelegate
  readonly maxRawTransportCursor: CursorDelegate
}

export interface RawJournalPrismaClient extends RawJournalPrismaTransaction {
  $transaction<T>(operation: (transaction: RawJournalPrismaTransaction) => Promise<T>): Promise<T>
}

export interface PrismaRawEventJournalOptions {
  readonly idGenerator?: () => string
  readonly maxPayloadBytes?: number
}

const PROCESSING_STATES: ReadonlySet<ProcessingStateName> = new Set([
  'pending',
  'processing',
  'completed',
  'retryable',
  'quarantined',
  'dead_letter',
])

function processingState(value: unknown): ProcessingStateName {
  if (typeof value !== 'string' || !PROCESSING_STATES.has(value as ProcessingStateName)) {
    throw new JournalError('INVALID_INPUT', 'Processing state is not supported')
  }
  return value as ProcessingStateName
}

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new JournalError('INVALID_INPUT', `${field} must be a non-negative integer`)
  }
}

function isPrismaUniqueError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && Reflect.get(error, 'code') === 'P2002'
}

function replayAvailability(value: unknown): ReplayAvailability {
  if (value !== 'available' && value !== 'quarantined') {
    throw new JournalError('INVALID_INPUT', 'Replay availability is not supported')
  }
  return value
}

function quarantineReason(value: unknown): QuarantineReason | undefined {
  if (value === undefined) return undefined
  if (value !== 'binary_payload_not_persisted'
    && value !== 'unsupported_payload'
    && value !== 'sanitized_payload_too_large') {
    throw new JournalError('INVALID_INPUT', 'Quarantine reason is not supported')
  }
  return value
}

function addRedactionEvidence(
  evidence: RedactionEvidence,
  category: string,
  path: string,
): RedactionEvidence {
  return {
    sanitizerVersion: evidence.sanitizerVersion,
    categories: [...new Set([...evidence.categories, category])].sort(),
    paths: [...new Set([...evidence.paths, path])].sort(),
  }
}

function required(value: string, field: string): void {
  if (value.trim().length === 0) throw new JournalError('INVALID_INPUT', `${field} is required`)
}

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value
}

function mapRaw(record: RawRecord): RawTransportObservation {
  return {
    observationId: record.observationId,
    journalSequence: record.journalSequence,
    accountId: record.accountId,
    observedAt: record.observedAt,
    persistedAt: record.persistedAt,
    sourceTransport: record.sourceTransport,
    sourceOrigin: record.sourceOrigin,
    historyLive: record.historyLive as RawTransportObservation['historyLive'],
    socketGeneration: optional(record.socketGeneration),
    frameId: optional(record.frameId),
    providerEventId: optional(record.providerEventId),
    transportSequence: optional(record.transportSequence),
    opcode: optional(record.opcode),
    eventType: optional(record.eventType),
    payloadEncoding: record.payloadEncoding as RawTransportObservation['payloadEncoding'],
    sanitizedPayload: record.sanitizedPayload,
    payloadSha256: record.payloadSha256,
    payloadSizeBytes: record.payloadSizeBytes,
    replayAvailability: replayAvailability(record.replayAvailability),
    quarantineReason: quarantineReason(optional(record.quarantineReason)),
    sanitizerVersion: record.sanitizerVersion,
    captureAdapterVersion: record.captureAdapterVersion,
    schemaVersion: record.schemaVersion,
    correlationMetadata: optional(record.correlationMetadata),
    redactionMetadata: record.redactionMetadata,
    quarantineEligible: record.quarantineEligible,
  }
}

function mapProcessing(record: ProcessingRecord): ProcessingState {
  return {
    id: record.id,
    observationId: record.observationId,
    parserVersion: record.parserVersion,
    state: processingState(record.state),
    attempts: record.attempts,
    claimedBy: optional(record.claimedBy),
    claimedAt: optional(record.claimedAt),
    leaseUntil: optional(record.leaseUntil),
    leaseVersion: record.leaseVersion,
    completedAt: optional(record.completedAt),
    lastErrorCode: optional(record.lastErrorCode),
    lastErrorSummary: optional(record.lastErrorSummary),
    quarantineReason: optional(record.quarantineReason),
    replayMetadata: optional(record.replayMetadata),
  }
}

function mapCursor(record: CursorRecord): ConsumerCursor {
  return {
    consumerId: record.consumerId,
    accountId: record.accountId,
    parserVersion: record.parserVersion,
    lastJournalSequence: record.lastJournalSequence,
    version: record.version,
    updatedAt: record.updatedAt,
  }
}

export class PrismaRawEventJournal implements RawEventJournal {
  readonly #client: RawJournalPrismaClient
  readonly #idGenerator: () => string
  readonly #maxPayloadBytes: number

  constructor(client: RawJournalPrismaClient, options: PrismaRawEventJournalOptions = {}) {
    this.#client = client
    this.#idGenerator = options.idGenerator ?? randomUUID
    this.#maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES
    if (!Number.isSafeInteger(this.#maxPayloadBytes) || this.#maxPayloadBytes < 1) {
      throw new JournalError('INVALID_INPUT', 'maxPayloadBytes must be a positive integer')
    }
  }

  async append(observation: SanitizedObservationInput): Promise<string> {
    required(observation.accountId, 'accountId')
    required(observation.parserVersion, 'parserVersion')
    required(observation.payloadSha256, 'payloadSha256')
    if (!/^[a-f0-9]{64}$/i.test(observation.payloadSha256)) {
      throw new JournalError('INVALID_INPUT', 'payloadSha256 must be a SHA-256 hex digest')
    }
    required(observation.sourceTransport, 'sourceTransport')
    required(observation.sourceOrigin, 'sourceOrigin')
    required(observation.captureAdapterVersion, 'captureAdapterVersion')
    required(observation.sanitizerVersion, 'sanitizerVersion')
    nonNegativeInteger(observation.schemaVersion, 'schemaVersion')

    let payloadBytes = 0
    let payloadInspectable = true
    try {
      const serialized = JSON.stringify(observation.sanitizedPayload)
      if (serialized === undefined) payloadInspectable = false
      else payloadBytes = Buffer.byteLength(serialized, 'utf8')
    } catch {
      payloadInspectable = false
    }

    let storedPayload = observation.sanitizedPayload
    let storedReplayAvailability = replayAvailability(observation.replayAvailability)
    let storedQuarantineReason = quarantineReason(observation.quarantineReason)
    nonNegativeInteger(observation.payloadSizeBytes, 'payloadSizeBytes')
    let storedRedactionMetadata = observation.redactionMetadata
    if (!payloadInspectable || payloadBytes > this.#maxPayloadBytes) {
      storedQuarantineReason = payloadInspectable ? 'sanitized_payload_too_large' : 'unsupported_payload'
      storedReplayAvailability = 'quarantined'
      storedRedactionMetadata = addRedactionEvidence(
        storedRedactionMetadata,
        payloadInspectable ? 'oversized_payload' : 'unsupported_value',
        '$',
      )
      storedPayload = {
        $quarantine: {
          reason: storedQuarantineReason,
          originalEncoding: observation.payloadEncoding,
          sanitizedSizeBytes: payloadBytes,
          sanitizedPayloadSha256: observation.payloadSha256,
          replayAvailability: 'quarantined',
          payloadStored: false,
        },
      }
    }
    if (storedReplayAvailability === 'quarantined' && !storedQuarantineReason) {
      throw new JournalError('INVALID_INPUT', 'Quarantined payload requires a quarantine reason')
    }
    if (storedReplayAvailability === 'available' && storedQuarantineReason) {
      throw new JournalError('INVALID_INPUT', 'Available payload cannot have a quarantine reason')
    }

    const observationId = this.#idGenerator()
    const processingId = this.#idGenerator()
    try {
      await this.#client.$transaction(async transaction => {
        await transaction.maxRawTransportEvent.create({
          data: {
            observationId,
            accountId: observation.accountId,
            observedAt: observation.observedAt,
            sourceTransport: observation.sourceTransport,
            sourceOrigin: observation.sourceOrigin,
            historyLive: observation.historyLive,
            socketGeneration: observation.socketGeneration,
            frameId: observation.frameId,
            providerEventId: observation.providerEventId,
            transportSequence: observation.transportSequence,
            opcode: observation.opcode,
            eventType: observation.eventType,
            payloadEncoding: observation.payloadEncoding,
            sanitizedPayload: storedPayload,
            payloadSha256: observation.payloadSha256,
            payloadSizeBytes: payloadBytes,
            replayAvailability: storedReplayAvailability,
            quarantineReason: storedQuarantineReason,
            sanitizerVersion: observation.sanitizerVersion,
            captureAdapterVersion: observation.captureAdapterVersion,
            schemaVersion: observation.schemaVersion,
            correlationMetadata: observation.correlationMetadata,
            redactionMetadata: storedRedactionMetadata,
            quarantineEligible: storedReplayAvailability === 'quarantined' || observation.quarantineEligible,
          },
        })
        await transaction.maxRawTransportProcessing.create({
          data: {
            id: processingId,
            observationId,
            parserVersion: observation.parserVersion,
            state: storedReplayAvailability === 'quarantined' ? 'quarantined' : 'pending',
            quarantineReason: storedQuarantineReason,
            replayMetadata: storedReplayAvailability === 'quarantined'
              ? {
                  replayAvailability: storedReplayAvailability,
                  quarantineReason: storedQuarantineReason ?? null,
                  payloadSizeBytes: payloadBytes,
                }
              : undefined,
          },
        })
      })
      return observationId
    } catch (error) {
      throw asJournalDatabaseError(error)
    }
  }

  async readAfter(accountId: string, cursor: bigint, limit: number): Promise<JournalPage> {
    required(accountId, 'accountId')
    if (cursor < 0n) throw new JournalError('INVALID_INPUT', 'cursor must be non-negative')
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) {
      throw new JournalError('INVALID_INPUT', `limit must be between 1 and ${MAX_READ_LIMIT}`)
    }
    try {
      const records = await this.#client.maxRawTransportEvent.findMany({
        where: { accountId, journalSequence: { gt: cursor } },
        orderBy: { journalSequence: 'asc' },
        take: limit,
      })
      const observations = records.map(mapRaw)
      return { observations, nextCursor: observations.at(-1)?.journalSequence ?? cursor }
    } catch (error) {
      throw asJournalDatabaseError(error)
    }
  }

  async claimProcessing(input: ClaimProcessingInput): Promise<ProcessingState> {
    required(input.accountId, 'accountId')
    required(input.observationId, 'observationId')
    required(input.parserVersion, 'parserVersion')
    required(input.workerId, 'workerId')
    if (input.leaseUntil <= input.now) throw new JournalError('INVALID_INPUT', 'leaseUntil must be after now')
    try {
      return await this.#client.$transaction(async transaction => {
        const raw = await transaction.maxRawTransportEvent.findUnique({ where: { observationId: input.observationId } })
        if (!raw) throw new JournalError('NOT_FOUND', 'Raw observation not found')
        if (raw.accountId !== input.accountId) throw new JournalError('ACCOUNT_MISMATCH', 'Raw observation account mismatch')

        await transaction.maxRawTransportProcessing.upsert({
          where: { observationId_parserVersion: { observationId: input.observationId, parserVersion: input.parserVersion } },
          create: {
            id: this.#idGenerator(),
            observationId: input.observationId,
            parserVersion: input.parserVersion,
            state: 'pending',
          },
          update: {},
        })

        const updated = await transaction.maxRawTransportProcessing.updateMany({
          where: {
            observationId: input.observationId,
            parserVersion: input.parserVersion,
            OR: [
              { state: 'pending' },
              { leaseUntil: { lt: input.now } },
              { claimedBy: input.workerId },
            ],
          },
          data: {
            state: 'processing',
            claimedBy: input.workerId,
            claimedAt: input.now,
            leaseUntil: input.leaseUntil,
            attempts: { increment: 1 },
            leaseVersion: { increment: 1 },
          },
        })
        if (updated.count !== 1) throw new JournalError('CLAIM_CONFLICT', 'Processing state is leased by another worker')
        const record = await transaction.maxRawTransportProcessing.findUnique({
          where: { observationId_parserVersion: { observationId: input.observationId, parserVersion: input.parserVersion } },
        })
        if (!record) throw new JournalError('NOT_FOUND', 'Processing state not found after claim')
        return mapProcessing(record)
      })
    } catch (error) {
      throw asJournalDatabaseError(error)
    }
  }

  async markProcessingState(input: MarkProcessingInput): Promise<ProcessingState> {
    required(input.accountId, 'accountId')
    required(input.observationId, 'observationId')
    required(input.parserVersion, 'parserVersion')
    required(input.workerId, 'workerId')
    nonNegativeInteger(input.expectedLeaseVersion, 'expectedLeaseVersion')
    const nextState = processingState(input.state)
    try {
      const updated = await this.#client.maxRawTransportProcessing.updateMany({
        where: {
          observationId: input.observationId,
          parserVersion: input.parserVersion,
          claimedBy: input.workerId,
          leaseVersion: input.expectedLeaseVersion,
          rawObservation: { accountId: input.accountId },
        },
        data: {
          state: nextState,
          completedAt: input.completedAt,
          lastErrorCode: input.lastErrorCode,
          lastErrorSummary: input.lastErrorSummary,
          quarantineReason: input.quarantineReason,
          replayMetadata: input.replayMetadata,
        },
      })
      if (updated.count !== 1) throw new JournalError('STALE_WORKER', 'Processing update rejected for stale worker or account')
      const record = await this.#client.maxRawTransportProcessing.findUnique({
        where: { observationId_parserVersion: { observationId: input.observationId, parserVersion: input.parserVersion } },
      })
      if (!record) throw new JournalError('NOT_FOUND', 'Processing state not found after update')
      return mapProcessing(record)
    } catch (error) {
      throw asJournalDatabaseError(error)
    }
  }

  async getProcessingState(accountId: string, observationId: string, parserVersion: string): Promise<ProcessingState | null> {
    required(accountId, 'accountId')
    required(observationId, 'observationId')
    required(parserVersion, 'parserVersion')
    try {
      const raw = await this.#client.maxRawTransportEvent.findUnique({ where: { observationId } })
      if (!raw || raw.accountId !== accountId) return null
      const record = await this.#client.maxRawTransportProcessing.findUnique({
        where: { observationId_parserVersion: { observationId, parserVersion } },
      })
      return record ? mapProcessing(record) : null
    } catch (error) {
      throw asJournalDatabaseError(error)
    }
  }

  async advanceCursor(input: AdvanceCursorInput): Promise<ConsumerCursor> {
    required(input.consumerId, 'consumerId')
    required(input.accountId, 'accountId')
    required(input.parserVersion, 'parserVersion')
    if (input.lastJournalSequence < 0n) throw new JournalError('INVALID_INPUT', 'Cursor position must be non-negative')
    nonNegativeInteger(input.expectedVersion, 'expectedVersion')
    try {
      return await this.#client.$transaction(async transaction => {
        const key = {
          consumerId_accountId_parserVersion: {
            consumerId: input.consumerId,
            accountId: input.accountId,
            parserVersion: input.parserVersion,
          },
        }
        const current = await transaction.maxRawTransportCursor.findUnique({ where: key })
        if (!current) {
          if (input.expectedVersion !== 0) throw new JournalError('CURSOR_CONFLICT', 'Cursor version conflict')
          return mapCursor(await transaction.maxRawTransportCursor.create({
            data: {
              id: this.#idGenerator(),
              consumerId: input.consumerId,
              accountId: input.accountId,
              parserVersion: input.parserVersion,
              lastJournalSequence: input.lastJournalSequence,
              version: 1,
            },
          }))
        }
        if (input.lastJournalSequence < current.lastJournalSequence) {
          throw new JournalError('CURSOR_CONFLICT', 'Cursor cannot move backwards')
        }
        const result = await transaction.maxRawTransportCursor.updateMany({
          where: { id: current.id, version: input.expectedVersion },
          data: { lastJournalSequence: input.lastJournalSequence, version: { increment: 1 } },
        })
        if (result.count !== 1) throw new JournalError('CURSOR_CONFLICT', 'Cursor version conflict')
        const updated = await transaction.maxRawTransportCursor.findUnique({ where: key })
        if (!updated) throw new JournalError('NOT_FOUND', 'Cursor not found after update')
        return mapCursor(updated)
      })
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        throw new JournalError('CURSOR_CONFLICT', 'Cursor was created concurrently')
      }
      throw asJournalDatabaseError(error)
    }
  }

  async getCursor(consumerId: string, accountId: string, parserVersion: string): Promise<ConsumerCursor | null> {
    required(consumerId, 'consumerId')
    required(accountId, 'accountId')
    required(parserVersion, 'parserVersion')
    try {
      const record = await this.#client.maxRawTransportCursor.findUnique({
        where: { consumerId_accountId_parserVersion: { consumerId, accountId, parserVersion } },
      })
      return record ? mapCursor(record) : null
    } catch (error) {
      throw asJournalDatabaseError(error)
    }
  }
}
