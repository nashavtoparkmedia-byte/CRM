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
const output = mkdtempSync(path.join(tmpdir(), 'yoko-work-management-assignment-tests-'))
const sources = [
    'gravity-mvp/src/contracts/work-management/v1/create-task-command.ts',
    'gravity-mvp/src/contracts/work-management/v1/assign-task-command.ts',
    'gravity-mvp/src/contracts/work-management/v1/reassign-tasks-command.ts',
    'gravity-mvp/src/contracts/work-management/v1/index.ts',
    'gravity-mvp/src/modules/work-management/public/v1/assign-task-handler.ts',
    'gravity-mvp/src/modules/work-management/public/v1/reassign-tasks-handler.ts',
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
const { createAssignTaskHandlerV1 } = require(path.join(
    output,
    'modules/work-management/public/v1/assign-task-handler.js',
))
const { createReassignTasksHandlerV1 } = require(path.join(
    output,
    'modules/work-management/public/v1/reassign-tasks-handler.js',
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
        contract: contracts.ASSIGN_TASK_COMMAND_V1,
        taskId: 'task-1',
        assigneeId: 'manager-2',
        assigneeName: 'Анна',
    }

    check('semantic identifiers are explicit v1', () => {
        assert.equal(contracts.ASSIGN_TASK_COMMAND_V1, 'work_management.AssignTaskCommand.v1')
        assert.equal(contracts.ASSIGN_TASK_RESULT_V1, 'work_management.AssignTaskResult.v1')
    })
    check('valid assignment command parses without drift', () => {
        assert.deepEqual(contracts.parseAssignTaskCommandV1(command), command)
    })
    check('v2 cannot silently replace v1', () => {
        assert.throws(
            () => contracts.parseAssignTaskCommandV1({ ...command, contract: 'work_management.AssignTaskCommand.v2' }),
            (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
        )
    })
    check('unknown command fields fail closed', () => {
        assert.throws(
            () => contracts.parseAssignTaskCommandV1({ ...command, persistence: 'prisma' }),
            (error) => error.code === 'INVALID_CONTRACT',
        )
    })
    check('empty semantic identifiers fail closed', () => {
        for (const field of ['taskId', 'assigneeId', 'assigneeName']) {
            assert.throws(
                () => contracts.parseAssignTaskCommandV1({ ...command, [field]: ' ' }),
                (error) => error.code === 'INVALID_CONTRACT',
            )
        }
    })

    const calls = []
    const handler = createAssignTaskHandlerV1({
        async assign(input) {
            calls.push(input)
            return 'reassigned'
        },
    })
    await checkAsync('handler forwards only validated owner input', async () => {
        const result = await handler(command)
        assert.deepEqual(calls, [{ taskId: 'task-1', assigneeId: 'manager-2', assigneeName: 'Анна' }])
        assert.deepEqual(result, { contract: contracts.ASSIGN_TASK_RESULT_V1, status: 'reassigned' })
    })
    await checkAsync('not-found status remains an explicit no-op', async () => {
        const result = await createAssignTaskHandlerV1({ async assign() { return 'not_found' } })(command)
        assert.equal(result.status, 'not_found')
    })
    await checkAsync('unchanged status remains an explicit no-op', async () => {
        const result = await createAssignTaskHandlerV1({ async assign() { return 'unchanged' } })(command)
        assert.equal(result.status, 'unchanged')
    })
    await checkAsync('invalid command never reaches the owner port', async () => {
        const before = calls.length
        await assert.rejects(handler({ ...command, taskId: '' }), (error) => error.code === 'INVALID_CONTRACT')
        assert.equal(calls.length, before)
    })
    await checkAsync('owner persistence failure remains visible', async () => {
        const failing = createAssignTaskHandlerV1({ async assign() { throw new Error('owner unavailable') } })
        await assert.rejects(failing(command), /owner unavailable/)
    })

    const reassignCommand = {
        contract: contracts.REASSIGN_TASKS_COMMAND_V1,
        taskIds: ['task-1', 'task-2', 'task-3'],
        newAssigneeId: 'manager-2',
    }
    check('batch reassignment contract is explicit v1', () => {
        assert.equal(
            contracts.REASSIGN_TASKS_COMMAND_V1,
            'work_management.ReassignTasksCommand.v1',
        )
        assert.equal(
            contracts.REASSIGN_TASKS_RESULT_V1,
            'work_management.ReassignTasksResult.v1',
        )
    })
    check('batch contract permits the legacy empty-input no-op', () => {
        assert.deepEqual(
            contracts.parseReassignTasksCommandV1({ ...reassignCommand, taskIds: [] }).taskIds,
            [],
        )
    })
    check('unrelated batch write operation fails closed', () => {
        assert.throws(
            () => contracts.parseReassignTasksCommandV1({ ...reassignCommand, deleteTasks: true }),
            (error) => error.code === 'INVALID_CONTRACT',
        )
    })
    check('invalid batch task identity fails closed', () => {
        assert.throws(
            () => contracts.parseReassignTasksCommandV1({ ...reassignCommand, taskIds: ['task-1', ' '] }),
            (error) => error.code === 'INVALID_CONTRACT',
        )
    })

    const batchCalls = []
    let lookupCount = 0
    const batchHandler = createReassignTasksHandlerV1({
        async findTargetUser(userId) {
            lookupCount++
            assert.equal(userId, 'manager-2')
            return { id: userId, name: 'Анна' }
        },
        async assign(input) {
            batchCalls.push(input)
            return ['reassigned', 'unchanged', 'not_found'][batchCalls.length - 1]
        },
    })
    await checkAsync('empty batch returns before identity lookup', async () => {
        const result = await batchHandler({ ...reassignCommand, taskIds: [] })
        assert.deepEqual(result, { contract: contracts.REASSIGN_TASKS_RESULT_V1, reassigned: 0 })
        assert.equal(lookupCount, 0)
        assert.deepEqual(batchCalls, [])
    })
    await checkAsync('batch preserves sequential assignment and completed-only count', async () => {
        const result = await batchHandler(reassignCommand)
        assert.deepEqual(result, { contract: contracts.REASSIGN_TASKS_RESULT_V1, reassigned: 1 })
        assert.equal(lookupCount, 1)
        assert.deepEqual(batchCalls, [
            { taskId: 'task-1', assigneeId: 'manager-2', assigneeName: 'Анна' },
            { taskId: 'task-2', assigneeId: 'manager-2', assigneeName: 'Анна' },
            { taskId: 'task-3', assigneeId: 'manager-2', assigneeName: 'Анна' },
        ])
    })
    await checkAsync('missing target preserves the exact legacy error', async () => {
        const missing = createReassignTasksHandlerV1({
            async findTargetUser() { return null },
            async assign() { throw new Error('must not assign') },
        })
        await assert.rejects(missing(reassignCommand), /^Error: Target user not found$/)
    })
} finally {
    rmSync(output, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
