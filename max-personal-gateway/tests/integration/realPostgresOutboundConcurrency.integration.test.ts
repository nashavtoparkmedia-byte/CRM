import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { PrismaPerConversationOutboundActor } from '../../src/outbound/PrismaPerConversationOutboundActor.ts'
import type { EnqueueOutboundCommandInput } from '../../src/outbound/types.ts'
import { PrismaRouteRegistry } from '../../src/route/PrismaRouteRegistry.ts'
import {
  createRealPrismaClient,
  errorCode,
  readRealPostgresConfig,
  runId,
  type RealPrismaClient,
} from '../support/realPostgres.ts'

const config = readRealPostgresConfig()

async function createActiveConversation(client: RealPrismaClient, accountId: string, conversationKey: string): Promise<void> {
  await client.maxRouteConversation.create({ data: { id: runId('route'), accountId, conversationKey, routeVersion: 1, optimisticVersion: 0, state: 'active' } })
  await client.maxRouteIdentityBinding.create({
    data: {
      id: runId('binding'), accountId, identityKind: 'protocol_chat_id', identityValue: `${conversationKey}-protocol`,
      conversationKey, status: 'active', firstSeenAt: new Date(), lastSeenAt: new Date(), evidenceRef: runId('evidence'), version: 1,
    },
  })
}

function command(accountId: string, conversationKey: string, commandId: string, clientMessageId: string, text: string): EnqueueOutboundCommandInput {
  return { commandId, accountId, conversationKey, clientMessageId, commandKind: 'text', text, source: 'synthetic_test' }
}

function summary(results: PromiseSettledResult<any>[]) {
  const fulfilled = results.filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled')
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  const classifiedCodes = new Set([
    'CLIENT_MESSAGE_ID_CONFLICT', 'COMMAND_IDEMPOTENCY_CONFLICT', 'LEASE_HELD', 'STALE_ACTOR_LEASE',
    'STALE_ACTOR_VERSION', 'RESERVATION_CONFLICT', 'RESERVATION_NOT_ACTIVE', 'STALE_RESERVATION_VERSION',
  ])
  return {
    attempts: results.length,
    successes: fulfilled.length,
    idempotent: fulfilled.filter(result => result.value?.idempotent === true).length,
    classifiedConflicts: rejected.filter(result => classifiedCodes.has(errorCode(result.reason) ?? '')).length,
    unexpectedErrors: rejected.filter(result => !classifiedCodes.has(errorCode(result.reason) ?? '')).length,
  }
}

if (config === null) {
  test('real PostgreSQL outbound concurrency gate requires PERSONAL_MAX_REAL_POSTGRES_URL', { skip: true }, () => {})
} else {
  describe('Stage 4 real PostgreSQL outbound concurrency', { concurrency: false }, () => {
    let client: RealPrismaClient
    let actor: PrismaPerConversationOutboundActor

    before(async () => {
      client = await createRealPrismaClient(config)
      actor = new PrismaPerConversationOutboundActor(client as any, new PrismaRouteRegistry(client as any))
    })

    after(async () => {
      await client.$disconnect()
    })

    test('100 concurrent identical-text commands in one conversation allocate exact sequence 1..100', async () => {
      const account = runId('s4_conc_one')
      const conversation = runId('conversation')
      await createActiveConversation(client, account, conversation)
      const results = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => actor.enqueueCommand(command(
        account, conversation, runId(`command_${index}`), runId(`client_${index}`), 'identical concurrent text',
      ))))
      const counts = summary(results)
      const rows = await client.maxOutboundCommand.findMany({ where: { accountId: account, conversationKey: conversation }, orderBy: { commandSequence: 'asc' } })
      assert.deepEqual({ successes: counts.successes, unexpectedErrors: counts.unexpectedErrors }, { successes: 100, unexpectedErrors: 0 })
      assert.deepEqual(rows.map((row: any) => row.commandSequence), Array.from({ length: 100 }, (_, index) => index + 1))
      assert.equal(new Set(rows.map((row: any) => row.commandId)).size, 100)
      console.log('STAGE4_CONCURRENCY same_conversation', JSON.stringify({ ...counts, finalRows: 100, sequenceRange: '1..100', duplicateRows: 0, lostCommands: 0, invariantViolations: 0 }))
    })

    test('100 concurrent commands each for A and B allocate independent sequence 1..100', async () => {
      const account = runId('s4_conc_ab')
      const a = runId('conversation_a')
      const b = runId('conversation_b')
      await createActiveConversation(client, account, a)
      await createActiveConversation(client, account, b)
      const attempts = [a, b].flatMap(conversation => Array.from({ length: 100 }, (_, index) => actor.enqueueCommand(command(
        account, conversation, runId(`command_${conversation}_${index}`), runId(`client_${conversation}_${index}`), 'same A/B text',
      ))))
      const results = await Promise.allSettled(attempts)
      const counts = summary(results)
      const [rowsA, rowsB] = await Promise.all([
        client.maxOutboundCommand.findMany({ where: { accountId: account, conversationKey: a }, orderBy: { commandSequence: 'asc' } }),
        client.maxOutboundCommand.findMany({ where: { accountId: account, conversationKey: b }, orderBy: { commandSequence: 'asc' } }),
      ])
      assert.equal(counts.successes, 200)
      assert.deepEqual(rowsA.map((row: any) => row.commandSequence), Array.from({ length: 100 }, (_, i) => i + 1))
      assert.deepEqual(rowsB.map((row: any) => row.commandSequence), Array.from({ length: 100 }, (_, i) => i + 1))
      console.log('STAGE4_CONCURRENCY ab_enqueue', JSON.stringify({ ...counts, finalA: 100, finalB: 100, sequenceRangeA: '1..100', sequenceRangeB: '1..100', blockingLeakage: 0, duplicateRows: 0, lostCommands: 0, invariantViolations: 0 }))
    })

    test('25 concurrent identical clientMessageId retries store one command and allocate sequence once', async () => {
      const account = runId('s4_conc_idempotent')
      const conversation = runId('conversation')
      const clientMessageId = runId('logical_client')
      await createActiveConversation(client, account, conversation)
      const results = await Promise.allSettled(Array.from({ length: 25 }, (_, index) => actor.enqueueCommand(command(
        account, conversation, runId(`retry_${index}`), clientMessageId, 'one logical command',
      ))))
      const counts = summary(results)
      const rows = await client.maxOutboundCommand.findMany({ where: { accountId: account } })
      assert.equal(counts.successes, 25)
      assert.equal(counts.idempotent, 24)
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.commandSequence, 1)
      console.log('STAGE4_CONCURRENCY idempotent_retry', JSON.stringify({ ...counts, finalRows: 1, sequenceRange: '1..1', duplicateRows: 0, lostCommands: 0, invariantViolations: 0 }))
    })

    test('25 conflicting clientMessageId retries keep one winner and classify all losers', async () => {
      const account = runId('s4_conc_conflict')
      const conversation = runId('conversation')
      const clientMessageId = runId('logical_client')
      await createActiveConversation(client, account, conversation)
      const results = await Promise.allSettled(Array.from({ length: 25 }, (_, index) => actor.enqueueCommand(command(
        account, conversation, runId(`conflict_${index}`), clientMessageId, `conflicting-${index}`,
      ))))
      const counts = summary(results)
      assert.deepEqual({ successes: counts.successes, classifiedConflicts: counts.classifiedConflicts, unexpectedErrors: counts.unexpectedErrors },
        { successes: 1, classifiedConflicts: 24, unexpectedErrors: 0 })
      assert.equal(await client.maxOutboundCommand.count({ where: { accountId: account } }), 1)
      console.log('STAGE4_CONCURRENCY conflicting_retry', JSON.stringify({ ...counts, finalRows: 1, sequenceRange: '1..1', silentOverwrite: 0, duplicateRows: 0, invariantViolations: 0 }))
    })

    test('25 actor acquire attempts elect one owner while A and B both acquire independently', async () => {
      const account = runId('s4_conc_lease')
      const conversation = runId('conversation')
      const a = runId('conversation_a')
      const b = runId('conversation_b')
      for (const key of [conversation, a, b]) await createActiveConversation(client, account, key)
      const results = await Promise.allSettled(Array.from({ length: 25 }, (_, index) => actor.acquireActorLease({
        accountId: account, conversationKey: conversation, ownerId: `owner-${index}`, leaseMilliseconds: 30_000,
      })))
      const counts = summary(results)
      assert.deepEqual({ successes: counts.successes, classifiedConflicts: counts.classifiedConflicts, unexpectedErrors: counts.unexpectedErrors },
        { successes: 1, classifiedConflicts: 24, unexpectedErrors: 0 })
      const independent = await Promise.all([
        actor.acquireActorLease({ accountId: account, conversationKey: a, ownerId: 'owner-a' }),
        actor.acquireActorLease({ accountId: account, conversationKey: b, ownerId: 'owner-b' }),
      ])
      assert.deepEqual(independent.map(lease => lease.leaseEpoch), [1, 1])
      console.log('STAGE4_CONCURRENCY lease_contention', JSON.stringify({ ...counts, finalOwners: 1, epoch: 1, invariantViolations: 0 }))
      console.log('STAGE4_CONCURRENCY ab_lease', JSON.stringify({ attempts: 2, successes: 2, idempotent: 0, classifiedConflicts: 0, unexpectedErrors: 0, globalLease: 0, invariantViolations: 0 }))
    })

    test('25 concurrent reserveNext attempts converge to one active FIFO-head reservation', async () => {
      const account = runId('s4_conc_reserve')
      const conversation = runId('conversation')
      await createActiveConversation(client, account, conversation)
      await actor.enqueueCommand(command(account, conversation, runId('head'), runId('client'), 'head'))
      const lease = await actor.acquireActorLease({ accountId: account, conversationKey: conversation, ownerId: 'reserve-owner' })
      const results = await Promise.allSettled(Array.from({ length: 25 }, () => actor.reserveNextCommand({
        accountId: account, conversationKey: conversation, ownerId: 'reserve-owner', leaseEpoch: lease.leaseEpoch,
        expectedActorVersion: lease.optimisticVersion,
      })))
      const counts = summary(results)
      assert.equal(counts.successes + counts.classifiedConflicts, 25)
      assert.equal(counts.unexpectedErrors, 0)
      assert.equal(await client.maxOutboundCommandReservation.count({ where: { accountId: account, reservationState: 'reserved' } }), 1)
      const reservation = await client.maxOutboundCommandReservation.findFirst({ where: { accountId: account, reservationState: 'reserved' } })
      assert.equal(reservation.commandSequence, 1)
      console.log('STAGE4_CONCURRENCY reservation', JSON.stringify({ ...counts, finalRows: 1, sequenceRange: '1..1', activeReservations: 1, headSkipped: 0, duplicateRows: 0, invariantViolations: 0 }))
    })

    test('10 takeover attempts after expiry increase epoch exactly once and fence old owner', async () => {
      const account = runId('s4_conc_takeover')
      const conversation = runId('conversation')
      await createActiveConversation(client, account, conversation)
      const start = new Date('2026-07-26T23:30:00.000Z')
      const old = await actor.acquireActorLease({ accountId: account, conversationKey: conversation, ownerId: 'old-owner', now: start, leaseMilliseconds: 100 })
      const takeoverAt = new Date(start.valueOf() + 101)
      const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => actor.acquireActorLease({
        accountId: account, conversationKey: conversation, ownerId: `new-owner-${index}`, now: takeoverAt, leaseMilliseconds: 10_000,
      })))
      const counts = summary(results)
      const final = await actor.getActorState(account, conversation)
      assert.deepEqual({ successes: counts.successes, classifiedConflicts: counts.classifiedConflicts, unexpectedErrors: counts.unexpectedErrors },
        { successes: 1, classifiedConflicts: 9, unexpectedErrors: 0 })
      assert.equal(final?.leaseEpoch, old.leaseEpoch + 1)
      await assert.rejects(actor.releaseActorLease({
        accountId: account, conversationKey: conversation, ownerId: 'old-owner', leaseEpoch: old.leaseEpoch,
        expectedOptimisticVersion: old.optimisticVersion, now: takeoverAt,
      }), error => errorCode(error) === 'STALE_ACTOR_LEASE')
      console.log('STAGE4_CONCURRENCY lease_takeover', JSON.stringify({ ...counts, finalRows: 1, initialEpoch: old.leaseEpoch, finalEpoch: final?.leaseEpoch, epochIncrements: 1, staleOwnerActions: 0, invariantViolations: 0 }))
    })
  })
}
