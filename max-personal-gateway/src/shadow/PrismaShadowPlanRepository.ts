import type { JsonValue } from '../journal/types.ts'
import { ShadowPlanError } from './errors.ts'
import type {
  OutboundShadowPlan,
  ShadowCommandRecord,
  ShadowPlanDraft,
  ShadowPlanRepository,
  ShadowReservationRecord,
  ShadowSemanticComparison,
} from './types.ts'

interface CommandDelegate {
  findUnique(args: { where: { commandId: string } }): Promise<ShadowCommandRecord | null>
}

interface ReservationDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<ShadowReservationRecord | null>
}

interface DispatchDelegate {
  findUnique(args: { where: { commandId: string }; select: { state: true } }): Promise<{ state: string } | null>
}

interface ShadowPlanRow {
  planId: string
  schemaVersion: string
  inputSha256: string
  accountId: string
  accountAliasSha256: string
  conversationKey: string
  conversationKeySha256: string
  commandId: string
  commandSequence: number
  reservationId: string
  clientMessageId: string | null
  attemptCorrelationId: string
  idempotencyKey: string
  routeResolution: string
  routeVersion: number | null
  selectedProtocolChatId: string | null
  payloadKind: string
  payloadSizeBytes: number
  payloadSha256: string
  replyMetadata: string
  ownerReadiness: string
  ownerInstanceId: string | null
  ownerFencingToken: bigint | null
  wouldSend: boolean
  refusalReason: string | null
  semanticComparison: JsonValue
  evaluatedAt: Date
  createdAt: Date
}

interface ShadowPlanDelegate {
  findUnique(args: { where: Record<string, unknown> }): Promise<ShadowPlanRow | null>
  create(args: { data: Record<string, unknown> }): Promise<ShadowPlanRow>
}

export interface ShadowPlanPrismaClient {
  readonly maxOutboundCommand: CommandDelegate
  readonly maxOutboundCommandReservation: ReservationDelegate
  readonly maxOutboundDispatch: DispatchDelegate
  readonly maxOutboundShadowPlan: ShadowPlanDelegate
}

function asPlan(row: ShadowPlanRow): OutboundShadowPlan {
  if (row.replyMetadata !== 'none' || row.semanticComparison === null || Array.isArray(row.semanticComparison)
    || typeof row.semanticComparison !== 'object') {
    throw new ShadowPlanError('DATABASE_FAILURE', 'Stored shadow plan is invalid')
  }
  return Object.freeze({
    ...row,
    replyMetadata: 'none' as const,
    refusalReason: row.refusalReason as OutboundShadowPlan['refusalReason'],
    semanticComparison: row.semanticComparison as unknown as ShadowSemanticComparison,
    evaluatedAt: new Date(row.evaluatedAt),
    createdAt: new Date(row.createdAt),
  })
}

function prismaCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string'
    ? Reflect.get(error, 'code') as string
    : undefined
}

export class PrismaShadowPlanRepository implements ShadowPlanRepository {
  readonly #client: ShadowPlanPrismaClient

  constructor(client: ShadowPlanPrismaClient) {
    this.#client = client
  }

  async getCommand(commandId: string): Promise<ShadowCommandRecord | null> {
    return this.#client.maxOutboundCommand.findUnique({ where: { commandId } })
  }

  async getActiveReservation(commandId: string, reservationId: string): Promise<ShadowReservationRecord | null> {
    return this.#client.maxOutboundCommandReservation.findFirst({
      where: { commandId, reservationId, reservationState: 'reserved' },
    })
  }

  async getDispatchState(commandId: string): Promise<string | null> {
    return (await this.#client.maxOutboundDispatch.findUnique({ where: { commandId }, select: { state: true } }))?.state ?? null
  }

  async getByIdempotencyKey(accountId: string, idempotencyKey: string): Promise<OutboundShadowPlan | null> {
    const row = await this.#client.maxOutboundShadowPlan.findUnique({ where: { accountId_idempotencyKey: { accountId, idempotencyKey } } })
    return row === null ? null : asPlan(row)
  }

  async getByCommandId(commandId: string): Promise<OutboundShadowPlan | null> {
    const row = await this.#client.maxOutboundShadowPlan.findUnique({ where: { commandId } })
    return row === null ? null : asPlan(row)
  }

  async createPlan(draft: ShadowPlanDraft): Promise<OutboundShadowPlan> {
    try {
      const row = await this.#client.maxOutboundShadowPlan.create({
        data: {
          ...draft,
          semanticComparison: draft.semanticComparison as unknown as JsonValue,
        },
      })
      return asPlan(row)
    } catch (error) {
      if (prismaCode(error) === 'P2002') {
        const existing = await this.getByIdempotencyKey(draft.accountId, draft.idempotencyKey)
          ?? await this.getByCommandId(draft.commandId)
        if (existing !== null && existing.inputSha256 === draft.inputSha256) return existing
        throw new ShadowPlanError('IDEMPOTENCY_CONFLICT', 'Concurrent shadow plan uniqueness conflict')
      }
      throw error
    }
  }
}
