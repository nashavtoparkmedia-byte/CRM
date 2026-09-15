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
  ['gravity-mvp/src/app/messages/link-chat-actions.ts', {
    count: 1,
    chatIds: ['chat.id'],
    placements: ['try/function:linkChatToDriverManually'],
  }],
  ['gravity-mvp/src/lib/whatsapp/WhatsAppService.ts', {
    count: 5,
    chatIds: ['unifiedSyncChat.id', 'unifiedSyncChat.id', 'unifiedChat.id', 'unifiedChat.id', 'unifiedChat.id'],
    placements: [
      'if/try/if/try/for-of/try/function:syncHistory',
      'if/if/try/if/try/for-of/try/function:syncHistory',
      'try/try/arrow/function:doInitializeClient',
      'if/try/if/try/for-of/try/function:importWhatsAppHistory',
      'if/if/try/if/try/for-of/try/function:importWhatsAppHistory',
    ],
  }],
  ['gravity-mvp/src/app/api/webhook/telegram/route.ts', {
    count: 1,
    chatIds: ['unifiedChat.id'],
    placements: ['try/try/try/function:POST'],
  }],
  ['gravity-mvp/src/app/tg-actions.ts', {
    count: 1,
    chatIds: ['chat.id'],
    placements: ['function:admitTelegramPrivateConversation'],
  }],
  ['gravity-mvp/src/app/api/webhooks/max/route.ts', {
    count: 1,
    chatIds: ['chat.id'],
    placements: ['if/if/if/if/try/if/try/function:POST'],
  }],
])
const retiredConsumerModel = new Map([
  ['gravity-mvp/src/app/api/messages/start-chat/route.ts', {
    parameters: [['_request', 'Request']],
    payload: {
      error: "'PROVIDER_IDENTITY_REQUIRED'",
      message: "'A stable provider identity is required; open the conversation from the Contact profile.'",
    },
    status: '409',
  }],
  ['gravity-mvp/src/app/api/webhook/max/route.ts', {
    parameters: [],
    payload: {
      error: "'MAX_LEGACY_WEBHOOK_RETIRED'",
      replacement: "'/api/webhooks/max'",
    },
    status: '410',
  }],
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
const unwrapExpression = node => {
  let current = node
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) current = current.expression
  return current
}
const definitelyFalsy = node => {
  const current = unwrapExpression(node)
  if (current.kind === ts.SyntaxKind.FalseKeyword || current.kind === ts.SyntaxKind.NullKeyword
    || (ts.isNumericLiteral(current) && Number(current.text) === 0)
    || (ts.isStringLiteralLike(current) && current.text.length === 0)
    || (ts.isIdentifier(current) && current.text === 'undefined')) return true
  if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.ExclamationToken) {
    return definitelyTruthy(current.operand)
  }
  if (!ts.isBinaryExpression(current)) return false
  if (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return definitelyFalsy(current.left) || definitelyFalsy(current.right)
  }
  if (current.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return definitelyFalsy(current.left) && definitelyFalsy(current.right)
  }
  return false
}
const definitelyTruthy = node => {
  const current = unwrapExpression(node)
  if (current.kind === ts.SyntaxKind.TrueKeyword
    || (ts.isNumericLiteral(current) && Number(current.text) !== 0)
    || (ts.isStringLiteralLike(current) && current.text.length > 0)) return true
  if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.ExclamationToken) {
    return definitelyFalsy(current.operand)
  }
  if (!ts.isBinaryExpression(current)) return false
  if (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return definitelyTruthy(current.left) && definitelyTruthy(current.right)
  }
  if (current.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return definitelyTruthy(current.left) || definitelyTruthy(current.right)
  }
  return false
}
const unconditionalTerminator = node => ts.isReturnStatement(node) || ts.isThrowStatement(node)
  || ts.isBreakStatement(node) || ts.isContinueStatement(node)
const statementAlwaysTerminates = statement => {
  if (unconditionalTerminator(statement)) return true
  if (ts.isBlock(statement)) return statement.statements.some(statementAlwaysTerminates)
  if (ts.isLabeledStatement(statement)) return statementAlwaysTerminates(statement.statement)
  if (ts.isIfStatement(statement)) {
    if (definitelyTruthy(statement.expression)) return statementAlwaysTerminates(statement.thenStatement)
    if (definitelyFalsy(statement.expression)) {
      return Boolean(statement.elseStatement && statementAlwaysTerminates(statement.elseStatement))
    }
    return Boolean(statement.elseStatement
      && statementAlwaysTerminates(statement.thenStatement)
      && statementAlwaysTerminates(statement.elseStatement))
  }
  if (ts.isTryStatement(statement)) {
    if (statement.finallyBlock && statementAlwaysTerminates(statement.finallyBlock)) return true
    return statementAlwaysTerminates(statement.tryBlock)
      && (!statement.catchClause || statementAlwaysTerminates(statement.catchClause.block))
  }
  return false
}
const followsUnconditionalTerminator = node => {
  for (let child = node, current = node.parent; current; child = current, current = current.parent) {
    const statements = ts.isBlock(current) || ts.isSourceFile(current) || ts.isCaseClause(current)
      || ts.isDefaultClause(current) ? current.statements : undefined
    if (!statements) continue
    const directChild = statements.find(statement => statement === child || (
      statement.pos <= child.pos && statement.end >= child.end
    ))
    const index = directChild ? statements.indexOf(directChild) : -1
    if (index > 0 && statements.slice(0, index).some(statementAlwaysTerminates)) return true
  }
  return false
}
const syntacticallyDead = node => {
  for (let child = node, current = node.parent; current; child = current, current = current.parent) {
    if (ts.isIfStatement(current)) {
      if (definitelyFalsy(current.expression) && child === current.thenStatement) return true
      if (definitelyTruthy(current.expression) && child === current.elseStatement) return true
    }
    if ((ts.isWhileStatement(current) || ts.isDoStatement(current)) && definitelyFalsy(current.expression)) return true
  }
  return followsUnconditionalTerminator(node)
}
const callPlacement = call => {
  const parts = []
  for (let current = call.parent; current && !ts.isSourceFile(current); current = current.parent) {
    if (ts.isIfStatement(current)) parts.push('if')
    else if (ts.isForOfStatement(current)) parts.push('for-of')
    else if (ts.isForInStatement(current)) parts.push('for-in')
    else if (ts.isForStatement(current)) parts.push('for')
    else if (ts.isWhileStatement(current)) parts.push('while')
    else if (ts.isDoStatement(current)) parts.push('do')
    else if (ts.isSwitchStatement(current)) parts.push('switch')
    else if (ts.isTryStatement(current)) parts.push('try')
    else if (ts.isCatchClause(current)) parts.push('catch')
    else if (ts.isConditionalExpression(current)) parts.push('conditional')
    else if (ts.isFunctionDeclaration(current)) parts.push(`function:${current.name?.text ?? '<anonymous>'}`)
    else if (ts.isMethodDeclaration(current)) parts.push(`method:${current.name.getText()}`)
    else if (ts.isArrowFunction(current)) parts.push('arrow')
    else if (ts.isFunctionExpression(current)) parts.push(`function-expression:${current.name?.text ?? '<anonymous>'}`)
  }
  return parts.join('/')
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
const memberReferences = (ast, name) => {
  const references = []
  visit(ast, node => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === name) references.push(node)
    if (ts.isElementAccessExpression(node)
      && ts.isStringLiteralLike(node.argumentExpression)
      && node.argumentExpression.text === name) references.push(node)
  })
  return references
}

function assertConsumerModel(overrides = new Map()) {
  const sourceFor = file => overrides.get(file) ?? sources.get(file)
  const observed = new Map()
  for (const file of productionSourceFiles) {
    const ast = parse(file, sourceFor(file))
    const imports = namedImports(ast).filter(binding => binding.imported === 'ensureConversationContactLinkV1')
    const calls = identifierCalls(ast, 'ensureConversationContactLinkV1')
    const members = memberReferences(ast, 'ensureConversationContactLinkV1')
    if (imports.length > 0 || calls.length > 0 || members.length > 0) observed.set(file, { ast, imports, calls, members })
  }
  if (JSON.stringify([...observed.keys()].sort()) !== JSON.stringify([...consumerModel.keys()].sort())) throw new Error('consumer denominator')
  let total = 0
  for (const [file, expected] of consumerModel) {
    const { ast, imports, calls, members } = observed.get(file)
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
    if (members.length > 0) throw new Error(`${file}: namespace or computed facade bypass`)
    if (calls.length !== expected.count || calls.some(call => syntacticallyDead(call))) throw new Error(`${file}: call denominator`)
    const chatIds = []
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index]
      if (!ts.isAwaitExpression(call.parent) || !ts.isExpressionStatement(call.parent.parent)
        || callPlacement(call) !== expected.placements[index]
        || call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0])) {
        throw new Error(`${file}: awaited reachable call placement`)
      }
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
  if (total !== 9) throw new Error('total call denominator')
}
const acceptsConsumerModel = overrides => {
  try { assertConsumerModel(overrides); return true } catch { return false }
}

function assertRetiredConsumerModel(overrides = new Map()) {
  for (const [file, expected] of retiredConsumerModel) {
    const ast = parse(file, overrides.get(file) ?? sources.get(file))
    const imports = ast.statements.filter(ts.isImportDeclaration)
    const functions = ast.statements.filter(statement => (
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'POST'
    ))
    if (ast.statements.length !== 2 || imports.length !== 1 || functions.length !== 1) {
      throw new Error(`${file}: tombstone gained executable surface`)
    }
    if (JSON.stringify(namedImports(ast)) !== JSON.stringify([{
      specifier: 'next/server',
      imported: 'NextResponse',
      local: 'NextResponse',
      typeOnly: false,
    }])) throw new Error(`${file}: tombstone import drift`)
    const fn = functions[0]
    const modifierKinds = fn.modifiers?.map(modifier => modifier.kind).sort() ?? []
    if (JSON.stringify(modifierKinds) !== JSON.stringify([
      ts.SyntaxKind.ExportKeyword,
      ts.SyntaxKind.AsyncKeyword,
    ].sort()) || fn.asteriskToken || !fn.body || fn.body.statements.length !== 1) {
      throw new Error(`${file}: tombstone function drift`)
    }
    const parameters = fn.parameters.map(parameter => {
      if (!ts.isIdentifier(parameter.name) || !parameter.type || parameter.dotDotDotToken
        || parameter.questionToken || parameter.initializer) throw new Error(`${file}: tombstone parameter drift`)
      return [parameter.name.text, normalize(parameter.type.getText(ast))]
    })
    if (JSON.stringify(parameters) !== JSON.stringify(expected.parameters)) throw new Error(`${file}: tombstone parameters drift`)
    const returned = fn.body.statements[0]
    if (!ts.isReturnStatement(returned) || !returned.expression || !ts.isCallExpression(returned.expression)
      || normalize(returned.expression.expression.getText(ast)) !== 'NextResponse.json'
      || returned.expression.arguments.length !== 2
      || !ts.isObjectLiteralExpression(returned.expression.arguments[0])
      || !ts.isObjectLiteralExpression(returned.expression.arguments[1])) {
      throw new Error(`${file}: tombstone response drift`)
    }
    const expectedPayload = Object.fromEntries(Object.entries(expected.payload).map(([key, value]) => [key, normalize(value)]))
    if (JSON.stringify(objectValues(returned.expression.arguments[0], ast)) !== JSON.stringify(expectedPayload)
      || JSON.stringify(objectValues(returned.expression.arguments[1], ast)) !== JSON.stringify({ status: expected.status })) {
      throw new Error(`${file}: tombstone payload drift`)
    }
  }
}
const acceptsRetiredConsumerModel = overrides => {
  try { assertRetiredConsumerModel(overrides); return true } catch { return false }
}

function assertTelegramAdmissionModel(source) {
  const file = 'gravity-mvp/src/app/tg-actions.ts'
  const ast = parse(file, source)
  const phases = ast.statements.filter(statement => (
    ts.isTypeAliasDeclaration(statement) && statement.name.text === 'TelegramPrivateIngressPhase'
  ))
  const admissions = ast.statements.filter(statement => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'admitTelegramPrivateConversation'
  ))
  if (phases.length !== 1 || normalize(phases[0].type.getText(ast)) !== "'inbound'|'mirror'|'import'"
    || admissions.length !== 1 || !admissions[0].body
    || !admissions[0].modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
    throw new Error('Telegram admission helper')
  }
  const linkCalls = identifierCalls(ast, 'ensureConversationContactLinkV1')
  if (linkCalls.length !== 1 || !ts.isAwaitExpression(linkCalls[0].parent)
    || !ts.isExpressionStatement(linkCalls[0].parent.parent)
    || syntacticallyDead(linkCalls[0])
    || callPlacement(linkCalls[0]) !== 'function:admitTelegramPrivateConversation') {
    throw new Error('Telegram link ownership')
  }
  let owner = linkCalls[0].parent
  while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent
  if (owner !== admissions[0]) throw new Error('Telegram link escaped admission helper')
  const calls = identifierCalls(ast, 'admitTelegramPrivateConversation')
  const expectedCalls = [
    {
      binding: 'unifiedChat',
      placement: 'if/function:processInboundTelegramMessage',
      phase: 'phase',
      peerId: 'senderId',
      providerAccountId: 'providerAccountId',
      connectionId: 'connectionId',
      displayName: 'senderName',
      lastMessageAt: 'now',
    },
    {
      binding: 'chat',
      placement: 'function:processOutboundMirrorMessage',
      phase: "'mirror'",
      peerId: 'recipientId',
      providerAccountId: 'providerAccountId',
      connectionId: 'connectionId',
      displayName: 'recipientName',
      lastMessageAt: 'sentAt',
    },
    {
      binding: 'unifiedChat',
      placement: 'try/for-of/try/function:importTelegramHistory',
      phase: "'import'",
      peerId: 'peerId',
      providerAccountId: 'providerAccountId',
      connectionId: 'connection.id',
      displayName: 'providerDisplayName',
    },
  ]
  if (calls.length !== expectedCalls.length) throw new Error('Telegram admission caller denominator')
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]
    const awaited = call.parent
    const declaration = awaited.parent
    const { binding, placement, ...expectedValues } = expectedCalls[index]
    if (!ts.isAwaitExpression(call.parent) || syntacticallyDead(call)
      || !ts.isVariableDeclaration(declaration) || declaration.initializer !== awaited
      || !ts.isIdentifier(declaration.name) || declaration.name.text !== binding
      || callPlacement(call) !== placement
      || call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0])
      || JSON.stringify(objectValues(call.arguments[0], ast)) !== JSON.stringify(expectedValues)) {
      throw new Error(`Telegram admission caller ${index + 1}`)
    }
  }
}
const acceptsTelegramAdmissionModel = source => {
  try { assertTelegramAdmissionModel(source); return true } catch { return false }
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

const compactNode = (node, ast) => normalize(node.getText(ast))
const declarationsNamed = (node, name) => {
  const declarations = []
  visit(node, candidate => {
    if (ts.isVariableDeclaration(candidate) && ts.isIdentifier(candidate.name) && candidate.name.text === name) {
      declarations.push(candidate)
    }
  })
  return declarations
}
const exactVariable = (node, name, ast) => {
  const declarations = declarationsNamed(node, name)
  if (declarations.length !== 1 || !declarations[0].initializer) throw new Error(`${name}: exact declaration`)
  return declarations[0]
}
const assertAwaitedDeclaration = (call, name) => {
  if (!ts.isAwaitExpression(call.parent) || !ts.isVariableDeclaration(call.parent.parent)
    || !ts.isIdentifier(call.parent.parent.name) || call.parent.parent.name.text !== name
    || syntacticallyDead(call)) throw new Error(`${name}: awaited live declaration`)
}

function adapterEnvelope(source) {
  const file = 'legacy-prisma-conversation-contact-link-adapter.ts'
  const ast = parse(file, source)
  const importDeclarations = ast.statements.filter(ts.isImportDeclaration)
  const expectedImports = [
    { specifier: '@prisma/client', imported: 'Prisma', local: 'Prisma', typeOnly: false },
    { specifier: '@/lib/prisma', imported: 'prisma', local: 'prisma', typeOnly: false },
    {
      specifier: '@/modules/contacts/public/v1/contact-ownership-lock-contract',
      imported: 'CONTACT_OWNERSHIP_ADVISORY_CLASS_ID_V1',
      local: 'CONTACT_OWNERSHIP_ADVISORY_CLASS_ID_V1',
      typeOnly: false,
    },
    {
      specifier: '@/modules/contacts/public/v1/contact-ownership-lock-contract',
      imported: 'CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID_V1',
      local: 'CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID_V1',
      typeOnly: false,
    },
    {
      specifier: './conversation-contact-link-handler',
      imported: 'ConversationContactLinkPersistencePortV1',
      local: 'ConversationContactLinkPersistencePortV1',
      typeOnly: true,
    },
  ]
  if (ast.statements.length !== 6 || importDeclarations.length !== 4
    || JSON.stringify(namedImports(ast)) !== JSON.stringify(expectedImports)) {
    throw new Error('adapter import surface')
  }
  const adapterStatements = ast.statements.filter(statement => (
    ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => (
      ts.isIdentifier(declaration.name) && declaration.name.text === 'legacyPrismaConversationContactLinkPortV1'
    ))
  ))
  if (adapterStatements.length !== 1
    || !adapterStatements[0].modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
    || (adapterStatements[0].declarationList.flags & ts.NodeFlags.Const) === 0) {
    throw new Error('adapter export')
  }
  const declarations = adapterStatements[0].declarationList.declarations.filter(declaration => (
    ts.isIdentifier(declaration.name) && declaration.name.text === 'legacyPrismaConversationContactLinkPortV1'
  ))
  if (adapterStatements[0].declarationList.declarations.length !== 1
    || declarations.length !== 1 || !declarations[0].type
    || compactNode(declarations[0].type, ast) !== 'ConversationContactLinkPersistencePortV1'
    || !declarations[0].initializer || !ts.isObjectLiteralExpression(declarations[0].initializer)
    || declarations[0].initializer.properties.length !== 1) throw new Error('adapter declaration')
  const ensure = declarations[0].initializer.properties[0]
  if (!ts.isMethodDeclaration(ensure) || ensure.name.getText(ast) !== 'ensure'
    || JSON.stringify(ensure.modifiers?.map(modifier => modifier.kind) ?? []) !== JSON.stringify([ts.SyntaxKind.AsyncKeyword])
    || ensure.parameters.length !== 1 || !ts.isIdentifier(ensure.parameters[0].name)
    || ensure.parameters[0].name.text !== 'input' || ensure.parameters[0].dotDotDotToken
    || ensure.parameters[0].questionToken || ensure.parameters[0].initializer || ensure.asteriskToken || !ensure.body
    || ensure.body.statements.length !== 1) throw new Error('adapter ensure envelope')
  const statement = ensure.body.statements[0]
  if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)
    || !ts.isCallExpression(statement.expression.expression)
    || normalize(statement.expression.expression.expression.getText(ast)) !== 'prisma.$transaction') {
    throw new Error('transaction envelope')
  }
  const transaction = statement.expression.expression
  if (transaction.arguments.length !== 2 || !ts.isArrowFunction(transaction.arguments[0])
    || !transaction.arguments[0].modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    || transaction.arguments[0].parameters.length !== 1
    || !ts.isIdentifier(transaction.arguments[0].parameters[0].name)
    || transaction.arguments[0].parameters[0].name.text !== 'transaction'
    || transaction.arguments[0].parameters[0].dotDotDotToken
    || transaction.arguments[0].parameters[0].questionToken
    || transaction.arguments[0].parameters[0].initializer
    || !ts.isBlock(transaction.arguments[0].body) || transaction.arguments[0].body.statements.length !== 15
    || !ts.isObjectLiteralExpression(transaction.arguments[1])) throw new Error('transaction callback')
  if (JSON.stringify(objectValues(transaction.arguments[1], ast)) !== JSON.stringify({
    isolationLevel: 'Prisma.TransactionIsolationLevel.ReadCommitted',
    maxWait: '2_000',
    timeout: '10_000',
  })) throw new Error('transaction options')
  return { ast, ensure, transaction, callback: transaction.arguments[0], body: transaction.arguments[0].body }
}

function assertRootClientCalls(ast, root, expected) {
  const observed = []
  visit(ast, node => {
    if (!ts.isIdentifier(node) || node.text !== root) return
    if (ts.isImportSpecifier(node.parent) && (node.parent.name === node || node.parent.propertyName === node)) return
    if (ts.isParameter(node.parent) && node.parent.name === node) return
    if (!ts.isPropertyAccessExpression(node.parent) || node.parent.expression !== node) {
      throw new Error(`${root}: indirect client reference`)
    }
    let expression = node.parent
    while (ts.isPropertyAccessExpression(expression.parent) && expression.parent.expression === expression) {
      expression = expression.parent
    }
    if (!ts.isCallExpression(expression.parent) || expression.parent.expression !== expression) {
      throw new Error(`${root}: escaped client capability`)
    }
    observed.push(normalize(expression.getText(ast)))
  })
  if (JSON.stringify(observed.sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${root}: client call inventory`)
  }
}

function assertAdapterLockModel(source) {
  const { ast, body } = adapterEnvelope(source)
  const locks = expressionCalls(body, 'transaction.$queryRaw', ast)
  if (locks.length !== 1 || locks[0].parent.parent !== body.statements[0]
    || !ts.isAwaitExpression(locks[0].parent) || locks[0].arguments.length !== 1
    || !ts.isTaggedTemplateExpression(locks[0].arguments[0])
    || normalize(locks[0].arguments[0].tag.getText(ast)) !== 'Prisma.sql') {
    throw new Error('CNT1 admission must be the first transaction statement')
  }
  const expectedSql = normalize(`Prisma.sql\`
    WITH "contact_link_lock_policy" AS MATERIALIZED (
      SELECT set_config('lock_timeout', '2000ms', true) AS configured
    )
    SELECT (
      pg_advisory_xact_lock(
        CAST(\${CONTACT_OWNERSHIP_ADVISORY_CLASS_ID_V1} AS integer)
          + octet_length(configured) * 0,
        CAST(\${CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID_V1} AS integer)
      ) IS NULL
    ) AS admitted
    FROM "contact_link_lock_policy"
  \``)
  if (normalize(locks[0].arguments[0].getText(ast)) !== expectedSql) throw new Error('CNT1 SQL projection')
}

function assertAdapterIdentityModel(source) {
  const { ast, body } = adapterEnvelope(source)
  const lock = expressionCalls(body, 'transaction.$queryRaw', ast)
  const identities = expressionCalls(body, 'transaction.contactIdentity.findUnique', ast)
  const contacts = expressionCalls(body, 'transaction.contact.findUnique', ast)
  if (lock.length !== 1 || identities.length !== 1 || contacts.length !== 2
    || identities[0].arguments.length !== 1
    || canonical(identities[0].arguments[0].getText(ast))
      !== '{where:{id:input.contactIdentityId},select:{id:true,contactId:true,isActive:true}}') {
    throw new Error('identity revalidation query')
  }
  const canonicalContact = contacts.find(call => canonical(call.arguments[0].getText(ast))
    === '{where:{id:identity.contactId},select:{id:true,isArchived:true,mainDriverId:true,customFields:true}}')
  const lineageContact = contacts.find(call => canonical(call.arguments[0].getText(ast))
    === '{where:{id:requestedId},select:{isArchived:true,customFields:true}}')
  if (!canonicalContact || !lineageContact
    || !(lock[0].pos < identities[0].pos && identities[0].pos < canonicalContact.pos
      && canonicalContact.pos < lineageContact.pos)) throw new Error('identity/lineage query order')
  assertAwaitedDeclaration(identities[0], 'identity')
  assertAwaitedDeclaration(canonicalContact, 'canonical')
  assertAwaitedDeclaration(lineageContact, 'requested')
  const requestedId = exactVariable(body, 'requestedId', ast)
  if (compactNode(requestedId.initializer, ast) !== 'input.contactId'
    || !ts.isVariableDeclarationList(requestedId.parent)
    || (requestedId.parent.flags & ts.NodeFlags.Let) === 0) throw new Error('requested Contact lineage root')
  const loops = []
  visit(body, node => { if (ts.isForStatement(node)) loops.push(node) })
  const expectedLoop = "for(letdepth=0;requestedId!==canonical.id&&depth<16;depth+=1){constrequested=awaittransaction.contact.findUnique({where:{id:requestedId},select:{isArchived:true,customFields:true},})constfields=requested?.customFields&&typeofrequested.customFields==='object'&&!Array.isArray(requested.customFields)?requested.customFieldsasRecord<string,unknown>:{}constnext=requested?.isArchived&&typeoffields.mergedIntoContactId==='string'?fields.mergedIntoContactId:nullif(!next||next===requestedId)thrownewError('CONTACT_IDENTITY_LINK_MISMATCH')requestedId=next}"
  if (loops.length !== 1 || compactNode(loops[0], ast) !== expectedLoop) throw new Error('bounded Contact lineage walk')
  const conditions = []
  visit(body, node => { if (ts.isIfStatement(node)) conditions.push(compactNode(node, ast)) })
  for (const expected of [
    "if(!identity?.isActive)thrownewError('CONTACT_IDENTITY_LINK_STALE')",
    "if(!canonical||canonical.isArchived)thrownewError('CONTACT_IDENTITY_LINK_STALE')",
    "if(requestedId!==canonical.id)thrownewError('CONTACT_IDENTITY_LINK_MISMATCH')",
  ]) {
    if (!conditions.includes(expected)) throw new Error('fail-closed Contact identity/lineage check')
  }
}

function assertAdapterConversationModel(source) {
  const { ast, body } = adapterEnvelope(source)
  const chats = expressionCalls(body, 'transaction.chat.findUnique', ast)
  const updates = expressionCalls(body, 'transaction.chat.update', ast)
  if (chats.length !== 1 || updates.length !== 1
    || canonical(chats[0].arguments[0].getText(ast))
      !== '{where:{id:input.chatId},select:{contactId:true,contactIdentityId:true,driverId:true}}'
    || canonical(updates[0].arguments[0].getText(ast)) !== '{where:{id:input.chatId},data:updateData}'
    || chats[0].pos >= updates[0].pos || !ts.isAwaitExpression(chats[0].parent)
    || !ts.isAwaitExpression(updates[0].parent) || updates[0].parent.parent !== body.statements.at(-1)) {
    throw new Error('exact Chat read/write boundary')
  }
  assertAwaitedDeclaration(chats[0], 'chat')
  const updateData = exactVariable(body, 'updateData', ast)
  if (!updateData.type || compactNode(updateData.type, ast) !== '{contactId:stringcontactIdentityId:stringdriverId?:string}'
    || !ts.isObjectLiteralExpression(updateData.initializer)
    || JSON.stringify(objectValues(updateData.initializer, ast)) !== JSON.stringify({
      contactId: 'canonical.id', contactIdentityId: 'identity.id',
    })) throw new Error('canonical Chat link payload')
  const conditions = []
  visit(body, node => { if (ts.isIfStatement(node)) conditions.push(compactNode(node, ast)) })
  for (const expected of [
    "if(!chat)thrownewError('CONTACT_CONVERSATION_LINK_STALE')",
    "if((chat.contactId!==null&&chat.contactId!==canonical.id)||(chat.contactIdentityId!==null&&chat.contactIdentityId!==identity.id)){thrownewError('CONTACT_CONVERSATION_OWNERSHIP_MISMATCH')}",
  ]) {
    if (!conditions.includes(expected)) throw new Error('fail-closed existing Chat ownership check')
  }
}

function assertAdapterDriverModel(source) {
  const { ast, body } = adapterEnvelope(source)
  const helpers = ast.statements.filter(statement => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'hasConfirmedRepresentativeDriver'
  ))
  if (helpers.length !== 1 || !helpers[0].body || helpers[0].parameters.length !== 2
    || !ts.isIdentifier(helpers[0].parameters[0].name) || helpers[0].parameters[0].name.text !== 'customFields'
    || compactNode(helpers[0].parameters[0].type, ast) !== 'unknown'
    || !ts.isIdentifier(helpers[0].parameters[1].name) || helpers[0].parameters[1].name.text !== 'driverId'
    || compactNode(helpers[0].parameters[1].type, ast) !== 'string'
    || compactNode(helpers[0].type, ast) !== 'boolean') throw new Error('confirmed Driver evidence helper')
  const expectedHelperStatements = [
    "if(!customFields||typeofcustomFields!=='object'||Array.isArray(customFields))returnfalse",
    'constconfirmations=(customFieldsasRecord<string,unknown>).driverConfirmations',
    'if(!Array.isArray(confirmations))returnfalse',
    "returnconfirmations.some(item=>{if(!item||typeofitem!=='object'||Array.isArray(item))returnfalseconstconfirmation=itemasRecord<string,unknown>returnconfirmation.status==='confirmed'&&confirmation.representativeDriverId===driverId})",
  ]
  if (JSON.stringify(helpers[0].body.statements.map(statement => compactNode(statement, ast)))
    !== JSON.stringify(expectedHelperStatements)) throw new Error('confirmed Driver evidence semantics')
  const confirmed = exactVariable(body, 'confirmedMainDriverId', ast)
  if (compactNode(confirmed.initializer, ast)
    !== 'canonical.mainDriverId&&hasConfirmedRepresentativeDriver(canonical.customFields,canonical.mainDriverId)?canonical.mainDriverId:null') {
    throw new Error('canonical confirmed Driver projection')
  }
  const driverConditions = []
  visit(body, node => {
    if (ts.isIfStatement(node) && normalize(node.expression.getText(ast)) === 'chat.driverId!==null') driverConditions.push(node)
  })
  const expectedCondition = "if(chat.driverId!==null){if(!confirmedMainDriverId||chat.driverId!==confirmedMainDriverId){thrownewError('CONTACT_CONVERSATION_DRIVER_MISMATCH')}}elseif(confirmedMainDriverId){updateData.driverId=confirmedMainDriverId}"
  if (driverConditions.length !== 1 || compactNode(driverConditions[0], ast) !== expectedCondition
    || source.includes('yandexDriverId') || expressionCalls(body, 'transaction.driver.findUnique', ast).length !== 0) {
    throw new Error('confirmed Driver preservation/enrichment')
  }
}

function assertAdapterCapacityModel(source) {
  const { ast, body } = adapterEnvelope(source)
  assertRootClientCalls(ast, 'prisma', ['prisma.$transaction'])
  assertRootClientCalls(ast, 'transaction', [
    'transaction.$queryRaw',
    'transaction.contactIdentity.findUnique',
    'transaction.contact.findUnique',
    'transaction.contact.findUnique',
    'transaction.chat.findUnique',
    'transaction.chat.update',
  ])
  if (/(Promise\.all|console\.|catch\s*\(|retry|sleep|setTimeout|\$executeRaw|RawUnsafe)/.test(source)) {
    throw new Error('generic orchestration or unsafe persistence capacity')
  }
  const returns = []
  const throws = []
  const catches = []
  visit(body, node => {
    if (ts.isReturnStatement(node)) returns.push(node)
    if (ts.isTryStatement(node) || ts.isCatchClause(node)) catches.push(node)
    if (ts.isThrowStatement(node)) {
      if (!node.expression || !ts.isNewExpression(node.expression)
        || !ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== 'Error'
        || node.expression.arguments?.length !== 1 || !ts.isStringLiteralLike(node.expression.arguments[0])) {
        throw new Error('non-literal owner failure')
      }
      throws.push(node.expression.arguments[0].text)
    }
  })
  const expectedFailures = [
    'CONTACT_IDENTITY_LINK_STALE',
    'CONTACT_IDENTITY_LINK_STALE',
    'CONTACT_IDENTITY_LINK_MISMATCH',
    'CONTACT_IDENTITY_LINK_MISMATCH',
    'CONTACT_CONVERSATION_LINK_STALE',
    'CONTACT_CONVERSATION_OWNERSHIP_MISMATCH',
    'CONTACT_CONVERSATION_DRIVER_MISMATCH',
  ]
  if (returns.length !== 0 || catches.length !== 0
    || JSON.stringify(throws.sort()) !== JSON.stringify(expectedFailures.sort())) {
    throw new Error('owner failure inventory')
  }
}

function assertAdapterModel(source) {
  assertAdapterLockModel(source)
  assertAdapterIdentityModel(source)
  assertAdapterConversationModel(source)
  assertAdapterDriverModel(source)
  assertAdapterCapacityModel(source)
}
const acceptsAdapterModel = source => {
  try { assertAdapterModel(source); return true } catch { return false }
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
  'owner acquires the shared CNT1 lock as the first statement in one bounded transaction',
  accepts(() => assertAdapterLockModel(adapter)),
  'lock coordinates, SQL, transaction order or transaction bounds drift',
)
check(
  'owner revalidates active identity canonical Contact and bounded merge lineage under CNT1',
  accepts(() => assertAdapterIdentityModel(adapter)),
  'identity ownership, canonical Contact or lineage validation drift',
)
check(
  'missing or differently owned Chat fails closed before one exact canonical update',
  accepts(() => assertAdapterConversationModel(adapter)),
  'Chat existence, monotonic ownership or canonical update mapping drift',
)
check(
  'driver linkage requires the canonical confirmed main Driver and never revives a legacy Yandex hint',
  accepts(() => assertAdapterDriverModel(adapter)),
  'confirmed Driver evidence, preservation or enrichment drift',
)
check(
  'owner retains only the exact lock-safe persistence capacity and no generic escape hatch',
  accepts(() => assertAdapterCapacityModel(adapter)) &&
    !/(tableName|sql|predicate|whereClause|transaction|select|include|orderBy|page)\s*:/i.test(contract + portSource),
  'owner acquired extra client, orchestration, SQL, return or failure capacity',
)
check(
  'Contacts compatibility method is removed without reverse dependency',
  !/ensureChatLinked/.test(contactService) &&
    !/from\s*['"]@\/(?:contracts|modules)\/messaging\//.test(contactService),
  'Contacts wrapper or Contacts-to-Messaging import remains',
)
check(
  'the two identity-unsafe legacy consumers remain static fail-closed tombstones',
  accepts(() => assertRetiredConsumerModel()),
  'a retired route regained parsing, imports, mutable work or a non-failing response',
)
check(
  'exactly nine calls exist across the five active consumers',
  consumers.length === 5 && accepts(() => assertConsumerModel()),
  'consumer population or awaited call count drift',
)
check(
  'the sole Telegram link remains inside one admission helper reached by inbound mirror and import flows',
  accepts(() => assertTelegramAdmissionModel(sources.get('gravity-mvp/src/app/tg-actions.ts'))),
  'Telegram admission phase, caller mapping or shared link ownership drift',
)
const rewriteCallStatement = (file, source, callee, target, rewrite) => {
  const ast = parse(file, source)
  const call = identifierCalls(ast, callee)[target]
  if (!call) throw new Error(`${file}: missing ${callee} probe target ${target}`)
  let statement = call
  while (statement && !ts.isExpressionStatement(statement) && !ts.isVariableStatement(statement)) statement = statement.parent
  if (!statement) throw new Error(`${file}: ${callee} probe target is not a statement`)
  const start = statement.getStart(ast)
  return source.slice(0, start) + rewrite(source.slice(start, statement.end)) + source.slice(statement.end)
}
const directFacadeBindingProbe = publicIndex.replace(
  '../../application/messaging-operations',
  './legacy-prisma-conversation-contact-link-adapter',
)
const reducedDenominatorProbe = sources.get(consumers[0]).replace(
  'await ensureConversationContactLinkV1(',
  'await removedConversationContactLinkV1(',
)
const aliasedFacadeProbe = sources.get(consumers[0])
  .replace('ensureConversationContactLinkV1,', 'ensureConversationContactLinkV1 as aliasedConversationContactLink,')
  .replace('await ensureConversationContactLinkV1(', 'await aliasedConversationContactLink(')
const compoundFalseConsumerProbe = rewriteCallStatement(
  consumers[0],
  sources.get(consumers[0]),
  'ensureConversationContactLinkV1',
  0,
  statement => `if (false && chat.id.length > 0) {\n${statement}\n}`,
)
const consumerProbes = [
  new Map([[consumers[0], `${reducedDenominatorProbe}\n// await ensureConversationContactLinkV1({})\n`]]),
  new Map([[consumers[0], `${reducedDenominatorProbe}\nif (false) { void ensureConversationContactLinkV1({}) }\n`]]),
  new Map([[consumers[0], sources.get(consumers[0]).replace('@/modules/messaging/public/v1', '@/modules/messaging/application/messaging-operations')]]),
  new Map([[consumers[0], reducedDenominatorProbe]]),
  new Map([[consumers[0], `${sources.get(consumers[0])}\nvoid ensureConversationContactLinkV1({})\n`]]),
  new Map([[consumers[0], aliasedFacadeProbe]]),
  new Map([[consumers[0], compoundFalseConsumerProbe]]),
  new Map([['gravity-mvp/src/app/api/messages/start-chat/route.ts',
    `${sources.get('gravity-mvp/src/app/api/messages/start-chat/route.ts')}\nvoid messaging.ensureConversationContactLinkV1({})\n`]]),
  new Map([['gravity-mvp/src/app/api/messages/start-chat/route.ts',
    `${sources.get('gravity-mvp/src/app/api/messages/start-chat/route.ts')}\nvoid messaging['ensureConversationContactLinkV1']({})\n`]]),
]
const retiredConsumerProbes = [
  new Map([['gravity-mvp/src/app/api/messages/start-chat/route.ts',
    sources.get('gravity-mvp/src/app/api/messages/start-chat/route.ts').replace('status: 409', 'status: 200')]]),
  new Map([['gravity-mvp/src/app/api/messages/start-chat/route.ts',
    sources.get('gravity-mvp/src/app/api/messages/start-chat/route.ts').replace(
      '    return NextResponse.json({',
      '    await _request.json()\n    return NextResponse.json({',
    )]]),
  new Map([['gravity-mvp/src/app/api/webhook/max/route.ts',
    sources.get('gravity-mvp/src/app/api/webhook/max/route.ts').replace('status: 410', 'status: 200')]]),
]
const telegramSource = sources.get('gravity-mvp/src/app/tg-actions.ts')
const telegramAdmissionProbes = [0, 1, 2].map(target => {
  let index = 0
  return telegramSource.replaceAll('await admitTelegramPrivateConversation({', match => {
    const replacement = index === target ? 'await removedTelegramPrivateConversation({' : match
    index += 1
    return replacement
  })
})
telegramAdmissionProbes.push(rewriteCallStatement(
  'gravity-mvp/src/app/tg-actions.ts',
  telegramSource,
  'ensureConversationContactLinkV1',
  0,
  statement => `return chat\n${statement}`,
))
telegramAdmissionProbes.push(rewriteCallStatement(
  'gravity-mvp/src/app/tg-actions.ts',
  telegramSource,
  'ensureConversationContactLinkV1',
  0,
  statement => `if (true) { return chat }\n${statement}`,
))
const adapterProbes = [
  adapter.replace(
    'CAST(${CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID_V1} AS integer)',
    'CAST(${CONTACT_OWNERSHIP_ADVISORY_CLASS_ID_V1} AS integer)',
  ),
  adapter.replace('await transaction.$queryRaw', 'void transaction.$queryRaw'),
  adapter.replace('const identity = await transaction.contactIdentity.findUnique', 'const identity = transaction.contactIdentity.findUnique'),
  adapter.replace("if (!identity?.isActive) throw new Error('CONTACT_IDENTITY_LINK_STALE')", "if (!identity) throw new Error('CONTACT_IDENTITY_LINK_STALE')"),
  adapter.replace("if (!canonical || canonical.isArchived) throw new Error('CONTACT_IDENTITY_LINK_STALE')", "if (!canonical) throw new Error('CONTACT_IDENTITY_LINK_STALE')"),
  adapter.replace('depth < 16', 'depth < 32'),
  adapter.replace('contactId: canonical.id,', 'contactId: input.contactId,'),
  adapter.replace("if (!chat) throw new Error('CONTACT_CONVERSATION_LINK_STALE')", 'if (!chat) return'),
  adapter.replace('chat.contactIdentityId !== null', 'false'),
  adapter.replace("confirmation.status === 'confirmed'", "confirmation.status !== 'contradicted'"),
  adapter.replace('mainDriverId: true,', 'mainDriverId: true,\n          yandexDriverId: true,'),
  adapter.replace('Prisma.TransactionIsolationLevel.ReadCommitted', 'Prisma.TransactionIsolationLevel.Serializable'),
  adapter.replace(
    '      await transaction.chat.update({ where: { id: input.chatId }, data: updateData })',
    '      try {\n        await transaction.chat.update({ where: { id: input.chatId }, data: updateData })\n      } catch {}',
  ),
  adapter.replace(
    '      await transaction.chat.update({ where: { id: input.chatId }, data: updateData })',
    "      await transaction.$executeRawUnsafe('SELECT 1')\n      await transaction.chat.update({ where: { id: input.chatId }, data: updateData })",
  ),
]
check(
  'negative probes reject lock identity ownership driver tombstone facade and denominator weakening',
  acceptsCompositionModel(publicIndex, application) &&
    acceptsAdapterModel(adapter) &&
    acceptsRetiredConsumerModel() &&
    acceptsConsumerModel() &&
    acceptsTelegramAdmissionModel(telegramSource) &&
    !acceptsCompositionModel(directFacadeBindingProbe, application) &&
    adapterProbes.every(probe => !acceptsAdapterModel(probe)) &&
    retiredConsumerProbes.every(probe => !acceptsRetiredConsumerModel(probe)) &&
    consumerProbes.every(probe => !acceptsConsumerModel(probe)) &&
    telegramAdmissionProbes.every(probe => !acceptsTelegramAdmissionModel(probe)),
  'a fail-open adapter, restored legacy route, facade bypass or denominator drift was accepted',
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
    adapter.includes('transaction.chat.update') &&
    !adapter.includes('prisma.chat.update') &&
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
