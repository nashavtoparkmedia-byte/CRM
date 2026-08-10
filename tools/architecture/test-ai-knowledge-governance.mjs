#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const paths = {
  contract: 'gravity-mvp/src/contracts/ai-knowledge/v1/knowledge-governance-commands.ts',
  contractIndex: 'gravity-mvp/src/contracts/ai-knowledge/v1/index.ts',
  handler: 'gravity-mvp/src/modules/ai-knowledge/public/v1/knowledge-governance-handler.ts',
  publicIndex: 'gravity-mvp/src/modules/ai-knowledge/public/v1/index.ts',
  actions: 'gravity-mvp/src/app/settings/ai/actions.ts',
  ui: 'gravity-mvp/src/app/settings/ai/AiControlCenterClient.tsx',
  trainer: 'gravity-mvp/src/app/messages/proposed-reply-actions.ts',
  trainerContract: 'gravity-mvp/src/contracts/ai-knowledge/v1/knowledge-item-review-commands.ts',
  trainerHandler: 'gravity-mvp/src/modules/ai-knowledge/public/v1/knowledge-item-review-handler.ts',
  trainerAdapter: 'gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-prisma-knowledge-item-review-adapter.ts',
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

function sourceFile(relative, kind = typescript.ScriptKind.TS) {
  return typescript.createSourceFile(
    relative,
    read(relative),
    typescript.ScriptTarget.Latest,
    true,
    kind,
  )
}

function functionSource(relative, name) {
  const file = sourceFile(relative)
  const statement = file.statements.find(
    (candidate) => typescript.isFunctionDeclaration(candidate) && candidate.name?.text === name,
  )
  assert.ok(statement, `${name} is missing from ${relative}`)
  return statement.getText(file)
}

function assertOrdered(body, values, label) {
  let previous = -1
  for (const value of values) {
    const index = body.indexOf(value, previous + 1)
    assert.ok(index > previous, `${label}: missing or out of order: ${value}`)
    previous = index
  }
}

function loadActionHarness({
  queryResults = [], failingOwners = [], failOwnerAt = {}, runtimeEnabled = true,
} = {}) {
  const events = []
  const queue = [...queryResults]
  const failing = new Set(failingOwners)
  const ownerCallCounts = new Map()
  const ownerNames = [
    'editGovernanceKnowledgeItemV1',
    'archiveGovernanceKnowledgeItemV1',
    'restoreGovernanceKnowledgeItemV1',
    'verifyGovernanceKnowledgeItemV1',
    'unverifyGovernanceKnowledgeItemV1',
    'supersedeGovernanceKnowledgeItemV1',
    'archiveKnowledgeConflictMemberV1',
    'clearKnowledgeConflictWinnerV1',
    'clearKnowledgeConflictGroupV1',
    'createManualGovernanceKnowledgeItemV1',
    'markKnowledgeItemSourcesDisabledV1',
    'archiveKnowledgeItemAfterSourceDisableV1',
    'archiveKnowledgeItemForCoreResetV1',
    'attachManualKnowledgeSourceV1',
    'disableKnowledgeSourcesV1',
  ]
  const ownerModule = Object.fromEntries(ownerNames.map((name) => [name, async (command) => {
    events.push(['owner', name, plain(command)])
    const count = (ownerCallCounts.get(name) ?? 0) + 1
    ownerCallCounts.set(name, count)
    if (failing.has(name) || failOwnerAt[name] === count) throw new Error(`owner:${name}`)
    if (name === 'disableKnowledgeSourcesV1') return { disabledCount: 1 }
    return { updated: true }
  }]))
  const prisma = {
    async $queryRaw(strings, ...values) {
      const sql = strings.join('?')
      events.push(['query', sql, ...plain(values)])
      assert.ok(queue.length > 0, `unexpected query: ${sql}`)
      return queue.shift()
    },
    async $executeRaw() { throw new Error('legacy executeRaw reached') },
    async $executeRawUnsafe() { throw new Error('legacy executeRawUnsafe reached') },
  }
  const known = {
    'next/headers': {
      async cookies() { return { get: () => ({ value: 'actor-1' }) } },
    },
    'next/cache': {
      revalidatePath(value) { events.push(['revalidate', value]) },
    },
    '@/lib/prisma': { prisma },
    '@/lib/users/user-service': {
      async getUsers() { return [{ id: 'actor-1', role: 'Администратор' }] },
    },
    '@/lib/ai/knowledge/auditLog': {
      async writeAuditEntry(input) { events.push(['audit', plain(input)]) },
      snapshotItem(input) { return input },
      async getKnowledgeAuditLog() { return [] },
    },
    '@/lib/ai/knowledge/featureFlags': {
      isRuntimeEnabled: () => runtimeEnabled,
      isShadowModeEnabled: () => false,
      getKnowledgeRuntimeMode: () => 'off',
    },
    '@/contracts/ai-knowledge/v1': new Proxy(contracts, {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver)
        return String(property)
      },
    }),
    '@/modules/ai-knowledge/public/v1': ownerModule,
  }
  const genericModule = new Proxy({}, {
    get(_target, property) {
      if (property === '__esModule') return true
      if (property === 'then') return undefined
      return async () => undefined
    },
  })
  const module = { exports: {} }
  vm.runInNewContext(transpile(paths.actions), {
    module,
    exports: module.exports,
    require(specifier) { return known[specifier] ?? genericModule },
    Array,
    Boolean,
    Buffer,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    URL,
    process,
    setTimeout,
    clearTimeout,
  })
  return { actions: module.exports, events, queue }
}

const contracts = evaluate(paths.contract, {})
const handlers = evaluate(paths.handler, {
  '../../../../contracts/ai-knowledge/v1': contracts,
})

const specs = [
  {
    constant: 'EDIT_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1',
    identifier: 'ai_knowledge.EditGovernanceKnowledgeItemCommand.v1',
    resultConstant: 'EDIT_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1',
    resultIdentifier: 'ai_knowledge.EditGovernanceKnowledgeItemResult.v1',
    parser: 'parseEditGovernanceKnowledgeItemCommandV1',
    factory: 'createEditGovernanceKnowledgeItemHandlerV1',
    method: 'editItem',
    command: { itemId: 'item-1', patch: { title: 'Title', canonicalStatement: 'Statement', tags: ['one'], safetyLevel: 'sensitive' } },
    mapped: { itemId: 'item-1', patch: { title: 'Title', canonicalStatement: 'Statement', tags: ['one'], safetyLevel: 'sensitive' } },
    result: { updated: true },
  },
  {
    constant: 'ARCHIVE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1', identifier: 'ai_knowledge.ArchiveGovernanceKnowledgeItemCommand.v1',
    resultConstant: 'ARCHIVE_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1', resultIdentifier: 'ai_knowledge.ArchiveGovernanceKnowledgeItemResult.v1',
    parser: 'parseArchiveGovernanceKnowledgeItemCommandV1', factory: 'createArchiveGovernanceKnowledgeItemHandlerV1', method: 'archiveItem',
    command: { itemId: 'item-2' }, mapped: { itemId: 'item-2' }, result: { updated: true },
  },
  {
    constant: 'RESTORE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1', identifier: 'ai_knowledge.RestoreGovernanceKnowledgeItemCommand.v1',
    resultConstant: 'RESTORE_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1', resultIdentifier: 'ai_knowledge.RestoreGovernanceKnowledgeItemResult.v1',
    parser: 'parseRestoreGovernanceKnowledgeItemCommandV1', factory: 'createRestoreGovernanceKnowledgeItemHandlerV1', method: 'restoreItem',
    command: { itemId: 'item-3' }, mapped: { itemId: 'item-3' }, result: { updated: true },
  },
  {
    constant: 'VERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1', identifier: 'ai_knowledge.VerifyGovernanceKnowledgeItemCommand.v1',
    resultConstant: 'VERIFY_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1', resultIdentifier: 'ai_knowledge.VerifyGovernanceKnowledgeItemResult.v1',
    parser: 'parseVerifyGovernanceKnowledgeItemCommandV1', factory: 'createVerifyGovernanceKnowledgeItemHandlerV1', method: 'verifyItem',
    command: { itemId: 'item-4', actorId: 'actor-1' }, mapped: { itemId: 'item-4', actorId: 'actor-1' }, result: { updated: true },
  },
  {
    constant: 'UNVERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1', identifier: 'ai_knowledge.UnverifyGovernanceKnowledgeItemCommand.v1',
    resultConstant: 'UNVERIFY_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1', resultIdentifier: 'ai_knowledge.UnverifyGovernanceKnowledgeItemResult.v1',
    parser: 'parseUnverifyGovernanceKnowledgeItemCommandV1', factory: 'createUnverifyGovernanceKnowledgeItemHandlerV1', method: 'unverifyItem',
    command: { itemId: 'item-5' }, mapped: { itemId: 'item-5' }, result: { updated: true },
  },
  {
    constant: 'SUPERSEDE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1', identifier: 'ai_knowledge.SupersedeGovernanceKnowledgeItemCommand.v1',
    resultConstant: 'SUPERSEDE_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1', resultIdentifier: 'ai_knowledge.SupersedeGovernanceKnowledgeItemResult.v1',
    parser: 'parseSupersedeGovernanceKnowledgeItemCommandV1', factory: 'createSupersedeGovernanceKnowledgeItemHandlerV1', method: 'supersedeItem',
    command: { oldItemId: 'old-1', newItemId: 'new-1' }, mapped: { oldItemId: 'old-1', newItemId: 'new-1' }, result: { updated: true },
  },
  {
    constant: 'ARCHIVE_KNOWLEDGE_CONFLICT_MEMBER_COMMAND_V1', identifier: 'ai_knowledge.ArchiveKnowledgeConflictMemberCommand.v1',
    resultConstant: 'ARCHIVE_KNOWLEDGE_CONFLICT_MEMBER_RESULT_V1', resultIdentifier: 'ai_knowledge.ArchiveKnowledgeConflictMemberResult.v1',
    parser: 'parseArchiveKnowledgeConflictMemberCommandV1', factory: 'createArchiveKnowledgeConflictMemberHandlerV1', method: 'archiveConflictMember',
    command: { itemId: 'loser-1' }, mapped: { itemId: 'loser-1' }, result: { updated: true },
  },
  {
    constant: 'CLEAR_KNOWLEDGE_CONFLICT_WINNER_COMMAND_V1', identifier: 'ai_knowledge.ClearKnowledgeConflictWinnerCommand.v1',
    resultConstant: 'CLEAR_KNOWLEDGE_CONFLICT_WINNER_RESULT_V1', resultIdentifier: 'ai_knowledge.ClearKnowledgeConflictWinnerResult.v1',
    parser: 'parseClearKnowledgeConflictWinnerCommandV1', factory: 'createClearKnowledgeConflictWinnerHandlerV1', method: 'clearConflictWinner',
    command: { itemId: 'winner-1' }, mapped: { itemId: 'winner-1' }, result: { updated: true },
  },
  {
    constant: 'CLEAR_KNOWLEDGE_CONFLICT_GROUP_COMMAND_V1', identifier: 'ai_knowledge.ClearKnowledgeConflictGroupCommand.v1',
    resultConstant: 'CLEAR_KNOWLEDGE_CONFLICT_GROUP_RESULT_V1', resultIdentifier: 'ai_knowledge.ClearKnowledgeConflictGroupResult.v1',
    parser: 'parseClearKnowledgeConflictGroupCommandV1', factory: 'createClearKnowledgeConflictGroupHandlerV1', method: 'clearConflictGroup',
    command: { conflictGroupId: 'group-1' }, mapped: { conflictGroupId: 'group-1' }, result: { updated: true },
  },
  {
    constant: 'CREATE_MANUAL_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1', identifier: 'ai_knowledge.CreateManualGovernanceKnowledgeItemCommand.v1',
    resultConstant: 'CREATE_MANUAL_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1', resultIdentifier: 'ai_knowledge.CreateManualGovernanceKnowledgeItemResult.v1',
    parser: 'parseCreateManualGovernanceKnowledgeItemCommandV1', factory: 'createCreateManualGovernanceKnowledgeItemHandlerV1', method: 'createManualItem',
    command: { itemId: 'manual-1', sectionId: 'section-1', title: 'Manual', canonicalStatement: 'Statement', tags: ['type:manual'], safetyLevel: 'normal', actorId: 'actor-1' },
    mapped: { itemId: 'manual-1', sectionId: 'section-1', title: 'Manual', canonicalStatement: 'Statement', tags: ['type:manual'], safetyLevel: 'normal', actorId: 'actor-1' },
    result: { created: true },
  },
  {
    constant: 'MARK_KNOWLEDGE_ITEM_SOURCES_DISABLED_COMMAND_V1', identifier: 'ai_knowledge.MarkKnowledgeItemSourcesDisabledCommand.v1',
    resultConstant: 'MARK_KNOWLEDGE_ITEM_SOURCES_DISABLED_RESULT_V1', resultIdentifier: 'ai_knowledge.MarkKnowledgeItemSourcesDisabledResult.v1',
    parser: 'parseMarkKnowledgeItemSourcesDisabledCommandV1', factory: 'createMarkKnowledgeItemSourcesDisabledHandlerV1', method: 'markSourcesDisabled',
    command: { itemId: 'item-11' }, mapped: { itemId: 'item-11' }, result: { updated: true },
  },
  {
    constant: 'ARCHIVE_KNOWLEDGE_ITEM_AFTER_SOURCE_DISABLE_COMMAND_V1', identifier: 'ai_knowledge.ArchiveKnowledgeItemAfterSourceDisableCommand.v1',
    resultConstant: 'ARCHIVE_KNOWLEDGE_ITEM_AFTER_SOURCE_DISABLE_RESULT_V1', resultIdentifier: 'ai_knowledge.ArchiveKnowledgeItemAfterSourceDisableResult.v1',
    parser: 'parseArchiveKnowledgeItemAfterSourceDisableCommandV1', factory: 'createArchiveKnowledgeItemAfterSourceDisableHandlerV1', method: 'archiveAfterSourceDisable',
    command: { itemId: 'item-12' }, mapped: { itemId: 'item-12' }, result: { updated: true },
  },
  {
    constant: 'ARCHIVE_KNOWLEDGE_ITEM_FOR_CORE_RESET_COMMAND_V1', identifier: 'ai_knowledge.ArchiveKnowledgeItemForCoreResetCommand.v1',
    resultConstant: 'ARCHIVE_KNOWLEDGE_ITEM_FOR_CORE_RESET_RESULT_V1', resultIdentifier: 'ai_knowledge.ArchiveKnowledgeItemForCoreResetResult.v1',
    parser: 'parseArchiveKnowledgeItemForCoreResetCommandV1', factory: 'createArchiveKnowledgeItemForCoreResetHandlerV1', method: 'archiveForCoreReset',
    command: { itemId: 'item-13' }, mapped: { itemId: 'item-13' }, result: { updated: true },
  },
]

check('all 13 governance command and result identifiers are exact', () => {
  const commandConstants = Object.keys(contracts).filter((name) => name.endsWith('_COMMAND_V1'))
  const resultConstants = Object.keys(contracts).filter((name) => name.endsWith('_RESULT_V1'))
  assert.equal(commandConstants.length, 13)
  assert.equal(resultConstants.length, 13)
  for (const spec of specs) {
    assert.equal(contracts[spec.constant], spec.identifier)
    assert.equal(contracts[spec.resultConstant], spec.resultIdentifier)
  }
})

check('all 13 command envelopes are closed, versioned, and capability-free', () => {
  for (const spec of specs) {
    const command = { contract: contracts[spec.constant], ...spec.command }
    assert.deepEqual(plain(contracts[spec.parser](command)), command)
    assert.throws(
      () => contracts[spec.parser]({ ...command, sql: 'UPDATE anything' }),
      (error) => error.code === 'INVALID_CONTRACT',
    )
    assert.throws(
      () => contracts[spec.parser]({ ...command, contract: spec.identifier.replace(/\.v1$/, '.v2') }),
      (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    )
  }
  for (const level of ['normal', 'sensitive', 'requires_human']) {
    const spec = specs[9]
    const command = { contract: contracts[spec.constant], ...spec.command, safetyLevel: level }
    assert.equal(contracts[spec.parser](command).safetyLevel, level)
  }
  assert.throws(() => contracts.parseEditGovernanceKnowledgeItemCommandV1({
    contract: contracts.EDIT_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
    itemId: 'item', patch: { where: { id: 'other' } },
  }))
  const source = read(paths.contract)
  assert.doesNotMatch(source, /@\/lib\/prisma|@prisma\/client|TransactionClient|PrismaPromise|\$queryRaw|\$executeRaw|\bSQL\b/i)
})

await checkAsync('all 13 owner handlers preserve exact named port mappings and envelopes', async () => {
  const calls = []
  const port = Object.fromEntries(specs.map((spec) => [spec.method, async (input) => {
    calls.push([spec.method, plain(input)])
  }]))
  for (const spec of specs) {
    const command = { contract: contracts[spec.constant], ...spec.command }
    const before = calls.length
    const result = await handlers[spec.factory](port)(command)
    assert.deepEqual(calls.slice(before), [[spec.method, spec.mapped]])
    assert.deepEqual(plain(result), { contract: contracts[spec.resultConstant], ...spec.result })
  }
  const whitespaceIdentityCases = [
    {
      factory: 'createVerifyGovernanceKnowledgeItemHandlerV1',
      method: 'verifyItem',
      command: {
        contract: contracts.VERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
        itemId: ' ',
        actorId: '  ',
      },
      mapped: { itemId: ' ', actorId: '  ' },
    },
    {
      factory: 'createClearKnowledgeConflictGroupHandlerV1',
      method: 'clearConflictGroup',
      command: {
        contract: contracts.CLEAR_KNOWLEDGE_CONFLICT_GROUP_COMMAND_V1,
        conflictGroupId: '   ',
      },
      mapped: { conflictGroupId: '   ' },
    },
    {
      factory: 'createCreateManualGovernanceKnowledgeItemHandlerV1',
      method: 'createManualItem',
      command: {
        contract: contracts.CREATE_MANUAL_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
        itemId: ' ',
        sectionId: '  ',
        title: 'Title',
        canonicalStatement: 'Statement',
        tags: ['type:manual'],
        safetyLevel: 'normal',
        actorId: '   ',
      },
      mapped: {
        itemId: ' ',
        sectionId: '  ',
        title: 'Title',
        canonicalStatement: 'Statement',
        tags: ['type:manual'],
        safetyLevel: 'normal',
        actorId: '   ',
      },
    },
  ]
  for (const identityCase of whitespaceIdentityCases) {
    const before = calls.length
    await handlers[identityCase.factory](port)(identityCase.command)
    assert.deepEqual(calls.slice(before), [[identityCase.method, identityCase.mapped]])
  }
  const expectedMethods = specs.map((spec) => spec.method).sort()
  const handlerFile = sourceFile(paths.handler)
  const portInterface = handlerFile.statements.find(
    (statement) => typescript.isInterfaceDeclaration(statement)
      && statement.name.text === 'KnowledgeGovernancePersistencePortV1',
  )
  assert.ok(portInterface)
  assert.deepEqual(portInterface.members.map((member) => member.name.getText()).sort(), expectedMethods)
  const portText = portInterface.getText(handlerFile)
  assert.doesNotMatch(portText, /TransactionClient|PrismaPromise|\bPrisma\b|\$queryRaw|\$executeRaw|\b(?:sql|table|model|delegate|where|data|tx)\s*[?:,(]/i)
  assert.doesNotMatch(portText, /\b(?:any|unknown)\b|Record\s*</)
})

await checkAsync('empty edit is an explicit owner no-op and owner failures remain visible', async () => {
  let editCalls = 0
  const port = Object.fromEntries(specs.map((spec) => [spec.method, async () => {
    if (spec.method === 'editItem') editCalls += 1
  }]))
  assert.deepEqual(plain(await handlers.createEditGovernanceKnowledgeItemHandlerV1(port)({
    contract: contracts.EDIT_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
    itemId: 'item-1',
    patch: {},
  })), {
    contract: contracts.EDIT_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1,
    updated: false,
  })
  assert.equal(editCalls, 0)
  assert.deepEqual(plain(await handlers.createEditGovernanceKnowledgeItemHandlerV1(port)({
    contract: contracts.EDIT_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
    itemId: 'item-undefined',
    patch: {
      title: undefined,
      canonicalStatement: undefined,
      tags: undefined,
      safetyLevel: undefined,
    },
  })), {
    contract: contracts.EDIT_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1,
    updated: false,
  })
  assert.equal(editCalls, 0, 'explicit undefined fields must not reach the persistence port')
  for (const spec of specs) {
    const failing = Object.fromEntries(specs.map((entry) => [entry.method, async () => {
      if (entry.method === spec.method) throw new Error(`${entry.method} failed`)
    }]))
    await assert.rejects(
      handlers[spec.factory](failing)({ contract: contracts[spec.constant], ...spec.command }),
      new RegExp(`${spec.method} failed`),
    )
  }
})

check('public indexes expose every governance handler through one exact adapter', () => {
  assert.match(read(paths.contractIndex), /export \* from '\.\/knowledge-governance-commands'/)
  const publicIndex = read(paths.publicIndex)
  for (const spec of specs) {
    const exported = spec.factory.replace(/^create/, '').replace(/HandlerV1$/, 'V1')
    const runtimeName = exported[0].toLowerCase() + exported.slice(1)
    assert.ok(publicIndex.includes(runtimeName), `${runtimeName} is missing from public index`)
    assert.ok(publicIndex.includes(spec.factory), `${spec.factory} is missing from public index`)
  }
  assert.match(publicIndex, /legacyPrismaKnowledgeGovernancePortV1/)
})

check('protected UI and trainer verification surfaces retain pinned identities', () => {
  assert.deepEqual({
    ui: sha256(paths.ui),
    trainer: sha256(paths.trainer),
    trainerContract: sha256(paths.trainerContract),
    trainerHandler: sha256(paths.trainerHandler),
    trainerAdapter: sha256(paths.trainerAdapter),
  }, {
    ui: '84c310bf76ac7538a10a5c3daedeae54a7a5576123835a094c88b6ae56734e94',
    trainer: '7a1acd91faf8140364321c8b0480fae7deec686abab3570646861ced9720ae59',
    trainerContract: '9d3b40f4f5d625330fd3ecb7aadfa64314c193a9e0c03b814e8df5845a1d581b',
    trainerHandler: 'd0fbb7c68365664d9744c5ec5c848461657b458cf613b15118d782546ea08bc6',
    trainerAdapter: '9e2a948d58df057a500f5bdf085fbd15bc090cc1ee153a238ad755b29a6c7d06',
  })
  const trainer = read(paths.trainer)
  assert.match(trainer, /verifyKnowledgeItemV1\(\{ contract: VERIFY_KNOWLEDGE_ITEM_COMMAND_V1/)
  assert.doesNotMatch(trainer, /VerifyGovernanceKnowledgeItem|verifyGovernanceKnowledgeItemV1/)
})

check('single-item callers retain auth, read, validation, owner write, reload, audit, revalidate order', () => {
  const edit = functionSource(paths.actions, 'editKnowledgeItem')
  assertOrdered(edit, [
    'requireAdminUserId()',
    'loadItemForEdit(id)',
    "if (!before) throw new Error('Знание не найдено')",
    'const normalizedPatch:',
    'if (patch.title !== undefined)',
    'normalizedPatch.title = patch.title.trim()',
    'if (patch.canonicalStatement !== undefined)',
    'normalizedPatch.canonicalStatement = patch.canonicalStatement.trim()',
    'if (patch.tags !== undefined)',
    'normalizedPatch.tags = patch.tags',
    'if (patch.safetyLevel !== undefined)',
    'normalizedPatch.safetyLevel = patch.safetyLevel',
    'if (Object.keys(normalizedPatch).length === 0) return',
    'await editGovernanceKnowledgeItemV1({',
    'const after = await loadItemForEdit(id)',
    'const changedFields = Object.keys(patch)',
    'await writeAuditEntry({',
    "revalidatePath('/settings/ai')",
  ], 'editKnowledgeItem')
  assert.doesNotMatch(edit, /\$executeRaw|\$transaction/)

  const archive = functionSource(paths.actions, 'archiveKnowledgeItem')
  assertOrdered(archive, [
    'requireAdminUserId()', 'loadItemForEdit(id)', "if (!before) throw new Error('Знание не найдено')",
    "if (before.status === 'archived') return", 'archiveGovernanceKnowledgeItemV1({',
    'loadItemForEdit(id)', 'writeAuditEntry({', "revalidatePath('/settings/ai')",
  ], 'archiveKnowledgeItem')

  const restore = functionSource(paths.actions, 'restoreKnowledgeItem')
  assertOrdered(restore, [
    'requireAdminUserId()', 'loadItemForEdit(id)', "if (!before) throw new Error('Знание не найдено')",
    "if (before.status === 'active' && before.isActive) return", "if (before.status === 'superseded')",
    'restoreGovernanceKnowledgeItemV1({', 'loadItemForEdit(id)', 'writeAuditEntry({',
    "revalidatePath('/settings/ai')",
  ], 'restoreKnowledgeItem')

  const verify = functionSource(paths.actions, 'verifyKnowledgeItem')
  assertOrdered(verify, [
    'requireAdminUserId()', 'loadItemForEdit(id)', "if (!before) throw new Error('Знание не найдено')",
    'if (before.isVerified === verified) return', 'if (verified)', 'verifyGovernanceKnowledgeItemV1({',
    '} else {', 'unverifyGovernanceKnowledgeItemV1({', 'loadItemForEdit(id)', 'writeAuditEntry({',
    "action: verified ? 'verified' : 'unverified'", "revalidatePath('/settings/ai')",
  ], 'verifyKnowledgeItem')
  assert.doesNotMatch(verify, /verified\s*===\s*true/)

  const supersede = functionSource(paths.actions, 'supersedeKnowledgeItem')
  assertOrdered(supersede, [
    'requireAdminUserId()', 'if (oldItemId === newItemId)', 'loadItemForEdit(oldItemId)',
    'loadItemForEdit(newItemId)', 'if (!oldBefore)', 'if (!newBefore)',
    'if (oldBefore.sectionId !== newBefore.sectionId)', "if (newBefore.status === 'superseded')",
    'if (newBefore.supersededByItemId === oldItemId)', 'supersedeGovernanceKnowledgeItemV1({',
    'loadItemForEdit(oldItemId)', 'writeAuditEntry({', 'writeAuditEntry({',
    "revalidatePath('/settings/ai')",
  ], 'supersedeKnowledgeItem')
  for (const body of [archive, restore, verify, supersede]) {
    assert.doesNotMatch(body, /\$executeRaw|\$transaction|Promise\.all/)
  }
})

check('runtime-only edit and branch behavior remains deliberately legacy-compatible', () => {
  const edit = functionSource(paths.actions, 'editKnowledgeItem')
  assert.match(edit, /const normalizedPatch: KnowledgeGovernanceEditPatchV1 = \{\}/)
  assert.equal((edit.match(/normalizedPatch\.[A-Za-z]+\s*=/g) || []).length, 4)
  assert.match(edit, /if \(Object\.keys\(normalizedPatch\)\.length === 0\) return/)
  assert.match(edit, /const changedFields = Object\.keys\(patch\)/)
  assert.doesNotMatch(edit, /Object\.keys\(patch\).*unsupported|unsupported.*Object\.keys\(patch\)/s)

  const verify = functionSource(paths.actions, 'verifyKnowledgeItem')
  assert.match(verify, /if \(verified\) \{/)
  assert.doesNotMatch(verify, /typeof verified|verified === true/)

  const conflict = functionSource(paths.actions, 'resolveConflict')
  assert.match(conflict, /if \(action === 'keep_this_archive_others'\) \{/)
  assert.match(conflict, /\} else \{\s*\/\/ unmark_all/)
  assert.doesNotMatch(conflict, /action\s*!==\s*'unmark_all'|\['keep_this_archive_others',\s*'unmark_all'\]\.includes/)
})

check('conflict resolution retains reads, per-member partial success, audit, and final revalidation', () => {
  const conflict = functionSource(paths.actions, 'resolveConflict')
  assertOrdered(conflict, [
    'requireAdminUserId()', 'loadItemForEdit(itemId)', "if (!before) throw new Error('Знание не найдено')",
    'const groupId = before.conflictGroupId', "if (!groupId) throw new Error('У этого знания нет конфликта')",
    'SELECT', 'FROM "AiKnowledgeItem"', 'if (action === \'keep_this_archive_others\')',
    'for (const m of members)', 'if (m.id === itemId) continue', "if (m.status === 'archived') continue",
    'archiveKnowledgeConflictMemberV1({', 'loadItemForEdit(m.id)', 'writeAuditEntry({',
    'clearKnowledgeConflictWinnerV1({', 'loadItemForEdit(itemId)', 'writeAuditEntry({',
    '} else {', 'clearKnowledgeConflictGroupV1({', 'for (const m of members)',
    'loadItemForEdit(m.id)', 'writeAuditEntry({', "revalidatePath('/settings/ai')",
  ], 'resolveConflict')
  assert.doesNotMatch(conflict, /\$executeRaw|\$transaction|Promise\.all/)
})

check('manual create retains validation, owner item, source, reload, audit, revalidate sequence', () => {
  const manual = functionSource(paths.actions, 'createManualKnowledgeItem')
  assertOrdered(manual, [
    'requireAdminUserId()', "if (!input.sectionId) throw new Error('Раздел обязателен')",
    "if (!input.title?.trim())", "if (!input.canonicalStatement?.trim())",
    'SELECT id FROM "AiKnowledgeSection"', "if (!sec[0]) throw new Error('Раздел не найден или отключён')",
    "const safety = input.safetyLevel ?? 'normal'", "const itemId = 'kbi_m_'",
    'tagSet.add(\'type:manual\')', 'await createManualGovernanceKnowledgeItemV1({',
    "const sourceId = 'kbs_m_'", 'await attachManualKnowledgeSourceV1({',
    'loadItemForEdit(itemId)', 'writeAuditEntry({', "revalidatePath('/settings/ai')", 'return { itemId }',
  ], 'createManualKnowledgeItem')
  assert.doesNotMatch(manual, /INSERT INTO "AiKnowledgeItem"|\$transaction|Promise\.all/)
})

check('source-disable workflow retains ordered reads, owner writes, audits, counters, and no transaction', () => {
  const disable = functionSource(paths.actions, 'disableKnowledgeSource')
  assertOrdered(disable, [
    'requireAdminUserId()', 'if (!input.channel || !input.connectionId)',
    'SELECT DISTINCT "itemId"', 'disableKnowledgeSourcesV1({',
    'if (affectedItemIds.length === 0) return result', 'for (const itemId of affectedItemIds)',
    'FROM "AiKnowledgeItem"', 'if (!item) continue', "if (item.status !== 'active')",
    'SELECT COUNT(*)::int AS cnt', 'if (activeSources > 0)',
    "const isManual = Array.isArray(item.tags) && item.tags.includes('type:manual')",
    'const shouldKeepActive = item.isVerified === true || isManual', 'if (shouldKeepActive)',
    "item.tags.includes('sources_all_disabled')", 'if (!hasMarker)',
    'markKnowledgeItemSourcesDisabledV1({', 'writeAuditEntry({', 'itemsKeptWithWarning++',
    '} else {', 'archiveKnowledgeItemAfterSourceDisableV1({', 'writeAuditEntry({',
    'itemsAutoArchived++', 'writeAuditEntry({', "revalidatePath('/settings/ai')", 'return result',
  ], 'disableKnowledgeSource')
  assert.doesNotMatch(disable, /UPDATE "AiKnowledgeItem"|\$transaction|Promise\.all/)
})

check('reset and bulk workflows retain deliberate non-transactional partial-success loops', () => {
  const reset = functionSource(paths.actions, 'resetKnowledgeCore')
  assertOrdered(reset, [
    'requireAdminUserId()', "if (!['auto_only', 'unverified', 'full'].includes(mode))",
    "if (mode === 'full' && typedConfirm !== 'ОЧИСТИТЬ')", 'const runtimeWasEnabled = isRuntimeEnabled()',
    "if (mode === 'auto_only')", "else if (mode === 'unverified')", 'SELECT COUNT(*)::int AS cnt',
    'const archivedCount = rowsToArchive.length', 'for (const item of rowsToArchive)',
    'archiveKnowledgeItemForCoreResetV1({', 'writeAuditEntry({', 'writeAuditEntry({',
    "revalidatePath('/settings/ai')", 'return { mode, archivedCount, keptCount, alreadyArchived, runtimeWasEnabled }',
  ], 'resetKnowledgeCore')
  assert.doesNotMatch(reset, /UPDATE "AiKnowledgeItem"|\$transaction|Promise\.all/)

  const verifyBulk = functionSource(paths.actions, 'bulkVerifyItems')
  assertOrdered(verifyBulk, [
    'requireAdminUserId()', 'for (const id of itemIds)', 'try {', 'loadItemForEdit(id)',
    'if (!cur)', 'if (cur.isVerified)', 'verifyKnowledgeItem(id, true)', 'result.processed++',
    '} catch', 'result.failed++', "if (result.processed > 0) revalidatePath('/settings/ai')", 'return result',
  ], 'bulkVerifyItems')

  const archiveBulk = functionSource(paths.actions, 'bulkArchiveDraftsInSection')
  assertOrdered(archiveBulk, [
    'requireAdminUserId()', 'if (!sectionId) return result', 'try {', 'SELECT id FROM "AiKnowledgeItem"',
    '} catch', 'return result', 'for (const r of drafts)', 'try {', 'archiveKnowledgeItem(r.id)',
    'result.processed++', '} catch', 'result.failed++',
    "if (result.processed > 0) revalidatePath('/settings/ai')", 'return result',
  ], 'bulkArchiveDraftsInSection')
  for (const body of [verifyBulk, archiveBulk]) {
    assert.doesNotMatch(body, /\$transaction|Promise\.all/)
    assert.match(body, /for \(/)
    assert.match(body, /catch/)
  }
})

await checkAsync('runtime edit ignores unsupported-only input but preserves legacy audit metadata for mixed input', async () => {
  const before = { id: 'item-edit', title: 'Before', status: 'active', isActive: true }
  const after = { ...before, title: 'X' }

  const unsupportedOnly = loadActionHarness({ queryResults: [[before]] })
  await unsupportedOnly.actions.editKnowledgeItem('item-edit', {
    title: undefined,
    unknown: 'ignored',
  })
  assert.deepEqual(unsupportedOnly.events.map((event) => event[0]), ['query'])
  assert.equal(unsupportedOnly.queue.length, 0)

  const mixed = loadActionHarness({ queryResults: [[before], [after]] })
  await mixed.actions.editKnowledgeItem('item-edit', {
    title: '  X  ',
    unknown: 'audit-only',
  })
  assert.deepEqual(mixed.events.map((event) => (
    event[0] === 'owner' ? `${event[0]}:${event[1]}` : event[0]
  )), [
    'query',
    'owner:editGovernanceKnowledgeItemV1',
    'query',
    'audit',
    'revalidate',
  ])
  assert.deepEqual(mixed.events[1][2].patch, { title: 'X' })
  assert.deepEqual(mixed.events[3][1].metadata.changedFields, ['title', 'unknown'])
  assert.equal(mixed.queue.length, 0)
})

await checkAsync('runtime verify preserves truthy non-boolean legacy branching', async () => {
  const before = { id: 'item-verify', isVerified: false, status: 'active', isActive: true }
  const after = { ...before, isVerified: true, verifiedBy: 'actor-1' }
  const harness = loadActionHarness({ queryResults: [[before], [after]] })
  await harness.actions.verifyKnowledgeItem('item-verify', 'truthy')

  assert.deepEqual(harness.events.map((event) => (
    event[0] === 'owner' ? `${event[0]}:${event[1]}` : event[0]
  )), [
    'query',
    'owner:verifyGovernanceKnowledgeItemV1',
    'query',
    'audit',
    'revalidate',
  ])
  assert.deepEqual(harness.events[1][2], {
    contract: contracts.VERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
    itemId: 'item-verify',
    actorId: 'actor-1',
  })
  assert.equal(harness.events[3][1].action, 'verified')
  assert.equal(harness.queue.length, 0)
})

await checkAsync('runtime non-exact conflict action falls through to legacy clear-group behavior', async () => {
  const winner = {
    id: 'winner', conflictGroupId: 'group-1', status: 'active', isActive: true,
  }
  const loser = {
    id: 'loser', conflictGroupId: 'group-1', status: 'active', isActive: true,
  }
  const harness = loadActionHarness({
    queryResults: [
      [winner],
      [winner, loser],
      [{ ...winner, conflictGroupId: null }],
      [{ ...loser, conflictGroupId: null }],
    ],
  })
  await harness.actions.resolveConflict('winner', 'unexpected')

  assert.deepEqual(harness.events.map((event) => (
    event[0] === 'owner' ? `${event[0]}:${event[1]}` : event[0]
  )), [
    'query',
    'query',
    'owner:clearKnowledgeConflictGroupV1',
    'query',
    'audit',
    'query',
    'audit',
    'revalidate',
  ])
  assert.deepEqual(harness.events[2][2], {
    contract: contracts.CLEAR_KNOWLEDGE_CONFLICT_GROUP_COMMAND_V1,
    conflictGroupId: 'group-1',
  })
  const memberAudits = harness.events.filter((event) => event[0] === 'audit')
  assert.deepEqual(memberAudits.map((event) => event[1].itemId), ['winner', 'loser'])
  assert.ok(memberAudits.every((event) => (
    event[1].metadata.resolution === 'unmark_all'
      && event[1].metadata.formerGroupId === 'group-1'
  )))
  assert.equal(harness.queue.length, 0)
})

await checkAsync('runtime conflict loser failure preserves earlier audit and blocks later winner work', async () => {
  const winner = {
    id: 'winner', conflictGroupId: 'group-2', status: 'active', isActive: true,
  }
  const archived = {
    id: 'archived', conflictGroupId: 'group-2', status: 'archived', isActive: false,
  }
  const loserOne = {
    id: 'loser-1', conflictGroupId: 'group-2', status: 'active', isActive: true,
  }
  const loserTwo = {
    id: 'loser-2', conflictGroupId: 'group-2', status: 'active', isActive: true,
  }
  const harness = loadActionHarness({
    queryResults: [
      [winner],
      [winner, archived, loserOne, loserTwo],
      [{ ...loserOne, conflictGroupId: null, status: 'archived', isActive: false }],
    ],
    failOwnerAt: { archiveKnowledgeConflictMemberV1: 2 },
  })
  await assert.rejects(
    harness.actions.resolveConflict('winner', 'keep_this_archive_others'),
    /owner:archiveKnowledgeConflictMemberV1/,
  )

  assert.deepEqual(harness.events.map((event) => (
    event[0] === 'owner' ? `${event[0]}:${event[1]}` : event[0]
  )), [
    'query',
    'query',
    'owner:archiveKnowledgeConflictMemberV1',
    'query',
    'audit',
    'owner:archiveKnowledgeConflictMemberV1',
  ])
  const ownerCommands = harness.events.filter((event) => event[0] === 'owner')
  assert.deepEqual(ownerCommands.map((event) => event[2].itemId), ['loser-1', 'loser-2'])
  assert.equal(harness.events[4][1].itemId, 'loser-1')
  assert.ok(!ownerCommands.some((event) => event[1] === 'clearKnowledgeConflictWinnerV1'))
  assert.ok(!harness.events.some((event) => event[0] === 'revalidate'))
  assert.equal(harness.queue.length, 0)
})

await checkAsync('runtime manual source-attach failure occurs after durable item owner call', async () => {
  const harness = loadActionHarness({
    queryResults: [[{ id: 'section-1' }]],
    failingOwners: ['attachManualKnowledgeSourceV1'],
  })
  await assert.rejects(harness.actions.createManualKnowledgeItem({
    sectionId: 'section-1',
    title: '  Manual  ',
    canonicalStatement: '  Statement  ',
    tags: ['custom'],
  }), /owner:attachManualKnowledgeSourceV1/)

  assert.deepEqual(harness.events.map((event) => (
    event[0] === 'owner' ? `${event[0]}:${event[1]}` : event[0]
  )), [
    'query',
    'owner:createManualGovernanceKnowledgeItemV1',
    'owner:attachManualKnowledgeSourceV1',
  ])
  const createCommand = harness.events[1][2]
  const attachCommand = harness.events[2][2]
  assert.equal(createCommand.itemId, attachCommand.itemId)
  assert.equal(createCommand.title, 'Manual')
  assert.equal(createCommand.canonicalStatement, 'Statement')
  assert.deepEqual(createCommand.tags, ['custom', 'type:manual'])
  assert.ok(!harness.events.some((event) => event[0] === 'audit' || event[0] === 'revalidate'))
  assert.equal(harness.queue.length, 0)
})

await checkAsync('runtime source disable keeps validation and truthy-audit legacy semantics', async () => {
  const invalid = loadActionHarness()
  await assert.rejects(
    invalid.actions.disableKnowledgeSource({ channel: '', connectionId: 'connection-1' }),
    /channel и connectionId обязательны/,
  )
  assert.deepEqual(invalid.events, [])

  const item = {
    id: 'manual-item',
    status: 'active',
    isActive: true,
    isVerified: 'truthy',
    tags: ['type:manual', 'sources_all_disabled'],
  }
  const harness = loadActionHarness({
    queryResults: [
      [{ itemId: item.id }],
      [item],
      [{ cnt: 0 }],
    ],
  })
  const result = await harness.actions.disableKnowledgeSource({
    channel: 'whatsapp',
    connectionId: 'connection-1',
  })

  assert.deepEqual(plain(result), {
    sourcesDisabled: 1,
    itemsAutoArchived: 0,
    itemsKeptWithWarning: 1,
    itemsUnaffected: 0,
  })
  assert.deepEqual(harness.events.map((event) => (
    event[0] === 'owner' ? `${event[0]}:${event[1]}` : event[0]
  )), [
    'query',
    'owner:disableKnowledgeSourcesV1',
    'query',
    'query',
    'audit',
    'audit',
    'revalidate',
  ])
  const ownerEvents = harness.events.filter((event) => event[0] === 'owner')
  assert.deepEqual(ownerEvents.map((event) => event[1]), ['disableKnowledgeSourcesV1'])
  assert.equal(harness.events[4][1].metadata.outcome, 'kept_active_warning')
  assert.equal(harness.events[4][1].metadata.reason, 'verified')
  assert.equal(harness.queue.length, 0)
})

await checkAsync('runtime reset item failure preserves earlier item audit and blocks final event', async () => {
  const itemOne = { id: 'reset-1', status: 'active', isActive: true }
  const itemTwo = { id: 'reset-2', status: 'active', isActive: true }
  const harness = loadActionHarness({
    queryResults: [
      [itemOne, itemTwo],
      [{ cnt: 3 }],
      [{ cnt: 4 }],
    ],
    failOwnerAt: { archiveKnowledgeItemForCoreResetV1: 2 },
    runtimeEnabled: true,
  })
  await assert.rejects(
    harness.actions.resetKnowledgeCore('unverified'),
    /owner:archiveKnowledgeItemForCoreResetV1/,
  )

  assert.deepEqual(harness.events.map((event) => (
    event[0] === 'owner' ? `${event[0]}:${event[1]}` : event[0]
  )), [
    'query',
    'query',
    'query',
    'owner:archiveKnowledgeItemForCoreResetV1',
    'audit',
    'owner:archiveKnowledgeItemForCoreResetV1',
  ])
  const ownerCommands = harness.events.filter((event) => event[0] === 'owner')
  assert.deepEqual(ownerCommands.map((event) => event[2].itemId), ['reset-1', 'reset-2'])
  assert.equal(harness.events[4][1].itemId, 'reset-1')
  assert.deepEqual(harness.events[4][1].metadata, {
    mode: 'unverified',
    runtimeWasEnabled: true,
  })
  assert.ok(!harness.events.some((event) => (
    event[0] === 'revalidate'
      || (event[0] === 'audit' && event[1].itemId === null)
  )))
  assert.equal(harness.queue.length, 0)
})

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
