#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const compiler = process.env.YOKO_TSC_PATH
    ?? path.join(root, 'gravity-mvp/node_modules/typescript/bin/tsc')
const output = mkdtempSync(path.join(tmpdir(), 'yoko-outbox-tests-'))
const sources = [
    'gravity-mvp/src/contracts/calling/v1/recording-ready-event.ts',
    'gravity-mvp/src/contracts/calling/v1/index.ts',
    'gravity-mvp/src/modules/calling/internal/recording-ready.ts',
    'gravity-mvp/src/infrastructure/outbox/v1/outbox-publisher.ts',
    'gravity-mvp/src/infrastructure/outbox/v1/index.ts',
].map((value) => path.join(root, value))

const compile = spawnSync(process.execPath, [
    compiler,
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--strict',
    '--skipLibCheck',
    '--rootDir', path.join(root, 'gravity-mvp/src'),
    '--outDir', output,
    ...sources,
], { encoding: 'utf8' })

if (compile.status !== 0) {
    process.stderr.write(compile.stdout)
    process.stderr.write(compile.stderr)
    rmSync(output, { recursive: true, force: true })
    process.exit(1)
}

const require = createRequire(import.meta.url)
const contracts = require(path.join(output, 'contracts/calling/v1/index.js'))
const recording = require(path.join(output, 'modules/calling/internal/recording-ready.js'))
const outbox = require(path.join(output, 'infrastructure/outbox/v1/index.js'))
const checks = []

async function check(name, action) {
    await action()
    checks.push(name)
}

class PreviewUnitOfWork {
    constructor() {
        this.state = { calls: new Map([['call-1', { recordingPath: null }]]), events: new Map() }
        this.failAppend = false
    }

    async run(operation) {
        const draft = {
            calls: new Map([...this.state.calls].map(([key, value]) => [key, { ...value }])),
            events: new Map(this.state.events),
        }
        const transaction = {
            updateCallRecording: async (callId, recordingPath) => {
                if (!draft.calls.has(callId)) throw new Error('CALL_NOT_FOUND')
                draft.calls.set(callId, { recordingPath })
            },
            appendOutboxEvent: async (event) => {
                if (this.failAppend) throw new Error('OUTBOX_INSERT_FAILED')
                if (!draft.events.has(event.eventId)) draft.events.set(event.eventId, event)
            },
        }
        const result = await operation(transaction)
        this.state = draft
        return result
    }
}

class PreviewOutboxStore {
    constructor(events = [], recovered = { retryWait: 0, deadLetter: 0 }) {
        this.events = events
        this.recovered = recovered
        this.published = []
        this.failed = []
        this.claimLimit = null
    }
    async recoverStale() { return this.recovered }
    async claimBatch(_now, limit) {
        this.claimLimit = limit
        return this.events.slice(0, limit)
    }
    async markPublished(id, publishedAt) { this.published.push({ id, publishedAt }) }
    async markFailed(id, failure) { this.failed.push({ id, failure }) }
}

try {
    const fixedNow = new Date('2026-08-09T14:00:00.000Z')
    const eventInput = {
        callId: 'call-1',
        recordingPath: '2026/08/fs-1.mp3',
        occurredAt: fixedNow.toISOString(),
        correlationId: 'call-1',
        causationId: 'fs-1',
    }
    const event = contracts.makeRecordingReadyEventV1(eventInput)

    await check('RecordingReady.v1 envelope is explicit and parseable', async () => {
        assert.equal(event.eventType, contracts.RECORDING_READY_EVENT_V1)
        assert.equal(event.eventVersion, 1)
        assert.deepEqual(contracts.parseRecordingReadyEventV1(event), event)
    })
    await check('event id is deterministic for idempotent append', async () => {
        assert.equal(contracts.makeRecordingReadyEventV1(eventInput).eventId, event.eventId)
    })
    await check('unknown event fields fail closed', async () => {
        assert.throws(() => contracts.parseRecordingReadyEventV1({ ...event, provider: 'redis' }))
    })
    await check('event version cannot silently change', async () => {
        assert.throws(() => contracts.parseRecordingReadyEventV1({ ...event, eventVersion: 2 }))
    })

    await check('domain update and outbox append commit atomically', async () => {
        const uow = new PreviewUnitOfWork()
        const persist = recording.createPersistRecordingReadyV1(uow, () => fixedNow)
        const persisted = await persist(eventInput)
        assert.equal(uow.state.calls.get('call-1').recordingPath, eventInput.recordingPath)
        assert.equal(uow.state.events.get(persisted.eventId).data.callId, 'call-1')
    })
    await check('replayed domain operation does not duplicate the logical event', async () => {
        const uow = new PreviewUnitOfWork()
        const persist = recording.createPersistRecordingReadyV1(uow, () => fixedNow)
        await persist(eventInput)
        await persist(eventInput)
        assert.equal(uow.state.events.size, 1)
    })
    await check('outbox append failure rolls domain update back', async () => {
        const uow = new PreviewUnitOfWork()
        uow.failAppend = true
        const persist = recording.createPersistRecordingReadyV1(uow, () => fixedNow)
        await assert.rejects(() => persist(eventInput), /OUTBOX_INSERT_FAILED/)
        assert.equal(uow.state.calls.get('call-1').recordingPath, null)
        assert.equal(uow.state.events.size, 0)
    })

    await check('retry schedule is bounded and increasing', async () => {
        assert.deepEqual([1, 2, 3, 4, 5].map(outbox.outboxRetryDelayMsV1), [
            5_000, 30_000, 120_000, 600_000, 1_800_000,
        ])
    })
    await check('successful publish marks the event published', async () => {
        const store = new PreviewOutboxStore([{ ...event, id: 'row-1', payload: event, attempts: 1, maxAttempts: 5 }])
        const result = await outbox.publishOutboxBatchV1({
            store,
            publishers: { [event.eventType]: async (payload) => contracts.parseRecordingReadyEventV1(payload) },
            now: fixedNow,
        })
        assert.equal(result.published, 1)
        assert.equal(store.published[0].id, 'row-1')
    })
    await check('transient failure schedules observable retry', async () => {
        const store = new PreviewOutboxStore([{ ...event, id: 'row-2', payload: event, attempts: 2, maxAttempts: 5 }])
        const result = await outbox.publishOutboxBatchV1({
            store,
            publishers: { [event.eventType]: async () => { throw new Error('REDIS_DOWN') } },
            now: fixedNow,
        })
        assert.equal(result.retryWait, 1)
        assert.equal(store.failed[0].failure.status, 'retry_wait')
        assert.equal(store.failed[0].failure.availableAt.toISOString(), '2026-08-09T14:00:30.000Z')
    })
    await check('retry exhaustion moves poison event to dead letter', async () => {
        const store = new PreviewOutboxStore([{ ...event, id: 'row-3', payload: event, attempts: 5, maxAttempts: 5 }])
        const result = await outbox.publishOutboxBatchV1({
            store,
            publishers: { [event.eventType]: async () => { throw new Error('POISON') } },
            now: fixedNow,
        })
        assert.equal(result.deadLetter, 1)
        assert.equal(store.failed[0].failure.status, 'dead_letter')
    })
    await check('unregistered event type fails visibly instead of disappearing', async () => {
        const store = new PreviewOutboxStore([{ ...event, eventType: 'unknown.v1', id: 'row-4', payload: event, attempts: 1, maxAttempts: 5 }])
        await outbox.publishOutboxBatchV1({ store, publishers: {}, now: fixedNow })
        assert.match(store.failed[0].failure.lastError, /UNREGISTERED_EVENT_TYPE/)
    })
    await check('hung publisher times out into the retry lane', async () => {
        const store = new PreviewOutboxStore([{ ...event, id: 'row-timeout', payload: event, attempts: 1, maxAttempts: 5 }])
        await outbox.publishOutboxBatchV1({
            store,
            publishers: { [event.eventType]: async () => new Promise(() => {}) },
            now: fixedNow,
            publishTimeoutMs: 5,
        })
        assert.equal(store.failed[0].failure.status, 'retry_wait')
        assert.match(store.failed[0].failure.lastError, /PUBLISH_TIMEOUT:5ms/)
    })
    await check('publisher batch and error size are bounded', async () => {
        const events = Array.from({ length: 30 }, (_, index) => ({
            ...event,
            id: `row-${index}`,
            payload: event,
            attempts: 1,
            maxAttempts: 5,
        }))
        const store = new PreviewOutboxStore(events)
        const result = await outbox.publishOutboxBatchV1({
            store,
            publishers: { [event.eventType]: async () => {} },
            now: fixedNow,
            limit: 999,
        })
        assert.equal(result.claimed, outbox.OUTBOX_BATCH_LIMIT_V1)
        assert.equal(store.claimLimit, outbox.OUTBOX_BATCH_LIMIT_V1)
        assert.equal(outbox.normalizeOutboxErrorV1('x'.repeat(2000)).length, 1000)
    })
    await check('stored errors redact credential-shaped values', async () => {
        const normalized = outbox.normalizeOutboxErrorV1(
            'Bearer super-secret https://user:pass@example.test/x?token=abc&api_key=def',
        )
        assert.equal(normalized.includes('super-secret'), false)
        assert.equal(normalized.includes('user:pass'), false)
        assert.equal(normalized.includes('token=abc'), false)
        assert.equal(normalized.includes('api_key=def'), false)
    })
    await check('stale claim recovery is part of every batch', async () => {
        const store = new PreviewOutboxStore([], { retryWait: 2, deadLetter: 1 })
        const result = await outbox.publishOutboxBatchV1({ store, publishers: {}, now: fixedNow })
        assert.equal(result.recovered, 3)
        assert.equal(result.deadLetter, 1)
    })

    process.stdout.write(JSON.stringify({ status: 'PASS', checks }, null, 2) + '\n')
} finally {
    rmSync(output, { recursive: true, force: true })
}
