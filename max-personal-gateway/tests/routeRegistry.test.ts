import assert from 'node:assert/strict'
import test from 'node:test'
import { RouteRegistryError, type RouteRegistryErrorCode } from '../src/route/errors.ts'
import { PrismaRouteRegistry } from '../src/route/PrismaRouteRegistry.ts'
import type {
  ObserveRouteEvidenceInput,
  RouteIdentityEvidence,
} from '../src/route/types.ts'
import { FakeRoutePrismaClient, type FakeRouteIdentityRow } from './support/FakeRoutePrisma.ts'

function sequence(prefix: string): () => string {
  let value = 0
  return () => `${prefix}-${++value}`
}

function routeError(code: RouteRegistryErrorCode): (error: unknown) => boolean {
  return (error: unknown) => error instanceof RouteRegistryError && error.code === code
}

interface Harness {
  readonly client: FakeRoutePrismaClient
  readonly registry: PrismaRouteRegistry
  observe(
    accountId: string,
    identities: readonly RouteIdentityEvidence[],
    overrides?: Partial<ObserveRouteEvidenceInput>,
  ): ReturnType<PrismaRouteRegistry['observeRouteEvidence']>
}

function harness(): Harness {
  const client = new FakeRoutePrismaClient()
  const registry = new PrismaRouteRegistry(client, {
    idGenerator: sequence('route-row'),
    conversationKeyGenerator: sequence('conversation'),
    maxEvidenceBytes: 512,
  })
  let source = 0
  return {
    client,
    registry,
    observe(accountId, identities, overrides = {}) {
      source += 1
      return registry.observeRouteEvidence({
        accountId,
        sourceEvidenceKey: `physical-source-${source}`,
        extractorVersion: 'route-extractor-v1',
        observedAt: new Date(`2026-07-26T19:${String(source).padStart(2, '0')}:00.000Z`),
        evidenceSource: 'synthetic-test',
        evidenceAuthority: 'protocol_exact',
        identities,
        evidence: { synthetic: true, source },
        ...overrides,
      })
    },
  }
}

const identity = (kind: RouteIdentityEvidence['kind'], value: string): RouteIdentityEvidence => ({ kind, value })

test('account isolation permits the same exact provider identities without cross-account reads or mutations', async () => {
  const context = harness()
  const identities = [
    identity('provider_user_id', 'provider-SAME'),
    identity('protocol_chat_id', 'protocol-SAME'),
    identity('web_route_id', 'web-SAME'),
  ]
  const accountA = await context.observe('account-a', identities)
  const accountB = await context.observe('account-b', identities)

  assert.notEqual(accountA.conversationKey, accountB.conversationKey)
  for (const providerIdentity of identities) assert.notEqual(accountA.conversationKey, providerIdentity.value)
  assert.equal((await context.registry.resolveByIdentity('account-a', 'provider_user_id', 'provider-SAME'))?.accountId, 'account-a')
  assert.equal((await context.registry.resolveByIdentity('account-b', 'protocol_chat_id', 'protocol-SAME'))?.accountId, 'account-b')
  assert.equal((await context.registry.resolveByIdentity('account-a', 'web_route_id', 'web-SAME'))?.conversationKey, accountA.conversationKey)
  assert.equal(await context.registry.getRouteSnapshot('account-a', accountB.conversationKey), null)

  const beforeB = await context.registry.getRouteSnapshot('account-b', accountB.conversationKey)
  await context.registry.supersedeIdentity({
    accountId: 'account-a', conversationKey: accountA.conversationKey, identityKind: 'web_route_id',
    oldIdentityValue: 'web-SAME', newIdentityValue: 'web-A-new', sourceEvidenceKey: 'manual-a',
    expectedRouteVersion: accountA.routeVersion, actor: 'reviewer-a', reason: 'synthetic drift',
    observedAt: new Date('2026-07-26T20:00:00Z'), evidence: { ticket: 'synthetic-audit' },
  })
  assert.deepEqual(await context.registry.getRouteSnapshot('account-b', accountB.conversationKey), beforeB)
  await assert.rejects(context.registry.supersedeIdentity({
    accountId: 'account-b', conversationKey: accountA.conversationKey, identityKind: 'protocol_chat_id',
    oldIdentityValue: 'protocol-SAME', newIdentityValue: 'protocol-cross', sourceEvidenceKey: 'cross-account',
    expectedRouteVersion: 1, actor: 'reviewer-b', reason: 'must fail',
    observedAt: new Date('2026-07-26T20:01:00Z'), evidence: {},
  }), routeError('NOT_FOUND'))

  context.client.addRawObservation('account-a', 'raw-a')
  await assert.rejects(context.observe('account-b', [identity('protocol_chat_id', 'raw-mismatch')], {
    sourceRawObservationId: 'raw-a', sourceEvidenceKey: 'raw-mismatch',
  }), routeError('ACCOUNT_MISMATCH'))
})

test('exact evidence creates a stable internal conversation and repeated physical evidence is idempotent by source', async () => {
  const context = harness()
  context.client.addRawObservation('account-a', 'raw-1')
  context.client.addRawObservation('account-a', 'raw-2')
  const input = {
    sourceEvidenceKey: 'raw-1-evidence', sourceRawObservationId: 'raw-1',
    evidence: { payloadHash: 'same-synthetic-hash' },
  } as const
  const first = await context.observe('account-a', [identity('protocol_chat_id', 'protocol-101')], input)
  const repeated = await context.observe('account-a', [identity('protocol_chat_id', 'protocol-101')], input)

  assert.equal(first.routeVersion, 1)
  assert.equal(first.state, 'active')
  assert.equal(repeated.conversationKey, first.conversationKey)
  assert.equal(repeated.routeVersion, 1)
  assert.equal(repeated.idempotent, true)
  assert.equal(context.client.snapshot().observations.length, 1)
  assert.notEqual(first.conversationKey, 'protocol-101')

  const secondPhysical = await context.observe('account-a', [identity('protocol_chat_id', 'protocol-101')], {
    sourceEvidenceKey: 'raw-2-evidence', sourceRawObservationId: 'raw-2',
    evidence: { payloadHash: 'same-synthetic-hash' },
  })
  assert.equal(secondPhysical.routeVersion, 1)
  assert.equal(secondPhysical.semanticChange, false)
  assert.equal(context.client.snapshot().observations.length, 2)

  const attached = await context.observe('account-a', [
    identity('protocol_chat_id', 'protocol-101'), identity('provider_user_id', 'provider-101'),
  ], { candidateConversationKey: first.conversationKey })
  assert.equal(attached.conversationKey, first.conversationKey)
  assert.equal(attached.routeVersion, 2)
  assert.equal((await context.registry.getSendableRouteSnapshot('account-a', first.conversationKey)).activeProviderUserId, 'provider-101')
})

test('provider identities are exact strings: case is preserved and invalid whitespace or coercion is rejected', async () => {
  const context = harness()
  const upper = await context.observe('account-a', [identity('provider_user_id', 'Provider-Exact')], {
    evidenceAuthority: 'provider_exact',
  })
  const lower = await context.observe('account-a', [identity('provider_user_id', 'provider-exact')], {
    evidenceAuthority: 'provider_exact',
  })
  assert.notEqual(upper.conversationKey, lower.conversationKey)
  assert.equal((await context.registry.resolveByIdentity('account-a', 'provider_user_id', 'Provider-Exact'))?.conversationKey,
    upper.conversationKey)
  assert.equal((await context.registry.resolveByIdentity('account-a', 'provider_user_id', 'provider-exact'))?.conversationKey,
    lower.conversationKey)
  await assert.rejects(context.observe('account-a', [identity('provider_user_id', ' provider-exact')], {
    evidenceAuthority: 'provider_exact',
  }), routeError('INVALID_INPUT'))
  await assert.rejects(context.observe('account-a', [
    { kind: 'provider_user_id', value: 101 as unknown as string },
  ], { evidenceAuthority: 'provider_exact' }), routeError('INVALID_INPUT'))
})

test('weak web and legacy evidence remain provisional and never override an exact binding', async () => {
  const context = harness()
  const exact = await context.observe('account-a', [identity('protocol_chat_id', 'protocol-exact')])
  const other = await context.observe('account-a', [identity('protocol_chat_id', 'protocol-other')])
  const weakNew = await context.observe('account-a', [identity('web_route_id', 'web-provisional')], {
    evidenceAuthority: 'web_route_observed',
  })
  assert.equal(weakNew.state, 'unresolved')
  await assert.rejects(
    context.registry.getSendableRouteSnapshot('account-a', weakNew.conversationKey),
    routeError('ROUTE_NOT_SENDABLE'),
  )

  const weakAgainstExact = await context.observe('account-a', [identity('protocol_chat_id', 'protocol-exact')], {
    candidateConversationKey: other.conversationKey,
    evidenceAuthority: 'web_route_observed',
  })
  const legacyAgainstExact = await context.observe('account-a', [identity('protocol_chat_id', 'protocol-exact')], {
    candidateConversationKey: other.conversationKey,
    evidenceAuthority: 'legacy_import',
  })
  assert.equal(weakAgainstExact.conversationKey, exact.conversationKey)
  assert.deepEqual(weakAgainstExact.processingResults, ['ignored_weak'])
  assert.equal(legacyAgainstExact.conversationKey, exact.conversationKey)
  assert.deepEqual(legacyAgainstExact.processingResults, ['ignored_weak'])
  assert.equal((await context.registry.resolveByIdentity('account-a', 'protocol_chat_id', 'protocol-exact'))?.conversationKey, exact.conversationKey)

  await assert.rejects(context.observe('account-a', [identity('protocol_chat_id', 'manual-invalid')], {
    evidenceAuthority: 'manual_approved' as ObserveRouteEvidenceInput['evidenceAuthority'],
  }), routeError('INVALID_INPUT'))
})

async function conflictingHarness(): Promise<{
  context: Harness
  incumbentKey: string
  candidateKey: string
  conflictId: string
}> {
  const context = harness()
  const incumbent = await context.observe('account-a', [identity('protocol_chat_id', 'protocol-incumbent')])
  const candidate = await context.observe('account-a', [identity('protocol_chat_id', 'protocol-candidate')])
  const conflict = await context.observe('account-a', [identity('protocol_chat_id', 'protocol-incumbent')], {
    sourceEvidenceKey: 'wrong-conversation-evidence', candidateConversationKey: candidate.conversationKey,
  })
  assert.ok(conflict.conflictId)
  return {
    context,
    incumbentKey: incumbent.conversationKey,
    candidateKey: candidate.conversationKey,
    conflictId: conflict.conflictId,
  }
}

test('wrong-conversation exact evidence creates one durable conflict without reassigning the incumbent', async () => {
  const { context, incumbentKey, candidateKey, conflictId } = await conflictingHarness()
  const store = context.client.snapshot()
  const binding = store.identities.find(row => row.identityValue === 'protocol-incumbent')
  assert.equal(binding?.conversationKey, incumbentKey)
  assert.equal(binding?.status, 'conflicted')
  assert.equal(store.conflicts.length, 1)
  assert.equal(store.conflicts[0]?.candidateConversationKey, candidateKey)
  assert.equal((await context.registry.listOpenConflicts('account-a', undefined, 10)).conflicts[0]?.conflictId, conflictId)
  assert.equal((await context.registry.getRouteSnapshot('account-a', incumbentKey))?.state, 'conflicted')
  assert.equal((await context.registry.getRouteSnapshot('account-a', candidateKey))?.state, 'conflicted')
  await assert.rejects(context.registry.getSendableRouteSnapshot('account-a', incumbentKey), routeError('ROUTE_NOT_SENDABLE'))

  const incumbentVersion = (await context.registry.getRouteSnapshot('account-a', incumbentKey))!.routeVersion
  const candidateVersion = (await context.registry.getRouteSnapshot('account-a', candidateKey))!.routeVersion
  const repeated = await context.observe('account-a', [identity('protocol_chat_id', 'protocol-incumbent')], {
    sourceEvidenceKey: 'wrong-conversation-evidence', candidateConversationKey: candidateKey,
  })
  assert.equal(repeated.idempotent, true)
  assert.equal(context.client.snapshot().conflicts.length, 1)
  assert.equal((await context.registry.getRouteSnapshot('account-a', incumbentKey))?.routeVersion, incumbentVersion)
  assert.equal((await context.registry.getRouteSnapshot('account-a', candidateKey))?.routeVersion, candidateVersion)

  const isolated = await context.observe('account-b', [identity('protocol_chat_id', 'protocol-incumbent')])
  assert.equal((await context.registry.getSendableRouteSnapshot('account-b', isolated.conversationKey)).state, 'active')
})

test('three-way exact ambiguity durably blocks every involved conversation without an automatic merge', async () => {
  const context = harness()
  const protocol = await context.observe('account-a', [identity('protocol_chat_id', 'protocol-three-way')])
  const provider = await context.observe('account-a', [identity('provider_user_id', 'provider-three-way')], {
    evidenceAuthority: 'provider_exact',
  })
  const web = await context.observe('account-a', [identity('web_route_id', 'web-three-way')])
  const ambiguity = await context.observe('account-a', [
    identity('protocol_chat_id', 'protocol-three-way'),
    identity('provider_user_id', 'provider-three-way'),
    identity('web_route_id', 'web-three-way'),
  ], { sourceEvidenceKey: 'three-way-source' })

  assert.equal(ambiguity.state, 'conflicted')
  assert.equal(context.client.snapshot().conflicts.length, 2)
  for (const key of [protocol.conversationKey, provider.conversationKey, web.conversationKey]) {
    assert.equal((await context.registry.getRouteSnapshot('account-a', key))?.state, 'conflicted')
  }
  assert.equal(context.client.snapshot().conversations.length, 3)
  const repeated = await context.observe('account-a', [
    identity('protocol_chat_id', 'protocol-three-way'),
    identity('provider_user_id', 'provider-three-way'),
    identity('web_route_id', 'web-three-way'),
  ], { sourceEvidenceKey: 'three-way-source' })
  assert.equal(repeated.idempotent, true)
  assert.equal(context.client.snapshot().conflicts.length, 2)
})

test('conflict resolution rejects stale writers, records audit, and advances both route versions', async () => {
  const { context, incumbentKey, candidateKey, conflictId } = await conflictingHarness()
  const incumbent = (await context.registry.getRouteSnapshot('account-a', incumbentKey))!
  const candidate = (await context.registry.getRouteSnapshot('account-a', candidateKey))!
  await assert.rejects(context.registry.resolveConflict({
    accountId: 'account-a', conflictId, decision: 'keep_incumbent', expectedConflictVersion: 99,
    expectedIncumbentRouteVersion: incumbent.routeVersion, expectedCandidateRouteVersion: candidate.routeVersion,
    actor: 'route-reviewer', reason: 'synthetic reviewed evidence', resolvedAt: new Date('2026-07-26T21:00:00Z'),
    auditMetadata: { ticket: 'review-1' },
  }), routeError('STALE_CONFLICT_VERSION'))

  const resolved = await context.registry.resolveConflict({
    accountId: 'account-a', conflictId, decision: 'keep_incumbent', expectedConflictVersion: 0,
    expectedIncumbentRouteVersion: incumbent.routeVersion, expectedCandidateRouteVersion: candidate.routeVersion,
    actor: 'route-reviewer', reason: 'synthetic reviewed evidence', resolvedAt: new Date('2026-07-26T21:00:00Z'),
    auditMetadata: { ticket: 'review-1' },
  })
  assert.equal(resolved.status, 'resolved')
  assert.equal(resolved.resolvedBy, 'route-reviewer')
  assert.equal(resolved.resolutionReason, 'synthetic reviewed evidence')
  assert.deepEqual(resolved.auditMetadata, {
    decision: 'keep_incumbent',
    evidence: { ticket: 'review-1' },
    evidenceSha256: (resolved.auditMetadata as { evidenceSha256: string }).evidenceSha256,
    evidenceQuarantined: false,
  })
  assert.equal((await context.registry.getRouteSnapshot('account-a', incumbentKey))?.routeVersion, incumbent.routeVersion + 1)
  assert.equal((await context.registry.getRouteSnapshot('account-a', candidateKey))?.routeVersion, candidate.routeVersion + 1)
  assert.equal((await context.registry.getSendableRouteSnapshot('account-a', incumbentKey)).activeProtocolChatId, 'protocol-incumbent')
})

test('explicit assign-candidate resolution moves only the audited identity and never merges conversation anchors', async () => {
  const context = harness()
  const incumbent = await context.observe('account-a', [identity('provider_user_id', 'provider-movable')], {
    evidenceAuthority: 'provider_exact',
  })
  const candidate = await context.observe('account-a', [identity('protocol_chat_id', 'protocol-target')])
  const conflictResult = await context.observe('account-a', [
    identity('provider_user_id', 'provider-movable'), identity('protocol_chat_id', 'protocol-target'),
  ], { evidenceAuthority: 'provider_exact' })
  assert.ok(conflictResult.conflictId)
  const incumbentConflicted = (await context.registry.getRouteSnapshot('account-a', incumbent.conversationKey))!
  const candidateConflicted = (await context.registry.getRouteSnapshot('account-a', candidate.conversationKey))!

  const resolved = await context.registry.resolveConflict({
    accountId: 'account-a', conflictId: conflictResult.conflictId, decision: 'assign_candidate',
    expectedConflictVersion: 0,
    expectedIncumbentRouteVersion: incumbentConflicted.routeVersion,
    expectedCandidateRouteVersion: candidateConflicted.routeVersion,
    actor: 'route-reviewer', reason: 'two exact identifiers reviewed',
    resolvedAt: new Date('2026-07-26T21:30:00Z'), auditMetadata: { ticket: 'review-assign-1' },
  })
  assert.equal(resolved.status, 'resolved')
  assert.equal((await context.registry.resolveByIdentity('account-a', 'provider_user_id', 'provider-movable'))?.conversationKey,
    candidate.conversationKey)
  assert.equal((await context.registry.getRouteSnapshot('account-a', incumbent.conversationKey))?.state, 'unresolved')
  assert.equal((await context.registry.getSendableRouteSnapshot('account-a', candidate.conversationKey)).activeProviderUserId,
    'provider-movable')
  assert.equal(context.client.snapshot().conversations.length, 2)
})

test('explicit supersede preserves identity history, immutable snapshots, and stable conversationKey', async () => {
  const context = harness()
  const created = await context.observe('account-a', [
    identity('protocol_chat_id', 'protocol-stable'), identity('web_route_id', 'web-old'),
  ])
  const before = (await context.registry.getRouteSnapshot('account-a', created.conversationKey))!
  assert.equal(Object.isFrozen(before), true)
  assert.equal(Object.isFrozen(before.identities), true)

  const passive = await context.observe('account-a', [identity('web_route_id', 'web-new')], {
    candidateConversationKey: created.conversationKey, evidenceAuthority: 'web_route_observed',
  })
  assert.deepEqual(passive.processingResults, ['ignored_weak'])
  assert.equal(passive.routeVersion, created.routeVersion)

  const after = await context.registry.supersedeIdentity({
    accountId: 'account-a', conversationKey: created.conversationKey, identityKind: 'web_route_id',
    oldIdentityValue: 'web-old', newIdentityValue: 'web-new', sourceEvidenceKey: 'approved-drift',
    expectedRouteVersion: created.routeVersion, actor: 'route-reviewer', reason: 'provider route rotated',
    observedAt: new Date('2026-07-26T22:00:00Z'), evidence: { ticket: 'drift-1' },
  })
  assert.equal(after.conversationKey, created.conversationKey)
  assert.equal(after.routeVersion, created.routeVersion + 1)
  assert.equal(after.activeWebRouteId, 'web-new')
  assert.equal(before.activeWebRouteId, 'web-old')
  assert.equal(before.routeVersion, created.routeVersion)
  const history = context.client.snapshot().identities.filter(row => row.identityKind === 'web_route_id')
  assert.deepEqual(history.map(row => [row.identityValue, row.status]), [['web-old', 'superseded'], ['web-new', 'active']])
  const manualAudit = context.client.snapshot().observations.find(row => row.processingResult === 'superseded')
  assert.match(JSON.stringify(manualAudit?.sanitizedEvidence), /route-reviewer/)
  assert.match(JSON.stringify(manualAudit?.sanitizedEvidence), /provider route rotated/)
  await assert.rejects(context.registry.supersedeIdentity({
    accountId: 'account-a', conversationKey: created.conversationKey, identityKind: 'web_route_id',
    oldIdentityValue: 'web-new', newIdentityValue: 'web-late', sourceEvidenceKey: 'stale-drift',
    expectedRouteVersion: created.routeVersion, actor: 'late-reviewer', reason: 'stale mutation',
    observedAt: new Date('2026-07-26T22:01:00Z'), evidence: {},
  }), routeError('STALE_ROUTE_VERSION'))
  assert.equal((await context.registry.getRouteSnapshot('account-a', created.conversationKey))?.activeWebRouteId, 'web-new')
})

test('transaction failures roll back observation, projection, conflict, supersede, and conflict resolution', async () => {
  const observationContext = harness()
  observationContext.client.setFailures({ observationCreate: true })
  await assert.rejects(observationContext.observe('account-a', [identity('protocol_chat_id', 'protocol-observation-rollback')], {
    evidence: { Authorization: 'Bearer synthetic-error-secret' },
  }), (error: unknown) => error instanceof RouteRegistryError
    && error.code === 'DATABASE_FAILURE' && !error.message.includes('synthetic-error-secret'))
  assert.equal(observationContext.client.snapshot().conversations.length, 0)
  assert.equal(observationContext.client.snapshot().observations.length, 0)

  const createContext = harness()
  createContext.client.setFailures({ identityCreate: true })
  await assert.rejects(createContext.observe('account-a', [identity('protocol_chat_id', 'protocol-rollback')]), routeError('DATABASE_FAILURE'))
  assert.equal(createContext.client.snapshot().conversations.length, 0)
  assert.equal(createContext.client.snapshot().observations.length, 0)

  const conflictSetup = harness()
  const incumbent = await conflictSetup.observe('account-a', [identity('protocol_chat_id', 'protocol-a')])
  const candidate = await conflictSetup.observe('account-a', [identity('protocol_chat_id', 'protocol-b')])
  conflictSetup.client.setFailures({ conflictCreate: true })
  await assert.rejects(conflictSetup.observe('account-a', [identity('protocol_chat_id', 'protocol-a')], {
    candidateConversationKey: candidate.conversationKey,
  }), routeError('DATABASE_FAILURE'))
  assert.equal(conflictSetup.client.snapshot().conflicts.length, 0)
  assert.equal((await conflictSetup.registry.getRouteSnapshot('account-a', incumbent.conversationKey))?.state, 'active')
  assert.equal((await conflictSetup.registry.getRouteSnapshot('account-a', candidate.conversationKey))?.state, 'active')

  conflictSetup.client.setFailures({ identityUpdate: true })
  await assert.rejects(conflictSetup.registry.supersedeIdentity({
    accountId: 'account-a', conversationKey: incumbent.conversationKey, identityKind: 'protocol_chat_id',
    oldIdentityValue: 'protocol-a', newIdentityValue: 'protocol-a-new', sourceEvidenceKey: 'rollback-supersede',
    expectedRouteVersion: 1, actor: 'reviewer', reason: 'synthetic failure',
    observedAt: new Date('2026-07-26T23:00:00Z'), evidence: {},
  }), routeError('DATABASE_FAILURE'))
  assert.equal(conflictSetup.client.snapshot().identities.filter(row => row.status === 'active'
    && row.conversationKey === incumbent.conversationKey).length, 1)
  assert.equal((await conflictSetup.registry.getRouteSnapshot('account-a', incumbent.conversationKey))?.routeVersion, 1)

  const confirmContext = harness()
  const confirmed = await confirmContext.observe('account-a', [identity('protocol_chat_id', 'protocol-confirm')])
  const beforeConfirmFailure = confirmContext.client.snapshot()
  confirmContext.client.setFailures({ identityUpdate: true })
  await assert.rejects(confirmContext.observe('account-a', [identity('protocol_chat_id', 'protocol-confirm')]),
    routeError('DATABASE_FAILURE'))
  assert.equal((await confirmContext.registry.getRouteSnapshot('account-a', confirmed.conversationKey))?.routeVersion, 1)
  assert.equal(confirmContext.client.snapshot().observations.length, beforeConfirmFailure.observations.length)

  const resolution = await conflictingHarness()
  const incumbentBefore = (await resolution.context.registry.getRouteSnapshot('account-a', resolution.incumbentKey))!
  const candidateBefore = (await resolution.context.registry.getRouteSnapshot('account-a', resolution.candidateKey))!
  resolution.context.client.setFailures({ conflictUpdate: true })
  await assert.rejects(resolution.context.registry.resolveConflict({
    accountId: 'account-a', conflictId: resolution.conflictId, decision: 'keep_incumbent', expectedConflictVersion: 0,
    expectedIncumbentRouteVersion: incumbentBefore.routeVersion,
    expectedCandidateRouteVersion: candidateBefore.routeVersion,
    actor: 'reviewer', reason: 'synthetic rollback', resolvedAt: new Date('2026-07-26T23:01:00Z'),
  }), routeError('DATABASE_FAILURE'))
  assert.equal(resolution.context.client.snapshot().conflicts[0]?.status, 'open')
  assert.equal(resolution.context.client.snapshot().identities.find(row => row.identityValue === 'protocol-incumbent')?.status, 'conflicted')
  assert.deepEqual(await resolution.context.registry.getRouteSnapshot('account-a', resolution.incumbentKey), incumbentBefore)
})

test('sendable snapshots fail closed for unknown, unresolved, retired, account mismatch, and corrupt duplicate routes', async () => {
  const context = harness()
  await assert.rejects(context.registry.getSendableRouteSnapshot('account-a', 'unknown'), routeError('NOT_FOUND'))
  const unresolved = await context.observe('account-a', [identity('web_route_id', 'web-only')], {
    evidenceAuthority: 'web_route_observed',
  })
  await assert.rejects(context.registry.getSendableRouteSnapshot('account-a', unresolved.conversationKey), routeError('ROUTE_NOT_SENDABLE'))
  await assert.rejects(context.registry.getSendableRouteSnapshot('account-b', unresolved.conversationKey), routeError('NOT_FOUND'))

  const active = await context.observe('account-a', [identity('protocol_chat_id', 'protocol-retire')])
  const retired = await context.registry.retireConversation({
    accountId: 'account-a', conversationKey: active.conversationKey, expectedRouteVersion: active.routeVersion,
    sourceEvidenceKey: 'retire-approved', actor: 'route-reviewer', reason: 'synthetic retirement',
    retiredAt: new Date('2026-07-27T00:00:00Z'), evidence: { ticket: 'retire-1' },
  })
  assert.equal(retired.state, 'retired')
  assert.equal(retired.routeVersion, active.routeVersion + 1)
  await assert.rejects(context.registry.getSendableRouteSnapshot('account-a', active.conversationKey), routeError('ROUTE_NOT_SENDABLE'))

  const clean = harness()
  const route = await clean.observe('account-a', [identity('protocol_chat_id', 'protocol-primary')])
  const now = new Date('2026-07-27T00:01:00Z')
  const corrupt: FakeRouteIdentityRow = {
    id: 'corrupt-row', accountId: 'account-a', identityKind: 'protocol_chat_id', identityValue: 'protocol-duplicate',
    conversationKey: route.conversationKey, status: 'active', firstSeenAt: now, lastSeenAt: now,
    evidenceRef: 'corrupt-evidence', version: 0, createdAt: now, updatedAt: now,
  }
  clean.client.unsafeInjectIdentityForCorruptionTest(corrupt)
  await assert.rejects(clean.registry.getSendableRouteSnapshot('account-a', route.conversationKey), routeError('ROUTE_NOT_SENDABLE'))
})

test('reads and bounded conflict pagination do not mutate route versions', async () => {
  const context = harness()
  const route = await context.observe('account-a', [identity('protocol_chat_id', 'protocol-read')])
  await context.registry.getRouteSnapshot('account-a', route.conversationKey)
  await context.registry.getSendableRouteSnapshot('account-a', route.conversationKey)
  await context.registry.resolveByIdentity('account-a', 'protocol_chat_id', 'protocol-read')
  await context.registry.listOpenConflicts('account-a', undefined, 10)
  assert.equal((await context.registry.getRouteSnapshot('account-a', route.conversationKey))?.routeVersion, route.routeVersion)
  await assert.rejects(context.registry.listOpenConflicts('account-a', undefined, 0), routeError('INVALID_INPUT'))
  await assert.rejects(context.registry.listOpenConflicts('account-a', undefined, 101), routeError('INVALID_INPUT'))
})
