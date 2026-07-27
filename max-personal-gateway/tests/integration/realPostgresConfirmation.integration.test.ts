import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { ProviderAbsenceEvidenceVerifier } from '../../src/confirmation/absence.ts'
import { MAX_PROVIDER_CONFIRMATION_MATCHER_VERSION } from '../../src/confirmation/constants.ts'
import { ConfirmationMatcherError } from '../../src/confirmation/errors.ts'
import { PrismaConfirmationMatcher } from '../../src/confirmation/PrismaConfirmationMatcher.ts'
import { createLedgerHarness, createConversation } from '../support/dispatchHarness.ts'
import { appendNormalizedConfirmationEvent, prepareDispatch } from '../support/confirmationHarness.ts'
import {
  createRealPrismaClient,
  readRealPostgresConfig,
  runId,
  type RealPrismaClient,
} from '../support/realPostgres.ts'

const config = readRealPostgresConfig()

function exactFixture(conversation: string, correlation: string, providerMessageId = runId('provider_message')) {
  return {
    providerMessageId,
    providerUserId: `${conversation}-provider`,
    protocolChatId: `${conversation}-protocol`,
    webRouteId: `${conversation}-web`,
    normalizedPayload: { attemptCorrelationId: correlation },
  } as const
}

if (config === null) {
  test('real PostgreSQL confirmation gate requires PERSONAL_MAX_REAL_POSTGRES_URL', { skip: true }, () => {})
} else {
  describe('Stage 6 real PostgreSQL exact provider confirmation', { concurrency: false }, () => {
    let client: RealPrismaClient
    let matcher: PrismaConfirmationMatcher

    before(async () => {
      client = await createRealPrismaClient(config)
      matcher = new PrismaConfirmationMatcher(client as any)
    })

    after(async () => {
      await client.$disconnect()
    })

    test('S6-DB-01 normal exact confirmation is one atomic accepted-by-MAX effect', async () => {
      const account = runId('s6_normal_account')
      const conversation = runId('s6_normal_conversation')
      await createConversation(client, account, conversation)
      const { actor, ledger } = createLedgerHarness(client)
      const prepared = await prepareDispatch(client, actor, ledger, account, conversation, 'awaiting')
      const event = await appendNormalizedConfirmationEvent(client, account, exactFixture(conversation, prepared.attemptCorrelationId))
      const result = await matcher.processNormalizedEvent({ accountId: account, normalizedEventId: event.normalizedEventId })
      assert.equal(result.resolution.status, 'matched')
      assert.equal(result.resolution.matchMethod, 'attempt_correlation_id')
      assert.equal(result.canonicalEffectApplied, true)
      const dispatch = await client.maxOutboundDispatch.findUniqueOrThrow({ where: { dispatchId: prepared.created.dispatch.dispatchId } })
      const attempt = await client.maxOutboundDispatchAttempt.findUniqueOrThrow({ where: { attemptId: prepared.begun.attempt.attemptId } })
      const lane = await client.maxOutboundDispatchLane.findUniqueOrThrow({ where: { accountId_conversationKey: { accountId: account, conversationKey: conversation } } })
      assert.equal(dispatch.state, 'provider_confirmed')
      assert.equal(attempt.attemptState, 'provider_confirmed')
      assert.equal(lane.nextPhysicalSequence, 2)
      assert.equal(await client.maxOutboundDispatchTransition.count({ where: { dispatchId: dispatch.dispatchId, eventType: 'provider_confirmed' } }), 1)
      assert.equal(await client.maxOutboundReconciliationTask.count({ where: { dispatchId: dispatch.dispatchId } }), 0)
      const decisions = await client.maxProviderConfirmationDecision.findMany({
        where: { resolutionId: result.resolution.resolutionId }, orderBy: { decisionSequence: 'asc' },
      })
      assert.equal(decisions.length, 2)
      assert.deepEqual(decisions.map((item: any) => [item.resolutionVersionBefore, item.resolutionVersionAfter]), [[0, 0], [0, 1]])
      assert.equal(decisions[1]?.evidenceId, result.evidence.evidenceId)
      assert.equal(decisions[1]?.dispatchId, dispatch.dispatchId)
      assert.equal(decisions[1]?.attemptId, attempt.attemptId)
      assert.equal(decisions[1]?.transitionId, result.resolution.transitionId)
    })

    test('S6-DB-02 same normalized event is idempotent under 25 concurrent calls', async () => {
      const account = runId('s6_same_event_account')
      const conversation = runId('s6_same_event_conversation')
      await createConversation(client, account, conversation)
      const { actor, ledger } = createLedgerHarness(client)
      const prepared = await prepareDispatch(client, actor, ledger, account, conversation, 'awaiting')
      const event = await appendNormalizedConfirmationEvent(client, account, exactFixture(conversation, prepared.attemptCorrelationId))
      const outcomes = await Promise.all(Array.from({ length: 25 }, () => matcher.processNormalizedEvent({
        accountId: account, normalizedEventId: event.normalizedEventId,
      })))
      assert.equal(outcomes.filter(item => item.canonicalEffectApplied).length, 1)
      assert.equal(outcomes.filter(item => item.idempotent).length, 24)
      assert.equal(await client.maxProviderConfirmationEvidence.count({ where: { accountId: account } }), 1)
      assert.equal(await client.maxProviderConfirmationResolution.count({ where: { accountId: account } }), 1)
      assert.equal(await client.maxOutboundDispatchTransition.count({ where: { dispatchId: prepared.created.dispatch.dispatchId, eventType: 'provider_confirmed' } }), 1)
    })

    test('S6-DB-03 25 physical duplicate events retain evidence and apply one canonical effect', async () => {
      const account = runId('s6_duplicates_account')
      const conversation = runId('s6_duplicates_conversation')
      await createConversation(client, account, conversation)
      const { actor, ledger } = createLedgerHarness(client)
      const prepared = await prepareDispatch(client, actor, ledger, account, conversation, 'awaiting')
      const providerMessageId = runId('shared_provider_message')
      const events = await Promise.all(Array.from({ length: 25 }, (_, index) => appendNormalizedConfirmationEvent(client, account, {
        ...exactFixture(conversation, prepared.attemptCorrelationId, providerMessageId),
        origin: index % 3 === 0 ? 'history' : index % 3 === 1 ? 'live' : 'replay',
      })))
      const outcomes = await Promise.all(events.map(event => matcher.processNormalizedEvent({
        accountId: account, normalizedEventId: event.normalizedEventId,
      })))
      assert.equal(outcomes.filter(item => item.canonicalEffectApplied).length, 1)
      assert.equal(outcomes.filter(item => item.resolution.status === 'duplicate').length, 24)
      assert.equal(await client.maxProviderConfirmationEvidence.count({ where: { accountId: account, providerMessageId } }), 25)
      assert.equal(await client.maxOutboundDispatchTransition.count({ where: { dispatchId: prepared.created.dispatch.dispatchId, eventType: 'provider_confirmed' } }), 1)
      assert.equal((await client.maxOutboundDispatchLane.findUniqueOrThrow({ where: { accountId_conversationKey: { accountId: account, conversationKey: conversation } } })).nextPhysicalSequence, 2)
    })

    test('S6-DB-04 early and late exact confirmation use the same Dispatch without regression', async () => {
      for (const target of ['physical_started', 'client_accepted', 'reconciliation'] as const) {
        const account = runId(`s6_${target}_account`)
        const conversation = runId(`s6_${target}_conversation`)
        await createConversation(client, account, conversation)
        const { actor, ledger } = createLedgerHarness(client)
        const prepared = await prepareDispatch(client, actor, ledger, account, conversation, target)
        const event = await appendNormalizedConfirmationEvent(client, account, exactFixture(conversation, prepared.attemptCorrelationId))
        const result = await matcher.processNormalizedEvent({ accountId: account, normalizedEventId: event.normalizedEventId })
        assert.equal(result.resolution.status, 'matched')
        const dispatches = await client.maxOutboundDispatch.findMany({ where: { accountId: account } })
        assert.equal(dispatches.length, 1)
        assert.equal(dispatches[0].dispatchId, prepared.created.dispatch.dispatchId)
        assert.equal(dispatches[0].state, 'provider_confirmed')
        assert.equal(await client.maxOutboundDispatchAttempt.count({ where: { dispatchId: dispatches[0].dispatchId } }), 1)
        if (target === 'reconciliation') {
          const task = await client.maxOutboundReconciliationTask.findFirstOrThrow({ where: { dispatchId: dispatches[0].dispatchId } })
          assert.equal(task.state, 'resolved')
        }
      }
    })

    test('S6-DB-05 exact correlation disagreement is durable ambiguity with zero state mutation', async () => {
      const account = runId('s6_ambiguity_account')
      const conversationA = runId('s6_ambiguity_a')
      const conversationB = runId('s6_ambiguity_b')
      await createConversation(client, account, conversationA)
      await createConversation(client, account, conversationB)
      const { actor, ledger } = createLedgerHarness(client)
      const first = await prepareDispatch(client, actor, ledger, account, conversationA, 'awaiting')
      const second = await prepareDispatch(client, actor, ledger, account, conversationB, 'awaiting')
      const event = await appendNormalizedConfirmationEvent(client, account, {
        ...exactFixture(conversationA, first.attemptCorrelationId),
        clientMessageId: second.clientMessageId,
      })
      const result = await matcher.processNormalizedEvent({ accountId: account, normalizedEventId: event.normalizedEventId })
      assert.equal(result.resolution.status, 'ambiguous')
      assert.equal(result.resolution.issueCode, 'CORRELATION_DISAGREEMENT')
      assert.deepEqual(new Set(result.resolution.candidateDispatchIds as string[]), new Set([
        first.created.dispatch.dispatchId, second.created.dispatch.dispatchId,
      ]))
      assert.equal((await client.maxOutboundDispatch.findUniqueOrThrow({ where: { dispatchId: first.created.dispatch.dispatchId } })).state, 'awaiting_confirmation')
      assert.equal((await client.maxOutboundDispatch.findUniqueOrThrow({ where: { dispatchId: second.created.dispatch.dispatchId } })).state, 'awaiting_confirmation')
      assert.doesNotMatch(JSON.stringify(result.resolution), /synthetic identical message/)
    })

    test('S6-DB-06 account and higher-authority route guards fail closed; weak web drift is diagnostic', async () => {
      const accountA = runId('s6_route_account_a')
      const accountB = runId('s6_route_account_b')
      const conversation = runId('s6_route_conversation')
      await createConversation(client, accountA, conversation)
      const { actor, ledger } = createLedgerHarness(client)
      const prepared = await prepareDispatch(client, actor, ledger, accountA, conversation, 'awaiting')
      const wrongAccount = await appendNormalizedConfirmationEvent(client, accountB, exactFixture(conversation, prepared.attemptCorrelationId))
      assert.equal((await matcher.processNormalizedEvent({ accountId: accountB, normalizedEventId: wrongAccount.normalizedEventId })).resolution.status, 'unmatched')
      const wrongProtocol = await appendNormalizedConfirmationEvent(client, accountA, {
        ...exactFixture(conversation, prepared.attemptCorrelationId), protocolChatId: 'wrong-protocol-chat',
      })
      assert.equal((await matcher.processNormalizedEvent({ accountId: accountA, normalizedEventId: wrongProtocol.normalizedEventId })).resolution.issueCode, 'PROTOCOL_CHAT_ID_MISMATCH')
      const wrongProvider = await appendNormalizedConfirmationEvent(client, accountA, {
        ...exactFixture(conversation, prepared.attemptCorrelationId), providerUserId: 'wrong-provider-user',
      })
      assert.equal((await matcher.processNormalizedEvent({ accountId: accountA, normalizedEventId: wrongProvider.normalizedEventId })).resolution.issueCode, 'PROVIDER_USER_ID_MISMATCH')
      const webDrift = await appendNormalizedConfirmationEvent(client, accountA, {
        ...exactFixture(conversation, prepared.attemptCorrelationId), webRouteId: 'weak-web-drift',
      })
      assert.equal((await matcher.processNormalizedEvent({ accountId: accountA, normalizedEventId: webDrift.normalizedEventId })).resolution.status, 'matched')
      assert.equal(await client.maxRouteConversation.count({ where: { accountId: accountA, conversationKey: conversation, routeVersion: 1 } }), 1)
    })

    test('S6-DB-07 deferred evidence reprocesses after physical marker and is idempotent', async () => {
      const account = runId('s6_deferred_account')
      const conversation = runId('s6_deferred_conversation')
      await createConversation(client, account, conversation)
      const { actor, ledger } = createLedgerHarness(client)
      const prepared = await prepareDispatch(client, actor, ledger, account, conversation, 'prepared')
      const event = await appendNormalizedConfirmationEvent(client, account, exactFixture(conversation, prepared.attemptCorrelationId))
      const deferred = await matcher.processNormalizedEvent({ accountId: account, normalizedEventId: event.normalizedEventId })
      assert.equal(deferred.resolution.status, 'deferred')
      assert.ok(deferred.resolution.nextRetryAt)
      await ledger.markPhysicalActionStarted({
        accountId: account, conversationKey: conversation, dispatchId: prepared.created.dispatch.dispatchId,
        attemptId: prepared.begun.attempt.attemptId, expectedStateVersion: prepared.begun.dispatch.stateVersion,
        expectedAttemptVersion: prepared.begun.attempt.attemptVersion, transitionIdempotencyKey: runId('deferred_marker'),
        evidenceReference: runId('deferred_marker_evidence'),
      })
      const matched = await matcher.reprocessEvidence({
        accountId: account, evidenceId: deferred.evidence.evidenceId,
        expectedResolutionVersion: deferred.resolution.resolutionVersion,
      })
      assert.equal(matched.resolution.status, 'matched')
      assert.equal(matched.resolution.nextRetryAt, null)
      await assert.rejects(matcher.reprocessEvidence({
        accountId: account, evidenceId: deferred.evidence.evidenceId,
        expectedResolutionVersion: deferred.resolution.resolutionVersion,
      }), (error: unknown) => error instanceof ConfirmationMatcherError && error.code === 'INVALID_INPUT')
    })

    test('S6-DB-08 delivery/read receipts link without changing provider-confirmed Dispatch state', async () => {
      const account = runId('s6_receipt_account')
      const conversation = runId('s6_receipt_conversation')
      await createConversation(client, account, conversation)
      const { actor, ledger } = createLedgerHarness(client)
      const prepared = await prepareDispatch(client, actor, ledger, account, conversation, 'awaiting')
      const providerMessageId = runId('receipt_provider_message')
      const echo = await appendNormalizedConfirmationEvent(client, account, exactFixture(conversation, prepared.attemptCorrelationId, providerMessageId))
      await matcher.processNormalizedEvent({ accountId: account, normalizedEventId: echo.normalizedEventId })
      for (const receiptType of ['recipient_delivery', 'recipient_read'] as const) {
        const receipt = await appendNormalizedConfirmationEvent(client, account, {
          eventKind: 'receipt', direction: 'system', targetProviderMessageId: providerMessageId,
          normalizedPayload: { receiptType },
        })
        const result = await matcher.processNormalizedEvent({ accountId: account, normalizedEventId: receipt.normalizedEventId })
        assert.equal(result.resolution.status, 'matched')
        assert.ok(result.resolution.transitionId)
        assert.equal(result.canonicalEffectApplied, false)
      }
      const dispatch = await client.maxOutboundDispatch.findUniqueOrThrow({ where: { dispatchId: prepared.created.dispatch.dispatchId } })
      assert.equal(dispatch.state, 'provider_confirmed')
      assert.equal(await client.maxOutboundDispatchTransition.count({ where: { dispatchId: dispatch.dispatchId, eventType: 'provider_confirmed' } }), 1)
    })

    test('S6-DB-09 default absence denies and verified synthetic exact absence is atomic', async () => {
      const account = runId('s6_absence_account')
      const conversation = runId('s6_absence_conversation')
      await createConversation(client, account, conversation)
      const { actor, ledger } = createLedgerHarness(client)
      const prepared = await prepareDispatch(client, actor, ledger, account, conversation, 'reconciliation')
      const event = await appendNormalizedConfirmationEvent(client, account, { eventKind: 'unsupported', direction: 'unknown' })
      const absenceInput = {
        accountId: account, normalizedEventId: event.normalizedEventId,
        dispatchId: prepared.created.dispatch.dispatchId, attemptId: prepared.begun.attempt.attemptId,
        absenceReference: runId('verified_absence'), verifierInput: { syntheticExactQueryResult: 'absent' },
        expectedStateVersion: prepared.current.dispatch.stateVersion,
        expectedAttemptVersion: prepared.current.attempt!.attemptVersion,
      }
      await assert.rejects(matcher.recordExactProviderAbsence(absenceInput), (error: unknown) =>
        error instanceof ConfirmationMatcherError && error.code === 'ABSENCE_EVIDENCE_DENIED')
      const verifier: ProviderAbsenceEvidenceVerifier = {
        async verify(input) {
          return {
            accountId: input.accountId, dispatchId: input.dispatchId, attemptId: input.attemptId,
            absenceReference: input.absenceReference, verifierVersion: 'synthetic-exact-absence-v1', verifiedAt: new Date(),
          }
        },
      }
      const verifiedMatcher = new PrismaConfirmationMatcher(client as any, { absenceVerifier: verifier })
      const result = await verifiedMatcher.recordExactProviderAbsence(absenceInput)
      assert.equal(result.resolution.status, 'matched')
      assert.equal(result.resolution.matchMethod, 'provider_absence_reference')
      assert.equal((await client.maxOutboundDispatch.findUniqueOrThrow({ where: { dispatchId: absenceInput.dispatchId } })).state, 'retryable_failed')
      assert.equal((await client.maxOutboundReconciliationTask.findFirstOrThrow({ where: { dispatchId: absenceInput.dispatchId } })).state, 'resolved')
      assert.equal(await client.maxOutboundDispatchAttempt.count({ where: { dispatchId: absenceInput.dispatchId } }), 1)
    })

    test('S6-DB-10 cursor advances in source order, survives restart, and ignores unsupported events durably', async () => {
      const account = runId('s6_cursor_account')
      const events = []
      for (let index = 0; index < 5; index += 1) {
        events.push(await appendNormalizedConfirmationEvent(client, account, {
          eventKind: index % 2 === 0 ? 'message' : 'reaction', direction: 'inbound',
          normalizedPayload: { syntheticIndex: index },
        }))
      }
      const first = await matcher.processBatch({ consumerId: 'stage6-consumer', accountId: account, limit: 3 })
      const second = await matcher.processBatch({ consumerId: 'stage6-consumer', accountId: account, limit: 3 })
      assert.equal(first.processed, 3)
      assert.equal(second.processed, 2)
      assert.equal(first.ignored + second.ignored, 5)
      const restarted = await createRealPrismaClient(config)
      try {
        const restartedMatcher = new PrismaConfirmationMatcher(restarted as any)
        const cursor = await restartedMatcher.getCursor('stage6-consumer', account, MAX_PROVIDER_CONFIRMATION_MATCHER_VERSION)
        assert.equal(cursor?.lastJournalSequence, events.at(-1)?.sourceJournalSequence)
        assert.equal((await restartedMatcher.processBatch({ consumerId: 'stage6-consumer', accountId: account, limit: 3 })).processed, 0)
      } finally {
        await restarted.$disconnect()
      }
    })

    test('S6-DB-11 evidence and decision are append-only with no custom GUC bypass', async () => {
      const account = runId('s6_immutable_account')
      const event = await appendNormalizedConfirmationEvent(client, account, { eventKind: 'message', direction: 'inbound' })
      const result = await matcher.processNormalizedEvent({ accountId: account, normalizedEventId: event.normalizedEventId })
      const decision = await client.maxProviderConfirmationDecision.findFirstOrThrow({ where: { resolutionId: result.resolution.resolutionId } })
      await assert.rejects(client.$executeRawUnsafe(`UPDATE "MaxProviderConfirmationEvidence" SET "evidenceKind" = 'unsupported' WHERE "evidenceId" = $1`, result.evidence.evidenceId))
      await assert.rejects(client.$executeRawUnsafe(`DELETE FROM "MaxProviderConfirmationDecision" WHERE "decisionId" = $1`, decision.decisionId))
      await assert.rejects(client.$transaction(async transaction => {
        await transaction.$executeRawUnsafe(`SET LOCAL max_personal.allow_confirmation_mutation = 'on'`)
        await transaction.$executeRawUnsafe(`DELETE FROM "MaxProviderConfirmationEvidence" WHERE "evidenceId" = $1`, result.evidence.evidenceId)
      }))
      await assert.rejects(client.$executeRawUnsafe(`
        UPDATE "MaxProviderConfirmationResolution" SET "accountId" = 'synthetic-other-account'
        WHERE "resolutionId" = $1`, result.resolution.resolutionId))
    })

    test('S6-DB-12 provider identifiers in evidence are nonunique while Stage 5 canonical identity remains account-scoped unique', async () => {
      const indexes = await client.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename IN ('MaxProviderConfirmationEvidence', 'MaxOutboundDispatch')`)
      assert.equal(indexes.some(index => index.indexname === 'MaxProviderConfirmationEvidence_account_provider_message_idx'
        && !index.indexdef.includes('UNIQUE')), true)
      assert.equal(indexes.some(index => index.indexname === 'MaxOutboundDispatch_account_provider_message_key'
        && index.indexdef.includes('UNIQUE') && index.indexdef.includes('WHERE')), true)
    })

    test('S6-DB-13 a new matcher version creates independent evidence without a second canonical effect', async () => {
      const account = runId('s6_version_account')
      const conversation = runId('s6_version_conversation')
      await createConversation(client, account, conversation)
      const { actor, ledger } = createLedgerHarness(client)
      const prepared = await prepareDispatch(client, actor, ledger, account, conversation, 'awaiting')
      const event = await appendNormalizedConfirmationEvent(client, account, exactFixture(conversation, prepared.attemptCorrelationId))
      const first = await matcher.processNormalizedEvent({ accountId: account, normalizedEventId: event.normalizedEventId })
      const second = await matcher.processNormalizedEvent({
        accountId: account, normalizedEventId: event.normalizedEventId, matcherVersion: 'max-provider-confirmation-matcher-v2',
      })
      assert.equal(first.resolution.status, 'matched')
      assert.equal(second.resolution.status, 'duplicate')
      assert.notEqual(first.evidence.evidenceId, second.evidence.evidenceId)
      assert.equal(await client.maxProviderConfirmationEvidence.count({ where: { accountId: account, sourceNormalizedEventId: event.normalizedEventId } }), 2)
      assert.equal(await client.maxOutboundDispatchTransition.count({ where: { dispatchId: prepared.created.dispatch.dispatchId, eventType: 'provider_confirmed' } }), 1)
    })

    test('S6-DB-14 manual ambiguity resolution requires actor/reason/version and stale replay is rejected', async () => {
      const account = runId('s6_manual_account')
      const conversations = [runId('s6_manual_a'), runId('s6_manual_b')]
      const { actor, ledger } = createLedgerHarness(client)
      const prepared = []
      for (const conversation of conversations) {
        await createConversation(client, account, conversation)
        prepared.push(await prepareDispatch(client, actor, ledger, account, conversation, 'awaiting'))
      }
      const event = await appendNormalizedConfirmationEvent(client, account, {
        ...exactFixture(conversations[0]!, prepared[0]!.attemptCorrelationId), clientMessageId: prepared[1]!.clientMessageId,
      })
      const ambiguous = await matcher.processNormalizedEvent({ accountId: account, normalizedEventId: event.normalizedEventId })
      assert.equal(ambiguous.resolution.status, 'ambiguous')
      const resolved = await matcher.resolveAmbiguity({
        accountId: account, evidenceId: ambiguous.evidence.evidenceId,
        expectedResolutionVersion: ambiguous.resolution.resolutionVersion,
        selectedDispatchId: prepared[0]!.created.dispatch.dispatchId,
        selectedAttemptId: prepared[0]!.begun.attempt.attemptId,
        actor: 'stage6-reviewer', reason: 'synthetic exact candidate reviewed',
      })
      assert.equal(resolved.resolution.status, 'matched')
      assert.equal(resolved.resolution.resolvedBy, 'stage6-reviewer')
      assert.equal(resolved.resolution.resolutionReason, 'synthetic exact candidate reviewed')
      await assert.rejects(matcher.resolveAmbiguity({
        accountId: account, evidenceId: ambiguous.evidence.evidenceId,
        expectedResolutionVersion: ambiguous.resolution.resolutionVersion,
        selectedDispatchId: prepared[0]!.created.dispatch.dispatchId,
        selectedAttemptId: prepared[0]!.begun.attempt.attemptId,
        actor: 'stage6-reviewer', reason: 'stale replay',
      }), (error: unknown) => error instanceof ConfirmationMatcherError && error.code === 'STALE_RESOLUTION_VERSION')
      const decisions = await client.maxProviderConfirmationDecision.findMany({ where: { resolutionId: ambiguous.resolution.resolutionId } })
      assert.equal(decisions.some((decision: any) => decision.actor === 'stage6-reviewer'
        && decision.reason === 'manual_exact_candidate_selected'), true)
    })

    test('S6-DB-15 exact evidence after terminal failure is durable conflict and never advances twice', async () => {
      const account = runId('s6_terminal_account')
      const conversation = runId('s6_terminal_conversation')
      await createConversation(client, account, conversation)
      const { actor, ledger } = createLedgerHarness(client)
      const prepared = await prepareDispatch(client, actor, ledger, account, conversation, 'prepared')
      const failed = await ledger.markHardFailed({
        accountId: account, conversationKey: conversation, dispatchId: prepared.created.dispatch.dispatchId,
        attemptId: prepared.begun.attempt.attemptId, expectedStateVersion: prepared.begun.dispatch.stateVersion,
        expectedAttemptVersion: prepared.begun.attempt.attemptVersion, transitionIdempotencyKey: runId('terminal_fail'),
        evidenceReference: runId('terminal_fail_evidence'), safeErrorCode: 'SYNTHETIC_CONTRACT_FAILURE',
      })
      const firstEvent = await appendNormalizedConfirmationEvent(client, account, exactFixture(conversation, prepared.attemptCorrelationId))
      const first = await matcher.processNormalizedEvent({ accountId: account, normalizedEventId: firstEvent.normalizedEventId })
      assert.equal(first.resolution.status, 'quarantined')
      assert.equal(first.resolution.issueCode, 'TERMINAL_DISPATCH_CONFIRMATION_CONFLICT')
      await ledger.resolveTerminalFailureAndAdvance({
        accountId: account, conversationKey: conversation, dispatchId: prepared.created.dispatch.dispatchId,
        expectedStateVersion: failed.dispatch.stateVersion, transitionIdempotencyKey: runId('terminal_advance'),
        evidenceReference: runId('terminal_advance_evidence'),
      })
      const secondEvent = await appendNormalizedConfirmationEvent(client, account, exactFixture(conversation, prepared.attemptCorrelationId))
      const second = await matcher.processNormalizedEvent({ accountId: account, normalizedEventId: secondEvent.normalizedEventId })
      assert.equal(second.resolution.issueCode, 'LATE_CONFIRMATION_AFTER_TERMINAL_ADVANCE')
      assert.equal((await client.maxOutboundDispatchLane.findUniqueOrThrow({ where: { accountId_conversationKey: { accountId: account, conversationKey: conversation } } })).nextPhysicalSequence, 2)
      assert.equal(await client.maxOutboundDispatchTransition.count({ where: { dispatchId: prepared.created.dispatch.dispatchId, eventType: 'provider_confirmed' } }), 0)
    })

    test('S6-DB-16 second decision failure rolls back evidence, resolution, Dispatch, Attempt, lane and transition', async () => {
      const account = runId('s6_rollback_account')
      const conversation = runId('s6_rollback_conversation')
      await createConversation(client, account, conversation)
      const { actor, ledger } = createLedgerHarness(client)
      const prepared = await prepareDispatch(client, actor, ledger, account, conversation, 'awaiting')
      const event = await appendNormalizedConfirmationEvent(client, account, exactFixture(conversation, prepared.attemptCorrelationId))
      await client.$executeRawUnsafe(`
        CREATE FUNCTION "s6_fail_second_confirmation_decision"() RETURNS trigger AS $$
        BEGIN
          IF NEW."decisionSequence" = 2 THEN RAISE EXCEPTION 'synthetic second decision failure'; END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql`)
      await client.$executeRawUnsafe(`
        CREATE TRIGGER "s6_fail_second_confirmation_decision_trigger"
        BEFORE INSERT ON "MaxProviderConfirmationDecision"
        FOR EACH ROW EXECUTE FUNCTION "s6_fail_second_confirmation_decision"()`)
      try {
        await assert.rejects(matcher.processNormalizedEvent({ accountId: account, normalizedEventId: event.normalizedEventId }))
      } finally {
        await client.$executeRawUnsafe(`DROP TRIGGER "s6_fail_second_confirmation_decision_trigger" ON "MaxProviderConfirmationDecision"`)
        await client.$executeRawUnsafe(`DROP FUNCTION "s6_fail_second_confirmation_decision"()`)
      }
      assert.equal(await client.maxProviderConfirmationEvidence.count({ where: { accountId: account } }), 0)
      assert.equal(await client.maxProviderConfirmationResolution.count({ where: { accountId: account } }), 0)
      assert.equal((await client.maxOutboundDispatch.findUniqueOrThrow({ where: { dispatchId: prepared.created.dispatch.dispatchId } })).state, 'awaiting_confirmation')
      assert.equal((await client.maxOutboundDispatchAttempt.findUniqueOrThrow({ where: { attemptId: prepared.begun.attempt.attemptId } })).attemptState, 'awaiting_confirmation')
      assert.equal((await client.maxOutboundDispatchLane.findUniqueOrThrow({ where: { accountId_conversationKey: { accountId: account, conversationKey: conversation } } })).nextPhysicalSequence, 1)
      assert.equal(await client.maxOutboundDispatchTransition.count({ where: { dispatchId: prepared.created.dispatch.dispatchId, eventType: 'provider_confirmed' } }), 0)
      assert.equal((await matcher.processNormalizedEvent({ accountId: account, normalizedEventId: event.normalizedEventId })).resolution.status, 'matched')
    })

    test('S6-DB-17 migration objects and monotonic cursor enforcement match the contract', async () => {
      const tables = await client.$queryRawUnsafe<Array<{ table_name: string }>>(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE 'MaxProviderConfirmation%'`)
      assert.deepEqual(new Set(tables.map(row => row.table_name)), new Set([
        'MaxProviderConfirmationEvidence', 'MaxProviderConfirmationResolution',
        'MaxProviderConfirmationDecision', 'MaxProviderConfirmationCursor',
      ]))
      const triggers = await client.$queryRawUnsafe<Array<{ tgname: string }>>(`
        SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (
          '"MaxProviderConfirmationEvidence"'::regclass,
          '"MaxProviderConfirmationResolution"'::regclass,
          '"MaxProviderConfirmationDecision"'::regclass,
          '"MaxProviderConfirmationCursor"'::regclass)`)
      assert.deepEqual(new Set(triggers.map(row => row.tgname)), new Set([
        'MaxProviderConfirmationEvidence_append_only',
        'MaxProviderConfirmationResolution_identity_immutable',
        'MaxProviderConfirmationResolution_scope_coherent',
        'MaxProviderConfirmationDecision_append_only',
        'MaxProviderConfirmationDecision_scope_coherent',
        'MaxProviderConfirmationCursor_monotonic',
      ]))
      const account = runId('s6_cursor_regression_account')
      const event = await appendNormalizedConfirmationEvent(client, account, { eventKind: 'message', direction: 'inbound' })
      await matcher.processBatch({ consumerId: 'regression-consumer', accountId: account, limit: 1 })
      const cursor = await matcher.getCursor('regression-consumer', account, MAX_PROVIDER_CONFIRMATION_MATCHER_VERSION)
      assert.ok(cursor)
      await assert.rejects(client.maxProviderConfirmationCursor.update({
        where: { cursorId: cursor.cursorId },
        data: { lastJournalSequence: 0n, lastEventOrdinal: 0, optimisticVersion: { increment: 1 } },
      }))
      assert.equal((await matcher.getCursor('regression-consumer', account, MAX_PROVIDER_CONFIRMATION_MATCHER_VERSION))?.lastJournalSequence,
        event.sourceJournalSequence)
    })

    test('S6-DB-18 provider acceptance confirms; unknown/malformed receipt has no positive effect', async () => {
      const account = runId('s6_acceptance_receipt_account')
      const conversation = runId('s6_acceptance_receipt_conversation')
      await createConversation(client, account, conversation)
      const { actor, ledger } = createLedgerHarness(client)
      const prepared = await prepareDispatch(client, actor, ledger, account, conversation, 'awaiting')
      const providerMessageId = runId('acceptance_receipt_provider')
      const acceptance = await appendNormalizedConfirmationEvent(client, account, {
        eventKind: 'receipt', direction: 'system', targetProviderMessageId: providerMessageId,
        protocolChatId: `${conversation}-protocol`, providerUserId: `${conversation}-provider`,
        normalizedPayload: { receiptType: 'provider_acceptance', attemptCorrelationId: prepared.attemptCorrelationId },
      })
      assert.equal((await matcher.processNormalizedEvent({ accountId: account, normalizedEventId: acceptance.normalizedEventId })).resolution.status, 'matched')
      for (const receiptType of ['future_receipt', 42] as const) {
        const event = await appendNormalizedConfirmationEvent(client, account, {
          eventKind: 'receipt', direction: 'system', targetProviderMessageId: providerMessageId,
          normalizedPayload: { receiptType },
        })
        const result = await matcher.processNormalizedEvent({ accountId: account, normalizedEventId: event.normalizedEventId })
        assert.equal(result.resolution.status, 'unmatched')
        assert.equal(result.canonicalEffectApplied, false)
      }
      assert.equal(await client.maxOutboundDispatchTransition.count({ where: { dispatchId: prepared.created.dispatch.dispatchId, eventType: 'provider_confirmed' } }), 1)
    })
  })
}
