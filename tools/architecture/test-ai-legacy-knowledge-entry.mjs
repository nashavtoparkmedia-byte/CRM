#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-ai-legacy-knowledge-entry-'))
const sources = [
    'gravity-mvp/src/contracts/ai-knowledge/v1/legacy-knowledge-entry-commands.ts',
    'gravity-mvp/src/contracts/ai-knowledge/v1/index.ts',
    'gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-knowledge-entry-handler.ts',
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
const {
    createCreateLegacyKnowledgeEntryHandlerV1,
    createDeleteLegacyKnowledgeEntryHandlerV1,
    createUpdateLegacyKnowledgeEntryHandlerV1,
} = require(path.join(out, 'modules/ai-knowledge/public/v1/legacy-knowledge-entry-handler.js'))
const checks = []
const check = (name, assertion) => { assertion(); checks.push(name) }
const checkAsync = async (name, assertion) => { await assertion(); checks.push(name) }

try {
    const data = {
        title: '',
        category: 'general',
        sampleQuestions: ['Как начать?'],
        answer: 'Ответ',
        tags: ['manual'],
        channels: ['telegram'],
        priority: 3,
    }
    const create = {
        contract: contracts.CREATE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1,
        entryId: 'kb_1',
        data,
    }
    const orderedPatch = { priority: 4, title: 'Обновлено', active: false, tags: ['reviewed'] }
    const update = {
        contract: contracts.UPDATE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1,
        entryId: 'kb_1',
        patch: orderedPatch,
    }
    const del = {
        contract: contracts.DELETE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1,
        entryId: 'kb_1',
    }

    check('identifiers explicit', () => {
        assert.equal(contracts.CREATE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1, 'ai_knowledge.CreateLegacyKnowledgeEntryCommand.v1')
        assert.equal(contracts.UPDATE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1, 'ai_knowledge.UpdateLegacyKnowledgeEntryCommand.v1')
        assert.equal(contracts.DELETE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1, 'ai_knowledge.DeleteLegacyKnowledgeEntryCommand.v1')
    })
    check('create parses without narrowing strings', () => assert.deepEqual(
        contracts.parseCreateLegacyKnowledgeEntryCommandV1(create),
        create,
    ))
    check('patch order is retained', () => {
        const parsed = contracts.parseUpdateLegacyKnowledgeEntryCommandV1(update)
        assert.deepEqual(parsed, update)
        assert.deepEqual(Object.keys(parsed.patch), ['priority', 'title', 'active', 'tags'])
        assert.deepEqual(Object.values(parsed.patch), [4, 'Обновлено', false, ['reviewed']])
    })
    check('empty patch parses', () => assert.deepEqual(
        contracts.parseUpdateLegacyKnowledgeEntryCommandV1({ ...update, patch: {} }).patch,
        {},
    ))
    check('delete parses', () => assert.deepEqual(contracts.parseDeleteLegacyKnowledgeEntryCommandV1(del), del))
    check('future versions rejected', () => {
        for (const [parser, command] of [
            [contracts.parseCreateLegacyKnowledgeEntryCommandV1, create],
            [contracts.parseUpdateLegacyKnowledgeEntryCommandV1, update],
            [contracts.parseDeleteLegacyKnowledgeEntryCommandV1, del],
        ]) {
            assert.throws(
                () => parser({ ...command, contract: command.contract.replace('.v1', '.v2') }),
                (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
            )
        }
    })
    check('unknown fields rejected', () => {
        assert.throws(() => contracts.parseCreateLegacyKnowledgeEntryCommandV1({ ...create, sql: 'hidden' }))
        assert.throws(() => contracts.parseCreateLegacyKnowledgeEntryCommandV1({ ...create, data: { ...data, active: true } }))
        assert.throws(() => contracts.parseUpdateLegacyKnowledgeEntryCommandV1({ ...update, patch: { table: 'hidden' } }))
    })
    check('invalid values rejected', () => {
        assert.throws(() => contracts.parseCreateLegacyKnowledgeEntryCommandV1({ ...create, data: { ...data, sampleQuestions: [1] } }))
        assert.throws(() => contracts.parseCreateLegacyKnowledgeEntryCommandV1({ ...create, data: { ...data, sampleQuestions: new Array(1) } }))
        assert.throws(() => contracts.parseCreateLegacyKnowledgeEntryCommandV1({ ...create, data: { ...data, priority: 1.5 } }))
        assert.throws(() => contracts.parseUpdateLegacyKnowledgeEntryCommandV1({ ...update, patch: { active: 'false' } }))
        assert.throws(() => contracts.parseUpdateLegacyKnowledgeEntryCommandV1({ ...update, patch: { tags: new Array(2) } }))
        assert.throws(() => contracts.parseDeleteLegacyKnowledgeEntryCommandV1({ ...del, entryId: 1 }))
        assert.throws(() => contracts.parseDeleteLegacyKnowledgeEntryCommandV1({ ...del, entryId: '  ' }))
    })

    const calls = []
    const port = {
        async create(entryId, value) { calls.push(['create', entryId, value]) },
        async update(entryId, patch) { calls.push(['update', entryId, patch]) },
        async delete(entryId) { calls.push(['delete', entryId]) },
    }
    const createHandler = createCreateLegacyKnowledgeEntryHandlerV1(port)
    const updateHandler = createUpdateLegacyKnowledgeEntryHandlerV1(port)
    const deleteHandler = createDeleteLegacyKnowledgeEntryHandlerV1(port)
    const created = await createHandler(create)
    const updated = await updateHandler(update)
    const deleted = await deleteHandler(del)
    check('exact owner mappings retain patch identity and order', () => assert.deepEqual(calls, [
        ['create', 'kb_1', data],
        ['update', 'kb_1', orderedPatch],
        ['delete', 'kb_1'],
    ]))
    check('results explicit', () => {
        assert.deepEqual(created, { contract: contracts.CREATE_LEGACY_KNOWLEDGE_ENTRY_RESULT_V1, created: true })
        assert.deepEqual(updated, { contract: contracts.UPDATE_LEGACY_KNOWLEDGE_ENTRY_RESULT_V1, updated: true })
        assert.deepEqual(deleted, { contract: contracts.DELETE_LEGACY_KNOWLEDGE_ENTRY_RESULT_V1, deleted: true })
    })
    const empty = await updateHandler({ ...update, patch: {} })
    check('empty patch skips persistence', () => {
        assert.equal(calls.length, 3)
        assert.deepEqual(empty, { contract: contracts.UPDATE_LEGACY_KNOWLEDGE_ENTRY_RESULT_V1, updated: false })
    })
    await checkAsync('invalid commands never persist', async () => {
        const before = calls.length
        await assert.rejects(createHandler({ ...create, data: { ...data, channels: 'telegram' } }))
        await assert.rejects(updateHandler({ ...update, patch: { priority: Number.NaN } }))
        await assert.rejects(deleteHandler({ ...del, entryId: null }))
        assert.equal(calls.length, before)
    })
    await checkAsync('owner failures remain visible', async () => {
        const failing = {
            async create() { throw new Error('create down') },
            async update() { throw new Error('update down') },
            async delete() { throw new Error('delete down') },
        }
        await assert.rejects(createCreateLegacyKnowledgeEntryHandlerV1(failing)(create), /create down/)
        await assert.rejects(createUpdateLegacyKnowledgeEntryHandlerV1(failing)(update), /update down/)
        await assert.rejects(createDeleteLegacyKnowledgeEntryHandlerV1(failing)(del), /delete down/)
    })
    await checkAsync('typed owner adapter preserves exact model operations and no-row semantics', async () => {
        const adapterCalls = []
        const prisma = {
            knowledgeBaseEntry: {
                async create(input) { adapterCalls.push(['create', input]) },
                async updateMany(input) { adapterCalls.push(['updateMany', input]); return { count: 0 } },
                async deleteMany(input) { adapterCalls.push(['deleteMany', input]); return { count: 0 } },
            },
        }
        const typescript = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
        const adapterSource = readFileSync(
            path.join(root, 'gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-prisma-legacy-knowledge-entry-adapter.ts'),
            'utf8',
        )
        const output = typescript.transpileModule(adapterSource, {
            compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
        }).outputText
        const module = { exports: {} }
        vm.runInNewContext(output, {
            module,
            exports: module.exports,
            Date,
            require(specifier) {
                if (specifier === '@/lib/prisma') return { prisma }
                throw new Error(`unexpected adapter import: ${specifier}`)
            },
        })
        const adapter = module.exports.legacyPrismaLegacyKnowledgeEntryPortV1
        await adapter.create('kb_1', data)
        await adapter.update('kb_1', {})
        await adapter.update('missing', orderedPatch)
        await adapter.delete('missing')
        assert.deepEqual(adapterCalls.map(([method]) => method), ['create', 'updateMany', 'deleteMany'])
        const createdData = adapterCalls[0][1].data
        assert.equal(createdData.id, 'kb_1')
        assert.equal(createdData.active, true)
        assert.deepEqual(createdData.sampleQuestions, data.sampleQuestions)
        assert.equal(createdData.createdAt, createdData.updatedAt)
        assert.equal(adapterCalls[1][1].where.id, 'missing')
        assert.equal(adapterCalls[1][1].data.priority, 4)
        assert.equal(adapterCalls[1][1].data.title, 'Обновлено')
        assert.equal(adapterCalls[1][1].data.active, false)
        assert.equal(adapterCalls[1][1].data.lastReviewedAt, adapterCalls[1][1].data.updatedAt)
        assert.equal(adapterCalls[2][1].where.id, 'missing')
    })
} finally {
    rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
