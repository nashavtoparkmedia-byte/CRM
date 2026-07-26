import type { JsonValue } from '../journal/types.ts'

export type OutboundCommandKind = 'text'
export type OutboundCommandSource = 'gravity' | 'api' | 'replay' | 'synthetic_test'
export type OutboundReservationState = 'reserved' | 'released' | 'handed_off' | 'expired'

export interface OutboundTextCommandPayload {
  readonly kind: 'text'
  readonly text: string
}

export interface EnqueueOutboundCommandInput {
  readonly commandId: string
  readonly accountId: string
  readonly conversationKey: string
  readonly clientMessageId?: string
  readonly commandKind: 'text'
  readonly text: string
  readonly source: OutboundCommandSource
}

export interface OutboundCommand {
  readonly commandId: string
  readonly accountId: string
  readonly conversationKey: string
  readonly clientMessageId: string | null
  readonly commandSequence: number
  readonly commandKind: OutboundCommandKind
  readonly envelopeVersion: string
  readonly commandPayload: JsonValue
  readonly payloadSha256: string
  readonly source: OutboundCommandSource
  readonly createdAt: Date
}

export interface EnqueueOutboundCommandResult {
  readonly command: OutboundCommand
  readonly idempotent: boolean
  readonly idempotencyKey: 'created' | 'command_id' | 'client_message_id'
}

export interface OutboundCommandPage {
  readonly commands: readonly OutboundCommand[]
  readonly nextSequence: number
}

export interface OutboundActorState {
  readonly accountId: string
  readonly conversationKey: string
  readonly nextCommandSequence: number
  readonly nextHandoffSequence: number
  readonly leaseOwnerId: string | null
  readonly leaseEpoch: number
  readonly leaseUntil: Date | null
  readonly optimisticVersion: number
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly physicalSendAuthorized: false
}

export interface AcquireActorLeaseInput {
  readonly accountId: string
  readonly conversationKey: string
  readonly ownerId: string
  readonly now?: Date
  readonly leaseMilliseconds?: number
}

export interface ActorLeaseMutationInput {
  readonly accountId: string
  readonly conversationKey: string
  readonly ownerId: string
  readonly leaseEpoch: number
  readonly expectedOptimisticVersion: number
  readonly now?: Date
  readonly leaseMilliseconds?: number
}

export interface OutboundCommandReservation {
  readonly reservationId: string
  readonly accountId: string
  readonly conversationKey: string
  readonly commandId: string
  readonly commandSequence: number
  readonly leaseOwnerId: string
  readonly leaseEpoch: number
  readonly reservationState: OutboundReservationState
  readonly reservationVersion: number
  readonly reservedAt: Date
  readonly leaseUntil: Date
  readonly releasedAt: Date | null
  readonly handoffReference: string | null
  readonly handedOffAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface ReserveNextCommandInput {
  readonly accountId: string
  readonly conversationKey: string
  readonly ownerId: string
  readonly leaseEpoch: number
  readonly expectedActorVersion: number
  readonly now?: Date
  readonly reservationMilliseconds?: number
}

export type ReserveNextCommandResult =
  | { readonly status: 'empty'; readonly nextHandoffSequence: number }
  | {
      readonly status: 'reserved'
      readonly command: OutboundCommand
      readonly reservation: OutboundCommandReservation
      readonly idempotent: boolean
    }

export interface ReservationMutationInput {
  readonly accountId: string
  readonly conversationKey: string
  readonly reservationId: string
  readonly ownerId: string
  readonly leaseEpoch: number
  readonly expectedActorVersion: number
  readonly expectedReservationVersion: number
  readonly now?: Date
}

export interface ExpireReservationInput {
  readonly accountId: string
  readonly conversationKey: string
  readonly reservationId: string
  readonly expectedReservationVersion: number
  readonly now?: Date
}

export interface PrepareReservedCommandInput extends ReservationMutationInput {}

export interface PreparedOutboundCommand {
  readonly commandId: string
  readonly accountId: string
  readonly conversationKey: string
  readonly commandSequence: number
  readonly commandKind: OutboundCommandKind
  readonly commandPayload: JsonValue
  readonly reservationId: string
  readonly reservationVersion: number
  readonly actorLeaseEpoch: number
  readonly routeVersion: number
  readonly activeProtocolChatId: string
  readonly activeProviderUserId: string | null
  readonly activeWebRouteId: string | null
  readonly routeEvidenceReferences: readonly string[]
  readonly physicalSendAuthorized: false
}

export interface MarkReservationHandedOffInput extends ReservationMutationInput {
  readonly handoffReference: string
}

export interface HandoffResult {
  readonly reservation: OutboundCommandReservation
  readonly actor: OutboundActorState
  readonly physicalSendAuthorized: false
}

export interface PerConversationOutboundActor {
  enqueueCommand(input: EnqueueOutboundCommandInput): Promise<EnqueueOutboundCommandResult>
  getCommand(accountId: string, commandId: string): Promise<OutboundCommand | null>
  listCommandsAfter(accountId: string, conversationKey: string, sequence: number, limit: number): Promise<OutboundCommandPage>
  acquireActorLease(input: AcquireActorLeaseInput): Promise<OutboundActorState>
  renewActorLease(input: ActorLeaseMutationInput): Promise<OutboundActorState>
  releaseActorLease(input: ActorLeaseMutationInput): Promise<OutboundActorState>
  getActorState(accountId: string, conversationKey: string): Promise<OutboundActorState | null>
  reserveNextCommand(input: ReserveNextCommandInput): Promise<ReserveNextCommandResult>
  prepareReservedCommand(input: PrepareReservedCommandInput): Promise<PreparedOutboundCommand>
  releaseReservation(input: ReservationMutationInput): Promise<OutboundCommandReservation>
  expireReservation(input: ExpireReservationInput): Promise<OutboundCommandReservation>
  markReservationHandedOff(input: MarkReservationHandedOffInput): Promise<HandoffResult>
}
