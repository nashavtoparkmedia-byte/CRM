import type { JsonValue } from '../journal/types.ts'

export type ShadowRefusalReason =
  | 'ROUTE_NOT_FOUND'
  | 'ROUTE_CONFLICT'
  | 'ACCOUNT_MISMATCH'
  | 'CONVERSATION_NOT_SENDABLE'
  | 'OWNER_NOT_ACQUIRED'
  | 'OWNER_LEASE_EXPIRED'
  | 'FENCING_TOKEN_MISSING'
  | 'FENCING_TOKEN_STALE'
  | 'PAYLOAD_UNSUPPORTED'
  | 'COMMAND_ALREADY_TERMINAL'
  | 'IDEMPOTENCY_CONFLICT'

export interface ShadowCommandRecord {
  readonly commandId: string
  readonly accountId: string
  readonly conversationKey: string
  readonly clientMessageId: string | null
  readonly commandSequence: number
  readonly commandKind: string
  readonly commandPayload: JsonValue
  readonly payloadSha256: string
}

export interface ShadowReservationRecord {
  readonly reservationId: string
  readonly accountId: string
  readonly conversationKey: string
  readonly commandId: string
  readonly commandSequence: number
  readonly reservationState: string
}

export interface LegacyOutboundProjection {
  readonly accountId: string
  readonly conversationKey: string
  readonly targetProtocolChatId: string | null
  readonly payloadKind: string
  readonly sendable: boolean
}

export interface PlanOutboundCommandInput {
  readonly accountId: string
  readonly conversationKey: string
  readonly commandId: string
  readonly reservationId: string
  readonly attemptCorrelationId: string
  readonly idempotencyKey: string
  readonly ownerInstanceId?: string
  readonly fencingToken?: bigint
  readonly legacy?: LegacyOutboundProjection
}

export interface ShadowSemanticComparison {
  readonly legacyObserved: boolean
  readonly legacyTargetSha256: string | null
  readonly newTargetSha256: string | null
  readonly legacyPayloadShape: string | null
  readonly newPayloadShape: 'text'
  readonly legacySendable: boolean | null
  readonly newSendable: boolean
  readonly accountMatches: boolean | null
  readonly conversationMatches: boolean | null
  readonly targetMatches: boolean | null
  readonly payloadMatches: boolean | null
  readonly sendabilityMatches: boolean | null
  readonly hiddenRouteConflict: boolean
  readonly criticalRegression: boolean
}

export interface OutboundShadowPlan {
  readonly planId: string
  readonly schemaVersion: string
  readonly inputSha256: string
  readonly accountId: string
  readonly accountAliasSha256: string
  readonly conversationKey: string
  readonly conversationKeySha256: string
  readonly commandId: string
  readonly commandSequence: number
  readonly reservationId: string
  readonly clientMessageId: string | null
  readonly attemptCorrelationId: string
  readonly idempotencyKey: string
  readonly routeResolution: string
  readonly routeVersion: number | null
  readonly selectedProtocolChatId: string | null
  readonly payloadKind: string
  readonly payloadSizeBytes: number
  readonly payloadSha256: string
  readonly replyMetadata: 'none'
  readonly ownerReadiness: string
  readonly ownerInstanceId: string | null
  readonly ownerFencingToken: bigint | null
  readonly wouldSend: boolean
  readonly refusalReason: ShadowRefusalReason | null
  readonly semanticComparison: ShadowSemanticComparison
  readonly evaluatedAt: Date
  readonly createdAt: Date
}

export interface ShadowPlanResult {
  readonly plan: OutboundShadowPlan
  readonly idempotent: boolean
  readonly physicalSendAuthorized: false
  readonly deliveryStateMutated: false
}

export interface ShadowPlanDraft extends OutboundShadowPlan {}

export interface ShadowPlanRepository {
  getCommand(commandId: string): Promise<ShadowCommandRecord | null>
  getActiveReservation(commandId: string, reservationId: string): Promise<ShadowReservationRecord | null>
  getDispatchState(commandId: string): Promise<string | null>
  getByIdempotencyKey(accountId: string, idempotencyKey: string): Promise<OutboundShadowPlan | null>
  getByCommandId(commandId: string): Promise<OutboundShadowPlan | null>
  createPlan(draft: ShadowPlanDraft): Promise<OutboundShadowPlan>
}
