import assert from 'node:assert/strict'
import test from 'node:test'
import { PrismaPerConversationOutboundActor } from '../src/outbound/PrismaPerConversationOutboundActor.ts'
import { OutboundActorError } from '../src/outbound/errors.ts'
import { isPerChatOutboundActorEnabled } from '../src/outbound/featureFlag.ts'
import type { EnqueueOutboundCommandInput, OutboundActorState } from '../src/outbound/types.ts'
import { RouteRegistryError } from '../src/route/errors.ts'
import type { RouteRegistry } from '../src/route/RouteRegistry.ts'
import type { RouteSnapshot, SendableRouteSnapshot } from '../src/route/types.ts'
import { FakeOutboundPrisma } from './support/FakeOutboundPrisma.ts'

const now = new Date('2026-07-26T22:30:00.000Z')

class FakeRouteAuthority {
  readonly snapshots = new Map<string, RouteSnapshot>()

  set(accountId: string, conversationKey: string, state: RouteSnapshot['state'], routeVersion = 1): void {
    this.snapshots.set(`${accountId}\0${conversationKey}`, {
      accountId,
      conversationKey,
      routeVersion,
      state,
      identities: state === 'active' ? [{
        kind: 'protocol_chat_id', value: `${conversationKey}-protocol`, status: 'active',
        firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(), evidenceRef: `${conversationKey}-evidence`, version: routeVersion,
      }] : [],
      activeProtocolChatId: state === 'active' ? `${conversationKey}-protocol` : undefined,
      activeProviderUserId: state === 'active' ? `${conversationKey}-provider` : undefined,
      activeWebRouteId: state === 'active' ? `${conversationKey}-web` : undefined,
      evidenceReferences: state === 'active' ? [`${conversationKey}-evidence`] : [],
      hasOpenConflict: state === 'conflicted',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })
  }

  async getSendableRouteSnapshot(accountId: string, conversationKey: string): Promise<SendableRouteSnapshot> {
    const snapshot = this.snapshots.get(`${accountId}\0${conversationKey}`)
    if (snapshot?.state !== 'active' || snapshot.hasOpenConflict || snapshot.activeProtocolChatId === undefined) {
      throw new RouteRegistryError('ROUTE_NOT_SENDABLE', 'Synthetic route is not sendable')
    }
    return snapshot as SendableRouteSnapshot
  }
}

function harness() {
  const client = new FakeOutboundPrisma()
  const routes = new FakeRouteAuthority()
  for (const [accountId, conversationKey, state] of [
    ['account-a', 'conversation-a', 'active'],
    ['account-a', 'conversation-b', 'active'],
    ['account-a', 'conversation-unresolved', 'unresolved'],
    ['account-a', 'conversation-conflicted', 'conflicted'],
    ['account-a', 'conversation-retired', 'retired'],
    ['account-b', 'conversation-a', 'active'],
  ] as const) {
    client.seedConversation(accountId, conversationKey)
    routes.set(accountId, conversationKey, state)
  }
  let id = 0
  const actor = new PrismaPerConversationOutboundActor(client, routes as unknown as RouteRegistry, {
    idGenerator: () => `reservation-${++id}`,
    clock: () => now,
    actorLeaseMilliseconds: 10_000,
    reservationLeaseMilliseconds: 5_000,
  })
  return { client, routes, actor }
}

function command(
  commandId: string,
  conversationKey = 'conversation-a',
  text = '  exact Unicode Привет\n',
  clientMessageId: string | undefined = `${commandId}-client`,
  accountId = 'account-a',
): EnqueueOutboundCommandInput {
  return { commandId, accountId, conversationKey, clientMessageId, commandKind: 'text', text, source: 'synthetic_test' }
}

async function rejectsCode(operation: Promise<unknown>, code: string): Promise<OutboundActorError> {
  let observed: OutboundActorError | undefined
  await assert.rejects(operation, error => {
    if (error instanceof OutboundActorError && error.code === code) observed = error
    return observed !== undefined
  })
  return observed!
}

async function acquire(actor: PrismaPerConversationOutboundActor, conversationKey = 'conversation-a', ownerId = 'owner-a', at = now): Promise<OutboundActorState> {
  return actor.acquireActorLease({ accountId: 'account-a', conversationKey, ownerId, now: at, leaseMilliseconds: 10_000 })
}

test('per-conversation sequence starts at one, paginates deterministically, and preserves exact text', async () => {
  const { actor } = harness()
  const first = await actor.enqueueCommand(command('command-1'))
  const second = await actor.enqueueCommand(command('command-2', 'conversation-a', 'same'))
  assert.deepEqual([first.command.commandSequence, second.command.commandSequence], [1, 2])
  assert.equal((first.command.commandPayload as { text: string }).text, '  exact Unicode Привет\n')
  const page = await actor.listCommandsAfter('account-a', 'conversation-a', 0, 1)
  const next = await actor.listCommandsAfter('account-a', 'conversation-a', page.nextSequence, 10)
  assert.deepEqual([...page.commands, ...next.commands].map(item => item.commandSequence), [1, 2])
})

test('account and conversation sequences are isolated', async () => {
  const { actor } = harness()
  const a1 = await actor.enqueueCommand(command('a-1'))
  const b1 = await actor.enqueueCommand(command('b-1', 'conversation-b'))
  const otherAccount = await actor.enqueueCommand(command('other-1', 'conversation-a', 'same', 'shared-client', 'account-b'))
  assert.deepEqual([a1.command.commandSequence, b1.command.commandSequence, otherAccount.command.commandSequence], [1, 1, 1])
  assert.equal((await actor.listCommandsAfter('account-a', 'conversation-a', 0, 10)).commands.length, 1)
  assert.equal(await actor.getCommand('account-b', 'a-1'), null)
})

test('one hundred identical texts remain one hundred physical commands with one shared nonunique hash', async () => {
  const { actor, client } = harness()
  for (let index = 1; index <= 100; index += 1) {
    await actor.enqueueCommand(command(`identical-${index}`, 'conversation-a', 'identical', `identical-client-${index}`))
  }
  const rows = client.commandRows()
  assert.equal(rows.length, 100)
  assert.deepEqual(rows.map(row => row.commandSequence), Array.from({ length: 100 }, (_, index) => index + 1))
  assert.equal(new Set(rows.map(row => row.payloadSha256)).size, 1)
})

test('commandId and clientMessageId retries are idempotent while semantic conflicts fail closed', async () => {
  const { actor, client } = harness()
  const input = command('retry-command', 'conversation-a', 'payload', 'logical-client')
  const created = await actor.enqueueCommand(input)
  const byCommand = await actor.enqueueCommand(input)
  const byClient = await actor.enqueueCommand({ ...input, commandId: 'another-command-id' })
  assert.equal(created.idempotent, false)
  assert.equal(byCommand.idempotencyKey, 'command_id')
  assert.equal(byClient.idempotencyKey, 'client_message_id')
  await rejectsCode(actor.enqueueCommand({ ...input, text: 'different' }), 'COMMAND_IDEMPOTENCY_CONFLICT')
  await rejectsCode(actor.enqueueCommand({ ...input, commandId: 'conflict-command', text: 'different' }), 'CLIENT_MESSAGE_ID_CONFLICT')
  await rejectsCode(actor.enqueueCommand({ ...input, commandId: 'conflict-conversation', conversationKey: 'conversation-b' }), 'CLIENT_MESSAGE_ID_CONFLICT')
  assert.equal(client.commandRows().length, 1)
})

test('same clientMessageId is account scoped while commandId is globally unique', async () => {
  const { actor } = harness()
  await actor.enqueueCommand(command('global-command', 'conversation-a', 'same', 'same-client', 'account-a'))
  await actor.enqueueCommand(command('other-global-command', 'conversation-a', 'same', 'same-client', 'account-b'))
  await rejectsCode(actor.enqueueCommand(command('global-command', 'conversation-a', 'same', 'different-client', 'account-b')), 'COMMAND_IDEMPOTENCY_CONFLICT')
})

test('enqueue requires an account-scoped route anchor but permits unresolved durable queueing', async () => {
  const { actor, client } = harness()
  const queued = await actor.enqueueCommand(command('unresolved', 'conversation-unresolved'))
  assert.equal(queued.command.commandSequence, 1)
  await rejectsCode(actor.enqueueCommand(command('missing', 'missing-conversation')), 'NOT_FOUND')
  await rejectsCode(actor.enqueueCommand(command('cross-account', 'conversation-b', 'x', 'x', 'account-b')), 'NOT_FOUND')
  assert.equal(client.commandRows().length, 1)
})

test('enqueue transaction rollback leaves no command and no false sequence allocation', async () => {
  const { actor, client } = harness()
  client.failNextCommandCreate()
  await rejectsCode(actor.enqueueCommand(command('rollback')), 'DATABASE_FAILURE')
  assert.equal(client.commandRows().length, 0)
  assert.equal(client.actorRows().length, 0)
  const retry = await actor.enqueueCommand(command('retry-after-rollback'))
  assert.equal(retry.command.commandSequence, 1)
})

test('actor leases are isolated, renewable, releasable, monotonic, and stale-safe', async () => {
  const { actor } = harness()
  const leaseA = await acquire(actor)
  const leaseB = await acquire(actor, 'conversation-b', 'owner-b')
  assert.equal(leaseA.leaseEpoch, 1)
  assert.equal(leaseB.leaseEpoch, 1)
  assert.equal(leaseA.physicalSendAuthorized, false)
  await rejectsCode(acquire(actor, 'conversation-a', 'owner-other'), 'LEASE_HELD')
  const renewed = await actor.renewActorLease({
    accountId: 'account-a', conversationKey: 'conversation-a', ownerId: 'owner-a', leaseEpoch: 1,
    expectedOptimisticVersion: leaseA.optimisticVersion, now: new Date(now.valueOf() + 1), leaseMilliseconds: 10_000,
  })
  await rejectsCode(actor.renewActorLease({
    accountId: 'account-a', conversationKey: 'conversation-a', ownerId: 'owner-a', leaseEpoch: 0,
    expectedOptimisticVersion: renewed.optimisticVersion, now: new Date(now.valueOf() + 2), leaseMilliseconds: 10_000,
  }), 'STALE_ACTOR_LEASE')
  const released = await actor.releaseActorLease({
    accountId: 'account-a', conversationKey: 'conversation-a', ownerId: 'owner-a', leaseEpoch: 1,
    expectedOptimisticVersion: renewed.optimisticVersion, now: new Date(now.valueOf() + 2),
  })
  assert.equal(released.leaseOwnerId, null)
  const acquiredAgain = await acquire(actor, 'conversation-a', 'owner-next', new Date(now.valueOf() + 3))
  assert.equal(acquiredAgain.leaseEpoch, 2)
})

test('expired lease takeover increments epoch once and fences every stale-owner operation', async () => {
  const { actor } = harness()
  await actor.enqueueCommand(command('takeover-command'))
  const first = await actor.acquireActorLease({
    accountId: 'account-a', conversationKey: 'conversation-a', ownerId: 'old-owner', now, leaseMilliseconds: 100,
  })
  const reservation = await actor.reserveNextCommand({
    accountId: 'account-a', conversationKey: 'conversation-a', ownerId: 'old-owner', leaseEpoch: first.leaseEpoch,
    expectedActorVersion: first.optimisticVersion, now, reservationMilliseconds: 100,
  })
  assert.equal(reservation.status, 'reserved')
  const takeoverAt = new Date(now.valueOf() + 101)
  const second = await actor.acquireActorLease({
    accountId: 'account-a', conversationKey: 'conversation-a', ownerId: 'new-owner', now: takeoverAt, leaseMilliseconds: 1000,
  })
  assert.equal(second.leaseEpoch, first.leaseEpoch + 1)
  await rejectsCode(actor.reserveNextCommand({
    accountId: 'account-a', conversationKey: 'conversation-a', ownerId: 'old-owner', leaseEpoch: first.leaseEpoch,
    expectedActorVersion: first.optimisticVersion, now: takeoverAt,
  }), 'STALE_ACTOR_LEASE')
  await rejectsCode(actor.prepareReservedCommand({
    accountId: 'account-a', conversationKey: 'conversation-a', reservationId: reservation.status === 'reserved' ? reservation.reservation.reservationId : '',
    ownerId: 'old-owner', leaseEpoch: first.leaseEpoch, expectedActorVersion: first.optimisticVersion,
    expectedReservationVersion: 0, now: takeoverAt,
  }), 'STALE_ACTOR_LEASE')
  await rejectsCode(actor.releaseActorLease({
    accountId: 'account-a', conversationKey: 'conversation-a', ownerId: 'old-owner', leaseEpoch: first.leaseEpoch,
    expectedOptimisticVersion: first.optimisticVersion, now: takeoverAt,
  }), 'STALE_ACTOR_LEASE')
})

test('reservation enforces FIFO and standalone handoff is forbidden without Dispatch Ledger', async () => {
  const { actor, client } = harness()
  await actor.enqueueCommand(command('fifo-1'))
  await actor.enqueueCommand(command('fifo-2'))
  const lease = await acquire(actor)
  const first = await actor.reserveNextCommand({
    accountId: 'account-a', conversationKey: 'conversation-a', ownerId: 'owner-a', leaseEpoch: lease.leaseEpoch,
    expectedActorVersion: lease.optimisticVersion, now,
  })
  assert.equal(first.status, 'reserved')
  if (first.status !== 'reserved') return
  assert.equal(first.command.commandSequence, 1)
  const repeated = await actor.reserveNextCommand({
    accountId: 'account-a', conversationKey: 'conversation-a', ownerId: 'owner-a', leaseEpoch: lease.leaseEpoch,
    expectedActorVersion: lease.optimisticVersion, now,
  })
  assert.equal(repeated.status === 'reserved' && repeated.idempotent, true)
  const released = await actor.releaseReservation({
    accountId: 'account-a', conversationKey: 'conversation-a', reservationId: first.reservation.reservationId,
    ownerId: 'owner-a', leaseEpoch: lease.leaseEpoch, expectedActorVersion: lease.optimisticVersion,
    expectedReservationVersion: 0, now,
  })
  assert.equal(released.reservationState, 'released')
  const retried = await actor.reserveNextCommand({
    accountId: 'account-a', conversationKey: 'conversation-a', ownerId: 'owner-a', leaseEpoch: lease.leaseEpoch,
    expectedActorVersion: lease.optimisticVersion, now: new Date(now.valueOf() + 1),
  })
  assert.equal(retried.status === 'reserved' && retried.command.commandSequence, 1)
  if (retried.status !== 'reserved') return
  await rejectsCode(actor.markReservationHandedOff({
    accountId: 'account-a', conversationKey: 'conversation-a', reservationId: retried.reservation.reservationId,
    ownerId: 'owner-a', leaseEpoch: lease.leaseEpoch, expectedActorVersion: lease.optimisticVersion,
    expectedReservationVersion: 0, handoffReference: 'future-dispatch-boundary-1', now: new Date(now.valueOf() + 2),
  }), 'DISPATCH_LEDGER_REQUIRED')
  assert.equal(client.commandRows().length, 2)
  assert.equal(client.reservationRows().some(row => row.reservationState === 'handed_off'), false)
  assert.equal(client.actorRows()[0]?.nextHandoffSequence, 1)
})

test('standalone handoff guard performs no reservation or actor mutation', async () => {
  const { actor, client } = harness()
  await actor.enqueueCommand(command('atomic-handoff'))
  const lease = await acquire(actor)
  const reserved = await actor.reserveNextCommand({
    accountId: 'account-a', conversationKey: 'conversation-a', ownerId: 'owner-a', leaseEpoch: lease.leaseEpoch,
    expectedActorVersion: lease.optimisticVersion, now,
  })
  if (reserved.status !== 'reserved') throw new Error('expected reservation')
  await rejectsCode(actor.markReservationHandedOff({
    accountId: 'account-a', conversationKey: 'conversation-a', reservationId: reserved.reservation.reservationId,
    ownerId: 'owner-a', leaseEpoch: lease.leaseEpoch, expectedActorVersion: lease.optimisticVersion,
    expectedReservationVersion: 0, handoffReference: 'future-boundary', now: new Date(now.valueOf() + 1),
  }), 'DISPATCH_LEDGER_REQUIRED')
  assert.equal(client.reservationRows()[0]?.reservationState, 'reserved')
  assert.equal(client.actorRows()[0]?.nextHandoffSequence, 1)
})

test('expired reservation retains FIFO head until explicit expiry and can then be reclaimed', async () => {
  const { actor } = harness()
  await actor.enqueueCommand(command('expire-head'))
  const lease = await actor.acquireActorLease({
    accountId: 'account-a', conversationKey: 'conversation-a', ownerId: 'owner-a', now, leaseMilliseconds: 10_000,
  })
  const reserved = await actor.reserveNextCommand({
    accountId: 'account-a', conversationKey: 'conversation-a', ownerId: 'owner-a', leaseEpoch: lease.leaseEpoch,
    expectedActorVersion: lease.optimisticVersion, now, reservationMilliseconds: 100,
  })
  if (reserved.status !== 'reserved') throw new Error('expected reservation')
  await rejectsCode(actor.releaseReservation({
    accountId: 'account-a', conversationKey: 'conversation-a', reservationId: reserved.reservation.reservationId,
    ownerId: 'owner-a', leaseEpoch: lease.leaseEpoch, expectedActorVersion: lease.optimisticVersion,
    expectedReservationVersion: 1, now: new Date(now.valueOf() + 1),
  }), 'STALE_RESERVATION_VERSION')
  await rejectsCode(actor.expireReservation({
    accountId: 'account-a', conversationKey: 'conversation-a', reservationId: reserved.reservation.reservationId,
    expectedReservationVersion: 0, now: new Date(now.valueOf() + 99),
  }), 'RESERVATION_NOT_EXPIRED')
  const expired = await actor.expireReservation({
    accountId: 'account-a', conversationKey: 'conversation-a', reservationId: reserved.reservation.reservationId,
    expectedReservationVersion: 0, now: new Date(now.valueOf() + 100),
  })
  assert.equal(expired.reservationState, 'expired')
  const reclaimed = await actor.reserveNextCommand({
    accountId: 'account-a', conversationKey: 'conversation-a', ownerId: 'owner-a', leaseEpoch: lease.leaseEpoch,
    expectedActorVersion: lease.optimisticVersion, now: new Date(now.valueOf() + 101),
  })
  assert.equal(reclaimed.status === 'reserved' && reclaimed.command.commandSequence, 1)
})

test('reservation and route failure in conversation A do not block conversation B', async () => {
  const { actor } = harness()
  await actor.enqueueCommand(command('independent-a', 'conversation-unresolved'))
  await actor.enqueueCommand(command('independent-b', 'conversation-b'))
  const leaseA = await acquire(actor, 'conversation-unresolved', 'owner-a')
  const leaseB = await acquire(actor, 'conversation-b', 'owner-b')
  const reservedA = await actor.reserveNextCommand({
    accountId: 'account-a', conversationKey: 'conversation-unresolved', ownerId: 'owner-a',
    leaseEpoch: leaseA.leaseEpoch, expectedActorVersion: leaseA.optimisticVersion, now,
  })
  const reservedB = await actor.reserveNextCommand({
    accountId: 'account-a', conversationKey: 'conversation-b', ownerId: 'owner-b',
    leaseEpoch: leaseB.leaseEpoch, expectedActorVersion: leaseB.optimisticVersion, now,
  })
  assert.equal(reservedA.status, 'reserved')
  assert.equal(reservedB.status, 'reserved')
  if (reservedA.status !== 'reserved' || reservedB.status !== 'reserved') return
  await rejectsCode(actor.prepareReservedCommand({
    accountId: 'account-a', conversationKey: 'conversation-unresolved', reservationId: reservedA.reservation.reservationId,
    ownerId: 'owner-a', leaseEpoch: leaseA.leaseEpoch, expectedActorVersion: leaseA.optimisticVersion,
    expectedReservationVersion: 0, now,
  }), 'ROUTE_NOT_SENDABLE')
  const preparedB = await actor.prepareReservedCommand({
    accountId: 'account-a', conversationKey: 'conversation-b', reservationId: reservedB.reservation.reservationId,
    ownerId: 'owner-b', leaseEpoch: leaseB.leaseEpoch, expectedActorVersion: leaseB.optimisticVersion,
    expectedReservationVersion: 0, now,
  })
  assert.equal(preparedB.conversationKey, 'conversation-b')
  assert.equal(preparedB.physicalSendAuthorized, false)
})

test('classified errors never include outbound message text', async () => {
  const { actor } = harness()
  const sensitiveSyntheticText = ['sensitive', 'synthetic', 'content'].join('-')
  await actor.enqueueCommand(command('safe-error', 'conversation-a', sensitiveSyntheticText, 'safe-error-client'))
  const error = await rejectsCode(actor.enqueueCommand(command('safe-error', 'conversation-a', `${sensitiveSyntheticText}-changed`, 'safe-error-client')), 'COMMAND_IDEMPOTENCY_CONFLICT')
  assert.equal(error.message.includes(sensitiveSyntheticText), false)
})

test('route preparation uses only the current registry snapshot and never grants physical-send authority', async () => {
  const { actor, routes } = harness()
  await actor.enqueueCommand(command('prepare-active'))
  const lease = await acquire(actor)
  const reserved = await actor.reserveNextCommand({
    accountId: 'account-a', conversationKey: 'conversation-a', ownerId: 'owner-a', leaseEpoch: lease.leaseEpoch,
    expectedActorVersion: lease.optimisticVersion, now,
  })
  if (reserved.status !== 'reserved') throw new Error('expected reservation')
  routes.set('account-a', 'conversation-a', 'active', 7)
  const prepared = await actor.prepareReservedCommand({
    accountId: 'account-a', conversationKey: 'conversation-a', reservationId: reserved.reservation.reservationId,
    ownerId: 'owner-a', leaseEpoch: lease.leaseEpoch, expectedActorVersion: lease.optimisticVersion,
    expectedReservationVersion: 0, now,
  })
  assert.equal(prepared.routeVersion, 7)
  assert.equal(prepared.activeProtocolChatId, 'conversation-a-protocol')
  assert.equal(prepared.physicalSendAuthorized, false)

  for (const conversationKey of ['conversation-unresolved', 'conversation-conflicted', 'conversation-retired']) {
    await actor.enqueueCommand(command(`route-${conversationKey}`, conversationKey))
    const routeLease = await acquire(actor, conversationKey, `owner-${conversationKey}`)
    const routeReservation = await actor.reserveNextCommand({
      accountId: 'account-a', conversationKey, ownerId: `owner-${conversationKey}`, leaseEpoch: routeLease.leaseEpoch,
      expectedActorVersion: routeLease.optimisticVersion, now,
    })
    if (routeReservation.status !== 'reserved') throw new Error('expected route reservation')
    await rejectsCode(actor.prepareReservedCommand({
      accountId: 'account-a', conversationKey, reservationId: routeReservation.reservation.reservationId,
      ownerId: `owner-${conversationKey}`, leaseEpoch: routeLease.leaseEpoch,
      expectedActorVersion: routeLease.optimisticVersion, expectedReservationVersion: 0, now,
    }), 'ROUTE_NOT_SENDABLE')
  }
})

test('feature flag is account-scoped and fails closed', () => {
  assert.equal(isPerChatOutboundActorEnabled('account-a', undefined), false)
  assert.equal(isPerChatOutboundActorEnabled('account-a', ''), false)
  assert.equal(isPerChatOutboundActorEnabled('account-a', '   '), false)
  assert.equal(isPerChatOutboundActorEnabled('account-a', '*'), false)
  assert.equal(isPerChatOutboundActorEnabled('account-a', 'true'), false)
  assert.equal(isPerChatOutboundActorEnabled('account-a', 'account-a,account-a'), true)
  assert.equal(isPerChatOutboundActorEnabled('account-b', 'account-a,account-a'), false)
  assert.equal(isPerChatOutboundActorEnabled('account-a', 'account-a, account-b'), false)
})
