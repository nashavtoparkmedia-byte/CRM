#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-fleet-inbox-public-'))
const sources = [
    'gravity-mvp/src/contracts/fleet-operations/v1/log-manager-call-command.ts',
    'gravity-mvp/src/contracts/fleet-operations/v1/index.ts',
    'gravity-mvp/src/modules/fleet-operations/public/v1/log-manager-call-handler.ts',
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
const { createLogManagerCallHandlerV1 } = require(path.join(out, 'modules/fleet-operations/public/v1/log-manager-call-handler.js'))
const checks = []
const check = (name, run) => { run(); checks.push(name) }
const checkAsync = async (name, run) => { await run(); checks.push(name) }

try {
    const command = { contract: contracts.LOG_MANAGER_CALL_COMMAND_V1, driverId: 'driver-1' }
    check('v1 identifier explicit', () => assert.equal(
        contracts.LOG_MANAGER_CALL_COMMAND_V1, 'fleet_operations.LogManagerCallCommand.v1',
    ))
    check('valid command parses unchanged', () => assert.deepEqual(
        contracts.parseLogManagerCallCommandV1(command), command,
    ))
    check('v2 cannot enter v1 parser', () => assert.throws(
        () => contracts.parseLogManagerCallCommandV1({ ...command, contract: 'fleet_operations.LogManagerCallCommand.v2' }),
        (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    ))
    check('unknown fields fail', () => assert.throws(
        () => contracts.parseLogManagerCallCommandV1({ ...command, channel: 'phone' }),
    ))
    check('driver id is required', () => assert.throws(
        () => contracts.parseLogManagerCallCommandV1({ ...command, driverId: '' }),
    ))

    const calls = []
    const handler = createLogManagerCallHandlerV1({ async logManagerCall(driverId) { calls.push(driverId) } })
    await checkAsync('compatibility port receives exact driver id', async () => {
        const result = await handler(command)
        assert.deepEqual(calls, ['driver-1'])
        assert.deepEqual(result, { contract: contracts.LOG_MANAGER_CALL_RESULT_V1, logged: true })
    })
    await checkAsync('invalid command never reaches compatibility port', async () => {
        const before = calls.length
        await assert.rejects(handler({ ...command, driverId: null }))
        assert.equal(calls.length, before)
    })
    await checkAsync('legacy failure remains visible', async () => {
        const failing = createLogManagerCallHandlerV1({ async logManagerCall() { throw new Error('legacy unavailable') } })
        await assert.rejects(failing(command), /legacy unavailable/)
    })
} finally {
    rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
