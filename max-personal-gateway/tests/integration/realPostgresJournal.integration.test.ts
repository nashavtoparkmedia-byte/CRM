import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { JournalError } from '../../src/journal/errors.ts'
import { PrismaRawEventJournal } from '../../src/journal/PrismaRawEventJournal.ts'
import { sanitizeRawObservationPayload } from '../../src/journal/sanitizer.ts'
import type { SanitizedObservationInput } from '../../src/journal/types.ts'
import {
  createRealPrismaClient,
  errorCode,
  readRealPostgresConfig,
  rejectedCode,
  runId,
  type RealPrismaClient,
} from '../support/realPostgres.ts'

const config = readRealPostgresConfig()

function observation(accountId: string, overrides: Partial<SanitizedObservationInput> = {}): SanitizedObservationInput {
  return {
    accountId,
    observedAt: new Date('2026-07-26T20:00:00.000Z'),
    sourceTransport: 'websocket_frame',
    sourceOrigin: 'stage2g-real-postgres',
    historyLive: 'live',
    providerEventId: 'provider-same',
    payloadEncoding: 'json',
    sanitizedPayload: { kind: 'message', body: 'same-payload' },
    payloadSha256: 'a'.repeat(64),
    payloadSizeBytes: 40,
    replayAvailability: 'available',
    sanitizerVersion: 'stage2g-sanitizer-v1',
    captureAdapterVersion: 'stage2g-capture-v1',
    schemaVersion: 1,
    redactionMetadata: { sanitizerVersion: 'stage2g-sanitizer-v1', categories: [], paths: [] },
    quarantineEligible: true,
    parserVersion: 'parser-a',
    ...overrides,
  }
}

if (config === null) {
  test('real PostgreSQL journal gate requires PERSONAL_MAX_REAL_POSTGRES_URL', { skip: true }, () => {})
} else {
  describe('Stage 1 real PostgreSQL journal semantics', { concurrency: false }, () => {
    let client: RealPrismaClient
    let journal: PrismaRawEventJournal
    const account = runId('s1_account')

    before(async () => {
      client = await createRealPrismaClient(config)
      journal = new PrismaRawEventJournal(client as any)
    })

    after(async () => {
      await client.$disconnect()
    })

    test('S1-01..08 append is transactional, physical, ordered, non-deduplicating and account-scoped', async () => {
      const ids = await Promise.all([
        journal.append(observation(account)),
        journal.append(observation(account)),
        journal.append(observation(account, { historyLive: 'history' })),
        journal.append(observation(`${account}_b`)),
      ])
      assert.equal(new Set(ids).size, 4)
      const rows = await client.maxRawTransportEvent.findMany({
        where: { observationId: { in: ids } },
        orderBy: { journalSequence: 'asc' },
        include: { processingStates: true },
      })
      assert.equal(rows.length, 4)
      assert.equal(rows.every((row: any) => typeof row.journalSequence === 'bigint'), true)
      assert.equal(rows.every((row: any, index: number) => index === 0 || row.journalSequence > rows[index - 1].journalSequence), true)
      assert.equal(rows.every((row: any) => row.processingStates.length === 1), true)
      assert.equal(rows.filter((row: any) => row.providerEventId === 'provider-same').length, 4)
      assert.equal(rows.filter((row: any) => row.payloadSha256 === 'a'.repeat(64)).length, 4)
      assert.equal(rows.filter((row: any) => row.accountId === account).length, 3)
      assert.deepEqual(new Set(rows.map((row: any) => row.historyLive)), new Set(['history', 'live']))
    })

    test('S1-09..12 processing insert failure rolls back raw insert and leaves no orphan', async () => {
      const seedId = await journal.append(observation(account, { providerEventId: 'rollback-seed' }))
      const seedProcessing = await client.maxRawTransportProcessing.findFirstOrThrow({ where: { observationId: seedId } })
      const rolledBackObservationId = runId('rolled_back_raw')
      const generated = [rolledBackObservationId, seedProcessing.id]
      const failing = new PrismaRawEventJournal(client as any, { idGenerator: () => generated.shift()! })
      await rejectedCode(failing.append(observation(account, { providerEventId: 'must-rollback' })), 'DATABASE_FAILURE')
      assert.equal(await client.maxRawTransportEvent.count({ where: { observationId: rolledBackObservationId } }), 0)
      assert.equal(await client.maxRawTransportProcessing.count({ where: { observationId: rolledBackObservationId } }), 0)

      const invalidRawId = runId('invalid_raw')
      await assert.rejects(client.$executeRawUnsafe(`
        INSERT INTO "MaxRawTransportEvent" (
          "observationId", "accountId", "observedAt", "sourceTransport", "sourceOrigin", "historyLive",
          "payloadEncoding", "sanitizedPayload", "payloadSha256", "payloadSizeBytes", "replayAvailability",
          "quarantineReason", "sanitizerVersion", "captureAdapterVersion", "schemaVersion",
          "redactionMetadata", "quarantineEligible"
        ) VALUES ($1, $2, now(), 'ws', 'gate', 'live', 'json', '{}'::jsonb, $3, 1,
          'available', 'invalid-combination', 'v1', 'v1', 1, '{}'::jsonb, true)
      `, invalidRawId, account, 'b'.repeat(64)))
      assert.equal(await client.maxRawTransportEvent.count({ where: { observationId: invalidRawId } }), 0)
    })

    test('S1-13..18 raw evidence is unconditionally append-only while projections remain mutable', async () => {
      const id = await journal.append(observation(account, { providerEventId: 'append-only' }))
      await assert.rejects(client.$executeRawUnsafe(
        `UPDATE "MaxRawTransportEvent" SET "eventType" = 'mutated' WHERE "observationId" = $1`, id,
      ))
      await assert.rejects(client.$executeRawUnsafe(
        `DELETE FROM "MaxRawTransportEvent" WHERE "observationId" = $1`, id,
      ))
      await assert.rejects(client.$transaction(async transaction => {
        await transaction.$executeRawUnsafe(`SET LOCAL max_personal.allow_raw_retention = 'on'`)
        await transaction.$executeRawUnsafe(`DELETE FROM "MaxRawTransportEvent" WHERE "observationId" = $1`, id)
      }))
      await assert.rejects(client.$transaction(async transaction => {
        await transaction.$executeRawUnsafe(`SET LOCAL stage2g.any_caller_guc = 'on'`)
        await transaction.$executeRawUnsafe(`DELETE FROM "MaxRawTransportEvent" WHERE "observationId" = $1`, id)
      }))

      const now = new Date('2026-07-26T20:01:00.000Z')
      const claimed = await journal.claimProcessing({
        accountId: account,
        observationId: id,
        parserVersion: 'parser-a',
        workerId: 'projection-worker',
        now,
        leaseUntil: new Date(now.getTime() + 60_000),
      })
      const completed = await journal.markProcessingState({
        accountId: account,
        observationId: id,
        parserVersion: 'parser-a',
        workerId: 'projection-worker',
        expectedLeaseVersion: claimed.leaseVersion,
        state: 'completed',
        completedAt: new Date(now.getTime() + 1_000),
      })
      assert.equal(completed.state, 'completed')
      const cursor = await journal.advanceCursor({
        consumerId: 'projection-consumer', accountId: account, parserVersion: 'parser-a',
        lastJournalSequence: 1n, expectedVersion: 0,
      })
      assert.equal(cursor.version, 1)
    })

    test('S1-19..24 PostgreSQL rejects invalid state, versions, quarantine, payload and journal positions', async () => {
      const id = await journal.append(observation(account, { providerEventId: 'constraints' }))
      const processing = await client.maxRawTransportProcessing.findFirstOrThrow({ where: { observationId: id } })
      await assert.rejects(client.$executeRawUnsafe(
        `UPDATE "MaxRawTransportProcessing" SET "state" = 'impossible' WHERE "id" = $1`, processing.id,
      ))
      await assert.rejects(client.$executeRawUnsafe(
        `UPDATE "MaxRawTransportProcessing" SET "leaseVersion" = -1 WHERE "id" = $1`, processing.id,
      ))
      const invalidSizeId = runId('invalid_size')
      await assert.rejects(client.$executeRawUnsafe(`
        INSERT INTO "MaxRawTransportEvent" (
          "observationId", "accountId", "observedAt", "sourceTransport", "sourceOrigin", "historyLive",
          "payloadEncoding", "sanitizedPayload", "payloadSha256", "payloadSizeBytes", "replayAvailability",
          "sanitizerVersion", "captureAdapterVersion", "schemaVersion", "redactionMetadata", "quarantineEligible"
        ) VALUES ($1, $2, now(), 'ws', 'gate', 'live', 'json', '{}'::jsonb, $3, -1,
          'available', 'v1', 'v1', 1, '{}'::jsonb, true)
      `, invalidSizeId, account, 'c'.repeat(64)))
      await assert.rejects(client.$executeRawUnsafe(`
        INSERT INTO "MaxRawTransportCursor" (
          "id", "consumerId", "accountId", "parserVersion", "lastJournalSequence", "version", "updatedAt"
        ) VALUES ($1, 'invalid', $2, 'parser-a', -1, 0, now())
      `, runId('invalid_cursor'), account))
      await rejectedCode(journal.advanceCursor({
        consumerId: 'projection-consumer', accountId: account, parserVersion: 'parser-a',
        lastJournalSequence: 0n, expectedVersion: 1,
      }), 'CURSOR_CONFLICT')
    })

    test('S1-25..30 leases admit one worker, reject stale writes, reclaim after expiry and isolate parsers', async () => {
      const id = await journal.append(observation(account, { providerEventId: 'lease' }))
      const now = new Date('2026-07-26T20:02:00.000Z')
      const claims = await Promise.allSettled(['worker-a', 'worker-b'].map(workerId => journal.claimProcessing({
        accountId: account, observationId: id, parserVersion: 'parser-a', workerId, now,
        leaseUntil: new Date(now.getTime() + 5_000),
      })))
      assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1)
      assert.equal(claims.filter(result => result.status === 'rejected' && errorCode(result.reason) === 'CLAIM_CONFLICT').length, 1)
      const winner = claims.find(result => result.status === 'fulfilled')!.value
      await rejectedCode(journal.markProcessingState({
        accountId: account, observationId: id, parserVersion: 'parser-a', workerId: winner.claimedBy!,
        expectedLeaseVersion: winner.leaseVersion - 1, state: 'completed',
      }), 'STALE_WORKER')
      const reclaimed = await journal.claimProcessing({
        accountId: account, observationId: id, parserVersion: 'parser-a', workerId: 'worker-c',
        now: new Date(now.getTime() + 6_000), leaseUntil: new Date(now.getTime() + 12_000),
      })
      assert.equal(reclaimed.claimedBy, 'worker-c')
      assert.ok(reclaimed.leaseVersion > winner.leaseVersion)
      const parserB = await journal.claimProcessing({
        accountId: account, observationId: id, parserVersion: 'parser-b', workerId: 'worker-b', now,
        leaseUntil: new Date(now.getTime() + 5_000),
      })
      assert.equal(parserB.parserVersion, 'parser-b')
    })

    test('S1-31..36 cursor OCC prevents regression and isolates account, consumer and reconnect', async () => {
      const id = await journal.append(observation(account, { providerEventId: 'cursor-sequence' }))
      const raw = await client.maxRawTransportEvent.findUniqueOrThrow({ where: { observationId: id } })
      const first = await journal.advanceCursor({
        consumerId: 'cursor-a', accountId: account, parserVersion: 'parser-a',
        lastJournalSequence: raw.journalSequence, expectedVersion: 0,
      })
      await rejectedCode(journal.advanceCursor({
        consumerId: 'cursor-a', accountId: account, parserVersion: 'parser-a',
        lastJournalSequence: raw.journalSequence + 1n, expectedVersion: 0,
      }), 'CURSOR_CONFLICT')
      await rejectedCode(journal.advanceCursor({
        consumerId: 'cursor-a', accountId: account, parserVersion: 'parser-a',
        lastJournalSequence: raw.journalSequence - 1n, expectedVersion: first.version,
      }), 'CURSOR_CONFLICT')
      await journal.advanceCursor({
        consumerId: 'cursor-a', accountId: `${account}_isolated`, parserVersion: 'parser-a',
        lastJournalSequence: 7n, expectedVersion: 0,
      })
      await journal.advanceCursor({
        consumerId: 'cursor-b', accountId: account, parserVersion: 'parser-a',
        lastJournalSequence: 8n, expectedVersion: 0,
      })
      const secondClient = await createRealPrismaClient(config)
      const durable = await new PrismaRawEventJournal(secondClient as any).getCursor('cursor-a', account, 'parser-a')
      await secondClient.$disconnect()
      assert.equal(durable?.lastJournalSequence, raw.journalSequence)
      assert.equal((await journal.getCursor('cursor-a', `${account}_isolated`, 'parser-a'))?.lastJournalSequence, 7n)
      assert.equal((await journal.getCursor('cursor-b', account, 'parser-a'))?.lastJournalSequence, 8n)
    })

    test('S1-37..41 oversized and binary inputs quarantine durably without bytes and preserve ordering', async () => {
      const oversized = new PrismaRawEventJournal(client as any, { maxPayloadBytes: 128 })
      const oversizedId = await oversized.append(observation(account, {
        providerEventId: 'oversized',
        sanitizedPayload: { authorization: 'credential-must-not-survive', body: 'x'.repeat(512) },
      }))
      const binarySanitized = sanitizeRawObservationPayload(Buffer.from('credential-binary-bytes'))
      const binaryId = await journal.append(observation(account, {
        providerEventId: 'binary',
        payloadEncoding: 'msgpack_sanitized_json',
        ...binarySanitized,
      }))
      const normalId = await journal.append(observation(account, { providerEventId: 'normal-after-quarantine' }))
      const rows = await client.maxRawTransportEvent.findMany({
        where: { observationId: { in: [oversizedId, binaryId, normalId] } },
        orderBy: { journalSequence: 'asc' },
      })
      assert.deepEqual(rows.map((row: any) => row.replayAvailability), ['quarantined', 'quarantined', 'available'])
      const persistedJson = JSON.stringify(rows, (_key, value) => typeof value === 'bigint' ? value.toString() : value)
      assert.equal(persistedJson.includes('credential-must-not-survive'), false)
      assert.equal(persistedJson.includes('credential-binary-bytes'), false)
      assert.equal(rows[0].journalSequence < rows[1].journalSequence && rows[1].journalSequence < rows[2].journalSequence, true)
    })

    test('S1 BigInt sequence remains exact above Number.MAX_SAFE_INTEGER', async () => {
      await client.$executeRawUnsafe(`SELECT setval(
        pg_get_serial_sequence('"MaxRawTransportEvent"', 'journalSequence'),
        GREATEST(COALESCE((SELECT max("journalSequence") FROM "MaxRawTransportEvent"), 0), 9007199254740992),
        true
      )`)
      const id = await journal.append(observation(account, { providerEventId: 'bigint' }))
      const row = await client.maxRawTransportEvent.findUniqueOrThrow({ where: { observationId: id } })
      assert.ok(row.journalSequence > 9007199254740992n)
      const page = await journal.readAfter(account, row.journalSequence - 1n, 10)
      assert.equal(page.observations.some(item => item.observationId === id), true)
      assert.equal(page.nextCursor >= row.journalSequence, true)
    })

    test('S1 transaction rejection is classified and never returns false success', async () => {
      const rejectingClient = {
        ...client,
        $transaction: async () => { throw new Error('synthetic transaction rejection') },
      }
      const rejecting = new PrismaRawEventJournal(rejectingClient as any)
      await assert.rejects(
        rejecting.append(observation(account, { providerEventId: 'rejected-transaction' })),
        (error: unknown) => error instanceof JournalError && error.code === 'DATABASE_FAILURE',
      )
    })
  })
}
