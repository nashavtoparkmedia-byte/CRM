import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { PrismaRawEventJournal } from '../../src/journal/PrismaRawEventJournal.ts'
import { PrismaRouteRegistry } from '../../src/route/PrismaRouteRegistry.ts'
import {
  createRealPrismaClient,
  errorCode,
  readRealPostgresConfig,
  runId,
  type RealPrismaClient,
} from '../support/realPostgres.ts'

const config = readRealPostgresConfig()

function rawInput(accountId: string, marker: string) {
  return {
    accountId,
    observedAt: new Date('2026-07-26T20:20:00.000Z'),
    sourceTransport: 'websocket_frame', sourceOrigin: 'stage2g-concurrency', historyLive: 'live' as const,
    providerEventId: marker, payloadEncoding: 'json' as const, sanitizedPayload: { marker },
    payloadSha256: 'e'.repeat(64), payloadSizeBytes: marker.length, replayAvailability: 'available' as const,
    sanitizerVersion: 'stage2g-v1', captureAdapterVersion: 'stage2g-v1', schemaVersion: 1,
    redactionMetadata: { sanitizerVersion: 'stage2g-v1', categories: [], paths: [] },
    quarantineEligible: true, parserVersion: 'concurrency-parser-v1',
  }
}

function routeInput(accountId: string, sourceEvidenceKey: string, protocolChatId: string, candidateConversationKey?: string) {
  return {
    accountId, sourceEvidenceKey, extractorVersion: 'stage2g-concurrency-v1',
    observedAt: new Date('2026-07-26T20:20:00.000Z'), evidenceSource: 'stage2g-concurrency',
    evidenceAuthority: 'protocol_exact' as const,
    identities: [{ kind: 'protocol_chat_id' as const, value: protocolChatId }],
    evidence: { sourceEvidenceKey }, candidateConversationKey,
  }
}

function counts(results: readonly PromiseSettledResult<unknown>[]) {
  const codes = results.filter(result => result.status === 'rejected').map(result => errorCode(result.reason) ?? 'UNCLASSIFIED')
  return {
    attempts: results.length,
    successes: results.filter(result => result.status === 'fulfilled').length,
    classified: codes.filter(code => code !== 'DATABASE_FAILURE' && code !== 'UNCLASSIFIED').length,
    databaseFailures: codes.filter(code => code === 'DATABASE_FAILURE').length,
    unclassified: codes.filter(code => code === 'UNCLASSIFIED').length,
    codes,
  }
}

if (config === null) {
  test('real PostgreSQL concurrency gate requires PERSONAL_MAX_REAL_POSTGRES_URL', { skip: true }, () => {})
} else {
  describe('Stage 1 + Stage 2 real PostgreSQL concurrency', { concurrency: false }, () => {
    let client: RealPrismaClient
    let journal: PrismaRawEventJournal
    let registry: PrismaRouteRegistry

    before(async () => {
      client = await createRealPrismaClient(config)
      journal = new PrismaRawEventJournal(client as any)
      registry = new PrismaRouteRegistry(client as any)
    })

    after(async () => {
      await client.$disconnect()
    })

    test('25 concurrent identical journal appends preserve all physical observations', async () => {
      const account = runId('conc_append')
      const results = await Promise.allSettled(Array.from({ length: 25 }, () => journal.append(rawInput(account, 'identical'))))
      const summary = counts(results)
      assert.deepEqual(summary, { attempts: 25, successes: 25, classified: 0, databaseFailures: 0, unclassified: 0, codes: [] })
      const rows = await client.maxRawTransportEvent.findMany({ where: { accountId: account } })
      assert.equal(rows.length, 25)
      assert.equal(new Set(rows.map((row: any) => row.observationId)).size, 25)
      assert.equal(new Set(rows.map((row: any) => row.journalSequence.toString())).size, 25)
      assert.equal(await client.maxRawTransportProcessing.count({ where: { rawObservation: { accountId: account } } }), 25)
      console.log('STAGE2G_CONCURRENCY journal_append', JSON.stringify(summary))
    })

    test('25 concurrent processing claims have exactly one lease winner', async () => {
      const account = runId('conc_claim')
      const observationId = await journal.append(rawInput(account, 'claim'))
      const now = new Date('2026-07-26T20:21:00.000Z')
      const results = await Promise.allSettled(Array.from({ length: 25 }, (_, index) => journal.claimProcessing({
        accountId: account, observationId, parserVersion: 'concurrency-parser-v1', workerId: `worker-${index}`, now,
        leaseUntil: new Date(now.getTime() + 60_000),
      })))
      const summary = counts(results)
      assert.equal(summary.successes, 1)
      assert.equal(summary.classified, 24)
      assert.equal(summary.databaseFailures, 0)
      assert.equal(summary.unclassified, 0)
      assert.equal(summary.codes.every(code => code === 'CLAIM_CONFLICT'), true)
      const state = await journal.getProcessingState(account, observationId, 'concurrency-parser-v1')
      assert.equal(state?.state, 'processing')
      assert.equal(state?.leaseVersion, 1)
      console.log('STAGE2G_CONCURRENCY processing_claim', JSON.stringify(summary))
    })

    test('25 concurrent cursor advances classify stale writers and converge without regression', async () => {
      const account = runId('conc_cursor')
      const first = await journal.advanceCursor({
        consumerId: 'concurrent-consumer', accountId: account, parserVersion: 'concurrency-parser-v1',
        lastJournalSequence: 1n, expectedVersion: 0,
      })
      const results = await Promise.allSettled(Array.from({ length: 25 }, (_, index) => journal.advanceCursor({
        consumerId: 'concurrent-consumer', accountId: account, parserVersion: 'concurrency-parser-v1',
        lastJournalSequence: BigInt(100 + index), expectedVersion: first.version,
      })))
      const summary = counts(results)
      assert.equal(summary.successes, 1)
      assert.equal(summary.classified, 24)
      assert.equal(summary.databaseFailures, 0)
      assert.equal(summary.unclassified, 0)
      assert.equal(summary.codes.every(code => code === 'CURSOR_CONFLICT'), true)
      let current = (await journal.getCursor('concurrent-consumer', account, 'concurrency-parser-v1'))!
      if (current.lastJournalSequence < 124n) {
        current = await journal.advanceCursor({
          consumerId: 'concurrent-consumer', accountId: account, parserVersion: 'concurrency-parser-v1',
          lastJournalSequence: 124n, expectedVersion: current.version,
        })
      }
      assert.equal(current.lastJournalSequence, 124n)
      console.log('STAGE2G_CONCURRENCY cursor_advance', JSON.stringify({ ...summary, final: '124' }))
    })

    test('25 concurrent identical exact route observations converge to one semantic route', async () => {
      const account = runId('conc_route_new')
      const input = routeInput(account, 'identical-new-route', 'concurrent-new-chat')
      const results = await Promise.allSettled(Array.from({ length: 25 }, () => registry.observeRouteEvidence(input)))
      const summary = counts(results)
      assert.equal(summary.successes, 25)
      assert.equal(summary.databaseFailures, 0)
      assert.equal(summary.unclassified, 0)
      const fulfilled = results.filter(result => result.status === 'fulfilled').map(result => result.value)
      assert.equal(new Set(fulfilled.map(result => result.conversationKey)).size, 1)
      assert.equal(fulfilled.filter(result => !result.idempotent).length, 1)
      assert.equal(await client.maxRouteConversation.count({ where: { accountId: account } }), 1)
      assert.equal(await client.maxRouteIdentityBinding.count({ where: { accountId: account } }), 1)
      assert.equal(await client.maxRouteObservation.count({ where: { accountId: account } }), 1)
      console.log('STAGE2G_CONCURRENCY new_route', JSON.stringify(summary))
    })

    test('25 concurrent distinct conflicting observations yield one open conflict and 25 evidence rows', async () => {
      const account = runId('conc_route_conflict')
      const incumbent = await registry.observeRouteEvidence(routeInput(account, 'incumbent', 'concurrent-incumbent-chat'))
      const candidate = await registry.observeRouteEvidence(routeInput(account, 'candidate', 'concurrent-candidate-chat'))
      const results = await Promise.allSettled(Array.from({ length: 25 }, (_, index) => registry.observeRouteEvidence(
        routeInput(account, `conflict-${index}`, 'concurrent-incumbent-chat', candidate.conversationKey),
      )))
      const summary = counts(results)
      assert.equal(summary.successes, 25)
      assert.equal(summary.databaseFailures, 0)
      assert.equal(summary.unclassified, 0)
      assert.equal(await client.maxRouteConflict.count({ where: { accountId: account, status: 'open' } }), 1)
      assert.equal(await client.maxRouteObservation.count({ where: { accountId: account, processingResult: 'conflict' } }), 25)
      const incumbentSnapshot = (await registry.getRouteSnapshot(account, incumbent.conversationKey))!
      const candidateSnapshot = (await registry.getRouteSnapshot(account, candidate.conversationKey))!
      assert.equal(incumbentSnapshot.state, 'conflicted')
      assert.equal(candidateSnapshot.state, 'conflicted')
      assert.equal(incumbentSnapshot.routeVersion, 2)
      assert.equal(candidateSnapshot.routeVersion, 2)
      console.log('STAGE2G_CONCURRENCY conflicting_route', JSON.stringify(summary))
    })

    test('10 concurrent supersede attempts have one winner and preserve one active identity', async () => {
      const account = runId('conc_supersede')
      const created = await registry.observeRouteEvidence(routeInput(account, 'supersede-create', 'concurrent-old-chat'))
      const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => registry.supersedeIdentity({
        accountId: account, conversationKey: created.conversationKey, identityKind: 'protocol_chat_id',
        oldIdentityValue: 'concurrent-old-chat', newIdentityValue: 'concurrent-new-chat',
        sourceEvidenceKey: `supersede-${index}`, expectedRouteVersion: created.routeVersion,
        actor: 'stage2g', reason: 'concurrency supersede', observedAt: new Date(), evidence: { index },
      })))
      const summary = counts(results)
      assert.equal(summary.successes, 1)
      assert.equal(summary.classified, 9)
      assert.equal(summary.databaseFailures, 0)
      assert.equal(summary.unclassified, 0)
      const active = await client.maxRouteIdentityBinding.findMany({
        where: { accountId: account, conversationKey: created.conversationKey, identityKind: 'protocol_chat_id', status: 'active' },
      })
      assert.equal(active.length, 1)
      assert.equal(active[0].identityValue, 'concurrent-new-chat')
      assert.equal((await registry.getRouteSnapshot(account, created.conversationKey))?.routeVersion, 2)
      console.log('STAGE2G_CONCURRENCY supersede', JSON.stringify(summary))
    })

    test('10 concurrent conflict resolutions have one winner and no partial outcome', async () => {
      const account = runId('conc_resolution')
      const incumbent = await registry.observeRouteEvidence(routeInput(account, 'incumbent', 'resolution-incumbent-chat'))
      const candidate = await registry.observeRouteEvidence(routeInput(account, 'candidate', 'resolution-candidate-chat'))
      await registry.observeRouteEvidence(routeInput(account, 'conflict', 'resolution-incumbent-chat', candidate.conversationKey))
      const conflict = (await registry.listOpenConflicts(account, undefined, 10)).conflicts[0]
      const incumbentSnapshot = (await registry.getRouteSnapshot(account, incumbent.conversationKey))!
      const candidateSnapshot = (await registry.getRouteSnapshot(account, candidate.conversationKey))!
      const input = {
        accountId: account, conflictId: conflict.conflictId, decision: 'keep_incumbent' as const,
        expectedConflictVersion: conflict.version,
        expectedIncumbentRouteVersion: incumbentSnapshot.routeVersion,
        expectedCandidateRouteVersion: candidateSnapshot.routeVersion,
        actor: 'stage2g', reason: 'concurrency resolution', resolvedAt: new Date(), auditMetadata: { approved: true },
      }
      const results = await Promise.allSettled(Array.from({ length: 10 }, () => registry.resolveConflict(input)))
      const summary = counts(results)
      assert.equal(summary.successes, 1)
      assert.equal(summary.classified, 9)
      assert.equal(summary.databaseFailures, 0)
      assert.equal(summary.unclassified, 0)
      assert.equal(await client.maxRouteConflict.count({ where: { accountId: account, status: 'resolved' } }), 1)
      assert.equal(await client.maxRouteConflict.count({ where: { accountId: account, status: 'open' } }), 0)
      assert.equal((await registry.getRouteSnapshot(account, incumbent.conversationKey))?.state, 'active')
      assert.equal((await registry.getRouteSnapshot(account, candidate.conversationKey))?.state, 'active')
      console.log('STAGE2G_CONCURRENCY resolution', JSON.stringify(summary))
    })
  })
}
