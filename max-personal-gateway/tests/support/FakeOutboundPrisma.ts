import type {
  OutboundActorPrismaClient,
  OutboundActorPrismaTransaction,
} from '../../src/outbound/PrismaPerConversationOutboundActor.ts'
import type { JsonValue } from '../../src/journal/types.ts'

export interface FakeOutboundCommandRow {
  commandId: string
  accountId: string
  conversationKey: string
  clientMessageId: string | null
  commandSequence: number
  commandKind: string
  envelopeVersion: string
  commandPayload: JsonValue
  payloadSha256: string
  source: string
  createdAt: Date
}

export interface FakeOutboundActorRow {
  accountId: string
  conversationKey: string
  nextCommandSequence: number
  nextHandoffSequence: number
  leaseOwnerId: string | null
  leaseEpoch: number
  leaseUntil: Date | null
  optimisticVersion: number
  createdAt: Date
  updatedAt: Date
}

export interface FakeOutboundReservationRow {
  reservationId: string
  accountId: string
  conversationKey: string
  commandId: string
  commandSequence: number
  leaseOwnerId: string
  leaseEpoch: number
  reservationState: string
  reservationVersion: number
  reservedAt: Date
  leaseUntil: Date
  releasedAt: Date | null
  handoffReference: string | null
  handedOffAt: Date | null
  createdAt: Date
  updatedAt: Date
}

interface FakeOutboundStore {
  conversations: Array<{ accountId: string; conversationKey: string }>
  commands: FakeOutboundCommandRow[]
  actors: FakeOutboundActorRow[]
  reservations: FakeOutboundReservationRow[]
  clock: number
}

interface FailurePlan {
  commandCreate: boolean
  actorUpdate: boolean
  reservationCreate: boolean
  reservationUpdate: boolean
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function uniqueError(): Error & { code: string } {
  return Object.assign(new Error('synthetic unique violation'), { code: 'P2002' })
}

function time(store: FakeOutboundStore): Date {
  const result = new Date(Date.UTC(2026, 6, 26, 22, 0, 0, store.clock))
  store.clock += 1
  return result
}

function composite(where: Record<string, unknown>, key: string): Record<string, unknown> {
  return where[key] as Record<string, unknown>
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
      const operation = expected as Record<string, unknown>
      if ('gt' in operation) return (row[key] as Date | number) > (operation.gt as Date | number)
      if ('gte' in operation) return (row[key] as Date | number) >= (operation.gte as Date | number)
      if ('lt' in operation) return (row[key] as Date | number) < (operation.lt as Date | number)
      if ('lte' in operation) return (row[key] as Date | number) <= (operation.lte as Date | number)
    }
    return row[key] === expected
  })
}

function apply(row: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown> {
  const updated = clone(row)
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && 'increment' in value) {
      updated[key] = Number(updated[key]) + Number((value as { increment: unknown }).increment)
    } else {
      updated[key] = clone(value)
    }
  }
  return updated
}

function actorKey(where: Record<string, unknown>): { accountId: string; conversationKey: string } {
  const key = composite(where, 'accountId_conversationKey')
  return { accountId: String(key.accountId), conversationKey: String(key.conversationKey) }
}

function makeTransaction(store: FakeOutboundStore, failure: FailurePlan): OutboundActorPrismaTransaction {
  return {
    maxRouteConversation: {
      async findUnique({ where }) {
        const key = actorKey(where)
        return clone(store.conversations.find(row => row.accountId === key.accountId && row.conversationKey === key.conversationKey) ?? null)
      },
    },
    maxOutboundCommand: {
      async create({ data }) {
        if (failure.commandCreate) {
          failure.commandCreate = false
          throw new Error('synthetic command insert failure')
        }
        const commandId = String(data.commandId)
        const accountId = String(data.accountId)
        const conversationKey = String(data.conversationKey)
        const clientMessageId = data.clientMessageId === null ? null : String(data.clientMessageId)
        const commandSequence = Number(data.commandSequence)
        if (store.commands.some(row => row.commandId === commandId)) throw uniqueError()
        if (store.commands.some(row => row.accountId === accountId && row.conversationKey === conversationKey
          && row.commandSequence === commandSequence)) throw uniqueError()
        if (clientMessageId !== null && store.commands.some(row => row.accountId === accountId
          && row.clientMessageId === clientMessageId)) throw uniqueError()
        if (!store.conversations.some(row => row.accountId === accountId && row.conversationKey === conversationKey)) {
          throw new Error('synthetic route conversation FK violation')
        }
        const row: FakeOutboundCommandRow = {
          commandId,
          accountId,
          conversationKey,
          clientMessageId,
          commandSequence,
          commandKind: String(data.commandKind),
          envelopeVersion: String(data.envelopeVersion),
          commandPayload: clone(data.commandPayload as JsonValue),
          payloadSha256: String(data.payloadSha256),
          source: String(data.source),
          createdAt: time(store),
        }
        store.commands.push(row)
        return clone(row)
      },
      async findUnique({ where }) {
        const row = typeof where.commandId === 'string'
          ? store.commands.find(item => item.commandId === where.commandId)
          : undefined
        return clone(row ?? null)
      },
      async findFirst({ where }) {
        return clone(store.commands.find(row => matches(row as unknown as Record<string, unknown>, where)) ?? null)
      },
      async findMany({ where, orderBy, take }) {
        const rows = store.commands.filter(row => matches(row as unknown as Record<string, unknown>, where))
        if (orderBy?.commandSequence) rows.sort((a, b) => a.commandSequence - b.commandSequence)
        return clone(rows.slice(0, take))
      },
    },
    maxOutboundConversationActor: {
      async findUnique({ where }) {
        const key = actorKey(where)
        return clone(store.actors.find(row => row.accountId === key.accountId && row.conversationKey === key.conversationKey) ?? null)
      },
      async upsert({ where, create }) {
        const key = actorKey(where)
        const existing = store.actors.find(row => row.accountId === key.accountId && row.conversationKey === key.conversationKey)
        if (existing) return clone(existing)
        if (!store.conversations.some(row => row.accountId === key.accountId && row.conversationKey === key.conversationKey)) {
          throw new Error('synthetic actor route FK violation')
        }
        const now = time(store)
        const row: FakeOutboundActorRow = {
          accountId: String(create.accountId),
          conversationKey: String(create.conversationKey),
          nextCommandSequence: Number(create.nextCommandSequence ?? 0),
          nextHandoffSequence: Number(create.nextHandoffSequence ?? 1),
          leaseOwnerId: null,
          leaseEpoch: Number(create.leaseEpoch ?? 0),
          leaseUntil: null,
          optimisticVersion: Number(create.optimisticVersion ?? 0),
          createdAt: now,
          updatedAt: now,
        }
        store.actors.push(row)
        return clone(row)
      },
      async update({ where, data }) {
        if (failure.actorUpdate) {
          failure.actorUpdate = false
          throw new Error('synthetic actor update failure')
        }
        const key = actorKey(where)
        const index = store.actors.findIndex(row => row.accountId === key.accountId && row.conversationKey === key.conversationKey)
        if (index < 0) throw new Error('synthetic actor missing')
        store.actors[index] = {
          ...apply(store.actors[index] as unknown as Record<string, unknown>, data) as unknown as FakeOutboundActorRow,
          updatedAt: time(store),
        }
        return clone(store.actors[index]!)
      },
      async updateMany({ where, data }) {
        if (failure.actorUpdate) {
          failure.actorUpdate = false
          throw new Error('synthetic actor update failure')
        }
        const indexes = store.actors.map((row, index) => matches(row as unknown as Record<string, unknown>, where) ? index : -1)
          .filter(index => index >= 0)
        for (const index of indexes) {
          store.actors[index] = {
            ...apply(store.actors[index] as unknown as Record<string, unknown>, data) as unknown as FakeOutboundActorRow,
            updatedAt: time(store),
          }
        }
        return { count: indexes.length }
      },
    },
    maxOutboundCommandReservation: {
      async create({ data }) {
        if (failure.reservationCreate) {
          failure.reservationCreate = false
          throw new Error('synthetic reservation insert failure')
        }
        const accountId = String(data.accountId)
        const conversationKey = String(data.conversationKey)
        const commandId = String(data.commandId)
        if (store.reservations.some(row => row.reservationId === data.reservationId)) throw uniqueError()
        if (store.reservations.some(row => row.accountId === accountId && row.conversationKey === conversationKey
          && row.reservationState === 'reserved')) throw uniqueError()
        if (!store.commands.some(row => row.accountId === accountId && row.conversationKey === conversationKey
          && row.commandId === commandId && row.commandSequence === data.commandSequence)) {
          throw new Error('synthetic reservation command FK violation')
        }
        const now = time(store)
        const row: FakeOutboundReservationRow = {
          reservationId: String(data.reservationId),
          accountId,
          conversationKey,
          commandId,
          commandSequence: Number(data.commandSequence),
          leaseOwnerId: String(data.leaseOwnerId),
          leaseEpoch: Number(data.leaseEpoch),
          reservationState: String(data.reservationState),
          reservationVersion: Number(data.reservationVersion ?? 0),
          reservedAt: data.reservedAt as Date,
          leaseUntil: data.leaseUntil as Date,
          releasedAt: null,
          handoffReference: null,
          handedOffAt: null,
          createdAt: now,
          updatedAt: now,
        }
        store.reservations.push(row)
        return clone(row)
      },
      async findUnique({ where }) {
        return clone(store.reservations.find(row => row.reservationId === where.reservationId) ?? null)
      },
      async findFirst({ where }) {
        return clone(store.reservations.find(row => matches(row as unknown as Record<string, unknown>, where)) ?? null)
      },
      async updateMany({ where, data }) {
        if (failure.reservationUpdate) {
          failure.reservationUpdate = false
          throw new Error('synthetic reservation update failure')
        }
        const indexes = store.reservations.map((row, index) => matches(row as unknown as Record<string, unknown>, where) ? index : -1)
          .filter(index => index >= 0)
        for (const index of indexes) {
          store.reservations[index] = {
            ...apply(store.reservations[index] as unknown as Record<string, unknown>, data) as unknown as FakeOutboundReservationRow,
            updatedAt: time(store),
          }
        }
        return { count: indexes.length }
      },
    },
  }
}

export class FakeOutboundPrisma implements OutboundActorPrismaClient {
  #store: FakeOutboundStore = { conversations: [], commands: [], actors: [], reservations: [], clock: 0 }
  readonly #failure: FailurePlan = {
    commandCreate: false,
    actorUpdate: false,
    reservationCreate: false,
    reservationUpdate: false,
  }

  get maxRouteConversation() { return makeTransaction(this.#store, this.#failure).maxRouteConversation }
  get maxOutboundCommand() { return makeTransaction(this.#store, this.#failure).maxOutboundCommand }
  get maxOutboundConversationActor() { return makeTransaction(this.#store, this.#failure).maxOutboundConversationActor }
  get maxOutboundCommandReservation() { return makeTransaction(this.#store, this.#failure).maxOutboundCommandReservation }

  async $transaction<T>(operation: (transaction: OutboundActorPrismaTransaction) => Promise<T>): Promise<T> {
    const draft = clone(this.#store)
    const result = await operation(makeTransaction(draft, this.#failure))
    this.#store = draft
    return result
  }

  seedConversation(accountId: string, conversationKey: string): void {
    this.#store.conversations.push({ accountId, conversationKey })
  }

  failNextCommandCreate(): void { this.#failure.commandCreate = true }
  failNextActorUpdate(): void { this.#failure.actorUpdate = true }
  failNextReservationCreate(): void { this.#failure.reservationCreate = true }
  failNextReservationUpdate(): void { this.#failure.reservationUpdate = true }
  commandRows(): FakeOutboundCommandRow[] { return clone(this.#store.commands) }
  actorRows(): FakeOutboundActorRow[] { return clone(this.#store.actors) }
  reservationRows(): FakeOutboundReservationRow[] { return clone(this.#store.reservations) }
}
