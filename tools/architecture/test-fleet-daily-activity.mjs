#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-fleet-daily-activity-'))
const sources = [
    'gravity-mvp/src/contracts/fleet-operations/v1/record-driver-daily-activity-command.ts',
    'gravity-mvp/src/contracts/fleet-operations/v1/index.ts',
    'gravity-mvp/src/modules/fleet-operations/public/v1/record-driver-daily-activity-handler.ts',
].map((value) => path.join(root, value))
const compile = spawnSync(process.execPath, [
    path.join(root, 'gravity-mvp/node_modules/typescript/bin/tsc'), '--target', 'ES2022',
    '--module', 'commonjs', '--moduleResolution', 'node', '--strict', '--skipLibCheck',
    '--rootDir', path.join(root, 'gravity-mvp/src'), '--outDir', out, ...sources,
], { encoding: 'utf8' })
if (compile.status !== 0) {
    process.stderr.write(compile.stdout + compile.stderr)
    process.exit(1)
}

const require = createRequire(import.meta.url)
const contracts = require(path.join(out, 'contracts/fleet-operations/v1/index.js'))
const { createRecordDriverDailyActivityHandlerV1 } = require(path.join(out, 'modules/fleet-operations/public/v1/record-driver-daily-activity-handler.js'))
const checks = []
const check = (name, run) => { run(); checks.push(name) }
const checkAsync = async (name, run) => { await run(); checks.push(name) }

try {
    const command = {
        contract: contracts.RECORD_DRIVER_DAILY_ACTIVITY_COMMAND_V1,
        driverId: 'driver-1',
        dayStart: '2026-08-09T00:00:00.000Z',
        activity: 'manager_message',
    }
    check('v1 identifier explicit', () => assert.equal(
        contracts.RECORD_DRIVER_DAILY_ACTIVITY_COMMAND_V1,
        'fleet_operations.RecordDriverDailyActivityCommand.v1',
    ))
    check('activity vocabulary frozen', () => assert.deepEqual(
        contracts.DRIVER_DAILY_ACTIVITIES_V1,
        ['manager_message', 'manager_call', 'auto_message', 'goal_achieved'],
    ))
    check('valid command parses unchanged', () => assert.deepEqual(
        contracts.parseRecordDriverDailyActivityCommandV1(command), command,
    ))
    check('v2 cannot enter v1 parser', () => assert.throws(
        () => contracts.parseRecordDriverDailyActivityCommandV1({ ...command, contract: 'fleet_operations.RecordDriverDailyActivityCommand.v2' }),
        (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    ))
    check('unknown fields fail', () => assert.throws(
        () => contracts.parseRecordDriverDailyActivityCommandV1({ ...command, prismaField: 'hadManagerMessage' }),
    ))
    check('driver id is required', () => assert.throws(
        () => contracts.parseRecordDriverDailyActivityCommandV1({ ...command, driverId: '' }),
    ))
    check('day start must parse', () => assert.throws(
        () => contracts.parseRecordDriverDailyActivityCommandV1({ ...command, dayStart: 'today' }),
    ))
    check('unknown activity fails', () => assert.throws(
        () => contracts.parseRecordDriverDailyActivityCommandV1({ ...command, activity: 'trip' }),
    ))

    const calls = []
    const handler = createRecordDriverDailyActivityHandlerV1({
        async recordActivity(input) { calls.push(input) },
    })
    await checkAsync('owner receives exact domain activity', async () => {
        const result = await handler(command)
        assert.deepEqual(calls, [{ driverId: 'driver-1', dayStart: '2026-08-09T00:00:00.000Z', activity: 'manager_message' }])
        assert.deepEqual(result, { contract: contracts.RECORD_DRIVER_DAILY_ACTIVITY_RESULT_V1, recorded: true })
    })
    await checkAsync('invalid command never reaches persistence', async () => {
        const before = calls.length
        await assert.rejects(handler({ ...command, activity: 'unknown' }))
        assert.equal(calls.length, before)
    })
    await checkAsync('persistence failures remain visible', async () => {
        const failing = createRecordDriverDailyActivityHandlerV1({ async recordActivity() { throw new Error('owner unavailable') } })
        await assert.rejects(failing(command), /owner unavailable/)
    })
} finally {
    rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
