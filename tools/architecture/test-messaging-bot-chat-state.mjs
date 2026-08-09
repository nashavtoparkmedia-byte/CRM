#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-messaging-bot-chat-'))
const sources = [
    'gravity-mvp/src/contracts/messaging/v1/update-conversation-command.ts',
    'gravity-mvp/src/contracts/messaging/v1/index.ts',
    'gravity-mvp/src/modules/messaging/public/v1/update-conversation-handler.ts',
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
const contracts = require(path.join(out, 'contracts/messaging/v1/index.js'))
const { createUpdateConversationHandlerV1 } = require(path.join(out, 'modules/messaging/public/v1/update-conversation-handler.js'))
const checks = []
const check = (name, run) => { run(); checks.push(name) }
const checkAsync = async (name, run) => { await run(); checks.push(name) }

try {
    const command = {
        contract: contracts.UPDATE_CONVERSATION_COMMAND_V1,
        operation: contracts.MARK_REQUIRES_RESPONSE_V1,
        chatId: 'chat-1',
        lastMessageAt: '2026-08-09T12:00:00.000Z',
    }
    check('v1 identifier explicit', () => assert.equal(contracts.UPDATE_CONVERSATION_COMMAND_V1, 'messaging.UpdateConversationCommand.v1'))
    check('operation explicit', () => assert.equal(contracts.MARK_REQUIRES_RESPONSE_V1, 'mark_requires_response'))
    check('valid command parses unchanged', () => assert.deepEqual(contracts.parseUpdateConversationCommandV1(command), command))
    check('v2 cannot enter v1 parser', () => assert.throws(
        () => contracts.parseUpdateConversationCommandV1({ ...command, contract: 'messaging.UpdateConversationCommand.v2' }),
        (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    ))
    check('unknown fields fail', () => assert.throws(() => contracts.parseUpdateConversationCommandV1({ ...command, status: 'open' })))
    check('unknown operation fails', () => assert.throws(() => contracts.parseUpdateConversationCommandV1({ ...command, operation: 'resolve' })))
    check('chat id is required', () => assert.throws(() => contracts.parseUpdateConversationCommandV1({ ...command, chatId: '' })))
    check('last message instant must parse', () => assert.throws(() => contracts.parseUpdateConversationCommandV1({ ...command, lastMessageAt: 'today' })))

    const calls = []
    const handler = createUpdateConversationHandlerV1({
        async markRequiresResponse(input) { calls.push(input); return { chatId: input.chatId } },
    })
    await checkAsync('owner receives exact state transition', async () => {
        const result = await handler(command)
        assert.deepEqual(calls, [{ chatId: 'chat-1', lastMessageAt: '2026-08-09T12:00:00.000Z' }])
        assert.deepEqual(result, { contract: contracts.UPDATE_CONVERSATION_RESULT_V1, chatId: 'chat-1' })
    })
    await checkAsync('invalid command never reaches persistence', async () => {
        const before = calls.length
        await assert.rejects(handler({ ...command, chatId: '' }))
        assert.equal(calls.length, before)
    })
    await checkAsync('persistence failures remain visible', async () => {
        const failing = createUpdateConversationHandlerV1({ async markRequiresResponse() { throw new Error('owner unavailable') } })
        await assert.rejects(failing(command), /owner unavailable/)
    })
} finally {
    rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
