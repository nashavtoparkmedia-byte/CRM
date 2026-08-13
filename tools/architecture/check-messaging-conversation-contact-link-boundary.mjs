#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

import { extractUnsafeApplicationCompositionExports } from './enforce-architecture.mjs'

const read = file => fs.readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, value, detail) => value
  ? checks.push(name)
  : failures.push({ check: name, detail })
const sliceBetween = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker)
  if (start < 0) return ''
  const end = endMarker === null ? source.length : source.indexOf(endMarker, start + startMarker.length)
  return end < 0 ? '' : source.slice(start, end)
}
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const absolute = path.join(directory, entry.name)
  return entry.isDirectory() ? walk(absolute) : (/\.tsx?$/.test(entry.name) ? [absolute] : [])
})

const contract = read('gravity-mvp/src/contracts/messaging/v1/conversation-contact-link-command.ts')
const contractIndex = read('gravity-mvp/src/contracts/messaging/v1/index.ts')
const handler = read('gravity-mvp/src/modules/messaging/public/v1/conversation-contact-link-handler.ts')
const adapter = read('gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-conversation-contact-link-adapter.ts')
const publicIndex = read('gravity-mvp/src/modules/messaging/public/v1/index.ts')
const applicationPath = 'gravity-mvp/src/modules/messaging/application/messaging-operations.ts'
const application = read(applicationPath)
const contactService = read('gravity-mvp/src/lib/ContactService.ts')
const amendmentPath = 'architecture/isolation/messaging/conversation-contact-link-v1/module-manifest-amendments.json'
const amendment = JSON.parse(read(amendmentPath))
const migration = JSON.parse(read('architecture/isolation/messaging/conversation-contact-link-v1/migration-manifest.json'))
const verification = JSON.parse(read('architecture/isolation/messaging/conversation-contact-link-v1/verification.json'))
const behavior = JSON.parse(read('architecture/isolation/messaging/conversation-contact-link-v1/BEHAVIOR-FREEZE.json'))
const policy = JSON.parse(read('architecture/enforcement/v1/policy.json'))
const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const sourceFiles = walk('gravity-mvp/src')
const sources = new Map(sourceFiles.map(file => [file, read(file)]))
const consumerModel = new Map([
  ['gravity-mvp/src/app/messages/link-chat-actions.ts', { count: 1, chatIds: ['chat.id'] }],
  ['gravity-mvp/src/lib/whatsapp/WhatsAppService.ts', {
    count: 5,
    chatIds: ['unifiedSyncChat.id', 'unifiedSyncChat.id', 'unifiedChat.id', 'unifiedChat.id', 'unifiedChat.id'],
  }],
  ['gravity-mvp/src/app/api/messages/start-chat/route.ts', { count: 1, chatIds: ['chat.id'] }],
  ['gravity-mvp/src/app/api/webhook/telegram/route.ts', { count: 1, chatIds: ['unifiedChat.id'] }],
  ['gravity-mvp/src/app/tg-actions.ts', { count: 2, chatIds: ['chat.id', 'unifiedChat.id'] }],
  ['gravity-mvp/src/app/api/webhook/max/route.ts', { count: 2, chatIds: ['unifiedChat.id', 'unifiedChat.id'] }],
  ['gravity-mvp/src/app/api/webhooks/max/route.ts', { count: 1, chatIds: ['chat.id'] }],
])
const consumers = [...consumerModel.keys()]
const portSource = sliceBetween(handler, 'export interface ConversationContactLinkPersistencePortV1', 'export function')
const productionSourceFiles = sourceFiles.filter(file => !/(?:^|\/)__tests__\/|\.(?:test|spec)\.tsx?$/.test(file))
const normalize = value => value.replace(/\s+/g, '')
const canonical = value => normalize(value).replace(/,\}/g, '}')
const parse = (file, source) => {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  if (ast.parseDiagnostics.length > 0) throw new Error(`${file}: TypeScript parse diagnostics`)
  return ast
}
const visit = (node, visitor) => {
  visitor(node)
  ts.forEachChild(node, child => visit(child, visitor))
}
const namedImports = ast => ast.statements.flatMap(statement => {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) return []
  const bindings = statement.importClause?.namedBindings
  if (!bindings || !ts.isNamedImports(bindings)) return []
  return bindings.elements.map(element => ({
    specifier: statement.moduleSpecifier.text,
    imported: element.propertyName?.text ?? element.name.text,
    local: element.name.text,
    typeOnly: statement.importClause?.isTypeOnly || element.isTypeOnly,
  }))
})
const identifierCalls = (node, name) => {
  const calls = []
  visit(node, candidate => {
    if (ts.isCallExpression(candidate) && ts.isIdentifier(candidate.expression) && candidate.expression.text === name) calls.push(candidate)
  })
  return calls
}
const expressionCalls = (node, text, ast) => {
  const calls = []
  visit(node, candidate => {
    if (ts.isCallExpression(candidate) && normalize(candidate.expression.getText(ast)) === text) calls.push(candidate)
  })
  return calls
}
const falseLiteral = node => node.kind === ts.SyntaxKind.FalseKeyword
  || (ts.isNumericLiteral(node) && Number(node.text) === 0)
const syntacticallyDead = node => {
  for (let child = node, current = node.parent; current; child = current, current = current.parent) {
    if (ts.isIfStatement(current)) {
      if (falseLiteral(current.expression) && child === current.thenStatement) return true
      if (current.expression.kind === ts.SyntaxKind.TrueKeyword && child === current.elseStatement) return true
    }
    if ((ts.isWhileStatement(current) || ts.isDoStatement(current)) && falseLiteral(current.expression)) return true
  }
  return false
}
const staticPropertyName = property => (
  ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : undefined
)
const objectValues = (literal, ast) => Object.fromEntries(literal.properties.map(property => {
  if (ts.isShorthandPropertyAssignment(property)) return [property.name.text, property.name.text]
  if (!ts.isPropertyAssignment(property)) throw new Error('non-static object property')
  const name = staticPropertyName(property)
  if (!name) throw new Error('computed object property')
  return [name, normalize(property.initializer.getText(ast))]
}))
const assertNoIndirectIdentifierUse = (ast, name) => {
  const bad = []
  visit(ast, node => {
    if (!ts.isIdentifier(node) || node.text !== name) return
    if (ts.isImportSpecifier(node.parent) && node.parent.name === node) return
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) return
    bad.push(node)
  })
  if (bad.length > 0) throw new Error(`${name}: indirect use`)
}

function assertConsumerModel(overrides = new Map()) {
  const sourceFor = file => overrides.get(file) ?? sources.get(file)
  const observed = new Map()
  for (const file of productionSourceFiles) {
    const ast = parse(file, sourceFor(file))
    const imports = namedImports(ast).filter(binding => binding.imported === 'ensureConversationContactLinkV1')
    if (imports.length > 0) observed.set(file, { ast, imports })
  }
  if (JSON.stringify([...observed.keys()].sort()) !== JSON.stringify([...consumerModel.keys()].sort())) throw new Error('consumer denominator')
  let total = 0
  for (const [file, expected] of consumerModel) {
    const { ast, imports } = observed.get(file)
    if (JSON.stringify(imports) !== JSON.stringify([{
      specifier: '@/modules/messaging/public/v1',
      imported: 'ensureConversationContactLinkV1',
      local: 'ensureConversationContactLinkV1',
      typeOnly: false,
    }])) throw new Error(`${file}: facade import`)
    const commandImports = namedImports(ast).filter(binding => binding.imported === 'ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1')
    if (JSON.stringify(commandImports) !== JSON.stringify([{
      specifier: '@/contracts/messaging/v1',
      imported: 'ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1',
      local: 'ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1',
      typeOnly: false,
    }])) throw new Error(`${file}: command import`)
    assertNoIndirectIdentifierUse(ast, 'ensureConversationContactLinkV1')
    const calls = identifierCalls(ast, 'ensureConversationContactLinkV1')
    if (calls.length !== expected.count || calls.some(call => syntacticallyDead(call))) throw new Error(`${file}: call denominator`)
    const chatIds = []
    for (const call of calls) {
      if (!ts.isAwaitExpression(call.parent) || call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0])) throw new Error(`${file}: awaited literal call`)
      const values = objectValues(call.arguments[0], ast)
      if (JSON.stringify(Object.keys(values)) !== JSON.stringify(['contract', 'chatId', 'contactId', 'contactIdentityId'])) throw new Error(`${file}: command fields`)
      if (values.contract !== 'ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1'
        || values.contactId !== 'contactResult.contact.id'
        || values.contactIdentityId !== 'contactResult.identity.id') throw new Error(`${file}: command mapping`)
      chatIds.push(values.chatId)
    }
    if (JSON.stringify(chatIds.sort()) !== JSON.stringify([...expected.chatIds].sort())) throw new Error(`${file}: chat mapping`)
    total += calls.length
  }
  if (total !== 13) throw new Error('total call denominator')
}
const acceptsConsumerModel = overrides => {
  try { assertConsumerModel(overrides); return true } catch { return false }
}

function assertCompositionModel(publicSource, applicationSource) {
  const publicAst = parse('messaging-public-index.ts', publicSource)
  const reexports = publicAst.statements.flatMap(statement => {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier?.text !== '../../application/messaging-operations') return []
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) throw new Error('application wildcard export')
    return statement.exportClause.elements.filter(element => (
      (element.propertyName?.text ?? element.name.text) === 'ensureConversationContactLinkV1'
    ))
  })
  if (reexports.length !== 1 || reexports[0].name.text !== 'ensureConversationContactLinkV1') throw new Error('facade re-export')
  const ast = parse(applicationPath, applicationSource)
  for (const [specifier, imported] of [
    ['../public/v1/conversation-contact-link-handler', 'createEnsureConversationContactLinkHandlerV1'],
    ['../public/v1/legacy-prisma-conversation-contact-link-adapter', 'legacyPrismaConversationContactLinkPortV1'],
  ]) {
    const imports = namedImports(ast).filter(binding => binding.specifier === specifier && binding.imported === imported)
    if (imports.length !== 1 || imports[0].local !== imported || imports[0].typeOnly) throw new Error(`${imported}: composition import`)
  }
  const factories = identifierCalls(ast, 'createEnsureConversationContactLinkHandlerV1')
  if (factories.length !== 1 || syntacticallyDead(factories[0])
    || factories[0].arguments.length !== 1
    || factories[0].arguments[0].getText(ast) !== 'legacyPrismaConversationContactLinkPortV1') throw new Error('handler composition')
  const factoryDeclaration = factories[0].parent
  if (!ts.isVariableDeclaration(factoryDeclaration)
    || !ts.isIdentifier(factoryDeclaration.name)
    || factoryDeclaration.name.text !== 'ensureConversationContactLink') throw new Error('handler binding')
  const wrappers = ast.statements.flatMap(statement => (
    ts.isVariableStatement(statement)
    && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ? [...statement.declarationList.declarations]
      : []
  )).filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'ensureConversationContactLinkV1')
  if (wrappers.length !== 1 || !wrappers[0].initializer || !ts.isArrowFunction(wrappers[0].initializer)) throw new Error('facade wrapper')
  const arrow = wrappers[0].initializer
  if (!ts.isCallExpression(arrow.body)
    || !ts.isIdentifier(arrow.body.expression)
    || arrow.body.expression.text !== 'ensureConversationContactLink'
    || arrow.body.arguments.length !== 1
    || !ts.isSpreadElement(arrow.body.arguments[0])
    || arrow.body.arguments[0].expression.getText(ast) !== 'args') throw new Error('facade wrapper delegate')
  if (extractUnsafeApplicationCompositionExports(applicationSource).length !== 0) throw new Error('unsafe application composition export')
}
const acceptsCompositionModel = (publicSource, applicationSource) => {
  try { assertCompositionModel(publicSource, applicationSource); return true } catch { return false }
}
const accepts = operation => {
  try { operation(); return true } catch { return false }
}

function assertHandlerModel(source) {
  const ast = parse('conversation-contact-link-handler.ts', source)
  const ports = ast.statements.filter(statement => ts.isInterfaceDeclaration(statement) && statement.name.text === 'ConversationContactLinkPersistencePortV1')
  if (ports.length !== 1 || ports[0].members.length !== 1 || !ts.isMethodSignature(ports[0].members[0]) || ports[0].members[0].name.getText(ast) !== 'ensure') throw new Error('port surface')
  const parses = identifierCalls(ast, 'parseEnsureConversationContactLinkCommandV1')
  const persists = expressionCalls(ast, 'port.ensure', ast)
  if (parses.length !== 1 || persists.length !== 1 || parses[0].pos >= persists[0].pos || !ts.isAwaitExpression(persists[0].parent)) throw new Error('handler order')
  if (persists[0].arguments.length !== 1 || !ts.isObjectLiteralExpression(persists[0].arguments[0])
    || JSON.stringify(objectValues(persists[0].arguments[0], ast)) !== JSON.stringify({
      chatId: 'parsed.chatId', contactId: 'parsed.contactId', contactIdentityId: 'parsed.contactIdentityId',
    })) throw new Error('handler persistence mapping')
  const returns = []
  visit(ast, node => { if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) returns.push(node.expression) })
  if (!returns.some(literal => JSON.stringify(objectValues(literal, ast)) === JSON.stringify({
    contract: 'ENSURE_CONVERSATION_CONTACT_LINK_RESULT_V1', completed: 'true',
  }))) throw new Error('handler result')
  let forbidden = false
  visit(ast, node => { if (ts.isTryStatement(node) || ts.isCatchClause(node)) forbidden = true })
  if (forbidden) throw new Error('handler catches owner failure')
}

function assertAdapterModel(source) {
  const ast = parse('legacy-prisma-conversation-contact-link-adapter.ts', source)
  const chains = [
    ['prisma.chat.findUnique', '{where:{id:input.chatId},select:{driverId:true}}'],
    ['prisma.contact.findUnique', '{where:{id:input.contactId},select:{yandexDriverId:true}}'],
    ['prisma.driver.findUnique', '{where:{yandexDriverId:contact.yandexDriverId},select:{id:true}}'],
    ['prisma.chat.update', '{where:{id:input.chatId},data:updateData}'],
  ]
  let previous = -1
  for (const [expression, argument] of chains) {
    const calls = expressionCalls(ast, expression, ast)
    if (calls.length !== 1 || calls[0].pos <= previous || !ts.isAwaitExpression(calls[0].parent)
      || calls[0].arguments.length !== 1 || canonical(calls[0].arguments[0].getText(ast)) !== argument) throw new Error(`${expression}: exact ordered call`)
    previous = calls[0].pos
  }
  const conditions = []
  visit(ast, node => { if (ts.isIfStatement(node)) conditions.push(normalize(node.expression.getText(ast))) })
  for (const expected of ['chat&&!chat.driverId', 'contact?.yandexDriverId', 'driver']) {
    if (conditions.filter(value => value === expected).length !== 1) throw new Error(`${expected}: exact condition`)
  }
  const assignments = []
  visit(ast, node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) assignments.push(normalize(node.getText(ast)))
  })
  if (assignments.filter(value => value === 'updateData.driverId=driver.id').length !== 1) throw new Error('driver assignment')
}

check(
  'contract and handler are provider and infrastructure neutral',
  !/(prisma|next\/|@\/lib|@\/app|whatsapp|telegram|max-bot|modesl)/i.test(contract + handler),
  'public boundary leaks infrastructure or provider details',
)
check(
  'command and result identities are exact versioned literals',
  contract.includes("'messaging.EnsureConversationContactLinkCommand.v1' as const") &&
    contract.includes("'messaging.EnsureConversationContactLinkResult.v1' as const") &&
    contract.includes('completed: true'),
  'versioned command/result identity drift',
)
check(
  'command exposes only the exact three identifiers',
  contract.includes("const supportedFields = ['contract', 'chatId', 'contactId', 'contactIdentityId']") &&
    !/(patch|table|sql|predicate|whereClause|transaction|select|include|orderBy|page|driverId)/i.test(
      sliceBetween(contract, 'export interface EnsureConversationContactLinkCommandV1', 'export interface EnsureConversationContactLinkResultV1'),
    ),
  'generic persistence or owner policy leaked into the command',
)
check(
  'strict parser rejects extras versions and empty identifiers',
  contract.includes('Object.keys(input).filter') &&
    contract.includes("startsWith('messaging.EnsureConversationContactLinkCommand.')") &&
    contract.includes("input[field].trim() === ''") &&
    contract.includes("['chatId', 'contactId', 'contactIdentityId'] as const"),
  'strict parser coverage drift',
)
check(
  'one named port owns only the exact link operation',
  accepts(() => assertHandlerModel(handler)),
  'port widened beyond the exact use case',
)
check(
  'handler parses before one port call and returns the exact result',
  accepts(() => assertHandlerModel(handler)),
  'handler mapping, result or failure visibility drift',
)
check(
  'public facade exposes the narrow application function and application binds the owner adapter exactly once',
  contractIndex.includes("export * from './conversation-contact-link-command'") &&
    publicIndex.includes('createEnsureConversationContactLinkHandlerV1') &&
    !publicIndex.includes('legacyPrismaConversationContactLinkPortV1') &&
    acceptsCompositionModel(publicIndex, application),
  'contract export or owner binding drift',
)
check(
  'owner reads Chat then Contact then Driver with exact projections',
  accepts(() => assertAdapterModel(adapter)),
  'owner read order, predicates or projections drift',
)
check(
  'driver enrichment preserves inherited truthy short circuits',
  accepts(() => assertAdapterModel(adapter)),
  'driver lookup or preservation semantics drift',
)
check(
  'missing Chat still reaches one exact update',
  accepts(() => assertAdapterModel(adapter)),
  'missing-Chat behavior or final update mapping drift',
)
check(
  'base link fields are always set and driverId remains optional',
  adapter.includes('contactId: input.contactId') &&
    adapter.includes('contactIdentityId: input.contactIdentityId') &&
    adapter.includes('driverId?: string') &&
    !adapter.includes('driverId: chat.driverId'),
  'contact link or existing driver preservation drift',
)
check(
  'owner adds no transaction retry logging or generic escape hatch',
  !/(\$transaction|Promise\.all|console\.|catch\s*\(|retry|sleep|setTimeout|\$queryRaw|\$executeRaw|RawUnsafe)/.test(adapter) &&
    !/(tableName|sql|predicate|whereClause|transaction|select|include|orderBy|page)\s*:/i.test(contract + portSource),
  'owner acquired forbidden orchestration or generic capacity',
)
check(
  'Contacts compatibility method is removed without reverse dependency',
  !/ensureChatLinked/.test(contactService) &&
    !/from\s*['"]@\/(?:contracts|modules)\/messaging\//.test(contactService),
  'Contacts wrapper or Contacts-to-Messaging import remains',
)
check(
  'exactly thirteen calls exist across the seven accepted consumers',
  consumers.length === 7 && accepts(() => assertConsumerModel()),
  'consumer population or awaited call count drift',
)
const directFacadeBindingProbe = publicIndex.replace(
  '../../application/messaging-operations',
  './legacy-prisma-conversation-contact-link-adapter',
)
const reducedDenominatorProbe = sources.get(consumers[0]).replace(
  'await ensureConversationContactLinkV1(',
  'await removedConversationContactLinkV1(',
)
const consumerProbes = [
  new Map([[consumers[0], `${reducedDenominatorProbe}\n// await ensureConversationContactLinkV1({})\n`]]),
  new Map([[consumers[0], `${reducedDenominatorProbe}\nif (false) { void ensureConversationContactLinkV1({}) }\n`]]),
  new Map([[consumers[0], sources.get(consumers[0]).replace('@/modules/messaging/public/v1', '@/modules/messaging/application/messaging-operations')]]),
  new Map([[consumers[0], reducedDenominatorProbe]]),
  new Map([[consumers[0], `${sources.get(consumers[0])}\nvoid ensureConversationContactLinkV1({})\n`]]),
]
check(
  'negative probes reject comments dead code direct bypass and denominator drift',
  !acceptsCompositionModel(directFacadeBindingProbe, application) &&
    consumerProbes.every(probe => !acceptsConsumerModel(probe)),
  'facade bypass or reduced consumer denominator was accepted',
)
check(
  'all consumer commands use the exact mapping with no generic fields',
  accepts(() => assertConsumerModel()),
  'consumer payload mapping widened or drifted',
)
check(
  'legacy method references are absent from all source',
  [...sources.values()].every(source => !/ContactService\s*\.\s*ensureChatLinked\b|static\s+async\s+ensureChatLinked\b/.test(source)),
  'legacy call or definition remains',
)
check(
  'the signed baseline retirement remains explicitly bounded to one site',
  'arch_3a32113e59d6d5250460be8d'.length === 29 &&
    adapter.includes('prisma.chat.update') &&
    !contactService.includes('prisma.chat.update'),
  'planned single-site relocation boundary drift',
)
check(
  'manifest amendment exposes only the exact owner command without a dependency amendment',
  amendment.amendments?.length === 1 &&
    amendment.amendments[0].context === 'messaging' &&
    JSON.stringify(amendment.amendments[0].add_commands) === JSON.stringify([
      'EnsureConversationContactLinkCommand.v1',
    ]) &&
    amendment.amendments[0].add_public_surface === undefined &&
    amendment.amendments[0].add_allowed_dependencies === undefined,
  'manifest amendment widened or added a dependency',
)
check(
  'strict policy retains the amendment and migration binds the slice to the accepted manager-health parent',
  policy.manifest_amendments.includes(amendmentPath) &&
    migration.base_commit === '9765eb7202bfe07aa54e137d5e96c8d728c0372f' &&
    migration.source_commit === '3c59b2733a6032a7cb1f02be3c42af8a13a0f3ab',
  'policy or evidence identity drift',
)
check(
  'accepted conversation-link retirement remains closed in later strict registries',
  registry.exceptions.length <= 1407 &&
    (registry.summary?.direct_foreign_prisma_write ?? 0) <= 84 &&
    (registry.summary?.direct_provider_transport_access ?? 0) <= 38 &&
    (registry.summary?.internal_module_import ?? 0) <= 379 &&
    (registry.summary?.non_public_cross_context_import ?? 0) <= 536 &&
    (registry.summary?.undeclared_dependency ?? 0) <= 370 &&
    !registry.exceptions.some(entry => entry.fingerprint === 'arch_3a32113e59d6d5250460be8d') &&
    !registry.exceptions.some(entry => entry.file.includes('legacy-prisma-conversation-contact-link-adapter.ts')),
  'strict registry monotonicity, retirement or owner-local classification drift',
)
check(
  'verified registry evidence preserves the exact one-removal zero-addition comparison',
  migration.enforcement?.baseline_findings === 1408 &&
    migration.enforcement?.actual_findings === 1407 &&
    migration.enforcement?.actual_direct_foreign_prisma_write === 84 &&
    migration.enforcement?.actual_removed === 1 &&
    migration.enforcement?.actual_added === 0 &&
    migration.enforcement?.actual_changed_shared_entries === 0 &&
    migration.enforcement?.finding_digest === '5b21c2b965d736b5451a92a56fb6dfb4dff17c179919b25a795c7ed584349e73' &&
    migration.enforcement?.registry_sha256 === '26d55bc9013a72c23670aefa99ae1202ead65b36182159d31e4707ac8e645cd0' &&
    migration.enforcement?.registry_deterministic === true,
  'verified registry comparison drift',
)
check(
  'behavior hashes and verification retain the frozen source-only non-execution boundary',
  behavior.source_commit === '3c59b2733a6032a7cb1f02be3c42af8a13a0f3ab' &&
    behavior.legacy_owner_before_sha256 === '25a35f2e8306a84cab4f6976abb0ae09550c203d7faef2d4f5fbc0032fa53659' &&
    behavior.legacy_owner_after_sha256 === '3557862ac3dc268117f2b2442236fda6ab6cddbb07dc3baaa981c1163ed72f47' &&
    behavior.consumer_hashes?.length === 7 &&
    createHash('sha256').update(JSON.stringify(behavior.consumer_hashes)).digest('hex') ===
      '960f1c9f6c494594827e6405f674ad81ec5a17d8e80da99c2cf645885b10213e' &&
    verification.database_accessed === false &&
    verification.conversation_link_executed_against_database === false &&
    verification.webhooks_or_providers_invoked === false &&
    verification.production_mutated === false &&
    verification.secret_values_read_or_emitted === false,
  'source hash or non-execution evidence drift',
)

process.stdout.write(`${JSON.stringify({
  status: failures.length > 0 ? 'FAIL' : 'PASS',
  checks,
  failures,
}, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
