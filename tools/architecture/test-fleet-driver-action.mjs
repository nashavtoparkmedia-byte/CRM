#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const output = mkdtempSync(path.join(tmpdir(), 'yoko-driver-action-'))
const sources = [
    'gravity-mvp/src/contracts/fleet-operations/v1/driver-action-commands.ts',
    'gravity-mvp/src/contracts/fleet-operations/v1/index.ts',
    'gravity-mvp/src/modules/fleet-operations/public/v1/driver-action-handler.ts',
].map(file => path.join(root, file))
const compiled = spawnSync(process.execPath, [
    path.join(root, 'gravity-mvp/node_modules/typescript/bin/tsc'),
    '--target', 'ES2022', '--module', 'commonjs', '--moduleResolution', 'node',
    '--strict', '--skipLibCheck', '--rootDir', path.join(root, 'gravity-mvp/src'),
    '--outDir', output, ...sources,
], { encoding: 'utf8' })
if (compiled.status !== 0) {
    process.stderr.write(compiled.stdout + compiled.stderr)
    process.exit(1)
}

const require = createRequire(import.meta.url)
const contract = require(path.join(output, 'contracts/fleet-operations/v1/index.js'))
const {
    createMirrorDriverActionResultHandlerV1,
    createRecordDriverActionHandlerV1,
} = require(path.join(output, 'modules/fleet-operations/public/v1/driver-action-handler.js'))
const checks = []
const check = (name, run) => { run(); checks.push(name) }
const checkAsync = async (name, run) => { await run(); checks.push(name) }

try {
    const record = {
        contract: contract.RECORD_DRIVER_ACTION_COMMAND_V1,
        data: {
            driverId: 'driver_1', kind: 'GET_PRICE', requestedBy: '42',
            status: 'PENDING', scraperTaskId: 'task_1',
        },
    }
    const completedAt = new Date('2026-01-02T03:04:05.000Z')
    const mirror = {
        contract: contract.MIRROR_DRIVER_ACTION_RESULT_COMMAND_V1,
        scraperTaskId: 'task_1', status: 'DONE', result: { priceRub: 1000 },
        errorMessage: null, shortOrderId: '123', orderId: 'long_123', completedAt,
    }
    check('identifiers explicit', () => {
        assert.equal(contract.RECORD_DRIVER_ACTION_COMMAND_V1, 'fleet_operations.RecordDriverActionCommand.v1')
        assert.equal(contract.MIRROR_DRIVER_ACTION_RESULT_COMMAND_V1, 'fleet_operations.MirrorDriverActionResultCommand.v1')
    })
    check('record command parses', () => assert.deepEqual(contract.parseRecordDriverActionCommandV1(record), record))
    check('all kinds and create statuses parse', () => {
        for (const kind of contract.DRIVER_ACTION_KINDS_V1) contract.parseRecordDriverActionCommandV1({ ...record, data: { ...record.data, kind } })
        for (const status of contract.DRIVER_ACTION_STATUSES_V1) contract.parseRecordDriverActionCommandV1({ ...record, data: { ...record.data, status } })
        contract.parseRecordDriverActionCommandV1({ ...record, data: { ...record.data, errorMessage: '' } })
    })
    check('mirror command parses', () => assert.deepEqual(contract.parseMirrorDriverActionResultCommandV1(mirror), mirror))
    check('v2 rejected', () => assert.throws(
        () => contract.parseRecordDriverActionCommandV1({ ...record, contract: 'fleet_operations.RecordDriverActionCommand.v2' }),
        error => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    ))
    check('unknown fields rejected', () => {
        assert.throws(() => contract.parseRecordDriverActionCommandV1({ ...record, extra: true }))
        assert.throws(() => contract.parseRecordDriverActionCommandV1({ ...record, data: { ...record.data, extra: true } }))
    })
    check('invalid values rejected', () => {
        assert.throws(() => contract.parseRecordDriverActionCommandV1({ ...record, data: { ...record.data, driverId: '' } }))
        assert.throws(() => contract.parseRecordDriverActionCommandV1({ ...record, data: { ...record.data, kind: 'OTHER' } }))
        assert.throws(() => contract.parseMirrorDriverActionResultCommandV1({ ...mirror, status: 'PENDING' }))
        assert.throws(() => contract.parseMirrorDriverActionResultCommandV1({ ...mirror, completedAt: 'now' }))
    })
    const calls = []
    const port = {
        async create(data) { calls.push(['create', data]); return { id: 'action_1', hidden: true } },
        async mirrorResult(input) { calls.push(['mirror', input]); return { updatedCount: 2 } },
    }
    const created = await createRecordDriverActionHandlerV1(port)(record)
    const mirrored = await createMirrorDriverActionResultHandlerV1(port)(mirror)
    check('exact owner mappings', () => assert.deepEqual(calls, [
        ['create', record.data],
        ['mirror', { scraperTaskId: 'task_1', status: 'DONE', result: { priceRub: 1000 }, errorMessage: null, shortOrderId: '123', orderId: 'long_123', completedAt }],
    ]))
    check('results explicit', () => {
        assert.deepEqual(created, { contract: contract.RECORD_DRIVER_ACTION_RESULT_V1, action: { id: 'action_1' } })
        assert.deepEqual(mirrored, { contract: contract.MIRROR_DRIVER_ACTION_RESULT_RESULT_V1, updatedCount: 2 })
    })
    await checkAsync('invalid never persists', async () => {
        const before = calls.length
        await assert.rejects(createRecordDriverActionHandlerV1(port)({ ...record, data: { ...record.data, status: 'OTHER' } }))
        await assert.rejects(createMirrorDriverActionResultHandlerV1(port)({ ...mirror, status: 'PENDING' }))
        assert.equal(calls.length, before)
    })
    await checkAsync('owner failures visible', async () => {
        const failing = {
            async create() { throw new Error('create down') },
            async mirrorResult() { throw new Error('mirror down') },
        }
        await assert.rejects(createRecordDriverActionHandlerV1(failing)(record), /create down/)
        await assert.rejects(createMirrorDriverActionResultHandlerV1(failing)(mirror), /mirror down/)
    })
} finally {
    rmSync(output, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
