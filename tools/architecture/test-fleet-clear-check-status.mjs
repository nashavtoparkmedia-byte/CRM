#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-fleet-clear-status-'))
const sources = [
    'gravity-mvp/src/contracts/fleet-operations/v1/clear-fleet-check-status-command.ts',
    'gravity-mvp/src/contracts/fleet-operations/v1/index.ts',
    'gravity-mvp/src/modules/fleet-operations/public/v1/clear-fleet-check-status-handler.ts',
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
const { createClearFleetCheckStatusHandlerV1 } = require(path.join(out, 'modules/fleet-operations/public/v1/clear-fleet-check-status-handler.js'))
const checks = []
const check = (name, run) => { run(); checks.push(name) }
const checkAsync = async (name, run) => { await run(); checks.push(name) }

try {
    const command = {
        contract: contracts.CLEAR_FLEET_CHECK_STATUS_COMMAND_V1,
        operation: contracts.CLEAR_ALL_DRIVER_FLEET_CHECK_STATUSES_V1,
    }
    check('v1 identifier explicit', () => assert.equal(contracts.CLEAR_FLEET_CHECK_STATUS_COMMAND_V1, 'fleet_operations.ClearFleetCheckStatusCommand.v1'))
    check('operation explicit', () => assert.equal(contracts.CLEAR_ALL_DRIVER_FLEET_CHECK_STATUSES_V1, 'clear_all_driver_fleet_check_statuses'))
    check('valid command parses unchanged', () => assert.deepEqual(contracts.parseClearFleetCheckStatusCommandV1(command), command))
    check('v2 cannot enter v1 parser', () => assert.throws(
        () => contracts.parseClearFleetCheckStatusCommandV1({ ...command, contract: 'fleet_operations.ClearFleetCheckStatusCommand.v2' }),
        (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    ))
    check('unknown fields fail', () => assert.throws(() => contracts.parseClearFleetCheckStatusCommandV1({ ...command, driverId: 'd1' })))
    check('unknown operation fails', () => assert.throws(() => contracts.parseClearFleetCheckStatusCommandV1({ ...command, operation: 'clear_one' })))
    let calls = 0
    const handler = createClearFleetCheckStatusHandlerV1({ async clearAll() { calls += 1; return { clearedCount: 7 } } })
    await checkAsync('owner result is explicit', async () => assert.deepEqual(
        await handler(command),
        { contract: contracts.CLEAR_FLEET_CHECK_STATUS_RESULT_V1, clearedCount: 7 },
    ))
    await checkAsync('invalid command never reaches persistence', async () => {
        const before = calls
        await assert.rejects(handler({ ...command, operation: 'clear_one' }))
        assert.equal(calls, before)
    })
    await checkAsync('owner failures remain visible', async () => {
        const failing = createClearFleetCheckStatusHandlerV1({ async clearAll() { throw new Error('owner unavailable') } })
        await assert.rejects(failing(command), /owner unavailable/)
    })
} finally {
    rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
