#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-proposed-reply-'))
const sources = [
    'gravity-mvp/src/contracts/ai-knowledge/v1/proposed-reply-commands.ts',
    'gravity-mvp/src/contracts/ai-knowledge/v1/index.ts',
    'gravity-mvp/src/modules/ai-knowledge/public/v1/proposed-reply-handler.ts',
].map((value) => path.join(root, value))
const compiled = spawnSync(process.execPath, [
    path.join(root, 'gravity-mvp/node_modules/typescript/bin/tsc'),
    '--target', 'ES2022', '--module', 'commonjs', '--moduleResolution', 'node',
    '--strict', '--skipLibCheck', '--rootDir', path.join(root, 'gravity-mvp/src'),
    '--outDir', out, ...sources,
], { encoding: 'utf8' })
if (compiled.status !== 0) {
    process.stderr.write(compiled.stdout + compiled.stderr)
    process.exit(1)
}

const require = createRequire(import.meta.url)
const contracts = require(path.join(out, 'contracts/ai-knowledge/v1/index.js'))
const { createPatchProposedReplyHandlerV1, createUpsertProposedReplyHandlerV1 } = require(path.join(out, 'modules/ai-knowledge/public/v1/proposed-reply-handler.js'))
const checks = []
const check = (name, assertion) => { assertion(); checks.push(name) }
const checkAsync = async (name, assertion) => { await assertion(); checks.push(name) }

try {
    const expiresAt = new Date('2026-08-09T22:15:00.000Z')
    const upsert = {
        contract: contracts.UPSERT_PROPOSED_REPLY_COMMAND_V1,
        messageId: 'message_1', chatId: 'chat_1', text: '', confidence: 0.75,
        decisionMode: 'auto_reply', reasoning: null,
        sources: [{ id: 'knowledge_1', title: 'Policy' }], expiresAt,
    }
    const patch = {
        contract: contracts.PATCH_PROPOSED_REPLY_COMMAND_V1,
        proposalId: 'proposal_1', patch: { takenAt: new Date('2026-08-09T22:01:00.000Z') },
    }
    check('identifiers explicit', () => {
        assert.equal(contracts.UPSERT_PROPOSED_REPLY_COMMAND_V1, 'ai_knowledge.UpsertProposedReplyCommand.v1')
        assert.equal(contracts.PATCH_PROPOSED_REPLY_COMMAND_V1, 'ai_knowledge.PatchProposedReplyCommand.v1')
    })
    check('commands parse', () => {
        assert.deepEqual(contracts.parseUpsertProposedReplyCommandV1(upsert), upsert)
        assert.deepEqual(contracts.parsePatchProposedReplyCommandV1(patch), patch)
    })
    check('all lifecycle patches parse', () => {
        for (const candidate of [
            { sentMessageId: 'message_2' }, { dismissedAt: new Date() }, { confirmedCorrectAt: new Date() },
        ]) contracts.parsePatchProposedReplyCommandV1({ ...patch, patch: candidate })
    })
    check('v2 rejected', () => assert.throws(
        () => contracts.parseUpsertProposedReplyCommandV1({ ...upsert, contract: 'ai_knowledge.UpsertProposedReplyCommand.v2' }),
        (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    ))
    check('unknown and empty patches rejected', () => {
        assert.throws(() => contracts.parsePatchProposedReplyCommandV1({ ...patch, patch: { text: 'leak' } }))
        assert.throws(() => contracts.parsePatchProposedReplyCommandV1({ ...patch, patch: {} }))
    })
    check('invalid values rejected', () => {
        assert.throws(() => contracts.parseUpsertProposedReplyCommandV1({ ...upsert, messageId: '' }))
        assert.throws(() => contracts.parseUpsertProposedReplyCommandV1({ ...upsert, confidence: Number.NaN }))
        assert.throws(() => contracts.parseUpsertProposedReplyCommandV1({ ...upsert, decisionMode: 'manual' }))
        assert.throws(() => contracts.parsePatchProposedReplyCommandV1({ ...patch, patch: { sentMessageId: '' } }))
    })
    const calls = []
    const proposal = { id: 'proposal_1' }
    const port = {
        async upsert(value) { calls.push(['upsert', value]); return proposal },
        async patch(id, value) { calls.push(['patch', id, value]) },
    }
    const upserted = await createUpsertProposedReplyHandlerV1(port)(upsert)
    const patched = await createPatchProposedReplyHandlerV1(port)(patch)
    check('exact owner mappings', () => assert.deepEqual(calls, [
        ['upsert', { messageId: 'message_1', chatId: 'chat_1', text: '', confidence: 0.75, decisionMode: 'auto_reply', reasoning: null, sources: [{ id: 'knowledge_1', title: 'Policy' }], expiresAt }],
        ['patch', 'proposal_1', patch.patch],
    ]))
    check('results explicit', () => {
        assert.deepEqual(upserted, { contract: contracts.UPSERT_PROPOSED_REPLY_RESULT_V1, proposal })
        assert.deepEqual(patched, { contract: contracts.PATCH_PROPOSED_REPLY_RESULT_V1, updated: true })
    })
    await checkAsync('invalid never persists', async () => {
        const before = calls.length
        await assert.rejects(createPatchProposedReplyHandlerV1(port)({ ...patch, patch: {} }))
        await assert.rejects(createUpsertProposedReplyHandlerV1(port)({ ...upsert, expiresAt: 'later' }))
        assert.equal(calls.length, before)
    })
    await checkAsync('owner failures visible', async () => {
        const failing = { async upsert() { throw new Error('upsert down') }, async patch() { throw new Error('patch down') } }
        await assert.rejects(createUpsertProposedReplyHandlerV1(failing)(upsert), /upsert down/)
        await assert.rejects(createPatchProposedReplyHandlerV1(failing)(patch), /patch down/)
    })
} finally {
    rmSync(out, { recursive: true, force: true })
}
process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
