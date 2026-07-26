import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { PrismaDispatchLedger } from '../../src/dispatch/PrismaDispatchLedger.ts'
import { DispatchLedgerError } from '../../src/dispatch/errors.ts'
import { PrismaPerConversationOutboundActor } from '../../src/outbound/PrismaPerConversationOutboundActor.ts'
import {
  createConversation,
  createDispatchFixture,
  createLedgerHarness,
  createReservedFixture,
  ExplicitTestSenderAuthority,
} from '../support/dispatchHarness.ts'
import {
  createRealPrismaClient,
  readRealPostgresConfig,
  runId,
  type RealPrismaClient,
} from '../support/realPostgres.ts'

const config = readRealPostgresConfig()

async function rejectsCode(operation: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, error => error instanceof DispatchLedgerError && error.code === code)
}

function beginInput(dispatch: any, overrides: Record<string, unknown> = {}) {
  const now = new Date()
  return {
    attemptId: runId('attempt'), accountId: dispatch.accountId, conversationKey: dispatch.conversationKey,
    dispatchId: dispatch.dispatchId, expectedStateVersion: dispatch.stateVersion,
    senderOwnerId: 'test-session-owner', senderFencingEpoch: 11, senderProofTimestamp: now,
    attemptCorrelationId: runId('correlation'), transitionIdempotencyKey: runId('begin'), now,
    ...overrides,
  }
}

function transitionInput(dispatch: any, attempt: any, prefix: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId: dispatch.accountId, conversationKey: dispatch.conversationKey, dispatchId: dispatch.dispatchId,
    attemptId: attempt.attemptId, expectedStateVersion: dispatch.stateVersion,
    expectedAttemptVersion: attempt.attemptVersion, transitionIdempotencyKey: runId(prefix),
    evidenceReference: runId('evidence'), now: new Date(), ...overrides,
  }
}

async function advanceToAwaiting(ledger: PrismaDispatchLedger, created: any) {
  const begun = await ledger.beginAttempt(beginInput(created.dispatch))
  const marked = await ledger.markPhysicalActionStarted(transitionInput(begun.dispatch, begun.attempt, 'physical'))
  const accepted = await ledger.recordClientActionAccepted(transitionInput(marked.dispatch, marked.attempt, 'client_ack'))
  assert.equal(accepted.dispatch.state, 'sent_to_provider_client')
  assert.equal(accepted.dispatch.providerMessageId, null)
  const awaiting = await ledger.markAwaitingConfirmation(transitionInput(accepted.dispatch, accepted.attempt, 'await'))
  return awaiting
}

async function listAll(ledger: PrismaDispatchLedger, accountId: string, conversationKey: string) {
  const rows: any[] = []
  let sequence = 0
  for (;;) {
    const page = await ledger.listDispatchesAfter(accountId, conversationKey, sequence, 200)
    rows.push(...page.dispatches)
    if (page.dispatches.length < 200) return rows
    sequence = page.nextSequence
  }
}

if (config === null) {
  test('real PostgreSQL Dispatch gate requires PERSONAL_MAX_REAL_POSTGRES_URL', { skip: true }, () => {})
} else {
  describe('Stage 5 real PostgreSQL Dispatch Ledger semantics', { concurrency: false }, () => {
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

    test('S5-DB-01..18 atomic reservation handoff creates one exact Dispatch, lane and transition', async () => {
      const account = runId('s5_atomic')
      const conversation = runId('conversation')
      await createConversation(client, account, conversation, 'active', 3)
      const fixture = await createReservedFixture(actor, account, conversation)
      const input = {
        dispatchId: runId('dispatch'), accountId: account, conversationKey: conversation,
        reservationId: fixture.reservation.reservationId, expectedCommandId: fixture.commandId,
        expectedCommandSequence: fixture.commandSequence, ownerId: fixture.ownerId,
        actorLeaseEpoch: fixture.actorState.leaseEpoch, expectedActorVersion: fixture.actorState.optimisticVersion,
        expectedReservationVersion: fixture.reservation.reservationVersion,
        transitionIdempotencyKey: runId('create_transition'),
      }
      const created = await ledger.createDispatchFromReservation(input)
      const repeated = await ledger.createDispatchFromReservation(input)
      await rejectsCode(ledger.createDispatchFromReservation({ ...input, dispatchId: runId('other_dispatch') }), 'DISPATCH_CREATION_CONFLICT')
      await rejectsCode(ledger.createDispatchFromReservation({
        ...input, transitionIdempotencyKey: runId('other_creation_key'),
      }), 'DISPATCH_CREATION_CONFLICT')
      assert.equal(created.idempotent, false)
      assert.equal(repeated.idempotent, true)
      assert.equal(created.dispatch.state, 'queued')
      assert.equal(created.dispatch.stateVersion, 1)
      assert.equal(created.dispatch.initialRouteVersion, 3)
      assert.equal(created.dispatch.initialProtocolChatId, conversation + '-protocol')
      assert.equal(created.physicalSendAuthorized, false)
      assert.equal(await client.maxOutboundDispatch.count({ where: { reservationId: fixture.reservation.reservationId } }), 1)
      assert.equal(await client.maxOutboundDispatchTransition.count({ where: { dispatchId: created.dispatch.dispatchId } }), 1)
      const reservation = await client.maxOutboundCommandReservation.findUnique({ where: { reservationId: fixture.reservation.reservationId } })
      const state = await actor.getActorState(account, conversation)
      assert.equal(reservation.reservationState, 'handed_off')
      assert.equal(reservation.dispatchId, created.dispatch.dispatchId)
      assert.equal(reservation.handoffReference, created.dispatch.dispatchId)
      assert.equal(state?.nextHandoffSequence, 2)
      assert.equal(created.lane.nextPhysicalSequence, 1)
      assert.equal(await ledger.getDispatch('wrong-account', conversation, created.dispatch.dispatchId), null)
    })

    test('S5-DB-19..29 transition insertion failure rolls back Dispatch, reservation, actor head and lane', async () => {
      const account = runId('s5_rollback')
      const conversation = runId('conversation')
      await createConversation(client, account, conversation)
      const fixture = await createReservedFixture(actor, account, conversation)
      const dispatchId = runId('reject_dispatch')
      await client.$executeRawUnsafe('CREATE FUNCTION stage5_test_reject_transition() RETURNS trigger AS $$ BEGIN IF NEW."dispatchId" = $q$' + dispatchId + '$q$ THEN RAISE EXCEPTION $q$synthetic reject$q$; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql')
      await client.$executeRawUnsafe('CREATE TRIGGER stage5_test_reject_transition_trigger BEFORE INSERT ON "MaxOutboundDispatchTransition" FOR EACH ROW EXECUTE FUNCTION stage5_test_reject_transition()')
      try {
        await rejectsCode(ledger.createDispatchFromReservation({
          dispatchId, accountId: account, conversationKey: conversation,
          reservationId: fixture.reservation.reservationId, expectedCommandId: fixture.commandId,
          expectedCommandSequence: fixture.commandSequence, ownerId: fixture.ownerId,
          actorLeaseEpoch: fixture.actorState.leaseEpoch, expectedActorVersion: fixture.actorState.optimisticVersion,
          expectedReservationVersion: fixture.reservation.reservationVersion,
          transitionIdempotencyKey: runId('rollback_transition'),
        }), 'DATABASE_FAILURE')
      } finally {
        await client.$executeRawUnsafe('DROP TRIGGER stage5_test_reject_transition_trigger ON "MaxOutboundDispatchTransition"')
        await client.$executeRawUnsafe('DROP FUNCTION stage5_test_reject_transition()')
      }
      assert.equal(await client.maxOutboundDispatch.count({ where: { dispatchId } }), 0)
      assert.equal(await client.maxOutboundDispatchLane.count({ where: { accountId: account, conversationKey: conversation } }), 0)
      const reservation = await client.maxOutboundCommandReservation.findUnique({ where: { reservationId: fixture.reservation.reservationId } })
      assert.equal(reservation.reservationState, 'reserved')
      assert.equal(reservation.dispatchId, null)
      assert.equal((await actor.getActorState(account, conversation))?.nextHandoffSequence, 1)
      await assert.rejects(actor.markReservationHandedOff({
        accountId: account, conversationKey: conversation, reservationId: fixture.reservation.reservationId,
        ownerId: fixture.ownerId, leaseEpoch: fixture.actorState.leaseEpoch,
        expectedActorVersion: fixture.actorState.optimisticVersion,
        expectedReservationVersion: fixture.reservation.reservationVersion, handoffReference: runId('standalone'),
      }), (error: any) => error?.code === 'DISPATCH_LEDGER_REQUIRED')
    })

    test('S5-DB-30..48 route is revalidated, Attempt is fenced, and physical FIFO blocks sequence 2', async () => {
      const account = runId('s5_fifo')
      const conversation = runId('conversation')
      await createConversation(client, account, conversation)
      const first = await createDispatchFixture(actor, ledger, account, conversation)
      const second = await createDispatchFixture(actor, ledger, account, conversation)
      await client.maxRouteIdentityBinding.updateMany({
        where: { accountId: account, conversationKey: conversation, identityKind: 'protocol_chat_id', status: 'active' },
        data: { identityValue: conversation + '-protocol-v2', version: { increment: 1 } },
      })
      await client.maxRouteConversation.update({
        where: { accountId_conversationKey: { accountId: account, conversationKey: conversation } },
        data: { routeVersion: { increment: 1 }, optimisticVersion: { increment: 1 } },
      })
      await rejectsCode(ledger.beginAttempt(beginInput(second.dispatch)), 'FIFO_BLOCKED')
      const begun = await ledger.beginAttempt(beginInput(first.dispatch))
      assert.equal(begun.attempt.attemptNumber, 1)
      assert.equal(begun.attempt.routeVersion, 2)
      assert.equal(begun.attempt.protocolChatId, conversation + '-protocol-v2')
      assert.equal(first.dispatch.initialRouteVersion, 1)
      assert.equal(first.dispatch.initialProtocolChatId, conversation + '-protocol')
      assert.equal(begun.attempt.senderFencingEpoch, 11)
      assert.equal(begun.physicalSendAuthorized, false)
      const marked = await ledger.markPhysicalActionStarted(transitionInput(begun.dispatch, begun.attempt, 'physical'))
      const accepted = await ledger.recordClientActionAccepted(transitionInput(marked.dispatch, marked.attempt, 'client'))
      const awaiting = await ledger.markAwaitingConfirmation(transitionInput(accepted.dispatch, accepted.attempt, 'await'))
      const confirmed = await ledger.recordExactProviderConfirmation({
        ...transitionInput(awaiting.dispatch, awaiting.attempt, 'confirm'),
        providerMessageId: runId('provider_message'), evidenceReference: runId('exact_echo'),
      })
      assert.equal(confirmed.dispatch.state, 'provider_confirmed')
      assert.equal(confirmed.dispatch.terminalAt instanceof Date, true)
      assert.equal(confirmed.lane?.nextPhysicalSequence, 2)
      const secondBegun = await ledger.beginAttempt(beginInput(second.dispatch))
      assert.equal(secondBegun.attempt.attemptNumber, 1)
      assert.equal(secondBegun.dispatch.state, 'dispatching')
      await ledger.recordPreActionFailure({
        ...transitionInput(secondBegun.dispatch, secondBegun.attempt, 'fifo_cleanup'),
        safeErrorCode: 'SYNTHETIC_PRE_ACTION',
      })
    })

    test('S5-DB-49..68 unknown outcome opens reconciliation, forbids retry and accepts late exact confirmation', async () => {
      const account = runId('s5_unknown')
      const conversation = runId('conversation')
      await createConversation(client, account, conversation)
      const created = await createDispatchFixture(actor, ledger, account, conversation)
      const begun = await ledger.beginAttempt(beginInput(created.dispatch))
      const marked = await ledger.markPhysicalActionStarted(transitionInput(begun.dispatch, begun.attempt, 'physical'))
      const unknown = await ledger.recordUnknownOutcome({
        ...transitionInput(marked.dispatch, marked.attempt, 'unknown'),
        reason: 'timeout',
      })
      assert.equal(unknown.dispatch.state, 'reconciliation_required')
      assert.equal(unknown.reconciliationTask?.state, 'open')
      assert.equal(unknown.lane?.nextPhysicalSequence, 1)
      await rejectsCode(ledger.queueRetry({
        accountId: account, conversationKey: conversation, dispatchId: created.dispatch.dispatchId,
        expectedStateVersion: unknown.dispatch.stateVersion, transitionIdempotencyKey: runId('unsafe_retry'),
        evidenceReference: runId('timeout_only'),
      }), 'UNSAFE_RETRY')
      const providerMessageId = runId('late_provider')
      const confirmed = await ledger.recordExactProviderConfirmation({
        ...transitionInput(unknown.dispatch, unknown.attempt, 'late_confirm'),
        providerMessageId, evidenceReference: runId('late_exact_echo'),
      })
      assert.equal(confirmed.dispatch.state, 'provider_confirmed')
      assert.equal(confirmed.dispatch.providerMessageId, providerMessageId)
      assert.equal(confirmed.reconciliationTask?.state, 'resolved')
      assert.equal(confirmed.reconciliationTask?.resolutionType, 'exact_provider_confirmation')
      const repeated = await ledger.recordExactProviderConfirmation({
        ...transitionInput(unknown.dispatch, unknown.attempt, 'late_confirm_repeat'),
        providerMessageId, evidenceReference: runId('late_exact_echo_repeat'),
      })
      assert.equal(repeated.idempotent, true)
      assert.equal(repeated.lane?.nextPhysicalSequence, 2)
    })

    test('S5-DB-69..82 exact absence permits retry; terminal failure requires audited lane advance', async () => {
      const account = runId('s5_retry')
      const conversation = runId('conversation')
      await createConversation(client, account, conversation)
      const created = await createDispatchFixture(actor, ledger, account, conversation)
      const begun = await ledger.beginAttempt(beginInput(created.dispatch))
      const marked = await ledger.markPhysicalActionStarted(transitionInput(begun.dispatch, begun.attempt, 'physical'))
      const unknown = await ledger.recordUnknownOutcome({ ...transitionInput(marked.dispatch, marked.attempt, 'unknown'), reason: 'outcome_unknown' })
      const absence = await ledger.recordProviderAbsenceProven({
        ...transitionInput(unknown.dispatch, unknown.attempt, 'absence'), evidenceReference: runId('exact_negative'),
      })
      assert.equal(absence.dispatch.state, 'retryable_failed')
      const queued = await ledger.queueRetry({
        accountId: account, conversationKey: conversation, dispatchId: created.dispatch.dispatchId,
        expectedStateVersion: absence.dispatch.stateVersion, transitionIdempotencyKey: runId('safe_retry'),
        evidenceReference: runId('retry_policy'),
      })
      assert.equal(queued.dispatch.state, 'queued')
      assert.equal(queued.lane?.nextPhysicalSequence, 1)
      const retry = await ledger.beginAttempt(beginInput(queued.dispatch))
      assert.equal(retry.attempt.attemptNumber, 2)
      const failed = await ledger.recordPreActionFailure({
        ...transitionInput(retry.dispatch, retry.attempt, 'pre_action_failure'), safeErrorCode: 'SYNTHETIC_PRE_ACTION',
      })
      const deadInput = {
        accountId: account, conversationKey: conversation, dispatchId: created.dispatch.dispatchId,
        expectedStateVersion: failed.dispatch.stateVersion, transitionIdempotencyKey: runId('dead_letter'),
        evidenceReference: runId('policy_limit'), maximumAttempts: 2,
      }
      const dead = await ledger.deadLetter(deadInput)
      const repeatedDead = await ledger.deadLetter(deadInput)
      assert.equal(dead.dispatch.state, 'dead_letter')
      assert.equal(repeatedDead.idempotent, true)
      assert.equal(dead.lane?.nextPhysicalSequence, 1)
      await rejectsCode(ledger.deadLetter({ ...deadInput, maximumAttempts: 3 }), 'TRANSITION_IDEMPOTENCY_CONFLICT')
      const advanceInput = {
        accountId: account, conversationKey: conversation, dispatchId: created.dispatch.dispatchId,
        expectedStateVersion: dead.dispatch.stateVersion, transitionIdempotencyKey: runId('terminal_advance'),
        evidenceReference: runId('operator_audit'),
      }
      const advanced = await ledger.resolveTerminalFailureAndAdvance(advanceInput)
      const repeatedAdvance = await ledger.resolveTerminalFailureAndAdvance(advanceInput)
      assert.equal(advanced.lane?.nextPhysicalSequence, 2)
      assert.equal(repeatedAdvance.idempotent, true)
      assert.equal(repeatedAdvance.lane?.nextPhysicalSequence, 2)

      const hardConversation = runId('hard_conversation')
      await createConversation(client, account, hardConversation)
      const hardCreated = await createDispatchFixture(actor, ledger, account, hardConversation)
      const hardInput = {
        accountId: account, conversationKey: hardConversation, dispatchId: hardCreated.dispatch.dispatchId,
        expectedStateVersion: hardCreated.dispatch.stateVersion, transitionIdempotencyKey: runId('hard_failure'),
        evidenceReference: runId('hard_contract'), safeErrorCode: 'SYNTHETIC_HARD_FAILURE',
      }
      const hard = await ledger.markHardFailed(hardInput)
      const repeatedHard = await ledger.markHardFailed(hardInput)
      assert.equal(hard.dispatch.state, 'hard_failed')
      assert.equal(repeatedHard.idempotent, true)
      await rejectsCode(ledger.markHardFailed({
        ...hardInput, safeErrorCode: 'DIFFERENT_HARD_FAILURE',
      }), 'TRANSITION_IDEMPOTENCY_CONFLICT')
    })

    test('S5-DB-83..90 unresolved, conflicted, retired and missing-protocol routes block Attempt fail-closed', async () => {
      const account = runId('s5_route_fail_closed')
      for (const state of ['unresolved', 'conflicted', 'retired', 'missing_protocol'] as const) {
        const conversation = runId(state)
        await createConversation(client, account, conversation)
        const created = await createDispatchFixture(actor, ledger, account, conversation, state + '-owner')
        if (state === 'missing_protocol') {
          await client.maxRouteIdentityBinding.updateMany({
            where: { accountId: account, conversationKey: conversation, identityKind: 'protocol_chat_id' },
            data: { status: 'superseded', version: { increment: 1 } },
          })
        } else {
          await client.maxRouteConversation.update({
            where: { accountId_conversationKey: { accountId: account, conversationKey: conversation } },
            data: {
              state,
              ...(state === 'retired' ? {
                retiredAt: new Date(), retiredBy: 'stage5-test', retirementReason: 'synthetic retirement',
              } : {}),
            },
          })
        }
        await rejectsCode(ledger.beginAttempt(beginInput(created.dispatch)), 'ROUTE_NOT_SENDABLE')
        assert.equal(await client.maxOutboundDispatchAttempt.count({ where: { dispatchId: created.dispatch.dispatchId } }), 0)
        assert.equal((await ledger.getDispatch(account, conversation, created.dispatch.dispatchId))?.state, 'queued')
      }
    })

    test('S5-DB-91..99 restart recovery distinguishes pre-action from post-action uncertainty and is idempotent', async () => {
      const account = runId('s5_recovery')
      const preConversation = runId('pre')
      const postConversation = runId('post')
      await createConversation(client, account, preConversation)
      await createConversation(client, account, postConversation)
      const base = new Date('2026-07-26T23:10:00.000Z')
      const pre = await createDispatchFixture(actor, ledger, account, preConversation, 'pre-owner')
      const preBegun = await ledger.beginAttempt(beginInput(pre.dispatch, {
        now: base, senderProofTimestamp: base, claimMilliseconds: 100,
      }))
      const post = await createDispatchFixture(actor, ledger, account, postConversation, 'post-owner')
      const postBegun = await ledger.beginAttempt(beginInput(post.dispatch, {
        now: base, senderProofTimestamp: base, claimMilliseconds: 100,
      }))
      await ledger.markPhysicalActionStarted(transitionInput(postBegun.dispatch, postBegun.attempt, 'post_marker', {
        now: new Date(base.valueOf() + 1),
      }))
      const recovered = await ledger.recoverStaleDispatches({ now: new Date(base.valueOf() + 101), limit: 20 })
      assert.equal(recovered.recoveredPreAction >= 1, true)
      assert.equal(recovered.openedReconciliation >= 1, true)
      assert.equal((await ledger.getDispatch(account, preConversation, pre.dispatch.dispatchId))?.state, 'retryable_failed')
      assert.equal((await ledger.getDispatch(account, postConversation, post.dispatch.dispatchId))?.state, 'reconciliation_required')
      const repeated = await ledger.recoverStaleDispatches({ now: new Date(base.valueOf() + 102), limit: 20 })
      assert.deepEqual(repeated, { recoveredPreAction: 0, openedReconciliation: 0, unchanged: 0 })
      assert.equal(preBegun.attempt.physicalActionStartedAt, null)
    })

    test('S5-DB-100..113 append-only audit and immutable Dispatch/Attempt snapshots reject mutation and GUC bypass', async () => {
      const account = runId('s5_constraints')
      const conversation = runId('conversation')
      await createConversation(client, account, conversation)
      const created = await createDispatchFixture(actor, ledger, account, conversation)
      const begun = await ledger.beginAttempt(beginInput(created.dispatch))
      await assert.rejects(client.maxOutboundDispatchTransition.update({
        where: { transitionId: created.transition.transitionId }, data: { eventType: 'mutated' },
      }))
      await assert.rejects(client.maxOutboundDispatchTransition.delete({ where: { transitionId: created.transition.transitionId } }))
      await client.$executeRawUnsafe("SELECT set_config('max_personal.allow_dispatch_retention', 'on', false)")
      await assert.rejects(client.maxOutboundDispatchTransition.delete({ where: { transitionId: created.transition.transitionId } }))
      await assert.rejects(client.maxOutboundDispatch.update({
        where: { dispatchId: created.dispatch.dispatchId }, data: { commandSequence: 99 },
      }))
      await assert.rejects(client.maxOutboundDispatch.update({
        where: { dispatchId: created.dispatch.dispatchId }, data: { initialProtocolChatId: 'mutated-route' },
      }))
      await assert.rejects(client.maxOutboundDispatchAttempt.update({
        where: { attemptId: begun.attempt.attemptId }, data: { protocolChatId: 'mutated-attempt-route' },
      }))
      await assert.rejects(client.maxOutboundDispatch.update({
        where: { dispatchId: created.dispatch.dispatchId }, data: { state: 'invalid' },
      }))
      assert.equal((await ledger.getDispatch(account, conversation, created.dispatch.dispatchId))?.commandSequence, 1)
    })

    test('S5-DB-114 catalog exposes five models, partial uniqueness, composite FKs, checks and triggers', async () => {
      const tables = await client.$queryRawUnsafe<Array<{ table_name: string }>>(`SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN
          ('MaxOutboundDispatch', 'MaxOutboundDispatchLane', 'MaxOutboundDispatchAttempt',
           'MaxOutboundDispatchTransition', 'MaxOutboundReconciliationTask') ORDER BY table_name`)
      assert.deepEqual(tables.map(row => row.table_name), [
        'MaxOutboundDispatch', 'MaxOutboundDispatchAttempt', 'MaxOutboundDispatchLane',
        'MaxOutboundDispatchTransition', 'MaxOutboundReconciliationTask',
      ])
      const indexes = await client.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(`SELECT indexname, indexdef
        FROM pg_indexes WHERE schemaname = 'public' AND indexname IN
          ('MaxOutboundDispatch_account_provider_message_key',
           'MaxOutboundDispatchAttempt_active_dispatch_key',
           'MaxOutboundReconciliationTask_open_dispatch_key',
           'MaxOutboundCommandReservation_dispatch_partial_key')`)
      assert.equal(indexes.length, 4)
      for (const index of indexes) assert.match(index.indexdef, /WHERE/)
      const foreignKeys = await client.$queryRawUnsafe<Array<{ conname: string }>>(`SELECT conname
        FROM pg_constraint WHERE contype = 'f' AND conname IN
          ('MaxOutboundDispatch_account_conversation_fkey', 'MaxOutboundDispatch_command_fkey',
           'MaxOutboundDispatch_reservation_fkey', 'MaxOutboundCommandReservation_dispatch_fkey',
           'MaxOutboundDispatchLane_account_conversation_fkey', 'MaxOutboundDispatchAttempt_dispatch_fkey',
           'MaxOutboundDispatchTransition_dispatch_fkey', 'MaxOutboundDispatchTransition_attempt_fkey',
           'MaxOutboundReconciliationTask_dispatch_fkey', 'MaxOutboundReconciliationTask_attempt_fkey')`)
      assert.equal(foreignKeys.length, 10)
      const checks = await client.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*)::bigint AS count
        FROM pg_constraint WHERE contype = 'c' AND conname LIKE 'MaxOutboundDispatch%'`)
      assert.equal(Number(checks[0]?.count) >= 10, true)
      const triggers = await client.$queryRawUnsafe<Array<{ tgname: string }>>(`SELECT tgname FROM pg_trigger
        WHERE NOT tgisinternal AND tgname IN
          ('MaxOutboundDispatch_immutable', 'MaxOutboundDispatchAttempt_immutable',
           'MaxOutboundDispatchTransition_append_only') ORDER BY tgname`)
      assert.deepEqual(triggers.map(row => row.tgname), [
        'MaxOutboundDispatchAttempt_immutable', 'MaxOutboundDispatchTransition_append_only',
        'MaxOutboundDispatch_immutable',
      ])
    })

    test('S5-LOAD 1000 single, 1000 A/B, 100 identical, restart and 100 physical confirmations preserve exact FIFO', { timeout: 900_000 }, async () => {
      const account = runId('s5_load')
      const single = runId('single')
      const a = runId('a')
      const b = runId('b')
      const identical = runId('identical')
      for (const conversation of [single, a, b, identical]) await createConversation(client, account, conversation)
      for (let index = 0; index < 1000; index += 1) await createDispatchFixture(actor, ledger, account, single, 'single-owner', 'single-' + index)
      for (let index = 0; index < 1000; index += 1) {
        const conversation = index % 2 === 0 ? a : b
        await createDispatchFixture(actor, ledger, account, conversation, conversation + '-owner', 'interleaved-' + index)
      }
      for (let index = 0; index < 100; index += 1) await createDispatchFixture(actor, ledger, account, identical, 'identical-owner', 'identical-message')
      const restartedClient = await createRealPrismaClient(config)
      try {
        const restarted = new PrismaDispatchLedger(
          restartedClient as any,
          createLedgerHarness(restartedClient).routeRegistry,
          new ExplicitTestSenderAuthority(),
        )
        const singleRows = await listAll(restarted, account, single)
        const aRows = await listAll(restarted, account, a)
        const bRows = await listAll(restarted, account, b)
        const identicalRows = await listAll(restarted, account, identical)
        assert.deepEqual(singleRows.map(row => row.commandSequence), Array.from({ length: 1000 }, (_, index) => index + 1))
        assert.deepEqual(aRows.map(row => row.commandSequence), Array.from({ length: 500 }, (_, index) => index + 1))
        assert.deepEqual(bRows.map(row => row.commandSequence), Array.from({ length: 500 }, (_, index) => index + 1))
        assert.equal(identicalRows.length, 100)
        assert.equal(new Set(identicalRows.map(row => row.commandId)).size, 100)
        for (const dispatch of singleRows.slice(0, 100)) {
          const awaiting = await advanceToAwaiting(restarted, { dispatch })
          await restarted.recordExactProviderConfirmation({
            ...transitionInput(awaiting.dispatch, awaiting.attempt, 'load_confirm'),
            providerMessageId: runId('load_provider'), evidenceReference: runId('load_exact_echo'),
          })
        }
        const lane = await restartedClient.maxOutboundDispatchLane.findUnique({
          where: { accountId_conversationKey: { accountId: account, conversationKey: single } },
        })
        assert.equal(lane.nextPhysicalSequence, 101)
        console.log('STAGE5_LOAD', JSON.stringify({
          single: 1000, interleavedA: 500, interleavedB: 500, identical: 100,
          confirmations: 100, dispatchLoss: 0, accidentalDuplicates: 0,
          wrongConversation: 0, creationFifoPercent: 100, physicalFifoPercent: 100,
          laneAdvancementExactlyOnce: true, restart: 'PASS', textCorrelation: 0,
        }))
      } finally {
        await restartedClient.$disconnect()
      }
    })
  })
}
