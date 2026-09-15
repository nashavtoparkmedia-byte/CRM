#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-archived-contact-owners-'))
const sourcePaths = [
  'gravity-mvp/src/contracts/contacts/v1/contact-retention-command.ts',
  'gravity-mvp/src/contracts/messaging/v1/contact-retention-command.ts',
  'gravity-mvp/src/contracts/work-management/v1/contact-retention-command.ts',
  'gravity-mvp/src/modules/contacts/public/v1/contact-retention-handler.ts',
  'gravity-mvp/src/modules/messaging/public/v1/contact-retention-handler.ts',
  'gravity-mvp/src/modules/work-management/public/v1/contact-retention-handler.ts',
].map(value => path.join(root, value))
const compiled = spawnSync(process.execPath, [
  path.join(root, 'gravity-mvp/node_modules/typescript/bin/tsc'),
  '--target', 'ES2022',
  '--module', 'commonjs',
  '--moduleResolution', 'node',
  '--strict',
  '--skipLibCheck',
  '--rootDir', path.join(root, 'gravity-mvp/src'),
  '--outDir', out,
  ...sourcePaths,
], { encoding: 'utf8' })

if (compiled.status !== 0) {
  process.stderr.write(compiled.stdout + compiled.stderr)
  process.exit(1)
}

const require = createRequire(import.meta.url)
const contacts = require(path.join(out, 'contracts/contacts/v1/contact-retention-command.js'))
const messaging = require(path.join(out, 'contracts/messaging/v1/contact-retention-command.js'))
const work = require(path.join(out, 'contracts/work-management/v1/contact-retention-command.js'))
const { createDeleteContactForRetentionHandlerV1 } = require(
  path.join(out, 'modules/contacts/public/v1/contact-retention-handler.js'),
)
const { createDetachContactConversationsHandlerV1 } = require(
  path.join(out, 'modules/messaging/public/v1/contact-retention-handler.js'),
)
const { createDetachContactTasksHandlerV1 } = require(
  path.join(out, 'modules/work-management/public/v1/contact-retention-handler.js'),
)
const typescript = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
const checks = []
const check = (name, fn) => { fn(); checks.push(name) }
const checkAsync = async (name, fn) => { await fn(); checks.push(name) }

function loadAdapter(relativePath, prisma) {
  const source = readFileSync(path.join(root, relativePath), 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === '@/lib/prisma') return { prisma }
      throw new Error(`unexpected adapter import: ${specifier}`)
    },
  })
  return module.exports
}

try {
  const contactId = 'contact-1'
  const contactCommand = { contract: contacts.DELETE_CONTACT_FOR_RETENTION_COMMAND_V1, contactId }
  const conversationCommand = { contract: messaging.DETACH_CONTACT_CONVERSATIONS_COMMAND_V1, contactId }
  const taskCommand = { contract: work.DETACH_CONTACT_TASKS_COMMAND_V1, contactId }
  const cases = [
    {
      name: 'contacts',
      contracts: contacts,
      command: contactCommand,
      parse: contacts.parseDeleteContactForRetentionCommandV1,
      commandId: 'contacts.DeleteContactForRetentionCommand.v1',
      resultId: 'contacts.DeleteContactForRetentionResult.v1',
      v2: 'contacts.DeleteContactForRetentionCommand.v2',
      handler: createDeleteContactForRetentionHandlerV1,
      portMethod: 'deleteContactForRetention',
      successOutcome: 'deleted',
    },
    {
      name: 'messaging',
      contracts: messaging,
      command: conversationCommand,
      parse: messaging.parseDetachContactConversationsCommandV1,
      commandId: 'messaging.DetachContactConversationsCommand.v1',
      resultId: 'messaging.DetachContactConversationsResult.v1',
      v2: 'messaging.DetachContactConversationsCommand.v2',
      handler: createDetachContactConversationsHandlerV1,
      portMethod: 'detachContactConversations',
    },
    {
      name: 'work',
      contracts: work,
      command: taskCommand,
      parse: work.parseDetachContactTasksCommandV1,
      commandId: 'work_management.DetachContactTasksCommand.v1',
      resultId: 'work_management.DetachContactTasksResult.v1',
      v2: 'work_management.DetachContactTasksCommand.v2',
      handler: createDetachContactTasksHandlerV1,
      portMethod: 'detachContactTasks',
    },
  ]

  check('command and result identifiers literal', () => {
    assert.equal(contacts.DELETE_CONTACT_FOR_RETENTION_COMMAND_V1, cases[0].commandId)
    assert.equal(contacts.DELETE_CONTACT_FOR_RETENTION_RESULT_V1, cases[0].resultId)
    assert.equal(messaging.DETACH_CONTACT_CONVERSATIONS_COMMAND_V1, cases[1].commandId)
    assert.equal(messaging.DETACH_CONTACT_CONVERSATIONS_RESULT_V1, cases[1].resultId)
    assert.equal(work.DETACH_CONTACT_TASKS_COMMAND_V1, cases[2].commandId)
    assert.equal(work.DETACH_CONTACT_TASKS_RESULT_V1, cases[2].resultId)
  })
  check('strict commands accept only exact contactId shape', () => {
    for (const entry of cases) {
      assert.deepEqual(entry.parse(entry.command), entry.command)
      assert.throws(() => entry.parse({ ...entry.command, contract: entry.v2 }), error =>
        error.code === 'UNSUPPORTED_CONTRACT_VERSION')
      assert.throws(() => entry.parse({ contract: entry.command.contract }))
      assert.throws(() => entry.parse({ ...entry.command, contactId: '' }))
      assert.throws(() => entry.parse({ ...entry.command, dryRun: false }))
      assert.throws(() => entry.parse({ ...entry.command, callContactId: contactId }))
      assert.throws(() => entry.parse({ ...entry.command, contactIdentityId: 'identity-1' }))
      assert.throws(() => entry.parse({ ...entry.command, transaction: {} }))
    }
  })
  await checkAsync('handlers map exactly and return explicit success', async () => {
    for (const entry of cases) {
      const calls = []
      const port = { async [entry.portMethod](id) { calls.push(id); return entry.successOutcome } }
      const result = await entry.handler(port)(entry.command)
      assert.deepEqual(calls, [contactId])
      assert.deepEqual(result, { contract: entry.resultId, completed: true })
    }
  })
  await checkAsync('invalid commands never reach owner ports', async () => {
    for (const entry of cases) {
      let calls = 0
      const port = { async [entry.portMethod]() { calls += 1 } }
      await assert.rejects(entry.handler(port)({ ...entry.command, contactId: '' }))
      await assert.rejects(entry.handler(port)({ ...entry.command, callContactId: contactId }))
      assert.equal(calls, 0)
    }
  })
  await checkAsync('owner failures remain visible', async () => {
    for (const entry of cases) {
      const port = { async [entry.portMethod]() { throw new Error(`${entry.name} down`) } }
      await assert.rejects(entry.handler(port)(entry.command), new RegExp(`${entry.name} down`))
    }
  })
  await checkAsync('Messaging and Work adapters keep exact literal positional SQL', async () => {
    const calls = []
    const prisma = {
      async $executeRawUnsafe(...args) { calls.push(args); return 0 },
    }
    const messagingAdapter = loadAdapter(
      'gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-contact-retention-adapter.ts',
      prisma,
    ).legacyPrismaContactConversationRetentionPortV1
    const workAdapter = loadAdapter(
      'gravity-mvp/src/modules/work-management/public/v1/legacy-prisma-contact-retention-adapter.ts',
      prisma,
    ).legacyPrismaContactTaskRetentionPortV1
    await messagingAdapter.detachContactConversations(contactId)
    await workAdapter.detachContactTasks(contactId)
    assert.deepEqual(calls, [
      [
        'UPDATE "Chat" SET "contactId" = NULL, "contactIdentityId" = NULL WHERE "contactId" = $1',
        contactId,
      ],
      ['UPDATE "tasks" SET "contactId" = NULL WHERE "contactId" = $1', contactId],
    ])
  })
  await checkAsync('Contacts handler preserves missing success and exposes eligibility drift', async () => {
    const outcomes = ['missing', 'ineligible']
    const calls = []
    const port = {
      async deleteContactForRetention(id) {
        calls.push(id)
        return outcomes.shift()
      },
    }
    const handler = createDeleteContactForRetentionHandlerV1(port)
    const result = await handler(contactCommand)
    assert.deepEqual(calls, [contactId])
    assert.deepEqual(result, {
      contract: contacts.DELETE_CONTACT_FOR_RETENTION_RESULT_V1,
      completed: true,
    })
    await assert.rejects(handler(contactCommand), error =>
      error.code === contacts.CONTACT_RETENTION_ELIGIBILITY_CHANGED_V1)
    assert.deepEqual(calls, [contactId, contactId])
  })
} finally {
  rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
