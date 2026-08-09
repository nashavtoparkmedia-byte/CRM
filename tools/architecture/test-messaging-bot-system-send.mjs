#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-messaging-bot-send-'))
const sources = [
    'gravity-mvp/src/contracts/messaging/v1/send-message-command.ts',
    'gravity-mvp/src/contracts/messaging/v1/index.ts',
    'gravity-mvp/src/modules/messaging/public/v1/send-message-handler.ts',
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
const { createSendMessageHandlerV1 } = require(path.join(out, 'modules/messaging/public/v1/send-message-handler.js'))
const checks = []
const check = (name, run) => { run(); checks.push(name) }
const checkAsync = async (name, run) => { await run(); checks.push(name) }

try {
    const command = {
        contract: contracts.SEND_MESSAGE_COMMAND_V1,
        operation: contracts.APPEND_SYSTEM_NOTIFICATION_V1,
        chatId: 'chat-1',
        content: 'Запрос привязки',
        sentAt: '2026-08-09T12:00:00.000Z',
        externalId: 'bot_link_req_1_123',
        channel: 'telegram',
    }
    check('v1 identifier explicit', () => assert.equal(contracts.SEND_MESSAGE_COMMAND_V1, 'messaging.SendMessageCommand.v1'))
    check('operation explicit', () => assert.equal(contracts.APPEND_SYSTEM_NOTIFICATION_V1, 'append_system_notification'))
    check('channel vocabulary frozen', () => assert.deepEqual(
        contracts.SEND_MESSAGE_CHANNELS_V1, ['telegram', 'whatsapp', 'max', 'phone', 'avito'],
    ))
    check('valid command parses unchanged', () => assert.deepEqual(contracts.parseSendMessageCommandV1(command), command))
    check('v2 cannot enter v1 parser', () => assert.throws(
        () => contracts.parseSendMessageCommandV1({ ...command, contract: 'messaging.SendMessageCommand.v2' }),
        (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    ))
    check('unknown fields fail', () => assert.throws(() => contracts.parseSendMessageCommandV1({ ...command, status: 'sent' })))
    check('unknown operation fails', () => assert.throws(() => contracts.parseSendMessageCommandV1({ ...command, operation: 'send_provider_message' })))
    check('chat id is required', () => assert.throws(() => contracts.parseSendMessageCommandV1({ ...command, chatId: '' })))
    check('content is required', () => assert.throws(() => contracts.parseSendMessageCommandV1({ ...command, content: '' })))
    check('sentAt must parse', () => assert.throws(() => contracts.parseSendMessageCommandV1({ ...command, sentAt: 'today' })))
    check('channel must be known', () => assert.throws(() => contracts.parseSendMessageCommandV1({ ...command, channel: 'bot' })))

    const calls = []
    const handler = createSendMessageHandlerV1({
        async appendSystemNotification(input) { calls.push(input); return { messageId: 'message-1' } },
    })
    await checkAsync('owner receives exact system notification', async () => {
        const result = await handler(command)
        assert.deepEqual(calls, [{
            chatId: 'chat-1', content: 'Запрос привязки', sentAt: '2026-08-09T12:00:00.000Z',
            externalId: 'bot_link_req_1_123', channel: 'telegram',
        }])
        assert.deepEqual(result, { contract: contracts.SEND_MESSAGE_RESULT_V1, messageId: 'message-1' })
    })
    await checkAsync('invalid command never reaches persistence', async () => {
        const before = calls.length
        await assert.rejects(handler({ ...command, externalId: '' }))
        assert.equal(calls.length, before)
    })
    await checkAsync('persistence failures remain visible', async () => {
        const failing = createSendMessageHandlerV1({ async appendSystemNotification() { throw new Error('owner unavailable') } })
        await assert.rejects(failing(command), /owner unavailable/)
    })
} finally {
    rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
