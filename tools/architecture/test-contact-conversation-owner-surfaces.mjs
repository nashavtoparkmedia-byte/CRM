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
  identityExternalId: 'legacy-user',
  exactExternalChatIds: ['telegram:legacy-user'],
  providerAccountId: 'telegram-account-1',
  allowContactFallback: true,
}
const fallbackCommand = {
  contract: messagingContracts.OPEN_FALLBACK_CONTACT_CONVERSATION_COMMAND_V1,
  legacyDriverId: 'driver-1',
  channel: 'telegram',
  identityExternalId: '79990001122',
  exactExternalChatIds: ['telegram:79990001122'],
  name: 'Contact One',
  contactId: 'contact-1',
  contactIdentityId: 'identity-1',
  providerAccountId: 'telegram-account-1',
}
const conversation = {
  id: 'chat-1',
  channel: 'telegram',
  externalChatId: 'telegram:legacy-user',
  status: 'open',
  contactId: 'contact-1',
  contactIdentityId: 'identity-1',
  metadata: {
    providerAccountId: 'telegram-account-1',
    connectionId: 'telegram-connection-1',
  },
}
const select = {
  id: true,
  channel: true,
  externalChatId: true,
  status: true,
  contactId: true,
  contactIdentityId: true,
  metadata: true,
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
    assert.match(fleetIndex, /\bfindDriverByExactPhoneV1\b/)
    assert.match(messagingIndex, /\bfindAndBackfillContactConversationV1\b/)
    assert.match(messagingIndex, /\bopenFallbackContactConversationV1\b/)
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
    assert.throws(() => messagingContracts.parseFindAndBackfillContactConversationCommandV1({ ...findCommand, externalChatId: 'max:legacy-user' }))
    assert.throws(() => messagingContracts.parseOpenFallbackContactConversationCommandV1({ ...fallbackCommand, legacyDriverId: '' }))
    assert.throws(() => messagingContracts.parseOpenFallbackContactConversationCommandV1({ ...fallbackCommand, externalChatId: 'whatsapp:79990001122' }))
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
      async openFallback(input) { calls.push(['fallback', input]); return { status: 'ready', conversation, isNew: false } },
    }
    assert.equal((await messagingHandlers.createFindAndBackfillContactConversationHandlerV1(port)(findCommand)).conversation.id, 'chat-1')
    assert.equal((await messagingHandlers.createOpenFallbackContactConversationHandlerV1(port)(fallbackCommand)).isNew, false)
    assert.deepEqual(calls, [
      ['find', { contactId: 'contact-1', contactIdentityId: 'identity-1', channel: 'telegram', identityExternalId: 'legacy-user', exactExternalChatIds: ['telegram:legacy-user'], providerAccountId: 'telegram-account-1', allowContactFallback: true }],
      ['fallback', { legacyDriverId: 'driver-1', channel: 'telegram', identityExternalId: '79990001122', exactExternalChatIds: ['telegram:79990001122'], name: 'Contact One', contactId: 'contact-1', contactIdentityId: 'identity-1', providerAccountId: 'telegram-account-1' }],
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

  await checkAsync('exact identity lookup is bounded, owner exact and read-only', async () => {
    const calls = []
    const prisma = { chat: {
      async findMany(input) { calls.push(['findMany', input]); return [conversation] },
      async updateMany(input) { calls.push(['updateMany', input]); throw new Error('unexpected update') },
    } }
    const port = loadAdapter(messagingAdapterOutput, 'legacyPrismaContactConversationPortV1', prisma)
    assert.deepEqual(plain(await port.findAndBackfill({ ...findCommand, contract: undefined })), {
      id: 'chat-1',
      channel: 'telegram',
      externalChatId: 'telegram:legacy-user',
      status: 'open',
      contactId: 'contact-1',
      contactIdentityId: 'identity-1',
      providerAccountId: 'telegram-account-1',
      transportConnectionId: 'telegram-connection-1',
    })
    assert.deepEqual(plain(calls), [[
      'findMany',
      {
        where: { contactIdentityId: 'identity-1', channel: 'telegram' },
        orderBy,
        take: 2,
        select,
      },
    ]])
  })

  await checkAsync('incomplete legacy ownership is never backfilled across the owner boundary', async () => {
    const calls = []
    const prisma = { chat: {
      async findMany(input) { calls.push(['findMany', input]); return [{ ...conversation, contactIdentityId: null }] },
      async updateMany(input) { calls.push(['updateMany', input]); throw new Error('unexpected update') },
    } }
    const port = loadAdapter(messagingAdapterOutput, 'legacyPrismaContactConversationPortV1', prisma)
    assert.equal(await port.findAndBackfill({ ...findCommand, contract: undefined, allowContactFallback: false }), null)
    assert.equal(calls.some(([operation]) => operation === 'updateMany'), false)
  })

  await checkAsync('fallback reuses only an exact owner pair with a proven transport', async () => {
    const calls = []
    const existing = { ...conversation, externalChatId: 'telegram:79990001122' }
    const prisma = { chat: {
      async findMany(input) { calls.push(['findMany', input]); return [existing] },
    } }
    const port = loadAdapter(messagingAdapterOutput, 'legacyPrismaContactConversationPortV1', prisma)
    const result = await port.openFallback({ ...fallbackCommand, contract: undefined })
    assert.equal(result.status, 'ready')
    assert.equal(result.isNew, false)
    assert.equal(result.conversation.externalChatId, 'telegram:79990001122')
    assert.deepEqual(plain(calls), [[
      'findMany',
      {
        where: { channel: 'telegram', externalChatId: { in: ['telegram:79990001122'] } },
        orderBy,
        take: 2,
        select,
      },
    ]])
  })

  await checkAsync('missing provider conversation target fails closed without creation', async () => {
    const calls = []
    const prisma = { chat: {
      async findMany(input) { calls.push(['findMany', input]); return [] },
      async create(input) { calls.push(['create', input]); throw new Error('unexpected create') },
    } }
    const port = loadAdapter(messagingAdapterOutput, 'legacyPrismaContactConversationPortV1', prisma)
    assert.deepEqual(plain(await port.openFallback({ ...fallbackCommand, contract: undefined })), {
      status: 'transport_unbound',
    })
    assert.equal(calls.some(([operation]) => operation === 'create'), false)
  })
} finally {
  rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
