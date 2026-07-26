import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { PrismaRawEventJournal } from '../../src/journal/PrismaRawEventJournal.ts'
import { PrismaRouteRegistry } from '../../src/route/PrismaRouteRegistry.ts'
import type { ObserveRouteEvidenceInput, RouteIdentityEvidence } from '../../src/route/types.ts'
import {
  createRealPrismaClient,
  errorCode,
  readRealPostgresConfig,
  rejectedCode,
  runId,
  type RealPrismaClient,
} from '../support/realPostgres.ts'

const config = readRealPostgresConfig()

function routeInput(
  accountId: string,
  sourceEvidenceKey: string,
  identities: readonly RouteIdentityEvidence[],
  overrides: Partial<ObserveRouteEvidenceInput> = {},
): ObserveRouteEvidenceInput {
  return {
    accountId,
    sourceEvidenceKey,
    extractorVersion: 'stage2g-extractor-v1',
    observedAt: new Date('2026-07-26T20:10:00.000Z'),
    evidenceSource: 'stage2g-real-postgres',
    evidenceAuthority: 'protocol_exact',
    identities,
    evidence: { kind: 'route-evidence', token: 'must-redact' },
    ...overrides,
  }
}

function rawInput(accountId: string, marker: string) {
  return {
    accountId,
    observedAt: new Date('2026-07-26T20:10:00.000Z'),
    sourceTransport: 'websocket_frame',
    sourceOrigin: 'stage2g-route-test',
    historyLive: 'live' as const,
    providerEventId: marker,
    payloadEncoding: 'json' as const,
    sanitizedPayload: { marker },
    payloadSha256: 'd'.repeat(64),
    payloadSizeBytes: marker.length,
    replayAvailability: 'available' as const,
    sanitizerVersion: 'stage2g-v1',
    captureAdapterVersion: 'stage2g-v1',
    schemaVersion: 1,
    redactionMetadata: { sanitizerVersion: 'stage2g-v1', categories: [], paths: [] },
    quarantineEligible: true,
    parserVersion: 'route-parser-v1',
  }
}

if (config === null) {
  test('real PostgreSQL route gate requires PERSONAL_MAX_REAL_POSTGRES_URL', { skip: true }, () => {})
} else {
  describe('Stage 2 real PostgreSQL route semantics', { concurrency: false }, () => {
    let client: RealPrismaClient
    let registry: PrismaRouteRegistry
    let journal: PrismaRawEventJournal

    before(async () => {
      client = await createRealPrismaClient(config)
      registry = new PrismaRouteRegistry(client as any)
      journal = new PrismaRawEventJournal(client as any)
    })

    after(async () => {
      await client.$disconnect()
    })

    test('S2-01..06 identities and idempotency are account-scoped and composite FKs reject mismatch', async () => {
      const accountA = runId('s2_scope_a')
      const accountB = runId('s2_scope_b')
      const identities: RouteIdentityEvidence[] = [
        { kind: 'provider_user_id', value: 'same-provider-user' },
        { kind: 'protocol_chat_id', value: 'same-protocol-chat' },
        { kind: 'web_route_id', value: 'same-web-route' },
      ]
      const a = await registry.observeRouteEvidence(routeInput(accountA, 'same-evidence-key', identities))
      const b = await registry.observeRouteEvidence(routeInput(accountB, 'same-evidence-key', identities))
      assert.notEqual(a.conversationKey, b.conversationKey)
      const observations = await client.maxRouteObservation.findMany({
        where: { accountId: { in: [accountA, accountB] } },
        orderBy: { accountId: 'asc' },
      })
      assert.equal(observations.length, 6)
      assert.equal(new Set(observations.map((row: any) => row.idempotencyKey)).size, 3)
      assert.equal(await client.maxRouteIdentityBinding.count({
        where: { accountId: { in: [accountA, accountB] }, identityValue: 'same-protocol-chat' },
      }), 2)

      await assert.rejects(client.maxRouteIdentityBinding.create({
        data: {
          id: runId('cross_account_binding'), accountId: accountA, identityKind: 'protocol_chat_id',
          identityValue: 'cross-account-fk', conversationKey: b.conversationKey, status: 'active',
          firstSeenAt: new Date(), lastSeenAt: new Date(), evidenceRef: observations[0].routeObservationId, version: 0,
        },
      }))
      const rawA = await journal.append(rawInput(accountA, 'cross-account-raw'))
      await rejectedCode(registry.observeRouteEvidence(routeInput(accountB, 'cross-account-raw-evidence', [
        { kind: 'provider_user_id', value: 'cross-account-provider' },
      ], { sourceRawObservationId: rawA })), 'ACCOUNT_MISMATCH')
    })

    test('S2-07..13 exact evidence is stable, physical observations remain distinct and invalid identities are rejected', async () => {
      const account = runId('s2_exact')
      const identities: RouteIdentityEvidence[] = [
        { kind: 'provider_user_id', value: 'provider-exact' },
        { kind: 'protocol_chat_id', value: 'protocol-exact' },
        { kind: 'web_route_id', value: 'web-exact' },
      ]
      const first = await registry.observeRouteEvidence(routeInput(account, 'exact-1', identities))
      assert.equal(first.routeVersion, 1)
      assert.equal(first.state, 'active')
      const repeated = await registry.observeRouteEvidence(routeInput(account, 'exact-1', identities))
      assert.equal(repeated.idempotent, true)
      assert.equal(repeated.routeVersion, first.routeVersion)
      assert.equal(repeated.conversationKey, first.conversationKey)

      const raw1 = await journal.append(rawInput(account, 'physical-1'))
      const raw2 = await journal.append(rawInput(account, 'physical-2'))
      const physical1 = await registry.observeRouteEvidence(routeInput(account, 'same-semantic-source', [
        { kind: 'protocol_chat_id', value: 'protocol-exact' },
      ], { sourceRawObservationId: raw1 }))
      const physical2 = await registry.observeRouteEvidence(routeInput(account, 'same-semantic-source', [
        { kind: 'protocol_chat_id', value: 'protocol-exact' },
      ], { sourceRawObservationId: raw2 }))
      assert.notDeepEqual(physical1.routeObservationIds, physical2.routeObservationIds)
      assert.equal(physical1.routeVersion, first.routeVersion)
      assert.equal(physical2.routeVersion, first.routeVersion)
      assert.equal(physical1.semanticChange, false)
      assert.equal(physical2.semanticChange, false)
      await rejectedCode(registry.observeRouteEvidence(routeInput(account, 'bad-space', [
        { kind: 'protocol_chat_id', value: ' protocol' },
      ])), 'INVALID_INPUT')
      await rejectedCode(registry.observeRouteEvidence(routeInput(account, 'bad-control', [
        { kind: 'protocol_chat_id', value: 'protocol\u0000bad' },
      ])), 'INVALID_INPUT')
      await assert.rejects(client.maxRouteIdentityBinding.create({
        data: {
          id: runId('invalid_binding'), accountId: account, identityKind: 'web_route_id', identityValue: ' trailing ',
          conversationKey: first.conversationKey, status: 'provisional', firstSeenAt: new Date(), lastSeenAt: new Date(),
          evidenceRef: first.routeObservationIds[0], version: 0,
        },
      }))
    })

    test('S2-14..17 route observations are append-only without caller GUC bypass; projections remain mutable', async () => {
      const account = runId('s2_append_only')
      const created = await registry.observeRouteEvidence(routeInput(account, 'append-only', [
        { kind: 'protocol_chat_id', value: 'append-only-chat' },
      ]))
      const observationId = created.routeObservationIds[0]
      await assert.rejects(client.$executeRawUnsafe(
        `UPDATE "MaxRouteObservation" SET "processingResult" = 'confirmed' WHERE "routeObservationId" = $1`, observationId,
      ))
      await assert.rejects(client.$executeRawUnsafe(
        `DELETE FROM "MaxRouteObservation" WHERE "routeObservationId" = $1`, observationId,
      ))
      await assert.rejects(client.$transaction(async transaction => {
        await transaction.$executeRawUnsafe(`SET LOCAL max_personal.allow_route_retention = 'on'`)
        await transaction.$executeRawUnsafe(`DELETE FROM "MaxRouteObservation" WHERE "routeObservationId" = $1`, observationId)
      }))
      assert.equal(await client.maxRouteConversation.updateMany({
        where: { accountId: account, conversationKey: created.conversationKey },
        data: { updatedAt: new Date('2026-07-26T20:11:00.000Z') },
      }).then((result: any) => result.count), 1)
    })

    test('S2-18..25 conflicts preserve incumbent binding, fail closed on both routes and deduplicate repeated evidence', async () => {
      const account = runId('s2_conflict')
      const incumbent = await registry.observeRouteEvidence(routeInput(account, 'incumbent', [
        { kind: 'protocol_chat_id', value: 'incumbent-chat' },
      ]))
      const candidate = await registry.observeRouteEvidence(routeInput(account, 'candidate', [
        { kind: 'protocol_chat_id', value: 'candidate-chat' },
      ]))
      const conflict = await registry.observeRouteEvidence(routeInput(account, 'conflict-first', [
        { kind: 'protocol_chat_id', value: 'incumbent-chat' },
      ], { candidateConversationKey: candidate.conversationKey }))
      assert.equal(conflict.state, 'conflicted')
      assert.ok(conflict.conflictId)
      const incumbentBinding = await client.maxRouteIdentityBinding.findUniqueOrThrow({
        where: { accountId_identityKind_identityValue: {
          accountId: account, identityKind: 'protocol_chat_id', identityValue: 'incumbent-chat',
        } },
      })
      assert.equal(incumbentBinding.conversationKey, incumbent.conversationKey)
      assert.equal(incumbentBinding.status, 'conflicted')
      assert.equal((await registry.getRouteSnapshot(account, incumbent.conversationKey))?.state, 'conflicted')
      assert.equal((await registry.getRouteSnapshot(account, candidate.conversationKey))?.state, 'conflicted')
      await rejectedCode(registry.getSendableRouteSnapshot(account, incumbent.conversationKey), 'ROUTE_NOT_SENDABLE')
      await rejectedCode(registry.getSendableRouteSnapshot(account, candidate.conversationKey), 'ROUTE_NOT_SENDABLE')

      const incumbentVersion = (await registry.getRouteSnapshot(account, incumbent.conversationKey))!.routeVersion
      const candidateVersion = (await registry.getRouteSnapshot(account, candidate.conversationKey))!.routeVersion
      const repeated = await registry.observeRouteEvidence(routeInput(account, 'conflict-first', [
        { kind: 'protocol_chat_id', value: 'incumbent-chat' },
      ], { candidateConversationKey: candidate.conversationKey }))
      assert.equal(repeated.idempotent, true)
      const separatePhysical = await registry.observeRouteEvidence(routeInput(account, 'conflict-second-physical', [
        { kind: 'protocol_chat_id', value: 'incumbent-chat' },
      ], { candidateConversationKey: candidate.conversationKey }))
      assert.equal(separatePhysical.idempotent, false)
      assert.equal(separatePhysical.semanticChange, false)
      assert.equal((await registry.getRouteSnapshot(account, incumbent.conversationKey))!.routeVersion, incumbentVersion)
      assert.equal((await registry.getRouteSnapshot(account, candidate.conversationKey))!.routeVersion, candidateVersion)
      assert.equal(await client.maxRouteConflict.count({ where: { accountId: account, status: 'open' } }), 1)
      assert.equal(await client.maxRouteObservation.count({ where: { accountId: account, processingResult: 'conflict' } }), 2)
    })

    test('S2-26..34 sendable snapshots require one exact active protocol route and reads do not mutate version', async () => {
      const account = runId('s2_snapshot')
      const active = await registry.observeRouteEvidence(routeInput(account, 'snapshot-active', [
        { kind: 'provider_user_id', value: 'snapshot-user' },
        { kind: 'protocol_chat_id', value: 'snapshot-chat' },
      ]))
      const sendable = await registry.getSendableRouteSnapshot(account, active.conversationKey)
      assert.equal(sendable.activeProtocolChatId, 'snapshot-chat')
      assert.equal(sendable.routeVersion, active.routeVersion)
      assert.equal((await registry.getRouteSnapshot(account, active.conversationKey))?.routeVersion, active.routeVersion)
      assert.equal((await registry.resolveByIdentity(account, 'protocol_chat_id', 'snapshot-chat'))?.conversationKey, active.conversationKey)
      assert.equal(await registry.resolveByIdentity(`${account}_wrong`, 'protocol_chat_id', 'snapshot-chat'), null)

      const unresolved = await registry.observeRouteEvidence(routeInput(account, 'snapshot-weak', [
        { kind: 'web_route_id', value: 'weak-web-route' },
      ], { evidenceAuthority: 'web_route_observed' }))
      await rejectedCode(registry.getSendableRouteSnapshot(account, unresolved.conversationKey), 'ROUTE_NOT_SENDABLE')
      const retired = await registry.retireConversation({
        accountId: account, conversationKey: active.conversationKey, expectedRouteVersion: active.routeVersion,
        sourceEvidenceKey: 'retire-snapshot', actor: 'stage2g', reason: 'retirement gate',
        retiredAt: new Date('2026-07-26T20:12:00.000Z'), evidence: { approved: true },
      })
      assert.equal(retired.state, 'retired')
      await rejectedCode(registry.getSendableRouteSnapshot(account, active.conversationKey), 'ROUTE_NOT_SENDABLE')
    })

    test('S2-35..43 routeVersion changes only for semantic mutations and stale or failed writers cannot bump it', async () => {
      const account = runId('s2_version')
      const first = await registry.observeRouteEvidence(routeInput(account, 'version-first', [
        { kind: 'provider_user_id', value: 'version-user' },
      ]))
      assert.equal(first.routeVersion, 1)
      const repeated = await registry.observeRouteEvidence(routeInput(account, 'version-first', [
        { kind: 'provider_user_id', value: 'version-user' },
      ]))
      assert.equal(repeated.routeVersion, 1)
      const attached = await registry.observeRouteEvidence(routeInput(account, 'version-protocol', [
        { kind: 'protocol_chat_id', value: 'version-chat' },
      ], { candidateConversationKey: first.conversationKey }))
      assert.equal(attached.routeVersion, 2)
      await rejectedCode(registry.supersedeIdentity({
        accountId: account, conversationKey: first.conversationKey, identityKind: 'protocol_chat_id',
        oldIdentityValue: 'version-chat', newIdentityValue: 'version-new-chat', sourceEvidenceKey: 'version-stale',
        expectedRouteVersion: 1, actor: 'stage2g', reason: 'stale gate', observedAt: new Date(), evidence: {},
      }), 'STALE_ROUTE_VERSION')
      assert.equal((await registry.getRouteSnapshot(account, first.conversationKey))?.routeVersion, 2)
    })

    test('S2-44..50 supersede is account-scoped, atomic, audited and stale-safe', async () => {
      const account = runId('s2_supersede')
      const created = await registry.observeRouteEvidence(routeInput(account, 'supersede-create', [
        { kind: 'protocol_chat_id', value: 'supersede-old' },
      ]))
      const superseded = await registry.supersedeIdentity({
        accountId: account, conversationKey: created.conversationKey, identityKind: 'protocol_chat_id',
        oldIdentityValue: 'supersede-old', newIdentityValue: 'supersede-new', sourceEvidenceKey: 'supersede-success',
        expectedRouteVersion: created.routeVersion, actor: 'stage2g', reason: 'provider route drift',
        observedAt: new Date('2026-07-26T20:13:00.000Z'), evidence: { ticket: 'approved' },
      })
      assert.equal(superseded.routeVersion, created.routeVersion + 1)
      assert.equal(superseded.activeProtocolChatId, 'supersede-new')
      assert.equal(superseded.identities.find(item => item.value === 'supersede-old')?.status, 'superseded')
      await rejectedCode(registry.supersedeIdentity({
        accountId: `${account}_other`, conversationKey: created.conversationKey, identityKind: 'protocol_chat_id',
        oldIdentityValue: 'supersede-new', newIdentityValue: 'cross-account', sourceEvidenceKey: 'cross-account',
        expectedRouteVersion: superseded.routeVersion, actor: 'stage2g', reason: 'must reject',
        observedAt: new Date(), evidence: {},
      }), 'NOT_FOUND')

      const collisionBinding = await client.maxRouteIdentityBinding.findFirstOrThrow({ where: { accountId: account } })
      const rollbackObservationId = runId('supersede_rollback_observation')
      const generated = [rollbackObservationId, collisionBinding.id]
      const rollbackRegistry = new PrismaRouteRegistry(client as any, { idGenerator: () => generated.shift()! })
      const beforeSnapshot = await registry.getRouteSnapshot(account, created.conversationKey)
      await rejectedCode(rollbackRegistry.supersedeIdentity({
        accountId: account, conversationKey: created.conversationKey, identityKind: 'protocol_chat_id',
        oldIdentityValue: 'supersede-new', newIdentityValue: 'supersede-rollback-new', sourceEvidenceKey: 'rollback-failure',
        expectedRouteVersion: superseded.routeVersion, actor: 'stage2g', reason: 'rollback proof',
        observedAt: new Date(), evidence: {},
      }), 'DATABASE_FAILURE')
      assert.equal(await client.maxRouteObservation.count({ where: { routeObservationId: rollbackObservationId } }), 0)
      assert.deepEqual(await registry.getRouteSnapshot(account, created.conversationKey), beforeSnapshot)
    })

    test('S2-51..60 conflict resolution validates all versions, preserves audit and has one durable outcome', async () => {
      const account = runId('s2_resolution')
      const incumbent = await registry.observeRouteEvidence(routeInput(account, 'resolve-incumbent', [
        { kind: 'protocol_chat_id', value: 'resolve-incumbent-chat' },
      ]))
      const candidate = await registry.observeRouteEvidence(routeInput(account, 'resolve-candidate', [
        { kind: 'protocol_chat_id', value: 'resolve-candidate-chat' },
      ]))
      const conflictResult = await registry.observeRouteEvidence(routeInput(account, 'resolve-conflict', [
        { kind: 'protocol_chat_id', value: 'resolve-incumbent-chat' },
      ], { candidateConversationKey: candidate.conversationKey }))
      const conflict = (await registry.listOpenConflicts(account, undefined, 10)).conflicts[0]
      assert.equal(conflict.conflictId, conflictResult.conflictId)
      const incumbentSnapshot = (await registry.getRouteSnapshot(account, incumbent.conversationKey))!
      const candidateSnapshot = (await registry.getRouteSnapshot(account, candidate.conversationKey))!
      await rejectedCode(registry.resolveConflict({
        accountId: account, conflictId: conflict.conflictId, decision: 'keep_incumbent',
        expectedConflictVersion: conflict.version + 1,
        expectedIncumbentRouteVersion: incumbentSnapshot.routeVersion,
        expectedCandidateRouteVersion: candidateSnapshot.routeVersion,
        actor: 'stage2g', reason: 'wrong version', resolvedAt: new Date(), auditMetadata: {},
      }), 'STALE_CONFLICT_VERSION')
      const resolved = await registry.resolveConflict({
        accountId: account, conflictId: conflict.conflictId, decision: 'keep_incumbent',
        expectedConflictVersion: conflict.version,
        expectedIncumbentRouteVersion: incumbentSnapshot.routeVersion,
        expectedCandidateRouteVersion: candidateSnapshot.routeVersion,
        actor: 'stage2g-reviewer', reason: 'candidate evidence proven false',
        resolvedAt: new Date('2026-07-26T20:14:00.000Z'), auditMetadata: { ticket: 'route-1' },
      })
      assert.equal(resolved.status, 'resolved')
      assert.equal(resolved.resolvedBy, 'stage2g-reviewer')
      assert.equal((resolved.auditMetadata as any).decision, 'keep_incumbent')
      await rejectedCode(registry.resolveConflict({
        accountId: account, conflictId: conflict.conflictId, decision: 'keep_incumbent',
        expectedConflictVersion: resolved.version,
        expectedIncumbentRouteVersion: incumbentSnapshot.routeVersion + 1,
        expectedCandidateRouteVersion: candidateSnapshot.routeVersion + 1,
        actor: 'stage2g-reviewer', reason: 'repeat', resolvedAt: new Date(), auditMetadata: {},
      }), 'OPEN_CONFLICT')
      assert.equal((await registry.getRouteSnapshot(account, incumbent.conversationKey))?.state, 'active')
      assert.equal((await registry.getRouteSnapshot(account, candidate.conversationKey))?.state, 'active')
    })

    test('S2-56 dismissal does not make an underlying unresolved route sendable', async () => {
      const account = runId('s2_dismiss')
      const incumbent = await registry.observeRouteEvidence(routeInput(account, 'dismiss-incumbent', [
        { kind: 'protocol_chat_id', value: 'dismiss-chat' },
      ]))
      const candidate = await registry.observeRouteEvidence(routeInput(account, 'dismiss-candidate', [
        { kind: 'web_route_id', value: 'dismiss-web-only' },
      ], { evidenceAuthority: 'web_route_observed' }))
      await registry.observeRouteEvidence(routeInput(account, 'dismiss-conflict', [
        { kind: 'protocol_chat_id', value: 'dismiss-chat' },
      ], { candidateConversationKey: candidate.conversationKey }))
      const conflict = (await registry.listOpenConflicts(account, undefined, 10)).conflicts[0]
      const incumbentSnapshot = (await registry.getRouteSnapshot(account, incumbent.conversationKey))!
      const candidateSnapshot = (await registry.getRouteSnapshot(account, candidate.conversationKey))!
      const dismissed = await registry.resolveConflict({
        accountId: account, conflictId: conflict.conflictId, decision: 'dismiss',
        expectedConflictVersion: conflict.version,
        expectedIncumbentRouteVersion: incumbentSnapshot.routeVersion,
        expectedCandidateRouteVersion: candidateSnapshot.routeVersion,
        actor: 'stage2g-reviewer', reason: 'candidate capture proven malformed',
        resolvedAt: new Date(), auditMetadata: { proof: 'forensic-review' },
      })
      assert.equal(dismissed.status, 'dismissed')
      await rejectedCode(registry.getSendableRouteSnapshot(account, candidate.conversationKey), 'ROUTE_NOT_SENDABLE')
    })

    test('S2-61..65 weak evidence stays provisional, cannot override exact, and exact promotion is ambiguity-safe', async () => {
      const account = runId('s2_provisional')
      const provisional = await registry.observeRouteEvidence(routeInput(account, 'weak-provisional', [
        { kind: 'protocol_chat_id', value: 'provisional-chat' },
      ], { evidenceAuthority: 'web_route_observed' }))
      assert.equal(provisional.state, 'unresolved')
      await rejectedCode(registry.getSendableRouteSnapshot(account, provisional.conversationKey), 'ROUTE_NOT_SENDABLE')
      const promoted = await registry.observeRouteEvidence(routeInput(account, 'exact-promotion', [
        { kind: 'protocol_chat_id', value: 'provisional-chat' },
      ]))
      assert.equal(promoted.conversationKey, provisional.conversationKey)
      assert.equal(promoted.state, 'active')
      assert.equal(promoted.routeVersion, provisional.routeVersion + 1)

      const exact = await registry.observeRouteEvidence(routeInput(account, 'exact-other', [
        { kind: 'protocol_chat_id', value: 'exact-other-chat' },
      ]))
      const weak = await registry.observeRouteEvidence(routeInput(account, 'legacy-cannot-override', [
        { kind: 'protocol_chat_id', value: 'provisional-chat' },
      ], { evidenceAuthority: 'legacy_import', candidateConversationKey: exact.conversationKey }))
      assert.equal(weak.conversationKey, provisional.conversationKey)
      assert.equal(weak.semanticChange, false)
      assert.equal((await registry.getRouteSnapshot(account, exact.conversationKey))?.activeProtocolChatId, 'exact-other-chat')

      const ambiguity = await registry.observeRouteEvidence(routeInput(account, 'exact-ambiguity', [
        { kind: 'protocol_chat_id', value: 'provisional-chat' },
      ], { candidateConversationKey: exact.conversationKey }))
      assert.equal(ambiguity.state, 'conflicted')
      assert.ok(ambiguity.conflictId)
    })

    test('S2 failed transaction rolls back observation, binding, conversation and routeVersion', async () => {
      const account = runId('s2_rollback')
      const collision = await client.maxRouteIdentityBinding.findFirstOrThrow({})
      let call = 0
      const failing = new PrismaRouteRegistry(client as any, {
        conversationKeyGenerator: () => `rollback-conversation-${call}`,
        idGenerator: () => {
          call += 1
          return call % 3 === 0 ? collision.id : `rollback-id-${call}-${Date.now()}`
        },
      })
      await assert.rejects(failing.observeRouteEvidence(routeInput(account, 'rollback-route', [
        { kind: 'protocol_chat_id', value: 'rollback-route-chat' },
      ])), error => ['DATABASE_FAILURE', 'INVALID_INPUT'].includes(errorCode(error) ?? ''))
      assert.equal(await client.maxRouteConversation.count({ where: { accountId: account } }), 0)
      assert.equal(await client.maxRouteObservation.count({ where: { accountId: account } }), 0)
      assert.equal(await client.maxRouteIdentityBinding.count({ where: { accountId: account } }), 0)
    })
  })
}
