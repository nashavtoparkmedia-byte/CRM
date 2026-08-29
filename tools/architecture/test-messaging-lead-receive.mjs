#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-messaging-lead-receive-'))
const sources = [
    'gravity-mvp/src/contracts/messaging/v1/receive-message-command.ts',
    'gravity-mvp/src/contracts/messaging/v1/index.ts',
    'gravity-mvp/src/modules/messaging/public/v1/receive-message-handler.ts',
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
const { createReceiveMessageHandlerV1 } = require(path.join(out, 'modules/messaging/public/v1/receive-message-handler.js'))
const checks = []
const check = (name, run) => { run(); checks.push(name) }
const checkAsync = async (name, run) => { await run(); checks.push(name) }

try {
    const command = {
        contract: contracts.RECEIVE_MESSAGE_COMMAND_V1,
        chatId: 'chat-1',
        content: 'Новый отклик',
        sentAt: '2026-08-09T12:00:00.000Z',
        externalId: 'avito:msg:response-1',
        channel: 'avito',
        metadata: { source: 'avito', sourceExternalId: 'response-1' },
    }
    check('v1 identifier explicit', () => assert.equal(
        contracts.RECEIVE_MESSAGE_COMMAND_V1, 'messaging.ReceiveMessageCommand.v1',
    ))
    check('channel vocabulary frozen', () => assert.deepEqual(
        contracts.RECEIVE_MESSAGE_CHANNELS_V1, ['telegram', 'whatsapp', 'max', 'phone', 'avito'],
    ))
    check('valid command parses unchanged', () => assert.deepEqual(
        contracts.parseReceiveMessageCommandV1(command), command,
    ))
    check('v2 cannot enter v1 parser', () => assert.throws(
        () => contracts.parseReceiveMessageCommandV1({ ...command, contract: 'messaging.ReceiveMessageCommand.v2' }),
        (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    ))
    check('unknown fields fail', () => assert.throws(
        () => contracts.parseReceiveMessageCommandV1({ ...command, status: 'delivered' }),
    ))
    check('chat id is required', () => assert.throws(
        () => contracts.parseReceiveMessageCommandV1({ ...command, chatId: '' }),
    ))
    check('content is required', () => assert.throws(
        () => contracts.parseReceiveMessageCommandV1({ ...command, content: '' }),
    ))
    check('sentAt must parse', () => assert.throws(
        () => contracts.parseReceiveMessageCommandV1({ ...command, sentAt: 'today' }),
    ))
    check('channel must be known', () => assert.throws(
        () => contracts.parseReceiveMessageCommandV1({ ...command, channel: 'site' }),
    ))
    check('metadata must be an object', () => assert.throws(
        () => contracts.parseReceiveMessageCommandV1({ ...command, metadata: [] }),
    ))

    const calls = []
    const handler = createReceiveMessageHandlerV1({
        async receive(input) { calls.push(input); return { messageId: 'message-1', created: true } },
    })
    await checkAsync('owner receives exact message values', async () => {
        const result = await handler(command)
        assert.deepEqual(calls, [{
            chatId: 'chat-1', content: 'Новый отклик', sentAt: '2026-08-09T12:00:00.000Z',
            externalId: 'avito:msg:response-1', channel: 'avito',
            metadata: { source: 'avito', sourceExternalId: 'response-1' },
        }])
        assert.deepEqual(result, { contract: contracts.RECEIVE_MESSAGE_RESULT_V1, messageId: 'message-1', created: true })
    })
    await checkAsync('existing message result remains explicit', async () => {
        const existing = createReceiveMessageHandlerV1({ async receive() { return { messageId: 'message-1', created: false } } })
        assert.deepEqual(await existing(command), { contract: contracts.RECEIVE_MESSAGE_RESULT_V1, messageId: 'message-1', created: false })
    })
    await checkAsync('invalid command never reaches persistence', async () => {
        const before = calls.length
        await assert.rejects(handler({ ...command, externalId: '' }))
        assert.equal(calls.length, before)
    })
    await checkAsync('persistence failures remain visible', async () => {
        const failing = createReceiveMessageHandlerV1({ async receive() { throw new Error('owner unavailable') } })
        await assert.rejects(failing(command), /owner unavailable/)
    })
} finally {
    rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
