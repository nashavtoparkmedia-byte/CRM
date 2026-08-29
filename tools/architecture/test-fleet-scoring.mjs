#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-fleet-scoring-'))
const sources = [
    'gravity-mvp/src/contracts/fleet-operations/v1/update-scoring-thresholds-command.ts',
    'gravity-mvp/src/contracts/fleet-operations/v1/index.ts',
    'gravity-mvp/src/modules/fleet-operations/public/v1/update-scoring-thresholds-handler.ts',
].map((value) => path.join(root, value))
const compile = spawnSync(process.execPath, [
    path.join(root, 'gravity-mvp/node_modules/typescript/bin/tsc'),
    '--target', 'ES2022', '--module', 'commonjs', '--moduleResolution', 'node',
    '--strict', '--skipLibCheck', '--rootDir', path.join(root, 'gravity-mvp/src'),
    '--outDir', out, ...sources,
], { encoding: 'utf8' })
if (compile.status !== 0) {
    process.stderr.write(compile.stdout + compile.stderr)
    process.exit(1)
}

const require = createRequire(import.meta.url)
const contracts = require(path.join(out, 'contracts/fleet-operations/v1/index.js'))
const { createUpdateScoringThresholdsHandlerV1 } = require(path.join(out, 'modules/fleet-operations/public/v1/update-scoring-thresholds-handler.js'))
const checks = []
const check = (name, run) => { run(); checks.push(name) }
const checkAsync = async (name, run) => { await run(); checks.push(name) }

try {
    const command = {
        contract: contracts.UPDATE_SCORING_THRESHOLDS_COMMAND_V1,
        thresholds: { profitable_min: 20, risk_days: 3 },
    }
    check('v1 identifier explicit', () => assert.equal(
        contracts.UPDATE_SCORING_THRESHOLDS_COMMAND_V1,
        'fleet_operations.UpdateScoringThresholdsCommand.v1',
    ))
    check('valid command parses without normalization', () => assert.deepEqual(
        contracts.parseUpdateScoringThresholdsCommandV1(command), command,
    ))
    check('v2 cannot enter v1 parser', () => assert.throws(
        () => contracts.parseUpdateScoringThresholdsCommandV1({ ...command, contract: 'fleet_operations.UpdateScoringThresholdsCommand.v2' }),
        (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    ))
    check('unknown command fields fail', () => assert.throws(
        () => contracts.parseUpdateScoringThresholdsCommandV1({ ...command, revalidate: true }),
    ))
    check('threshold collection must be an object', () => assert.throws(
        () => contracts.parseUpdateScoringThresholdsCommandV1({ ...command, thresholds: [] }),
    ))
    check('threshold values must be numbers', () => assert.throws(
        () => contracts.parseUpdateScoringThresholdsCommandV1({ ...command, thresholds: { risk_days: '3' } }),
    ))
    check('non-finite threshold values fail', () => assert.throws(
        () => contracts.parseUpdateScoringThresholdsCommandV1({ ...command, thresholds: { risk_days: Number.NaN } }),
    ))

    const calls = []
    const handler = createUpdateScoringThresholdsHandlerV1({
        async upsertThresholds(entries) { calls.push(entries) },
    })
    await checkAsync('owner receives ordered entries unchanged', async () => {
        const result = await handler(command)
        assert.deepEqual(calls, [[['profitable_min', 20], ['risk_days', 3]]])
        assert.deepEqual(result, {
            contract: contracts.UPDATE_SCORING_THRESHOLDS_RESULT_V1,
            updated: 2,
        })
    })
    await checkAsync('empty threshold update remains valid', async () => {
        const result = await handler({ ...command, thresholds: {} })
        assert.deepEqual(calls.at(-1), [])
        assert.equal(result.updated, 0)
    })
    await checkAsync('invalid command never reaches persistence', async () => {
        const before = calls.length
        await assert.rejects(handler({ ...command, thresholds: { risk_days: Infinity } }))
        assert.equal(calls.length, before)
    })
    await checkAsync('persistence failures remain visible', async () => {
        const failing = createUpdateScoringThresholdsHandlerV1({
            async upsertThresholds() { throw new Error('owner unavailable') },
        })
        await assert.rejects(failing(command), /owner unavailable/)
    })
} finally {
    rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
