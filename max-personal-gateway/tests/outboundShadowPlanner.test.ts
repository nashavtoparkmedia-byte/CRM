import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { RouteRegistry } from '../src/route/RouteRegistry.ts'
import type { RouteSnapshot } from '../src/route/types.ts'
import { DurableAccountSessionOwner } from '../src/session/AccountSessionOwner.ts'
import { OutboundShadowPlanner } from '../src/shadow/OutboundShadowPlanner.ts'
import { ShadowPlanError } from '../src/shadow/errors.ts'
import { isOutboundShadowPlanningEnabled } from '../src/shadow/featureFlag.ts'
import type { PlanOutboundCommandInput, ShadowCommandRecord } from '../src/shadow/types.ts'
import { FakeSessionOwnerRepository } from './support/FakeSessionOwnerRepository.ts'
import { FakeShadowPlanRepository } from './support/FakeShadowPlanRepository.ts'

const evaluatedAt = new Date('2026-07-28T22:00:00.000Z')

class FakeRoutes {
  readonly snapshots = new Map<string, RouteSnapshot>()

  set(accountId: string, conversationKey: string, state: RouteSnapshot['state'] = 'active', target = `${conversationKey}-protocol`): void {
    this.snapshots.set(`${accountId}\0${conversationKey}`, {
      accountId, conversationKey, state, routeVersion: 1,
      identities: state === 'active' ? [{ kind: 'protocol_chat_id', value: target, status: 'active', firstSeenAt: evaluatedAt.toISOString(), lastSeenAt: evaluatedAt.toISOString(), evidenceRef: 'synthetic-route', version: 1 }] : [],
      activeProtocolChatId: state === 'active' ? target : undefined,
      evidenceReferences: ['synthetic-route'], hasOpenConflict: state === 'conflicted', createdAt: evaluatedAt.toISOString(), updatedAt: evaluatedAt.toISOString(),
    })
  }

  async getRouteSnapshot(accountId: string, conversationKey: string): Promise<RouteSnapshot | null> {
    return this.snapshots.get(`${accountId}\0${conversationKey}`) ?? null
  }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }

function command(commandId: string, accountId = 'account-a', conversationKey = 'conversation-a', sequence = 1, text = 'exact text'): ShadowCommandRecord {
  return { commandId, accountId, conversationKey, clientMessageId: `${commandId}-client`, commandSequence: sequence, commandKind: 'text', commandPayload: { kind: 'text', text }, payloadSha256: hash(JSON.stringify({ kind: 'text', text })) }
}

function harness(withOwner = true) {
  const repository = new FakeShadowPlanRepository()
  const routes = new FakeRoutes()
  const ownerRepository = new FakeSessionOwnerRepository(evaluatedAt)
  const sessionOwner = new DurableAccountSessionOwner(ownerRepository)
  let id = 0
  const planner = new OutboundShadowPlanner(repository, routes as unknown as RouteRegistry, sessionOwner, {
    idGenerator: () => `shadow-plan-${++id}`, clock: () => evaluatedAt,
  })
  const ready = withOwner ? sessionOwner.acquire({ accountId: 'account-a', ownerInstanceId: 'owner-a', leaseMilliseconds: 30_000 }) : Promise.resolve(null)
  return { repository, routes, ownerRepository, sessionOwner, planner, ready }
}

function seed(repository: FakeShadowPlanRepository, item: ShadowCommandRecord): void {
  repository.seedCommand(item)
  repository.seedReservation({ reservationId: `${item.commandId}-reservation`, accountId: item.accountId, conversationKey: item.conversationKey, commandId: item.commandId, commandSequence: item.commandSequence, reservationState: 'reserved' })
}

function input(item: ShadowCommandRecord, token = 1n, overrides: Partial<PlanOutboundCommandInput> = {}): PlanOutboundCommandInput {
  return {
    accountId: item.accountId, conversationKey: item.conversationKey, commandId: item.commandId,
    reservationId: `${item.commandId}-reservation`, attemptCorrelationId: `${item.commandId}-attempt`, idempotencyKey: `${item.commandId}-idempotency`,
    ownerInstanceId: 'owner-a', fencingToken: token,
    legacy: { accountId: item.accountId, conversationKey: item.conversationKey, targetProtocolChatId: `${item.conversationKey}-protocol`, payloadKind: 'text', sendable: true },
    ...overrides,
  }
}

async function rejectsCode(operation: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, error => error instanceof ShadowPlanError && error.code === code)
}

test('accepted exact route produces a shadow-only would-send plan', async () => {
  const { repository, routes, planner, ready } = harness()
  await ready
  const item = command('accepted')
  seed(repository, item); routes.set(item.accountId, item.conversationKey)
  const result = await planner.plan(input(item))
  assert.equal(result.plan.wouldSend, true)
  assert.equal(result.plan.refusalReason, null)
  assert.equal(result.physicalSendAuthorized, false)
  assert.equal(result.deliveryStateMutated, false)
})

test('one thousand commands remain one thousand FIFO-ordered artifacts with zero critical regressions', async () => {
  const { repository, routes, planner, ready } = harness()
  await ready; routes.set('account-a', 'conversation-a')
  for (let sequence = 1; sequence <= 1000; sequence += 1) {
    const item = command(`scale-${sequence}`, 'account-a', 'conversation-a', sequence, `text-${sequence}`)
    seed(repository, item)
    await planner.plan(input(item))
  }
  const plans = repository.plans()
  assert.equal(plans.length, 1000)
  assert.deepEqual(plans.map(plan => plan.commandSequence), Array.from({ length: 1000 }, (_, index) => index + 1))
  assert.equal(plans.filter(plan => plan.semanticComparison.criticalRegression).length, 0)
})

test('one hundred identical texts are one hundred distinct command plans without hash deduplication', async () => {
  const { repository, routes, planner, ready } = harness()
  await ready; routes.set('account-a', 'conversation-a')
  for (let sequence = 1; sequence <= 100; sequence += 1) {
    const item = command(`identical-${sequence}`, 'account-a', 'conversation-a', sequence, 'identical')
    seed(repository, item); await planner.plan(input(item))
  }
  assert.equal(repository.plans().length, 100)
  assert.equal(new Set(repository.plans().map(plan => plan.payloadSha256)).size, 1)
})

test('A and B accounts and same text remain isolated', async () => {
  const { repository, routes, sessionOwner, planner, ready } = harness()
  await ready; await sessionOwner.acquire({ accountId: 'account-b', ownerInstanceId: 'owner-b' })
  routes.set('account-a', 'shared-chat', 'active', 'target-a'); routes.set('account-b', 'shared-chat', 'active', 'target-b')
  const a = command('a-command', 'account-a', 'shared-chat', 1, 'same')
  const b = command('b-command', 'account-b', 'shared-chat', 1, 'same')
  seed(repository, a); seed(repository, b)
  const planA = await planner.plan(input(a, 1n, { legacy: undefined }))
  const planB = await planner.plan(input(b, 1n, { ownerInstanceId: 'owner-b', legacy: undefined }))
  assert.notEqual(planA.plan.accountAliasSha256, planB.plan.accountAliasSha256)
  assert.notEqual(planA.plan.selectedProtocolChatId, planB.plan.selectedProtocolChatId)
})

test('same text in different chats preserves distinct exact routes', async () => {
  const { repository, routes, planner, ready } = harness()
  await ready; routes.set('account-a', 'chat-a'); routes.set('account-a', 'chat-b')
  const a = command('chat-a-command', 'account-a', 'chat-a', 1, 'same')
  const b = command('chat-b-command', 'account-a', 'chat-b', 1, 'same')
  seed(repository, a); seed(repository, b)
  assert.notEqual((await planner.plan(input(a))).plan.selectedProtocolChatId, (await planner.plan(input(b))).plan.selectedProtocolChatId)
})

test('route conflict is visible, refused, and classified as hidden legacy conflict', async () => {
  const { repository, routes, planner, ready } = harness()
  await ready
  const item = command('conflict'); seed(repository, item); routes.set(item.accountId, item.conversationKey, 'conflicted')
  const plan = (await planner.plan(input(item))).plan
  assert.equal(plan.refusalReason, 'ROUTE_CONFLICT')
  assert.equal(plan.semanticComparison.hiddenRouteConflict, true)
  assert.equal(plan.semanticComparison.criticalRegression, true)
})

test('missing route is refused without target guessing', async () => {
  const { repository, planner, ready } = harness()
  await ready
  const item = command('missing-route'); seed(repository, item)
  const plan = (await planner.plan(input(item, 1n, { legacy: undefined }))).plan
  assert.equal(plan.refusalReason, 'ROUTE_NOT_FOUND')
  assert.equal(plan.selectedProtocolChatId, null)
})

test('stale owner is refused', async () => {
  const { repository, routes, ownerRepository, planner, ready } = harness()
  const acquired = await ready
  const item = command('stale-owner'); seed(repository, item); routes.set(item.accountId, item.conversationKey)
  ownerRepository.advanceDatabaseTime(30_001)
  const plan = (await planner.plan(input(item, acquired!.lease.fencingToken))).plan
  assert.equal(plan.refusalReason, 'OWNER_LEASE_EXPIRED')
})

test('missing owner is refused', async () => {
  const { repository, routes, planner } = harness(false)
  const item = command('missing-owner'); seed(repository, item); routes.set(item.accountId, item.conversationKey)
  assert.equal((await planner.plan(input(item))).plan.refusalReason, 'OWNER_NOT_ACQUIRED')
})

test('missing and stale fencing inputs are distinct fail-closed reasons', async () => {
  const { repository, routes, planner, ready } = harness()
  await ready; routes.set('account-a', 'conversation-a')
  const missing = command('missing-fence'); const stale = command('stale-fence', 'account-a', 'conversation-a', 2)
  seed(repository, missing); seed(repository, stale)
  assert.equal((await planner.plan(input(missing, 1n, { fencingToken: undefined }))).plan.refusalReason, 'FENCING_TOKEN_MISSING')
  assert.equal((await planner.plan(input(stale, 2n))).plan.refusalReason, 'FENCING_TOKEN_STALE')
})

test('wrong-account command is refused before route or owner can authorize it', async () => {
  const { repository, routes, sessionOwner, planner, ready } = harness()
  await ready; await sessionOwner.acquire({ accountId: 'account-b', ownerInstanceId: 'owner-b' }); routes.set('account-b', 'conversation-a')
  const item = command('wrong-account', 'account-a'); seed(repository, item)
  const plan = (await planner.plan(input(item, 1n, { accountId: 'account-b', ownerInstanceId: 'owner-b', legacy: undefined }))).plan
  assert.equal(plan.refusalReason, 'ACCOUNT_MISMATCH')
})

test('duplicate command with a new idempotency key returns one prior artifact and creates no duplicate intent', async () => {
  const { repository, routes, planner, ready } = harness()
  await ready
  const item = command('duplicate-command'); seed(repository, item); routes.set(item.accountId, item.conversationKey)
  const first = await planner.plan(input(item))
  const duplicate = await planner.plan(input(item, 1n, { idempotencyKey: 'different-idempotency' }))
  assert.equal(duplicate.idempotent, true)
  assert.equal(duplicate.plan.planId, first.plan.planId)
  assert.equal(repository.plans().length, 1)
})

test('duplicate idempotency request returns the immutable prior artifact', async () => {
  const { repository, routes, planner, ready } = harness()
  await ready
  const item = command('duplicate-idempotency'); seed(repository, item); routes.set(item.accountId, item.conversationKey)
  const first = await planner.plan(input(item)); const second = await planner.plan(input(item))
  assert.equal(first.idempotent, false); assert.equal(second.idempotent, true); assert.equal(second.plan.planId, first.plan.planId)
})

test('duplicate idempotency key with changed semantic input is rejected', async () => {
  const { repository, routes, planner, ready } = harness()
  await ready
  const item = command('idempotency-conflict'); seed(repository, item); routes.set(item.accountId, item.conversationKey)
  await planner.plan(input(item))
  await rejectsCode(planner.plan(input(item, 2n)), 'IDEMPOTENCY_CONFLICT')
})

test('non-head or absent active reservation is not treated as sendable', async () => {
  const { repository, routes, planner, ready } = harness()
  await ready
  const item = command('no-reservation'); repository.seedCommand(item); routes.set(item.accountId, item.conversationKey)
  assert.equal((await planner.plan(input(item))).plan.refusalReason, 'CONVERSATION_NOT_SENDABLE')
})

test('terminal dispatch is never planned as a duplicate physical action', async () => {
  const { repository, routes, planner, ready } = harness()
  await ready
  const item = command('terminal'); seed(repository, item); routes.set(item.accountId, item.conversationKey); repository.setDispatchState(item.commandId, 'provider_confirmed')
  assert.equal((await planner.plan(input(item))).plan.refusalReason, 'COMMAND_ALREADY_TERMINAL')
})

test('unsupported payload is refused and raw text is never copied into the plan', async () => {
  const { repository, routes, planner, ready } = harness()
  await ready
  const item = { ...command('unsupported'), commandKind: 'media', commandPayload: { kind: 'media', text: 'must-not-copy' } }
  seed(repository, item); routes.set(item.accountId, item.conversationKey)
  const plan = (await planner.plan(input(item))).plan
  assert.equal(plan.refusalReason, 'PAYLOAD_UNSUPPORTED')
  assert.doesNotMatch(JSON.stringify(plan, (_key, value) => typeof value === 'bigint' ? value.toString(10) : value), /must-not-copy/)
})

test('planning mutates neither command/reservation nor physical/delivery adapters', async () => {
  const { repository, routes, planner, ready } = harness()
  await ready
  const item = command('side-effects'); seed(repository, item); routes.set(item.accountId, item.conversationKey)
  const beforeCommand = repository.commandSnapshot(); const beforeReservation = repository.reservationSnapshot()
  await planner.plan(input(item))
  assert.equal(repository.commandSnapshot(), beforeCommand); assert.equal(repository.reservationSnapshot(), beforeReservation)
  assert.equal(repository.physicalAdapterCalls, 0); assert.equal(repository.deliveryStateMutations, 0)
})

test('shadow planning feature flag is default-off, exact-account scoped, and rejects wildcard', () => {
  assert.equal(isOutboundShadowPlanningEnabled('account-a', undefined), false)
  assert.equal(isOutboundShadowPlanningEnabled('account-a', 'account-a'), true)
  assert.equal(isOutboundShadowPlanningEnabled('account-b', 'account-a'), false)
  assert.equal(isOutboundShadowPlanningEnabled('account-a', '*'), false)
})
