import { PrismaDispatchLedger } from '../../src/dispatch/PrismaDispatchLedger.ts'
import type {
  CreateDispatchResult,
  SenderAuthorityInput,
  SenderAuthorityProof,
  SenderAuthorityVerifier,
} from '../../src/dispatch/types.ts'
import { PrismaPerConversationOutboundActor } from '../../src/outbound/PrismaPerConversationOutboundActor.ts'
import type { EnqueueOutboundCommandInput, OutboundActorState, OutboundCommandReservation } from '../../src/outbound/types.ts'
import { PrismaRouteRegistry } from '../../src/route/PrismaRouteRegistry.ts'
import { runId, type RealPrismaClient } from './realPostgres.ts'

export class ExplicitTestSenderAuthority implements SenderAuthorityVerifier {
  async verify(input: SenderAuthorityInput): Promise<SenderAuthorityProof> {
    return {
      accountId: input.accountId,
      ownerId: input.ownerId,
      fencingEpoch: input.fencingEpoch,
      verifiedAt: input.proofTimestamp,
      leaseUntil: new Date(input.now.valueOf() + 1_800_000),
    }
  }
}

export function createLedgerHarness(client: RealPrismaClient): {
  readonly actor: PrismaPerConversationOutboundActor
  readonly ledger: PrismaDispatchLedger
  readonly routeRegistry: PrismaRouteRegistry
} {
  const routeRegistry = new PrismaRouteRegistry(client as any)
  return {
    actor: new PrismaPerConversationOutboundActor(client as any, routeRegistry),
    ledger: new PrismaDispatchLedger(client as any, routeRegistry, new ExplicitTestSenderAuthority()),
    routeRegistry,
  }
}

export async function createConversation(
  client: RealPrismaClient,
  accountId: string,
  conversationKey: string,
  state: 'active' | 'unresolved' | 'conflicted' | 'retired' = 'active',
  routeVersion = 1,
): Promise<void> {
  await client.maxRouteConversation.create({
    data: {
      id: runId('route'), accountId, conversationKey, routeVersion, optimisticVersion: 0, state,
      ...(state === 'retired'
        ? { retiredAt: new Date(), retiredBy: 'stage5-test', retirementReason: 'synthetic retired route' }
        : {}),
    },
  })
  if (state === 'active') {
    for (const [identityKind, identityValue] of [
      ['protocol_chat_id', conversationKey + '-protocol'],
      ['provider_user_id', conversationKey + '-provider'],
      ['web_route_id', conversationKey + '-web'],
    ]) {
      await client.maxRouteIdentityBinding.create({
        data: {
          id: runId('binding'), accountId, identityKind, identityValue, conversationKey, status: 'active',
          firstSeenAt: new Date(), lastSeenAt: new Date(), evidenceRef: runId('evidence'), version: routeVersion,
        },
      })
    }
  }
}

export function outboundCommand(
  accountId: string,
  conversationKey: string,
  commandId = runId('command'),
  clientMessageId = runId('client'),
  text = 'synthetic Stage 5 message',
): EnqueueOutboundCommandInput {
  return { commandId, accountId, conversationKey, clientMessageId, commandKind: 'text', text, source: 'synthetic_test' }
}

export interface ReservedFixture {
  readonly commandId: string
  readonly commandSequence: number
  readonly reservation: OutboundCommandReservation
  readonly actorState: OutboundActorState
  readonly ownerId: string
}

export async function createReservedFixture(
  actor: PrismaPerConversationOutboundActor,
  accountId: string,
  conversationKey: string,
  ownerId = 'actor-owner',
  text = 'synthetic Stage 5 message',
): Promise<ReservedFixture> {
  const enqueued = await actor.enqueueCommand(outboundCommand(accountId, conversationKey, runId('command'), runId('client'), text))
  const actorState = await actor.acquireActorLease({
    accountId, conversationKey, ownerId, leaseMilliseconds: 300_000,
  })
  const reserved = await actor.reserveNextCommand({
    accountId, conversationKey, ownerId, leaseEpoch: actorState.leaseEpoch,
    expectedActorVersion: actorState.optimisticVersion, reservationMilliseconds: 300_000,
  })
  if (reserved.status !== 'reserved') throw new Error('synthetic fixture expected a reservation')
  return {
    commandId: enqueued.command.commandId,
    commandSequence: enqueued.command.commandSequence,
    reservation: reserved.reservation,
    actorState,
    ownerId,
  }
}

export async function createDispatchFixture(
  actor: PrismaPerConversationOutboundActor,
  ledger: PrismaDispatchLedger,
  accountId: string,
  conversationKey: string,
  ownerId = 'actor-owner',
  text = 'synthetic Stage 5 message',
): Promise<CreateDispatchResult> {
  const fixture = await createReservedFixture(actor, accountId, conversationKey, ownerId, text)
  return ledger.createDispatchFromReservation({
    dispatchId: runId('dispatch'), accountId, conversationKey,
    reservationId: fixture.reservation.reservationId,
    expectedCommandId: fixture.commandId,
    expectedCommandSequence: fixture.commandSequence,
    ownerId, actorLeaseEpoch: fixture.actorState.leaseEpoch,
    expectedActorVersion: fixture.actorState.optimisticVersion,
    expectedReservationVersion: fixture.reservation.reservationVersion,
    transitionIdempotencyKey: runId('dispatch_create'),
  })
}
