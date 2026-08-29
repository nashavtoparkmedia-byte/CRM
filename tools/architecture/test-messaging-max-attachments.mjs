#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-messaging-max-attachments-'))
const sources = [
    'gravity-mvp/src/contracts/messaging/v1/attach-message-media-command.ts',
    'gravity-mvp/src/contracts/messaging/v1/delete-message-media-command.ts',
    'gravity-mvp/src/contracts/messaging/v1/index.ts',
    'gravity-mvp/src/contracts/messaging/v2/attach-message-media-command.ts',
    'gravity-mvp/src/contracts/messaging/v2/index.ts',
    'gravity-mvp/src/modules/messaging/public/v1/delete-message-media-handler.ts',
    'gravity-mvp/src/modules/messaging/public/v2/attach-message-media-handler.ts',
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
const v1 = require(path.join(out, 'contracts/messaging/v1/index.js'))
const v2 = require(path.join(out, 'contracts/messaging/v2/index.js'))
const { createDeleteMessageMediaHandlerV1 } = require(path.join(out, 'modules/messaging/public/v1/delete-message-media-handler.js'))
const { createAttachMessageMediaHandlerV2 } = require(path.join(out, 'modules/messaging/public/v2/attach-message-media-handler.js'))
const checks = []
const check = (name, run) => { run(); checks.push(name) }
const checkAsync = async (name, run) => { await run(); checks.push(name) }

try {
    const attach = {
        contract: v2.ATTACH_MESSAGE_MEDIA_COMMAND_V2,
        messageId: 'message-1', mediaType: 'file', url: 'https://media/1',
        fileName: null, fileSize: null, mimeType: null,
    }
    check('attach v2 identifier explicit', () => assert.equal(v2.ATTACH_MESSAGE_MEDIA_COMMAND_V2, 'messaging.AttachMessageMediaCommand.v2'))
    check('valid nullable-size v2 parses', () => assert.deepEqual(v2.parseAttachMessageMediaCommandV2(attach), attach))
    check('v1 cannot enter v2 parser', () => assert.throws(
        () => v2.parseAttachMessageMediaCommandV2({ ...attach, contract: v1.ATTACH_MESSAGE_MEDIA_COMMAND_V1 }),
        (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    ))
    check('v2 cannot enter v1 parser', () => assert.throws(
        () => v1.parseAttachMessageMediaCommandV1({ ...attach, contract: v2.ATTACH_MESSAGE_MEDIA_COMMAND_V2, fileSize: 1 }),
        (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    ))
    check('attach v2 unknown fields fail', () => assert.throws(() => v2.parseAttachMessageMediaCommandV2({ ...attach, provider: 'max' })))
    check('attach v2 validates nullable size', () => {
        assert.doesNotThrow(() => v2.parseAttachMessageMediaCommandV2({ ...attach, fileSize: 42 }))
        assert.throws(() => v2.parseAttachMessageMediaCommandV2({ ...attach, fileSize: -1 }))
        assert.throws(() => v2.parseAttachMessageMediaCommandV2({ ...attach, fileSize: 1.5 }))
    })
    const attachCalls = []
    const attachHandler = createAttachMessageMediaHandlerV2({
        async attach(input) { attachCalls.push(input); return { attachmentId: 'attachment-1' } },
    })
    await checkAsync('attach owner receives exact nullable fields', async () => {
        const result = await attachHandler(attach)
        assert.deepEqual(attachCalls, [{ messageId: 'message-1', mediaType: 'file', url: 'https://media/1', fileName: null, fileSize: null, mimeType: null }])
        assert.deepEqual(result, { contract: v2.ATTACH_MESSAGE_MEDIA_RESULT_V2, attachmentId: 'attachment-1' })
    })
    await checkAsync('invalid attach never reaches persistence', async () => {
        const before = attachCalls.length
        await assert.rejects(attachHandler({ ...attach, url: '' }))
        assert.equal(attachCalls.length, before)
    })
    await checkAsync('attach failures remain visible', async () => {
        const failing = createAttachMessageMediaHandlerV2({ async attach() { throw new Error('attach unavailable') } })
        await assert.rejects(failing(attach), /attach unavailable/)
    })

    const remove = { contract: v1.DELETE_MESSAGE_MEDIA_COMMAND_V1, messageId: 'message-1' }
    check('delete v1 identifier explicit', () => assert.equal(v1.DELETE_MESSAGE_MEDIA_COMMAND_V1, 'messaging.DeleteMessageMediaCommand.v1'))
    check('valid delete parses', () => assert.deepEqual(v1.parseDeleteMessageMediaCommandV1(remove), remove))
    check('delete v2 cannot enter v1 parser', () => assert.throws(
        () => v1.parseDeleteMessageMediaCommandV1({ ...remove, contract: 'messaging.DeleteMessageMediaCommand.v2' }),
        (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    ))
    const deleteCalls = []
    const deleteHandler = createDeleteMessageMediaHandlerV1({
        async deleteAllForMessage(input) { deleteCalls.push(input); return { deletedCount: 2 } },
    })
    await checkAsync('delete owner receives exact message id', async () => {
        const result = await deleteHandler(remove)
        assert.deepEqual(deleteCalls, [{ messageId: 'message-1' }])
        assert.deepEqual(result, { contract: v1.DELETE_MESSAGE_MEDIA_RESULT_V1, deletedCount: 2 })
    })
    await checkAsync('invalid delete never reaches persistence', async () => {
        const before = deleteCalls.length
        await assert.rejects(deleteHandler({ ...remove, messageId: '' }))
        assert.equal(deleteCalls.length, before)
    })
    await checkAsync('delete failures remain visible', async () => {
        const failing = createDeleteMessageMediaHandlerV1({ async deleteAllForMessage() { throw new Error('delete unavailable') } })
        await assert.rejects(failing(remove), /delete unavailable/)
    })
} finally {
    rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
