#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'

import { extractPrismaWrites } from './enforce-architecture.mjs'

const root = process.cwd()
const adapterPath =
  'gravity-mvp/src/modules/calling/public/v1/legacy-prisma-ai-agent-config-adapter.ts'
const credentialVaultPath =
  'gravity-mvp/src/modules/calling/application/ai-agent-provider-credential.ts'
const publicPath = 'gravity-mvp/src/modules/calling/public/v1/index.ts'
const ownershipPath = 'architecture/evidence/v1/data-ownership-candidates.json'
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const plain = (value) => JSON.parse(JSON.stringify(value))
const require = createRequire(import.meta.url)
const typescript = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
const checks = []
const check = (name, run) => { run(); checks.push(name) }
const checkAsync = async (name, run) => { await run(); checks.push(name) }

function loadAdapter(prisma) {
  const compilerOptions = {
    module: typescript.ModuleKind.CommonJS,
    target: typescript.ScriptTarget.ES2022,
  }
  const credentialOutput = typescript.transpileModule(read(credentialVaultPath), {
    compilerOptions,
  }).outputText
  const credentialModule = { exports: {} }
  vm.runInNewContext(credentialOutput, {
    module: credentialModule,
    exports: credentialModule.exports,
    require(specifier) {
      throw new Error(`unexpected credential vault import: ${specifier}`)
    },
  })

  const output = typescript.transpileModule(read(adapterPath), {
    compilerOptions: {
      ...compilerOptions,
    },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === '@/lib/prisma') return { prisma }
      if (specifier === '../../application/ai-agent-provider-credential') {
        return credentialModule.exports
      }
      throw new Error(`unexpected adapter import: ${specifier}`)
    },
  })
  return { ...credentialModule.exports, ...module.exports }
}

function harness(options = {}) {
  const rawCalls = []
  const reads = []
  const profileReads = []
  const upserts = []
  const prisma = {
    async $queryRaw(strings, ...values) {
      reads.push({ sql: strings.join('?'), values })
      return options.exists ? [{ id: 'singleton' }] : []
    },
    async $executeRawUnsafe(...call) {
      if (options.execute) return options.execute(...call)
      rawCalls.push(call)
      return options.affectedRows ?? 0
    },
    aiAgentProfile: {
      async findUnique(input) {
        profileReads.push(input)
        return options.profile ?? null
      },
    },
    aiAgentConfig: {
      async upsert(input) {
        upserts.push(input)
        if (options.upsertError) throw options.upsertError
        return { id: 'singleton' }
      },
    },
  }
  return { ...loadAdapter(prisma), profileReads, rawCalls, reads, upserts }
}

const bindOrder = [
  'enabled',
  'mode',
  'provider',
  'providerCredential',
  'classificationModel',
  'responseModel',
  'language',
  'confidenceThreshold',
  'maxAutoRepliesPerChat',
  'activeChannels',
  'escalationPolicy',
  'workingHours',
  'routingRules',
  'promptRole',
  'promptTone',
  'promptAllowed',
  'promptForbidden',
  'activeProfileId',
  'connectionStatus',
  'lastConnectionCheckAt',
  'extractionQualityTier',
  'extractionPromptVersion',
  'internEnabled',
]

await checkAsync('existence read remains a separate singleton SELECT', async () => {
  const { legacyPrismaAiAgentConfigPortV1: port, reads } = harness({ exists: true })
  assert.equal(await port.singletonExists(), true)
  assert.equal(reads.length, 1)
  assert.match(reads[0].sql, /SELECT id FROM "AiAgentConfig" WHERE id = 'singleton' LIMIT 1/)

  const absent = harness({ exists: false })
  assert.equal(await absent.legacyPrismaAiAgentConfigPortV1.singletonExists(), false)
})

await checkAsync('fixed INSERT and atomic UPDATE use exact 23-field presence/value bind order', async () => {
  const { legacyPrismaAiAgentConfigPortV1: port, rawCalls } = harness()
  const when = new Date('2026-08-10T01:02:03.000Z')
  const entries = [
    { field: 'internEnabled', value: false },
    { field: 'language', value: 'ru' },
    { field: 'lastConnectionCheckAt', value: when },
    { field: 'enabled', value: true },
    { field: 'routingRules', value: [{ route: 'operator' }] },
  ]
  await port.createSingleton(entries)
  await port.updateSingleton(entries)
  assert.equal(rawCalls.length, 2)

  for (const call of rawCalls) {
    assert.equal(call.length, 47)
    for (let index = 0; index < bindOrder.length; index += 1) {
      const expected = entries.find((entry) => entry.field === bindOrder[index])
      assert.equal(call[1 + index * 2], expected !== undefined, `${bindOrder[index]} presence`)
      assert.deepEqual(call[2 + index * 2], expected?.value ?? null, `${bindOrder[index]} value`)
    }
  }

  const insert = rawCalls[0][0]
  assert.match(insert, /^INSERT INTO "AiAgentConfig"/)
  assert.match(insert, /ELSE false END/)
  assert.match(insert, /ELSE 'off'::"AiAgentMode" END/)
  assert.match(insert, /ELSE 'anthropic'::"AiProviderType" END/)
  assert.match(insert, /ELSE 'claude-haiku-4-5'::text END/)
  assert.match(insert, /ELSE 'claude-sonnet-4-5'::text END/)
  assert.match(insert, /ELSE NULL::text\[\] END/)
  assert.match(insert, /ELSE 'balanced'::text END/)
  assert.match(insert, /ELSE true END, NOW\(\)\)$/)

  const update = rawCalls[1][0]
  assert.match(update, /^UPDATE "AiAgentConfig" SET/)
  assert.equal((update.match(/CASE WHEN \$\d+::boolean/g) || []).length, 23)
  assert.match(update, /"updatedAt" = NOW\(\) WHERE id = 'singleton'$/)
})

await checkAsync('credential reference is empty, authentic, one-shot and immediately discarded', async () => {
  let transient = randomBytes(48).toString('base64url')
  let matched = false
  let executions = 0
  const loaded = harness({
    async execute(_sql, ...args) {
      executions += 1
      matched = args[7] === transient
      args[7] = null
      return 0
    },
  })
  const reference = loaded.captureAiAgentProviderCredentialV1(transient)
  assert.equal(Object.isFrozen(reference), true)
  assert.deepEqual(Reflect.ownKeys(reference), [])
  await loaded.legacyPrismaAiAgentConfigPortV1.updateSingleton([
    { field: 'providerCredential', value: reference },
  ])
  assert.equal(matched, true)
  assert.equal(executions, 1)
  transient = ''

  await assert.rejects(
    loaded.legacyPrismaAiAgentConfigPortV1.updateSingleton([
      { field: 'providerCredential', value: reference },
    ]),
    /Invalid provider credential reference/,
  )
  assert.equal(executions, 1)
})

await checkAsync('forged opaque shape is rejected before persistence', async () => {
  let executions = 0
  const loaded = harness({ execute: async () => { executions += 1; return 0 } })
  await assert.rejects(
    loaded.legacyPrismaAiAgentConfigPortV1.createSingleton([
      { field: 'providerCredential', value: Object.freeze({}) },
    ]),
    /Invalid provider credential reference/,
  )
  assert.equal(executions, 0)
})

await checkAsync('fixed status/tier writes preserve DB NOW and zero-row success', async () => {
  const { legacyPrismaAiAgentConfigPortV1: port, rawCalls } = harness({ affectedRows: 0 })
  await port.recordSavedConnectionSuccess()
  await port.saveExtractionQualityTier('quality')
  assert.deepEqual(rawCalls, [
    [
      'UPDATE "AiAgentConfig" SET "connectionStatus" = \'ok\', "lastConnectionCheckAt" = NOW() WHERE id = \'singleton\'',
    ],
    [
      'UPDATE "AiAgentConfig" SET "extractionQualityTier" = $1::text, "updatedAt" = NOW() WHERE id = \'singleton\'',
      'quality',
    ],
  ])
})

await checkAsync('active profile retains exact read and Prisma upsert semantics', async () => {
  const profile = { id: 'profile-1' }
  const loaded = harness({ profile })
  const port = loaded.legacyPrismaAiAgentConfigPortV1
  assert.deepEqual(await port.findProfile('profile-1'), profile)
  await port.setActiveProfile(null)
  assert.deepEqual(plain(loaded.profileReads), [
    { where: { id: 'profile-1' }, select: { id: true } },
  ])
  assert.deepEqual(plain(loaded.upserts), [{
    where: { id: 'singleton' },
    update: { activeProfileId: null },
    create: { id: 'singleton', activeProfileId: null, activeChannels: [] },
  }])
})

await checkAsync('database and profile race errors remain visible', async () => {
  const marker = new Error('database marker')
  const rawFailure = harness({ execute: async () => { throw marker } })
  await assert.rejects(
    rawFailure.legacyPrismaAiAgentConfigPortV1.updateSingleton([
      { field: 'enabled', value: true },
    ]),
    marker,
  )
  const profileFailure = harness({ upsertError: marker })
  await assert.rejects(
    profileFailure.legacyPrismaAiAgentConfigPortV1.setActiveProfile('profile-race'),
    marker,
  )
})

check('real analyzer classifies the four raw writes as static AiAgentConfig writes', () => {
  const writes = extractPrismaWrites(read(adapterPath))
  const rawWrites = writes.filter((write) => write.kind === 'raw')
  assert.equal(rawWrites.length, 4)
  for (const write of rawWrites) {
    assert.equal(write.method, '$executeRawUnsafe')
    assert.equal(write.dynamic, false)
    assert.deepEqual(write.tables, ['AiAgentConfig'])
  }
  const upsert = writes.find((write) => write.method === 'upsert')
  assert.ok(upsert)
  assert.equal(upsert.model, 'aiAgentConfig')

  const ownership = JSON.parse(read(ownershipPath)).models.find(
    (candidate) => candidate.model === 'AiAgentConfig',
  )
  assert.ok(ownership)
  assert.equal(ownership.owner_candidate, 'ai_calls')
  const calling = JSON.parse(read('architecture/contexts/v1/manifests/calling.json'))
  assert.ok(calling.technical_modules.includes(ownership.owner_candidate))
})

check('adapter is closed to fixed persistence and credential retrieval stays private and one-shot', () => {
  const adapterSource = read(adapterPath)
  const credentialVault = read(credentialVaultPath)
  const publicSource = read(publicPath)
  assert.equal((adapterSource.match(/prisma\.\$executeRawUnsafe\s*\(/g) || []).length, 4)
  assert.doesNotMatch(adapterSource, /\$transaction|Prisma\.|TransactionClient|PrismaPromise/)
  assert.doesNotMatch(adapterSource, /\$executeRawUnsafe\s*\(\s*[A-Za-z_$]/)
  assert.doesNotMatch(adapterSource, /`(?:UPDATE|INSERT)[^`]*\$\{/)
  assert.match(credentialVault, /new WeakMap<OpaqueCredentialRefV1, string>\(\)/)
  assert.match(credentialVault, /credentialValues\.set\(reference, value\)/)
  const readIndex = credentialVault.indexOf('credentialValues.get(reference)')
  const deleteIndex = credentialVault.indexOf('credentialValues.delete(reference)')
  const returnIndex = credentialVault.indexOf('return value', readIndex)
  assert.ok(readIndex >= 0)
  assert.ok(deleteIndex > readIndex)
  assert.ok(returnIndex > deleteIndex)
  assert.match(adapterSource, /from '\.\.\/\.\.\/application\/ai-agent-provider-credential'/)
  assert.match(adapterSource, /revealAiAgentProviderCredentialV1\(entry\.value\)/)
  assert.doesNotMatch(
    adapterSource,
    /export\s+(?:function|const|\{)[^\n]*(?:reveal|unseal|read)[A-Za-z]*Credential/i,
  )
  assert.match(
    publicSource,
    /export\s*\{\s*captureAiAgentProviderCredentialV1\s*\}\s*from\s*['"]\.\.\/\.\.\/application\/ai-agent-provider-credential['"]/,
  )
  assert.doesNotMatch(publicSource, /(?:reveal|unseal|read)[A-Za-z]*Credential|credentialValues/i)
})

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
