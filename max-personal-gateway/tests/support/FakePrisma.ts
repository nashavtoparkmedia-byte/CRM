import type { JsonValue, RedactionEvidence } from '../../src/journal/types.ts'
import type { RawJournalPrismaClient, RawJournalPrismaTransaction } from '../../src/journal/PrismaRawEventJournal.ts'

interface RawRow {
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

interface ProcessingRow {
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

interface CursorRow {
  id: string
  consumerId: string
  accountId: string
  parserVersion: string
  lastJournalSequence: bigint
  version: number
  updatedAt: Date
}

interface Store {
  raw: RawRow[]
  processing: ProcessingRow[]
  cursors: CursorRow[]
  sequence: bigint
}

interface FailurePlan {
  failRawCreate: boolean
  failProcessingCreate: boolean
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function stringValue(data: Record<string, unknown>, key: string): string {
  return String(data[key])
}

function nullableString(data: Record<string, unknown>, key: string): string | null {
  return data[key] === undefined || data[key] === null ? null : String(data[key])
}

function composite(where: Record<string, unknown>, key: string): Record<string, unknown> {
  return where[key] as Record<string, unknown>
}

function makeTransaction(store: Store, failures: FailurePlan): RawJournalPrismaTransaction {
  return {
    maxRawTransportEvent: {
      async create({ data }) {
        if (failures.failRawCreate) throw new Error('synthetic raw insert failure')
        store.sequence += 1n
        const row: RawRow = {
          observationId: stringValue(data, 'observationId'),
          journalSequence: store.sequence,
          accountId: stringValue(data, 'accountId'),
          observedAt: data.observedAt as Date,
          persistedAt: new Date('2026-07-26T00:00:00.000Z'),
          sourceTransport: stringValue(data, 'sourceTransport'),
          sourceOrigin: stringValue(data, 'sourceOrigin'),
          historyLive: stringValue(data, 'historyLive'),
          socketGeneration: nullableString(data, 'socketGeneration'),
          frameId: nullableString(data, 'frameId'),
          providerEventId: nullableString(data, 'providerEventId'),
          transportSequence: nullableString(data, 'transportSequence'),
          opcode: data.opcode === undefined ? null : Number(data.opcode),
          eventType: nullableString(data, 'eventType'),
          payloadEncoding: stringValue(data, 'payloadEncoding'),
          sanitizedPayload: clone(data.sanitizedPayload as JsonValue),
          payloadSha256: stringValue(data, 'payloadSha256'),
          payloadSizeBytes: Number(data.payloadSizeBytes),
          replayAvailability: stringValue(data, 'replayAvailability'),
          quarantineReason: nullableString(data, 'quarantineReason'),
          sanitizerVersion: stringValue(data, 'sanitizerVersion'),
          captureAdapterVersion: stringValue(data, 'captureAdapterVersion'),
          schemaVersion: Number(data.schemaVersion),
          correlationMetadata: data.correlationMetadata === undefined ? null : clone(data.correlationMetadata as JsonValue),
          redactionMetadata: clone(data.redactionMetadata as RedactionEvidence),
          quarantineEligible: Boolean(data.quarantineEligible),
        }
        store.raw.push(row)
        return clone(row)
      },
      async findMany({ where, take }) {
        const accountId = String(where.accountId)
        const cursor = ((where.journalSequence as Record<string, unknown>).gt as bigint)
        return store.raw
          .filter(row => row.accountId === accountId && row.journalSequence > cursor)
          .sort((left, right) => left.journalSequence < right.journalSequence ? -1 : 1)
          .slice(0, take)
          .map(clone)
      },
      async findUnique({ where }) {
        const observationId = String(where.observationId)
        return clone(store.raw.find(row => row.observationId === observationId) ?? null)
      },
    },
    maxRawTransportProcessing: {
      async create({ data }) {
        if (failures.failProcessingCreate) throw new Error('synthetic processing insert failure')
        const duplicate = store.processing.some(row =>
          row.observationId === String(data.observationId) && row.parserVersion === String(data.parserVersion))
        if (duplicate) throw new Error('synthetic unique processing constraint')
        const row: ProcessingRow = {
          id: stringValue(data, 'id'),
          observationId: stringValue(data, 'observationId'),
          parserVersion: stringValue(data, 'parserVersion'),
          state: String(data.state ?? 'pending'),
          attempts: 0,
          claimedBy: null,
          claimedAt: null,
          leaseUntil: null,
          leaseVersion: 0,
          completedAt: null,
          lastErrorCode: null,
          lastErrorSummary: null,
          quarantineReason: nullableString(data, 'quarantineReason'),
          replayMetadata: data.replayMetadata === undefined ? null : clone(data.replayMetadata as JsonValue),
        }
        store.processing.push(row)
        return clone(row)
      },
      async upsert({ where, create }) {
        const key = composite(where, 'observationId_parserVersion')
        const found = store.processing.find(row =>
          row.observationId === String(key.observationId) && row.parserVersion === String(key.parserVersion))
        if (found) return clone(found)
        return this.create({ data: create })
      },
      async updateMany({ where, data }) {
        const rawAccount = (where.rawObservation as Record<string, unknown> | undefined)?.accountId
        const now = ((where.OR as Array<Record<string, unknown>> | undefined)?.find(condition => condition.leaseUntil)?.leaseUntil as Record<string, Date> | undefined)?.lt
        const allowedWorker = (where.OR as Array<Record<string, unknown>> | undefined)?.find(condition => condition.claimedBy)?.claimedBy
        const allowPending = (where.OR as Array<Record<string, unknown>> | undefined)?.some(condition => condition.state === 'pending') ?? false
        const row = store.processing.find(candidate => {
          if (where.observationId !== undefined && candidate.observationId !== String(where.observationId)) return false
          if (where.parserVersion !== undefined && candidate.parserVersion !== String(where.parserVersion)) return false
          if (where.claimedBy !== undefined && candidate.claimedBy !== String(where.claimedBy)) return false
          if (where.leaseVersion !== undefined && candidate.leaseVersion !== Number(where.leaseVersion)) return false
          if (rawAccount !== undefined) {
            const raw = store.raw.find(item => item.observationId === candidate.observationId)
            if (raw?.accountId !== String(rawAccount)) return false
          }
          if (where.OR !== undefined) {
            return (allowPending && candidate.state === 'pending')
              || (now !== undefined && candidate.leaseUntil !== null && candidate.leaseUntil < now)
              || (allowedWorker !== undefined && candidate.claimedBy === String(allowedWorker))
          }
          return true
        })
        if (!row) return { count: 0 }
        for (const [key, value] of Object.entries(data)) {
          if (value === undefined) continue
          if (key === 'attempts' || key === 'leaseVersion') {
            const increment = Number((value as Record<string, unknown>).increment)
            row[key] += increment
          } else {
            ;(row as unknown as Record<string, unknown>)[key] = clone(value)
          }
        }
        return { count: 1 }
      },
      async findUnique({ where }) {
        const key = composite(where, 'observationId_parserVersion')
        return clone(store.processing.find(row =>
          row.observationId === String(key.observationId) && row.parserVersion === String(key.parserVersion)) ?? null)
      },
    },
    maxRawTransportCursor: {
      async create({ data }) {
        const row: CursorRow = {
          id: stringValue(data, 'id'),
          consumerId: stringValue(data, 'consumerId'),
          accountId: stringValue(data, 'accountId'),
          parserVersion: stringValue(data, 'parserVersion'),
          lastJournalSequence: data.lastJournalSequence as bigint,
          version: Number(data.version),
          updatedAt: new Date('2026-07-26T00:00:00.000Z'),
        }
        store.cursors.push(row)
        return clone(row)
      },
      async updateMany({ where, data }) {
        const row = store.cursors.find(candidate => candidate.id === String(where.id) && candidate.version === Number(where.version))
        if (!row) return { count: 0 }
        row.lastJournalSequence = data.lastJournalSequence as bigint
        row.version += Number((data.version as Record<string, unknown>).increment)
        row.updatedAt = new Date('2026-07-26T00:00:01.000Z')
        return { count: 1 }
      },
      async findUnique({ where }) {
        const key = composite(where, 'consumerId_accountId_parserVersion')
        return clone(store.cursors.find(row => row.consumerId === String(key.consumerId)
          && row.accountId === String(key.accountId)
          && row.parserVersion === String(key.parserVersion)) ?? null)
      },
    },
  }
}

export class FakePrismaClient implements RawJournalPrismaClient {
  #store: Store = { raw: [], processing: [], cursors: [], sequence: 0n }
  readonly #failures: FailurePlan = { failRawCreate: false, failProcessingCreate: false }

  get maxRawTransportEvent() { return makeTransaction(this.#store, this.#failures).maxRawTransportEvent }
  get maxRawTransportProcessing() { return makeTransaction(this.#store, this.#failures).maxRawTransportProcessing }
  get maxRawTransportCursor() { return makeTransaction(this.#store, this.#failures).maxRawTransportCursor }

  async $transaction<T>(operation: (transaction: RawJournalPrismaTransaction) => Promise<T>): Promise<T> {
    const candidate = clone(this.#store)
    const result = await operation(makeTransaction(candidate, this.#failures))
    this.#store = candidate
    return result
  }

  failNextRawCreate(): void {
    this.#failures.failRawCreate = true
  }

  failNextProcessingCreate(): void {
    this.#failures.failProcessingCreate = true
  }

  clearFailures(): void {
    this.#failures.failRawCreate = false
    this.#failures.failProcessingCreate = false
  }

  rawRows(): readonly RawRow[] {
    return clone(this.#store.raw)
  }

  processingRows(): readonly ProcessingRow[] {
    return clone(this.#store.processing)
  }
}
