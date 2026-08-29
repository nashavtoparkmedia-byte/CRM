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
const output = mkdtempSync(path.join(tmpdir(), 'yoko-calling-ai-intern-control-tests-'))
const sources = [
    'gravity-mvp/src/contracts/calling/v1/ai-intern-control.ts',
    'gravity-mvp/src/modules/calling/public/v1/ai-intern-control-handler.ts',
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
const contracts = require(path.join(output, 'contracts/calling/v1/ai-intern-control.js'))
const { createAiInternControlHandlerV1 } = require(path.join(
    output,
    'modules/calling/public/v1/ai-intern-control-handler.js',
))
const checks = []
const check = (name, body) => {
    body()
    checks.push(name)
}
const checkAsync = async (name, body) => {
    await body()
    checks.push(name)
}

try {
    const query = { contract: contracts.GET_AI_INTERN_STATE_QUERY_V1 }
    const command = { contract: contracts.SET_AI_INTERN_STATE_COMMAND_V1, enabled: false }
    check('AI intern contracts are explicit v1', () => {
        assert.equal(contracts.GET_AI_INTERN_STATE_QUERY_V1, 'calling.GetAiInternStateQuery.v1')
        assert.equal(contracts.SET_AI_INTERN_STATE_COMMAND_V1, 'calling.SetAiInternStateCommand.v1')
    })
    check('valid query and command parse without drift', () => {
        assert.deepEqual(contracts.parseGetAiInternStateQueryV1(query), query)
        assert.deepEqual(contracts.parseSetAiInternStateCommandV1(command), command)
    })
    check('unrelated AI config write fails closed', () => {
        assert.throws(
            () => contracts.parseSetAiInternStateCommandV1({ ...command, providerCredential: 'secret' }),
            (error) => error.code === 'INVALID_CONTRACT',
        )
    })
    check('non-boolean state and v2 fail closed', () => {
        assert.throws(
            () => contracts.parseSetAiInternStateCommandV1({ ...command, enabled: 'false' }),
            (error) => error.code === 'INVALID_CONTRACT',
        )
        assert.throws(
            () => contracts.parseGetAiInternStateQueryV1({ contract: 'calling.GetAiInternStateQuery.v2' }),
            (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
        )
    })

    const writes = []
    const control = createAiInternControlHandlerV1({
        async getInternEnabled() { return false },
        async setInternEnabled(enabled) { writes.push(enabled) },
    })
    await checkAsync('read returns only the nullable boolean projection', async () => {
        assert.deepEqual(await control.getState(query), {
            contract: contracts.GET_AI_INTERN_STATE_RESULT_V1,
            internEnabled: false,
        })
    })
    await checkAsync('write forwards only the validated boolean', async () => {
        assert.deepEqual(await control.setState(command), {
            contract: contracts.SET_AI_INTERN_STATE_RESULT_V1,
            saved: true,
        })
        assert.deepEqual(writes, [false])
    })
    await checkAsync('invalid write never reaches the owner port', async () => {
        await assert.rejects(
            control.setState({ ...command, enabled: 1 }),
            (error) => error.code === 'INVALID_CONTRACT',
        )
        assert.deepEqual(writes, [false])
    })
} finally {
    rmSync(output, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
