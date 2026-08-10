#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-contact-conversation-'))
const contractPath = 'gravity-mvp/src/contracts/contacts/v1/contact-conversation-commands.ts'
const handlerPath = 'gravity-mvp/src/modules/contacts/public/v1/contact-conversation-handler.ts'
const adapterPath = 'gravity-mvp/src/modules/contacts/public/v1/legacy-prisma-contact-conversation-adapter.ts'
const sources = [
  contractPath,
  'gravity-mvp/src/contracts/contacts/v1/index.ts',
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
const contracts = require(path.join(out, 'contracts/contacts/v1/index.js'))
const handlers = require(path.join(out, 'modules/contacts/public/v1/contact-conversation-handler.js'))
const typescript = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
const contractSource = readFileSync(path.join(root, contractPath), 'utf8')
const handlerSource = readFileSync(path.join(root, handlerPath), 'utf8')
const adapterSource = readFileSync(path.join(root, adapterPath), 'utf8')
const adapterOutput = typescript.transpileModule(adapterSource, {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
}).outputText

const checks = []
const check = (name, fn) => { fn(); checks.push(name) }
const checkAsync = async (name, fn) => { await fn(); checks.push(name) }
const plain = (value) => JSON.parse(JSON.stringify(value))

const resolveCommand = {
  contract: contracts.RESOLVE_CHANNEL_CONTACT_COMMAND_V1,
  channel: 'telegram',
  externalId: '79991234567',
  phone: '+79991234567',
  displayName: null,
}
const prepareCommand = {
  contract: contracts.PREPARE_CONTACT_CONVERSATION_IDENTITY_COMMAND_V1,
  contactId: 'contact-1',
  channel: 'telegram',
  identityId: null,
}
const phoneQuery = {
  contract: contracts.GET_PREFERRED_ACTIVE_CONTACT_PHONE_QUERY_V1,
  contactId: 'contact-1',
}

function loadAdapter(prisma, contactService, consoleOverride = console) {
  const module = { exports: {} }
  vm.runInNewContext(adapterOutput, {
    module,
    exports: module.exports,
    console: consoleOverride,
    require(specifier) {
      if (specifier === '@/lib/prisma') return { prisma }
      if (specifier === '@/lib/ContactService') return { ContactService: contactService }
      throw new Error(`unexpected adapter import: ${specifier}`)
    },
  })
  return module.exports.legacyPrismaContactConversationPortV1
}

function makePrisma({
  contact = { id: 'contact-1', displayName: 'Contact One', isArchived: false },
  identities = [],
  phones = [],
  createdIdentity = {
    id: 'identity-created',
    channel: 'telegram',
    externalId: '79991234567',
  },
} = {}) {
  const calls = []
  let identityRead = 0
  let phoneRead = 0
  const prisma = {
    contact: {
      async findUnique(input) {
        calls.push(['contact.findUnique', input])
        return contact
      },
    },
    contactIdentity: {
      async findFirst(input) {
        calls.push(['contactIdentity.findFirst', input])
        return identities[identityRead++] ?? null
      },
      async create(input) {
        calls.push(['contactIdentity.create', input])
        return createdIdentity
      },
    },
    contactPhone: {
      async findFirst(input) {
        calls.push(['contactPhone.findFirst', input])
        return phones[phoneRead++] ?? null
      },
    },
  }
  return { prisma, calls }
}

const unexpectedContactService = {
  async resolveContact() { throw new Error('unexpected ContactService.resolveContact call') },
}

try {
  check('all six identifiers are explicit and exported through the public contract index', () => {
    assert.equal(
      contracts.RESOLVE_CHANNEL_CONTACT_COMMAND_V1,
      'contacts.ResolveChannelContactCommand.v1',
    )
    assert.equal(
      contracts.RESOLVE_CHANNEL_CONTACT_RESULT_V1,
      'contacts.ResolveChannelContactResult.v1',
    )
    assert.equal(
      contracts.PREPARE_CONTACT_CONVERSATION_IDENTITY_COMMAND_V1,
      'contacts.PrepareContactConversationIdentityCommand.v1',
    )
    assert.equal(
      contracts.PREPARE_CONTACT_CONVERSATION_IDENTITY_RESULT_V1,
      'contacts.PrepareContactConversationIdentityResult.v1',
    )
    assert.equal(
      contracts.GET_PREFERRED_ACTIVE_CONTACT_PHONE_QUERY_V1,
      'contacts.GetPreferredActiveContactPhoneQuery.v1',
    )
    assert.equal(
      contracts.GET_PREFERRED_ACTIVE_CONTACT_PHONE_RESULT_V1,
      'contacts.GetPreferredActiveContactPhoneResult.v1',
    )
  })

  check('strict parsers accept the three exact v1 envelopes and every supported channel', () => {
    assert.deepEqual(contracts.parseResolveChannelContactCommandV1(resolveCommand), resolveCommand)
    assert.deepEqual(
      contracts.parsePrepareContactConversationIdentityCommandV1(prepareCommand),
      prepareCommand,
    )
    assert.deepEqual(contracts.parseGetPreferredActiveContactPhoneQueryV1(phoneQuery), phoneQuery)
    for (const channel of ['telegram', 'whatsapp', 'max']) {
      contracts.parseResolveChannelContactCommandV1({
        ...resolveCommand,
        channel,
        phone: null,
        displayName: 'Visible Name',
      })
      contracts.parsePrepareContactConversationIdentityCommandV1({
        ...prepareCommand,
        channel,
        identityId: 'identity-explicit',
      })
    }
  })

  check('nonobjects extra fields wrong versions and wrong namespaces are rejected distinctly', () => {
    for (const parse of [
      contracts.parseResolveChannelContactCommandV1,
      contracts.parsePrepareContactConversationIdentityCommandV1,
      contracts.parseGetPreferredActiveContactPhoneQueryV1,
    ]) {
      for (const invalid of [null, [], 'command', 7]) {
        assert.throws(() => parse(invalid), (error) =>
          error.name === 'ContactConversationContractValidationError'
          && error.code === 'INVALID_CONTRACT')
      }
    }
    assert.throws(
      () => contracts.parseResolveChannelContactCommandV1({ ...resolveCommand, prisma: true }),
      (error) => error.code === 'INVALID_CONTRACT',
    )
    assert.throws(
      () => contracts.parsePrepareContactConversationIdentityCommandV1({
        ...prepareCommand,
        contract: 'contacts.PrepareContactConversationIdentityCommand.v2',
      }),
      (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    )
    assert.throws(
      () => contracts.parseGetPreferredActiveContactPhoneQueryV1({
        ...phoneQuery,
        contract: 'messaging.GetPreferredActiveContactPhoneQuery.v1',
      }),
      (error) => error.code === 'INVALID_CONTRACT',
    )
  })

  check('identifiers nullable fields and closed channels are validated before ownership code', () => {
    for (const field of ['externalId', 'phone', 'displayName']) {
      assert.throws(() => contracts.parseResolveChannelContactCommandV1({
        ...resolveCommand,
        [field]: '',
      }), (error) => error.code === 'INVALID_CONTRACT')
    }
    for (const channel of ['phone', 'avito', '', null, 4]) {
      assert.throws(() => contracts.parseResolveChannelContactCommandV1({
        ...resolveCommand,
        channel,
      }), (error) => error.code === 'INVALID_CONTRACT')
    }
    for (const identityId of ['', 7, undefined]) {
      assert.throws(() => contracts.parsePrepareContactConversationIdentityCommandV1({
        ...prepareCommand,
        identityId,
      }), (error) => error.code === 'INVALID_CONTRACT')
    }
    assert.deepEqual(
      contracts.parsePrepareContactConversationIdentityCommandV1({
        ...prepareCommand,
        contactId: '  ',
        identityId: '  ',
      }),
      { ...prepareCommand, contactId: '  ', identityId: '  ' },
    )
    for (const contactId of ['', '  ', null, 7]) {
      assert.throws(() => contracts.parseGetPreferredActiveContactPhoneQueryV1({
        ...phoneQuery,
        contactId,
      }), (error) => error.code === 'INVALID_CONTRACT')
    }
  })

  await checkAsync('handlers validate first and preserve exact port mappings and result envelopes', async () => {
    const calls = []
    const port = {
      async resolveChannelContact(input) {
        calls.push(['resolve', input])
        return {
          contact: { id: 'contact-1', displayName: 'Contact One' },
          identity: { id: 'identity-1', channel: 'telegram', externalId: '79991234567' },
          isNew: false,
        }
      },
      async prepareContactConversationIdentity(input) {
        calls.push(['prepare', input])
        return {
          status: 'ready',
          contact: { id: 'contact-1', displayName: 'Contact One' },
          identity: { id: 'identity-1', channel: 'telegram', externalId: '79991234567' },
        }
      },
      async getPreferredActiveContactPhone(contactId) {
        calls.push(['phone', contactId])
        return '+79991234567'
      },
    }
    assert.deepEqual(await handlers.createResolveChannelContactHandlerV1(port)(resolveCommand), {
      contract: contracts.RESOLVE_CHANNEL_CONTACT_RESULT_V1,
      contact: { id: 'contact-1', displayName: 'Contact One' },
      identity: { id: 'identity-1', channel: 'telegram', externalId: '79991234567' },
      isNew: false,
    })
    assert.deepEqual(
      await handlers.createPrepareContactConversationIdentityHandlerV1(port)(prepareCommand),
      {
        contract: contracts.PREPARE_CONTACT_CONVERSATION_IDENTITY_RESULT_V1,
        status: 'ready',
        contact: { id: 'contact-1', displayName: 'Contact One' },
        identity: { id: 'identity-1', channel: 'telegram', externalId: '79991234567' },
      },
    )
    assert.deepEqual(
      await handlers.createGetPreferredActiveContactPhoneHandlerV1(port)(phoneQuery),
      {
        contract: contracts.GET_PREFERRED_ACTIVE_CONTACT_PHONE_RESULT_V1,
        phone: '+79991234567',
      },
    )
    assert.deepEqual(calls, [
      ['resolve', {
        channel: 'telegram',
        externalId: '79991234567',
        phone: '+79991234567',
        displayName: null,
      }],
      ['prepare', { contactId: 'contact-1', channel: 'telegram', identityId: null }],
      ['phone', 'contact-1'],
    ])

    const before = calls.length
    await assert.rejects(handlers.createResolveChannelContactHandlerV1(port)({
      ...resolveCommand,
      channel: 'phone',
    }))
    await assert.rejects(handlers.createPrepareContactConversationIdentityHandlerV1(port)({
      ...prepareCommand,
      rawSql: 'x',
    }))
    await assert.rejects(handlers.createGetPreferredActiveContactPhoneHandlerV1(port)({
      ...phoneQuery,
      contactId: '',
    }))
    assert.equal(calls.length, before)
  })

  await checkAsync('prepare handler exposes each expected non-ready status without synthetic fields', async () => {
    for (const status of ['contact_not_found', 'identity_not_found', 'no_identity']) {
      const port = {
        async resolveChannelContact() { throw new Error('unexpected resolve') },
        async prepareContactConversationIdentity() { return { status } },
        async getPreferredActiveContactPhone() { throw new Error('unexpected phone') },
      }
      assert.deepEqual(
        await handlers.createPrepareContactConversationIdentityHandlerV1(port)(prepareCommand),
        { contract: contracts.PREPARE_CONTACT_CONVERSATION_IDENTITY_RESULT_V1, status },
      )
    }
  })

  await checkAsync('all handler owner failures propagate without translation or retry', async () => {
    const failing = {
      async resolveChannelContact() { throw new Error('resolve owner failed') },
      async prepareContactConversationIdentity() { throw new Error('prepare owner failed') },
      async getPreferredActiveContactPhone() { throw new Error('phone owner failed') },
    }
    await assert.rejects(
      handlers.createResolveChannelContactHandlerV1(failing)(resolveCommand),
      /resolve owner failed/,
    )
    await assert.rejects(
      handlers.createPrepareContactConversationIdentityHandlerV1(failing)(prepareCommand),
      /prepare owner failed/,
    )
    await assert.rejects(
      handlers.createGetPreferredActiveContactPhoneHandlerV1(failing)(phoneQuery),
      /phone owner failed/,
    )
  })

  await checkAsync('resolve adapter delegates once to existing ContactService semantics', async () => {
    const calls = []
    const contactService = {
      async resolveContact(...args) {
        calls.push(args)
        return {
          contact: { id: 'contact-resolved', displayName: 'Resolved Contact' },
          identity: { id: 'identity-resolved', channel: 'telegram', externalId: '79991234567' },
          isNew: true,
        }
      },
    }
    const { prisma, calls: prismaCalls } = makePrisma()
    assert.deepEqual(
      plain(await loadAdapter(prisma, contactService).resolveChannelContact({
        channel: 'telegram',
        externalId: '79991234567',
        phone: '+79991234567',
        displayName: null,
      })),
      {
        contact: { id: 'contact-resolved', displayName: 'Resolved Contact' },
        identity: { id: 'identity-resolved', channel: 'telegram', externalId: '79991234567' },
        isNew: true,
      },
    )
    assert.deepEqual(calls, [['telegram', '79991234567', '+79991234567', null]])
    assert.deepEqual(prismaCalls, [])
  })

  await checkAsync('missing and archived contacts short-circuit all identity and phone work', async () => {
    for (const contact of [null, { id: 'contact-1', displayName: 'Archived', isArchived: true }]) {
      const { prisma, calls } = makePrisma({ contact })
      assert.deepEqual(
        plain(await loadAdapter(prisma, unexpectedContactService)
          .prepareContactConversationIdentity({
            contactId: 'contact-1', channel: 'telegram', identityId: null,
          })),
        { status: 'contact_not_found' },
      )
      assert.deepEqual(plain(calls), [
        ['contact.findUnique', { where: { id: 'contact-1' } }],
      ])
    }
  })

  await checkAsync('explicit active identity is contact and channel scoped and short-circuits fallback', async () => {
    const identity = { id: 'identity-explicit', channel: 'telegram', externalId: 'tg-42' }
    const { prisma, calls } = makePrisma({ identities: [identity] })
    assert.deepEqual(
      plain(await loadAdapter(prisma, unexpectedContactService)
        .prepareContactConversationIdentity({
          contactId: 'contact-1', channel: 'telegram', identityId: 'identity-explicit',
        })),
      {
        status: 'ready',
        contact: { id: 'contact-1', displayName: 'Contact One' },
        identity,
      },
    )
    assert.deepEqual(plain(calls), [
      ['contact.findUnique', { where: { id: 'contact-1' } }],
      ['contactIdentity.findFirst', {
        where: {
          id: 'identity-explicit',
          contactId: 'contact-1',
          channel: 'telegram',
          isActive: true,
        },
      }],
    ])
  })

  await checkAsync('missing explicit identity returns identity_not_found without implicit fallback', async () => {
    const { prisma, calls } = makePrisma()
    assert.deepEqual(
      plain(await loadAdapter(prisma, unexpectedContactService)
        .prepareContactConversationIdentity({
          contactId: 'contact-1', channel: 'whatsapp', identityId: 'identity-missing',
        })),
      { status: 'identity_not_found' },
    )
    assert.deepEqual(plain(calls), [
      ['contact.findUnique', { where: { id: 'contact-1' } }],
      ['contactIdentity.findFirst', {
        where: {
          id: 'identity-missing',
          contactId: 'contact-1',
          channel: 'whatsapp',
          isActive: true,
        },
      }],
    ])
  })

  await checkAsync('implicit identity resolution selects the earliest active identity', async () => {
    const identity = { id: 'identity-earliest', channel: 'max', externalId: 'max-7' }
    const { prisma, calls } = makePrisma({ identities: [identity] })
    assert.equal(
      (await loadAdapter(prisma, unexpectedContactService).prepareContactConversationIdentity({
        contactId: 'contact-1', channel: 'max', identityId: null,
      })).status,
      'ready',
    )
    assert.deepEqual(plain(calls), [
      ['contact.findUnique', { where: { id: 'contact-1' } }],
      ['contactIdentity.findFirst', {
        where: { contactId: 'contact-1', channel: 'max', isActive: true },
        orderBy: { createdAt: 'asc' },
      }],
    ])
  })

  await checkAsync('identity fallback returns no_identity when no active phone exists', async () => {
    const { prisma, calls } = makePrisma()
    assert.deepEqual(
      plain(await loadAdapter(prisma, unexpectedContactService)
        .prepareContactConversationIdentity({
          contactId: 'contact-1', channel: 'telegram', identityId: null,
        })),
      { status: 'no_identity' },
    )
    assert.deepEqual(plain(calls), [
      ['contact.findUnique', { where: { id: 'contact-1' } }],
      ['contactIdentity.findFirst', {
        where: { contactId: 'contact-1', channel: 'telegram', isActive: true },
        orderBy: { createdAt: 'asc' },
      }],
      ['contactPhone.findFirst', {
        where: { contactId: 'contact-1', isActive: true },
        orderBy: { isPrimary: 'desc' },
      }],
    ])
  })

  await checkAsync('identity fallback uses the preferred active phone and exact manual identity write', async () => {
    const createdIdentity = {
      id: 'identity-created',
      channel: 'whatsapp',
      externalId: '79990001122',
    }
    const { prisma, calls } = makePrisma({
      phones: [{ id: 'phone-primary', phone: '+79990001122' }],
      createdIdentity,
    })
    assert.deepEqual(
      plain(await loadAdapter(prisma, unexpectedContactService)
        .prepareContactConversationIdentity({
          contactId: 'contact-1', channel: 'whatsapp', identityId: null,
        })),
      {
        status: 'ready',
        contact: { id: 'contact-1', displayName: 'Contact One' },
        identity: createdIdentity,
      },
    )
    assert.deepEqual(plain(calls), [
      ['contact.findUnique', { where: { id: 'contact-1' } }],
      ['contactIdentity.findFirst', {
        where: { contactId: 'contact-1', channel: 'whatsapp', isActive: true },
        orderBy: { createdAt: 'asc' },
      }],
      ['contactPhone.findFirst', {
        where: { contactId: 'contact-1', isActive: true },
        orderBy: { isPrimary: 'desc' },
      }],
      ['contactIdentity.create', {
        data: {
          contactId: 'contact-1',
          channel: 'whatsapp',
          externalId: '79990001122',
          phoneId: 'phone-primary',
          source: 'manual',
          confidence: 1,
        },
      }],
    ])
  })

  await checkAsync('preferred phone query remains an independent ordered read and returns string or null', async () => {
    const found = makePrisma({ phones: [{ id: 'phone-primary', phone: '+71112223344' }] })
    assert.equal(
      await loadAdapter(found.prisma, unexpectedContactService)
        .getPreferredActiveContactPhone('contact-1'),
      '+71112223344',
    )
    assert.deepEqual(plain(found.calls), [
      ['contactPhone.findFirst', {
        where: { contactId: 'contact-1', isActive: true },
        orderBy: { isPrimary: 'desc' },
      }],
    ])

    const missing = makePrisma()
    assert.equal(
      await loadAdapter(missing.prisma, unexpectedContactService)
        .getPreferredActiveContactPhone('contact-1'),
      null,
    )
    assert.equal(missing.calls.length, 1)
  })

  await checkAsync('adapter dependency failures remain visible with one attempt and no logging', async () => {
    const contactServiceCalls = []
    const contactService = {
      async resolveContact() {
        contactServiceCalls.push('resolveContact')
        throw new Error('ContactService failed')
      },
    }
    const logs = []
    const consoleTrap = new Proxy({}, {
      get: () => (...args) => { logs.push(args) },
    })
    const base = makePrisma()
    await assert.rejects(
      loadAdapter(base.prisma, contactService, consoleTrap).resolveChannelContact({
        channel: 'telegram', externalId: 'tg-1', phone: null, displayName: null,
      }),
      /ContactService failed/,
    )
    assert.deepEqual(contactServiceCalls, ['resolveContact'])

    for (const failingStage of [
      'contact.findUnique',
      'contactIdentity.findFirst',
      'contactPhone.findFirst',
      'contactIdentity.create',
    ]) {
      const calls = []
      const invoke = async (stage, result) => {
        calls.push(stage)
        if (stage === failingStage) throw new Error(`${stage} failed`)
        return result
      }
      const prisma = {
        contact: {
          findUnique: () => invoke('contact.findUnique', {
            id: 'contact-1', displayName: 'Contact One', isArchived: false,
          }),
        },
        contactIdentity: {
          findFirst: () => invoke('contactIdentity.findFirst', null),
          create: () => invoke('contactIdentity.create', {
            id: 'identity-created', channel: 'telegram', externalId: '79991234567',
          }),
        },
        contactPhone: {
          findFirst: () => invoke('contactPhone.findFirst', {
            id: 'phone-1', phone: '+79991234567',
          }),
        },
      }
      await assert.rejects(
        loadAdapter(prisma, unexpectedContactService, consoleTrap)
          .prepareContactConversationIdentity({
            contactId: 'contact-1', channel: 'telegram', identityId: null,
          }),
        new RegExp(`${failingStage.replace('.', '\\.')} failed`),
      )
      assert.equal(calls.filter((stage) => stage === failingStage).length, 1)
    }
    assert.equal(logs.length, 0)
  })

  check('contracts and handlers stay infrastructure-neutral and the adapter has no escape hatch', () => {
    assert.doesNotMatch(contractSource, /@prisma|@\/lib|next\/server|\bprisma\b/i)
    assert.doesNotMatch(handlerSource, /@prisma|@\/lib|next\/server|\bprisma\b/i)
    assert.doesNotMatch(adapterSource, /\$transaction|console\.|\bcatch\b|\bretry\b/i)
    assert.doesNotMatch(adapterSource, /\$(?:query|execute)Raw|Unsafe|\bany\b/)
    assert.equal((adapterSource.match(/ContactService\.resolveContact/g) ?? []).length, 1)
    assert.equal((adapterSource.match(/prisma\.contact\.findUnique/g) ?? []).length, 1)
    assert.equal((adapterSource.match(/prisma\.contactIdentity\.findFirst/g) ?? []).length, 2)
    assert.equal((adapterSource.match(/prisma\.contactPhone\.findFirst/g) ?? []).length, 2)
    assert.equal((adapterSource.match(/prisma\.contactIdentity\.create/g) ?? []).length, 1)
  })
} finally {
  rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
