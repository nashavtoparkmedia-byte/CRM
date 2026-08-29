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
const output = mkdtempSync(path.join(tmpdir(), 'yoko-work-management-completion-tests-'))
const sources = [
    'gravity-mvp/src/contracts/work-management/v1/create-task-command.ts',
    'gravity-mvp/src/contracts/work-management/v1/assign-task-command.ts',
    'gravity-mvp/src/contracts/work-management/v1/complete-task-command.ts',
    'gravity-mvp/src/contracts/work-management/v1/index.ts',
    'gravity-mvp/src/modules/work-management/public/v1/complete-task-handler.ts',
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
const contracts = require(path.join(output, 'contracts/work-management/v1/index.js'))
const { createCompleteTaskHandlerV1 } = require(path.join(
    output,
    'modules/work-management/public/v1/complete-task-handler.js',
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
    const command = {
        contract: contracts.COMPLETE_TASK_COMMAND_V1,
        taskId: 'manager-task-1',
        outcome: 'done',
        resolvedBy: 'manager',
    }

    check('semantic identifiers are explicit v1', () => {
        assert.equal(contracts.COMPLETE_TASK_COMMAND_V1, 'work_management.CompleteTaskCommand.v1')
        assert.equal(contracts.COMPLETE_TASK_RESULT_V1, 'work_management.CompleteTaskResult.v1')
    })
    check('valid completion command parses without drift', () => {
        assert.deepEqual(contracts.parseCompleteTaskCommandV1(command), command)
    })
    check('done and skipped outcomes are both preserved', () => {
        for (const outcome of ['done', 'skipped']) {
            assert.equal(contracts.parseCompleteTaskCommandV1({ ...command, outcome }).outcome, outcome)
        }
    })
    check('unsupported outcomes fail closed', () => {
        assert.throws(
            () => contracts.parseCompleteTaskCommandV1({ ...command, outcome: 'archived' }),
            (error) => error.code === 'INVALID_CONTRACT',
        )
    })
    check('v2 cannot silently replace v1', () => {
        assert.throws(
            () => contracts.parseCompleteTaskCommandV1({ ...command, contract: 'work_management.CompleteTaskCommand.v2' }),
            (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
        )
    })
    check('unknown fields fail closed', () => {
        assert.throws(
            () => contracts.parseCompleteTaskCommandV1({ ...command, revalidatePath: '/inbox' }),
            (error) => error.code === 'INVALID_CONTRACT',
        )
    })

    const writes = []
    const handler = createCompleteTaskHandlerV1({
        async complete(input) { writes.push(input) },
    })
    await checkAsync('handler forwards only validated owner input', async () => {
        const result = await handler(command)
        assert.deepEqual(writes, [{ taskId: 'manager-task-1', outcome: 'done', resolvedBy: 'manager' }])
        assert.deepEqual(result, {
            contract: contracts.COMPLETE_TASK_RESULT_V1,
            taskId: 'manager-task-1',
            status: 'done',
        })
    })
    await checkAsync('skipped result remains explicit and versioned', async () => {
        const result = await handler({ ...command, outcome: 'skipped' })
        assert.equal(result.contract, contracts.COMPLETE_TASK_RESULT_V1)
        assert.equal(result.status, 'skipped')
    })
    await checkAsync('invalid commands never reach the owner port', async () => {
        const before = writes.length
        await assert.rejects(handler({ ...command, taskId: '' }), (error) => error.code === 'INVALID_CONTRACT')
        assert.equal(writes.length, before)
    })
    await checkAsync('owner persistence failures remain visible', async () => {
        const failing = createCompleteTaskHandlerV1({ async complete() { throw new Error('owner unavailable') } })
        await assert.rejects(failing(command), /owner unavailable/)
    })
} finally {
    rmSync(output, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
