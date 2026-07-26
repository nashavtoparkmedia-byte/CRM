import type { JsonValue, RedactionEvidence } from '../../src/journal/types.ts'
import type {
  RouteRegistryPrismaClient,
  RouteRegistryPrismaTransaction,
} from '../../src/route/PrismaRouteRegistry.ts'

export interface FakeRouteConversationRow {
  id: string
  accountId: string
  conversationKey: string
  routeVersion: number
  optimisticVersion: number
  state: string
  retiredAt: Date | null
  retiredBy: string | null
  retirementReason: string | null
  createdAt: Date
  updatedAt: Date
}

export interface FakeRouteIdentityRow {
  id: string
  accountId: string
  identityKind: string
  identityValue: string
  conversationKey: string
  status: string
  firstSeenAt: Date
  lastSeenAt: Date
  evidenceRef: string
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface FakeRouteObservationRow {
  routeObservationId: string
  accountId: string
  idempotencyKey: string
  sourceRawObservationId: string | null
  extractorVersion: string
  observedAt: Date
  evidenceSource: string
  evidenceAuthority: string
  candidateConversationKey: string | null
  identityKind: string
  identityValue: string
  sanitizedEvidence: JsonValue
  evidenceSha256: string
  evidenceSizeBytes: number
  evidenceQuarantined: boolean
  redactionMetadata: RedactionEvidence
  processingResult: string
  routeVersionAfter: number | null
  createdAt: Date
}

export interface FakeRouteConflictRow {
  conflictId: string
  accountId: string
  identityKind: string
  identityValue: string
  incumbentConversationKey: string
  candidateConversationKey: string
  sourceRouteObservationId: string
  status: string
  expectedRouteVersion: number
  version: number
  createdAt: Date
  resolvedAt: Date | null
  resolutionReason: string | null
  resolvedBy: string | null
  auditMetadata: JsonValue | null
}

interface FakeRawRow {
  observationId: string
  accountId: string
}

export interface FakeRouteStore {
  conversations: FakeRouteConversationRow[]
  identities: FakeRouteIdentityRow[]
  observations: FakeRouteObservationRow[]
  conflicts: FakeRouteConflictRow[]
  raw: FakeRawRow[]
  clock: number
}

export interface FakeRouteFailurePlan {
  conversationUpdate: boolean
  identityCreate: boolean
  identityUpdate: boolean
  observationCreate: boolean
  conflictCreate: boolean
  conflictUpdate: boolean
}

const NO_FAILURES: FakeRouteFailurePlan = {
  conversationUpdate: false,
  identityCreate: false,
  identityUpdate: false,
  observationCreate: false,
  conflictCreate: false,
  conflictUpdate: false,
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function composite(where: Record<string, unknown>, name: string): Record<string, unknown> {
  return where[name] as Record<string, unknown>
}

function stringValue(data: Record<string, unknown>, name: string): string {
  return String(data[name])
}

function optionalString(data: Record<string, unknown>, name: string): string | null {
  return data[name] === undefined || data[name] === null ? null : String(data[name])
}

function nextTime(store: FakeRouteStore): Date {
  const value = new Date(Date.UTC(2026, 6, 26, 19, 0, 0, store.clock))
  store.clock += 1
  return value
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') {
      return (expected as Record<string, unknown>[]).some(candidate => matches(row, candidate))
    }
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
      const operation = expected as Record<string, unknown>
      if ('gt' in operation) return String(row[key]) > String(operation.gt)
    }
    return row[key] === expected
  })
}

function applyData(row: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown> {
  const updated: Record<string, unknown> = clone(row)
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && 'increment' in value) {
      updated[key] = Number(updated[key]) + Number((value as { increment: unknown }).increment)
    } else {
      updated[key] = clone(value)
    }
  }
  return updated
}

function makeTransaction(store: FakeRouteStore, failures: FakeRouteFailurePlan): RouteRegistryPrismaTransaction {
  return {
    maxRouteConversation: {
      async create({ data }) {
        const accountId = stringValue(data, 'accountId')
        const key = stringValue(data, 'conversationKey')
        if (store.conversations.some(row => row.accountId === accountId && row.conversationKey === key)) {
          throw new Error('synthetic conversation unique violation')
        }
        const now = nextTime(store)
        const row: FakeRouteConversationRow = {
          id: stringValue(data, 'id'),
          accountId,
          conversationKey: key,
          routeVersion: Number(data.routeVersion ?? 0),
          optimisticVersion: Number(data.optimisticVersion ?? 0),
          state: String(data.state ?? 'unresolved'),
          retiredAt: null,
          retiredBy: null,
          retirementReason: null,
          createdAt: now,
          updatedAt: now,
        }
        store.conversations.push(row)
        return clone(row)
      },
      async findUnique({ where }) {
        const key = composite(where, 'accountId_conversationKey')
        const row = store.conversations.find(item =>
          item.accountId === key.accountId && item.conversationKey === key.conversationKey)
        return row ? clone(row) : null
      },
      async updateMany({ where, data }) {
        if (failures.conversationUpdate) throw new Error('synthetic conversation update failure')
        const indexes = store.conversations
          .map((row, index) => matches(row as unknown as Record<string, unknown>, where) ? index : -1)
          .filter(index => index >= 0)
        for (const index of indexes) {
          const current = store.conversations[index]!
          store.conversations[index] = {
            ...applyData(current as unknown as Record<string, unknown>, data) as unknown as FakeRouteConversationRow,
            updatedAt: nextTime(store),
          }
        }
        return { count: indexes.length }
      },
    },
    maxRouteIdentityBinding: {
      async create({ data }) {
        if (failures.identityCreate) throw new Error('synthetic identity insert failure')
        const accountId = stringValue(data, 'accountId')
        const identityKind = stringValue(data, 'identityKind')
        const identityValue = stringValue(data, 'identityValue')
        const key = stringValue(data, 'conversationKey')
        if (!store.conversations.some(row => row.accountId === accountId && row.conversationKey === key)) {
          throw new Error('synthetic account-scoped conversation FK violation')
        }
        if (store.identities.some(row => row.accountId === accountId
          && row.identityKind === identityKind && row.identityValue === identityValue)) {
          throw new Error('synthetic account identity unique violation')
        }
        const status = String(data.status ?? 'provisional')
        if (status === 'active' && store.identities.some(row => row.accountId === accountId
          && row.conversationKey === key && row.identityKind === identityKind && row.status === 'active')) {
          throw new Error('synthetic active route identity kind unique violation')
        }
        const now = nextTime(store)
        const row: FakeRouteIdentityRow = {
          id: stringValue(data, 'id'),
          accountId,
          identityKind,
          identityValue,
          conversationKey: key,
          status,
          firstSeenAt: data.firstSeenAt as Date,
          lastSeenAt: data.lastSeenAt as Date,
          evidenceRef: stringValue(data, 'evidenceRef'),
          version: Number(data.version ?? 0),
          createdAt: now,
          updatedAt: now,
        }
        store.identities.push(row)
        return clone(row)
      },
      async findUnique({ where }) {
        const key = composite(where, 'accountId_identityKind_identityValue')
        const row = store.identities.find(item => item.accountId === key.accountId
          && item.identityKind === key.identityKind && item.identityValue === key.identityValue)
        return row ? clone(row) : null
      },
      async findMany({ where, orderBy }) {
        const rows = store.identities.filter(row => matches(row as unknown as Record<string, unknown>, where))
        if (orderBy?.identityKind) rows.sort((left, right) => left.identityKind.localeCompare(right.identityKind))
        return clone(rows)
      },
      async updateMany({ where, data }) {
        if (failures.identityUpdate) throw new Error('synthetic identity update failure')
        const indexes = store.identities
          .map((row, index) => matches(row as unknown as Record<string, unknown>, where) ? index : -1)
          .filter(index => index >= 0)
        for (const index of indexes) {
          const current = store.identities[index]!
          const updated = applyData(current as unknown as Record<string, unknown>, data) as unknown as FakeRouteIdentityRow
          if (!store.conversations.some(row => row.accountId === updated.accountId
            && row.conversationKey === updated.conversationKey)) {
            throw new Error('synthetic account-scoped conversation FK violation')
          }
          if (updated.status === 'active' && store.identities.some((row, otherIndex) => otherIndex !== index
            && row.accountId === updated.accountId && row.conversationKey === updated.conversationKey
            && row.identityKind === updated.identityKind && row.status === 'active')) {
            throw new Error('synthetic active route identity kind unique violation')
          }
          store.identities[index] = { ...updated, updatedAt: nextTime(store) }
        }
        return { count: indexes.length }
      },
    },
    maxRouteObservation: {
      async create({ data }) {
        if (failures.observationCreate) throw new Error('synthetic observation insert failure')
        const accountId = stringValue(data, 'accountId')
        const idempotencyKey = stringValue(data, 'idempotencyKey')
        const routeObservationId = stringValue(data, 'routeObservationId')
        if (store.observations.some(row => row.accountId === accountId && row.idempotencyKey === idempotencyKey)) {
          throw new Error('synthetic observation idempotency unique violation')
        }
        if (store.observations.some(row => row.routeObservationId === routeObservationId)) {
          throw new Error('synthetic observation primary key violation')
        }
        const sourceRawObservationId = optionalString(data, 'sourceRawObservationId')
        if (sourceRawObservationId && !store.raw.some(row =>
          row.accountId === accountId && row.observationId === sourceRawObservationId)) {
          throw new Error('synthetic account-scoped raw FK violation')
        }
        const candidateConversationKey = optionalString(data, 'candidateConversationKey')
        if (candidateConversationKey && !store.conversations.some(row =>
          row.accountId === accountId && row.conversationKey === candidateConversationKey)) {
          throw new Error('synthetic account-scoped candidate FK violation')
        }
        const row: FakeRouteObservationRow = {
          routeObservationId,
          accountId,
          idempotencyKey,
          sourceRawObservationId,
          extractorVersion: stringValue(data, 'extractorVersion'),
          observedAt: data.observedAt as Date,
          evidenceSource: stringValue(data, 'evidenceSource'),
          evidenceAuthority: stringValue(data, 'evidenceAuthority'),
          candidateConversationKey,
          identityKind: stringValue(data, 'identityKind'),
          identityValue: stringValue(data, 'identityValue'),
          sanitizedEvidence: clone(data.sanitizedEvidence as JsonValue),
          evidenceSha256: stringValue(data, 'evidenceSha256'),
          evidenceSizeBytes: Number(data.evidenceSizeBytes),
          evidenceQuarantined: Boolean(data.evidenceQuarantined),
          redactionMetadata: clone(data.redactionMetadata as RedactionEvidence),
          processingResult: stringValue(data, 'processingResult'),
          routeVersionAfter: data.routeVersionAfter === undefined || data.routeVersionAfter === null
            ? null : Number(data.routeVersionAfter),
          createdAt: nextTime(store),
        }
        store.observations.push(row)
        return clone(row)
      },
      async findUnique({ where }) {
        const key = composite(where, 'accountId_idempotencyKey')
        const row = store.observations.find(item =>
          item.accountId === key.accountId && item.idempotencyKey === key.idempotencyKey)
        return row ? clone(row) : null
      },
    },
    maxRouteConflict: {
      async create({ data }) {
        if (failures.conflictCreate) throw new Error('synthetic conflict insert failure')
        const accountId = stringValue(data, 'accountId')
        const sourceRouteObservationId = stringValue(data, 'sourceRouteObservationId')
        if (store.conflicts.some(row => row.accountId === accountId
          && row.sourceRouteObservationId === sourceRouteObservationId)) {
          throw new Error('synthetic conflict source unique violation')
        }
        if (!store.observations.some(row => row.accountId === accountId
          && row.routeObservationId === sourceRouteObservationId)) {
          throw new Error('synthetic account-scoped observation FK violation')
        }
        for (const field of ['incumbentConversationKey', 'candidateConversationKey']) {
          if (!store.conversations.some(row => row.accountId === accountId
            && row.conversationKey === data[field])) {
            throw new Error('synthetic account-scoped conflict route FK violation')
          }
        }
        const row: FakeRouteConflictRow = {
          conflictId: stringValue(data, 'conflictId'),
          accountId,
          identityKind: stringValue(data, 'identityKind'),
          identityValue: stringValue(data, 'identityValue'),
          incumbentConversationKey: stringValue(data, 'incumbentConversationKey'),
          candidateConversationKey: stringValue(data, 'candidateConversationKey'),
          sourceRouteObservationId,
          status: String(data.status ?? 'open'),
          expectedRouteVersion: Number(data.expectedRouteVersion),
          version: Number(data.version ?? 0),
          createdAt: nextTime(store),
          resolvedAt: null,
          resolutionReason: null,
          resolvedBy: null,
          auditMetadata: null,
        }
        store.conflicts.push(row)
        return clone(row)
      },
      async findUnique({ where }) {
        let row: FakeRouteConflictRow | undefined
        if ('conflictId' in where) row = store.conflicts.find(item => item.conflictId === where.conflictId)
        else {
          const key = composite(where, 'accountId_sourceRouteObservationId')
          row = store.conflicts.find(item => item.accountId === key.accountId
            && item.sourceRouteObservationId === key.sourceRouteObservationId)
        }
        return row ? clone(row) : null
      },
      async findMany({ where, orderBy, take }) {
        const rows = store.conflicts.filter(row => matches(row as unknown as Record<string, unknown>, where))
        if (orderBy?.conflictId) rows.sort((left, right) => left.conflictId.localeCompare(right.conflictId))
        return clone(take === undefined ? rows : rows.slice(0, take))
      },
      async updateMany({ where, data }) {
        if (failures.conflictUpdate) throw new Error('synthetic conflict update failure')
        const indexes = store.conflicts
          .map((row, index) => matches(row as unknown as Record<string, unknown>, where) ? index : -1)
          .filter(index => index >= 0)
        for (const index of indexes) {
          store.conflicts[index] = applyData(
            store.conflicts[index] as unknown as Record<string, unknown>,
            data,
          ) as unknown as FakeRouteConflictRow
        }
        return { count: indexes.length }
      },
    },
    maxRawTransportEvent: {
      async findUnique({ where }) {
        const row = store.raw.find(item => item.observationId === where.observationId)
        return row ? clone(row) : null
      },
    },
  }
}

export class FakeRoutePrismaClient implements RouteRegistryPrismaClient {
  #store: FakeRouteStore = {
    conversations: [], identities: [], observations: [], conflicts: [], raw: [], clock: 0,
  }
  #failures: FakeRouteFailurePlan = { ...NO_FAILURES }

  get maxRouteConversation(): RouteRegistryPrismaTransaction['maxRouteConversation'] {
    return makeTransaction(this.#store, this.#failures).maxRouteConversation
  }

  get maxRouteIdentityBinding(): RouteRegistryPrismaTransaction['maxRouteIdentityBinding'] {
    return makeTransaction(this.#store, this.#failures).maxRouteIdentityBinding
  }

  get maxRouteObservation(): RouteRegistryPrismaTransaction['maxRouteObservation'] {
    return makeTransaction(this.#store, this.#failures).maxRouteObservation
  }

  get maxRouteConflict(): RouteRegistryPrismaTransaction['maxRouteConflict'] {
    return makeTransaction(this.#store, this.#failures).maxRouteConflict
  }

  get maxRawTransportEvent(): RouteRegistryPrismaTransaction['maxRawTransportEvent'] {
    return makeTransaction(this.#store, this.#failures).maxRawTransportEvent
  }

  async $transaction<T>(operation: (transaction: RouteRegistryPrismaTransaction) => Promise<T>): Promise<T> {
    const working = clone(this.#store)
    const result = await operation(makeTransaction(working, this.#failures))
    this.#store = working
    return result
  }

  addRawObservation(accountId: string, observationId: string): void {
    this.#store.raw.push({ accountId, observationId })
  }

  unsafeInjectIdentityForCorruptionTest(row: FakeRouteIdentityRow): void {
    this.#store.identities.push(clone(row))
  }

  setFailures(failures: Partial<FakeRouteFailurePlan>): void {
    this.#failures = { ...NO_FAILURES, ...failures }
  }

  snapshot(): Readonly<FakeRouteStore> {
    return clone(this.#store)
  }
}
