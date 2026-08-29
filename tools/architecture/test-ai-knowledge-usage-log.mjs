#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-ai-knowledge-usage-'))
const sources = [
    'gravity-mvp/src/contracts/ai-knowledge/v1/record-knowledge-usage-command.ts',
    'gravity-mvp/src/contracts/ai-knowledge/v1/index.ts',
    'gravity-mvp/src/modules/ai-knowledge/public/v1/record-knowledge-usage-handler.ts',
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
const contracts = require(path.join(out, 'contracts/ai-knowledge/v1/index.js'))
const { createRecordKnowledgeUsageHandlerV1 } = require(path.join(out, 'modules/ai-knowledge/public/v1/record-knowledge-usage-handler.js'))
const checks = []
const check = (name, run) => { run(); checks.push(name) }
const checkAsync = async (name, run) => { await run(); checks.push(name) }

try {
    const command = {
        contract: contracts.RECORD_KNOWLEDGE_USAGE_COMMAND_V1,
        id: 'kul_1',
        itemId: 'item_1',
        decisionLogId: 'adl_1',
        messageId: 'msg_1',
        retrievalScore: 0.73,
        rerankScore: null,
        usedInReply: false,
        policyDecision: 'filtered_low_confidence',
        shadowMode: true,
        escalationReason: 'low_confidence',
    }
    check('v1 identifier explicit', () => assert.equal(
        contracts.RECORD_KNOWLEDGE_USAGE_COMMAND_V1,
        'ai_knowledge.RecordKnowledgeUsageCommand.v1',
    ))
    check('valid command parses unchanged', () => assert.deepEqual(
        contracts.parseRecordKnowledgeUsageCommandV1(command), command,
    ))
    check('finite rerank score is accepted', () => assert.equal(
        contracts.parseRecordKnowledgeUsageCommandV1({ ...command, rerankScore: 0.91 }).rerankScore, 0.91,
    ))
    check('nullable escalation reason is accepted', () => assert.equal(
        contracts.parseRecordKnowledgeUsageCommandV1({ ...command, escalationReason: null }).escalationReason, null,
    ))
    check('v2 cannot enter v1 parser', () => assert.throws(
        () => contracts.parseRecordKnowledgeUsageCommandV1({ ...command, contract: 'ai_knowledge.RecordKnowledgeUsageCommand.v2' }),
        (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    ))
    check('unknown fields fail closed', () => assert.throws(
        () => contracts.parseRecordKnowledgeUsageCommandV1({ ...command, provider: 'openai' }),
    ))
    check('non-finite retrieval score fails closed', () => assert.throws(
        () => contracts.parseRecordKnowledgeUsageCommandV1({ ...command, retrievalScore: Number.NaN }),
    ))
    check('non-finite rerank score fails closed', () => assert.throws(
        () => contracts.parseRecordKnowledgeUsageCommandV1({ ...command, rerankScore: Number.POSITIVE_INFINITY }),
    ))
    check('empty identifiers fail closed', () => assert.throws(
        () => contracts.parseRecordKnowledgeUsageCommandV1({ ...command, itemId: ' ' }),
    ))

    const writes = []
    const handler = createRecordKnowledgeUsageHandlerV1({ async append(input) { writes.push(input) } })
    const result = await handler(command)
    await checkAsync('owner port receives exact persistence fields', async () => assert.deepEqual(
        writes, [{
            id: 'kul_1',
            itemId: 'item_1',
            decisionLogId: 'adl_1',
            messageId: 'msg_1',
            retrievalScore: 0.73,
            rerankScore: null,
            usedInReply: false,
            policyDecision: 'filtered_low_confidence',
            shadowMode: true,
            escalationReason: 'low_confidence',
        }],
    ))
    check('handler returns explicit result', () => assert.deepEqual(result, {
        contract: contracts.RECORD_KNOWLEDGE_USAGE_RESULT_V1,
        recorded: true,
    }))
    await checkAsync('invalid command never reaches persistence', async () => {
        const before = writes.length
        await assert.rejects(handler({ ...command, shadowMode: 'yes' }))
        assert.equal(writes.length, before)
    })
    await checkAsync('owner failure remains observable to caller boundary', async () => {
        const failing = createRecordKnowledgeUsageHandlerV1({ async append() { throw new Error('write failed') } })
        await assert.rejects(failing(command), /write failed/)
    })
} finally {
    rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
