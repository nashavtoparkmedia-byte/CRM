#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'

import { extractPrismaWrites, scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = relative => readFileSync(path.join(root, relative), 'utf8')
const require = createRequire(import.meta.url)
const ts = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
const checks = []
const check = (name, run) => { run(); checks.push(name) }
const checkAsync = async (name, run) => { await run(); checks.push(name) }

const paths = {
  tasks: 'gravity-mvp/src/app/tasks/actions.ts',
  contacts: 'gravity-mvp/src/lib/ContactService.ts',
  workflow: 'gravity-mvp/src/lib/ConversationWorkflowService.ts',
  extractor: 'gravity-mvp/src/lib/ai/knowledge/Extractor.ts',
  audit: 'gravity-mvp/src/lib/ai/knowledge/auditLog.ts',
  migration: 'gravity-mvp/src/lib/ai/knowledge/legacyMigration.ts',
  messageEvents: 'gravity-mvp/src/lib/messageEvents.ts',
  scenarioFields: 'gravity-mvp/src/lib/tasks/scenario-fields.ts',
  usage: 'gravity-mvp/src/lib/tasks/usage.ts',
}

const expectedTables = {
  [paths.tasks]: { tasks: 1 },
  [paths.contacts]: { ContactIdentity: 1 },
  [paths.workflow]: { Chat: 16 },
  [paths.extractor]: { AiKnowledgeItem: 4, AiKnowledgeSource: 3, AiExtractionJob: 3 },
  [paths.audit]: { AiKnowledgeAuditLog: 1 },
  [paths.migration]: { AiKnowledgeItem: 1, AiKnowledgeSource: 1 },
  [paths.messageEvents]: { MessageEventLog: 1 },
  [paths.scenarioFields]: { tasks: 2 },
  [paths.usage]: { usage_events: 1 },
}

const retiredFingerprints = [
  'arch_426845ea7ee5a12db18a3eb9',
  'arch_3bb6bcb48551c2c1f33ee42f',
  'arch_c7c39b64fe8479d85158a07d',
  'arch_082bee3f3835458c4d3a75a9',
  'arch_d1dcb6b79fb4285d9db9567d',
  'arch_03a2822e6b0ed83a5b426a21',
  'arch_438caa28b4d2293c3971e382',
  'arch_f22521adc4f7b6245679405b',
  'arch_4346afd1734f5209a5651602',
  'arch_7d68f40450f1a8e20d97dff6',
  'arch_cec7f9b39beb9926341922b7',
  'arch_b3dce82f88b5f09ad2592731',
  'arch_e4aa4f86fd077d3016543bee',
  'arch_7bfb0c4d840c690d44a7b059',
  'arch_6964e16d79bb402d78dd81c8',
  'arch_38057fbef2bd6ddb46d478ce',
  'arch_681bf1228d3df4f105771b9f',
  'arch_dab5d716f440e75560df9f04',
  'arch_b503671b339d2ccba4e6a91e',
  'arch_ae925e638c71cd7c87690e96',
  'arch_9405b2e0c3a1e469ec3a5ee8',
  'arch_e284bd79fbf65b2373aa434b',
  'arch_2e20540bc30816ae2cb076fe',
  'arch_3c859af8ee64038352fb0b5d',
  'arch_b8a087987d55c06f4e959c33',
  'arch_c5aa795cdee1279da7d78dcb',
  'arch_68321aae1812ea3ab21ae074',
].sort()

function unsafeCalls(relative) {
  const source = read(relative)
  const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const calls = []
  function visit(node) {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === '$executeRawUnsafe'
    ) {
      const sqlNode = node.arguments[0]
      assert.ok(
        ts.isStringLiteral(sqlNode) || ts.isNoSubstitutionTemplateLiteral(sqlNode),
        `${relative}:${ast.getLineAndCharacterOfPosition(node.getStart()).line + 1} SQL must be a direct literal`,
      )
      const sql = sqlNode.text
      const args = node.arguments.slice(1).map(argument => argument.getText(ast))
      const placeholders = [...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]))
      const unique = [...new Set(placeholders)].sort((left, right) => left - right)
      assert.deepEqual(unique, Array.from({ length: args.length }, (_, index) => index + 1))
      calls.push({ sql, args })
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return calls
}

function transpile(relative) {
  return ts.transpileModule(read(relative), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
}

function evaluate(relative, imports, globals = {}) {
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
    ...globals,
  })
  return module.exports
}

function loadWorkflow(queryResults, execute = async () => 0) {
  const queries = []
  const writes = []
  const queue = [...queryResults]
  const prisma = new Proxy({
    async $queryRaw(strings, ...args) {
      queries.push([strings.join('?'), ...args])
      return queue.shift() ?? []
    },
    async $executeRawUnsafe(...args) {
      writes.push(args)
      return execute(...args)
    },
  }, {
    get(target, property, receiver) {
      if (property === '$queryRaw' || property === '$executeRawUnsafe') {
        return Reflect.get(target, property, receiver)
      }
      throw new Error(`unexpected Prisma workflow capability: ${String(property)}`)
    },
  })
  const loaded = evaluate(paths.workflow, { '@/lib/prisma': { prisma } })
  return { service: loaded.ConversationWorkflowService, queries, writes }
}

const scan = await scanArchitecture(root)
const registry = JSON.parse(read(scan.policy.exception_registry))
const currentIds = new Set(scan.findings.map(finding => finding.fingerprint))
const registryIds = new Set(registry.exceptions.map(exception => exception.fingerprint))
const additions = [...currentIds].filter(id => !registryIds.has(id)).sort()
const stale = [...registryIds].filter(id => !currentIds.has(id)).sort()

check('exact 27 reviewed dynamic-fragment findings retire with no addition', () => {
  assert.equal(scan.findings.length, 1295)
  assert.equal(
    scan.findings.filter(finding => finding.rule === 'direct_foreign_prisma_write').length,
    0,
  )
  assert.deepEqual(additions, [])
  assert.ok([0, 48, 53].includes(stale.length))
  if (stale.length > 0) {
    for (const fingerprint of retiredFingerprints) assert.ok(stale.includes(fingerprint))
  }
  for (const fingerprint of retiredFingerprints) assert.equal(currentIds.has(fingerprint), false)
})

check('all replacement writes are direct fixed unsafe literals with exact positional binds', () => {
  let total = 0
  for (const [relative, tables] of Object.entries(expectedTables)) {
    const calls = unsafeCalls(relative)
    const expectedCount = Object.values(tables).reduce((sum, count) => sum + count, 0)
    assert.equal(calls.length, expectedCount, relative)
    total += calls.length
    const source = read(relative)
    assert.doesNotMatch(source, /\$executeRaw\s*`|Prisma\.(?:sql|raw)\s*`/)
    const writes = extractPrismaWrites(source).filter(write => write.kind === 'raw')
    assert.equal(writes.length, expectedCount)
    assert.ok(writes.every(write => write.method === '$executeRawUnsafe' && write.dynamic === false))
    const actualTables = Object.fromEntries([...new Set(writes.flatMap(write => write.tables))].sort().map(table => [
      table,
      writes.filter(write => write.tables.length === 1 && write.tables[0] === table).length,
    ]))
    assert.deepEqual(actualTables, tables)
  }
  assert.equal(total, 35)
})

check('JSON arrays enums and database timestamps retain exact casts and bind order', () => {
  const taskCall = unsafeCalls(paths.tasks)[0]
  assert.deepEqual(taskCall.args, ['JSON.stringify(scenarioData)', 'task.id'])
  assert.match(taskCall.sql, /\$1::jsonb[\s\S]*id = \$2/)

  const contactCall = unsafeCalls(paths.contacts)[0]
  assert.deepEqual(contactCall.args, ['contactIds'])
  assert.match(contactCall.sql, /ANY\(\$1::text\[\]\)/)

  const auditCall = unsafeCalls(paths.audit)[0]
  assert.deepEqual(auditCall.args, [
    'id', 'input.itemId', 'input.actor', 'input.action', 'beforeJson', 'afterJson', 'metaJson',
  ])
  assert.match(auditCall.sql, /\$4::"AiKnowledgeAuditAction"/)
  assert.equal((auditCall.sql.match(/::jsonb/g) ?? []).length, 3)
  assert.match(auditCall.sql, /NOW\(\)/)

  const extractionCalls = unsafeCalls(paths.extractor)
  assert.equal(extractionCalls.filter(call => call.sql.includes('::"AiKnowledgeSourceOrigin"')).length, 3)
  assert.equal(extractionCalls.filter(call => call.sql.includes('::"ChatChannel"')).length, 3)
  assert.equal(extractionCalls.filter(call => call.args.includes('JSON.stringify(progress)')).length, 3)
  const conflict = extractionCalls.find(call => call.sql.includes('WHERE id IN ($2, $3)'))
  assert.deepEqual(conflict.args, ['groupId', 'itemA.id', 'itemB.id', 'groupId'])

  const usageCall = unsafeCalls(paths.usage)[0]
  assert.deepEqual(usageCall.args, ['id', 'userId', 'action', 'payloadJson'])
  assert.match(usageCall.sql, /\$4::jsonb, NOW\(\)/)
})

check('semantic conversation selector is closed and generic SQL fragments are absent', () => {
  const source = read(paths.workflow)
  assert.match(source, /type ConversationGroupSelector\s*=\s*[\s\S]*kind: 'contact'[\s\S]*kind: 'driver'[\s\S]*kind: 'chat'/)
  assert.match(source, /_getGroupSelector\(chatId: string\): Promise<ConversationGroupSelector>/)
  assert.doesNotMatch(source, /Prisma\.Sql|_getGroupCondition|WHERE\s+\$\{/)
})

await checkAsync('conversation reads transitions and fixed group branches preserve order and zero-row behavior', async () => {
  const missing = loadWorkflow([[]])
  await missing.service.onInboundMessage('missing', new Date('2026-01-01T00:00:00Z'))
  assert.equal(missing.queries.length, 1)
  assert.deepEqual(missing.writes, [])

  const inboundAt = new Date('2026-01-02T00:00:00Z')
  const inbound = loadWorkflow([[{ status: 'resolved' }]])
  await inbound.service.onInboundMessage('chat-in', inboundAt)
  assert.deepEqual(inbound.writes[0].slice(1), [inboundAt, 'open', 'chat-in'])
  assert.match(inbound.writes[0][0], /"lastInboundAt" = \$1[\s\S]*status = \$2[\s\S]*id = \$3/)

  const outboundAt = new Date('2026-01-03T00:00:00Z')
  const outbound = loadWorkflow([[{ status: 'waiting_internal' }]])
  await outbound.service.onOutboundMessage('chat-out', outboundAt)
  assert.deepEqual(outbound.writes[0].slice(1), [outboundAt, 'waiting_customer', 'chat-out'])

  const contact = loadWorkflow([[{ status: 'new', contactId: 'contact-1', driverId: 'driver-ignored' }]])
  await contact.service.assignChat('chat-1', 'user-1')
  assert.match(contact.writes[0][0], /WHERE "contactId" = \$3/)
  assert.deepEqual(contact.writes[0].slice(1), ['user-1', 'open', 'contact-1'])

  const driver = loadWorkflow([[{ status: 'open', contactId: null, driverId: 'driver-1' }]])
  await driver.service.assignChat('chat-2', 'user-2')
  assert.match(driver.writes[0][0], /WHERE "driverId" = \$3/)
  assert.deepEqual(driver.writes[0].slice(1), ['user-2', 'open', 'driver-1'])

  const chat = loadWorkflow([[{ status: 'resolved', contactId: null, driverId: null }]])
  await chat.service.assignChat('chat-3', 'user-3')
  assert.match(chat.writes[0][0], /WHERE id = \$3/)
  assert.deepEqual(chat.writes[0].slice(1), ['user-3', 'resolved', 'chat-3'])

  const fallback = loadWorkflow([[]])
  await fallback.service.unassignChat('chat-fallback')
  assert.match(fallback.writes[0][0], /WHERE id = \$1/)
  assert.deepEqual(fallback.writes[0].slice(1), ['chat-fallback'])

  const resolved = loadWorkflow([[{ contactId: 'contact-2', driverId: 'driver-ignored' }]])
  await resolved.service.resolveChat('chat-resolve')
  assert.match(resolved.writes[0][0], /status = 'resolved'[\s\S]*WHERE "contactId" = \$1/)
  assert.deepEqual(resolved.writes[0].slice(1), ['contact-2'])

  const readGroup = loadWorkflow([[{ contactId: null, driverId: 'driver-2' }]])
  await readGroup.service.markRead('chat-read')
  assert.match(readGroup.writes[0][0], /"unreadCount" = 0[\s\S]*WHERE "driverId" = \$1/)
  assert.deepEqual(readGroup.writes[0].slice(1), ['driver-2'])
})

await checkAsync('write errors retain propagate-or-tolerate behavior without database execution', async () => {
  const failure = new Error('write failed')
  const workflow = loadWorkflow([], async () => { throw failure })
  await assert.rejects(
    workflow.service.onGroupInboundMessage('chat-error', new Date('2026-01-04T00:00:00Z')),
    error => error === failure,
  )

  const auditCalls = []
  const auditSuccess = evaluate(paths.audit, {
    '@/lib/prisma': { prisma: { async $executeRawUnsafe(...args) { auditCalls.push(args); return 1 } } },
  }, { console: { error() {} } })
  const auditId = await auditSuccess.writeAuditEntry({
    itemId: 'item-1', actor: 'actor-1', action: 'edited',
    before: { title: 'before' }, after: { title: 'after' }, metadata: { source: 'test' },
  })
  assert.equal(auditCalls.length, 1)
  assert.deepEqual(auditCalls[0].slice(2), [
    'item-1', 'actor-1', 'edited', '{"title":"before"}', '{"title":"after"}', '{"source":"test"}',
  ])
  assert.equal(auditCalls[0][1], auditId)

  let logged = 0
  const auditFailure = evaluate(paths.audit, {
    '@/lib/prisma': { prisma: { async $executeRawUnsafe() { throw failure } } },
  }, { console: { error() { logged++ } } })
  assert.equal(await auditFailure.writeAuditEntry({ itemId: null, actor: null, action: 'edited' }), null)
  assert.equal(logged, 1)

  assert.match(read(paths.usage), /try\s*\{[\s\S]*\$executeRawUnsafe[\s\S]*\}\s*catch\s*\{[\s\S]*Telemetry must not break the app/)
  assert.match(read(paths.extractor), /try\s*\{[\s\S]*INSERT INTO "AiKnowledgeSource"[\s\S]*\}\s*catch\s*\{\s*return \{ added: false, promoted: false \}/)
})

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
