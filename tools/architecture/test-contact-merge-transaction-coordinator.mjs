#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const paths = {
  contract: 'gravity-mvp/src/contracts/contacts/v1/merge-contacts-command.ts',
  contractIndex: 'gravity-mvp/src/contracts/contacts/v1/index.ts',
  handler: 'gravity-mvp/src/modules/contacts/public/v1/contact-merge-handler.ts',
  adapter: 'gravity-mvp/src/modules/contacts/public/v1/legacy-prisma-contact-merge-adapter.ts',
  publicIndex: 'gravity-mvp/src/modules/contacts/public/v1/index.ts',
  facade: 'gravity-mvp/src/lib/ContactMergeService.ts',
  policy: 'architecture/enforcement/v1/policy.json',
  driverRoute: 'gravity-mvp/src/app/api/contacts/[id]/merge/route.ts',
  contactRoute: 'gravity-mvp/src/app/api/contacts/[id]/merge-to/[targetId]/route.ts',
  drawer: 'gravity-mvp/src/app/messages/components/ContactProfileDrawer.tsx',
}

const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const plain = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const sha256 = (relative) => createHash('sha256').update(read(relative)).digest('hex')
const require = createRequire(import.meta.url)
const typescript = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
const checks = []
const check = (name, run) => { run(); checks.push(name) }
const checkAsync = async (name, run) => { await run(); checks.push(name) }

function transpile(relative) {
  return typescript.transpileModule(read(relative), {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText
}

function evaluate(relative, imports) {
  const module = { exports: {} }
  vm.runInNewContext(transpile(relative), {
    module,
    exports: module.exports,
    require(specifier) {
      if (Object.hasOwn(imports, specifier)) return imports[specifier]
      throw new Error(`unexpected import in ${relative}: ${specifier}`)
    },
    Array,
    Boolean,
    console,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Object,
    Promise,
    Set,
    String,
  })
  return module.exports
}

function sourceFile(relative) {
  return typescript.createSourceFile(
    relative,
    read(relative),
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  )
}

function findDeclaration(relative, kind, name) {
  const file = sourceFile(relative)
  const declaration = file.statements.find((statement) => kind(statement) && statement.name?.text === name)
  assert.ok(declaration, `${name} is missing from ${relative}`)
  return { file, declaration }
}

function literalUnion(relative, name) {
  const { declaration } = findDeclaration(relative, typescript.isTypeAliasDeclaration, name)
  const nodes = typescript.isUnionTypeNode(declaration.type) ? declaration.type.types : [declaration.type]
  return nodes.map((node) => {
    assert.ok(typescript.isLiteralTypeNode(node) && typescript.isStringLiteral(node.literal), `${name} must be a string-literal union`)
    return node.literal.text
  }).sort()
}

function discriminatedUnionShape(relative, name, discriminator) {
  const { declaration } = findDeclaration(relative, typescript.isTypeAliasDeclaration, name)
  assert.ok(typescript.isUnionTypeNode(declaration.type), `${name} must remain a union`)
  return declaration.type.types.map((node) => {
    assert.ok(typescript.isTypeLiteralNode(node), `${name} members must be closed object types`)
    const members = node.members.map((member) => {
      assert.ok(typescript.isPropertySignature(member) && member.name, `${name} may contain properties only`)
      assert.equal(member.questionToken, undefined, `${name}.${member.name.getText()} must not be optional`)
      return member
    })
    const discriminant = members.find((member) => member.name.getText() === discriminator)
    assert.ok(discriminant && typescript.isLiteralTypeNode(discriminant.type) && typescript.isStringLiteral(discriminant.type.literal))
    return [discriminant.type.literal.text, members.map((member) => member.name.getText()).sort()]
  }).sort(([left], [right]) => left.localeCompare(right))
}

function interfaceMethods(relative, name) {
  const { declaration } = findDeclaration(relative, typescript.isInterfaceDeclaration, name)
  return declaration.members.map((member) => {
    assert.ok(typescript.isMethodSignature(member), `${name} must expose named methods only`)
    assert.equal(member.typeParameters, undefined, `${name}.${member.name.getText()} must not expose a generic capability`)
    return member.name.getText()
  }).sort()
}

const contracts = evaluate(paths.contract, {})
const handlerModule = evaluate(paths.handler, {
  '../../../../contracts/contacts/v1': contracts,
})

const driverCommand = {
  contract: 'contacts.MergeContactsCommand.v1',
  operation: 'contact_to_driver',
  contactId: 'source-1',
  driverId: 'driver-1',
  mergedBy: 'manager-1',
}
const contactCommand = {
  contract: 'contacts.MergeContactsCommand.v1',
  operation: 'contact_to_contact',
  sourceId: 'source-1',
  targetId: 'target-1',
  mergedBy: 'manager-1',
}

const source = {
  id: 'source-1',
  displayName: 'Source Name',
  displayNameSource: 'telegram',
  masterSource: 'telegram',
  yandexDriverId: null,
  notes: 'source note',
  tags: ['one', 'two'],
  isArchived: false,
  phones: [
    { id: 'phone-duplicate', phone: '+70000000001', isPrimary: true, source: 'telegram', isActive: true },
    { id: 'phone-unique', phone: '+70000000002', isPrimary: false, source: 'manual', isActive: true },
  ],
  identities: [
    { id: 'identity-duplicate', channel: 'telegram', externalId: 'same', displayName: 'Old', reachabilityStatus: 'reachable' },
    { id: 'identity-unique', channel: 'max', externalId: 'unique', displayName: null, reachabilityStatus: 'unknown' },
  ],
  chats: [{ id: 'chat-1' }],
  tasks: [{ id: 'task-1' }],
}
const driver = { id: 'driver-1', yandexDriverId: 'yandex-1', fullName: 'Driver Name' }
const survivor = {
  id: 'target-1',
  yandexDriverId: 'yandex-1',
  isArchived: false,
  phones: [{ id: 'target-phone', phone: '+70000000001' }],
  identities: [{ id: 'target-identity', channel: 'telegram', externalId: 'same' }],
}

function makeHarness(options = {}) {
  const events = []
  const selected = (name, fallback) => Object.hasOwn(options, name) ? options[name] : fallback
  const record = (name) => async (...args) => { events.push([name, ...plain(args)]) }
  const repositories = {
    contacts: {
      lockContactPairOrdered: record('contacts.lock'),
      linkContactToDriver: record('contacts.link'),
      deleteDuplicateIdentities: record('contacts.delete-identities'),
      moveIdentitiesToContact: record('contacts.move-identities'),
      deleteDuplicatePhones: record('contacts.delete-phones'),
      movePhonesToContact: record('contacts.move-phones'),
      async recordMerge(input) {
        events.push(['contacts.record-merge', plain(input)])
        return input.id
      },
      archiveContact: record('contacts.archive'),
    },
    fleet: {
      async findDriverIdByYandexDriverId(id) {
        events.push(['fleet.find-driver', id])
        return selected('targetDriverId', 'target-driver-physical')
      },
    },
    messaging: {
      remapChatsToIdentity: record('messaging.remap-identity'),
      moveChatsToContact: record('messaging.move-contact'),
      moveChatsToDriverContact: record('messaging.move-driver-contact'),
      attachUnlinkedContactChatsToDriver: record('messaging.attach-driver'),
    },
    work: { moveTasksToContact: record('work.move-tasks') },
  }
  const dependencies = {
    queries: {
      contacts: {
        async findSourceContact(id) {
          events.push(['query.source', id])
          return selected('source', source)
        },
        async findTargetContact(id) {
          events.push(['query.target', id])
          return selected('target', survivor)
        },
        async findSurvivorByYandexDriverId(id) {
          events.push(['query.survivor', id])
          return selected('survivor', survivor)
        },
        async hasCompletedMerge(sourceId, targetId) {
          events.push(['query.completed-merge', sourceId, targetId])
          return selected('hasCompletedMerge', false)
        },
      },
      fleet: {
        async findDriverById(id) {
          events.push(['query.driver', id])
          return selected('driver', driver)
        },
      },
    },
    unitOfWork: {
      async runSimpleLink(operation) {
        events.push(['uow.simple:start'])
        await operation({
          contacts: { linkContactToDriver: repositories.contacts.linkContactToDriver },
          messaging: { attachUnlinkedContactChatsToDriver: repositories.messaging.attachUnlinkedContactChatsToDriver },
        })
        events.push(['uow.simple:end'])
      },
      async runMerge(operation) {
        events.push(['uow.merge:start'])
        await operation(repositories)
        events.push(['uow.merge:end'])
      },
    },
    generateMergeRecordId: () => 'merge-fixed',
    log(message) { events.push(['log', message]) },
  }
  return {
    events,
    merge: handlerModule.createMergeContactsHandlerV1(dependencies),
  }
}

check('exact closed Contacts command, result, and error contracts', () => {
  assert.equal(contracts.MERGE_CONTACTS_COMMAND_V1, 'contacts.MergeContactsCommand.v1')
  assert.equal(contracts.MERGE_CONTACTS_RESULT_V1, 'contacts.MergeContactsResult.v1')
  assert.deepEqual(contracts.parseMergeContactsCommandV1(driverCommand), driverCommand)
  assert.deepEqual(contracts.parseMergeContactsCommandV1(contactCommand), contactCommand)
  for (const invalid of [
    null,
    [],
    { ...driverCommand, contactId: 7 },
    { ...driverCommand, operation: 'raw_sql' },
    { ...driverCommand, where: { id: 'source-1' } },
    { ...contactCommand, data: { arbitrary: true } },
  ]) {
    assert.throws(() => contracts.parseMergeContactsCommandV1(invalid), (error) => error.code === 'INVALID_CONTRACT')
  }
  assert.deepEqual(
    contracts.parseMergeContactsCommandV1({ ...driverCommand, contactId: '' }),
    { ...driverCommand, contactId: '' },
  )
  assert.throws(
    () => contracts.parseMergeContactsCommandV1({ ...driverCommand, contract: 'contacts.MergeContactsCommand.v2' }),
    (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
  )
  assert.deepEqual(discriminatedUnionShape(paths.contract, 'MergeContactsCommandV1', 'operation'), [
    ['contact_to_contact', ['contract', 'mergedBy', 'operation', 'sourceId', 'targetId']],
    ['contact_to_driver', ['contactId', 'contract', 'driverId', 'mergedBy', 'operation']],
  ])
  assert.deepEqual(discriminatedUnionShape(paths.contract, 'MergeContactsResultV1', 'status'), [
    ['already_linked', ['contactId', 'contract', 'driverId', 'status']],
    ['already_merged', ['contract', 'sourceId', 'status', 'targetId']],
    ['contact_merged', ['contract', 'mergeRecordId', 'mergedId', 'status', 'survivorId']],
    ['linked', ['contactId', 'contract', 'driverId', 'status']],
    ['merged', ['contract', 'driverId', 'mergeRecordId', 'mergedId', 'status', 'survivorId']],
  ])
  assert.deepEqual(literalUnion(paths.handler, 'ContactMergeErrorCodeV1'), [
    'ALREADY_MERGED',
    'CONTACT_ARCHIVED',
    'CONTACT_LINKED_TO_OTHER_DRIVER',
    'CONTACT_NOT_FOUND',
    'DRIVER_NOT_FOUND',
    'INVALID_MERGE_STATE',
    'SELF_MERGE',
    'SOURCE_HAS_DRIVER',
    'SURVIVOR_ARCHIVED',
  ])
  assert.match(read(paths.contractIndex), /export \* from '\.\/merge-contacts-command'/)
})

check('public contract and named ports expose no persistence or arbitrary transaction capability', () => {
  assert.doesNotMatch(read(paths.contract), /@prisma\/client|TransactionClient|PrismaPromise|\bPrisma\b|\$queryRaw|\$executeRaw|\bSQL\b/i)
  const expectedMethods = {
    ContactMergeContactsQueryRepositoryV1: ['findSourceContact', 'findSurvivorByYandexDriverId', 'findTargetContact', 'hasCompletedMerge'],
    ContactMergeFleetQueryRepositoryV1: ['findDriverById'],
    ContactMergeSimpleLinkContactsRepositoryV1: ['linkContactToDriver'],
    ContactMergeContactsRepositoryV1: ['archiveContact', 'deleteDuplicateIdentities', 'deleteDuplicatePhones', 'lockContactPairOrdered', 'moveIdentitiesToContact', 'movePhonesToContact', 'recordMerge'],
    ContactMergeFleetRepositoryV1: ['findDriverIdByYandexDriverId'],
    ContactMergeSimpleLinkMessagingRepositoryV1: ['attachUnlinkedContactChatsToDriver'],
    ContactMergeMessagingRepositoryV1: ['moveChatsToContact', 'moveChatsToDriverContact', 'remapChatsToIdentity'],
    ContactMergeWorkRepositoryV1: ['moveTasksToContact'],
    ContactMergeUnitOfWorkV1: ['runMerge', 'runSimpleLink'],
  }
  for (const [name, methods] of Object.entries(expectedMethods)) {
    assert.deepEqual(interfaceMethods(paths.handler, name), [...methods].sort(), `${name} method allowlist changed`)
  }
  const handler = sourceFile(paths.handler)
  const portText = handler.statements
    .filter((statement) => typescript.isInterfaceDeclaration(statement) && /(?:Repository|Repositories|UnitOfWork)V1$/.test(statement.name.text))
    .map((statement) => statement.getText(handler))
    .join('\n')
  assert.doesNotMatch(portText, /@prisma\/client|TransactionClient|PrismaPromise|\bPrisma\b|\$queryRaw|\$executeRaw/)
  assert.doesNotMatch(portText, /\b(?:where|data|predicate|sql|table|model|delegate|transactionClient|tx)\s*[?:,(]/i)
  assert.doesNotMatch(portText, /\b(?:any|unknown)\b|Record\s*</)
})

await checkAsync('simple link preserves exact owner step order and result', async () => {
  const harness = makeHarness({ survivor: null })
  assert.deepEqual(plain(await harness.merge(driverCommand)), {
    contract: 'contacts.MergeContactsResult.v1',
    status: 'linked',
    contactId: 'source-1',
    driverId: 'driver-1',
  })
  assert.deepEqual(harness.events, [
    ['query.source', 'source-1'],
    ['query.driver', 'driver-1'],
    ['query.survivor', 'yandex-1'],
    ['uow.simple:start'],
    ['contacts.link', {
      contactId: 'source-1',
      driverYandexId: 'yandex-1',
      driverFullName: 'Driver Name',
      replaceDisplayName: true,
    }],
    ['messaging.attach-driver', 'source-1', 'driver-1'],
    ['uow.simple:end'],
    ['log', '[ContactMergeService] Simple link: contact=source-1 → driver=yandex-1'],
  ])
})

await checkAsync('driver merge preserves lock, dedup, move, record, archive order', async () => {
  const harness = makeHarness()
  assert.deepEqual(plain(await harness.merge(driverCommand)), {
    contract: 'contacts.MergeContactsResult.v1',
    status: 'merged',
    survivorId: 'target-1',
    mergedId: 'source-1',
    driverId: 'driver-1',
    mergeRecordId: 'merge-fixed',
  })
  assert.deepEqual(harness.events.map(([name]) => name), [
    'query.source', 'query.driver', 'query.survivor',
    'uow.merge:start',
    'contacts.lock',
    'messaging.remap-identity',
    'contacts.delete-identities',
    'contacts.move-identities',
    'contacts.delete-phones',
    'contacts.move-phones',
    'messaging.move-driver-contact',
    'messaging.attach-driver',
    'work.move-tasks',
    'contacts.record-merge',
    'contacts.archive',
    'uow.merge:end',
    'log',
  ])
  assert.deepEqual(harness.events.find(([name]) => name === 'contacts.record-merge')[1], {
    id: 'merge-fixed',
    survivorId: 'target-1',
    mergedId: 'source-1',
    mergedBy: 'manager-1',
    reason: 'yandex_link',
    driverYandexId: 'yandex-1',
    snapshotBefore: {
      contact: {
        id: 'source-1', displayName: 'Source Name', displayNameSource: 'telegram',
        masterSource: 'telegram', yandexDriverId: null, notes: 'source note', tags: ['one', 'two'],
      },
      phones: source.phones,
      identities: source.identities,
      chatIds: ['chat-1'],
      taskIds: ['task-1'],
    },
  })
})

await checkAsync('manual merge preserves driver-found and driver-missing branches and exact order', async () => {
  const withDriver = makeHarness()
  assert.deepEqual(plain(await withDriver.merge(contactCommand)), {
    contract: 'contacts.MergeContactsResult.v1',
    status: 'contact_merged',
    survivorId: 'target-1',
    mergedId: 'source-1',
    mergeRecordId: 'merge-fixed',
  })
  assert.deepEqual(withDriver.events.map(([name]) => name), [
    'query.source', 'query.target',
    'uow.merge:start',
    'contacts.lock',
    'messaging.remap-identity',
    'contacts.delete-identities',
    'contacts.move-identities',
    'contacts.delete-phones',
    'contacts.move-phones',
    'fleet.find-driver',
    'messaging.move-driver-contact',
    'work.move-tasks',
    'contacts.record-merge',
    'contacts.archive',
    'uow.merge:end',
    'log',
  ])
  const record = withDriver.events.find(([name]) => name === 'contacts.record-merge')[1]
  assert.equal(record.reason, 'manual')
  assert.equal(record.driverYandexId, 'yandex-1')

  const targetWithoutDriver = { ...survivor, yandexDriverId: null }
  const withoutDriver = makeHarness({ target: targetWithoutDriver, targetDriverId: null })
  await withoutDriver.merge(contactCommand)
  assert.ok(withoutDriver.events.some(([name]) => name === 'messaging.move-contact'))
  assert.ok(!withoutDriver.events.some(([name]) => name === 'fleet.find-driver'))
  assert.ok(!withoutDriver.events.some(([name]) => name === 'messaging.move-driver-contact'))
  assert.equal(withoutDriver.events.find(([name]) => name === 'contacts.record-merge')[1].driverYandexId, null)
})

await checkAsync('all legacy precondition and no-op paths remain outside the unit of work', async () => {
  async function expectError(options, command, code) {
    const harness = makeHarness(options)
    await assert.rejects(harness.merge(command), (error) => error.code === code && error.name === 'MergeError')
    assert.ok(!harness.events.some(([name]) => name.startsWith('uow.')), `${code} entered a unit of work`)
    return harness.events
  }
  await expectError({ source: null }, driverCommand, 'CONTACT_NOT_FOUND')
  await expectError({ driver: null }, driverCommand, 'DRIVER_NOT_FOUND')
  await expectError({ source: { ...source, isArchived: true } }, driverCommand, 'CONTACT_ARCHIVED')
  await expectError({ source: { ...source, yandexDriverId: 'other' } }, driverCommand, 'CONTACT_LINKED_TO_OTHER_DRIVER')
  await expectError({ survivor: { ...survivor, isArchived: true } }, driverCommand, 'SURVIVOR_ARCHIVED')

  const linked = makeHarness({ source: { ...source, yandexDriverId: 'yandex-1' } })
  assert.deepEqual(plain(await linked.merge(driverCommand)), {
    contract: 'contacts.MergeContactsResult.v1', status: 'already_linked', contactId: 'source-1', driverId: 'driver-1',
  })
  assert.ok(!linked.events.some(([name]) => name.startsWith('uow.')))

  const selfEvents = await expectError({}, { ...contactCommand, targetId: 'source-1' }, 'SELF_MERGE')
  assert.deepEqual(selfEvents, [])
  await expectError({ source: null }, contactCommand, 'CONTACT_NOT_FOUND')
  await expectError({ source: { ...source, yandexDriverId: 'linked-driver' } }, contactCommand, 'SOURCE_HAS_DRIVER')
  await expectError({ target: null }, contactCommand, 'CONTACT_NOT_FOUND')
  await expectError({ target: { ...survivor, isArchived: true } }, contactCommand, 'SURVIVOR_ARCHIVED')
  await expectError({ source: { ...source, isArchived: true }, hasCompletedMerge: false }, contactCommand, 'CONTACT_ARCHIVED')

  const idempotent = makeHarness({ source: { ...source, isArchived: true }, hasCompletedMerge: true })
  assert.deepEqual(plain(await idempotent.merge(contactCommand)), {
    contract: 'contacts.MergeContactsResult.v1', status: 'already_merged', sourceId: 'source-1', targetId: 'target-1',
  })
  assert.deepEqual(idempotent.events, [
    ['query.source', 'source-1'],
    ['query.completed-merge', 'source-1', 'target-1'],
  ])
})

check('policy allowlist is exactly this adapter plus Chat and Task', () => {
  const policy = JSON.parse(read(paths.policy))
  const approvals = policy.approved_infrastructure_writers.filter((entry) => entry.file === paths.adapter)
  assert.equal(approvals.length, 2)
  assert.deepEqual(approvals.map((entry) => entry.model).sort(), ['Chat', 'Task'])
  assert.equal(new Set(approvals.map((entry) => `${entry.file}:${entry.model}`)).size, 2)
  assert.ok(approvals.every((entry) => /contact-merge unit of work/.test(entry.reason)))
})

await checkAsync('adapter pins four Chat and one Task writers to the sentinel transaction', async () => {
  const sourceText = read(paths.adapter)
  assert.equal((sourceText.match(/transaction\.chat\.updateMany\s*\(/g) || []).length, 4)
  assert.equal((sourceText.match(/transaction\.task\.updateMany\s*\(/g) || []).length, 1)
  assert.equal((sourceText.match(/INSERT INTO "ContactMerge"/g) || []).length, 2)
  assert.match(sourceText, /'manual'/)
  assert.match(sourceText, /'yandex_link'/)
  assert.equal(sourceText.includes('${input.reason}'), false)
  assert.doesNotMatch(sourceText, /(?:transaction|prisma)\.message\.(?:create|update|updateMany|delete|deleteMany|upsert)\s*\(/i)
  assert.doesNotMatch(sourceText, /Promise\.all|\bcatch\b|\bretry\b|queueMicrotask|setTimeout|console\./i)
  assert.equal((sourceText.match(/prisma\.\$transaction\s*\(/g) || []).length, 2)

  const transactionRuns = []
  let currentCalls = []
  const model = (name, methods) => Object.fromEntries(methods.map((method) => [method, async (input) => {
    currentCalls.push([`${name}.${method}`, plain(input)])
    if (name === 'driver' && method === 'findUnique') return { id: 'driver-from-tx' }
    return { count: 1 }
  }]))
  const transaction = {
    contact: model('contact', ['update']),
    contactIdentity: model('contactIdentity', ['deleteMany', 'updateMany']),
    contactPhone: model('contactPhone', ['deleteMany', 'updateMany']),
    driver: model('driver', ['findUnique']),
    chat: model('chat', ['updateMany']),
    task: model('task', ['updateMany']),
    async $queryRaw(strings, ...values) {
      const sql = strings.join('?')
      currentCalls.push(['$queryRaw', sql, ...plain(values)])
      return sql.includes('INSERT INTO "ContactMerge"') ? [{ id: 'merge-from-tx' }] : []
    },
  }
  const globalPrisma = new Proxy({
    async $transaction(operation, options) {
      currentCalls = []
      const result = await operation(transaction)
      transactionRuns.push({ options: plain(options), calls: currentCalls })
      return result
    },
  }, {
    get(target, property, receiver) {
      if (property === '$transaction') return Reflect.get(target, property, receiver)
      throw new Error(`global Prisma access forbidden during unit of work: ${String(property)}`)
    },
  })
  const adapter = evaluate(paths.adapter, { '@/lib/prisma': { prisma: globalPrisma } })

  await adapter.legacyPrismaContactMergeUnitOfWorkV1.runSimpleLink(async ({ contacts, messaging }) => {
    assert.deepEqual(Object.keys(contacts), ['linkContactToDriver'])
    assert.deepEqual(Object.keys(messaging), ['attachUnlinkedContactChatsToDriver'])
    await contacts.linkContactToDriver({
      contactId: 'source', driverYandexId: 'yandex', driverFullName: 'Driver', replaceDisplayName: true,
    })
    await messaging.attachUnlinkedContactChatsToDriver('source', 'driver')
  })
  assert.equal(transactionRuns.length, 1)
  assert.equal(transactionRuns[0].options, undefined)
  assert.deepEqual(transactionRuns[0].calls, [
    ['contact.update', { where: { id: 'source' }, data: {
      yandexDriverId: 'yandex', masterSource: 'yandex', displayName: 'Driver', displayNameSource: 'yandex',
    } }],
    ['chat.updateMany', { where: { contactId: 'source', driverId: null }, data: { driverId: 'driver' } }],
  ])

  await adapter.legacyPrismaContactMergeUnitOfWorkV1.runMerge(async ({ contacts, fleet, messaging, work }) => {
    await contacts.lockContactPairOrdered('target', 'source')
    await contacts.deleteDuplicateIdentities(['identity'])
    await contacts.moveIdentitiesToContact('source', 'target')
    await contacts.deleteDuplicatePhones(['phone'])
    await contacts.movePhonesToContact('source', 'target')
    assert.equal(await contacts.recordMerge({
      id: 'merge', survivorId: 'target', mergedId: 'source', mergedBy: 'manager', reason: 'manual',
      driverYandexId: null, snapshotBefore: { contact: {}, phones: [], identities: [], chatIds: [], taskIds: [] },
    }), 'merge-from-tx')
    await contacts.archiveContact('source')
    assert.equal(await fleet.findDriverIdByYandexDriverId('yandex'), 'driver-from-tx')
    await messaging.remapChatsToIdentity('old', 'new')
    await messaging.moveChatsToContact('source', 'target')
    await messaging.moveChatsToDriverContact('source', 'target', 'driver')
    await messaging.attachUnlinkedContactChatsToDriver('target', 'driver')
    await work.moveTasksToContact('source', 'target')
  })
  assert.deepEqual(transactionRuns[1].options, { timeout: 15000 })
  assert.deepEqual(transactionRuns[1].calls.filter(([name]) => name === 'chat.updateMany'), [
    ['chat.updateMany', { where: { contactIdentityId: 'old' }, data: { contactIdentityId: 'new' } }],
    ['chat.updateMany', { where: { contactId: 'source' }, data: { contactId: 'target' } }],
    ['chat.updateMany', { where: { contactId: 'source' }, data: { contactId: 'target', driverId: 'driver' } }],
    ['chat.updateMany', { where: { contactId: 'target', driverId: null }, data: { driverId: 'driver' } }],
  ])
  assert.deepEqual(transactionRuns[1].calls.filter(([name]) => name === 'task.updateMany'), [
    ['task.updateMany', { where: { contactId: 'source' }, data: { contactId: 'target' } }],
  ])
})

check('legacy API routes and protected Messages drawer remain byte-identical', () => {
  assert.deepEqual({
    driverRoute: sha256(paths.driverRoute),
    contactRoute: sha256(paths.contactRoute),
    drawer: sha256(paths.drawer),
  }, {
    driverRoute: 'aef997b91d69ac326015b834471e9beb436c2a23276d766f9be6b42b7275943d',
    contactRoute: 'ceab4210dfb589719b1558e54ab1bfd408f7598881ae7e7d3a0f6027cb84c40a',
    drawer: 'b5a96ee22dbc645dad8adb4bb50c4473f317ccba2d8e8e8c2ec52812cf598076',
  })
})

await checkAsync('ContactMergeService is a compatibility-only facade over the Contacts owner', async () => {
  const facadeSource = read(paths.facade)
  assert.doesNotMatch(facadeSource, /@\/lib\/prisma|@prisma\/client|\bprisma\.|\$transaction|\$queryRaw/)
  assert.match(facadeSource, /mergeContactsV1/)
  assert.match(read(paths.publicIndex), /export const mergeContactsV1\s*=\s*createMergeContactsHandlerV1/)

  const calls = []
  const facade = evaluate(paths.facade, {
    '@/contracts/contacts/v1': {
      MERGE_CONTACTS_COMMAND_V1: 'contacts.MergeContactsCommand.v1',
    },
    '@/modules/contacts/public/v1': {
      async mergeContactsV1(command) {
        calls.push(plain(command))
        return command.operation === 'contact_to_driver'
          ? { contract: 'contacts.MergeContactsResult.v1', status: 'linked', contactId: command.contactId, driverId: command.driverId }
          : { contract: 'contacts.MergeContactsResult.v1', status: 'contact_merged', survivorId: command.targetId, mergedId: command.sourceId, mergeRecordId: 'merge-1' }
      },
      ContactMergeErrorV1: handlerModule.ContactMergeErrorV1,
    },
  })
  assert.deepEqual(plain(await facade.ContactMergeService.mergeContactToDriver('source', 'driver')), {
    status: 'linked', contactId: 'source', driverId: 'driver',
  })
  assert.deepEqual(plain(await facade.ContactMergeService.mergeContactToContact('source', 'target', 'manager')), {
    status: 'contact_merged', survivorId: 'target', mergedId: 'source', mergeRecordId: 'merge-1',
  })
  assert.deepEqual(calls, [
    { contract: 'contacts.MergeContactsCommand.v1', operation: 'contact_to_driver', contactId: 'source', driverId: 'driver', mergedBy: 'system' },
    { contract: 'contacts.MergeContactsCommand.v1', operation: 'contact_to_contact', sourceId: 'source', targetId: 'target', mergedBy: 'manager' },
  ])
})

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
