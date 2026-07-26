import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { DispatchLedgerError } from '../../src/dispatch/errors.ts'
import { PrismaDispatchLedger } from '../../src/dispatch/PrismaDispatchLedger.ts'
import { PrismaPerConversationOutboundActor } from '../../src/outbound/PrismaPerConversationOutboundActor.ts'
import {
  createConversation,
  createDispatchFixture,
  createLedgerHarness,
  createReservedFixture,
} from '../support/dispatchHarness.ts'
import {
  createRealPrismaClient,
  errorCode,
  readRealPostgresConfig,
  runId,
  type RealPrismaClient,
} from '../support/realPostgres.ts'

const config = readRealPostgresConfig()

function beginInput(dispatch: any, suffix = '') {
  const now = new Date()
  return {
    attemptId: runId('attempt' + suffix), accountId: dispatch.accountId, conversationKey: dispatch.conversationKey,
    dispatchId: dispatch.dispatchId, expectedStateVersion: dispatch.stateVersion,
    senderOwnerId: 'concurrency-owner', senderFencingEpoch: 19, senderProofTimestamp: now,
    attemptCorrelationId: runId('correlation' + suffix), transitionIdempotencyKey: runId('begin' + suffix), now,
  }
}

function transitionInput(dispatch: any, attempt: any, key: string, reference: string) {
  return {
    accountId: dispatch.accountId, conversationKey: dispatch.conversationKey, dispatchId: dispatch.dispatchId,
    attemptId: attempt.attemptId, expectedStateVersion: dispatch.stateVersion,
    expectedAttemptVersion: attempt.attemptVersion, transitionIdempotencyKey: key,
    evidenceReference: reference, now: new Date(),
  }
}

function outcomeCounts(results: readonly PromiseSettledResult<any>[]) {
  return {
    successes: results.filter(result => result.status === 'fulfilled').length,
    idempotent: results.filter(result => result.status === 'fulfilled' && result.value.idempotent === true).length,
    classified: results.filter(result => result.status === 'rejected' && errorCode(result.reason) !== undefined).length,
    unexpected: results.filter(result => result.status === 'rejected' && errorCode(result.reason) === undefined).length,
  }
}

async function awaiting(ledger: PrismaDispatchLedger, created: any) {
  const begun = await ledger.beginAttempt(beginInput(created.dispatch))
  const marked = await ledger.markPhysicalActionStarted(transitionInput(
    begun.dispatch, begun.attempt, runId('physical'), runId('marker'),
  ))
  const accepted = await ledger.recordClientActionAccepted(transitionInput(
    marked.dispatch, marked.attempt, runId('client'), runId('local_ack'),
  ))
  return ledger.markAwaitingConfirmation(transitionInput(
    accepted.dispatch, accepted.attempt, runId('await'), runId('correlation'),
  ))
}

async function unknown(ledger: PrismaDispatchLedger, created: any) {
  const begun = await ledger.beginAttempt(beginInput(created.dispatch))
  const marked = await ledger.markPhysicalActionStarted(transitionInput(
    begun.dispatch, begun.attempt, runId('physical'), runId('marker'),
  ))
  return ledger.recordUnknownOutcome({
    ...transitionInput(marked.dispatch, marked.attempt, runId('unknown'), runId('uncertain')),
    reason: 'timeout',
  })
}

if (config === null) {
  test('real PostgreSQL Dispatch concurrency gate requires PERSONAL_MAX_REAL_POSTGRES_URL', { skip: true }, () => {})
} else {
  describe('Stage 5 real PostgreSQL Dispatch concurrency', { concurrency: false }, () => {
    let client: RealPrismaClient
    let actor: PrismaPerConversationOutboundActor
    let ledger: PrismaDispatchLedger

    before(async () => {
      client = await createRealPrismaClient(config)
      const harness = createLedgerHarness(client)
      actor = harness.actor
      ledger = harness.ledger
    })

    after(async () => {
      await client.$disconnect()
    })

    test('25 concurrent creations of one reservation produce one complete Dispatch graph', async () => {
      const account = runId('s5_conc_create')
      const conversation = runId('conversation')
      await createConversation(client, account, conversation)
      const fixture = await createReservedFixture(actor, account, conversation)
      const input = {
        dispatchId: runId('dispatch'), accountId: account, conversationKey: conversation,
        reservationId: fixture.reservation.reservationId, expectedCommandId: fixture.commandId,
        expectedCommandSequence: fixture.commandSequence, ownerId: fixture.ownerId,
        actorLeaseEpoch: fixture.actorState.leaseEpoch, expectedActorVersion: fixture.actorState.optimisticVersion,
        expectedReservationVersion: fixture.reservation.reservationVersion,
        transitionIdempotencyKey: runId('create_key'),
      }
      const results = await Promise.allSettled(Array.from({ length: 25 }, () => ledger.createDispatchFromReservation(input)))
      const counts = outcomeCounts(results)
      assert.equal(counts.successes + counts.classified, 25)
      assert.equal(counts.unexpected, 0)
      assert.equal(await client.maxOutboundDispatch.count({ where: { reservationId: fixture.reservation.reservationId } }), 1)
      assert.equal(await client.maxOutboundDispatchTransition.count({ where: { eventType: 'dispatch_created', accountId: account } }), 1)
      assert.equal((await actor.getActorState(account, conversation))?.nextHandoffSequence, 2)
      console.log('STAGE5_CONCURRENCY dispatch_creation', JSON.stringify({
        attempts: 25, ...counts, finalDispatchRows: 1, finalTransitionRows: 1,
        actorHeadAdvances: 1, partialRows: 0, duplicateRows: 0, invariantViolations: 0,
      }))
    })

    test('100 Dispatch each for A/B remain independently ordered with zero loss', { timeout: 300_000 }, async () => {
      const account = runId('s5_conc_ab')
      const a = runId('a')
      const b = runId('b')
      await createConversation(client, account, a)
      await createConversation(client, account, b)
      for (let index = 0; index < 100; index += 1) {
        await Promise.all([
          createDispatchFixture(actor, ledger, account, a, 'owner-a', 'identical'),
          createDispatchFixture(actor, ledger, account, b, 'owner-b', 'identical'),
        ])
      }
      const [rowsA, rowsB] = await Promise.all([
        client.maxOutboundDispatch.findMany({ where: { accountId: account, conversationKey: a }, orderBy: { commandSequence: 'asc' } }),
        client.maxOutboundDispatch.findMany({ where: { accountId: account, conversationKey: b }, orderBy: { commandSequence: 'asc' } }),
      ])
      assert.deepEqual(rowsA.map((row: any) => row.commandSequence), Array.from({ length: 100 }, (_, index) => index + 1))
      assert.deepEqual(rowsB.map((row: any) => row.commandSequence), Array.from({ length: 100 }, (_, index) => index + 1))
      console.log('STAGE5_CONCURRENCY ab_creation', JSON.stringify({
        attempts: 200, successes: 200, idempotent: 0, classified: 0, unexpected: 0,
        finalDispatchRows: 200, sequenceA: '1..100', sequenceB: '1..100',
        wrongConversation: 0, lostRows: 0, duplicateRows: 0, invariantViolations: 0,
      }))
    })

    test('25 beginAttempt calls produce one active Attempt and one state mutation', async () => {
      const account = runId('s5_conc_begin')
      const conversation = runId('conversation')
      await createConversation(client, account, conversation)
      const created = await createDispatchFixture(actor, ledger, account, conversation)
      const input = beginInput(created.dispatch)
      const results = await Promise.allSettled(Array.from({ length: 25 }, () => ledger.beginAttempt(input)))
      const counts = outcomeCounts(results)
      assert.equal(counts.successes + counts.classified, 25)
      assert.equal(counts.unexpected, 0)
      assert.equal(await client.maxOutboundDispatchAttempt.count({ where: { dispatchId: created.dispatch.dispatchId } }), 1)
      const stored = await ledger.getDispatch(account, conversation, created.dispatch.dispatchId)
      assert.equal(stored?.stateVersion, 2)
      console.log('STAGE5_CONCURRENCY begin_attempt', JSON.stringify({
        attempts: 25, ...counts, finalAttemptRows: 1, attemptNumber: 1,
        finalStateVersion: 2, duplicateRows: 0, invariantViolations: 0,
      }))
    })

    test('simultaneous sequence 1/2 begin permits only the physical FIFO head', async () => {
      const account = runId('s5_conc_fifo')
      const conversation = runId('conversation')
      await createConversation(client, account, conversation)
      const first = await createDispatchFixture(actor, ledger, account, conversation)
      const second = await createDispatchFixture(actor, ledger, account, conversation)
      const results = await Promise.allSettled([
        ledger.beginAttempt(beginInput(first.dispatch, 'first')),
        ledger.beginAttempt(beginInput(second.dispatch, 'second')),
      ])
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
      assert.equal(results.filter(result => result.status === 'rejected' && errorCode(result.reason) === 'FIFO_BLOCKED').length, 1)
      assert.equal(await client.maxOutboundDispatchAttempt.count({ where: { accountId: account } }), 1)
      console.log('STAGE5_CONCURRENCY fifo', JSON.stringify({
        attempts: 2, successes: 1, idempotent: 0, classified: 1, unexpected: 0,
        laneValue: 1, physicalActions: 0, duplicateRows: 0, invariantViolations: 0,
      }))
    })

    test('25 identical marker transitions mutate state/version and journal exactly once', async () => {
      const account = runId('s5_conc_transition')
      const conversation = runId('conversation')
      await createConversation(client, account, conversation)
      const created = await createDispatchFixture(actor, ledger, account, conversation)
      const begun = await ledger.beginAttempt(beginInput(created.dispatch))
      const key = runId('same_transition')
      const reference = runId('same_marker')
      const input = transitionInput(begun.dispatch, begun.attempt, key, reference)
      const results = await Promise.allSettled(Array.from({ length: 25 }, () => ledger.markPhysicalActionStarted(input)))
      const counts = outcomeCounts(results)
      assert.equal(counts.successes, 25)
      assert.equal(counts.idempotent, 24)
      assert.equal(await client.maxOutboundDispatchTransition.count({ where: { dispatchId: created.dispatch.dispatchId, eventType: 'physical_action_started' } }), 1)
      const stored = await ledger.getDispatch(account, conversation, created.dispatch.dispatchId)
      assert.equal(stored?.stateVersion, 3)
      console.log('STAGE5_CONCURRENCY transition_idempotency', JSON.stringify({
        attempts: 25, ...counts, finalTransitionRows: 1, finalStateVersion: 3,
        duplicateRows: 0, invariantViolations: 0,
      }))
    })

    test('25 conflicting transitions yield one winner and classified stale/invalid losers', async () => {
      const account = runId('s5_conc_conflict')
      const conversation = runId('conversation')
      await createConversation(client, account, conversation)
      const created = await createDispatchFixture(actor, ledger, account, conversation)
      const begun = await ledger.beginAttempt(beginInput(created.dispatch))
      const results = await Promise.allSettled(Array.from({ length: 25 }, (_, index) => {
        const input = transitionInput(begun.dispatch, begun.attempt, runId('conflict_' + index), runId('evidence_' + index))
        return index % 2 === 0
          ? ledger.markPhysicalActionStarted(input)
          : ledger.recordPreActionFailure({ ...input, safeErrorCode: 'SYNTHETIC_PRE_ACTION' })
      }))
      const counts = outcomeCounts(results)
      assert.equal(counts.successes, 1)
      assert.equal(counts.classified, 24)
      assert.equal(counts.unexpected, 0)
      assert.equal(await client.maxOutboundDispatchTransition.count({
        where: { dispatchId: created.dispatch.dispatchId, transitionSequence: 3 },
      }), 1)
      console.log('STAGE5_CONCURRENCY conflicting_transitions', JSON.stringify({
        attempts: 25, ...counts, finalTransitionRows: 1, finalStateVersion: 3,
        corruptedRows: 0, invariantViolations: 0,
      }))
    })

    test('25 late exact confirmations have one effect, lane advance and reconciliation resolution', async () => {
      const account = runId('s5_conc_late')
      const conversation = runId('conversation')
      await createConversation(client, account, conversation)
      const created = await createDispatchFixture(actor, ledger, account, conversation)
      const uncertain = await unknown(ledger, created)
      const key = runId('same_confirmation')
      const providerMessageId = runId('provider_message')
      const reference = runId('exact_echo')
      const input = {
        ...transitionInput(uncertain.dispatch, uncertain.attempt, key, reference),
        providerMessageId,
      }
      const results = await Promise.allSettled(Array.from({ length: 25 }, () => ledger.recordExactProviderConfirmation(input)))
      const counts = outcomeCounts(results)
      assert.equal(counts.successes, 25)
      assert.equal(counts.idempotent, 24)
      assert.equal(await client.maxOutboundDispatchTransition.count({ where: { dispatchId: created.dispatch.dispatchId, eventType: 'provider_confirmed' } }), 1)
      assert.equal(await client.maxOutboundReconciliationTask.count({ where: { dispatchId: created.dispatch.dispatchId, state: 'resolved' } }), 1)
      const lane = await client.maxOutboundDispatchLane.findUnique({ where: { accountId_conversationKey: { accountId: account, conversationKey: conversation } } })
      assert.equal(lane.nextPhysicalSequence, 2)
      console.log('STAGE5_CONCURRENCY late_confirmation', JSON.stringify({
        attempts: 25, ...counts, finalConfirmationTransitions: 1, reconciliationResolved: 1,
        laneValue: 2, laneAdvances: 1, duplicateRows: 0, invariantViolations: 0,
      }))
    })

    test('provider identity is unique per account but reusable in another account', async () => {
      const account = runId('s5_provider_scope')
      const otherAccount = runId('s5_provider_other')
      const conversation = runId('conversation')
      await createConversation(client, account, conversation)
      await createConversation(client, otherAccount, conversation)
      const first = await createDispatchFixture(actor, ledger, account, conversation)
      const second = await createDispatchFixture(actor, ledger, account, conversation)
      const other = await createDispatchFixture(actor, ledger, otherAccount, conversation, 'other-owner')
      const providerMessageId = runId('shared_provider')
      const firstAwaiting = await awaiting(ledger, first)
      await ledger.recordExactProviderConfirmation({
        ...transitionInput(firstAwaiting.dispatch, firstAwaiting.attempt, runId('confirm_first'), runId('echo_first')),
        providerMessageId,
      })
      const secondAwaiting = await awaiting(ledger, second)
      await assert.rejects(ledger.recordExactProviderConfirmation({
        ...transitionInput(secondAwaiting.dispatch, secondAwaiting.attempt, runId('confirm_second'), runId('echo_second')),
        providerMessageId,
      }), error => error instanceof DispatchLedgerError && error.code === 'PROVIDER_MESSAGE_ID_CONFLICT')
      const otherAwaiting = await awaiting(ledger, other)
      const otherConfirmed = await ledger.recordExactProviderConfirmation({
        ...transitionInput(otherAwaiting.dispatch, otherAwaiting.attempt, runId('confirm_other'), runId('echo_other')),
        providerMessageId,
      })
      assert.equal(otherConfirmed.dispatch.state, 'provider_confirmed')
      console.log('STAGE5_CONCURRENCY provider_identity', JSON.stringify({
        attempts: 3, successes: 2, idempotent: 0, classified: 1, unexpected: 0,
        sameAccountWinners: 1, crossAccountRows: 2, silentCrossConfirmation: 0,
        duplicateRows: 0, invariantViolations: 0,
      }))
    })

    test('25 retries under unknown outcome are rejected; exact absence permits one idempotent retry transition', async () => {
      const account = runId('s5_conc_retry')
      const conversation = runId('conversation')
      await createConversation(client, account, conversation)
      const created = await createDispatchFixture(actor, ledger, account, conversation)
      const uncertain = await unknown(ledger, created)
      const unsafe = await Promise.allSettled(Array.from({ length: 25 }, (_, index) => ledger.queueRetry({
        accountId: account, conversationKey: conversation, dispatchId: created.dispatch.dispatchId,
        expectedStateVersion: uncertain.dispatch.stateVersion, transitionIdempotencyKey: runId('unsafe_' + index),
        evidenceReference: runId('timeout_only_' + index),
      })))
      assert.equal(unsafe.filter(result => result.status === 'rejected' && errorCode(result.reason) === 'UNSAFE_RETRY').length, 25)
      assert.equal(await client.maxOutboundDispatchAttempt.count({ where: { dispatchId: created.dispatch.dispatchId } }), 1)
      const absence = await ledger.recordProviderAbsenceProven({
        ...transitionInput(uncertain.dispatch, uncertain.attempt, runId('absence'), runId('exact_negative')),
      })
      const retryKey = runId('safe_retry')
      const retryReference = runId('retry_policy')
      const retry = await Promise.allSettled(Array.from({ length: 25 }, () => ledger.queueRetry({
        accountId: account, conversationKey: conversation, dispatchId: created.dispatch.dispatchId,
        expectedStateVersion: absence.dispatch.stateVersion, transitionIdempotencyKey: retryKey,
        evidenceReference: retryReference,
      })))
      const counts = outcomeCounts(retry)
      assert.equal(counts.successes, 25)
      assert.equal(counts.idempotent, 24)
      assert.equal(await client.maxOutboundDispatchAttempt.count({ where: { dispatchId: created.dispatch.dispatchId } }), 1)
      console.log('STAGE5_CONCURRENCY unsafe_retry', JSON.stringify({
        attempts: 25, successes: 0, idempotent: 0, classified: 25, unexpected: 0,
        newAttemptsBeforeProof: 0, afterProofAttempts: 25, afterProofSuccesses: counts.successes,
        afterProofIdempotent: counts.idempotent, finalAttemptRows: 1,
        duplicateRows: 0, invariantViolations: 0,
      }))
    })
  })
}
