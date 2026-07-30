import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { loadTextSenderRuntimeConfig } from '../../src/sender/config.ts'
import { TextCanaryService } from '../../src/sender/TextCanaryService.ts'
import { createLedgerHarness } from '../support/dispatchHarness.ts'
import { createRealPrismaClient, readRealPostgresConfig, runId, type RealPrismaClient } from '../support/realPostgres.ts'

const config = readRealPostgresConfig()
const secret = 'real-postgres-text-canary-secret-000000000000000'

async function createRoute(client: RealPrismaClient, accountId: string, conversationKey: string, protocolChatId: string): Promise<void> {
  await client.maxRouteConversation.create({
    data: { id: runId('route'), accountId, conversationKey, routeVersion: 1, optimisticVersion: 0, state: 'active' },
  })
  for (const [identityKind, identityValue] of [
    ['protocol_chat_id', protocolChatId], ['provider_user_id', runId('provider')], ['web_route_id', runId('web')],
  ]) {
    await client.maxRouteIdentityBinding.create({
      data: {
        id: runId('binding'), accountId, conversationKey, identityKind, identityValue, status: 'active',
        firstSeenAt: new Date(), lastSeenAt: new Date(), evidenceRef: runId('evidence'), version: 1,
      },
    })
  }
}

if (config === null) {
  test('real PostgreSQL text canary gate requires PERSONAL_MAX_REAL_POSTGRES_URL', { skip: true }, () => {})
} else {
  describe('durable physical text canary on real PostgreSQL', { concurrency: false }, () => {
    let client: RealPrismaClient
    let originalFetch: typeof fetch

    before(async () => {
      client = await createRealPrismaClient(config)
      originalFetch = globalThis.fetch
    })

    after(async () => {
      globalThis.fetch = originalFetch
      await client.$disconnect()
    })

    test('exact provider confirmations are FIFO, idempotent, and preserve identical messages', async () => {
      const accountId = runId('canary_account')
      const conversationKey = runId('canary_conversation')
      const protocolChatId = String(800000000000 + Math.floor(Math.random() * 99_999_999_999))
      await createRoute(client, accountId, conversationKey, protocolChatId)
      const runtimeConfig = loadTextSenderRuntimeConfig({
        MAX_PERSONAL_TEXT_SENDER_ENABLED: 'true', MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED: 'true',
        MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR: 'true', MAX_PERSONAL_TEXT_SENDER_ACCOUNT_ID: accountId,
        MAX_PERSONAL_TEXT_SENDER_CONVERSATIONS_JSON: JSON.stringify([conversationKey]),
        MAX_PERSONAL_TEXT_SENDER_HMAC_KEYS_JSON: JSON.stringify({ current: secret }), MAX_PERSONAL_TEXT_SENDER_HMAC_KEY_ID: 'current',
        MAX_PERSONAL_TEXT_COMMAND_HMAC_SECRET: secret,
        MAX_PERSONAL_TEXT_SENDER_SCRAPER_URL: 'http://max-web-scraper:3005/v1/personal-max/send/text',
        MAX_PERSONAL_TEXT_SENDER_OWNER_ID: 'real-postgres-scraper-owner', MAX_PERSONAL_TEXT_ACTOR_OWNER_ID: 'real-postgres-gateway-actor',
      })
      const service = new TextCanaryService(client as any, runtimeConfig)
      let physicalCalls = 0
      globalThis.fetch = async (_input, init) => {
        physicalCalls += 1
        const envelope = JSON.parse(String(init?.body))
        const authorization = await service.authorize(envelope)
        assert.equal(authorization.authorized, true)
        return new Response(JSON.stringify({
          schemaVersion: 1, attemptId: envelope.request.attemptId, outcome: 'PROVIDER_CONFIRMED',
          safeCode: 'EXACT_PROVIDER_CONFIRMATION', physicalProviderCalled: true,
          providerMessageId: `d301${runId(`message_${physicalCalls}`).replace(/[^0-9a-f]/gi, '').padEnd(32, 'a').slice(0, 32)}`,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const command = (clientMessageId: string) => ({
        schemaVersion: 1, accountId, protocolChatId, text: 'identical physical text', clientMessageId,
      })
      const first = await service.submit(command('crm-message-1'))
      const duplicate = await service.submit(command('crm-message-1'))
      const [second, third] = await Promise.all([
        service.submit(command('crm-message-2')),
        service.submit(command('crm-message-3')),
      ])
      assert.equal(first.deliveryConfirmed, true)
      assert.equal(duplicate.externalId, first.externalId)
      assert.equal(second.deliveryConfirmed, true)
      assert.equal(third.deliveryConfirmed, true)
      assert.equal(physicalCalls, 3)
      const rows = await client.maxOutboundCommand.findMany({
        where: { accountId, conversationKey }, orderBy: { commandSequence: 'asc' },
      })
      assert.deepEqual(rows.map((row: any) => row.commandSequence), [1, 2, 3])
      assert.equal(new Set(rows.map((row: any) => row.commandId)).size, 3)
      const dispatches = await client.maxOutboundDispatch.findMany({ where: { accountId, conversationKey } })
      assert.equal(dispatches.every((row: any) => row.state === 'provider_confirmed' && row.providerMessageId), true)
    })

    test('post-action uncertainty is durable and never retried', async () => {
      const accountId = runId('unknown_account')
      const conversationKey = runId('unknown_conversation')
      const protocolChatId = String(700000000000 + Math.floor(Math.random() * 99_999_999_999))
      await createRoute(client, accountId, conversationKey, protocolChatId)
      const runtimeConfig = loadTextSenderRuntimeConfig({
        MAX_PERSONAL_TEXT_SENDER_ENABLED: 'true', MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED: 'true',
        MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR: 'true', MAX_PERSONAL_TEXT_SENDER_ACCOUNT_ID: accountId,
        MAX_PERSONAL_TEXT_SENDER_CONVERSATIONS_JSON: JSON.stringify([conversationKey]),
        MAX_PERSONAL_TEXT_SENDER_HMAC_KEYS_JSON: JSON.stringify({ current: secret }), MAX_PERSONAL_TEXT_SENDER_HMAC_KEY_ID: 'current',
        MAX_PERSONAL_TEXT_COMMAND_HMAC_SECRET: secret,
        MAX_PERSONAL_TEXT_SENDER_SCRAPER_URL: 'http://max-web-scraper:3005/v1/personal-max/send/text',
        MAX_PERSONAL_TEXT_SENDER_OWNER_ID: 'unknown-scraper-owner', MAX_PERSONAL_TEXT_ACTOR_OWNER_ID: 'unknown-gateway-actor',
      })
      const service = new TextCanaryService(client as any, runtimeConfig)
      let calls = 0
      globalThis.fetch = async (_input, init) => {
        calls += 1
        const envelope = JSON.parse(String(init?.body))
        await service.authorize(envelope)
        throw new Error('synthetic lost response after physical authorization')
      }
      const command = { schemaVersion: 1, accountId, protocolChatId, text: 'uncertain once', clientMessageId: 'crm-unknown-1' }
      const first = await service.submit(command)
      const duplicate = await service.submit(command)
      assert.equal(first.deliveryStatus, 'needs_review')
      assert.equal(duplicate.deliveryStatus, 'needs_review')
      assert.equal(calls, 1)
      const tasks = await client.maxOutboundReconciliationTask.findMany({ where: { accountId, conversationKey, state: 'open' } })
      assert.equal(tasks.length, 1)
    })

    test('provider identity conflict becomes reconciliation and exact late confirmation releases FIFO', async () => {
      const accountId = runId('conflict_account')
      const conversationKey = runId('conflict_conversation')
      const protocolChatId = String(650000000000 + Math.floor(Math.random() * 99_999_999_999))
      await createRoute(client, accountId, conversationKey, protocolChatId)
      const runtimeConfig = loadTextSenderRuntimeConfig({
        MAX_PERSONAL_TEXT_SENDER_ENABLED: 'true', MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED: 'true',
        MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR: 'true', MAX_PERSONAL_TEXT_SENDER_ACCOUNT_ID: accountId,
        MAX_PERSONAL_TEXT_SENDER_CONVERSATIONS_JSON: JSON.stringify([conversationKey]),
        MAX_PERSONAL_TEXT_SENDER_HMAC_KEYS_JSON: JSON.stringify({ current: secret }), MAX_PERSONAL_TEXT_SENDER_HMAC_KEY_ID: 'current',
        MAX_PERSONAL_TEXT_COMMAND_HMAC_SECRET: secret,
        MAX_PERSONAL_TEXT_SENDER_SCRAPER_URL: 'http://max-web-scraper:3005/v1/personal-max/send/text',
        MAX_PERSONAL_TEXT_SENDER_OWNER_ID: 'conflict-scraper-owner', MAX_PERSONAL_TEXT_ACTOR_OWNER_ID: 'conflict-gateway-actor',
      })
      const service = new TextCanaryService(client as any, runtimeConfig)
      const reusedProviderId = `d301${'a'.repeat(32)}`
      const reconciledProviderId = `d301${'b'.repeat(32)}`
      const thirdProviderId = `d301${'c'.repeat(32)}`
      let physicalCalls = 0
      globalThis.fetch = async (_input, init) => {
        physicalCalls += 1
        const envelope = JSON.parse(String(init?.body))
        await service.authorize(envelope)
        return new Response(JSON.stringify({
          schemaVersion: 1, attemptId: envelope.request.attemptId, outcome: 'PROVIDER_CONFIRMED',
          safeCode: 'EXACT_PROVIDER_CONFIRMATION', physicalProviderCalled: true,
          providerMessageId: physicalCalls <= 2 ? reusedProviderId : thirdProviderId,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }

      const command = (clientMessageId: string) => ({
        schemaVersion: 1, accountId, protocolChatId, text: 'same text', clientMessageId,
      })
      const first = await service.submit(command('conflict-first'))
      const second = await service.submit(command('conflict-second'))
      const third = await service.submit(command('conflict-third'))

      assert.equal(first.deliveryConfirmed, true)
      assert.equal(second.deliveryStatus, 'needs_review')
      assert.equal(second.success, true)
      assert.equal(third.deliveryStatus, 'queued')
      assert.equal(third.success, true)
      assert.equal(physicalCalls, 2)
      assert.equal(await client.maxOutboundReconciliationTask.count({
        where: { accountId, conversationKey, state: 'open' },
      }), 1)
      const thirdCommand = await client.maxOutboundCommand.findFirstOrThrow({
        where: { accountId, conversationKey, clientMessageId: 'conflict-third' },
      })
      const queuedThirdDispatch = await client.maxOutboundDispatch.findUnique({
        where: { commandId: thirdCommand.commandId },
      })
      assert.equal(queuedThirdDispatch?.state, 'queued')
      assert.equal(queuedThirdDispatch?.attemptCount, 0)

      const secondCommand = await client.maxOutboundCommand.findFirstOrThrow({
        where: { accountId, conversationKey, clientMessageId: 'conflict-second' },
      })
      const secondDispatch = await client.maxOutboundDispatch.findUniqueOrThrow({
        where: { commandId: secondCommand.commandId },
      })
      const secondAttempt = await client.maxOutboundDispatchAttempt.findUniqueOrThrow({
        where: { attemptId: secondDispatch.currentAttemptId },
      })
      const ledger = createLedgerHarness(client).ledger
      const reconciled = await ledger.recordExactProviderConfirmation({
        accountId, conversationKey, dispatchId: secondDispatch.dispatchId,
        attemptId: secondAttempt.attemptId, expectedStateVersion: secondDispatch.stateVersion,
        expectedAttemptVersion: secondAttempt.attemptVersion,
        transitionIdempotencyKey: runId('late_exact_transition'),
        evidenceReference: runId('late_exact_evidence'), providerMessageId: reconciledProviderId,
      })
      assert.equal(reconciled.dispatch.state, 'provider_confirmed')
      assert.equal(reconciled.reconciliationTask?.state, 'resolved')

      const resumed = await service.submit(command('conflict-third'))
      assert.equal(resumed.deliveryConfirmed, true)
      assert.equal(resumed.externalId, thirdProviderId)
      assert.equal(physicalCalls, 3)
      assert.equal(await client.maxOutboundReconciliationTask.count({
        where: { accountId, conversationKey, state: 'open' },
      }), 0)
    })

    test('a proven pre-action refusal can retry safely with a new attempt', async () => {
      const accountId = runId('pre_action_account')
      const conversationKey = runId('pre_action_conversation')
      const protocolChatId = String(600000000000 + Math.floor(Math.random() * 99_999_999_999))
      await createRoute(client, accountId, conversationKey, protocolChatId)
      const runtimeConfig = loadTextSenderRuntimeConfig({
        MAX_PERSONAL_TEXT_SENDER_ENABLED: 'true', MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED: 'true',
        MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR: 'true', MAX_PERSONAL_TEXT_SENDER_ACCOUNT_ID: accountId,
        MAX_PERSONAL_TEXT_SENDER_CONVERSATIONS_JSON: JSON.stringify([conversationKey]),
        MAX_PERSONAL_TEXT_SENDER_HMAC_KEYS_JSON: JSON.stringify({ current: secret }), MAX_PERSONAL_TEXT_SENDER_HMAC_KEY_ID: 'current',
        MAX_PERSONAL_TEXT_COMMAND_HMAC_SECRET: secret,
        MAX_PERSONAL_TEXT_SENDER_SCRAPER_URL: 'http://max-web-scraper:3005/v1/personal-max/send/text',
        MAX_PERSONAL_TEXT_SENDER_OWNER_ID: 'pre-action-scraper-owner', MAX_PERSONAL_TEXT_ACTOR_OWNER_ID: 'pre-action-gateway-actor',
      })
      const service = new TextCanaryService(client as any, runtimeConfig)
      let calls = 0
      globalThis.fetch = async (_input, init) => {
        calls += 1
        const envelope = JSON.parse(String(init?.body))
        if (calls === 1) {
          return new Response(JSON.stringify({
            schemaVersion: 1, attemptId: envelope.request.attemptId, outcome: 'REFUSED_BEFORE_SEND',
            safeCode: 'SENDER_NOT_READY', physicalProviderCalled: false,
          }), { status: 409, headers: { 'content-type': 'application/json' } })
        }
        await service.authorize(envelope)
        return new Response(JSON.stringify({
          schemaVersion: 1, attemptId: envelope.request.attemptId, outcome: 'PROVIDER_CONFIRMED',
          safeCode: 'EXACT_PROVIDER_CONFIRMATION', physicalProviderCalled: true,
          providerMessageId: `d301${runId('pre_action_message').replace(/[^0-9a-f]/gi, '').padEnd(32, 'b').slice(0, 32)}`,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const command = { schemaVersion: 1, accountId, protocolChatId, text: 'safe retry', clientMessageId: 'crm-pre-action-1' }
      const first = await service.submit(command)
      const second = await service.submit(command)
      assert.equal(first.success, false)
      assert.equal(first.deliveryStatus, 'retryable_failed')
      assert.equal(second.deliveryConfirmed, true)
      assert.equal(calls, 2)
      const attempts = await client.maxOutboundDispatchAttempt.findMany({
        where: { accountId, conversationKey }, orderBy: { attemptNumber: 'asc' },
      })
      assert.deepEqual(attempts.map((row: any) => row.attemptState), ['pre_action_failed', 'provider_confirmed'])
      assert.equal(attempts[0].physicalActionStartedAt, null)
    })

    test('two process boots never share one session-owner identity or fence', async () => {
      const accountId = runId('boot_fence_account')
      const conversationKey = runId('boot_fence_conversation')
      const protocolChatId = String(500000000000 + Math.floor(Math.random() * 99_999_999_999))
      await createRoute(client, accountId, conversationKey, protocolChatId)
      const runtimeConfig = loadTextSenderRuntimeConfig({
        MAX_PERSONAL_TEXT_SENDER_ENABLED: 'true', MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED: 'true',
        MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR: 'true', MAX_PERSONAL_TEXT_SENDER_ACCOUNT_ID: accountId,
        MAX_PERSONAL_TEXT_SENDER_CONVERSATIONS_JSON: JSON.stringify([conversationKey]),
        MAX_PERSONAL_TEXT_SENDER_HMAC_KEYS_JSON: JSON.stringify({ current: secret }), MAX_PERSONAL_TEXT_SENDER_HMAC_KEY_ID: 'current',
        MAX_PERSONAL_TEXT_COMMAND_HMAC_SECRET: secret,
        MAX_PERSONAL_TEXT_SENDER_SCRAPER_URL: 'http://max-web-scraper:3005/v1/personal-max/send/text',
        MAX_PERSONAL_TEXT_SENDER_OWNER_ID: 'stable-configured-owner', MAX_PERSONAL_TEXT_ACTOR_OWNER_ID: 'stable-configured-actor',
      })
      const firstBoot = new TextCanaryService(client as any, runtimeConfig)
      const secondBoot = new TextCanaryService(client as any, runtimeConfig)
      let physicalCalls = 0
      globalThis.fetch = async (_input, init) => {
        physicalCalls += 1
        const envelope = JSON.parse(String(init?.body))
        await firstBoot.authorize(envelope)
        return new Response(JSON.stringify({
          schemaVersion: 1, attemptId: envelope.request.attemptId, outcome: 'PROVIDER_CONFIRMED',
          safeCode: 'EXACT_PROVIDER_CONFIRMATION', physicalProviderCalled: true,
          providerMessageId: `d301${runId('boot_fence_message').replace(/[^0-9a-f]/gi, '').padEnd(32, 'c').slice(0, 32)}`,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      await firstBoot.submit({ schemaVersion: 1, accountId, protocolChatId, text: 'first boot', clientMessageId: 'boot-one' })
      await client.maxOutboundConversationActor.update({
        where: { accountId_conversationKey: { accountId, conversationKey } },
        data: { leaseUntil: new Date(Date.now() - 1_000) },
      })
      await assert.rejects(
        secondBoot.submit({ schemaVersion: 1, accountId, protocolChatId, text: 'overlapping boot', clientMessageId: 'boot-two' }),
        (error: any) => error?.code === 'LEASE_HELD',
      )
      assert.equal(physicalCalls, 1)
      const owner = await client.maxAccountSessionOwner.findUniqueOrThrow({ where: { accountId } })
      assert.match(owner.ownerInstanceId, /^stable-configured-owner:[0-9a-f-]{36}$/)
      assert.notEqual(owner.ownerInstanceId, 'stable-configured-owner')
    })
  })
}
