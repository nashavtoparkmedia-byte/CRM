#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-contact-conversation-owners-'))
const fleetContract = 'gravity-mvp/src/contracts/fleet-operations/v1/find-driver-by-exact-phone-query.ts'
const fleetHandler = 'gravity-mvp/src/modules/fleet-operations/public/v1/find-driver-by-exact-phone-handler.ts'
const fleetAdapter = 'gravity-mvp/src/modules/fleet-operations/public/v1/legacy-prisma-find-driver-by-exact-phone-adapter.ts'
const messagingContract = 'gravity-mvp/src/contracts/messaging/v1/contact-conversation-commands.ts'
const messagingHandler = 'gravity-mvp/src/modules/messaging/public/v1/contact-conversation-handler.ts'
const messagingAdapter = 'gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-contact-conversation-adapter.ts'
const sources = [
  fleetContract,
  'gravity-mvp/src/contracts/fleet-operations/v1/index.ts',
  fleetHandler,
  messagingContract,
  'gravity-mvp/src/contracts/messaging/v1/index.ts',
  messagingHandler,
].map((value) => path.join(root, value))

const compiled = spawnSync(process.execPath, [
  path.join(root, 'gravity-mvp/node_modules/typescript/bin/tsc'),
  '--target', 'ES2022',
  '--module', 'commonjs',
  '--moduleResolution', 'node',
  '--strict',
  '--skipLibCheck',
  '--rootDir', path.join(root, 'gravity-mvp/src'),
  '--outDir', out,
  ...sources,
], { encoding: 'utf8' })
if (compiled.status !== 0) {
  process.stderr.write(compiled.stdout + compiled.stderr)
  process.exit(1)
}

const require = createRequire(import.meta.url)
const ts = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
const fleetContracts = require(path.join(out, 'contracts/fleet-operations/v1/index.js'))
const fleetHandlers = require(path.join(out, 'modules/fleet-operations/public/v1/find-driver-by-exact-phone-handler.js'))
const messagingContracts = require(path.join(out, 'contracts/messaging/v1/index.js'))
const messagingHandlers = require(path.join(out, 'modules/messaging/public/v1/contact-conversation-handler.js'))
const checks = []
const check = (name, fn) => { fn(); checks.push(name) }
const checkAsync = async (name, fn) => { await fn(); checks.push(name) }
const plain = (value) => JSON.parse(JSON.stringify(value))

function transpile(file) {
  return ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
}

function loadAdapter(output, exportName, prisma) {
  const module = { exports: {} }
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === '@/lib/prisma') return { prisma }
      throw new Error(`unexpected adapter import: ${specifier}`)
    },
  })
  return module.exports[exportName]
}

const fleetAdapterOutput = transpile(fleetAdapter)
const messagingAdapterOutput = transpile(messagingAdapter)
const findCommand = {
  contract: messagingContracts.FIND_AND_BACKFILL_CONTACT_CONVERSATION_COMMAND_V1,
  contactId: 'contact-1',
  contactIdentityId: 'identity-1',
  channel: 'telegram',
  allowContactFallback: true,
}
const fallbackCommand = {
  contract: messagingContracts.OPEN_FALLBACK_CONTACT_CONVERSATION_COMMAND_V1,
  legacyDriverId: 'driver-1',
  channel: 'telegram',
  externalChatId: 'telegram:79990001122',
  name: 'Contact One',
  contactId: 'contact-1',
  contactIdentityId: 'identity-1',
}
const conversation = {
  id: 'chat-1',
  channel: 'telegram',
  externalChatId: 'telegram:legacy-user',
  status: 'open',
  contactId: null,
  contactIdentityId: null,
}
const select = {
  id: true,
  channel: true,
  externalChatId: true,
  status: true,
  contactId: true,
  contactIdentityId: true,
}
const orderBy = [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }]

try {
  check('exact identifiers, channel vocabulary and public facades are exported', () => {
    assert.equal(fleetContracts.FIND_DRIVER_BY_EXACT_PHONE_QUERY_V1, 'fleet_operations.FindDriverByExactPhoneQuery.v1')
    assert.equal(messagingContracts.FIND_AND_BACKFILL_CONTACT_CONVERSATION_COMMAND_V1, 'messaging.FindAndBackfillContactConversationCommand.v1')
    assert.equal(messagingContracts.OPEN_FALLBACK_CONTACT_CONVERSATION_COMMAND_V1, 'messaging.OpenFallbackContactConversationCommand.v1')
    assert.deepEqual(messagingContracts.CONTACT_CONVERSATION_CHANNELS_V1, ['telegram', 'whatsapp', 'max'])
    const fleetIndex = readFileSync(path.join(root, 'gravity-mvp/src/modules/fleet-operations/public/v1/index.ts'), 'utf8')
    const messagingIndex = readFileSync(path.join(root, 'gravity-mvp/src/modules/messaging/public/v1/index.ts'), 'utf8')
    assert.match(fleetIndex, /export const findDriverByExactPhoneV1=/)
    assert.match(messagingIndex, /export const findAndBackfillContactConversationV1=/)
    assert.match(messagingIndex, /export const openFallbackContactConversationV1=/)
  })

  check('strict parsers reject unknown fields, invalid values and later versions', () => {
    const fleet = { contract: fleetContracts.FIND_DRIVER_BY_EXACT_PHONE_QUERY_V1, phone: '+79990001122' }
    assert.deepEqual(fleetContracts.parseFindDriverByExactPhoneQueryV1(fleet), fleet)
    assert.deepEqual(messagingContracts.parseFindAndBackfillContactConversationCommandV1(findCommand), findCommand)
    assert.deepEqual(messagingContracts.parseOpenFallbackContactConversationCommandV1(fallbackCommand), fallbackCommand)
    assert.throws(() => fleetContracts.parseFindDriverByExactPhoneQueryV1({ ...fleet, sql: 'x' }))
    assert.throws(() => fleetContracts.parseFindDriverByExactPhoneQueryV1({ ...fleet, phone: '' }))
    assert.throws(() => fleetContracts.parseFindDriverByExactPhoneQueryV1({ ...fleet, contract: 'fleet_operations.FindDriverByExactPhoneQuery.v2' }), (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION')
    assert.throws(() => messagingContracts.parseFindAndBackfillContactConversationCommandV1({ ...findCommand, channel: 'phone' }))
    assert.throws(() => messagingContracts.parseOpenFallbackContactConversationCommandV1({ ...fallbackCommand, legacyDriverId: '' }))
    assert.throws(() => messagingContracts.parseOpenFallbackContactConversationCommandV1({ ...fallbackCommand, rawWhere: {} }))
    assert.throws(() => messagingContracts.parseOpenFallbackContactConversationCommandV1({ ...fallbackCommand, contract: 'messaging.OpenFallbackContactConversationCommand.v2' }), (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION')
  })

  await checkAsync('handlers validate first, map closed results and expose owner failures', async () => {
    const fleetCalls = []
    const fleet = fleetHandlers.createFindDriverByExactPhoneHandlerV1({
      async findByExactPhone(phone) { fleetCalls.push(phone); return { id: 'driver-1' } },
    })
    assert.deepEqual(await fleet({ contract: fleetContracts.FIND_DRIVER_BY_EXACT_PHONE_QUERY_V1, phone: '+79990001122' }), {
      contract: fleetContracts.FIND_DRIVER_BY_EXACT_PHONE_RESULT_V1,
      driverId: 'driver-1',
    })
    assert.deepEqual(fleetCalls, ['+79990001122'])
    const calls = []
    const port = {
      async findAndBackfill(input) { calls.push(['find', input]); return conversation },
      async openFallback(input) { calls.push(['fallback', input]); return { conversation, isNew: false } },
    }
    assert.equal((await messagingHandlers.createFindAndBackfillContactConversationHandlerV1(port)(findCommand)).conversation.id, 'chat-1')
    assert.equal((await messagingHandlers.createOpenFallbackContactConversationHandlerV1(port)(fallbackCommand)).isNew, false)
    assert.deepEqual(calls, [
      ['find', { contactId: 'contact-1', contactIdentityId: 'identity-1', channel: 'telegram', allowContactFallback: true }],
      ['fallback', { legacyDriverId: 'driver-1', channel: 'telegram', externalChatId: 'telegram:79990001122', name: 'Contact One', contactId: 'contact-1', contactIdentityId: 'identity-1' }],
    ])
    await assert.rejects(messagingHandlers.createFindAndBackfillContactConversationHandlerV1({
      async findAndBackfill() { throw new Error('owner failed') },
      async openFallback() { throw new Error('unused') },
    })(findCommand), /owner failed/)
  })

  await checkAsync('Fleet adapter performs the one exact phone lookup and projection', async () => {
    const calls = []
    const prisma = { driver: { async findFirst(input) { calls.push(input); return { id: 'driver-1' } } } }
    const port = loadAdapter(fleetAdapterOutput, 'legacyPrismaFindDriverByExactPhonePortV1', prisma)
    assert.deepEqual(plain(await port.findByExactPhone('+79990001122')), { id: 'driver-1' })
    assert.deepEqual(plain(calls), [{ where: { phone: '+79990001122' }, select: { id: true } }])
  })

  await checkAsync('contact lookup uses exact latest ordering and backfills only the missing identity', async () => {
    const calls = []
    const prisma = { chat: {
      async findFirst(input) { calls.push(['findFirst', input]); return { ...conversation, contactId: 'contact-1' } },
      async update(input) { calls.push(['update', input]); return {} },
    } }
    const port = loadAdapter(messagingAdapterOutput, 'legacyPrismaContactConversationPortV1', prisma)
    assert.deepEqual(plain(await port.findAndBackfill({ contactId: 'contact-1', contactIdentityId: 'identity-1', channel: 'telegram', allowContactFallback: true })), {
      ...conversation, contactId: 'contact-1', contactIdentityId: 'identity-1',
    })
    assert.deepEqual(plain(calls), [
      ['findFirst', { where: { contactIdentityId: 'identity-1', channel: 'telegram' }, orderBy, select }],
      ['update', { where: { id: 'chat-1' }, data: { contactIdentityId: 'identity-1' } }],
    ])
  })

  await checkAsync('fallback tries legacy driver then unique external id and preserves existing links', async () => {
    const calls = []
    const existing = { ...conversation, contactId: 'existing-contact', contactIdentityId: 'existing-identity' }
    const prisma = { chat: {
      async findFirst(input) { calls.push(['findFirst', input]); return null },
      async findUnique(input) { calls.push(['findUnique', input]); return existing },
      async update(input) { calls.push(['update', input]); return {} },
    } }
    const port = loadAdapter(messagingAdapterOutput, 'legacyPrismaContactConversationPortV1', prisma)
    const result = await port.openFallback({ ...fallbackCommand, contract: undefined })
    assert.equal(result.isNew, false)
    assert.deepEqual(plain(result.conversation), existing)
    assert.deepEqual(plain(calls), [
      ['findFirst', { where: { driverId: 'driver-1', channel: 'telegram' }, orderBy, select }],
      ['findUnique', { where: { externalChatId: 'telegram:79990001122' }, select }],
    ])
  })

  await checkAsync('missing fallback creates exactly one new linked conversation', async () => {
    const calls = []
    const created = { ...conversation, externalChatId: 'telegram:79990001122', status: 'new', contactId: 'contact-1', contactIdentityId: 'identity-1' }
    const prisma = { chat: {
      async findUnique(input) { calls.push(['findUnique', input]); return null },
      async create(input) { calls.push(['create', input]); return created },
    } }
    const port = loadAdapter(messagingAdapterOutput, 'legacyPrismaContactConversationPortV1', prisma)
    const result = await port.openFallback({ ...fallbackCommand, contract: undefined, legacyDriverId: null })
    assert.equal(result.isNew, true)
    assert.deepEqual(plain(calls), [
      ['findUnique', { where: { externalChatId: 'telegram:79990001122' }, select }],
      ['create', { data: { channel: 'telegram', externalChatId: 'telegram:79990001122', name: 'Contact One', status: 'new', contactId: 'contact-1', contactIdentityId: 'identity-1' }, select }],
    ])
  })
} finally {
  rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
