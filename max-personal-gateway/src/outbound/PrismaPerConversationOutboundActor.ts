import { createHash, randomUUID } from 'node:crypto'
import type { JsonValue } from '../journal/types.ts'
import type { RouteRegistry } from '../route/RouteRegistry.ts'
import {
  DEFAULT_ACTOR_LEASE_MILLISECONDS,
  DEFAULT_RESERVATION_LEASE_MILLISECONDS,
  MAX_OUTBOUND_PAGE_LIMIT,
  MAX_OUTBOUND_TEXT_BYTES,
  OUTBOUND_COMMAND_ENVELOPE_VERSION,
} from './constants.ts'
import { asOutboundDatabaseError, OutboundActorError, outboundErrorCode } from './errors.ts'
import type {
  AcquireActorLeaseInput,
  ActorLeaseMutationInput,
  EnqueueOutboundCommandInput,
  EnqueueOutboundCommandResult,
  ExpireReservationInput,
  HandoffResult,
  MarkReservationHandedOffInput,
  OutboundActorState,
  OutboundCommand,
  OutboundCommandPage,
  OutboundCommandReservation,
  OutboundCommandSource,
  PerConversationOutboundActor,
  PreparedOutboundCommand,
  PrepareReservedCommandInput,
  ReservationMutationInput,
  ReserveNextCommandInput,
  ReserveNextCommandResult,
} from './types.ts'

interface CommandRecord {
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

interface ActorRecord {
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

interface ReservationRecord {
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

interface RouteConversationRecord {
  accountId: string
  conversationKey: string
}

interface CommandDelegate {
  create(args: { data: Record<string, unknown> }): Promise<CommandRecord>
  findUnique(args: { where: Record<string, unknown> }): Promise<CommandRecord | null>
  findFirst(args: { where: Record<string, unknown> }): Promise<CommandRecord | null>
  findMany(args: {
    where: Record<string, unknown>
    orderBy?: Record<string, 'asc' | 'desc'>
    take?: number
  }): Promise<CommandRecord[]>
}

interface ActorDelegate {
  findUnique(args: { where: Record<string, unknown> }): Promise<ActorRecord | null>
  upsert(args: {
    where: Record<string, unknown>
    create: Record<string, unknown>
    update: Record<string, unknown>
  }): Promise<ActorRecord>
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<ActorRecord>
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
}

interface ReservationDelegate {
  create(args: { data: Record<string, unknown> }): Promise<ReservationRecord>
  findUnique(args: { where: Record<string, unknown> }): Promise<ReservationRecord | null>
  findFirst(args: { where: Record<string, unknown> }): Promise<ReservationRecord | null>
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
}

interface RouteConversationDelegate {
  findUnique(args: { where: Record<string, unknown> }): Promise<RouteConversationRecord | null>
}

export interface OutboundActorPrismaTransaction {
  readonly maxOutboundCommand: CommandDelegate
  readonly maxOutboundConversationActor: ActorDelegate
  readonly maxOutboundCommandReservation: ReservationDelegate
  readonly maxRouteConversation: RouteConversationDelegate
}

export interface OutboundActorPrismaClient extends OutboundActorPrismaTransaction {
  $transaction<T>(operation: (transaction: OutboundActorPrismaTransaction) => Promise<T>): Promise<T>
}

export interface PrismaPerConversationOutboundActorOptions {
  readonly idGenerator?: () => string
  readonly clock?: () => Date
  readonly actorLeaseMilliseconds?: number
  readonly reservationLeaseMilliseconds?: number
}

function required(value: unknown, field: string, maxLength = 256): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new OutboundActorError('INVALID_INPUT', `${field} is required`)
  if (value !== value.trim() || value.length > maxLength || /\p{Cc}/u.test(value)) {
    throw new OutboundActorError('INVALID_INPUT', `${field} is not an exact bounded identifier`)
  }
}

function validDate(value: unknown, field: string): asserts value is Date {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new OutboundActorError('INVALID_INPUT', `${field} must be a valid date`)
  }
}

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OutboundActorError('INVALID_INPUT', `${field} must be a nonnegative integer`)
  }
}

function positiveDuration(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new OutboundActorError('INVALID_INPUT', `${field} must be between 1 and 300000 milliseconds`)
  }
}

function commandPayload(text: string): { readonly kind: 'text'; readonly text: string } {
  if (typeof text !== 'string' || text.length === 0) {
    throw new OutboundActorError('INVALID_INPUT', 'Text command payload is required')
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_OUTBOUND_TEXT_BYTES) {
    throw new OutboundActorError('INVALID_INPUT', 'Text command payload exceeds the safe size limit')
  }
  return Object.freeze({ kind: 'text' as const, text })
}

function payloadHash(payload: { readonly kind: 'text'; readonly text: string }): string {
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
}

function commandKey(accountId: string, conversationKey: string): Record<string, unknown> {
  return { accountId_conversationKey: { accountId, conversationKey } }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function asCommand(record: CommandRecord): OutboundCommand {
  if (record.commandKind !== 'text') throw new OutboundActorError('DATABASE_FAILURE', 'Stored command kind is invalid')
  if (!['gravity', 'api', 'replay', 'synthetic_test'].includes(record.source)) {
    throw new OutboundActorError('DATABASE_FAILURE', 'Stored command source is invalid')
  }
  return deepFreeze({
    ...record,
    commandKind: 'text' as const,
    source: record.source as OutboundCommandSource,
  })
}

function asActor(record: ActorRecord): OutboundActorState {
  return deepFreeze({ ...record, physicalSendAuthorized: false as const })
}

function asReservation(record: ReservationRecord): OutboundCommandReservation {
  if (!['reserved', 'released', 'handed_off', 'expired'].includes(record.reservationState)) {
    throw new OutboundActorError('DATABASE_FAILURE', 'Stored reservation state is invalid')
  }
  return deepFreeze({
    ...record,
    reservationState: record.reservationState as OutboundCommandReservation['reservationState'],
  })
}

function sameSemanticCommand(record: CommandRecord, input: EnqueueOutboundCommandInput, payload: JsonValue, hash: string): boolean {
  return record.accountId === input.accountId
    && record.conversationKey === input.conversationKey
    && record.commandKind === input.commandKind
    && record.clientMessageId === (input.clientMessageId ?? null)
    && record.envelopeVersion === OUTBOUND_COMMAND_ENVELOPE_VERSION
    && record.payloadSha256 === hash
    && JSON.stringify(record.commandPayload) === JSON.stringify(payload)
}

function prismaCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string'
    ? Reflect.get(error, 'code') as string
    : undefined
}

export class PrismaPerConversationOutboundActor implements PerConversationOutboundActor {
  readonly #client: OutboundActorPrismaClient
  readonly #routeRegistry: RouteRegistry
  readonly #idGenerator: () => string
  readonly #clock: () => Date
  readonly #actorLeaseMilliseconds: number
  readonly #reservationLeaseMilliseconds: number

  constructor(
    client: OutboundActorPrismaClient,
    routeRegistry: RouteRegistry,
    options: PrismaPerConversationOutboundActorOptions = {},
  ) {
    this.#client = client
    this.#routeRegistry = routeRegistry
    this.#idGenerator = options.idGenerator ?? randomUUID
    this.#clock = options.clock ?? (() => new Date())
    this.#actorLeaseMilliseconds = options.actorLeaseMilliseconds ?? DEFAULT_ACTOR_LEASE_MILLISECONDS
    this.#reservationLeaseMilliseconds = options.reservationLeaseMilliseconds ?? DEFAULT_RESERVATION_LEASE_MILLISECONDS
    positiveDuration(this.#actorLeaseMilliseconds, 'actorLeaseMilliseconds')
    positiveDuration(this.#reservationLeaseMilliseconds, 'reservationLeaseMilliseconds')
  }

  async #existingResult(
    input: EnqueueOutboundCommandInput,
    payload: JsonValue,
    hash: string,
  ): Promise<EnqueueOutboundCommandResult | null> {
    const byCommandId = await this.#client.maxOutboundCommand.findUnique({ where: { commandId: input.commandId } })
    if (byCommandId !== null) {
      if (!sameSemanticCommand(byCommandId, input, payload, hash)) {
        throw new OutboundActorError('COMMAND_IDEMPOTENCY_CONFLICT', 'commandId already represents another immutable command')
      }
      return deepFreeze({ command: asCommand(byCommandId), idempotent: true, idempotencyKey: 'command_id' as const })
    }
    if (input.clientMessageId !== undefined) {
      const byClientId = await this.#client.maxOutboundCommand.findFirst({
        where: { accountId: input.accountId, clientMessageId: input.clientMessageId },
      })
      if (byClientId !== null) {
        if (!sameSemanticCommand(byClientId, { ...input, commandId: byClientId.commandId }, payload, hash)) {
          throw new OutboundActorError('CLIENT_MESSAGE_ID_CONFLICT', 'clientMessageId already represents another immutable command')
        }
        return deepFreeze({ command: asCommand(byClientId), idempotent: true, idempotencyKey: 'client_message_id' as const })
      }
    }
    return null
  }

  async enqueueCommand(input: EnqueueOutboundCommandInput): Promise<EnqueueOutboundCommandResult> {
    required(input.commandId, 'commandId')
    required(input.accountId, 'accountId', 128)
    required(input.conversationKey, 'conversationKey')
    if (input.clientMessageId !== undefined) required(input.clientMessageId, 'clientMessageId')
    if (input.commandKind !== 'text') throw new OutboundActorError('INVALID_INPUT', 'Only text commands are supported')
    if (!['gravity', 'api', 'replay', 'synthetic_test'].includes(input.source)) {
      throw new OutboundActorError('INVALID_INPUT', 'Command source is not supported')
    }
    const payload = commandPayload(input.text)
    const hash = payloadHash(payload)
    for (let concurrencyAttempt = 0; concurrencyAttempt < 16; concurrencyAttempt += 1) {
      try {
        const existing = await this.#existingResult(input, payload, hash)
        if (existing !== null) return existing
        return await this.#client.$transaction(async transaction => {
        const racedById = await transaction.maxOutboundCommand.findUnique({ where: { commandId: input.commandId } })
        if (racedById !== null) {
          if (!sameSemanticCommand(racedById, input, payload, hash)) {
            throw new OutboundActorError('COMMAND_IDEMPOTENCY_CONFLICT', 'commandId already represents another immutable command')
          }
          return deepFreeze({ command: asCommand(racedById), idempotent: true, idempotencyKey: 'command_id' as const })
        }
        if (input.clientMessageId !== undefined) {
          const racedByClient = await transaction.maxOutboundCommand.findFirst({
            where: { accountId: input.accountId, clientMessageId: input.clientMessageId },
          })
          if (racedByClient !== null) {
            if (!sameSemanticCommand(racedByClient, { ...input, commandId: racedByClient.commandId }, payload, hash)) {
              throw new OutboundActorError('CLIENT_MESSAGE_ID_CONFLICT', 'clientMessageId already represents another immutable command')
            }
            return deepFreeze({ command: asCommand(racedByClient), idempotent: true, idempotencyKey: 'client_message_id' as const })
          }
        }
        const conversation = await transaction.maxRouteConversation.findUnique({ where: commandKey(input.accountId, input.conversationKey) })
        if (conversation === null) throw new OutboundActorError('NOT_FOUND', 'Account-scoped conversation was not found')
        await transaction.maxOutboundConversationActor.upsert({
          where: commandKey(input.accountId, input.conversationKey),
          create: { accountId: input.accountId, conversationKey: input.conversationKey },
          update: {},
        })
        const actor = await transaction.maxOutboundConversationActor.update({
          where: commandKey(input.accountId, input.conversationKey),
          data: { nextCommandSequence: { increment: 1 } },
        })
        const created = await transaction.maxOutboundCommand.create({
          data: {
            commandId: input.commandId,
            accountId: input.accountId,
            conversationKey: input.conversationKey,
            clientMessageId: input.clientMessageId ?? null,
            commandSequence: actor.nextCommandSequence,
            commandKind: input.commandKind,
            envelopeVersion: OUTBOUND_COMMAND_ENVELOPE_VERSION,
            commandPayload: payload,
            payloadSha256: hash,
            source: input.source,
          },
        })
        return deepFreeze({ command: asCommand(created), idempotent: false, idempotencyKey: 'created' as const })
        })
      } catch (error) {
        if (prismaCode(error) === 'P2002' || prismaCode(error) === 'P2034') {
          let raced: EnqueueOutboundCommandResult | null
          try {
            raced = await this.#existingResult(input, payload, hash)
          } catch (lookupError) {
            throw asOutboundDatabaseError(lookupError)
          }
          if (raced !== null) return raced
          if (concurrencyAttempt < 15) continue
        }
        throw asOutboundDatabaseError(error)
      }
    }
    throw new OutboundActorError('DATABASE_FAILURE', 'Outbound command concurrency retries were exhausted')
  }

  async getCommand(accountId: string, commandId: string): Promise<OutboundCommand | null> {
    required(accountId, 'accountId', 128)
    required(commandId, 'commandId')
    try {
      const record = await this.#client.maxOutboundCommand.findUnique({ where: { commandId } })
      return record === null || record.accountId !== accountId ? null : asCommand(record)
    } catch (error) {
      throw asOutboundDatabaseError(error)
    }
  }

  async listCommandsAfter(accountId: string, conversationKey: string, sequence: number, limit: number): Promise<OutboundCommandPage> {
    required(accountId, 'accountId', 128)
    required(conversationKey, 'conversationKey')
    nonNegativeInteger(sequence, 'sequence')
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OUTBOUND_PAGE_LIMIT) {
      throw new OutboundActorError('INVALID_INPUT', `limit must be between 1 and ${MAX_OUTBOUND_PAGE_LIMIT}`)
    }
    try {
      const records = await this.#client.maxOutboundCommand.findMany({
        where: { accountId, conversationKey, commandSequence: { gt: sequence } },
        orderBy: { commandSequence: 'asc' },
        take: limit,
      })
      const commands = records.map(asCommand)
      return deepFreeze({ commands, nextSequence: commands.at(-1)?.commandSequence ?? sequence })
    } catch (error) {
      throw asOutboundDatabaseError(error)
    }
  }

  async #ensureActor(transaction: OutboundActorPrismaTransaction, accountId: string, conversationKey: string): Promise<ActorRecord> {
    const conversation = await transaction.maxRouteConversation.findUnique({ where: commandKey(accountId, conversationKey) })
    if (conversation === null) throw new OutboundActorError('NOT_FOUND', 'Account-scoped conversation was not found')
    return transaction.maxOutboundConversationActor.upsert({
      where: commandKey(accountId, conversationKey),
      create: { accountId, conversationKey },
      update: {},
    })
  }

  async acquireActorLease(input: AcquireActorLeaseInput): Promise<OutboundActorState> {
    required(input.accountId, 'accountId', 128)
    required(input.conversationKey, 'conversationKey')
    required(input.ownerId, 'ownerId')
    const now = input.now ?? this.#clock()
    validDate(now, 'now')
    const duration = input.leaseMilliseconds ?? this.#actorLeaseMilliseconds
    positiveDuration(duration, 'leaseMilliseconds')
    for (let concurrencyAttempt = 0; concurrencyAttempt < 16; concurrencyAttempt += 1) {
      try {
        return await this.#client.$transaction(async transaction => {
        const current = await this.#ensureActor(transaction, input.accountId, input.conversationKey)
        if (current.leaseOwnerId !== null && current.leaseUntil !== null && current.leaseUntil > now) {
          if (current.leaseOwnerId === input.ownerId) return asActor(current)
          throw new OutboundActorError('LEASE_HELD', 'Conversation actor lease is held by another owner')
        }
        const changed = await transaction.maxOutboundConversationActor.updateMany({
          where: {
            accountId: input.accountId,
            conversationKey: input.conversationKey,
            optimisticVersion: current.optimisticVersion,
          },
          data: {
            leaseOwnerId: input.ownerId,
            leaseUntil: new Date(now.valueOf() + duration),
            leaseEpoch: { increment: 1 },
            optimisticVersion: { increment: 1 },
          },
        })
        if (changed.count !== 1) throw new OutboundActorError('LEASE_HELD', 'Conversation actor lease changed concurrently')
        const acquired = await transaction.maxOutboundConversationActor.findUnique({ where: commandKey(input.accountId, input.conversationKey) })
        if (acquired === null) throw new OutboundActorError('DATABASE_FAILURE', 'Conversation actor disappeared')
        return asActor(acquired)
        })
      } catch (error) {
        if ((prismaCode(error) === 'P2002' || prismaCode(error) === 'P2034') && concurrencyAttempt < 15) continue
        throw asOutboundDatabaseError(error)
      }
    }
    throw new OutboundActorError('DATABASE_FAILURE', 'Actor lease concurrency retries were exhausted')
  }

  async #currentLease(
    transaction: OutboundActorPrismaTransaction,
    input: ActorLeaseMutationInput | ReservationMutationInput | ReserveNextCommandInput,
    now: Date,
  ): Promise<ActorRecord> {
    const actor = await transaction.maxOutboundConversationActor.findUnique({
      where: commandKey(input.accountId, input.conversationKey),
    })
    if (actor === null || actor.leaseOwnerId !== input.ownerId || actor.leaseEpoch !== input.leaseEpoch
      || actor.leaseUntil === null || actor.leaseUntil <= now) {
      throw new OutboundActorError('STALE_ACTOR_LEASE', 'Actor lease owner, epoch, or deadline is stale')
    }
    const expected = 'expectedActorVersion' in input ? input.expectedActorVersion : input.expectedOptimisticVersion
    if (actor.optimisticVersion !== expected) {
      throw new OutboundActorError('STALE_ACTOR_VERSION', 'Actor optimistic version is stale')
    }
    return actor
  }

  async renewActorLease(input: ActorLeaseMutationInput): Promise<OutboundActorState> {
    return this.#mutateLease(input, 'renew')
  }

  async releaseActorLease(input: ActorLeaseMutationInput): Promise<OutboundActorState> {
    return this.#mutateLease(input, 'release')
  }

  async #mutateLease(input: ActorLeaseMutationInput, operation: 'renew' | 'release'): Promise<OutboundActorState> {
    required(input.accountId, 'accountId', 128)
    required(input.conversationKey, 'conversationKey')
    required(input.ownerId, 'ownerId')
    nonNegativeInteger(input.leaseEpoch, 'leaseEpoch')
    nonNegativeInteger(input.expectedOptimisticVersion, 'expectedOptimisticVersion')
    const now = input.now ?? this.#clock()
    validDate(now, 'now')
    const duration = input.leaseMilliseconds ?? this.#actorLeaseMilliseconds
    if (operation === 'renew') positiveDuration(duration, 'leaseMilliseconds')
    try {
      return await this.#client.$transaction(async transaction => {
        await this.#currentLease(transaction, input, now)
        const changed = await transaction.maxOutboundConversationActor.updateMany({
          where: {
            accountId: input.accountId,
            conversationKey: input.conversationKey,
            leaseOwnerId: input.ownerId,
            leaseEpoch: input.leaseEpoch,
            optimisticVersion: input.expectedOptimisticVersion,
            leaseUntil: { gt: now },
          },
          data: operation === 'renew'
            ? { leaseUntil: new Date(now.valueOf() + duration), optimisticVersion: { increment: 1 } }
            : { leaseOwnerId: null, leaseUntil: null, optimisticVersion: { increment: 1 } },
        })
        if (changed.count !== 1) throw new OutboundActorError('STALE_ACTOR_VERSION', 'Actor lease changed concurrently')
        const updated = await transaction.maxOutboundConversationActor.findUnique({ where: commandKey(input.accountId, input.conversationKey) })
        if (updated === null) throw new OutboundActorError('DATABASE_FAILURE', 'Conversation actor disappeared')
        return asActor(updated)
      })
    } catch (error) {
      throw asOutboundDatabaseError(error)
    }
  }

  async getActorState(accountId: string, conversationKey: string): Promise<OutboundActorState | null> {
    required(accountId, 'accountId', 128)
    required(conversationKey, 'conversationKey')
    try {
      const actor = await this.#client.maxOutboundConversationActor.findUnique({ where: commandKey(accountId, conversationKey) })
      return actor === null ? null : asActor(actor)
    } catch (error) {
      throw asOutboundDatabaseError(error)
    }
  }

  async reserveNextCommand(input: ReserveNextCommandInput): Promise<ReserveNextCommandResult> {
    required(input.accountId, 'accountId', 128)
    required(input.conversationKey, 'conversationKey')
    required(input.ownerId, 'ownerId')
    nonNegativeInteger(input.leaseEpoch, 'leaseEpoch')
    nonNegativeInteger(input.expectedActorVersion, 'expectedActorVersion')
    const now = input.now ?? this.#clock()
    validDate(now, 'now')
    const duration = input.reservationMilliseconds ?? this.#reservationLeaseMilliseconds
    positiveDuration(duration, 'reservationMilliseconds')
    try {
      return await this.#client.$transaction(async transaction => {
        const actor = await this.#currentLease(transaction, input, now)
        const active = await transaction.maxOutboundCommandReservation.findFirst({
          where: { accountId: input.accountId, conversationKey: input.conversationKey, reservationState: 'reserved' },
        })
        if (active !== null) {
          if (active.leaseOwnerId !== input.ownerId || active.leaseEpoch !== input.leaseEpoch) {
            throw new OutboundActorError('RESERVATION_CONFLICT', 'Conversation already has an active reservation')
          }
          const command = await transaction.maxOutboundCommand.findUnique({ where: { commandId: active.commandId } })
          if (command === null) throw new OutboundActorError('DATABASE_FAILURE', 'Reserved command was not found')
          return deepFreeze({ status: 'reserved' as const, command: asCommand(command), reservation: asReservation(active), idempotent: true })
        }
        const command = await transaction.maxOutboundCommand.findFirst({
          where: {
            accountId: input.accountId,
            conversationKey: input.conversationKey,
            commandSequence: actor.nextHandoffSequence,
          },
        })
        if (command === null) {
          if (actor.nextHandoffSequence <= actor.nextCommandSequence) {
            throw new OutboundActorError('DATABASE_FAILURE', 'FIFO head command is missing')
          }
          return deepFreeze({ status: 'empty' as const, nextHandoffSequence: actor.nextHandoffSequence })
        }
        const deadline = new Date(Math.min(actor.leaseUntil!.valueOf(), now.valueOf() + duration))
        if (deadline <= now) throw new OutboundActorError('STALE_ACTOR_LEASE', 'Actor lease has no remaining reservation interval')
        const reservation = await transaction.maxOutboundCommandReservation.create({
          data: {
            reservationId: this.#idGenerator(),
            accountId: input.accountId,
            conversationKey: input.conversationKey,
            commandId: command.commandId,
            commandSequence: command.commandSequence,
            leaseOwnerId: input.ownerId,
            leaseEpoch: input.leaseEpoch,
            reservationState: 'reserved',
            reservationVersion: 0,
            reservedAt: now,
            leaseUntil: deadline,
          },
        })
        return deepFreeze({ status: 'reserved' as const, command: asCommand(command), reservation: asReservation(reservation), idempotent: false })
      })
    } catch (error) {
      if (prismaCode(error) === 'P2002') {
        try {
          const active = await this.#client.maxOutboundCommandReservation.findFirst({
            where: { accountId: input.accountId, conversationKey: input.conversationKey, reservationState: 'reserved' },
          })
          if (active !== null && active.leaseOwnerId === input.ownerId && active.leaseEpoch === input.leaseEpoch) {
            const command = await this.#client.maxOutboundCommand.findUnique({ where: { commandId: active.commandId } })
            if (command !== null) return deepFreeze({ status: 'reserved', command: asCommand(command), reservation: asReservation(active), idempotent: true })
          }
        } catch (lookupError) {
          throw asOutboundDatabaseError(lookupError)
        }
        throw new OutboundActorError('RESERVATION_CONFLICT', 'Conversation already has an active reservation')
      }
      throw asOutboundDatabaseError(error)
    }
  }

  async #activeReservation(
    transaction: OutboundActorPrismaTransaction,
    input: ReservationMutationInput,
    now: Date,
  ): Promise<{ actor: ActorRecord; reservation: ReservationRecord; command: CommandRecord }> {
    const actor = await this.#currentLease(transaction, input, now)
    const reservation = await transaction.maxOutboundCommandReservation.findUnique({ where: { reservationId: input.reservationId } })
    if (reservation === null || reservation.accountId !== input.accountId || reservation.conversationKey !== input.conversationKey) {
      throw new OutboundActorError('NOT_FOUND', 'Account-scoped reservation was not found')
    }
    if (reservation.reservationState === 'handed_off') {
      throw new OutboundActorError('ALREADY_HANDED_OFF', 'Reservation was already handed off')
    }
    if (reservation.reservationState !== 'reserved' || reservation.leaseUntil <= now
      || reservation.leaseOwnerId !== input.ownerId || reservation.leaseEpoch !== input.leaseEpoch) {
      throw new OutboundActorError('RESERVATION_NOT_ACTIVE', 'Reservation is not active for the current actor lease')
    }
    if (reservation.reservationVersion !== input.expectedReservationVersion) {
      throw new OutboundActorError('STALE_RESERVATION_VERSION', 'Reservation version is stale')
    }
    const command = await transaction.maxOutboundCommand.findUnique({ where: { commandId: reservation.commandId } })
    if (command === null || command.accountId !== input.accountId || command.conversationKey !== input.conversationKey) {
      throw new OutboundActorError('DATABASE_FAILURE', 'Reserved command relation is invalid')
    }
    return { actor, reservation, command }
  }

  async prepareReservedCommand(input: PrepareReservedCommandInput): Promise<PreparedOutboundCommand> {
    const now = input.now ?? this.#clock()
    validDate(now, 'now')
    let route
    try {
      route = await this.#routeRegistry.getSendableRouteSnapshot(input.accountId, input.conversationKey)
    } catch (error) {
      const code = outboundErrorCode(error)
      if (code === 'DATABASE_FAILURE') throw asOutboundDatabaseError(error)
      throw new OutboundActorError('ROUTE_NOT_SENDABLE', 'Current account-scoped route is not sendable')
    }
    try {
      const selected = await this.#client.$transaction(transaction => this.#activeReservation(transaction, input, now))
      return deepFreeze({
        commandId: selected.command.commandId,
        accountId: selected.command.accountId,
        conversationKey: selected.command.conversationKey,
        commandSequence: selected.command.commandSequence,
        commandKind: 'text' as const,
        commandPayload: selected.command.commandPayload,
        reservationId: selected.reservation.reservationId,
        reservationVersion: selected.reservation.reservationVersion,
        actorLeaseEpoch: selected.actor.leaseEpoch,
        routeVersion: route.routeVersion,
        activeProtocolChatId: route.activeProtocolChatId,
        activeProviderUserId: route.activeProviderUserId ?? null,
        activeWebRouteId: route.activeWebRouteId ?? null,
        routeEvidenceReferences: route.evidenceReferences,
        physicalSendAuthorized: false as const,
      })
    } catch (error) {
      throw asOutboundDatabaseError(error)
    }
  }

  async releaseReservation(input: ReservationMutationInput): Promise<OutboundCommandReservation> {
    const now = input.now ?? this.#clock()
    validDate(now, 'now')
    try {
      return await this.#client.$transaction(async transaction => {
        await this.#activeReservation(transaction, input, now)
        const changed = await transaction.maxOutboundCommandReservation.updateMany({
          where: {
            reservationId: input.reservationId,
            accountId: input.accountId,
            conversationKey: input.conversationKey,
            leaseOwnerId: input.ownerId,
            leaseEpoch: input.leaseEpoch,
            reservationState: 'reserved',
            reservationVersion: input.expectedReservationVersion,
            leaseUntil: { gt: now },
          },
          data: { reservationState: 'released', releasedAt: now, reservationVersion: { increment: 1 } },
        })
        if (changed.count !== 1) throw new OutboundActorError('STALE_RESERVATION_VERSION', 'Reservation changed concurrently')
        const updated = await transaction.maxOutboundCommandReservation.findUnique({ where: { reservationId: input.reservationId } })
        if (updated === null) throw new OutboundActorError('DATABASE_FAILURE', 'Reservation disappeared')
        return asReservation(updated)
      })
    } catch (error) {
      throw asOutboundDatabaseError(error)
    }
  }

  async expireReservation(input: ExpireReservationInput): Promise<OutboundCommandReservation> {
    required(input.accountId, 'accountId', 128)
    required(input.conversationKey, 'conversationKey')
    required(input.reservationId, 'reservationId')
    nonNegativeInteger(input.expectedReservationVersion, 'expectedReservationVersion')
    const now = input.now ?? this.#clock()
    validDate(now, 'now')
    try {
      return await this.#client.$transaction(async transaction => {
        const current = await transaction.maxOutboundCommandReservation.findUnique({ where: { reservationId: input.reservationId } })
        if (current === null || current.accountId !== input.accountId || current.conversationKey !== input.conversationKey) {
          throw new OutboundActorError('NOT_FOUND', 'Account-scoped reservation was not found')
        }
        if (current.reservationState !== 'reserved') throw new OutboundActorError('RESERVATION_NOT_ACTIVE', 'Reservation is not active')
        if (current.reservationVersion !== input.expectedReservationVersion) {
          throw new OutboundActorError('STALE_RESERVATION_VERSION', 'Reservation version is stale')
        }
        if (current.leaseUntil > now) throw new OutboundActorError('RESERVATION_NOT_EXPIRED', 'Reservation deadline has not elapsed')
        const changed = await transaction.maxOutboundCommandReservation.updateMany({
          where: {
            reservationId: input.reservationId,
            accountId: input.accountId,
            conversationKey: input.conversationKey,
            reservationState: 'reserved',
            reservationVersion: input.expectedReservationVersion,
            leaseUntil: { lte: now },
          },
          data: { reservationState: 'expired', releasedAt: now, reservationVersion: { increment: 1 } },
        })
        if (changed.count !== 1) throw new OutboundActorError('STALE_RESERVATION_VERSION', 'Reservation changed concurrently')
        const updated = await transaction.maxOutboundCommandReservation.findUnique({ where: { reservationId: input.reservationId } })
        if (updated === null) throw new OutboundActorError('DATABASE_FAILURE', 'Reservation disappeared')
        return asReservation(updated)
      })
    } catch (error) {
      throw asOutboundDatabaseError(error)
    }
  }

  async markReservationHandedOff(input: MarkReservationHandedOffInput): Promise<HandoffResult> {
    required(input.handoffReference, 'handoffReference', 512)
    const now = input.now ?? this.#clock()
    validDate(now, 'now')
    try {
      return await this.#client.$transaction(async transaction => {
        const selected = await this.#activeReservation(transaction, input, now)
        if (selected.actor.nextHandoffSequence !== selected.command.commandSequence) {
          throw new OutboundActorError('RESERVATION_CONFLICT', 'Reservation is not the current FIFO head')
        }
        const reservationChanged = await transaction.maxOutboundCommandReservation.updateMany({
          where: {
            reservationId: input.reservationId,
            accountId: input.accountId,
            conversationKey: input.conversationKey,
            leaseOwnerId: input.ownerId,
            leaseEpoch: input.leaseEpoch,
            reservationState: 'reserved',
            reservationVersion: input.expectedReservationVersion,
            leaseUntil: { gt: now },
          },
          data: {
            reservationState: 'handed_off',
            handoffReference: input.handoffReference,
            handedOffAt: now,
            reservationVersion: { increment: 1 },
          },
        })
        if (reservationChanged.count !== 1) throw new OutboundActorError('STALE_RESERVATION_VERSION', 'Reservation changed concurrently')
        const actorChanged = await transaction.maxOutboundConversationActor.updateMany({
          where: {
            accountId: input.accountId,
            conversationKey: input.conversationKey,
            leaseOwnerId: input.ownerId,
            leaseEpoch: input.leaseEpoch,
            optimisticVersion: input.expectedActorVersion,
            nextHandoffSequence: selected.command.commandSequence,
            leaseUntil: { gt: now },
          },
          data: { nextHandoffSequence: { increment: 1 }, optimisticVersion: { increment: 1 } },
        })
        if (actorChanged.count !== 1) throw new OutboundActorError('STALE_ACTOR_VERSION', 'Actor changed before handoff')
        const [reservation, actor] = await Promise.all([
          transaction.maxOutboundCommandReservation.findUnique({ where: { reservationId: input.reservationId } }),
          transaction.maxOutboundConversationActor.findUnique({ where: commandKey(input.accountId, input.conversationKey) }),
        ])
        if (reservation === null || actor === null) throw new OutboundActorError('DATABASE_FAILURE', 'Handoff state disappeared')
        return deepFreeze({ reservation: asReservation(reservation), actor: asActor(actor), physicalSendAuthorized: false as const })
      })
    } catch (error) {
      throw asOutboundDatabaseError(error)
    }
  }
}
