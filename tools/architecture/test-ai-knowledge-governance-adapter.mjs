#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import { extractPrismaWrites } from './enforce-architecture.mjs'

const root = process.cwd()
const adapterPath = 'gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-prisma-knowledge-governance-adapter.ts'
const ownershipPath = 'architecture/evidence/v1/data-ownership-candidates.json'
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const plain = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const require = createRequire(import.meta.url)
const typescript = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
const checks = []
const check = (name, run) => { run(); checks.push(name) }
const checkAsync = async (name, run) => { await run(); checks.push(name) }

function loadAdapter(execute) {
  const output = typescript.transpileModule(read(adapterPath), {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  const prisma = new Proxy({ $executeRawUnsafe: execute }, {
    get(target, property, receiver) {
      if (property === '$executeRawUnsafe') return Reflect.get(target, property, receiver)
      throw new Error(`unexpected Prisma capability: ${String(property)}`)
    },
  })
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === '@/lib/prisma') return { prisma }
      throw new Error(`unexpected adapter import: ${specifier}`)
    },
    Array,
    Object,
    Promise,
  })
  return module.exports.legacyPrismaKnowledgeGovernancePortV1
}

const fieldSpecs = [
  { bit: 1, key: 'title', value: 'Title', sql: '"title" = $' },
  { bit: 2, key: 'canonicalStatement', value: 'Statement', sql: '"canonicalStatement" = $' },
  { bit: 4, key: 'tags', value: ['one', 'two'], sql: '"tags" = $', cast: '::text[]' },
  { bit: 8, key: 'safetyLevel', value: 'sensitive', sql: '"safetyLevel" = $', cast: '::"AiKnowledgeSafety"' },
]

function expectedEdit(mask) {
  const selected = fieldSpecs.filter((field) => (mask & field.bit) !== 0)
  const assignments = selected.map(
    (field, index) => `${field.sql}${index + 1}${field.cast ?? ''}`,
  )
  return {
    input: {
      itemId: `item-${mask}`,
      patch: Object.fromEntries(selected.map((field) => [field.key, field.value])),
    },
    call: [
      `UPDATE "AiKnowledgeItem" SET ${assignments.join(', ')}, "updatedAt" = NOW() WHERE id = $${selected.length + 1}`,
      ...selected.map((field) => field.value),
      `item-${mask}`,
    ],
  }
}

const fixedCases = [
  ['archiveItem', { itemId: 'archive' }, [
    'UPDATE "AiKnowledgeItem" SET status = \'archived\'::"AiKnowledgeStatus", "isActive" = false, "updatedAt" = NOW() WHERE id = $1',
    'archive',
  ]],
  ['restoreItem', { itemId: 'restore' }, [
    'UPDATE "AiKnowledgeItem" SET status = \'active\'::"AiKnowledgeStatus", "isActive" = true, "updatedAt" = NOW() WHERE id = $1',
    'restore',
  ]],
  ['verifyItem', { itemId: 'verify', actorId: 'actor' }, [
    'UPDATE "AiKnowledgeItem" SET "isVerified" = true, "verifiedBy" = $1, "verifiedAt" = NOW(), "updatedAt" = NOW() WHERE id = $2',
    'actor', 'verify',
  ]],
  ['unverifyItem', { itemId: 'unverify' }, [
    'UPDATE "AiKnowledgeItem" SET "isVerified" = false, "verifiedBy" = NULL, "verifiedAt" = NULL, "updatedAt" = NOW() WHERE id = $1',
    'unverify',
  ]],
  ['supersedeItem', { oldItemId: 'old', newItemId: 'new' }, [
    'UPDATE "AiKnowledgeItem" SET status = \'superseded\'::"AiKnowledgeStatus", "isActive" = false, "supersededByItemId" = $1, "updatedAt" = NOW() WHERE id = $2',
    'new', 'old',
  ]],
  ['archiveConflictMember', { itemId: 'loser' }, [
    'UPDATE "AiKnowledgeItem" SET status = \'archived\'::"AiKnowledgeStatus", "isActive" = false, "conflictGroupId" = NULL, "updatedAt" = NOW() WHERE id = $1',
    'loser',
  ]],
  ['clearConflictWinner', { itemId: 'winner' }, [
    'UPDATE "AiKnowledgeItem" SET "conflictGroupId" = NULL, "updatedAt" = NOW() WHERE id = $1',
    'winner',
  ]],
  ['clearConflictGroup', { conflictGroupId: 'group' }, [
    'UPDATE "AiKnowledgeItem" SET "conflictGroupId" = NULL, "updatedAt" = NOW() WHERE "conflictGroupId" = $1',
    'group',
  ]],
  ['createManualItem', {
    itemId: 'manual', sectionId: 'section', title: 'Title', canonicalStatement: 'Statement',
    tags: ['type:manual'], safetyLevel: 'normal', actorId: 'actor',
  }, [
    'INSERT INTO "AiKnowledgeItem" (id, "sectionId", title, "canonicalStatement", tags, confidence, "sourceCount", "uniqueManagerCount", status, "isActive", "safetyLevel", "isVerified", "verifiedBy", "verifiedAt", "createdBy", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5::text[], 0.95, 0, 0, \'active\'::"AiKnowledgeStatus", true, $6::"AiKnowledgeSafety", true, $7, NOW(), $8, NOW(), NOW())',
    'manual', 'section', 'Title', 'Statement', ['type:manual'], 'normal', 'actor', 'actor',
  ]],
  ['markSourcesDisabled', { itemId: 'warning' }, [
    'UPDATE "AiKnowledgeItem" SET tags = array_append(tags, \'sources_all_disabled\'), "updatedAt" = NOW() WHERE id = $1',
    'warning',
  ]],
  ['archiveAfterSourceDisable', { itemId: 'source-archive' }, [
    'UPDATE "AiKnowledgeItem" SET status = \'archived\'::"AiKnowledgeStatus", "isActive" = false, "updatedAt" = NOW() WHERE id = $1',
    'source-archive',
  ]],
  ['archiveForCoreReset', { itemId: 'reset' }, [
    'UPDATE "AiKnowledgeItem" SET status = \'archived\'::"AiKnowledgeStatus", "isActive" = false, "updatedAt" = NOW() WHERE id = $1',
    'reset',
  ]],
]

await checkAsync('all 15 non-empty edit masks execute one exact fixed statement', async () => {
  const calls = []
  const adapter = loadAdapter(async (...args) => { calls.push(plain(args)); return 0 })
  for (let mask = 1; mask <= 15; mask += 1) {
    const expected = expectedEdit(mask)
    const before = calls.length
    await adapter.editItem(expected.input)
    assert.equal(calls.length, before + 1, `mask ${mask} must execute exactly once`)
    assert.deepEqual(calls.at(-1), expected.call, `mask ${mask} SQL/binds drifted`)
  }
  const before = calls.length
  await adapter.editItem({ itemId: 'empty', patch: {} })
  assert.equal(calls.length, before, 'empty mask must not execute')
})

await checkAsync('all 12 non-edit mutations retain exact fixed SQL and bind order', async () => {
  const calls = []
  const adapter = loadAdapter(async (...args) => { calls.push(plain(args)); return 0 })
  for (const [method, input, expected] of fixedCases) {
    const before = calls.length
    await adapter[method](input)
    assert.equal(calls.length, before + 1, `${method} must execute exactly once`)
    assert.deepEqual(calls.at(-1), expected, `${method} SQL/binds drifted`)
  }
})

await checkAsync('zero affected rows remain success and every database error propagates', async () => {
  const zeroAdapter = loadAdapter(async () => 0)
  for (let mask = 1; mask <= 15; mask += 1) await zeroAdapter.editItem(expectedEdit(mask).input)
  for (const [method, input] of fixedCases) await zeroAdapter[method](input)

  let marker = ''
  const failingAdapter = loadAdapter(async () => { throw new Error(`db:${marker}`) })
  for (let mask = 1; mask <= 15; mask += 1) {
    marker = `edit-${mask}`
    await assert.rejects(failingAdapter.editItem(expectedEdit(mask).input), new RegExp(`db:${marker}`))
  }
  for (const [method, input] of fixedCases) {
    marker = method
    await assert.rejects(failingAdapter[method](input), new RegExp(`db:${method}`))
  }
})

check('real analyzer classifies every raw write as static AiKnowledgeItem ownership', () => {
  const writes = extractPrismaWrites(read(adapterPath))
  assert.equal(writes.length, 27)
  for (const write of writes) {
    assert.equal(write.kind, 'raw')
    assert.equal(write.method, '$executeRawUnsafe')
    assert.equal(write.dynamic, false)
    assert.deepEqual(write.tables, ['AiKnowledgeItem'])
  }
  const ownership = JSON.parse(read(ownershipPath)).models.find(
    (candidate) => candidate.model === 'AiKnowledgeItem',
  )
  assert.ok(ownership)
  assert.equal(ownership.owner_candidate, 'ai_knowledge')
  assert.equal(ownership.schema, 'gravity-mvp/prisma/schema.prisma')
})

check('adapter exposes no generic persistence or transaction capability', () => {
  const source = read(adapterPath)
  assert.equal((source.match(/prisma\.\$executeRawUnsafe\s*\(/g) || []).length, 27)
  assert.doesNotMatch(source, /\$transaction|\$queryRaw|\$executeRaw`|Prisma\.|TransactionClient|PrismaPromise/)
  assert.doesNotMatch(source, /`UPDATE|`INSERT|\$\{[^}]+\}/)
  assert.match(source, /import \{ prisma \} from '@\/lib\/prisma'/)
  assert.match(source, /import type \{ KnowledgeGovernancePersistencePortV1 \}/)
})

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
