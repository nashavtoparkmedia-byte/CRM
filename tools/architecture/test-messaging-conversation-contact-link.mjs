#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-conversation-contact-link-'))
const contractPath = 'gravity-mvp/src/contracts/messaging/v1/conversation-contact-link-command.ts'
const handlerPath = 'gravity-mvp/src/modules/messaging/public/v1/conversation-contact-link-handler.ts'
const adapterPath = 'gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-conversation-contact-link-adapter.ts'
const sources = [
  contractPath,
  'gravity-mvp/src/contracts/messaging/v1/index.ts',
  handlerPath,
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
const contracts = require(path.join(out, 'contracts/messaging/v1/index.js'))
const handlers = require(path.join(
  out,
  'modules/messaging/public/v1/conversation-contact-link-handler.js',
))
const typescript = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
const adapterSource = readFileSync(path.join(root, adapterPath), 'utf8')
const adapterOutput = typescript.transpileModule(adapterSource, {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
}).outputText

const checks = []
const check = (name, fn) => { fn(); checks.push(name) }
const checkAsync = async (name, fn) => { await fn(); checks.push(name) }
const plain = (value) => JSON.parse(JSON.stringify(value))
const command = {
  contract: contracts.ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1,
  chatId: 'chat-1',
  contactId: 'contact-1',
  contactIdentityId: 'identity-1',
}

function loadAdapter(prisma, consoleOverride = console) {
  const module = { exports: {} }
  vm.runInNewContext(adapterOutput, {
    module,
    exports: module.exports,
    console: consoleOverride,
    require(specifier) {
      if (specifier === '@/lib/prisma') return { prisma }
      throw new Error(`unexpected adapter import: ${specifier}`)
    },
  })
  return module.exports.legacyPrismaConversationContactLinkPortV1
}

function makePrisma({ chat = { driverId: null }, contact = { yandexDriverId: null }, driver = null } = {}) {
  const calls = []
  const prisma = {
    chat: {
      async findUnique(input) { calls.push(['chat.findUnique', input]); return chat },
      async update(input) { calls.push(['chat.update', input]); return { id: input.where.id } },
    },
    contact: {
      async findUnique(input) { calls.push(['contact.findUnique', input]); return contact },
    },
    driver: {
      async findUnique(input) { calls.push(['driver.findUnique', input]); return driver },
    },
  }
  return { prisma, calls }
}

try {
  check('command and result identifiers are exact and the public index exports them', () => {
    assert.equal(
      contracts.ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1,
      'messaging.EnsureConversationContactLinkCommand.v1',
    )
    assert.equal(
      contracts.ENSURE_CONVERSATION_CONTACT_LINK_RESULT_V1,
      'messaging.EnsureConversationContactLinkResult.v1',
    )
    assert.equal(typeof contracts.parseEnsureConversationContactLinkCommandV1, 'function')
  })

  check('strict parser accepts only the exact nonempty command', () => {
    assert.deepEqual(contracts.parseEnsureConversationContactLinkCommandV1(command), command)
    for (const invalid of [null, [], 'command', 1]) {
      assert.throws(() => contracts.parseEnsureConversationContactLinkCommandV1(invalid), (error) =>
        error.name === 'ConversationContactLinkCommandValidationError'
        && error.code === 'INVALID_CONTRACT')
    }
    assert.throws(() => contracts.parseEnsureConversationContactLinkCommandV1({ ...command, sql: 'x' }), (error) =>
      error.code === 'INVALID_CONTRACT')
    assert.throws(() => contracts.parseEnsureConversationContactLinkCommandV1({
      ...command,
      contract: 'messaging.EnsureConversationContactLinkCommand.v2',
    }), (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION')
    assert.throws(() => contracts.parseEnsureConversationContactLinkCommandV1({
      ...command,
      contract: 'contacts.EnsureConversationContactLinkCommand.v1',
    }), (error) => error.code === 'INVALID_CONTRACT')
    for (const field of ['chatId', 'contactId', 'contactIdentityId']) {
      for (const value of ['', '  ', null, 7]) {
        assert.throws(() => contracts.parseEnsureConversationContactLinkCommandV1({
          ...command,
          [field]: value,
        }), (error) => error.code === 'INVALID_CONTRACT')
      }
    }
  })

  await checkAsync('handler validates before the port and preserves the exact mapping and result', async () => {
    const calls = []
    const handler = handlers.createEnsureConversationContactLinkHandlerV1({
      async ensure(input) { calls.push(input) },
    })
    assert.deepEqual(await handler(command), {
      contract: contracts.ENSURE_CONVERSATION_CONTACT_LINK_RESULT_V1,
      completed: true,
    })
    assert.deepEqual(calls, [{
      chatId: 'chat-1',
      contactId: 'contact-1',
      contactIdentityId: 'identity-1',
    }])
    await assert.rejects(handler({ ...command, rawSql: 'x' }))
    await assert.rejects(handler({ ...command, chatId: '' }))
    assert.equal(calls.length, 1)
    await assert.rejects(handlers.createEnsureConversationContactLinkHandlerV1({
      async ensure() { throw new Error('owner write failed') },
    })(command), /owner write failed/)
  })

  await checkAsync('existing driver short-circuits enrichment and is never overwritten', async () => {
    const { prisma, calls } = makePrisma({ chat: { driverId: 'driver-existing' } })
    await loadAdapter(prisma).ensure({ chatId: 'chat-1', contactId: 'contact-1', contactIdentityId: 'identity-1' })
    assert.deepEqual(plain(calls), [
      ['chat.findUnique', { where: { id: 'chat-1' }, select: { driverId: true } }],
      ['chat.update', {
        where: { id: 'chat-1' },
        data: { contactId: 'contact-1', contactIdentityId: 'identity-1' },
      }],
    ])
    assert.equal(Object.hasOwn(calls[1][1].data, 'driverId'), false)
  })

  await checkAsync('missing chat still performs the exact contact link update', async () => {
    const { prisma, calls } = makePrisma({ chat: null })
    await loadAdapter(prisma).ensure({ chatId: 'chat-1', contactId: 'contact-1', contactIdentityId: 'identity-1' })
    assert.deepEqual(plain(calls), [
      ['chat.findUnique', { where: { id: 'chat-1' }, select: { driverId: true } }],
      ['chat.update', {
        where: { id: 'chat-1' },
        data: { contactId: 'contact-1', contactIdentityId: 'identity-1' },
      }],
    ])
  })

  await checkAsync('missing contact does not attempt a driver lookup', async () => {
    const { prisma, calls } = makePrisma({ chat: { driverId: null }, contact: null })
    await loadAdapter(prisma).ensure({ chatId: 'chat-1', contactId: 'contact-1', contactIdentityId: 'identity-1' })
    assert.deepEqual(plain(calls), [
      ['chat.findUnique', { where: { id: 'chat-1' }, select: { driverId: true } }],
      ['contact.findUnique', { where: { id: 'contact-1' }, select: { yandexDriverId: true } }],
      ['chat.update', {
        where: { id: 'chat-1' },
        data: { contactId: 'contact-1', contactIdentityId: 'identity-1' },
      }],
    ])
  })

  await checkAsync('null yandex driver identity does not attempt a driver lookup', async () => {
    const { prisma, calls } = makePrisma({
      chat: { driverId: null },
      contact: { yandexDriverId: null },
    })
    await loadAdapter(prisma).ensure({ chatId: 'chat-1', contactId: 'contact-1', contactIdentityId: 'identity-1' })
    assert.deepEqual(plain(calls), [
      ['chat.findUnique', { where: { id: 'chat-1' }, select: { driverId: true } }],
      ['contact.findUnique', { where: { id: 'contact-1' }, select: { yandexDriverId: true } }],
      ['chat.update', {
        where: { id: 'chat-1' },
        data: { contactId: 'contact-1', contactIdentityId: 'identity-1' },
      }],
    ])
  })

  await checkAsync('missing driver keeps the base update and exact lookup projection', async () => {
    const { prisma, calls } = makePrisma({
      chat: { driverId: null },
      contact: { yandexDriverId: 'ya-42' },
      driver: null,
    })
    await loadAdapter(prisma).ensure({ chatId: 'chat-1', contactId: 'contact-1', contactIdentityId: 'identity-1' })
    assert.deepEqual(plain(calls), [
      ['chat.findUnique', { where: { id: 'chat-1' }, select: { driverId: true } }],
      ['contact.findUnique', { where: { id: 'contact-1' }, select: { yandexDriverId: true } }],
      ['driver.findUnique', { where: { yandexDriverId: 'ya-42' }, select: { id: true } }],
      ['chat.update', {
        where: { id: 'chat-1' },
        data: { contactId: 'contact-1', contactIdentityId: 'identity-1' },
      }],
    ])
  })

  await checkAsync('found driver enriches the final write after all three ordered reads', async () => {
    const { prisma, calls } = makePrisma({
      chat: { driverId: null },
      contact: { yandexDriverId: 'ya-42' },
      driver: { id: 'driver-found' },
    })
    await loadAdapter(prisma).ensure({ chatId: 'chat-1', contactId: 'contact-1', contactIdentityId: 'identity-1' })
    assert.deepEqual(plain(calls), [
      ['chat.findUnique', { where: { id: 'chat-1' }, select: { driverId: true } }],
      ['contact.findUnique', { where: { id: 'contact-1' }, select: { yandexDriverId: true } }],
      ['driver.findUnique', { where: { yandexDriverId: 'ya-42' }, select: { id: true } }],
      ['chat.update', {
        where: { id: 'chat-1' },
        data: {
          contactId: 'contact-1',
          contactIdentityId: 'identity-1',
          driverId: 'driver-found',
        },
      }],
    ])
  })

  await checkAsync('every read and write failure propagates without retry or logging', async () => {
    const stages = ['chat.findUnique', 'contact.findUnique', 'driver.findUnique', 'chat.update']
    for (const failingStage of stages) {
      const calls = []
      const logs = []
      const invoke = async (stage, result) => {
        calls.push(stage)
        if (stage === failingStage) throw new Error(`${stage} failed`)
        return result
      }
      const prisma = {
        chat: {
          findUnique: () => invoke('chat.findUnique', { driverId: null }),
          update: () => invoke('chat.update', {}),
        },
        contact: { findUnique: () => invoke('contact.findUnique', { yandexDriverId: 'ya-42' }) },
        driver: { findUnique: () => invoke('driver.findUnique', { id: 'driver-found' }) },
      }
      const consoleTrap = new Proxy({}, {
        get: () => (...args) => { logs.push(args) },
      })
      await assert.rejects(
        loadAdapter(prisma, consoleTrap).ensure({
          chatId: 'chat-1', contactId: 'contact-1', contactIdentityId: 'identity-1',
        }),
        new RegExp(`${failingStage.replace('.', '\\.')} failed`),
      )
      assert.equal(calls.filter((stage) => stage === failingStage).length, 1)
      assert.equal(logs.length, 0)
    }
  })

  check('adapter has no transaction logging retry or generic persistence escape hatch', () => {
    assert.doesNotMatch(adapterSource, /\$transaction|console\.|\bcatch\b|\bretry\b/i)
    assert.doesNotMatch(adapterSource, /\$(?:query|execute)Raw|Unsafe|\bany\b/)
    assert.equal((adapterSource.match(/prisma\.chat\.findUnique/g) ?? []).length, 1)
    assert.equal((adapterSource.match(/prisma\.contact\.findUnique/g) ?? []).length, 1)
    assert.equal((adapterSource.match(/prisma\.driver\.findUnique/g) ?? []).length, 1)
    assert.equal((adapterSource.match(/prisma\.chat\.update/g) ?? []).length, 1)
  })
} finally {
  rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
