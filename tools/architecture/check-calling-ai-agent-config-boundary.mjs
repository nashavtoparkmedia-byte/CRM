#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { extractPrismaWrites, scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const readJson = (relative) => JSON.parse(read(relative))
const checks = []
const check = (name, run) => { run(); checks.push(name) }

const actionsPath = 'gravity-mvp/src/app/settings/ai/actions.ts'
const contractPath = 'gravity-mvp/src/contracts/calling/v1/ai-agent-config-commands.ts'
const handlerPath =
  'gravity-mvp/src/modules/calling/public/v1/ai-agent-config-handler.ts'
const adapterPath =
  'gravity-mvp/src/modules/calling/public/v1/legacy-prisma-ai-agent-config-adapter.ts'
const publicPath = 'gravity-mvp/src/modules/calling/public/v1/index.ts'
const amendmentPath =
  'architecture/isolation/calling/ai-agent-config-v1/module-manifest-amendments.json'

const retiredFingerprints = [
  'arch_72b270b1fc3c03ccc58b1c9f',
  'arch_4b0b29ed845be05d5ef139df',
  'arch_e5df8b423e9cc7981de3ab1a',
  'arch_cb1d5db547da28c32be32d70',
  'arch_d4c8bd3927c6aaaf4956a4cd',
]

const commandPairs = [
  ['SAVE_AI_AGENT_CONFIG_COMMAND_V1', 'saveAiAgentConfigV1'],
  [
    'RECORD_SAVED_AI_CONNECTION_SUCCESS_COMMAND_V1',
    'recordSavedAiConnectionSuccessV1',
  ],
  ['SET_ACTIVE_AI_PROFILE_COMMAND_V1', 'setActiveAiProfileV1'],
  ['SAVE_EXTRACTION_QUALITY_TIER_COMMAND_V1', 'saveExtractionQualityTierV1'],
]

const actions = read(actionsPath)
const contracts = read(contractPath)
const handler = read(handlerPath)
const adapter = read(adapterPath)
const publicSurface = read(publicPath)

check('Configuration invokes all four versioned Calling commands', () => {
  for (const [constant, runtime] of commandPairs) {
    assert.match(actions, new RegExp(`\\b${constant}\\b`))
    assert.match(actions, new RegExp(`\\b${runtime}\\(`))
  }
})

check('all five foreign AiAgentConfig writes are absent from the caller', () => {
  const writes = extractPrismaWrites(actions).filter((write) => (
    write.model === 'aiAgentConfig' || write.tables?.includes('AiAgentConfig')
  ))
  assert.deepEqual(writes, [])
  assert.doesNotMatch(actions, /prisma\.aiAgentConfig\.(?:create|update|updateMany|upsert|delete)/)
})

check('save caller maps the legacy credential to an opaque token and returns no secret', () => {
  assert.match(actions, /field === 'apiKeyEncrypted'/)
  assert.match(actions, /field: 'providerCredential'/)
  assert.match(actions, /captureAiAgentProviderCredentialV1\(data\[field\]\)/)
  assert.match(actions, /field === 'providerCredential'/)
  assert.match(actions, /field: '__unsupported_provider_credential__', value: null/)
  assert.match(actions, /return \{ id: 'singleton', \.\.\.safeResult \}/)
  assert.doesNotMatch(actions, /return \{ id: 'singleton', \.\.\.data \}/)
  assert.match(actions, /includesProviderCredential[\s\S]*ошибка сохранения учётных данных/)
  assert.doesNotMatch(actions, /console\.(?:log|error)[^\n]*data/)
})

check('caller retains authorization, provider orchestration, validation and revalidation', () => {
  const save = actions.slice(actions.indexOf('export async function saveAiConfig'), actions.indexOf('/** PR9.19'))
  const savedConnection = actions.slice(
    actions.indexOf('export async function testSavedConnection'),
    actions.indexOf('export async function testAiConnection'),
  )
  const activeProfile = actions.slice(
    actions.indexOf('export async function setActiveAiProfile'),
    actions.indexOf('// ─── AI Knowledge Core'),
  )
  const tier = actions.slice(
    actions.indexOf('export async function saveExtractionQualityTier'),
    actions.indexOf('/** Текущий tier'),
  )
  assert.match(save, /await assertCanEditAi\(\)/)
  assert.match(save, /revalidatePath\('\/settings\/ai'\)/)
  assert.match(savedConnection, /await testAiConnection\(/)
  assert.match(savedConnection, /if \(result\.ok\)/)
  assert.match(savedConnection, /catch \{ \/\* silent \*\/ \}/)
  assert.match(activeProfile, /await assertCanEditAi\(\)/)
  assert.match(activeProfile, /revalidatePath\('\/settings\/ai'\)/)
  assert.match(tier, /\['economy', 'balanced', 'quality'\]\.includes\(tier\)/)
  assert.match(tier, /throw new Error\('Недопустимый tier'\)/)
  assert.match(tier, /revalidatePath\('\/settings\/ai'\)/)
})

check('public contract is a strict ordered 23-field union without a credential value', () => {
  const fieldBlock = contracts.slice(
    contracts.indexOf('AI_AGENT_CONFIG_PATCH_FIELDS_V1'),
    contracts.indexOf('] as const', contracts.indexOf('AI_AGENT_CONFIG_PATCH_FIELDS_V1')),
  )
  assert.equal((fieldBlock.match(/^  '[^']+',?$/gm) || []).length, 23)
  assert.match(contracts, /type OpaqueCredentialRefV1/)
  assert.match(contracts, /Reflect\.ownKeys\(value\)\.length === 0/)
  assert.match(contracts, /duplicate patch field:/)
  assert.match(contracts, /unsupported patch field:/)
  assert.doesNotMatch(contracts, /apiKeyEncrypted/)
  assert.doesNotMatch(contracts, /credentialValue|rawCredential|secretValue/i)
})

check('handler retains no transaction/catch and only semantic port capabilities', () => {
  assert.match(handler, /interface AiAgentConfigPersistencePortV1/)
  for (const capability of [
    'singletonExists',
    'createSingleton',
    'updateSingleton',
    'recordSavedConnectionSuccess',
    'findProfile',
    'setActiveProfile',
    'saveExtractionQualityTier',
  ]) assert.match(handler, new RegExp(`\\b${capability}\\b`))
  assert.doesNotMatch(handler, /@\/lib\/prisma|\$transaction|\bcatch\b/)
  assert.match(handler, /if \(parsed\.profileId\)/)
  assert.match(handler, /throw new Error\('Профиль не найден'\)/)
})

check('adapter has fixed SQL, DB NOW and private one-shot credential storage', () => {
  const writes = extractPrismaWrites(adapter)
  assert.equal(writes.length, 5)
  assert.equal(writes.filter((write) => write.kind === 'raw').length, 4)
  assert.ok(writes.every((write) => write.kind !== 'raw' || write.dynamic === false))
  assert.ok(writes.every((write) => (
    write.model === 'aiAgentConfig' || write.tables?.includes('AiAgentConfig')
  )))
  assert.match(adapter, /new WeakMap<OpaqueCredentialRefV1, string>\(\)/)
  assert.match(adapter, /credentialValues\.delete\(reference\)/)
  assert.doesNotMatch(adapter, /export function (?:reveal|unseal|read).*Credential/i)
  assert.equal((adapter.match(/"updatedAt" = NOW\(\)/g) || []).length, 2)
  assert.equal((adapter.match(/NOW\(\)/g) || []).length, 4)
  assert.doesNotMatch(adapter, /\$transaction/)
})

check('public surface exports only credential capture, not retrieval', () => {
  assert.match(publicSurface, /export\{captureAiAgentProviderCredentialV1\}/)
  assert.doesNotMatch(publicSurface, /revealCredential|unsealCredential|credentialValues/)
  for (const [, runtime] of commandPairs) assert.match(publicSurface, new RegExp(`\\b${runtime}\\b`))
})

check('Calling amendment adds exactly the four reviewed commands', () => {
  const amendment = readJson(amendmentPath)
  assert.equal(amendment.schema, 'yoko.crm.module-manifest-amendments.v1')
  assert.equal(amendment.version, 1)
  assert.equal(amendment.amendments.length, 1)
  assert.equal(amendment.amendments[0].context, 'calling')
  assert.deepEqual(amendment.amendments[0].add_commands, [
    'SaveAiAgentConfigCommand.v1',
    'RecordSavedAiConnectionSuccessCommand.v1',
    'SetActiveAiProfileCommand.v1',
    'SaveExtractionQualityTierCommand.v1',
  ])
})

const scan = await scanArchitecture(root)
const currentIds = new Set(scan.findings.map((finding) => finding.fingerprint))
const registry = readJson(scan.policy.exception_registry)
const registryIds = new Set(registry.exceptions.map((exception) => exception.fingerprint))

check('only the exact five reviewed D4 findings retire without replacement', () => {
  for (const fingerprint of retiredFingerprints) assert.equal(currentIds.has(fingerprint), false)
  const additions = [...currentIds].filter((fingerprint) => !registryIds.has(fingerprint))
  assert.deepEqual(additions, [])
  assert.equal(
    scan.findings.filter((finding) => finding.rule === 'direct_foreign_prisma_write').length,
    48,
  )
})

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  passed: checks.length,
  findings: scan.findings.length,
  checks,
}, null, 2)}\n`)
