#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

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
const sourceRoot = 'gravity-mvp/src'
const consumerPath = 'gravity-mvp/src/lib/RetentionCleanup.ts'
const consumerModules = {
  deleteContactForRetentionV1: '@/modules/contacts/public/v1',
  detachContactConversationsV1: '@/modules/messaging/public/v1',
  detachContactTasksV1: '@/modules/work-management/public/v1',
}
const compositionSpecs = [
  {
    applicationPath: 'gravity-mvp/src/modules/contacts/application/contact-operations.ts',
    indexPath: 'gravity-mvp/src/modules/contacts/public/v1/index.ts',
    applicationModule: '../../application/contact-operations',
    handlerModule: '../public/v1/contact-retention-handler',
    adapterModule: '../public/v1/legacy-prisma-contact-retention-adapter',
    factory: 'createDeleteContactForRetentionHandlerV1',
    adapter: 'legacyPrismaContactRetentionPortV1',
    local: 'deleteContactForRetention',
    operation: 'deleteContactForRetentionV1',
  },
  {
    applicationPath: 'gravity-mvp/src/modules/messaging/application/messaging-operations.ts',
    indexPath: 'gravity-mvp/src/modules/messaging/public/v1/index.ts',
    applicationModule: '../../application/messaging-operations',
    handlerModule: '../public/v1/contact-retention-handler',
    adapterModule: '../public/v1/legacy-prisma-contact-retention-adapter',
    factory: 'createDetachContactConversationsHandlerV1',
    adapter: 'legacyPrismaContactConversationRetentionPortV1',
    local: 'detachContactConversations',
    operation: 'detachContactConversationsV1',
  },
  {
    applicationPath: 'gravity-mvp/src/modules/work-management/application/task-operations.ts',
    indexPath: 'gravity-mvp/src/modules/work-management/public/v1/index.ts',
    applicationModule: '../../application/task-operations',
    handlerModule: '../public/v1/contact-retention-handler',
    adapterModule: '../public/v1/legacy-prisma-contact-retention-adapter',
    factory: 'createDetachContactTasksHandlerV1',
    adapter: 'legacyPrismaContactTaskRetentionPortV1',
    local: 'detachContactTasks',
    operation: 'detachContactTasksV1',
  },
]
const handlerSpecs = [
  {
    file: 'gravity-mvp/src/modules/contacts/public/v1/contact-retention-handler.ts',
    factory: 'createDeleteContactForRetentionHandlerV1',
    inner: 'deleteContactForRetentionV1',
    parser: 'parseDeleteContactForRetentionCommandV1',
    portMethod: 'deleteContactForRetention',
    result: 'DELETE_CONTACT_FOR_RETENTION_RESULT_V1',
  },
  {
    file: 'gravity-mvp/src/modules/messaging/public/v1/contact-retention-handler.ts',
    factory: 'createDetachContactConversationsHandlerV1',
    inner: 'detachContactConversationsV1',
    parser: 'parseDetachContactConversationsCommandV1',
    portMethod: 'detachContactConversations',
    result: 'DETACH_CONTACT_CONVERSATIONS_RESULT_V1',
  },
  {
    file: 'gravity-mvp/src/modules/work-management/public/v1/contact-retention-handler.ts',
    factory: 'createDetachContactTasksHandlerV1',
    inner: 'detachContactTasksV1',
    parser: 'parseDetachContactTasksCommandV1',
    portMethod: 'detachContactTasks',
    result: 'DETACH_CONTACT_TASKS_RESULT_V1',
  },
]
const sourceFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(directory, entry.name)
  if (entry.isDirectory()) return sourceFiles(file)
  return /\.(?:ts|tsx)$/.test(entry.name) ? [file] : []
})
const repositorySources = new Map(sourceFiles(sourceRoot).map((file) => [file, read(file)]))
const parseCache = new Map()
const parse = (file, source) => {
  let sources = parseCache.get(file)
  if (!sources) {
    sources = new Map()
    parseCache.set(file, sources)
  }
  if (!sources.has(source)) sources.set(source, ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  ))
  return sources.get(source)
}
const walk = (node, visit) => {
  visit(node)
  ts.forEachChild(node, child => walk(child, visit))
}
const unwrap = (node) => {
  let current = node
  while (current && (
    ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  )) current = current.expression
  return current
}
const isIdentifier = (node, name) => ts.isIdentifier(unwrap(node)) && unwrap(node).text === name
const hasExport = (node) => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
const staticNamedBindings = (sourceFile, direction, specifier) => {
  const records = []
  for (const statement of sourceFile.statements) {
    if (direction === 'import' && ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteralLike(statement.moduleSpecifier) || statement.moduleSpecifier.text !== specifier) continue
      const clause = statement.importClause
      if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue
      for (const binding of clause.namedBindings.elements) if (!binding.isTypeOnly) records.push({
        imported: binding.propertyName?.text ?? binding.name.text,
        local: binding.name.text,
      })
    }
    if (direction === 'export' && ts.isExportDeclaration(statement)) {
      if (!statement.moduleSpecifier || !ts.isStringLiteralLike(statement.moduleSpecifier)
        || statement.moduleSpecifier.text !== specifier || !statement.exportClause
        || !ts.isNamedExports(statement.exportClause)) continue
      for (const binding of statement.exportClause.elements) records.push({
        imported: binding.propertyName?.text ?? binding.name.text,
        local: binding.name.text,
      })
    }
  }
  return records
}
const allNamedImports = (sourceFile) => {
  const records = []
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue
    const clause = statement.importClause
    if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue
    for (const binding of clause.namedBindings.elements) if (!binding.isTypeOnly) records.push({
      module: statement.moduleSpecifier.text,
      imported: binding.propertyName?.text ?? binding.name.text,
      local: binding.name.text,
    })
  }
  return records
}
const dynamicNamedImports = (sourceFile) => {
  const records = []
  walk(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isObjectBindingPattern(node.name) || !node.initializer) return
    let initializer = unwrap(node.initializer)
    if (ts.isAwaitExpression(initializer)) initializer = unwrap(initializer.expression)
    if (!ts.isCallExpression(initializer) || initializer.expression.kind !== ts.SyntaxKind.ImportKeyword
      || initializer.arguments.length !== 1 || !ts.isStringLiteralLike(initializer.arguments[0])) return
    for (const binding of node.name.elements) {
      if (binding.dotDotDotToken || !ts.isIdentifier(binding.name)) continue
      records.push({
        module: initializer.arguments[0].text,
        imported: binding.propertyName && (ts.isIdentifier(binding.propertyName) || ts.isStringLiteralLike(binding.propertyName))
          ? binding.propertyName.text : binding.name.text,
        local: binding.name.text,
      })
    }
  })
  return records
}
const declarationsNamed = (sourceFile, name) => sourceFile.statements.flatMap(statement => (
  ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []
)).filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name)
const exactComposition = (sources, spec) => {
  const application = parse(spec.applicationPath, sources.get(spec.applicationPath) ?? '')
  const publicIndex = parse(spec.indexPath, sources.get(spec.indexPath) ?? '')
  if (application.parseDiagnostics.length || publicIndex.parseDiagnostics.length) return false
  const factoryBindings = staticNamedBindings(application, 'import', spec.handlerModule)
  const adapterBindings = staticNamedBindings(application, 'import', spec.adapterModule)
  const publicBindings = staticNamedBindings(publicIndex, 'export', spec.applicationModule)
  const locals = declarationsNamed(application, spec.local)
  const wrappers = declarationsNamed(application, spec.operation)
  if (locals.length !== 1 || wrappers.length !== 1) return false
  const factoryCall = unwrap(locals[0].initializer)
  const wrapper = unwrap(wrappers[0].initializer)
  const wrapperStatement = wrappers[0].parent.parent
  if (!factoryCall || !ts.isCallExpression(factoryCall) || !isIdentifier(factoryCall.expression, spec.factory)
    || factoryCall.arguments.length !== 1 || !isIdentifier(factoryCall.arguments[0], spec.adapter)) return false
  if (!ts.isVariableStatement(wrapperStatement) || !hasExport(wrapperStatement)
    || !wrapper || !ts.isArrowFunction(wrapper) || wrapper.parameters.length !== 1) return false
  const parameter = wrapper.parameters[0]
  const body = unwrap(wrapper.body)
  if (!parameter.dotDotDotToken || !isIdentifier(parameter.name, 'args')
    || !parameter.type || !ts.isTypeReferenceNode(parameter.type)
    || !isIdentifier(parameter.type.typeName, 'Parameters') || parameter.type.typeArguments?.length !== 1
    || !ts.isTypeQueryNode(parameter.type.typeArguments[0])
    || !isIdentifier(parameter.type.typeArguments[0].exprName, spec.local)
    || !ts.isCallExpression(body) || !isIdentifier(body.expression, spec.local)
    || body.arguments.length !== 1 || !ts.isSpreadElement(body.arguments[0])
    || !isIdentifier(body.arguments[0].expression, 'args')) return false
  const adapterCalls = []
  const localCalls = []
  let adapterIdentifiers = 0
  walk(application, (node) => {
    if (ts.isIdentifier(node) && node.text === spec.adapter) adapterIdentifiers += 1
    if (ts.isCallExpression(node) && node.arguments.some(argument => isIdentifier(argument, spec.adapter))) adapterCalls.push(node)
    if (ts.isCallExpression(node) && isIdentifier(node.expression, spec.local)) localCalls.push(node)
  })
  const exposedModules = publicIndex.statements.filter(statement => (
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
    && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
  )).map(statement => statement.moduleSpecifier.text)
  return factoryBindings.filter(binding => binding.imported === spec.factory && binding.local === spec.factory).length === 1
    && adapterBindings.length === 1 && adapterBindings[0].imported === spec.adapter && adapterBindings[0].local === spec.adapter
    && publicBindings.filter(binding => binding.imported === spec.operation && binding.local === spec.operation).length === 1
    && adapterCalls.length === 1 && adapterCalls[0] === factoryCall && adapterIdentifiers === 2
    && localCalls.length === 1 && localCalls[0] === body
    && !exposedModules.some(module => module.includes('legacy-prisma-contact-retention-adapter'))
}
const exactRuntimeConsumers = (sources) => {
  const operations = new Set(Object.keys(consumerModules))
  const records = []
  const callFiles = new Map([...operations].map(operation => [operation, []]))
  let propertyBypasses = 0
  for (const [file, source] of sources) {
    if (![...operations].some(operation => source.includes(operation))) continue
    const sourceFile = parse(file, source)
    for (const binding of [...allNamedImports(sourceFile), ...dynamicNamedImports(sourceFile)]) {
      if (operations.has(binding.imported)) records.push({ file, ...binding })
    }
    walk(sourceFile, (node) => {
      if (ts.isPropertyAccessExpression(node) && operations.has(node.name.text)) propertyBypasses += 1
      if (ts.isCallExpression(node) && ts.isIdentifier(unwrap(node.expression))
        && operations.has(unwrap(node.expression).text)) callFiles.get(unwrap(node.expression).text).push(file)
    })
  }
  const consumerFile = parse(consumerPath, sources.get(consumerPath) ?? '')
  return consumerFile.parseDiagnostics.length === 0 && propertyBypasses === 0
    && [...operations].every((operation) => {
      const matching = records.filter(record => record.imported === operation)
      let calls = 0
      walk(consumerFile, (node) => {
        if (ts.isCallExpression(node) && isIdentifier(node.expression, operation)) calls += 1
      })
      return matching.length === 1 && matching[0].file === consumerPath
        && matching[0].module === consumerModules[operation] && matching[0].local === operation
        && calls === 1 && callFiles.get(operation).length === 1 && callFiles.get(operation)[0] === consumerPath
    })
}
const exactPrivateCompositionConsumers = (sources) => compositionSpecs.every((spec) => {
  const records = []
  for (const [file, source] of sources) {
    if (!source.includes(spec.adapter) && !source.includes(spec.factory)) continue
    for (const binding of [...allNamedImports(parse(file, source)), ...dynamicNamedImports(parse(file, source))]) {
      if (binding.imported === spec.adapter || binding.imported === spec.factory) records.push({ file, ...binding })
    }
  }
  const adapterRecords = records.filter(record => record.imported === spec.adapter)
  const factoryRecords = records.filter(record => record.imported === spec.factory)
  return adapterRecords.length === 1 && adapterRecords[0].file === spec.applicationPath
    && adapterRecords[0].module === spec.adapterModule && adapterRecords[0].local === spec.adapter
    && factoryRecords.length === 1 && factoryRecords[0].file === spec.applicationPath
    && factoryRecords[0].module === spec.handlerModule && factoryRecords[0].local === spec.factory
})
const exactHandler = (source, spec) => {
  const sourceFile = parse(spec.file, source)
  if (sourceFile.parseDiagnostics.length) return false
  const factories = sourceFile.statements.filter(statement => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === spec.factory && hasExport(statement)
  ))
  if (factories.length !== 1 || !factories[0].body) return false
  const returns = factories[0].body.statements.filter(ts.isReturnStatement)
  const inner = returns.length === 1 ? unwrap(returns[0].expression) : null
  if (!inner || !ts.isFunctionExpression(inner) || !inner.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    || inner.name?.text !== spec.inner || inner.parameters.length !== 1 || !inner.body
    || inner.body.statements.length !== 3) return false
  const [parseStatement, portStatement, resultStatement] = inner.body.statements
  if (!ts.isVariableStatement(parseStatement) || parseStatement.declarationList.declarations.length !== 1) return false
  const parsedDeclaration = parseStatement.declarationList.declarations[0]
  const parseCall = unwrap(parsedDeclaration.initializer)
  if (!isIdentifier(parsedDeclaration.name, 'parsed') || !parseCall || !ts.isCallExpression(parseCall)
    || !isIdentifier(parseCall.expression, spec.parser) || parseCall.arguments.length !== 1
    || !isIdentifier(parseCall.arguments[0], 'command')) return false
  const awaited = ts.isExpressionStatement(portStatement) && ts.isAwaitExpression(unwrap(portStatement.expression))
    ? unwrap(portStatement.expression).expression : null
  const portCall = unwrap(awaited)
  if (!portCall || !ts.isCallExpression(portCall) || !ts.isPropertyAccessExpression(unwrap(portCall.expression))
    || !isIdentifier(unwrap(portCall.expression).expression, 'port')
    || unwrap(portCall.expression).name.text !== spec.portMethod || portCall.arguments.length !== 1
    || !ts.isPropertyAccessExpression(unwrap(portCall.arguments[0]))
    || !isIdentifier(unwrap(portCall.arguments[0]).expression, 'parsed')
    || unwrap(portCall.arguments[0]).name.text !== 'contactId') return false
  const result = ts.isReturnStatement(resultStatement) ? unwrap(resultStatement.expression) : null
  if (!result || !ts.isObjectLiteralExpression(result) || result.properties.length !== 2) return false
  const contract = result.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === 'contract')
  const completed = result.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === 'completed')
  return Boolean(contract && completed && isIdentifier(contract.initializer, spec.result)
    && completed.initializer.kind === ts.SyntaxKind.TrueKeyword)
}
const propertyChain = (node) => {
  const current = unwrap(node)
  if (ts.isIdentifier(current)) return current.text
  if (ts.isPropertyAccessExpression(current)) {
    const prefix = propertyChain(current.expression)
    return prefix ? `${prefix}.${current.name.text}` : null
  }
  return null
}
const callsByChain = (source, file, chain) => {
  const result = []
  walk(parse(file, source), (node) => {
    if (ts.isCallExpression(node) && propertyChain(node.expression) === chain) result.push(node)
  })
  return result
}
const findMethod = (sourceFile, name) => {
  const methods = []
  walk(sourceFile, (node) => {
    if (ts.isMethodDeclaration(node) && node.name.getText(sourceFile) === name) methods.push(node)
  })
  return methods.length === 1 ? methods[0] : null
}
const exactArchivedMutationSequence = (source) => {
  const sourceFile = parse(consumerPath, source)
  if (sourceFile.parseDiagnostics.length) return false
  const method = findMethod(sourceFile, '_cleanupArchivedContacts')
  if (!method?.body) return false
  const dryRunBlocks = []
  walk(method.body, (node) => {
    if (!ts.isIfStatement(node)) return
    const condition = unwrap(node.expression)
    if (ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken
      && isIdentifier(condition.operand, 'dryRun') && ts.isBlock(node.thenStatement)) dryRunBlocks.push(node.thenStatement)
  })
  if (dryRunBlocks.length !== 1 || dryRunBlocks[0].statements.length !== 3) return false
  const expected = [
    ['detachContactConversationsV1', 'DETACH_CONTACT_CONVERSATIONS_COMMAND_V1'],
    ['detachContactTasksV1', 'DETACH_CONTACT_TASKS_COMMAND_V1'],
    ['deleteContactForRetentionV1', 'DELETE_CONTACT_FOR_RETENTION_COMMAND_V1'],
  ]
  return expected.every(([operation, contract], index) => {
    const statement = dryRunBlocks[0].statements[index]
    const awaitExpression = ts.isExpressionStatement(statement) && ts.isAwaitExpression(unwrap(statement.expression))
      ? unwrap(statement.expression) : null
    const call = awaitExpression ? unwrap(awaitExpression.expression) : null
    if (!call || !ts.isCallExpression(call) || !isIdentifier(call.expression, operation)
      || call.arguments.length !== 1 || !ts.isObjectLiteralExpression(unwrap(call.arguments[0]))) return false
    const fields = unwrap(call.arguments[0]).properties
    if (fields.length !== 2 || !fields.every(ts.isPropertyAssignment)) return false
    const values = Object.fromEntries(fields.map(field => [field.name.getText(sourceFile), unwrap(field.initializer)]))
    return isIdentifier(values.contract, contract) && isIdentifier(values.contactId, 'id')
  })
}

const contactsContract = read('gravity-mvp/src/contracts/contacts/v1/contact-retention-command.ts')
const messagingContract = read('gravity-mvp/src/contracts/messaging/v1/contact-retention-command.ts')
const workContract = read('gravity-mvp/src/contracts/work-management/v1/contact-retention-command.ts')
const contactsHandler = read('gravity-mvp/src/modules/contacts/public/v1/contact-retention-handler.ts')
const messagingHandler = read('gravity-mvp/src/modules/messaging/public/v1/contact-retention-handler.ts')
const workHandler = read('gravity-mvp/src/modules/work-management/public/v1/contact-retention-handler.ts')
const contactsAdapter = read('gravity-mvp/src/modules/contacts/public/v1/legacy-prisma-contact-retention-adapter.ts')
const messagingAdapter = read('gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-contact-retention-adapter.ts')
const workAdapter = read('gravity-mvp/src/modules/work-management/public/v1/legacy-prisma-contact-retention-adapter.ts')
const contactsIndex = read('gravity-mvp/src/modules/contacts/public/v1/index.ts')
const messagingIndex = read('gravity-mvp/src/modules/messaging/public/v1/index.ts')
const workIndex = read('gravity-mvp/src/modules/work-management/public/v1/index.ts')
const contactsOperations = read('gravity-mvp/src/modules/contacts/application/contact-operations.ts')
const messagingOperations = read('gravity-mvp/src/modules/messaging/application/messaging-operations.ts')
const workOperations = read('gravity-mvp/src/modules/work-management/application/task-operations.ts')
const consumer = read('gravity-mvp/src/lib/RetentionCleanup.ts')
const amendmentPath = 'architecture/isolation/operations-observability/archived-contact-purge-v1/module-manifest-amendments.json'
const amendment = JSON.parse(read(amendmentPath))
const migration = JSON.parse(read('architecture/isolation/operations-observability/archived-contact-purge-v1/migration-manifest.json'))
const policy = JSON.parse(read('architecture/enforcement/v1/policy.json'))
const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const contracts = contactsContract + messagingContract + workContract
const handlers = contactsHandler + messagingHandler + workHandler
const adapters = contactsAdapter + messagingAdapter + workAdapter
const contactsBody = sliceBetween(contactsHandler, 'return async function deleteContactForRetentionV1', null)
const messagingBody = sliceBetween(messagingHandler, 'return async function detachContactConversationsV1', null)
const workBody = sliceBetween(workHandler, 'return async function detachContactTasksV1', null)
const archivedMethod = sliceBetween(consumer, 'private static async _cleanupArchivedContacts', null)
const dependencyRead = sliceBetween(archivedMethod, 'const deps = await prisma.$queryRaw', 'const dep = deps[0]')
const mutationBlock = sliceBetween(archivedMethod, 'if (!dryRun) {', 'deleted++')
const archivedPhase = sliceBetween(consumer, '// 7. Archived contacts', '} catch (err: any)')
const messagingRawCalls = callsByChain(
  messagingAdapter,
  'gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-contact-retention-adapter.ts',
  'prisma.$executeRawUnsafe',
)
const workRawCalls = callsByChain(
  workAdapter,
  'gravity-mvp/src/modules/work-management/public/v1/legacy-prisma-contact-retention-adapter.ts',
  'prisma.$executeRawUnsafe',
)
const contactDeleteCalls = callsByChain(
  contactsAdapter,
  'gravity-mvp/src/modules/contacts/public/v1/legacy-prisma-contact-retention-adapter.ts',
  'prisma.contact.deleteMany',
)
const currentAstBoundaryIsValid = compositionSpecs.every(spec => exactComposition(repositorySources, spec))
  && exactPrivateCompositionConsumers(repositorySources)
  && exactRuntimeConsumers(repositorySources)
  && handlerSpecs.every(spec => exactHandler(repositorySources.get(spec.file) ?? '', spec))
  && exactArchivedMutationSequence(consumer)
const withSource = (sources, file, source) => new Map([...sources, [file, source]])
const contactWrapper = 'export const deleteContactForRetentionV1 = (...args: Parameters<typeof deleteContactForRetention>) => deleteContactForRetention(...args)'
const extraMutation = `      if (!dryRun) {
        await detachContactConversationsV1({
          contract: DETACH_CONTACT_CONVERSATIONS_COMMAND_V1,
          contactId: id,
        })`
const failClosedAstProbes = [
  withSource(
    repositorySources,
    compositionSpecs[0].applicationPath,
    contactsOperations.replace(contactWrapper, `// ${contactWrapper}`),
  ),
  withSource(repositorySources, consumerPath, consumer.replace('      if (!dryRun) {', extraMutation)),
  withSource(
    repositorySources,
    consumerPath,
    consumer.replace('@/modules/contacts/public/v1', '@/modules/contacts/application/contact-operations'),
  ),
  new Map([...repositorySources, [
    'gravity-mvp/src/app/archived-contact-purge-probe.ts',
    `import { detachContactTasksV1 } from '${consumerModules.detachContactTasksV1}'\nvoid detachContactTasksV1\n`,
  ]]),
]
const astBoundaryProbePasses = (sources) => compositionSpecs.every(spec => exactComposition(sources, spec))
  && exactPrivateCompositionConsumers(sources)
  && exactRuntimeConsumers(sources)
  && handlerSpecs.every(spec => exactHandler(sources.get(spec.file) ?? '', spec))
  && exactArchivedMutationSequence(sources.get(consumerPath) ?? '')

check(
  'contracts and handlers remain infrastructure neutral',
  !/(prisma|next\/|@\/lib|@\/app)/i.test(contracts + handlers),
  'public contract or handler leaks infrastructure',
)
check(
  'literal command and result identities exact',
  contactsContract.includes("'contacts.DeleteContactForRetentionCommand.v1'") &&
    contactsContract.includes("'contacts.DeleteContactForRetentionResult.v1'") &&
    messagingContract.includes("'messaging.DetachContactConversationsCommand.v1'") &&
    messagingContract.includes("'messaging.DetachContactConversationsResult.v1'") &&
    workContract.includes("'work_management.DetachContactTasksCommand.v1'") &&
    workContract.includes("'work_management.DetachContactTasksResult.v1'"),
  'public identity drift',
)
check(
  'contracts expose only contract and contactId',
  (contracts.match(/!\['contract', 'contactId'\]\.includes\(key\)/g) || []).length === 3 &&
    (contracts.match(/contactId: string/g) || []).length === 3 &&
    !/(callContactId|contactIdentityId|dryRun|transaction|sql|predicate)/.test(contracts),
  'contract field scope widened',
)
check(
  'each concrete handler parses before its exact port',
  handlerSpecs.every(spec => exactHandler(repositorySources.get(spec.file) ?? '', spec)),
  'handler parse/port order drift',
)
check(
  'handlers return exact completed results and expose owner failure',
  handlerSpecs.every(spec => exactHandler(repositorySources.get(spec.file) ?? '', spec)) &&
    !/\b(?:try|catch)\b/.test(adapters),
  'handler result or failure propagation drift',
)
check(
  'application roots bind all three owner adapters and public indexes expose only operations',
  currentAstBoundaryIsValid,
  'owner application composition or narrow public export missing',
)
check(
  'retention AST boundary is fail-closed against spoofing and bypasses',
  currentAstBoundaryIsValid && failClosedAstProbes.length === 4
    && failClosedAstProbes.every(probe => !astBoundaryProbePasses(probe)),
  'AST detector accepted a comment, extra mutation, private bypass, or extra consumer',
)
check(
  'Messaging detach keeps exact literal positional SQL',
  messagingRawCalls.length === 1 && messagingRawCalls[0].arguments.length === 2 &&
    ts.isStringLiteral(messagingRawCalls[0].arguments[0]) &&
    messagingRawCalls[0].arguments[0].text === 'UPDATE "Chat" SET "contactId" = NULL, "contactIdentityId" = NULL WHERE "contactId" = $1' &&
    isIdentifier(messagingRawCalls[0].arguments[1], 'contactId') &&
    !/\$executeRaw`|updateMany|\bOR\b|"contactIdentityId"\s*=\s*\$1/.test(messagingAdapter),
  'Messaging detach broadened scope or changed raw execution semantics',
)
check(
  'Work detach keeps exact literal positional SQL',
  workRawCalls.length === 1 && workRawCalls[0].arguments.length === 2 &&
    ts.isStringLiteral(workRawCalls[0].arguments[0]) &&
    workRawCalls[0].arguments[0].text === 'UPDATE "tasks" SET "contactId" = NULL WHERE "contactId" = $1' &&
    isIdentifier(workRawCalls[0].arguments[1], 'contactId') &&
    !/\$executeRaw`|updateMany|\bOR\b/.test(workAdapter),
  'Work detach broadened scope or changed raw execution semantics',
)
check(
  'Contacts typed deleteMany preserves zero-row success',
  contactDeleteCalls.length === 1 && contactDeleteCalls[0].arguments.length === 1 &&
    contactDeleteCalls[0].arguments[0].getText(parse('contact-adapter.ts', contactsAdapter)).replace(/\s+/g, '') === '{where:{id:contactId}}' &&
    !/\.delete\(|\$(?:query|execute)Raw|\.count|throw/.test(contactsAdapter),
  'Contacts adapter changed missing-row completion semantics',
)
check(
  'archived candidate read exact and equal-time order unspecified',
  archivedMethod.includes('WHERE "isArchived" = true') &&
    archivedMethod.includes('"updatedAt" < (NOW() AT TIME ZONE \'UTC\') - CAST(${ageDays + \' days\'} AS INTERVAL)') &&
    archivedMethod.includes('ORDER BY "updatedAt" ASC') &&
    archivedMethod.includes('LIMIT ${limit}') &&
    !/ORDER BY "updatedAt" ASC[^\n]*(?:,|\bid\b)/.test(archivedMethod),
  'candidate selection or equal-time ordering drift',
)
check(
  'dependency read remains Chat Message ContactMerge only',
  dependencyRead.includes('FROM "Chat" WHERE "contactId" = ${id} AND status != \'resolved\'') &&
    dependencyRead.includes('FROM "Message" m') &&
    dependencyRead.includes('JOIN "Chat" c ON c.id = m."chatId"') &&
    dependencyRead.includes('WHERE c."contactId" = ${id}') &&
    dependencyRead.includes("INTERVAL '30 days'") &&
    dependencyRead.includes('FROM "ContactMerge" WHERE "survivorId" = ${id} OR "mergedId" = ${id}') &&
    !/\bCall\b|ContactIdentity|inconsistent/i.test(dependencyRead),
  'dependency safety scope broadened',
)
check(
  'skip accounting retains the exact three dependency classes',
  archivedMethod.includes('if (dep.activeChats > 0 || dep.recentMessages > 0 || dep.merges > 0)') &&
    archivedMethod.indexOf('skipped++') < archivedMethod.indexOf('continue'),
  'skip predicate or count drift',
)
check(
  'real mutation order remains Messaging then Work then Contacts',
  exactArchivedMutationSequence(consumer),
  'nontransactional owner sequence drift',
)
check(
  'dry run and missing final row preserve deleted count behavior',
  archivedMethod.indexOf('if (!dryRun) {') < archivedMethod.indexOf('await detachContactConversationsV1') &&
    archivedMethod.indexOf('await deleteContactForRetentionV1') < archivedMethod.indexOf('deleted++') &&
    (archivedMethod.match(/deleted\+\+/g) || []).length === 1,
  'dry-run or successful zero-row count behavior drift',
)
check(
  'deadline remains between phases only',
  (archivedPhase.match(/if \(!checkTimeout\(\)\)/g) || []).length === 1 &&
    archivedPhase.indexOf('if (!checkTimeout())') < archivedPhase.indexOf('await this._cleanupArchivedContacts') &&
    !archivedMethod.includes('checkTimeout'),
  'deadline moved inside the archived-contact loop or phase guard vanished',
)
check(
  'outer result assignment remains after complete workflow return',
  archivedPhase.indexOf('const contactResult = await this._cleanupArchivedContacts') <
    archivedPhase.indexOf('result.deletedArchivedContacts = contactResult.deleted') &&
    archivedPhase.indexOf('result.deletedArchivedContacts = contactResult.deleted') <
    archivedPhase.indexOf('result.skippedContacts = contactResult.skipped'),
  'partial workflow failure could publish contact counts',
)
check(
  'consumer no longer performs the three foreign writes directly',
  !consumer.includes('UPDATE "Chat" SET "contactId" = NULL') &&
    !consumer.includes('UPDATE "tasks" SET "contactId" = NULL') &&
    !consumer.includes('DELETE FROM "Contact"') &&
    !consumer.includes('prisma.contact.delete'),
  'direct foreign archived-contact write remains',
)
check(
  'owner commands and two direct Operations dependencies are exact',
  amendment.amendments?.length === 4 &&
    amendment.amendments[0].context === 'messaging' &&
    JSON.stringify(amendment.amendments[0].add_commands) === JSON.stringify(['DetachContactConversationsCommand.v1']) &&
    amendment.amendments[1].context === 'work_management' &&
    JSON.stringify(amendment.amendments[1].add_commands) === JSON.stringify(['DetachContactTasksCommand.v1']) &&
    amendment.amendments[2].context === 'contacts' &&
    JSON.stringify(amendment.amendments[2].add_commands) === JSON.stringify(['DeleteContactForRetentionCommand.v1']) &&
    amendment.amendments[3].context === 'operations_observability' &&
    JSON.stringify(amendment.amendments[3].add_allowed_dependencies) === JSON.stringify([
      { context: 'work_management', surface: 'work_management.public' },
      { context: 'contacts', surface: 'contacts.public' },
    ]),
  'manifest amendment widened or drifted',
)
check(
  'accepted archived-contact evidence stays bound to the event-retention parent',
  policy.manifest_amendments.includes(amendmentPath) &&
    migration.base_commit === 'fb16db6ef7759c4a1bd73e0012485a5e6777a03a' &&
    migration.enforcement?.before === 1429 &&
    migration.enforcement?.after === 1419 &&
    migration.enforcement?.direct_before === 99 &&
    migration.enforcement?.direct_after === 96 &&
    migration.enforcement?.undeclared_dependency_before === 377 &&
    migration.enforcement?.undeclared_dependency_after === 370,
  'accepted archived-contact evidence identity drift',
)
check(
  'exact three writes and seven redundant dependency findings retire with no new capacity',
  (registry.summary?.direct_foreign_prisma_write ?? 0) <= 96 &&
    (registry.summary?.undeclared_dependency ?? 0) <= 370 &&
    registry.exceptions.length <= 1419 &&
    [
      'arch_268626904318c85d53361d4e',
      'arch_76d3bcc4d7b0267149f18cf2',
      'arch_b5f33a4a29e14f22da9a05ec',
      'arch_2f0731db82ab64962a25bd42',
      'arch_3afb0d0704ed7e43a95d098b',
      'arch_4a9d0523cce679b947b0263d',
      'arch_63ba5b4a4669d613e6cd16f1',
      'arch_7650208958f7be1610e5230d',
      'arch_9310b6d863a190924cf95bd2',
      'arch_f04a8b9f2910b9c345227d1f',
    ].every(fingerprint => !registry.exceptions.some(entry => entry.fingerprint === fingerprint)) &&
    !registry.exceptions.some(entry =>
      entry.file === 'gravity-mvp/src/lib/RetentionCleanup.ts' || entry.file.includes('contact-retention'),
    ) &&
    (registry.exceptions.length === 0 || [
      'gravity-mvp/src/app/api/cron/auto-close-tasks/route.ts',
      'gravity-mvp/src/app/api/cron/sla-escalation/route.ts',
      'gravity-mvp/src/app/api/health/route.ts',
      'gravity-mvp/src/app/api/cron/enforce-followup/route.ts',
      'gravity-mvp/src/app/monitoring/system-health/actions.ts',
      'gravity-mvp/src/app/api/cron/pattern-alerts/route.ts',
      'gravity-mvp/src/app/api/cron/escalations/route.ts',
    ].every(file => registry.exceptions.some(entry =>
      entry.file === file && entry.rule === 'non_public_cross_context_import',
    ))),
  'registry delta, owner classification, or retained non-public protection drift',
)

process.stdout.write(`${JSON.stringify({
  status: failures.length > 0 ? 'FAIL' : 'PASS',
  checks,
  failures,
}, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
