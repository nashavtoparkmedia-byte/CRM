#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const require = createRequire(import.meta.url)
const typescript = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
const source = readFileSync(path.join(root, 'gravity-mvp/src/lib/RetentionCleanup.ts'), 'utf8')
const output = typescript.transpileModule(source, {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
}).outputText
const checks = []
const checkAsync = async (name, fn) => { await fn(); checks.push(name) }
const plain = value => JSON.parse(JSON.stringify(value))

const constants = {
  contacts: {
    CONTACT_RETENTION_ELIGIBILITY_CHANGED_V1: 'CONTACT_RETENTION_ELIGIBILITY_CHANGED',
    DELETE_CONTACT_FOR_RETENTION_COMMAND_V1: 'contacts.DeleteContactForRetentionCommand.v1',
  },
  fleet: {
    RUN_API_LOG_RETENTION_COMMAND_V1: 'fleet_operations.RunApiLogRetentionCommand.v1',
    RUN_COMMUNICATION_EVENT_RETENTION_COMMAND_V1: 'fleet_operations.RunCommunicationEventRetentionCommand.v1',
    RUN_DRIVER_EVENT_RETENTION_COMMAND_V1: 'fleet_operations.RunDriverEventRetentionCommand.v1',
  },
  messaging: {
    DELETE_RETAINED_MESSAGES_COMMAND_V1: 'messaging.DeleteRetainedMessagesCommand.v1',
    DETACH_CONTACT_CONVERSATIONS_COMMAND_V1: 'messaging.DetachContactConversationsCommand.v1',
    PURGE_MESSAGE_RETRY_METADATA_COMMAND_V1: 'messaging.PurgeMessageRetryMetadataCommand.v1',
  },
  work: {
    DETACH_CONTACT_TASKS_COMMAND_V1: 'work_management.DetachContactTasksCommand.v1',
  },
}

function loadCleanup({
  candidates,
  dependencies,
  failStage = null,
  failContactId = null,
  ineligibleContactId = null,
}) {
  const reads = []
  const ownerCalls = []
  const logs = []
  const dependencyRows = dependencies.map(value => [value])
  const prisma = {
    async $queryRaw(strings, ...values) {
      const sql = strings.join('$PARAM')
      reads.push({ sql, values: Array.from(values) })
      if (sql.includes('SELECT id FROM "Contact"')) return candidates.map(id => ({ id }))
      if (sql.includes('SELECT id FROM "Message"')) return []
      if (sql.includes('SELECT\n          (SELECT count(*)::int FROM "Chat"')) {
        const next = dependencyRows.shift()
        if (next === undefined) throw new Error('missing dependency fixture')
        return next
      }
      throw new Error(`unexpected fixture query: ${sql}`)
    },
  }
  const maybeFail = (stage, contactId) => {
    if (failStage === stage && (failContactId === null || failContactId === contactId)) {
      throw new Error(`${stage} failure`)
    }
  }
  const contactsModule = {
    async deleteContactForRetentionV1(command) {
      ownerCalls.push(['contacts', command.contactId, command.contract])
      maybeFail('contacts', command.contactId)
      if (command.contactId === ineligibleContactId) {
        const error = new Error('retention eligibility changed')
        error.code = constants.contacts.CONTACT_RETENTION_ELIGIBILITY_CHANGED_V1
        throw error
      }
      return { contract: 'contacts.DeleteContactForRetentionResult.v1', completed: true }
    },
  }
  const fleetModule = {
    async runApiLogRetentionV1() { return { selectedCount: 0 } },
    async runCommunicationEventRetentionV1() { return { selectedCount: 0 } },
    async runDriverEventRetentionV1() { return { selectedCount: 0 } },
  }
  const messagingModule = {
    async deleteRetainedMessagesV1() { throw new Error('empty fixture must not delete messages') },
    async purgeMessageRetryMetadataV1() { throw new Error('empty fixture must not purge metadata') },
    async detachContactConversationsV1(command) {
      ownerCalls.push(['messaging', command.contactId, command.contract])
      maybeFail('messaging', command.contactId)
      return { contract: 'messaging.DetachContactConversationsResult.v1', completed: true }
    },
  }
  const workModule = {
    async detachContactTasksV1(command) {
      ownerCalls.push(['work', command.contactId, command.contract])
      maybeFail('work', command.contactId)
      return { contract: 'work_management.DetachContactTasksResult.v1', completed: true }
    },
  }
  const module = { exports: {} }
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require(specifier) {
      const modules = {
        '@/lib/prisma': { prisma },
        '@/infrastructure/operations/operational-log': {
          operationalLogV1(level, event, context) { logs.push([level, event, plain(context)]) },
        },
        '@/contracts/contacts/v1': constants.contacts,
        '@/contracts/fleet-operations/v1': constants.fleet,
        '@/contracts/messaging/v1': constants.messaging,
        '@/contracts/work-management/v1': constants.work,
        '@/modules/contacts/public/v1': contactsModule,
        '@/modules/fleet-operations/public/v1': fleetModule,
        '@/modules/messaging/public/v1': messagingModule,
        '@/modules/work-management/public/v1': workModule,
      }
      if (Object.prototype.hasOwnProperty.call(modules, specifier)) return modules[specifier]
      throw new Error(`unexpected RetentionCleanup import: ${specifier}`)
    },
  })
  return { RetentionCleanup: module.exports.RetentionCleanup, reads, ownerCalls, logs }
}

await checkAsync('dry run counts safe candidates and skips dependencies without owner writes', async () => {
  const fixture = loadCleanup({
    candidates: ['safe-dry', 'merge-skip'],
    dependencies: [
      { activeChats: 0, recentMessages: 0, merges: 0 },
      { activeChats: 0, recentMessages: 0, merges: 1 },
    ],
  })
  const result = await fixture.RetentionCleanup._cleanupArchivedContacts(365, 50, true)
  assert.deepEqual(plain(result), { deleted: 1, skipped: 1 })
  assert.deepEqual(fixture.ownerCalls, [])
})

await checkAsync('selection and dependency reads retain exact scope and equal-time order remains unspecified', async () => {
  const fixture = loadCleanup({
    candidates: ['safe'],
    dependencies: [{ activeChats: 0, recentMessages: 0, merges: 0 }],
  })
  await fixture.RetentionCleanup._cleanupArchivedContacts(365, 50, true)
  assert.equal(fixture.reads.length, 2)
  const selection = fixture.reads[0]
  assert.match(selection.sql, /FROM "Contact"\s+WHERE "isArchived" = true/s)
  assert.match(selection.sql, /"updatedAt" < \(NOW\(\) AT TIME ZONE 'UTC'\) - CAST\(\$PARAM AS INTERVAL\)/s)
  assert.match(selection.sql, /ORDER BY "updatedAt" ASC\s+LIMIT \$PARAM/s)
  assert.deepEqual(selection.values, ['365 days', 50])
  assert.doesNotMatch(selection.sql, /ORDER BY[^\n]*(?:,|\bid\b)/)
  const dependencies = fixture.reads[1]
  assert.match(dependencies.sql, /FROM "Chat" WHERE "contactId" = \$PARAM AND status != 'resolved'/)
  assert.match(dependencies.sql, /FROM "Message" m\s+JOIN "Chat" c ON c\.id = m\."chatId"/s)
  assert.match(dependencies.sql, /m\."sentAt" > \(NOW\(\) AT TIME ZONE 'UTC'\) - INTERVAL '30 days'/)
  assert.match(dependencies.sql, /FROM "ContactMerge" WHERE "survivorId" = \$PARAM OR "mergedId" = \$PARAM/)
  assert.deepEqual(dependencies.values, ['safe', 'safe', 'safe', 'safe'])
  assert.doesNotMatch(dependencies.sql, /\bCall\b|ContactIdentity|inconsistent/i)
})

await checkAsync('real run skips all three dependency classes and orders owner commands for the safe row', async () => {
  const fixture = loadCleanup({
    candidates: ['chat-skip', 'message-skip', 'merge-skip', 'missing-final-contact'],
    dependencies: [
      { activeChats: 1, recentMessages: 0, merges: 0 },
      { activeChats: 0, recentMessages: 1, merges: 0 },
      { activeChats: 0, recentMessages: 0, merges: 1 },
      { activeChats: 0, recentMessages: 0, merges: 0 },
    ],
  })
  const result = await fixture.RetentionCleanup._cleanupArchivedContacts(365, 50, false)
  assert.deepEqual(plain(result), { deleted: 1, skipped: 3 })
  assert.deepEqual(fixture.ownerCalls, [
    ['messaging', 'missing-final-contact', constants.messaging.DETACH_CONTACT_CONVERSATIONS_COMMAND_V1],
    ['work', 'missing-final-contact', constants.work.DETACH_CONTACT_TASKS_COMMAND_V1],
    ['contacts', 'missing-final-contact', constants.contacts.DELETE_CONTACT_FOR_RETENTION_COMMAND_V1],
  ])
})

await checkAsync('each owner failure is visible and prevents subsequent owner calls', async () => {
  const expected = {
    messaging: ['messaging'],
    work: ['messaging', 'work'],
    contacts: ['messaging', 'work', 'contacts'],
  }
  for (const stage of Object.keys(expected)) {
    const fixture = loadCleanup({
      candidates: ['failed-contact'],
      dependencies: [{ activeChats: 0, recentMessages: 0, merges: 0 }],
      failStage: stage,
    })
    await assert.rejects(
      fixture.RetentionCleanup._cleanupArchivedContacts(365, 50, false),
      new RegExp(`${stage} failure`),
    )
    assert.deepEqual(fixture.ownerCalls.map(([owner]) => owner), expected[stage])
  }
})

await checkAsync('Contacts eligibility drift is skipped while unexpected owner failures remain visible', async () => {
  const fixture = loadCleanup({
    candidates: ['stale-contact', 'still-eligible'],
    dependencies: [
      { activeChats: 0, recentMessages: 0, merges: 0 },
      { activeChats: 0, recentMessages: 0, merges: 0 },
    ],
    ineligibleContactId: 'stale-contact',
  })
  const result = await fixture.RetentionCleanup._cleanupArchivedContacts(365, 50, false)
  assert.deepEqual(plain(result), { deleted: 1, skipped: 1 })
  assert.deepEqual(fixture.ownerCalls, [
    ['messaging', 'stale-contact', constants.messaging.DETACH_CONTACT_CONVERSATIONS_COMMAND_V1],
    ['work', 'stale-contact', constants.work.DETACH_CONTACT_TASKS_COMMAND_V1],
    ['contacts', 'stale-contact', constants.contacts.DELETE_CONTACT_FOR_RETENTION_COMMAND_V1],
    ['messaging', 'still-eligible', constants.messaging.DETACH_CONTACT_CONVERSATIONS_COMMAND_V1],
    ['work', 'still-eligible', constants.work.DETACH_CONTACT_TASKS_COMMAND_V1],
    ['contacts', 'still-eligible', constants.contacts.DELETE_CONTACT_FOR_RETENTION_COMMAND_V1],
  ])
})

await checkAsync('outer run keeps contact counts zero when a later candidate fails after prior mutation', async () => {
  const fixture = loadCleanup({
    candidates: ['already-mutated', 'later-failure'],
    dependencies: [
      { activeChats: 0, recentMessages: 0, merges: 0 },
      { activeChats: 0, recentMessages: 0, merges: 0 },
    ],
    failStage: 'work',
    failContactId: 'later-failure',
  })
  const result = await fixture.RetentionCleanup.runAll(false)
  assert.equal(result.deletedArchivedContacts, 0)
  assert.equal(result.skippedContacts, 0)
  assert.deepEqual(fixture.ownerCalls, [
    ['messaging', 'already-mutated', constants.messaging.DETACH_CONTACT_CONVERSATIONS_COMMAND_V1],
    ['work', 'already-mutated', constants.work.DETACH_CONTACT_TASKS_COMMAND_V1],
    ['contacts', 'already-mutated', constants.contacts.DELETE_CONTACT_FOR_RETENTION_COMMAND_V1],
    ['messaging', 'later-failure', constants.messaging.DETACH_CONTACT_CONVERSATIONS_COMMAND_V1],
    ['work', 'later-failure', constants.work.DETACH_CONTACT_TASKS_COMMAND_V1],
  ])
  assert.equal(fixture.logs.some(([, event]) => event === 'retention_cleanup_error'), true)
})

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
