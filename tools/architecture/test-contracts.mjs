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
const output = mkdtempSync(path.join(tmpdir(), 'yoko-contract-tests-'))

const sources = [
    'gravity-mvp/src/contracts/work-management/v1/create-task-command.ts',
    'gravity-mvp/src/contracts/work-management/v1/index.ts',
    'gravity-mvp/src/modules/work-management/public/v1/create-task-handler.ts',
    'gravity-mvp/src/modules/work-management/public/v1/legacy-task-record.ts',
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
const handlers = require(path.join(output, 'modules/work-management/public/v1/create-task-handler.js'))
const legacy = require(path.join(output, 'modules/work-management/public/v1/legacy-task-record.js'))

const checks = []
function check(name, action) {
    action()
    checks.push(name)
}

try {
    const validCommand = {
        contract: contracts.CREATE_TASK_COMMAND_V1,
        data: {
            driverId: 'driver-1',
            contactId: 'contact-1',
            source: 'auto',
            type: 'ai_call_followup',
            title: 'AI-звонок: результат разговора',
            description: 'Перезвонить завтра',
            priority: 'high',
            status: 'todo',
            createdBy: 'manager-1',
            metadata: { aiCallId: 'call-1', qualification: 'qualified' },
        },
    }

    check('v1 valid command parses', () => {
        assert.deepEqual(contracts.parseCreateTaskCommandV1(validCommand), validCommand)
    })

    check('v1 missing required title fails closed', () => {
        assert.throws(
            () => contracts.parseCreateTaskCommandV1({
                ...validCommand,
                data: { ...validCommand.data, title: '' },
            }),
            (error) => error.code === 'INVALID_CONTRACT',
        )
    })

    check('v1 non-JSON metadata fails closed', () => {
        assert.throws(
            () => contracts.parseCreateTaskCommandV1({
                ...validCommand,
                data: { ...validCommand.data, metadata: { value: Number.NaN } },
            }),
            (error) => error.code === 'INVALID_CONTRACT',
        )
    })

    check('v2 cannot silently replace v1', () => {
        assert.throws(
            () => contracts.parseCreateTaskCommandV1({ ...validCommand, contract: 'work_management.CreateTaskCommand.v2' }),
            (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
        )
    })

    check('unknown v1 fields fail closed', () => {
        assert.throws(
            () => contracts.parseCreateTaskCommandV1({
                ...validCommand,
                data: { ...validCommand.data, providerImplementation: 'forbidden' },
            }),
            (error) => error.code === 'INVALID_CONTRACT',
        )
    })

    check('unknown command envelope fields fail closed', () => {
        assert.throws(
            () => contracts.parseCreateTaskCommandV1({ ...validCommand, implementation: 'legacy-prisma' }),
            (error) => error.code === 'INVALID_CONTRACT',
        )
    })

    check('v1 task enums match the owned schema surface', () => {
        for (const priority of ['critical', 'high', 'medium', 'low']) {
            contracts.parseCreateTaskCommandV1({
                contract: contracts.CREATE_TASK_COMMAND_V1,
                data: { source: 'manual', type: 'other', title: 'Schema parity', priority },
            })
        }
        for (const status of [
            'todo', 'in_progress', 'waiting_reply', 'overdue',
            'snoozed', 'done', 'cancelled', 'archived',
        ]) {
            contracts.parseCreateTaskCommandV1({
                contract: contracts.CREATE_TASK_COMMAND_V1,
                data: { source: 'manual', type: 'other', title: 'Schema parity', status },
            })
        }
    })

    const writes = []
    const handler = handlers.createCreateTaskHandlerV1({
        async create(data) {
            writes.push(data)
            return { id: 'task-1', title: data.title }
        },
    })

    const result = await handler(validCommand)
    check('producer payload reaches owner port without semantic drift', () => {
        assert.deepEqual(writes, [validCommand.data])
    })
    check('owner handler returns versioned result', () => {
        assert.deepEqual(result, {
            contract: contracts.CREATE_TASK_RESULT_V1,
            task: { id: 'task-1', title: validCommand.data.title },
        })
    })

    check('legacy persistence mapping preserves representative payload', () => {
        assert.deepEqual(legacy.mapCreateTaskDataToLegacyRecordV1(validCommand.data), {
            ...validCommand.data,
            assigneeId: null,
        })
    })

    check('contract module is provider independent', () => {
        const serialized = JSON.stringify(validCommand)
        assert.equal(serialized.includes('prisma'), false)
        assert.equal(serialized.includes('yandex'), false)
        assert.equal(serialized.includes('freeswitch'), false)
    })

    process.stdout.write(JSON.stringify({ status: 'PASS', checks }, null, 2) + '\n')
} finally {
    rmSync(output, { recursive: true, force: true })
}
