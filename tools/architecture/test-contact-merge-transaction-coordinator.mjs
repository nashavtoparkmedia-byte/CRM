#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const paths = {
  handler: 'gravity-mvp/src/modules/contacts/public/v1/contact-merge-handler.ts',
  contactsAdapter: 'gravity-mvp/src/modules/contacts/public/v1/legacy-prisma-contact-merge-adapter.ts',
  messagingAdapter: 'gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-contact-merge-adapter.ts',
  workAdapter: 'gravity-mvp/src/modules/work-management/public/v1/legacy-prisma-contact-merge-adapter.ts',
  composition: 'gravity-mvp/src/infrastructure/contact-merge-composition.ts',
  policy: 'architecture/enforcement/v1/policy.json',
  driverRoute: 'gravity-mvp/src/app/api/contacts/[id]/merge/route.ts',
  contactRoute: 'gravity-mvp/src/app/api/contacts/[id]/merge-to/[targetId]/route.ts',
}
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const require = createRequire(import.meta.url)
const typescript = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
const checks = []
const check = (name, run) => { run(); checks.push(name) }
const checkAsync = async (name, run) => { await run(); checks.push(name) }

function transpile(relative) {
  return typescript.transpileModule(read(relative), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
  }).outputText
}

function evaluate(relative, imports) {
  const module = { exports: {} }
  vm.runInNewContext(transpile(relative), {
    module, exports: module.exports,
    require(specifier) {
      if (Object.hasOwn(imports, specifier)) return imports[specifier]
      throw new Error(`unexpected import in ${relative}: ${specifier}`)
    },
    Array, Boolean, Error, JSON, Map, Object, Promise, Set, String,
  })
  return module.exports
}

check('Contacts defines closed ports without Prisma or arbitrary persistence capability', () => {
  const handler = read(paths.handler)
  assert.doesNotMatch(handler, /@prisma\/client|TransactionClient|PrismaPromise|\bPrisma\b|\$queryRaw|\$executeRaw/)
  assert.match(handler, /interface ContactMergeUnitOfWorkV1/)
  assert.doesNotMatch(handler, /\b(?:where|data|predicate|sql|table|model|transactionClient|tx)\s*[?:,(]/i)
})

check('owner adapters retain exact write capabilities and Contacts has no foreign-owner imports or writes', () => {
  const contacts = read(paths.contactsAdapter)
  const messaging = read(paths.messagingAdapter)
  const work = read(paths.workAdapter)
  assert.match(contacts, /export function makeLegacyPrismaContactMergeRepositoriesV1/)
  assert.doesNotMatch(contacts, /messaging\/public|work-management\/public|\.chat\.|\.task\./)
  // Four forward merge mutations plus one exact, guarded recovery mutation.
  assert.equal((messaging.match(/transaction\.chat\.updateMany\s*\(/g) || []).length, 5)
  // One forward merge mutation plus one exact, guarded recovery mutation.
  assert.equal((work.match(/transaction\.task\.updateMany\s*\(/g) || []).length, 2)
  assert.doesNotMatch(messaging, /\.message\.(?:create|update|updateMany|delete|deleteMany|upsert)\s*\(/i)
  assert.doesNotMatch(`${messaging}\n${work}`, /Promise\.all|\bcatch\b|\bretry\b|queueMicrotask|setTimeout|console\./)
})

check('platform composition is the sole transaction boundary and uses only named owner capabilities', () => {
  const composition = read(paths.composition)
  assert.match(composition, /@\/modules\/messaging\/public\/v1\/legacy-prisma-contact-merge-adapter/)
  assert.match(composition, /@\/modules\/work-management\/public\/v1\/legacy-prisma-contact-merge-adapter/)
  assert.match(composition, /@\/modules\/calling\/public\/v1\/legacy-prisma-contact-merge-adapter/)
  assert.match(composition, /@\/modules\/fleet-operations\/public\/v1\/legacy-prisma-contact-merge-adapter/)
  assert.equal((composition.match(/prisma\.\$transaction\s*\(/g) || []).length, 2)
  assert.equal((composition.match(/timeout:\s*15_000/g) || []).length, 2)
  assert.equal((composition.match(/isolationLevel:\s*'ReadCommitted'/g) || []).length, 2)
  assert.equal((composition.match(/maxWait:\s*2_000/g) || []).length, 2)
  assert.doesNotMatch(composition, /transaction\.(?:contact|contactIdentity|contactPhone|driver|chat|task)\./)
  assert.doesNotMatch(composition, /@prisma\/client|TransactionClient|PrismaPromise|\$queryRaw|\$executeRaw/)
})

await checkAsync('composition binds all owners to one sentinel transaction without exposing it to the handler', async () => {
  const sentinel = { id: 'single-transaction' }
  const transactions = []
  let capturedDependencies
  const calls = []
  const composition = evaluate(paths.composition, {
    '@/lib/prisma': { prisma: { async $transaction(operation, options) {
      transactions.push(options)
      return operation(sentinel)
    } } },
    '@/modules/contacts/public/v1': {
      createMergeContactsHandlerV1(dependencies) { capturedDependencies = dependencies; return async () => ({ status: 'unused' }) },
    },
    '@/modules/contacts/public/v1/legacy-prisma-contact-merge-adapter': {
      legacyPrismaContactMergeQueriesV1: { contacts: {}, fleet: {} },
      makeLegacyPrismaContactMergeRepositoriesV1(transaction) {
        assert.equal(transaction, sentinel)
        return {
          contacts: { linkContactToDriver: async () => calls.push('contacts.link') },
          recoveryContacts: { owner: 'contacts.recovery' },
        }
      },
    },
    '@/modules/messaging/public/v1/legacy-prisma-contact-merge-adapter': {
      makeMessagingContactMergeRepositories(transaction) {
        assert.equal(transaction, sentinel)
        return {
          attachUnlinkedContactChatsToDriver: async () => calls.push('messaging.attach'),
          recovery: { owner: 'messaging.recovery' },
        }
      },
    },
    '@/modules/work-management/public/v1/legacy-prisma-contact-merge-adapter': {
      makeWorkContactMergeRepositories(transaction) {
        assert.equal(transaction, sentinel)
        return {
          moveTasksToContact: async () => calls.push('work.move'),
          recovery: { owner: 'work.recovery' },
        }
      },
    },
    '@/modules/calling/public/v1/legacy-prisma-contact-merge-adapter': {
      makeCallingContactMergeRepositories(transaction) {
        assert.equal(transaction, sentinel)
        return {
          moveCallsToContact: async () => calls.push('calling.move'),
          recovery: { owner: 'calling.recovery' },
        }
      },
    },
    '@/modules/fleet-operations/public/v1/legacy-prisma-contact-merge-adapter': {
      makeFleetContactMergeRepositories(transaction) {
        assert.equal(transaction, sentinel)
        return {
          admitAutomaticMergeEvidenceRead: async () => calls.push('fleet.admit'),
          recovery: { owner: 'fleet.recovery' },
        }
      },
    },
  })
  assert.equal(typeof composition.mergeContactsV1, 'function')
  assert.ok(capturedDependencies)
  await capturedDependencies.unitOfWork.run(async (repositories) => {
    assert.deepEqual(Object.keys(repositories).sort(), ['calling', 'contacts', 'fleet', 'messaging', 'work'])
    await repositories.contacts.linkContactToDriver()
    await repositories.messaging.attachUnlinkedContactChatsToDriver()
    await repositories.work.moveTasksToContact()
    await repositories.calling.moveCallsToContact()
    await repositories.fleet.admitAutomaticMergeEvidenceRead()
  })
  await capturedDependencies.recoveryUnitOfWork.run(async (repositories) => {
    assert.deepEqual(Object.keys(repositories).sort(), ['calling', 'contacts', 'fleet', 'messaging', 'work'])
    assert.equal(repositories.contacts.owner, 'contacts.recovery')
    assert.equal(repositories.messaging.owner, 'messaging.recovery')
    assert.equal(repositories.work.owner, 'work.recovery')
    assert.equal(repositories.calling.owner, 'calling.recovery')
    assert.equal(repositories.fleet.owner, 'fleet.recovery')
  })
  assert.deepEqual(JSON.parse(JSON.stringify(transactions)), [
    { isolationLevel: 'ReadCommitted', maxWait: 2_000, timeout: 15_000 },
    { isolationLevel: 'ReadCommitted', maxWait: 2_000, timeout: 15_000 },
  ])
  assert.deepEqual(calls, ['contacts.link', 'messaging.attach', 'work.move', 'calling.move', 'fleet.admit'])
})

check('no exception is needed, Contact merge retains its facade, and legacy Driver merge is retired', () => {
  const policy = JSON.parse(read(paths.policy))
  assert.equal(policy.approved_infrastructure_writers.some((entry) => entry.file === paths.contactsAdapter), false)
  const driverRoute = read(paths.driverRoute)
  assert.match(driverRoute, /DRIVER_PERSON_CONFIRMATION_REQUIRED/)
  assert.doesNotMatch(driverRoute, /ContactMergeService|MergeError|mergeContactToDriver|contact-merge-composition/)
  const contactRoute = read(paths.contactRoute)
  assert.match(contactRoute, /ContactMergeService/)
  assert.match(contactRoute, /MergeError/)
  assert.doesNotMatch(contactRoute, /contact-merge-composition/)
})

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
