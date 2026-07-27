import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { PrismaConfirmationMatcher } from '../../src/confirmation/PrismaConfirmationMatcher.ts'
import { confirmationErrorCode } from '../../src/confirmation/errors.ts'
import { dispatchErrorCode } from '../../src/dispatch/errors.ts'
import { createConversation, createLedgerHarness } from '../support/dispatchHarness.ts'
import {
  appendManyNormalizedConfirmationEvents,
  appendNormalizedConfirmationEvent,
  prepareDispatch,
  type ConfirmationEventFixture,
} from '../support/confirmationHarness.ts'
import { createRealPrismaClient, readRealPostgresConfig, runId, type RealPrismaClient } from '../support/realPostgres.ts'

const config = readRealPostgresConfig()

function exactFixture(conversation: string, correlation: string, providerMessageId: string): ConfirmationEventFixture {
  return {
    providerMessageId,
    providerUserId: `${conversation}-provider`,
    protocolChatId: `${conversation}-protocol`,
    webRouteId: `${conversation}-web`,
    normalizedPayload: { attemptCorrelationId: correlation },
  }
}

async function inChunks<T, R>(values: readonly T[], size: number, operation: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let index = 0; index < values.length; index += size) {
    results.push(...await Promise.all(values.slice(index, index + size).map(operation)))
  }
  return results
}

if (config === null) {
  test('real PostgreSQL confirmation concurrency gate requires PERSONAL_MAX_REAL_POSTGRES_URL', { skip: true }, () => {})
} else {
  describe('Stage 6 real PostgreSQL concurrency and load', { concurrency: false }, () => {
    let client: RealPrismaClient
    let matcher: PrismaConfirmationMatcher

    before(async () => {
      client = await createRealPrismaClient(config)
      matcher = new PrismaConfirmationMatcher(client as any)
    })

    after(async () => {
      await client.$disconnect()
    })

    test('S6-CONC-01 25 disagreement events remain ambiguous with no automatic winner', async () => {
      const account = runId('s6_conc_disagreement_account')
      const conversationA = runId('s6_conc_disagreement_a')
      const conversationB = runId('s6_conc_disagreement_b')
      await createConversation(client, account, conversationA)
      await createConversation(client, account, conversationB)
      const { actor, ledger } = createLedgerHarness(client)
      const first = await prepareDispatch(client, actor, ledger, account, conversationA, 'awaiting')
      const second = await prepareDispatch(client, actor, ledger, account, conversationB, 'awaiting')
      const events = await appendManyNormalizedConfirmationEvents(client, account, Array.from({ length: 25 }, (_, index) => ({
        ...exactFixture(conversationA, first.attemptCorrelationId, runId(`disagreement_provider_${index}`)),
        clientMessageId: second.clientMessageId,
      })))
      const results = await Promise.all(events.map(event => matcher.processNormalizedEvent({ accountId: account, normalizedEventId: event.normalizedEventId })))
      assert.equal(results.filter(result => result.resolution.status === 'ambiguous').length, 25)
      assert.equal(results.filter(result => result.canonicalEffectApplied).length, 0)
      assert.equal((await client.maxOutboundDispatch.findUniqueOrThrow({ where: { dispatchId: first.created.dispatch.dispatchId } })).state, 'awaiting_confirmation')
      assert.equal((await client.maxOutboundDispatch.findUniqueOrThrow({ where: { dispatchId: second.created.dispatch.dispatchId } })).state, 'awaiting_confirmation')
    })

    test('S6-CONC-02 25 concurrent late confirmations close reconciliation and advance lane once', async () => {
      const account = runId('s6_conc_late_account')
      const conversation = runId('s6_conc_late_conversation')
      await createConversation(client, account, conversation)
      const { actor, ledger } = createLedgerHarness(client)
      const prepared = await prepareDispatch(client, actor, ledger, account, conversation, 'reconciliation')
      const providerMessageId = runId('late_provider_message')
      const events = await appendManyNormalizedConfirmationEvents(client, account, Array.from({ length: 25 }, (_, index) => ({
        ...exactFixture(conversation, prepared.attemptCorrelationId, providerMessageId),
        origin: index % 2 === 0 ? 'history' : 'live',
      })))
      const results = await Promise.all(events.map(event => matcher.processNormalizedEvent({ accountId: account, normalizedEventId: event.normalizedEventId })))
      assert.equal(results.filter(result => result.canonicalEffectApplied).length, 1)
      assert.equal(results.filter(result => result.resolution.status === 'duplicate').length, 24)
      assert.equal(await client.maxProviderConfirmationEvidence.count({ where: { accountId: account } }), 25)
      assert.equal(await client.maxOutboundDispatchTransition.count({ where: { dispatchId: prepared.created.dispatch.dispatchId, eventType: 'provider_confirmed' } }), 1)
      assert.equal((await client.maxOutboundReconciliationTask.findFirstOrThrow({ where: { dispatchId: prepared.created.dispatch.dispatchId } })).state, 'resolved')
      assert.equal((await client.maxOutboundDispatchLane.findUniqueOrThrow({ where: { accountId_conversationKey: { accountId: account, conversationKey: conversation } } })).nextPhysicalSequence, 2)
    })

    test('S6-CONC-03 25 early ACK/awaiting/confirmation races finish confirmed without regression', async () => {
      const fixtures = []
      const { actor, ledger } = createLedgerHarness(client)
      for (let index = 0; index < 25; index += 1) {
        const account = runId(`s6_early_race_account_${index}`)
        const conversation = runId(`s6_early_race_conversation_${index}`)
        await createConversation(client, account, conversation)
        const prepared = await prepareDispatch(client, actor, ledger, account, conversation, 'physical_started')
        const event = await appendNormalizedConfirmationEvent(client, account, exactFixture(
          conversation, prepared.attemptCorrelationId, runId(`early_race_provider_${index}`),
        ))
        fixtures.push({ account, conversation, prepared, event })
      }
      let unclassifiedErrors = 0
      await inChunks(fixtures, 10, async fixture => {
        const physical = fixture.prepared.current
        const acceptedInput = {
          accountId: fixture.account, conversationKey: fixture.conversation,
          dispatchId: fixture.prepared.created.dispatch.dispatchId, attemptId: fixture.prepared.begun.attempt.attemptId,
          expectedStateVersion: physical.dispatch.stateVersion, expectedAttemptVersion: physical.attempt!.attemptVersion,
          transitionIdempotencyKey: runId('early_race_ack'), evidenceReference: runId('early_race_ack_evidence'),
        }
        const awaitingInput = {
          ...acceptedInput,
          expectedStateVersion: acceptedInput.expectedStateVersion + 1,
          expectedAttemptVersion: acceptedInput.expectedAttemptVersion + 1,
          transitionIdempotencyKey: runId('early_race_awaiting'),
        }
        const outcomes = await Promise.allSettled([
          ledger.recordClientActionAccepted(acceptedInput),
          ledger.markAwaitingConfirmation(awaitingInput),
          matcher.processNormalizedEvent({ accountId: fixture.account, normalizedEventId: fixture.event.normalizedEventId }),
        ])
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') {
            const code = dispatchErrorCode(outcome.reason) ?? confirmationErrorCode(outcome.reason)
            if (!['TERMINAL_STATE', 'INVALID_TRANSITION', 'STALE_DISPATCH_VERSION', 'STALE_ATTEMPT_VERSION', 'DATABASE_FAILURE'].includes(code ?? '')) {
              unclassifiedErrors += 1
            }
          }
        }
      })
      assert.equal(unclassifiedErrors, 0)
      for (const fixture of fixtures) {
        const dispatch = await client.maxOutboundDispatch.findUniqueOrThrow({ where: { dispatchId: fixture.prepared.created.dispatch.dispatchId } })
        assert.equal(dispatch.state, 'provider_confirmed')
        assert.equal(await client.maxOutboundReconciliationTask.count({ where: { dispatchId: dispatch.dispatchId, state: 'open' } }), 0)
        assert.equal(await client.maxOutboundDispatchTransition.count({ where: { dispatchId: dispatch.dispatchId, eventType: 'provider_confirmed' } }), 1)
      }
    })

    test('S6-CONC-04 duplicate provider ID in one account yields one winner and one classified conflict', async () => {
      const account = runId('s6_provider_conflict_account')
      const conversations = [runId('s6_provider_conflict_a'), runId('s6_provider_conflict_b')]
      const { actor, ledger } = createLedgerHarness(client)
      const prepared: Array<Awaited<ReturnType<typeof prepareDispatch>>> = []
      for (const conversation of conversations) {
        await createConversation(client, account, conversation)
        prepared.push(await prepareDispatch(client, actor, ledger, account, conversation, 'awaiting'))
      }
      const providerMessageId = runId('conflicting_provider_message')
      const events = await Promise.all(prepared.map((item, index) => appendNormalizedConfirmationEvent(client, account,
        exactFixture(conversations[index]!, item.attemptCorrelationId, providerMessageId))))
      const outcomes = await Promise.all(events.map(event => matcher.processNormalizedEvent({ accountId: account, normalizedEventId: event.normalizedEventId })))
      assert.equal(outcomes.filter(result => result.resolution.status === 'matched').length, 1)
      assert.equal(outcomes.filter(result => result.resolution.status === 'ambiguous').length, 1)
      assert.equal(await client.maxOutboundDispatch.count({ where: { accountId: account, providerMessageId } }), 1)
      assert.equal((await client.maxOutboundDispatchLane.findMany({ where: { accountId: account, nextPhysicalSequence: 2 } })).length, 1)
    })

    test('S6-CONC-05 25 cursor contenders classify conflicts without regression or skip', async () => {
      const account = runId('s6_cursor_contention_account')
      await appendManyNormalizedConfirmationEvents(client, account, Array.from({ length: 25 }, (_, index) => ({
        eventKind: 'message', direction: 'inbound', normalizedPayload: { index },
      })))
      const calls = await Promise.allSettled(Array.from({ length: 25 }, () => matcher.processBatch({
        consumerId: 'contended-consumer', accountId: account, limit: 1,
      })))
      assert.equal(calls.filter(result => result.status === 'fulfilled').length, 1)
      assert.equal(calls.filter(result => result.status === 'rejected'
        && confirmationErrorCode(result.reason) === 'CURSOR_CONFLICT').length, 24)
      let processed = 1
      while (true) {
        const batch = await matcher.processBatch({ consumerId: 'contended-consumer', accountId: account, limit: 10 })
        processed += batch.processed
        if (batch.processed === 0) break
      }
      assert.equal(processed, 25)
      assert.equal(await client.maxProviderConfirmationEvidence.count({ where: { accountId: account } }), 25)
      const cursor = await matcher.getCursor('contended-consumer', account, 'max-provider-confirmation-matcher-v1')
      assert.equal(cursor?.optimisticVersion, 25)
    })

    test('S6-LOAD-01 1000 one-conversation evidence events have zero evidence or canonical loss', async () => {
      const account = runId('s6_load_1000_account')
      const conversation = runId('s6_load_1000_conversation')
      await createConversation(client, account, conversation)
      const { actor, ledger } = createLedgerHarness(client)
      const prepared = await prepareDispatch(client, actor, ledger, account, conversation, 'awaiting')
      const providerMessageId = runId('load_1000_provider_message')
      const events = await appendManyNormalizedConfirmationEvents(client, account, Array.from({ length: 1000 }, (_, index) => ({
        ...exactFixture(conversation, prepared.attemptCorrelationId, providerMessageId),
        origin: index % 3 === 0 ? 'history' : index % 3 === 1 ? 'live' : 'replay',
      })))
      const outcomes = await inChunks(events, 25, event => matcher.processNormalizedEvent({ accountId: account, normalizedEventId: event.normalizedEventId }))
      assert.equal(outcomes.filter(result => result.canonicalEffectApplied).length, 1)
      assert.equal(outcomes.filter(result => result.resolution.status === 'duplicate').length, 999)
      assert.equal(await client.maxProviderConfirmationEvidence.count({ where: { accountId: account } }), 1000)
      assert.equal(await client.maxOutboundDispatchTransition.count({ where: { dispatchId: prepared.created.dispatch.dispatchId, eventType: 'provider_confirmed' } }), 1)
      assert.equal((await client.maxOutboundDispatchLane.findUniqueOrThrow({ where: { accountId_conversationKey: { accountId: account, conversationKey: conversation } } })).nextPhysicalSequence, 2)
    })

    test('S6-LOAD-02 100 identical-message reverse-order exact matches choose zero wrong Dispatches', async () => {
      const account = runId('s6_identical_account')
      const { actor, ledger } = createLedgerHarness(client)
      const fixtures = []
      for (let index = 0; index < 100; index += 1) {
        const conversation = runId(`s6_identical_conversation_${index}`)
        await createConversation(client, account, conversation)
        const prepared = await prepareDispatch(client, actor, ledger, account, conversation, 'awaiting', 'identical synthetic body')
        fixtures.push({ conversation, prepared, providerMessageId: runId(`identical_provider_${index}`) })
      }
      const events = await appendManyNormalizedConfirmationEvents(client, account, fixtures.map(fixture => ({
        ...exactFixture(fixture.conversation, fixture.prepared.attemptCorrelationId, fixture.providerMessageId),
      })))
      const eventByCorrelation = new Map(events.map(event => [event.normalizedPayload.attemptCorrelationId, event]))
      let wrongDispatch = 0
      for (const fixture of [...fixtures].reverse()) {
        const event = eventByCorrelation.get(fixture.prepared.attemptCorrelationId)!
        const result = await matcher.processNormalizedEvent({ accountId: account, normalizedEventId: event.normalizedEventId })
        if (result.resolution.dispatchId !== fixture.prepared.created.dispatch.dispatchId) wrongDispatch += 1
      }
      assert.equal(wrongDispatch, 0)
      assert.equal(await client.maxOutboundDispatch.count({ where: { accountId: account, state: 'provider_confirmed' } }), 100)
      const providerRows = await client.maxOutboundDispatch.findMany({ where: { accountId: account }, select: { dispatchId: true, providerMessageId: true } })
      const expected = new Map(fixtures.map(fixture => [fixture.prepared.created.dispatch.dispatchId, fixture.providerMessageId]))
      assert.equal(providerRows.every((row: any) => row.providerMessageId === expected.get(row.dispatchId)), true)
    })

    test('S6-LOAD-03 1000 interleaved events over 100 A and 100 B Dispatches remain 100% isolated', async () => {
      const accounts = [runId('s6_interleaved_account_a'), runId('s6_interleaved_account_b')]
      const providerMessagePrefix = runId('shared_cross_account_provider')
      const prepared: Array<{
        account: string
        dispatches: Array<Awaited<ReturnType<typeof prepareDispatch>>>
        events: any[]
      }> = []
      const { actor, ledger } = createLedgerHarness(client)
      for (const [index, account] of accounts.entries()) {
        const dispatches: Array<Awaited<ReturnType<typeof prepareDispatch>>> = []
        const eventFixtures = []
        for (let dispatchIndex = 0; dispatchIndex < 100; dispatchIndex += 1) {
          const conversation = runId(`s6_interleaved_conversation_${index}_${dispatchIndex}`)
          await createConversation(client, account, conversation)
          const dispatch = await prepareDispatch(client, actor, ledger, account, conversation, 'awaiting')
          dispatches.push(dispatch)
          for (let copy = 0; copy < 5; copy += 1) {
            eventFixtures.push({
              ...exactFixture(conversation, dispatch.attemptCorrelationId, `${providerMessagePrefix}:${dispatchIndex}`),
              origin: copy % 2 === 0 ? 'live' as const : 'history' as const,
            })
          }
        }
        const events = await appendManyNormalizedConfirmationEvents(client, account, eventFixtures)
        prepared.push({ account, dispatches, events })
      }
      const interleaved = Array.from({ length: 500 }, (_, index) => [prepared[0]!.events[index], prepared[1]!.events[index]]).flat()
      const outcomes = await inChunks(interleaved, 25, event => matcher.processNormalizedEvent({ accountId: event.accountId, normalizedEventId: event.normalizedEventId }))
      assert.equal(outcomes.filter(result => result.canonicalEffectApplied).length, 200)
      assert.equal(outcomes.filter(result => result.resolution.status === 'duplicate').length, 800)
      assert.equal(await client.maxProviderConfirmationEvidence.count({ where: { accountId: { in: accounts } } }), 1000)
      assert.equal(await client.maxOutboundDispatch.count({ where: { accountId: { in: accounts }, state: 'provider_confirmed' } }), 200)
      assert.equal(await client.maxOutboundDispatchLane.count({ where: { accountId: { in: accounts }, nextPhysicalSequence: 2 } }), 200)
      const expectedByCorrelation = new Map(prepared.flatMap(fixture => fixture.dispatches.map(dispatch => [
        dispatch.attemptCorrelationId, dispatch.created.dispatch.dispatchId,
      ] as const)))
      assert.equal(outcomes.filter(result => result.resolution.dispatchId
        !== expectedByCorrelation.get(result.evidence.attemptCorrelationId!)).length, 0)
      for (const fixture of prepared) {
        assert.equal(await client.maxOutboundDispatch.count({ where: { accountId: fixture.account, state: 'provider_confirmed' } }), 100)
      }
    })

    test('S6-LOAD-04 100 delayed and 100 history/live duplicate series preserve all evidence', async () => {
      const account = runId('s6_delayed_history_account')
      const conversation = runId('s6_delayed_history_conversation')
      await createConversation(client, account, conversation)
      const { actor, ledger } = createLedgerHarness(client)
      const prepared = await prepareDispatch(client, actor, ledger, account, conversation, 'reconciliation')
      const providerMessageId = runId('delayed_history_provider')
      const events = await appendManyNormalizedConfirmationEvents(client, account, Array.from({ length: 200 }, (_, index) => ({
        ...exactFixture(conversation, prepared.attemptCorrelationId, providerMessageId),
        origin: index < 100 ? 'history' : 'live',
        providerOccurredAt: new Date(Date.UTC(2026, 6, 27, 1, 0, index % 60)),
      })))
      const outcomes = await inChunks(events, 25, event => matcher.processNormalizedEvent({ accountId: account, normalizedEventId: event.normalizedEventId }))
      assert.equal(outcomes.filter(result => result.canonicalEffectApplied).length, 1)
      assert.equal(outcomes.filter(result => result.resolution.status === 'duplicate').length, 199)
      assert.equal(await client.maxProviderConfirmationEvidence.count({ where: { accountId: account } }), 200)
      assert.equal(await client.maxOutboundDispatchTransition.count({ where: { dispatchId: prepared.created.dispatch.dispatchId, eventType: 'provider_confirmed' } }), 1)
    })
  })
}
