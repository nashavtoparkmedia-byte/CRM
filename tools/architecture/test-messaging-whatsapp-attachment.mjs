#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-messaging-wa-attachment-'))
const sources = [
    'gravity-mvp/src/contracts/messaging/v1/attach-message-media-command.ts',
    'gravity-mvp/src/contracts/messaging/v1/index.ts',
    'gravity-mvp/src/modules/messaging/public/v1/attach-message-media-handler.ts',
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
const { createAttachMessageMediaHandlerV1 } = require(path.join(out, 'modules/messaging/public/v1/attach-message-media-handler.js'))
const checks = []
const check = (name, run) => { run(); checks.push(name) }
const checkAsync = async (name, run) => { await run(); checks.push(name) }

try {
    const command = {
        contract: contracts.ATTACH_MESSAGE_MEDIA_COMMAND_V1,
        messageId: 'message-1',
        mediaType: 'image',
        url: 'data:image/jpeg;base64,YQ==',
        fileName: 'photo.jpg',
        fileSize: 1,
        mimeType: 'image/jpeg',
    }
    check('v1 identifier explicit', () => assert.equal(contracts.ATTACH_MESSAGE_MEDIA_COMMAND_V1, 'messaging.AttachMessageMediaCommand.v1'))
    check('valid command parses unchanged', () => assert.deepEqual(contracts.parseAttachMessageMediaCommandV1(command), command))
    check('v2 cannot enter v1 parser', () => assert.throws(
        () => contracts.parseAttachMessageMediaCommandV1({ ...command, contract: 'messaging.AttachMessageMediaCommand.v2' }),
        (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    ))
    check('unknown fields fail', () => assert.throws(() => contracts.parseAttachMessageMediaCommandV1({ ...command, provider: 'whatsapp' })))
    check('message id is required', () => assert.throws(() => contracts.parseAttachMessageMediaCommandV1({ ...command, messageId: '' })))
    check('media type is required', () => assert.throws(() => contracts.parseAttachMessageMediaCommandV1({ ...command, mediaType: '' })))
    check('url is required', () => assert.throws(() => contracts.parseAttachMessageMediaCommandV1({ ...command, url: '' })))
    check('file size is a non-negative integer', () => {
        assert.throws(() => contracts.parseAttachMessageMediaCommandV1({ ...command, fileSize: -1 }))
        assert.throws(() => contracts.parseAttachMessageMediaCommandV1({ ...command, fileSize: 1.5 }))
    })
    check('nullable names and MIME types remain valid', () => assert.deepEqual(
        contracts.parseAttachMessageMediaCommandV1({ ...command, fileName: null, mimeType: null }),
        { ...command, fileName: null, mimeType: null },
    ))

    const calls = []
    const handler = createAttachMessageMediaHandlerV1({
        async attach(input) { calls.push(input); return { attachmentId: 'attachment-1' } },
    })
    await checkAsync('owner receives exact attachment', async () => {
        const result = await handler(command)
        assert.deepEqual(calls, [{
            messageId: 'message-1', mediaType: 'image', url: 'data:image/jpeg;base64,YQ==',
            fileName: 'photo.jpg', fileSize: 1, mimeType: 'image/jpeg',
        }])
        assert.deepEqual(result, { contract: contracts.ATTACH_MESSAGE_MEDIA_RESULT_V1, attachmentId: 'attachment-1' })
    })
    await checkAsync('invalid command never reaches persistence', async () => {
        const before = calls.length
        await assert.rejects(handler({ ...command, fileSize: -1 }))
        assert.equal(calls.length, before)
    })
    await checkAsync('persistence failures remain visible', async () => {
        const failing = createAttachMessageMediaHandlerV1({ async attach() { throw new Error('owner unavailable') } })
        await assert.rejects(failing(command), /owner unavailable/)
    })
} finally {
    rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
