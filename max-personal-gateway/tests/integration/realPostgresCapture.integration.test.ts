import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { CaptureDrainWorker } from '../../src/capture/CaptureDrainWorker.ts'
import { CaptureEnvelopeFactory } from '../../src/capture/CaptureEnvelopeFactory.ts'
import { PrismaRawCaptureIngress } from '../../src/capture/PrismaRawCaptureIngress.ts'
import { SegmentedFileCaptureSpool } from '../../src/capture/SegmentedFileCaptureSpool.ts'
import type { RawCaptureIngress } from '../../src/capture/types.ts'
import { MAX_SHADOW_COMPARISON_VERSION } from '../../src/comparison/constants.ts'
import { PrismaShadowSemanticComparisonHarness } from '../../src/comparison/PrismaShadowSemanticComparisonHarness.ts'
import { DefaultSemanticComparisonEngine } from '../../src/comparison/SemanticComparisonEngine.ts'
import { MAX_INBOUND_NORMALIZER_VERSION } from '../../src/inbound/constants.ts'
import { MaxInboundNormalizer } from '../../src/inbound/MaxInboundNormalizer.ts'
import { PrismaShadowInboundNormalizationProcessor } from '../../src/inbound/PrismaShadowInboundNormalizationProcessor.ts'
import { PrismaRawEventJournal } from '../../src/journal/PrismaRawEventJournal.ts'
import { createComparisonRun } from '../support/comparisonHarness.ts'
import {
  createRealPrismaClient,
  readRealPostgresConfig,
  runId,
  type RealPrismaClient,
} from '../support/realPostgres.ts'

const config = readRealPostgresConfig()
const require = createRequire(import.meta.url)
const repositoryRoot = resolve(import.meta.dirname, '../../..')

if (config === null) {
  test('real PostgreSQL Stage 8A gate requires PERSONAL_MAX_REAL_POSTGRES_URL', { skip: true }, () => {})
} else {
  describe('Stage 8A real PostgreSQL capture ingress and synthetic runtime', { concurrency: false }, () => {
    let client: RealPrismaClient
    const temporaryRoots: string[] = []

    before(async () => { client = await createRealPrismaClient(config) })
    after(async () => {
      await client.$disconnect()
      for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
    })

    const temporary = (name: string): string => {
      const value = mkdtempSync(join(tmpdir(), `max-stage8a-pg-${name}-`))
      temporaryRoots.push(value)
      return value
    }

    test('S8A-DB-01 retry identity is account-scoped under concurrency and physical duplicates remain distinct', async () => {
      const accountA = runId('s8a_ingress_a')
      const accountB = runId('s8a_ingress_b')
      const factory = new CaptureEnvelopeFactory()
      const first = factory.createEnvelope({
        accountId: accountA, sourceOrigin: 'live', socketGeneration: 'socket-1', sessionGeneration: 'session-1',
        providerEventId: 'provider-shared', transportSequence: '1', opcode: 128, payloadEncoding: 'json',
        payload: { kind: 'message', direction: 'inbound', providerMessageId: 'provider-shared', text: 'same' },
      })
      const physicalDuplicate = factory.createEnvelope({
        accountId: accountA, sourceOrigin: 'live', socketGeneration: 'socket-1', sessionGeneration: 'session-1',
        providerEventId: 'provider-shared', transportSequence: '1', opcode: 128, payloadEncoding: 'json',
        payload: { kind: 'message', direction: 'inbound', providerMessageId: 'provider-shared', text: 'same' },
      })
      const ingress = new PrismaRawCaptureIngress(client as any)
      const results = await Promise.all(Array.from({ length: 50 }, () => ingress.ingestEnvelope(first)))
      assert.equal(new Set(results.map(result => result.observationId)).size, 1)
      assert.equal(results.filter(result => result.created).length, 1)
      await ingress.ingestEnvelope(physicalDuplicate)
      await ingress.ingestEnvelope({ ...first, accountId: accountB })
      await assert.rejects(
        ingress.ingestEnvelope({ ...physicalDuplicate, captureEnvelopeId: first.captureEnvelopeId }),
        (error: unknown) => error !== null && typeof error === 'object'
          && Reflect.get(error, 'code') === 'CAPTURE_ENVELOPE_ID_COLLISION',
      )
      assert.equal(await client.maxRawTransportEvent.count({ where: { accountId: accountA } }), 2)
      assert.equal(await client.maxRawTransportEvent.count({ where: { accountId: accountB } }), 1)
      assert.equal(await client.maxRawTransportEvent.count({
        where: { accountId: { in: [accountA, accountB] }, payloadSha256: first.payloadSha256 },
      }), 3)
      assert.equal(await client.maxRawTransportProcessing.count({ where: { rawObservation: { accountId: { in: [accountA, accountB] } } } }), 3)
      assert.equal(ingress.getCaptureHealth().captureEnvelopeIdCollisionCount, 1)
    })

    test('S8A-DB-02 transaction rollback leaves no raw or processing orphan', async () => {
      const account = runId('s8a_rollback')
      const factory = new CaptureEnvelopeFactory()
      const envelope = factory.createEnvelope({
        accountId: account, sourceOrigin: 'live', socketGeneration: 'socket-1', sessionGeneration: 'session-1',
        payloadEncoding: 'json', payload: { kind: 'message', text: 'rollback' },
      })
      const seedIngress = new PrismaRawCaptureIngress(client as any)
      const seed = await seedIngress.ingestEnvelope({ ...envelope, captureEnvelopeId: `${envelope.captureEnvelopeId}-seed` })
      const processing = await client.maxRawTransportProcessing.findFirstOrThrow({ where: { observationId: seed.observationId } })
      const rolledBackObservationId = runId('s8a_rolled_back')
      const generated = [rolledBackObservationId, processing.id]
      const journal = new PrismaRawEventJournal(client as any, { idGenerator: () => generated.shift()! })
      await assert.rejects(journal.appendCapture({
        accountId: account,
        captureEnvelopeId: envelope.captureEnvelopeId,
        observedAt: new Date(envelope.observedAt),
        sourceTransport: envelope.sourceTransport,
        sourceOrigin: 'physical-frame',
        historyLive: envelope.sourceOrigin,
        socketGeneration: envelope.socketGeneration,
        payloadEncoding: envelope.payloadEncoding,
        sanitizedPayload: envelope.sanitizedPayload,
        payloadSha256: envelope.payloadSha256,
        payloadSizeBytes: envelope.payloadSizeBytes,
        replayAvailability: envelope.replayAvailability,
        sanitizerVersion: envelope.sanitizerVersion,
        captureAdapterVersion: envelope.captureAdapterVersion,
        schemaVersion: 1,
        redactionMetadata: envelope.redactionMetadata,
        quarantineEligible: true,
        parserVersion: MAX_INBOUND_NORMALIZER_VERSION,
      }))
      assert.equal(await client.maxRawTransportEvent.count({ where: { observationId: rolledBackObservationId } }), 0)
      assert.equal(await client.maxRawTransportProcessing.count({ where: { observationId: rolledBackObservationId } }), 0)
    })

    test('S8A-DB-03 actual hook, outage retention, 1000-frame burst, journal, normalization, and comparison are end-to-end', async () => {
      const account = runId('s8a_e2e')
      const spoolPath = temporary('e2e')
      const runtime = require(resolve(repositoryRoot, 'max-web-scraper/capture/LiveCaptureAdapter.js'))
      const { TransportInterceptor } = require(resolve(repositoryRoot, 'max-web-scraper/transport/TransportInterceptor.js'))
      const adapter = new runtime.LiveCaptureAdapter({ accountId: account, spoolPath, maxSpoolBytes: 128 * 1024 * 1024 })
      const transport = new TransportInterceptor(adapter)
      transport._processDecodedFrame = () => {}
      transport._handleFrame(JSON.stringify({ __diag: 'ws_created', url: 'wss://synthetic.invalid/one' }))
      transport._handleFrame(JSON.stringify({ opcode: 128, seq: 1, payload: {
        chatId: 'chat-live', message: { id: 'provider-live', sender: 'user-live', time: 1_785_171_600_000, text: 'live' },
      } }))
      transport._handleFrame(JSON.stringify({ opcode: 49, seq: 2, payload: {
        chatId: 'chat-history', message: { id: 'provider-history', sender: 'user-history', time: 1_785_171_500_000, text: 'history' },
      } }))
      const identical = JSON.stringify({ opcode: 128, seq: 3, payload: { kind: 'message', text: 'identical' } })
      transport._handleFrame(identical)
      transport._handleFrame(identical)
      transport._handleFrame(JSON.stringify({ __diag: 'ws_created', url: 'wss://synthetic.invalid/two' }))
      transport._handleFrame('{malformed')
      transport._handleFrame(JSON.stringify({ opcode: 250, seq: 4, payload: { future: true } }))
      for (let index = 0; index < 1000; index += 1) {
        transport._handleFrame(JSON.stringify({ opcode: 128, seq: index + 10, payload: {
          kind: 'message', direction: 'inbound', providerMessageId: `burst-${index}`, text: `burst-${index}`,
        } }))
      }

      const spool = new SegmentedFileCaptureSpool({ directory: spoolPath, maxTotalBytes: 128 * 1024 * 1024 })
      assert.equal(spool.readPending(2000).length, 1006)
      const unavailable: RawCaptureIngress = {
        async ingestEnvelope() { throw new Error('synthetic database outage') },
        getCaptureHealth: () => ({ ingressIdempotentRetryCount: 0, rejectedCount: 0, captureEnvelopeIdCollisionCount: 0 }),
      }
      const outageWorker = new CaptureDrainWorker(spool, unavailable, { batchSize: 100, maxConcurrency: 8, jitterRatio: 0 })
      const failed = await outageWorker.drainOnce()
      assert.equal(failed.acknowledged, 0)
      assert.equal(spool.readPending(2000).length, 1006)

      const ingress = new PrismaRawCaptureIngress(client as any)
      const worker = new CaptureDrainWorker(spool, ingress, { batchSize: 100, maxConcurrency: 8, jitterRatio: 0 })
      while (spool.readPending(1).length > 0) await worker.drainOnce()
      assert.equal(await client.maxRawTransportEvent.count({ where: { accountId: account } }), 1006)
      assert.equal(await client.maxRawTransportProcessing.count({ where: { rawObservation: { accountId: account } } }), 1006)
      assert.equal(await client.maxRawTransportEvent.count({ where: { accountId: account, historyLive: 'history' } }), 1)
      assert.equal(await client.maxRawTransportEvent.count({ where: { accountId: account, replayAvailability: 'quarantined' } }), 1)
      assert.equal(new Set((await client.maxRawTransportEvent.findMany({
        where: { accountId: account }, select: { captureEnvelopeId: true },
      })).map((row: any) => row.captureEnvelopeId)).size, 1006)

      const journal = new PrismaRawEventJournal(client as any)
      const first = (await journal.readAfter(account, 0n, 1)).observations[0]!
      const processor = new PrismaShadowInboundNormalizationProcessor(client as any, journal, new MaxInboundNormalizer())
      const normalized = await processor.normalizeObservation({
        accountId: account, observationId: first.observationId,
        parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'stage8a-synthetic-worker',
      })
      assert.equal(normalized.result.status, 'normalized')
      assert.equal(normalized.events.length >= 1, true)
      const comparison = new PrismaShadowSemanticComparisonHarness(client as any, new DefaultSemanticComparisonEngine())
      const comparisonRun = runId('s8a_comparison')
      await createComparisonRun(comparison, account, comparisonRun)
      const compared = await comparison.compareObservation({
        runId: comparisonRun, accountId: account,
        comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, observationId: first.observationId,
      })
      assert.equal(compared.result.sourceObservationId, first.observationId)
      assert.equal(await client.maxShadowComparisonResult.count({ where: { runId: comparisonRun } }), 1)
      assert.equal(spool.getCaptureHealth().lostBeforeSpoolCount, 0)
    })

    test('S8A-DB-04 retry storm, A/B isolation, and new Prisma client preserve exact counts', async () => {
      const accountA = runId('s8a_load_a')
      const accountB = runId('s8a_load_b')
      const factory = new CaptureEnvelopeFactory()
      let ingress = new PrismaRawCaptureIngress(client as any)
      const retryValues = Array.from({ length: 100 }, (_, index) => factory.createEnvelope({
        accountId: accountA, sourceOrigin: 'live', socketGeneration: 'socket-1', sessionGeneration: 'session-1',
        transportSequence: String(index), payloadEncoding: 'json', payload: { kind: 'message', text: 'same' },
      }))
      for (const value of retryValues) for (let attempt = 0; attempt < 25; attempt += 1) await ingress.ingestEnvelope(value)
      assert.equal(await client.maxRawTransportEvent.count({ where: { accountId: accountA } }), 100)
      assert.equal(ingress.getCaptureHealth().ingressIdempotentRetryCount, 2400)

      const interleaved = Array.from({ length: 500 }, (_, index) => [
        factory.createEnvelope({ accountId: accountA, sourceOrigin: 'live', socketGeneration: 'socket-2', sessionGeneration: 'session-1', transportSequence: String(index), payloadEncoding: 'json', payload: { kind: 'message', text: `a-${index}` } }),
        factory.createEnvelope({ accountId: accountB, sourceOrigin: 'live', socketGeneration: 'socket-1', sessionGeneration: 'session-2', transportSequence: String(index), payloadEncoding: 'json', payload: { kind: 'message', text: `b-${index}` } }),
      ]).flat()
      for (let offset = 0; offset < interleaved.length; offset += 20) {
        await Promise.all(interleaved.slice(offset, offset + 20).map(value => ingress.ingestEnvelope(value)))
      }
      assert.equal(await client.maxRawTransportEvent.count({ where: { accountId: accountA } }), 600)
      assert.equal(await client.maxRawTransportEvent.count({ where: { accountId: accountB } }), 500)

      await client.$disconnect()
      client = await createRealPrismaClient(config)
      ingress = new PrismaRawCaptureIngress(client as any)
      const resumed = await ingress.ingestEnvelope(retryValues[0]!)
      assert.equal(resumed.created, false)
      assert.equal(await client.maxRawTransportEvent.count({ where: { accountId: accountA } }), 600)
    })
  })
}
