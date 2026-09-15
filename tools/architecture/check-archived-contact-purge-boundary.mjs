#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
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
const contactServicePath = 'gravity-mvp/src/lib/ContactService.ts'
const contactsOwnershipPortPath = 'gravity-mvp/src/modules/contacts/internal/contact-ownership-persistence-ports.ts'
const legacyContactsRetentionAdapterPath = 'gravity-mvp/src/modules/contacts/public/v1/legacy-prisma-contact-retention-adapter.ts'
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
    adapterModule: '../internal/contact-ownership-persistence-ports',
    factory: 'createDeleteContactForRetentionHandlerV1',
    adapter: 'contactOwnershipRetentionPortV1',
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
    command: 'DELETE_CONTACT_FOR_RETENTION_COMMAND_V1',
    commandIdentity: 'contacts.DeleteContactForRetentionCommand.v1',
    portMethod: 'deleteContactForRetention',
    portType: 'ContactRetentionPersistencePortV1',
    portSignature: "deleteContactForRetention(contactId:string):Promise<'deleted'|'missing'|'ineligible'>",
    result: 'DELETE_CONTACT_FOR_RETENTION_RESULT_V1',
    resultIdentity: 'contacts.DeleteContactForRetentionResult.v1',
    revalidatesEligibility: true,
    contractModule: '../../../../contracts/contacts/v1',
    contractPath: 'gravity-mvp/src/contracts/contacts/v1/contact-retention-command.ts',
    parserDigest: 'bc5a7f1e6d4e3737c0e83324e02a0287c4f6767cb68eb2fcf6851a80baaf4043',
    eligibilityError: 'ContactRetentionEligibilityChangedError',
    eligibilityErrorDigest: '8a0a7185e95605ce2a4cd2a77c44bc7fdaedda5f8ee1578a1f7fa53a6cd395a5',
    eligibilityConstant: 'CONTACT_RETENTION_ELIGIBILITY_CHANGED_V1',
    eligibilityIdentity: 'CONTACT_RETENTION_ELIGIBILITY_CHANGED',
    commandType: 'DeleteContactForRetentionCommandV1',
    resultType: 'DeleteContactForRetentionResultV1',
  },
  {
    file: 'gravity-mvp/src/modules/messaging/public/v1/contact-retention-handler.ts',
    factory: 'createDetachContactConversationsHandlerV1',
    inner: 'detachContactConversationsV1',
    parser: 'parseDetachContactConversationsCommandV1',
    command: 'DETACH_CONTACT_CONVERSATIONS_COMMAND_V1',
    commandIdentity: 'messaging.DetachContactConversationsCommand.v1',
    portMethod: 'detachContactConversations',
    portType: 'ContactConversationRetentionPersistencePortV1',
    portSignature: 'detachContactConversations(contactId:string):Promise<void>',
    result: 'DETACH_CONTACT_CONVERSATIONS_RESULT_V1',
    resultIdentity: 'messaging.DetachContactConversationsResult.v1',
    contractModule: '../../../../contracts/messaging/v1',
    contractPath: 'gravity-mvp/src/contracts/messaging/v1/contact-retention-command.ts',
    parserDigest: '70c08915f54a1ec1d9684c321fd80f09ebf188c52189c8eef77ad493af99264f',
    commandType: 'DetachContactConversationsCommandV1',
    resultType: 'DetachContactConversationsResultV1',
  },
  {
    file: 'gravity-mvp/src/modules/work-management/public/v1/contact-retention-handler.ts',
    factory: 'createDetachContactTasksHandlerV1',
    inner: 'detachContactTasksV1',
    parser: 'parseDetachContactTasksCommandV1',
    command: 'DETACH_CONTACT_TASKS_COMMAND_V1',
    commandIdentity: 'work_management.DetachContactTasksCommand.v1',
    portMethod: 'detachContactTasks',
    portType: 'ContactTaskRetentionPersistencePortV1',
    portSignature: 'detachContactTasks(contactId:string):Promise<void>',
    result: 'DETACH_CONTACT_TASKS_RESULT_V1',
    resultIdentity: 'work_management.DetachContactTasksResult.v1',
    contractModule: '../../../../contracts/work-management/v1',
    contractPath: 'gravity-mvp/src/contracts/work-management/v1/contact-retention-command.ts',
    parserDigest: '0a50ac47e21bb06d10ace72fd8ee4fc89dce2bda4f0346d77776604c8a007647',
    commandType: 'DetachContactTasksCommandV1',
    resultType: 'DetachContactTasksResultV1',
  },
]
const literalRetentionAdapterSpecs = [
  {
    file: 'gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-contact-retention-adapter.ts',
    adapter: 'legacyPrismaContactConversationRetentionPortV1',
    portType: 'ContactConversationRetentionPersistencePortV1',
    method: 'detachContactConversations',
    sql: 'UPDATE "Chat" SET "contactId" = NULL, "contactIdentityId" = NULL WHERE "contactId" = $1',
  },
  {
    file: 'gravity-mvp/src/modules/work-management/public/v1/legacy-prisma-contact-retention-adapter.ts',
    adapter: 'legacyPrismaContactTaskRetentionPortV1',
    portType: 'ContactTaskRetentionPersistencePortV1',
    method: 'detachContactTasks',
    sql: 'UPDATE "tasks" SET "contactId" = NULL WHERE "contactId" = $1',
  },
]
const sourceFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(directory, entry.name)
  if (entry.isDirectory()) return sourceFiles(file)
  return /\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : []
})
const repositorySources = new Map(sourceFiles(sourceRoot).map((file) => [file, read(file)]))
const parseCache = new Map()
const parse = (file, source) => {
  let sources = parseCache.get(file)
  if (!sources) {
    sources = new Map()
    parseCache.set(file, sources)
  }
  if (!sources.has(source)) {
    const scriptKind = file.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : /\.(?:js|mjs|cjs)$/.test(file) ? ts.ScriptKind.JS
        : file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    sources.set(source, ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind))
  }
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
const isRuntimeIdentifier = (node) => {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current) || ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) {
      return false
    }
    if (ts.isImportDeclaration(current)) {
      const clause = current.importClause
      const specifier = node.parent && ts.isImportSpecifier(node.parent) ? node.parent : null
      return !(clause?.isTypeOnly || specifier?.isTypeOnly)
    }
    if (ts.isExportDeclaration(current)) {
      const specifier = node.parent && ts.isExportSpecifier(node.parent) ? node.parent : null
      return !(current.isTypeOnly || specifier?.isTypeOnly)
    }
    if (ts.isSourceFile(current)) break
  }
  return true
}
const staticStringBindings = (sourceFile) => {
  const bindings = new Map()
  walk(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer
      || !ts.isVariableDeclarationList(node.parent)
      || (node.parent.flags & ts.NodeFlags.Const) === 0) return
    bindings.set(node.name.text, node.initializer)
  })
  return bindings
}
const staticStringValue = (node, bindings, seen = new Set()) => {
  const current = unwrap(node)
  if (!current) return null
  if (ts.isStringLiteralLike(current)) return current.text
  if (ts.isIdentifier(current) && bindings.has(current.text) && !seen.has(current.text)) {
    return staticStringValue(bindings.get(current.text), bindings, new Set([...seen, current.text]))
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(current.left, bindings, seen)
    const right = staticStringValue(current.right, bindings, seen)
    return left === null || right === null ? null : left + right
  }
  if (ts.isTemplateExpression(current)) {
    let value = current.head.text
    for (const span of current.templateSpans) {
      const expression = staticStringValue(span.expression, bindings, seen)
      if (expression === null) return null
      value += expression + span.literal.text
    }
    return value
  }
  return null
}
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
const allNamedExports = (sourceFile) => {
  const records = []
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier
      || statement.isTypeOnly
      || !ts.isStringLiteralLike(statement.moduleSpecifier) || !statement.exportClause
      || !ts.isNamedExports(statement.exportClause)) continue
    for (const binding of statement.exportClause.elements) if (!binding.isTypeOnly) records.push({
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
  const matchingAdapterBindings = adapterBindings.filter(binding => (
    binding.imported === spec.adapter && binding.local === spec.adapter
  ))
  const publicBindings = staticNamedBindings(publicIndex, 'export', spec.applicationModule)
  const locals = declarationsNamed(application, spec.local)
  const wrappers = declarationsNamed(application, spec.operation)
  if (locals.length !== 1 || wrappers.length !== 1) return false
  const localStatement = locals[0].parent.parent
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
  const adapterTarget = path.join(path.dirname(spec.applicationPath), spec.adapterModule)
  return ts.isVariableStatement(localStatement) && !hasExport(localStatement)
    && factoryBindings.filter(binding => binding.imported === spec.factory && binding.local === spec.factory).length === 1
    && matchingAdapterBindings.length === 1
    && publicBindings.filter(binding => binding.imported === spec.operation && binding.local === spec.operation).length === 1
    && adapterCalls.length === 1 && adapterCalls[0] === factoryCall && adapterIdentifiers === 2
    && localCalls.length === 1 && localCalls[0] === body
    && !exposedModules.some(module => resolvesToSourceModule(spec.indexPath, module, adapterTarget))
}
const exactRuntimeConsumers = (sources) => {
  const operations = new Set(Object.keys(consumerModules))
  const records = []
  const exports = []
  const callFiles = new Map([...operations].map(operation => [operation, []]))
  const occurrenceFiles = new Map([...operations].map(operation => [operation, []]))
  let propertyBypasses = 0
  for (const [file, source] of sources) {
    if (![...operations].some(operation => source.includes(operation))) continue
    const sourceFile = parse(file, source)
    const stringBindings = staticStringBindings(sourceFile)
    for (const binding of [...allNamedImports(sourceFile), ...dynamicNamedImports(sourceFile)]) {
      if (operations.has(binding.imported)) records.push({ file, ...binding })
    }
    for (const binding of allNamedExports(sourceFile)) {
      if (operations.has(binding.imported)) exports.push({ file, ...binding })
    }
    walk(sourceFile, (node) => {
      const runtimeComputedName = ts.isStringLiteralLike(node) && (
        (ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node)
          || (ts.isBindingElement(node.parent) && node.parent.propertyName === node)
      )
      if (((ts.isIdentifier(node) && isRuntimeIdentifier(node)) || runtimeComputedName) && operations.has(node.text)) {
        occurrenceFiles.get(node.text).push(file)
      }
      if (ts.isPropertyAccessExpression(node) && operations.has(node.name.text)) propertyBypasses += 1
      if (ts.isElementAccessExpression(node) && node.argumentExpression
        && operations.has(staticStringValue(node.argumentExpression, stringBindings))) propertyBypasses += 1
      if (ts.isCallExpression(node) && ts.isIdentifier(unwrap(node.expression))
        && operations.has(unwrap(node.expression).text)) callFiles.get(unwrap(node.expression).text).push(file)
    })
  }
  const consumerFile = parse(consumerPath, sources.get(consumerPath) ?? '')
  const dynamicImportCountsFor = spec => spec.operation === 'deleteContactForRetentionV1'
    ? { 'gravity-mvp/src/instrumentation.ts': 1 }
    : spec.operation === 'detachContactConversationsV1'
      ? { 'gravity-mvp/src/instrumentation.ts': 5 }
      : {}
  const parentPublicIndexFor = spec => path.join(path.dirname(spec.indexPath), '..', 'index.ts')
  const moduleIndexFor = spec => path.join(path.dirname(parentPublicIndexFor(spec)), '..', 'index.ts')
  const moduleNamespaceFor = spec => spec.operation === 'deleteContactForRetentionV1'
    ? 'ContactsPublic'
    : spec.operation === 'detachContactConversationsV1' ? 'MessagingPublic' : 'WorkManagementPublic'
  const broadRuntimeExposure = compositionSpecs.some(spec => (
    unsafeBroadRuntimeReferencesTo(sources, spec.indexPath, {
      allowedDynamicImportCounts: dynamicImportCountsFor(spec),
      allowedStarExporter: parentPublicIndexFor(spec),
    }).length > 0
      || unsafeBroadRuntimeReferencesTo(sources, parentPublicIndexFor(spec), {
        allowedNamespaceExporter: moduleIndexFor(spec),
        allowedNamespaceName: moduleNamespaceFor(spec),
      }).length > 0
      || unsafeBroadRuntimeReferencesTo(sources, moduleIndexFor(spec)).length > 0
      || unsafeBroadRuntimeReferencesTo(sources, spec.applicationPath).length > 0
  ))
  const exactOccurrences = compositionSpecs.every((spec) => {
    const handler = handlerSpecs.find(candidate => candidate.factory === spec.factory)
    const expected = new Map([
      [consumerPath, 2],
      [spec.applicationPath, 1],
      [spec.indexPath, 1],
      [handler?.file, 1],
    ])
    const actual = occurrenceFiles.get(spec.operation)
    return actual.length === 5 && [...expected].every(([file, count]) => (
      file && actual.filter(candidate => candidate === file).length === count
    ))
  })
  if (process.env.YOKO_DEBUG_ARCHIVED_CONTACT_BOUNDARY === '1' && sources === repositorySources) {
    process.stderr.write(`${JSON.stringify({
      runtimeRecords: records,
      runtimeExports: exports,
      runtimeCalls: Object.fromEntries(callFiles),
      propertyBypasses,
      broadReferences: compositionSpecs.flatMap(spec => [
        ...unsafeBroadRuntimeReferencesTo(sources, spec.indexPath, {
          allowedDynamicImportCounts: dynamicImportCountsFor(spec),
          allowedStarExporter: parentPublicIndexFor(spec),
        }),
        ...unsafeBroadRuntimeReferencesTo(sources, parentPublicIndexFor(spec), {
          allowedNamespaceExporter: moduleIndexFor(spec),
          allowedNamespaceName: moduleNamespaceFor(spec),
        }),
        ...unsafeBroadRuntimeReferencesTo(sources, moduleIndexFor(spec)),
        ...unsafeBroadRuntimeReferencesTo(sources, spec.applicationPath),
      ]),
    })}\n`)
  }
  return consumerFile.parseDiagnostics.length === 0 && propertyBypasses === 0
    && exactAdmittedDynamicPublicImports(sources)
    && exactCanonicalPublicNamespaceBarrels(sources)
    && !broadRuntimeExposure && exactOccurrences
    && [...operations].every((operation) => {
      const matching = records.filter(record => record.imported === operation)
      const matchingExports = exports.filter(record => record.imported === operation)
      const spec = compositionSpecs.find(candidate => candidate.operation === operation)
      let calls = 0
      walk(consumerFile, (node) => {
        if (ts.isCallExpression(node) && isIdentifier(node.expression, operation)) calls += 1
      })
      return matching.length === 1 && matching[0].file === consumerPath
        && matching[0].module === consumerModules[operation] && matching[0].local === operation
        && spec && matchingExports.length === 1 && matchingExports[0].file === spec.indexPath
        && matchingExports[0].module === spec.applicationModule && matchingExports[0].local === operation
        && calls === 1 && callFiles.get(operation).length === 1 && callFiles.get(operation)[0] === consumerPath
    })
}
const exactPrivateCompositionConsumers = (sources) => compositionSpecs.every((spec) => {
  const records = []
  for (const [file, source] of sources) {
    if (!source.includes(spec.adapter) && !source.includes(spec.factory)) continue
    const sourceFile = parse(file, source)
    for (const binding of [...allNamedImports(sourceFile), ...dynamicNamedImports(sourceFile)]) {
      if (binding.imported === spec.adapter || binding.imported === spec.factory) {
        records.push({ file, direction: 'import', ...binding })
      }
    }
    for (const binding of allNamedExports(sourceFile)) {
      if (binding.imported === spec.adapter || binding.imported === spec.factory) {
        records.push({ file, direction: 'export', ...binding })
      }
    }
  }
  const handlerTarget = path.join(path.dirname(spec.applicationPath), spec.handlerModule)
  const adapterTarget = path.join(path.dirname(spec.applicationPath), spec.adapterModule)
  const adapterRecords = records.filter(record => record.imported === spec.adapter)
  const factoryImports = records.filter(record => (
    record.imported === spec.factory && record.direction === 'import'
  ))
  const factoryExports = records.filter(record => (
    record.imported === spec.factory && record.direction === 'export'
  ))
  return unsafeBroadRuntimeReferencesTo(sources, handlerTarget).length === 0
    && unsafeBroadRuntimeReferencesTo(sources, adapterTarget).length === 0
    && adapterRecords.length === 1 && adapterRecords[0].direction === 'import'
    && adapterRecords[0].file === spec.applicationPath
    && adapterRecords[0].module === spec.adapterModule && adapterRecords[0].local === spec.adapter
    && factoryImports.length === 1 && factoryImports[0].file === spec.applicationPath
    && factoryImports[0].module === spec.handlerModule && factoryImports[0].local === spec.factory
    && factoryExports.length === 1 && factoryExports[0].file === spec.indexPath
    && resolvesToSourceModule(factoryExports[0].file, factoryExports[0].module, handlerTarget)
    && factoryExports[0].local === spec.factory
})
const exactHandler = (source, spec) => {
  const sourceFile = parse(spec.file, source)
  if (sourceFile.parseDiagnostics.length || sourceFile.statements.length !== 3) return false
  const contractImport = sourceFile.statements[0]
  if (!ts.isImportDeclaration(contractImport) || !ts.isStringLiteralLike(contractImport.moduleSpecifier)
    || contractImport.moduleSpecifier.text !== spec.contractModule || !contractImport.importClause
    || contractImport.importClause.isTypeOnly || contractImport.importClause.name
    || !contractImport.importClause.namedBindings
    || !ts.isNamedImports(contractImport.importClause.namedBindings)) return false
  const expectedValueImports = new Set([
    spec.result,
    spec.parser,
    ...(spec.eligibilityError ? [spec.eligibilityError] : []),
  ])
  const expectedTypeImports = new Set([spec.commandType, spec.resultType])
  const contractBindings = contractImport.importClause.namedBindings.elements
  if (contractBindings.length !== expectedValueImports.size + expectedTypeImports.size
    || contractBindings.some(binding => binding.propertyName
      || binding.name.text !== (binding.propertyName?.text ?? binding.name.text)
      || (binding.isTypeOnly ? !expectedTypeImports.has(binding.name.text) : !expectedValueImports.has(binding.name.text)))) {
    return false
  }
  if ([...expectedValueImports].some(name => contractBindings.filter(binding => (
    !binding.isTypeOnly && binding.name.text === name
  )).length !== 1) || [...expectedTypeImports].some(name => contractBindings.filter(binding => (
    binding.isTypeOnly && binding.name.text === name
  )).length !== 1)) return false
  const portInterface = sourceFile.statements[1]
  if (!ts.isInterfaceDeclaration(portInterface) || portInterface.modifiers?.length !== 1
    || !hasExport(portInterface) || portInterface.name.text !== spec.portType
    || portInterface.typeParameters?.length || portInterface.heritageClauses?.length
    || portInterface.members.length !== 1
    || compactNode(portInterface.members[0], sourceFile) !== spec.portSignature) return false
  const factories = sourceFile.statements.filter(statement => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === spec.factory && hasExport(statement)
  ))
  if (factories.length !== 1 || factories[0].asteriskToken || factories[0].modifiers?.length !== 1
    || !factories[0].body || factories[0].parameters.length !== 1
    || !isIdentifier(factories[0].parameters[0].name, 'port') || factories[0].parameters[0].dotDotDotToken
    || factories[0].parameters[0].initializer || factories[0].parameters[0].questionToken
    || !factories[0].parameters[0].type || !ts.isTypeReferenceNode(factories[0].parameters[0].type)
    || !isIdentifier(factories[0].parameters[0].type.typeName, spec.portType)
    || factories[0].body.statements.length !== 1) return false
  const returns = factories[0].body.statements.filter(ts.isReturnStatement)
  const inner = returns.length === 1 ? unwrap(returns[0].expression) : null
  if (!inner || !ts.isFunctionExpression(inner) || inner.asteriskToken
    || inner.modifiers?.length !== 1
    || !inner.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    || inner.name?.text !== spec.inner || inner.parameters.length !== 1
    || !isIdentifier(inner.parameters[0].name, 'command') || inner.parameters[0].dotDotDotToken
    || inner.parameters[0].initializer || inner.parameters[0].questionToken || !inner.body
    || !inner.parameters[0].type || !inner.type
    || compactNode(inner.parameters[0].type, sourceFile) !== `${spec.commandType}|unknown`
    || compactNode(inner.type, sourceFile) !== `Promise<${spec.resultType}>`
    || inner.body.statements.length !== (spec.revalidatesEligibility ? 4 : 3)) return false
  const [parseStatement, portStatement] = inner.body.statements
  if (!ts.isVariableStatement(parseStatement) || parseStatement.declarationList.declarations.length !== 1) return false
  const parsedDeclaration = parseStatement.declarationList.declarations[0]
  const parseCall = unwrap(parsedDeclaration.initializer)
  if (!isIdentifier(parsedDeclaration.name, 'parsed') || !parseCall || !ts.isCallExpression(parseCall)
    || !isIdentifier(parseCall.expression, spec.parser) || parseCall.arguments.length !== 1
    || !isIdentifier(parseCall.arguments[0], 'command')) return false
  const outcomeDeclaration = spec.revalidatesEligibility && ts.isVariableStatement(portStatement)
    && portStatement.declarationList.declarations.length === 1
    && (portStatement.declarationList.flags & ts.NodeFlags.Const) !== 0
    ? portStatement.declarationList.declarations[0] : null
  const portExpression = outcomeDeclaration?.initializer
    ?? (ts.isExpressionStatement(portStatement) ? portStatement.expression : null)
  const awaited = portExpression && ts.isAwaitExpression(unwrap(portExpression))
    ? unwrap(portExpression).expression : null
  const portCall = unwrap(awaited)
  if (!portCall || !ts.isCallExpression(portCall) || portCall.questionDotToken
    || !ts.isPropertyAccessExpression(unwrap(portCall.expression))
    || unwrap(portCall.expression).questionDotToken
    || !isIdentifier(unwrap(portCall.expression).expression, 'port')
    || unwrap(portCall.expression).name.text !== spec.portMethod || portCall.arguments.length !== 1
    || !ts.isPropertyAccessExpression(unwrap(portCall.arguments[0]))
    || !isIdentifier(unwrap(portCall.arguments[0]).expression, 'parsed')
    || unwrap(portCall.arguments[0]).name.text !== 'contactId') return false
  if (spec.revalidatesEligibility) {
    if (!outcomeDeclaration || !isIdentifier(outcomeDeclaration.name, 'outcome')) return false
    const eligibilityBindings = staticNamedBindings(sourceFile, 'import', spec.contractModule)
      .filter(binding => binding.imported === spec.eligibilityError && binding.local === spec.eligibilityError)
    const eligibility = inner.body.statements[2]
    const condition = ts.isIfStatement(eligibility) ? unwrap(eligibility.expression) : null
    const thrown = ts.isIfStatement(eligibility) && !eligibility.elseStatement
      && ts.isThrowStatement(eligibility.thenStatement)
      ? unwrap(eligibility.thenStatement.expression) : null
    if (eligibilityBindings.length !== 1 || !condition || !ts.isBinaryExpression(condition)
      || condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
      || !isIdentifier(condition.left, 'outcome') || !ts.isStringLiteralLike(unwrap(condition.right))
      || unwrap(condition.right).text !== 'ineligible'
      || !thrown || !ts.isNewExpression(thrown) || !isIdentifier(thrown.expression, spec.eligibilityError)
      || (thrown.arguments?.length ?? 0) !== 0) return false
  }
  const resultStatement = inner.body.statements[spec.revalidatesEligibility ? 3 : 2]
  const result = ts.isReturnStatement(resultStatement) ? unwrap(resultStatement.expression) : null
  if (!result || !ts.isObjectLiteralExpression(result) || result.properties.length !== 2) return false
  const contract = result.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === 'contract')
  const completed = result.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === 'completed')
  return Boolean(contract && completed && isIdentifier(contract.initializer, spec.result)
    && completed.initializer.kind === ts.SyntaxKind.TrueKeyword)
}
const exactLiteralRetentionAdapter = (source, spec) => {
  const sourceFile = parse(spec.file, source)
  if (sourceFile.parseDiagnostics.length || sourceFile.statements.length !== 3) return false
  const [prismaImport, portImport, adapterStatement] = sourceFile.statements
  const exactNamedImport = (statement, moduleName, imported, typeOnly) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== moduleName || !statement.importClause
      || statement.importClause.isTypeOnly !== typeOnly || statement.importClause.name
      || !statement.importClause.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)
      || statement.importClause.namedBindings.elements.length !== 1) return false
    const binding = statement.importClause.namedBindings.elements[0]
    return !binding.propertyName && !binding.isTypeOnly && binding.name.text === imported
  }
  if (!exactNamedImport(prismaImport, '@/lib/prisma', 'prisma', false)
    || !exactNamedImport(portImport, './contact-retention-handler', spec.portType, true)
    || !ts.isVariableStatement(adapterStatement) || !hasExport(adapterStatement)
    || adapterStatement.modifiers?.length !== 1
    || adapterStatement.declarationList.declarations.length !== 1
    || (adapterStatement.declarationList.flags & ts.NodeFlags.Const) === 0) return false
  const declaration = adapterStatement.declarationList.declarations[0]
  const initializer = unwrap(declaration.initializer)
  if (!isIdentifier(declaration.name, spec.adapter) || !declaration.type
    || !ts.isTypeReferenceNode(declaration.type) || !isIdentifier(declaration.type.typeName, spec.portType)
    || !initializer || !ts.isObjectLiteralExpression(initializer) || initializer.properties.length !== 1) return false
  const method = initializer.properties[0]
  if (!ts.isMethodDeclaration(method) || method.asteriskToken || method.name.getText(sourceFile) !== spec.method
    || method.modifiers?.length !== 1
    || method.modifiers[0].kind !== ts.SyntaxKind.AsyncKeyword
    || method.parameters.length !== 1 || !isIdentifier(method.parameters[0].name, 'contactId')
    || method.parameters[0].dotDotDotToken || method.parameters[0].initializer
    || method.parameters[0].questionToken || method.typeParameters?.length || method.body?.statements.length !== 1) return false
  const statement = method.body.statements[0]
  const awaited = ts.isExpressionStatement(statement) && ts.isAwaitExpression(unwrap(statement.expression))
    ? unwrap(statement.expression) : null
  const call = awaited ? unwrap(awaited.expression) : null
  const callee = call && ts.isCallExpression(call) ? unwrap(call.expression) : null
  return Boolean(call && ts.isCallExpression(call) && !call.questionDotToken && !call.typeArguments?.length
    && callee && ts.isPropertyAccessExpression(callee) && !callee.questionDotToken
    && propertyChain(callee) === 'prisma.$executeRawUnsafe' && call.arguments.length === 2
    && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === spec.sql
    && isIdentifier(call.arguments[1], 'contactId'))
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
const exactOwnerCommand = (statement, sourceFile, operation, contract) => {
  const awaitExpression = ts.isExpressionStatement(statement) && ts.isAwaitExpression(unwrap(statement.expression))
    ? unwrap(statement.expression) : null
  const call = awaitExpression ? unwrap(awaitExpression.expression) : null
  if (!call || !ts.isCallExpression(call) || call.questionDotToken || !isIdentifier(call.expression, operation)
    || call.arguments.length !== 1 || !ts.isObjectLiteralExpression(unwrap(call.arguments[0]))) return false
  const fields = unwrap(call.arguments[0]).properties
  if (fields.length !== 2 || !fields.every(ts.isPropertyAssignment)) return false
  const values = Object.fromEntries(fields.map(field => [field.name.getText(sourceFile), unwrap(field.initializer)]))
  return Object.keys(values).length === 2
    && isIdentifier(values.contract, contract) && isIdentifier(values.contactId, 'id')
}
const exactTaggedQueryDeclaration = (statement, name) => {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1
    || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) return null
  const declaration = statement.declarationList.declarations[0]
  const initializer = unwrap(declaration.initializer)
  const tagged = initializer && ts.isAwaitExpression(initializer)
    ? unwrap(initializer.expression) : null
  return isIdentifier(declaration.name, name) && tagged && ts.isTaggedTemplateExpression(tagged)
    && propertyChain(tagged.tag) === 'prisma.$queryRaw' ? tagged : null
}
const normalizedTemplateProjection = (tagged, sourceFile) => {
  const template = tagged?.template
  if (!template) return ''
  if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text.replace(/\s+/g, ' ').trim()
  if (!ts.isTemplateExpression(template)) return ''
  let projection = template.head.text
  for (const span of template.templateSpans) {
    projection += `\${${span.expression.getText(sourceFile).trim().replace(/\s+/g, ' ')}}${span.literal.text}`
  }
  return projection.replace(/\s+/g, ' ').trim()
}
const exactCounterDeclaration = (statement, name) => {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1
    || (statement.declarationList.flags & ts.NodeFlags.Let) === 0) return false
  const declaration = statement.declarationList.declarations[0]
  return isIdentifier(declaration.name, name)
    && declaration.initializer?.kind === ts.SyntaxKind.NumericLiteral
    && declaration.initializer.text === '0'
}
const exactCounterIncrement = (statement, name) => ts.isExpressionStatement(statement)
  && ts.isPostfixUnaryExpression(unwrap(statement.expression))
  && unwrap(statement.expression).operator === ts.SyntaxKind.PlusPlusToken
  && isIdentifier(unwrap(statement.expression).operand, name)
const rejectArchivedMutationSequence = (reason) => {
  if (process.env.YOKO_DEBUG_ARCHIVED_CONTACT_BOUNDARY === '1') {
    process.stderr.write(`archived mutation sequence rejected: ${reason}\n`)
  }
  return false
}
const exactArchivedMutationSequence = (source) => {
  const sourceFile = parse(consumerPath, source)
  if (sourceFile.parseDiagnostics.length) return rejectArchivedMutationSequence('parse diagnostics')
  const prismaBindings = allNamedImports(sourceFile).filter(binding => (
    binding.imported === 'prisma' || binding.local === 'prisma'
  ))
  if (prismaBindings.length !== 1 || prismaBindings[0].module !== '@/lib/prisma'
    || prismaBindings[0].imported !== 'prisma' || prismaBindings[0].local !== 'prisma') {
    return rejectArchivedMutationSequence('prisma import origin')
  }
  const retentionClasses = sourceFile.statements.filter(statement => (
    ts.isClassDeclaration(statement) && statement.name?.text === 'RetentionCleanup'
  ))
  const retentionClass = retentionClasses.length === 1 ? retentionClasses[0] : null
  const retentionMethods = retentionClass?.members.filter(member => (
    ts.isMethodDeclaration(member) && member.name.getText(sourceFile) === '_cleanupArchivedContacts'
  )) ?? []
  const method = retentionMethods.length === 1 ? retentionMethods[0] : null
  const aliasedRetentionExport = sourceFile.statements.some(statement => (
    ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)
      && statement.exportClause.elements.some(binding => binding.name.text === 'RetentionCleanup')
  ))
  if (!retentionClass || retentionClass.modifiers?.length !== 1 || !hasExport(retentionClass)
    || retentionClass.heritageClauses?.length || aliasedRetentionExport
    || !method?.body || method.asteriskToken || method.modifiers?.length !== 3
    || !method.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword)
    || !method.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)
    || !method.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    || method.parameters.length !== 3
    || !['ageDays', 'limit', 'dryRun'].every((name, index) => isIdentifier(method.parameters[index].name, name))
    || method.parameters.some(parameter => (
      parameter.dotDotDotToken || parameter.questionToken || parameter.initializer
    ))
    || method.parameters[0].type?.kind !== ts.SyntaxKind.NumberKeyword
    || method.parameters[1].type?.kind !== ts.SyntaxKind.NumberKeyword
    || method.parameters[2].type?.kind !== ts.SyntaxKind.BooleanKeyword
    || method.body.statements.length !== 6) return rejectArchivedMutationSequence('method shape')
  const [candidateStatement, emptyStatement, deletedStatement, skippedStatement, loop, resultStatement] = method.body.statements
  const candidateQuery = exactTaggedQueryDeclaration(candidateStatement, 'candidates')
  if (!candidateQuery || !ts.isIfStatement(emptyStatement) || emptyStatement.elseStatement
    || emptyStatement.getText(sourceFile).replace(/\s+/g, '') !== 'if(candidates.length===0)return{deleted:0,skipped:0}'
    || !exactCounterDeclaration(deletedStatement, 'deleted')
    || !exactCounterDeclaration(skippedStatement, 'skipped')
    || !ts.isForOfStatement(loop) || loop.awaitModifier || !ts.isVariableDeclarationList(loop.initializer)
    || (loop.initializer.flags & ts.NodeFlags.Const) === 0
    || loop.initializer.declarations.length !== 1 || loop.initializer.declarations[0].initializer
    || !ts.isObjectBindingPattern(loop.initializer.declarations[0].name)
    || loop.initializer.declarations[0].name.elements.length !== 1
    || loop.initializer.declarations[0].name.elements[0].propertyName
    || loop.initializer.declarations[0].name.elements[0].dotDotDotToken
    || loop.initializer.declarations[0].name.elements[0].initializer
    || !isIdentifier(loop.initializer.declarations[0].name.elements[0].name, 'id')
    || !isIdentifier(loop.expression, 'candidates') || !ts.isBlock(loop.statement)
    || loop.statement.statements.length !== 5
    || resultStatement.getText(sourceFile).replace(/\s+/g, '') !== 'return{deleted,skipped}') {
    return rejectArchivedMutationSequence('outer statement shape')
  }
  const [dependencyStatement, depStatement, dependencySkip, dryRunStatement, deletedIncrement] = loop.statement.statements
  const dependencyQuery = exactTaggedQueryDeclaration(dependencyStatement, 'deps')
  if (!dependencyQuery) return rejectArchivedMutationSequence('dependency query shape')
  const candidateSql = 'SELECT id FROM "Contact" WHERE "isArchived" = true AND "updatedAt" < '
    + "(NOW() AT TIME ZONE 'UTC') - CAST(${ageDays + ' days'} AS INTERVAL) "
    + 'ORDER BY "updatedAt" ASC LIMIT ${limit}'
  const dependencySql = 'SELECT '
    + '(SELECT count(*)::int FROM "Chat" WHERE "contactId" = ${id} AND status != \'resolved\') as "activeChats", '
    + '(SELECT count(*)::int FROM "Message" m JOIN "Chat" c ON c.id = m."chatId" '
    + 'WHERE c."contactId" = ${id} AND m."sentAt" > '
    + "(NOW() AT TIME ZONE 'UTC') - INTERVAL '30 days') as \"recentMessages\", "
    + '(SELECT count(*)::int FROM "ContactMerge" WHERE "survivorId" = ${id} '
    + 'OR "mergedId" = ${id}) as "merges"'
  if (normalizedTemplateProjection(candidateQuery, sourceFile) !== candidateSql
    || normalizedTemplateProjection(dependencyQuery, sourceFile) !== dependencySql) {
    return rejectArchivedMutationSequence('read SQL body')
  }
  if (depStatement.getText(sourceFile).replace(/\s+/g, '') !== 'constdep=deps[0]') {
    return rejectArchivedMutationSequence('dependency row shape')
  }
  if (dependencySkip.getText(sourceFile).replace(/\s+/g, '')
    !== 'if(dep.activeChats>0||dep.recentMessages>0||dep.merges>0){skipped++continue}') {
    return rejectArchivedMutationSequence('dependency skip shape')
  }
  if (!exactCounterIncrement(deletedIncrement, 'deleted')) {
    return rejectArchivedMutationSequence('deleted counter shape')
  }
  const requiredContractImports = new Map([
    ['CONTACT_RETENTION_ELIGIBILITY_CHANGED_V1', '@/contracts/contacts/v1'],
    ['DELETE_CONTACT_FOR_RETENTION_COMMAND_V1', '@/contracts/contacts/v1'],
    ['DETACH_CONTACT_CONVERSATIONS_COMMAND_V1', '@/contracts/messaging/v1'],
    ['DETACH_CONTACT_TASKS_COMMAND_V1', '@/contracts/work-management/v1'],
  ])
  const contractImports = allNamedImports(sourceFile).filter(binding => (
    requiredContractImports.has(binding.imported) || requiredContractImports.has(binding.local)
  ))
  if (contractImports.length !== requiredContractImports.size
    || contractImports.some(binding => binding.imported !== binding.local
      || requiredContractImports.get(binding.imported) !== binding.module)) {
    return rejectArchivedMutationSequence('owner contract imports')
  }
  let directMutation = false
  const calls = []
  const taggedQueries = []
  walk(method.body, (node) => {
    if (ts.isCallExpression(node)) {
      calls.push(node)
      const expression = unwrap(node.expression)
      if (ts.isPropertyAccessExpression(expression)) {
        const chain = propertyChain(expression)
        if (/^(?:create|createMany|update|updateMany|upsert|delete|deleteMany)$/.test(expression.name.text)
          || chain === 'prisma.$executeRaw' || chain === 'prisma.$executeRawUnsafe'
          || chain === 'prisma.$queryRaw' || chain === 'prisma.$queryRawUnsafe') directMutation = true
      }
    }
    if (ts.isTaggedTemplateExpression(node)) {
      const chain = propertyChain(node.tag)
      if (chain === 'prisma.$queryRaw') taggedQueries.push(node)
      else directMutation = true
    }
  })
  if (directMutation || calls.length !== 3 || taggedQueries.length !== 2
    || taggedQueries[0] !== candidateQuery || taggedQueries[1] !== dependencyQuery) {
    return rejectArchivedMutationSequence('call or query inventory')
  }
  if (!ts.isIfStatement(dryRunStatement) || dryRunStatement.elseStatement
    || !ts.isPrefixUnaryExpression(unwrap(dryRunStatement.expression))
    || unwrap(dryRunStatement.expression).operator !== ts.SyntaxKind.ExclamationToken
    || !isIdentifier(unwrap(dryRunStatement.expression).operand, 'dryRun')
    || !ts.isBlock(dryRunStatement.thenStatement)
    || dryRunStatement.thenStatement.statements.length !== 3) {
    return rejectArchivedMutationSequence('owner block shape')
  }
  const expected = [
    ['detachContactConversationsV1', 'DETACH_CONTACT_CONVERSATIONS_COMMAND_V1'],
    ['detachContactTasksV1', 'DETACH_CONTACT_TASKS_COMMAND_V1'],
  ]
  const foreignSequence = expected.every(([operation, contract], index) => (
    exactOwnerCommand(dryRunStatement.thenStatement.statements[index], sourceFile, operation, contract)
  ))
  const contactTry = dryRunStatement.thenStatement.statements[2]
  if (!foreignSequence || !ts.isTryStatement(contactTry) || contactTry.finallyBlock
    || contactTry.tryBlock.statements.length !== 1 || !contactTry.catchClause
    || !contactTry.catchClause.variableDeclaration
    || !isIdentifier(contactTry.catchClause.variableDeclaration.name, 'error')
    || contactTry.catchClause.variableDeclaration.type?.kind !== ts.SyntaxKind.UnknownKeyword
    || !exactOwnerCommand(
      contactTry.tryBlock.statements[0],
      sourceFile,
      'deleteContactForRetentionV1',
      'DELETE_CONTACT_FOR_RETENTION_COMMAND_V1',
    )) return rejectArchivedMutationSequence('contact owner try/catch shape')
  const catchStatements = contactTry.catchClause.block.statements
  if (catchStatements.length !== 2 || !ts.isIfStatement(catchStatements[0])
    || catchStatements[0].elseStatement || !ts.isBlock(catchStatements[0].thenStatement)
    || catchStatements[0].thenStatement.statements.length !== 2) return false
  const condition = unwrap(catchStatements[0].expression)
  const left = condition && ts.isBinaryExpression(condition) ? unwrap(condition.left) : null
  const skipped = catchStatements[0].thenStatement.statements[0]
  const continuation = catchStatements[0].thenStatement.statements[1]
  const thrown = catchStatements[1]
  const exactCatch = Boolean(condition && ts.isBinaryExpression(condition)
    && condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && left && ts.isPropertyAccessExpression(left) && left.questionDotToken
    && isIdentifier(left.expression, 'error') && left.name.text === 'code'
    && isIdentifier(condition.right, 'CONTACT_RETENTION_ELIGIBILITY_CHANGED_V1')
    && ts.isExpressionStatement(skipped) && ts.isPostfixUnaryExpression(unwrap(skipped.expression))
    && unwrap(skipped.expression).operator === ts.SyntaxKind.PlusPlusToken
    && isIdentifier(unwrap(skipped.expression).operand, 'skipped')
    && ts.isContinueStatement(continuation) && !continuation.label
    && ts.isThrowStatement(thrown) && isIdentifier(thrown.expression, 'error'))
  return exactCatch || rejectArchivedMutationSequence('eligibility catch shape')
}

const exactContactOwnershipRetentionPort = (sources) => {
  const source = sources.get(contactsOwnershipPortPath) ?? ''
  const sourceFile = parse(contactsOwnershipPortPath, source)
  if (sourceFile.parseDiagnostics.length) return false
  const contactServiceBindings = staticNamedBindings(sourceFile, 'import', '@/lib/ContactService')
    .filter(binding => binding.imported === 'ContactService' && binding.local === 'ContactService')
  const declarations = declarationsNamed(sourceFile, 'contactOwnershipRetentionPortV1')
  if (contactServiceBindings.length !== 1 || declarations.length !== 1) return false
  const declaration = declarations[0]
  const declarationList = declaration.parent
  const statement = declarationList.parent
  const initializer = unwrap(declaration.initializer)
  if (!ts.isVariableStatement(statement) || !hasExport(statement)
    || declarationList.declarations.length !== 1 || (declarationList.flags & ts.NodeFlags.Const) === 0
    || !declaration.type || !ts.isTypeReferenceNode(declaration.type)
    || !isIdentifier(declaration.type.typeName, 'ContactRetentionPersistencePortV1')
    || !initializer || !ts.isObjectLiteralExpression(initializer) || initializer.properties.length !== 1) return false
  const method = initializer.properties[0]
  if (!ts.isMethodDeclaration(method) || method.asteriskToken
    || method.name.getText(sourceFile) !== 'deleteContactForRetention'
    || !method.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    || method.modifiers.length !== 1
    || method.parameters.length !== 1 || !isIdentifier(method.parameters[0].name, 'contactId')
    || method.parameters[0].dotDotDotToken || method.parameters[0].initializer || method.parameters[0].questionToken
    || !method.body || method.body.statements.length !== 1 || !ts.isReturnStatement(method.body.statements[0])) return false
  const call = unwrap(method.body.statements[0].expression)
  const callee = call && ts.isCallExpression(call) ? unwrap(call.expression) : null
  return Boolean(call && ts.isCallExpression(call) && !call.questionDotToken
    && callee && ts.isPropertyAccessExpression(callee) && !callee.questionDotToken
    && propertyChain(callee) === 'ContactService.deleteContactForRetention'
    && !call.typeArguments?.length && call.arguments.length === 1 && isIdentifier(call.arguments[0], 'contactId'))
}

const compactNode = (node, sourceFile) => {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    sourceFile.languageVariant,
    node.getText(sourceFile),
  )
  let compact = ''
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SemicolonToken) compact += scanner.getTokenText()
  }
  return compact
}
const exactContractParser = (sources, spec) => {
  const sourceFile = parse(spec.contractPath, sources.get(spec.contractPath) ?? '')
  if (sourceFile.parseDiagnostics.length) return false
  const contractIndexPath = path.join(path.dirname(spec.contractPath), 'index.ts')
  const contractIndex = parse(contractIndexPath, sources.get(contractIndexPath) ?? '')
  const targetExports = contractIndex.statements.filter(statement => (
    ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier
      && ts.isStringLiteralLike(statement.moduleSpecifier)
      && resolvesToSourceModule(contractIndexPath, statement.moduleSpecifier.text, spec.contractPath)
  ))
  if (contractIndex.parseDiagnostics.length || targetExports.length !== 1
    || targetExports[0].exportClause || targetExports[0].moduleSpecifier.text !== './contact-retention-command') {
    return false
  }
  const protectedContractNames = new Set([
    spec.command,
    spec.result,
    spec.parser,
    spec.commandType,
    spec.resultType,
    ...(spec.eligibilityError ? [spec.eligibilityError] : []),
    ...(spec.eligibilityConstant ? [spec.eligibilityConstant] : []),
  ])
  let shadowExport = false
  walk(contractIndex, (node) => {
    if (ts.isIdentifier(node) && protectedContractNames.has(node.text)) shadowExport = true
    if (ts.isStringLiteralLike(node) && ts.isExportSpecifier(node.parent)
      && node.parent.name === node && protectedContractNames.has(node.text)) shadowExport = true
  })
  if (shadowExport) return false
  const exactLiteralConstant = (name, identity) => {
    const declarations = declarationsNamed(sourceFile, name)
    if (declarations.length !== 1) return false
    const declaration = declarations[0]
    const statement = declaration.parent?.parent
    const initializer = declaration.initializer
    return ts.isVariableStatement(statement) && hasExport(statement)
      && statement.modifiers?.length === 1
      && statement.declarationList.declarations.length === 1
      && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
      && initializer && ts.isAsExpression(initializer)
      && ts.isStringLiteral(initializer.expression) && initializer.expression.text === identity
      && initializer.type.getText(sourceFile) === 'const'
  }
  if (!exactLiteralConstant(spec.command, spec.commandIdentity)
    || !exactLiteralConstant(spec.result, spec.resultIdentity)
    || (spec.eligibilityConstant
      && !exactLiteralConstant(spec.eligibilityConstant, spec.eligibilityIdentity))) return false
  if (spec.eligibilityError) {
    const errorClasses = sourceFile.statements.filter(statement => (
      ts.isClassDeclaration(statement) && statement.name?.text === spec.eligibilityError
    ))
    if (errorClasses.length !== 1 || !hasExport(errorClasses[0])
      || errorClasses[0].heritageClauses?.length !== 1
      || compactNode(errorClasses[0], sourceFile).length === 0
      || createHash('sha256').update(compactNode(errorClasses[0], sourceFile)).digest('hex')
        !== spec.eligibilityErrorDigest) return false
  }
  const parsers = sourceFile.statements.filter(statement => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === spec.parser
  ))
  if (parsers.length !== 1 || parsers[0].asteriskToken || parsers[0].modifiers?.length !== 1
    || !hasExport(parsers[0]) || !parsers[0].body
    || parsers[0].parameters.length !== 1 || !isIdentifier(parsers[0].parameters[0].name, 'input')
    || parsers[0].parameters[0].dotDotDotToken || parsers[0].parameters[0].questionToken
    || parsers[0].parameters[0].initializer
    || parsers[0].parameters[0].type?.kind !== ts.SyntaxKind.UnknownKeyword
    || !parsers[0].type || !ts.isTypeReferenceNode(parsers[0].type)
    || !isIdentifier(parsers[0].type.typeName, spec.commandType)) return false
  const digest = createHash('sha256').update(compactNode(parsers[0].body, sourceFile)).digest('hex')
  return digest === spec.parserDigest
}
const exactContactServiceRetentionMethod = (sources) => {
  const source = sources.get(contactServicePath) ?? ''
  const sourceFile = parse(contactServicePath, source)
  if (sourceFile.parseDiagnostics.length) return false
  const prismaBindings = allNamedImports(sourceFile).filter(binding => (
    binding.imported === 'Prisma' || binding.local === 'Prisma'
  ))
  if (prismaBindings.length !== 1 || prismaBindings[0].module !== '@prisma/client'
    || prismaBindings[0].imported !== 'Prisma' || prismaBindings[0].local !== 'Prisma') return false
  const classes = sourceFile.statements.filter(statement => (
    ts.isClassDeclaration(statement) && statement.name?.text === 'ContactService'
  ))
  const aliasedContactServiceExport = sourceFile.statements.some(statement => (
    ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)
      && statement.exportClause.elements.some(binding => binding.name.text === 'ContactService')
  ))
  const methods = classes.length === 1 ? classes[0].members.filter(member => (
    ts.isMethodDeclaration(member) && member.name.getText(sourceFile) === 'deleteContactForRetention'
  )) : []
  if (classes.length !== 1 || classes[0].modifiers?.length !== 1 || !hasExport(classes[0])
    || classes[0].heritageClauses?.length || aliasedContactServiceExport
    || methods.length !== 1 || methods[0].parent !== classes[0]
    || methods[0].asteriskToken || methods[0].modifiers?.length !== 2
    || !methods[0].body || methods[0].parameters.length !== 1
    || !methods[0].modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)
    || !methods[0].modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    || !isIdentifier(methods[0].parameters[0].name, 'contactId')
    || methods[0].parameters[0].dotDotDotToken || methods[0].parameters[0].questionToken
    || methods[0].parameters[0].initializer
    || methods[0].parameters[0].type?.kind !== ts.SyntaxKind.StringKeyword
    || !methods[0].type
    || compactNode(methods[0].type, sourceFile) !== "Promise<'deleted'|'missing'|'ineligible'>"
    || methods[0].body.statements.length !== 1 || !ts.isReturnStatement(methods[0].body.statements[0])) return false
  const run = unwrap(methods[0].body.statements[0].expression)
  if (!run || !ts.isCallExpression(run) || run.questionDotToken
    || !isIdentifier(run.expression, 'runContactOwnershipTransaction') || run.arguments.length !== 1) return false
  const callback = unwrap(run.arguments[0])
  if (!callback || !ts.isArrowFunction(callback)
    || !callback.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    || callback.parameters.length !== 1 || !isIdentifier(callback.parameters[0].name, 'transaction')
    || callback.parameters[0].dotDotDotToken || callback.parameters[0].questionToken
    || callback.parameters[0].initializer
    || !ts.isBlock(callback.body) || callback.body.statements.length !== 8) return false
  const [scope, contact, missing, eligible, ineligible, deletion, postconditions, completed] = callback.body.statements
  if (compactNode(scope, sourceFile)
      !== 'constscope=awaitlockContactOwnershipRows(transaction,{contactIds:[contactId]})'
    || compactNode(contact, sourceFile)
      !== 'constcontact=awaittransaction.contact.findUnique({where:{id:contactId},select:{id:true},})'
    || compactNode(missing, sourceFile) !== "if(!contact)return'missing'"
    || compactNode(ineligible, sourceFile) !== "if(!eligible[0])return'ineligible'"
    || compactNode(deletion, sourceFile)
      !== 'awaittransaction.contact.deleteMany({where:{id:contactId}})'
    || compactNode(postconditions, sourceFile)
      !== 'awaitassertContactOwnershipPostconditions(transaction,scope)'
    || compactNode(completed, sourceFile) !== "return'deleted'") return false
  if (!ts.isVariableStatement(eligible) || eligible.declarationList.declarations.length !== 1
    || (eligible.declarationList.flags & ts.NodeFlags.Const) === 0) return false
  const eligibleDeclaration = eligible.declarationList.declarations[0]
  const eligibleAwait = unwrap(eligibleDeclaration.initializer)
  const eligibleCall = eligibleAwait && ts.isAwaitExpression(eligibleAwait)
    ? unwrap(eligibleAwait.expression) : null
  if (!isIdentifier(eligibleDeclaration.name, 'eligible') || !eligibleCall
    || !ts.isCallExpression(eligibleCall) || eligibleCall.questionDotToken
    || propertyChain(eligibleCall.expression) !== 'transaction.$queryRaw'
    || eligibleCall.arguments.length !== 1 || !ts.isTaggedTemplateExpression(unwrap(eligibleCall.arguments[0]))
    || propertyChain(unwrap(eligibleCall.arguments[0]).tag) !== 'Prisma.sql') return false
  const eligibilitySql = 'SELECT contact.id FROM "Contact" AS contact '
    + 'WHERE contact.id = ${contactId} AND contact."isArchived" = true '
    + "AND contact.\"updatedAt\" < (NOW() AT TIME ZONE 'UTC') - INTERVAL '365 days' "
    + 'AND NOT EXISTS ( SELECT 1 FROM "ContactMerge" AS edge '
    + 'WHERE edge."survivorId" = contact.id OR edge."mergedId" = contact.id ) LIMIT 1'
  if (normalizedTemplateProjection(unwrap(eligibleCall.arguments[0]), sourceFile) !== eligibilitySql) return false
  const calls = []
  const tagged = []
  walk(methods[0], (node) => {
    if (ts.isCallExpression(node)) calls.push(propertyChain(node.expression))
    if (ts.isTaggedTemplateExpression(node)) tagged.push(propertyChain(node.tag))
  })
  const expectedCalls = [
    'runContactOwnershipTransaction',
    'lockContactOwnershipRows',
    'transaction.contact.findUnique',
    'transaction.$queryRaw',
    'transaction.contact.deleteMany',
    'assertContactOwnershipPostconditions',
  ]
  const coordinatorImports = allNamedImports(sourceFile).filter(binding => [
    'runContactOwnershipTransaction',
    'lockContactOwnershipRows',
    'assertContactOwnershipPostconditions',
  ].includes(binding.imported) || [
    'runContactOwnershipTransaction',
    'lockContactOwnershipRows',
    'assertContactOwnershipPostconditions',
  ].includes(binding.local))
  return calls.length === expectedCalls.length
    && expectedCalls.every(name => calls.filter(candidate => candidate === name).length === 1)
    && tagged.length === 1 && tagged[0] === 'Prisma.sql'
    && coordinatorImports.length === 3
    && coordinatorImports.every(binding => binding.module === '@/modules/contacts/internal/contact-ownership-coordinator'
      && binding.imported === binding.local)
}

const withoutSourceExtension = file => file.replace(/\.(?:[cm]?[jt]sx?)$/, '')
const resolvesToSourceModule = (file, specifier, target) => {
  const resolved = specifier.startsWith('@/')
    ? path.join(sourceRoot, specifier.slice(2))
    : specifier.startsWith('.') ? path.join(path.dirname(file), specifier) : null
  if (resolved === null) return false
  const candidate = withoutSourceExtension(path.normalize(resolved))
  const expected = withoutSourceExtension(path.normalize(target))
  return candidate === expected || path.join(candidate, 'index') === expected
}
const broadRuntimeReferenceInventoryCache = new WeakMap()
const broadRuntimeReferenceInventory = (sources) => {
  const cached = broadRuntimeReferenceInventoryCache.get(sources)
  if (cached) return cached
  const references = []
  for (const [file, source] of sources) {
    const sourceFile = parse(file, source)
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const clause = statement.importClause
        if (clause && !clause.isTypeOnly && (
          clause.name || (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        )) references.push({ file, module: statement.moduleSpecifier.text, kind: 'broad-import' })
      }
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier
        && ts.isStringLiteralLike(statement.moduleSpecifier) && !statement.isTypeOnly
        && (!statement.exportClause || ts.isNamespaceExport(statement.exportClause))) {
        references.push({
          file,
          module: statement.moduleSpecifier.text,
          kind: 'broad-export',
          star: !statement.exportClause,
          namespaceName: statement.exportClause && ts.isNamespaceExport(statement.exportClause)
            ? statement.exportClause.name.text : null,
        })
      }
      if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly
        && ts.isExternalModuleReference(statement.moduleReference)
        && statement.moduleReference.expression
        && ts.isStringLiteralLike(statement.moduleReference.expression)) {
        references.push({ file, module: statement.moduleReference.expression.text, kind: 'import-equals' })
      }
    }
    walk(sourceFile, (node) => {
      if (!ts.isCallExpression(node) || node.arguments.length !== 1
        || !ts.isStringLiteralLike(node.arguments[0])) return
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      if (dynamicImport || isIdentifier(node.expression, 'require')) {
        references.push({
          file,
          module: node.arguments[0].text,
          kind: 'runtime-module-load',
          dynamicImport,
        })
      }
    })
  }
  broadRuntimeReferenceInventoryCache.set(sources, references)
  return references
}
const unsafeBroadRuntimeReferencesTo = (
  sources,
  target,
  {
    allowedDynamicImportCounts = {},
    allowedStarExporter = null,
    allowedNamespaceExporter = null,
    allowedNamespaceName = null,
  } = {},
) => {
  const matching = broadRuntimeReferenceInventory(sources).filter(reference => (
    resolvesToSourceModule(reference.file, reference.module, target)
  ))
  const dynamicCounts = Object.fromEntries([...new Set(matching
    .filter(reference => reference.dynamicImport)
    .map(reference => reference.file))]
    .map(file => [file, matching.filter(reference => reference.dynamicImport && reference.file === file).length]))
  const dynamicAllowlistExact = JSON.stringify(Object.entries(dynamicCounts).sort())
    === JSON.stringify(Object.entries(allowedDynamicImportCounts).sort())
  return matching.filter((reference) => {
  if (reference.dynamicImport && dynamicAllowlistExact) return false
  if (reference.kind === 'broad-export' && reference.star && allowedStarExporter
    && path.normalize(reference.file) === path.normalize(allowedStarExporter)) return false
  if (reference.kind === 'broad-export' && !reference.star && allowedNamespaceExporter
    && path.normalize(reference.file) === path.normalize(allowedNamespaceExporter)
    && reference.namespaceName === allowedNamespaceName) return false
  return true
  })
}
const exactDirectDynamicDestructure = (call, imported) => {
  const awaited = call.parent
  const declaration = awaited && ts.isAwaitExpression(awaited) ? awaited.parent : null
  if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.initializer !== awaited
    || !ts.isObjectBindingPattern(declaration.name) || declaration.name.elements.length !== 1) return false
  const binding = declaration.name.elements[0]
  const declarationList = declaration.parent
  const statement = declarationList?.parent
  return ts.isBindingElement(binding) && !binding.dotDotDotToken && !binding.initializer
    && (!binding.propertyName || isIdentifier(binding.propertyName, imported))
    && isIdentifier(binding.name, imported)
    && ts.isVariableDeclarationList(declarationList)
    && declarationList.declarations.length === 1
    && (declarationList.flags & ts.NodeFlags.Const) !== 0
    && ts.isVariableStatement(statement) && !hasExport(statement)
}
const dynamicImportsResolvingTo = (sources, target) => {
  const calls = []
  for (const [file, source] of sources) {
    const sourceFile = parse(file, source)
    walk(sourceFile, (node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])
        && resolvesToSourceModule(file, node.arguments[0].text, target)) calls.push({ file, node, sourceFile })
    })
  }
  return calls
}
const exactMessagingPromiseNamespaceImport = (record) => {
  const { node: call, sourceFile } = record
  const imports = call.parent
  if (!ts.isArrayLiteralExpression(imports) || imports.elements.length !== 2 || imports.elements[0] !== call) return false
  const platformImport = imports.elements[1]
  if (!ts.isCallExpression(platformImport) || platformImport.expression.kind !== ts.SyntaxKind.ImportKeyword
    || platformImport.arguments.length !== 1 || !ts.isStringLiteralLike(platformImport.arguments[0])
    || platformImport.arguments[0].text !== '@/modules/platform-shell/public/v1') return false
  const promiseCall = imports.parent
  const awaited = promiseCall && ts.isCallExpression(promiseCall) && promiseCall.arguments.length === 1
    && promiseCall.arguments[0] === imports && propertyChain(promiseCall.expression) === 'Promise.all'
    ? promiseCall.parent : null
  const declaration = awaited && ts.isAwaitExpression(awaited) ? awaited.parent : null
  if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.initializer !== awaited
    || !ts.isArrayBindingPattern(declaration.name) || declaration.name.elements.length !== 2) return false
  const [messagingBinding, platformBinding] = declaration.name.elements
  const declarationList = declaration.parent
  const statement = declarationList?.parent
  if (!ts.isBindingElement(messagingBinding) || messagingBinding.dotDotDotToken || messagingBinding.initializer
    || messagingBinding.propertyName || !isIdentifier(messagingBinding.name, 'messaging')
    || !ts.isBindingElement(platformBinding) || platformBinding.dotDotDotToken || platformBinding.initializer
    || platformBinding.propertyName || !isIdentifier(platformBinding.name, 'platform')
    || !ts.isVariableDeclarationList(declarationList) || declarationList.declarations.length !== 1
    || (declarationList.flags & ts.NodeFlags.Const) === 0
    || !ts.isVariableStatement(statement) || hasExport(statement)) return false
  let scope = statement.parent
  while (scope && !ts.isTryStatement(scope) && !ts.isSourceFile(scope)) scope = scope.parent
  if (!scope || !ts.isTryStatement(scope)) return false
  const messagingIdentifiers = []
  walk(scope.tryBlock, (node) => {
    if (ts.isIdentifier(node) && node.text === 'messaging' && isRuntimeIdentifier(node)) {
      messagingIdentifiers.push(node)
    }
  })
  if (messagingIdentifiers.length !== 2 || messagingIdentifiers[0] !== messagingBinding.name) return false
  const use = messagingIdentifiers[1]
  const access = use.parent
  const invocation = access?.parent
  return ts.isPropertyAccessExpression(access) && access.expression === use && !access.questionDotToken
    && access.name.text === 'registerOutboundConversationPreparerV1'
    && ts.isCallExpression(invocation) && invocation.expression === access && !invocation.questionDotToken
}
const exactAdmittedDynamicPublicImports = (sources) => {
  const instrumentationPath = 'gravity-mvp/src/instrumentation.ts'
  const contactsTarget = compositionSpecs[0].indexPath
  const messagingTarget = compositionSpecs[1].indexPath
  const workTarget = compositionSpecs[2].indexPath
  const contacts = dynamicImportsResolvingTo(sources, contactsTarget)
  const messaging = dynamicImportsResolvingTo(sources, messagingTarget)
  const work = dynamicImportsResolvingTo(sources, workTarget)
  if (contacts.length !== 1 || contacts[0].file !== instrumentationPath
    || !exactDirectDynamicDestructure(contacts[0].node, 'deactivateContactPhoneV1')
    || messaging.length !== 5 || messaging.some(record => record.file !== instrumentationPath)
    || work.length !== 0) return false
  const directExpected = new Map([
    ['recoverStuckMessagingDeliveriesV1', 2],
    ['retryEligibleMessagingDeliveriesV1', 1],
    ['messagingCompletedCallTimelineProjectorV1', 1],
  ])
  let namespaceRecords = 0
  for (const record of messaging) {
    const matched = [...directExpected].find(([name]) => exactDirectDynamicDestructure(record.node, name))
    if (matched) {
      directExpected.set(matched[0], matched[1] - 1)
      continue
    }
    if (exactMessagingPromiseNamespaceImport(record)) namespaceRecords += 1
    else return false
  }
  return namespaceRecords === 1 && [...directExpected.values()].every(count => count === 0)
}
const exactCanonicalPublicNamespaceBarrels = (sources) => compositionSpecs.every((spec) => {
  const parentPublicIndex = path.join(path.dirname(spec.indexPath), '..', 'index.ts')
  const moduleIndex = path.join(path.dirname(parentPublicIndex), '..', 'index.ts')
  const namespaceName = spec.operation === 'deleteContactForRetentionV1'
    ? 'ContactsPublic'
    : spec.operation === 'detachContactConversationsV1' ? 'MessagingPublic' : 'WorkManagementPublic'
  const sourceFile = parse(moduleIndex, sources.get(moduleIndex) ?? '')
  if (sourceFile.parseDiagnostics.length || sourceFile.statements.length !== 1) return false
  const statement = sourceFile.statements[0]
  if (!ts.isExportDeclaration(statement) || statement.isTypeOnly
    || !statement.moduleSpecifier || !ts.isStringLiteralLike(statement.moduleSpecifier)
    || statement.moduleSpecifier.text !== './public' || !statement.exportClause
    || !ts.isNamespaceExport(statement.exportClause)
    || statement.exportClause.name.text !== namespaceName) return false
  const occurrences = []
  for (const [file, source] of sources) {
    walk(parse(file, source), (node) => {
      if (ts.isIdentifier(node) && node.text === namespaceName && isRuntimeIdentifier(node)) {
        occurrences.push({ file, node })
      }
    })
  }
  return occurrences.length === 1 && occurrences[0].file === moduleIndex
    && occurrences[0].node === statement.exportClause.name
})
const exactRuntimeIdentifierInventory = (sources, name, expected) => {
  const actual = new Map()
  for (const [file, source] of sources) {
    walk(parse(file, source), (node) => {
      if (ts.isIdentifier(node) && node.text === name && isRuntimeIdentifier(node)) {
        actual.set(file, (actual.get(file) ?? 0) + 1)
      }
    })
  }
  return actual.size === expected.size && [...expected].every(([file, count]) => actual.get(file) === count)
}
const resolvedSourceFile = (sources, target) => [...sources.keys()].find(file => (
  withoutSourceExtension(path.normalize(file)) === withoutSourceExtension(path.normalize(target))
))
const exactSensitiveCompositionIdentifierInventory = (sources) => {
  const protectedNames = new Set()
  for (const spec of compositionSpecs) {
    const handler = handlerSpecs.find(candidate => candidate.factory === spec.factory)
    const adapterTarget = path.join(path.dirname(spec.applicationPath), spec.adapterModule)
    const adapterFile = resolvedSourceFile(sources, adapterTarget)
    if (!handler || !adapterFile) return false
    const localExpected = new Map([
      [spec.applicationPath, 2],
      [handler.file, 1],
      [adapterFile, spec.operation === 'deleteContactForRetentionV1' ? 2 : 1],
      ...(spec.operation === 'deleteContactForRetentionV1' ? [[contactServicePath, 1]] : []),
    ])
    const adapterExpected = new Map([
      [spec.applicationPath, 2],
      [adapterFile, 1],
    ])
    const factoryExpected = new Map([
      [spec.applicationPath, 2],
      [handler.file, 1],
      [spec.indexPath, 1],
    ])
    if (!exactRuntimeIdentifierInventory(sources, spec.local, localExpected)
      || !exactRuntimeIdentifierInventory(sources, spec.adapter, adapterExpected)
      || !exactRuntimeIdentifierInventory(sources, spec.factory, factoryExpected)) return false
    protectedNames.add(spec.local)
    protectedNames.add(spec.adapter)
    protectedNames.add(spec.factory)
    protectedNames.add(spec.operation)
  }
  for (const [file, source] of sources) {
    const sourceFile = parse(file, source)
    const bindings = staticStringBindings(sourceFile)
    let bypass = false
    walk(sourceFile, (node) => {
      if (ts.isElementAccessExpression(node) && node.argumentExpression
        && protectedNames.has(staticStringValue(node.argumentExpression, bindings))) bypass = true
      if (ts.isIdentifier(node) && node.text === 'ContactService' && isRuntimeIdentifier(node)) {
        const parent = node.parent
        const admitted = (ts.isImportSpecifier(parent) && parent.name === node)
          || (ts.isClassDeclaration(parent) && parent.name === node)
          || (ts.isPropertyAccessExpression(parent) && parent.expression === node)
          || (ts.isPropertyAssignment(parent) && parent.name === node)
        if (!admitted) bypass = true
      }
    })
    if (bypass) return false
  }
  return true
}
const exactNoLegacyContactRetentionConsumers = (sources) => !sources.has(legacyContactsRetentionAdapterPath)
  && [...sources].every(([file, source]) => {
  const sourceFile = parse(file, source)
  let referenced = sourceFile.statements.some(statement => (
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
    && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
    && resolvesToSourceModule(file, statement.moduleSpecifier.text, legacyContactsRetentionAdapterPath)
  ))
  walk(sourceFile, (node) => {
    if (referenced) return
    if (ts.isIdentifier(node) && node.text === 'legacyPrismaContactRetentionPortV1') {
      referenced = true
      return
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || isIdentifier(node.expression, 'require'))
      && resolvesToSourceModule(file, node.arguments[0].text, legacyContactsRetentionAdapterPath)) referenced = true
  })
  return !referenced
  })

const contactsContract = read('gravity-mvp/src/contracts/contacts/v1/contact-retention-command.ts')
const messagingContract = read('gravity-mvp/src/contracts/messaging/v1/contact-retention-command.ts')
const workContract = read('gravity-mvp/src/contracts/work-management/v1/contact-retention-command.ts')
const contactsHandler = read('gravity-mvp/src/modules/contacts/public/v1/contact-retention-handler.ts')
const messagingHandler = read('gravity-mvp/src/modules/messaging/public/v1/contact-retention-handler.ts')
const workHandler = read('gravity-mvp/src/modules/work-management/public/v1/contact-retention-handler.ts')
const contactsAdapter = read('gravity-mvp/src/modules/contacts/internal/contact-ownership-persistence-ports.ts')
const messagingAdapter = read('gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-contact-retention-adapter.ts')
const workAdapter = read('gravity-mvp/src/modules/work-management/public/v1/legacy-prisma-contact-retention-adapter.ts')
const contactsIndex = read('gravity-mvp/src/modules/contacts/public/v1/index.ts')
const messagingIndex = read('gravity-mvp/src/modules/messaging/public/v1/index.ts')
const workIndex = read('gravity-mvp/src/modules/work-management/public/v1/index.ts')
const contactsOperations = read('gravity-mvp/src/modules/contacts/application/contact-operations.ts')
const messagingOperations = read('gravity-mvp/src/modules/messaging/application/messaging-operations.ts')
const workOperations = read('gravity-mvp/src/modules/work-management/application/task-operations.ts')
const consumer = read('gravity-mvp/src/lib/RetentionCleanup.ts')
const contactService = read(contactServicePath)
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
const archivedPhase = sliceBetween(consumer, '// 7. Archived contacts', '} catch (err: unknown)')
const spoofedDependencyRead = dependencyRead
  .replace(
    '        SELECT\n',
    '        SELECT 0::int as "activeChats", 0::int as "recentMessages", 0::int as "merges"\n        /* SELECT\n',
  )
  .replace(' as "merges"\n      `', ' as "merges" */\n      `')
const contactEligibilityRead = sliceBetween(
  contactService,
  '      const eligible = await transaction.$queryRaw',
  '      if (!eligible[0])',
)
const spoofedContactEligibilityRead = contactEligibilityRead
  .replace(
    '        SELECT contact.id FROM "Contact" AS contact\n',
    '        SELECT contact.id FROM "Contact" AS contact WHERE TRUE\n        /* SELECT contact.id FROM "Contact" AS contact\n',
  )
  .replace('        LIMIT 1\n      `)', '        LIMIT 1 */\n      `)')
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
  contactsOwnershipPortPath,
  'ContactService.deleteContactForRetention',
)
const astBoundaryPasses = sources => compositionSpecs.every(spec => exactComposition(sources, spec))
  && exactPrivateCompositionConsumers(sources)
  && exactRuntimeConsumers(sources)
  && handlerSpecs.every(spec => exactHandler(sources.get(spec.file) ?? '', spec))
  && handlerSpecs.every(spec => exactContractParser(sources, spec))
  && literalRetentionAdapterSpecs.every(spec => exactLiteralRetentionAdapter(sources.get(spec.file) ?? '', spec))
  && exactSensitiveCompositionIdentifierInventory(sources)
  && exactArchivedMutationSequence(sources.get(consumerPath) ?? '')
  && exactContactOwnershipRetentionPort(sources)
  && exactContactServiceRetentionMethod(sources)
  && exactNoLegacyContactRetentionConsumers(sources)
const currentAstBoundaryIsValid = astBoundaryPasses(repositorySources)
if (process.env.YOKO_DEBUG_ARCHIVED_CONTACT_BOUNDARY === '1') {
  process.stderr.write(`${JSON.stringify({
    composition: compositionSpecs.map(spec => exactComposition(repositorySources, spec)),
    privateConsumers: exactPrivateCompositionConsumers(repositorySources),
    runtimeConsumers: exactRuntimeConsumers(repositorySources),
    handlers: handlerSpecs.map(spec => exactHandler(repositorySources.get(spec.file) ?? '', spec)),
    contractParsers: handlerSpecs.map(spec => exactContractParser(repositorySources, spec)),
    literalAdapters: literalRetentionAdapterSpecs.map(spec => (
      exactLiteralRetentionAdapter(repositorySources.get(spec.file) ?? '', spec)
    )),
    sensitiveIdentifiers: exactSensitiveCompositionIdentifierInventory(repositorySources),
    mutationSequence: exactArchivedMutationSequence(repositorySources.get(consumerPath) ?? ''),
    retentionPort: exactContactOwnershipRetentionPort(repositorySources),
    contactService: exactContactServiceRetentionMethod(repositorySources),
    noLegacyAdapter: exactNoLegacyContactRetentionConsumers(repositorySources),
  })}\n`)
}
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
  withSource(
    repositorySources,
    handlerSpecs[0].file,
    contactsHandler.replace(
      'const outcome = await port.deleteContactForRetention(parsed.contactId)',
      'const outcome = await port.deleteContactForRetention(parsed.contactId), hidden = sideEffect()',
    ),
  ),
  withSource(
    repositorySources,
    consumerPath,
    consumer.replace(
      '        try {\n          await deleteContactForRetentionV1({',
      '        try {\n          await hiddenMutation()\n          await deleteContactForRetentionV1({',
    ),
  ),
  withSource(
    repositorySources,
    contactsOwnershipPortPath,
    contactsAdapter.replace(
      '    return ContactService.deleteContactForRetention(contactId)',
      "    await ContactService.deleteContactForRetention(contactId)\n    return 'deleted'",
    ),
  ),
  new Map([...repositorySources, [
    'gravity-mvp/src/modules/contacts/application/legacy-retention-probe.js',
    "const { legacyPrismaContactRetentionPortV1 } = require('../public/v1/legacy-prisma-contact-retention-adapter')\nvoid legacyPrismaContactRetentionPortV1\n",
  ]]),
  withSource(
    repositorySources,
    handlerSpecs[0].file,
    contactsHandler.replace(
      'export function createDeleteContactForRetentionHandlerV1(port: ContactRetentionPersistencePortV1) {\n  return async',
      'export function createDeleteContactForRetentionHandlerV1(ignoredPort: ContactRetentionPersistencePortV1) {\n  const port = injectedRetentionPort\n  return async',
    ),
  ),
  withSource(
    repositorySources,
    compositionSpecs[0].indexPath,
    `${contactsIndex}\nexport { contactOwnershipRetentionPortV1 } from '../../internal/contact-ownership-persistence-ports'\n`,
  ),
  new Map([...repositorySources, [
    'gravity-mvp/src/modules/contacts/public/retention-alias-probe.ts',
    "export { deleteContactForRetentionV1 as aliasedDelete } from './v1/index'\n",
  ]]),
  withSource(
    repositorySources,
    consumerPath,
    consumer.replace(
      '  private static async _cleanupArchivedContacts(ageDays: number, limit: number, dryRun: boolean): Promise<{ deleted: number; skipped: number }> {',
      '  private static async _cleanupArchivedContacts(ageDays: number, limit: number, dryRun: boolean): Promise<{ deleted: number; skipped: number }> {\n    await prisma.contactPhone.deleteMany({})',
    ),
  ),
  withSource(
    repositorySources,
    consumerPath,
    consumer.replace('await deleteContactForRetentionV1({', 'await deleteContactForRetentionV1?.({'),
  ),
  withSource(
    repositorySources,
    handlerSpecs[0].file,
    contactsHandler.replace('port.deleteContactForRetention(', 'port?.deleteContactForRetention('),
  ),
  withSource(
    repositorySources,
    consumerPath,
    consumer.replace(
      '    // Find archived contacts old enough',
      '    await prisma.$queryRawUnsafe(\'DELETE FROM "ContactPhone" WHERE id = $1 RETURNING id\', id)\n    // Find archived contacts old enough',
    ),
  ),
  withSource(
    repositorySources,
    legacyContactsRetentionAdapterPath,
    `import { prisma } from '@/lib/prisma'
export const legacyPrismaContactRetentionPortV1 = {
  async deleteContactForRetention(contactId) {
    return prisma.contact.deleteMany({ where: { id: contactId } })
  },
}\n`,
  ),
  new Map([...repositorySources, [
    'gravity-mvp/src/modules/contacts/application/private-retention-require-probe.cjs',
    "const { contactOwnershipRetentionPortV1 } = require('../internal/contact-ownership-persistence-ports')\nvoid contactOwnershipRetentionPortV1\n",
  ]]),
  withSource(
    repositorySources,
    consumerPath,
    consumer.replace(
      '    // Find archived contacts old enough',
      '    await prisma.$queryRaw`DELETE FROM "ContactPhone" RETURNING id`\n    // Find archived contacts old enough',
    ),
  ),
  new Map([...repositorySources, [
    'gravity-mvp/src/app/retention-namespace-probe.ts',
    "import * as contacts from '@/modules/contacts/public/v1'\nvoid contacts['deleteContactForRetentionV1']\n",
  ]]),
  new Map([...repositorySources, [
    'gravity-mvp/src/app/retention-star-export-probe.ts',
    "export * from '../modules/contacts/public/v1'\n",
  ]]),
  withSource(
    repositorySources,
    consumerPath,
    consumer.replace(mutationBlock, `if (false) {\n${mutationBlock}\n      }\n      `),
  ),
  withSource(
    repositorySources,
    consumerPath,
    consumer.replace("} from '@/contracts/contacts/v1'", "} from '@/contracts/messaging/v1'"),
  ),
  withSource(
    repositorySources,
    contactServicePath,
    contactService.replace(
      "  static async deleteContactForRetention(\n    contactId: string,\n  ): Promise<'deleted' | 'missing' | 'ineligible'> {\n    return runContactOwnershipTransaction(async transaction => {",
      "  static async deleteContactForRetention(\n    contactId: string,\n  ): Promise<'deleted' | 'missing' | 'ineligible'> {\n    return bypassContactOwnershipTransaction(async transaction => {",
    ),
  ),
  new Map([...repositorySources, [
    'gravity-mvp/src/app/retention-commonjs-operation-probe.cjs',
    "const { deleteContactForRetentionV1: purge } = require('@/modules/contacts/public/v1')\nvoid purge\n",
  ]]),
  new Map([...repositorySources, [
    'gravity-mvp/src/modules/contacts/public/private-retention-star-probe.ts',
    "export * from '../internal/contact-ownership-persistence-ports'\n",
  ]]),
  withSource(
    repositorySources,
    consumerPath,
    consumer.replace(dependencyRead, spoofedDependencyRead),
  ),
  withSource(
    repositorySources,
    contactServicePath,
    contactService.replace(contactEligibilityRead, spoofedContactEligibilityRead),
  ),
  new Map([...repositorySources, [
    'gravity-mvp/src/app/retention-dynamic-indirection-probe.ts',
    "const operations = await import('@/modules/contacts/public/v1')\nconst { deleteContactForRetentionV1: hiddenPurge } = operations\nvoid hiddenPurge\n",
  ]]),
  new Map([...repositorySources, [
    'gravity-mvp/src/app/retention-parent-barrel-probe.cjs',
    "const { deleteContactForRetentionV1: hiddenPurge } = require('@/modules/contacts/public')\nvoid hiddenPurge\n",
  ]]),
  withSource(
    repositorySources,
    consumerPath,
    `${consumer}\nexport const hiddenRetentionDelete = deleteContactForRetentionV1\n`,
  ),
  withSource(
    repositorySources,
    compositionSpecs[0].applicationPath,
    contactsOperations.replace(
      'const deleteContactForRetention = createDeleteContactForRetentionHandlerV1',
      'export const deleteContactForRetention = createDeleteContactForRetentionHandlerV1',
    ),
  ),
  new Map([...repositorySources, [
    'gravity-mvp/src/app/retention-transitive-star-probe.ts',
    "export * from '@/modules/contacts/public'\n",
  ]]),
  new Map([...repositorySources, [
    'gravity-mvp/src/app/retention-computed-dynamic-probe.ts',
    "const operations = await import('@/modules/contacts/public/v1')\nconst name = 'deleteContactFor' + 'RetentionV1'\nvoid operations[name]\n",
  ]]),
  withSource(
    repositorySources,
    compositionSpecs[0].applicationPath,
    `${contactsOperations}\nexport { deleteContactForRetention as hiddenRetentionDelete }\n`,
  ),
  withSource(
    repositorySources,
    contactsOwnershipPortPath,
    `${contactsAdapter}\nexport { contactOwnershipRetentionPortV1 as hiddenRetentionPort }\n`,
  ),
  withSource(
    repositorySources,
    handlerSpecs[0].file,
    `${contactsHandler}\nexport { createDeleteContactForRetentionHandlerV1 as hiddenRetentionFactory }\n`,
  ),
  withSource(
    repositorySources,
    'gravity-mvp/src/instrumentation.ts',
    repositorySources.get('gravity-mvp/src/instrumentation.ts').replace(
      "const { deactivateContactPhoneV1 } = await import('@/modules/contacts/public/v1')",
      "const contacts = await import('@/modules/contacts/public/v1')\n                const { deactivateContactPhoneV1 } = contacts\n                const hiddenRetentionName = 'deleteContactFor' + 'RetentionV1'\n                void contacts[hiddenRetentionName]",
    ),
  ),
  withSource(
    repositorySources,
    'gravity-mvp/src/instrumentation.ts',
    repositorySources.get('gravity-mvp/src/instrumentation.ts').replace(
      '        messaging.registerOutboundConversationPreparerV1(',
      "        const hiddenRetentionName = 'detachContact' + 'ConversationsV1'\n        void messaging[hiddenRetentionName]\n        messaging.registerOutboundConversationPreparerV1(",
    ),
  ),
  new Map([...repositorySources, [
    'gravity-mvp/src/app/retention-root-namespace-probe.ts',
    "import { ContactsPublic } from '@/modules/contacts'\nconst name = 'deleteContactFor' + 'RetentionV1'\nvoid ContactsPublic[name]\n",
  ]]),
  withSource(
    repositorySources,
    literalRetentionAdapterSpecs[0].file,
    messagingAdapter.replace(
      '      contactId,\n    )',
      '      contactId,\n    )\n    await hiddenMutation(contactId)',
    ),
  ),
  withSource(
    repositorySources,
    handlerSpecs[1].file,
    messagingHandler.replace(handlerSpecs[1].contractModule, './retention-spoof-contract'),
  ),
  withSource(
    repositorySources,
    handlerSpecs[1].contractPath,
    messagingContract.replace(
      'return value as unknown as DetachContactConversationsCommandV1',
      "return { ...value, contactId: 'attacker-selected-contact' } as unknown as DetachContactConversationsCommandV1",
    ),
  ),
  withSource(
    repositorySources,
    handlerSpecs[0].contractPath,
    contactsContract.replace(
      "'contacts.DeleteContactForRetentionCommand.v1' as const",
      "'contacts.AttackerSelectedContactCommand.v1' as const // 'contacts.DeleteContactForRetentionCommand.v1'",
    ),
  ),
  new Map([...repositorySources, [
    'gravity-mvp/src/app/retention-contact-service-probe.ts',
    "import { ContactService } from '@/lib/ContactService'\nvoid ContactService.deleteContactForRetention('hidden-id')\n",
  ]]),
  withSource(
    repositorySources,
    handlerSpecs[0].contractPath,
    contactsContract.replace(
      'readonly code = CONTACT_RETENTION_ELIGIBILITY_CHANGED_V1',
      "readonly code = 'WRONG_ELIGIBILITY_CODE'",
    ),
  ),
  withSource(
    repositorySources,
    path.join(path.dirname(handlerSpecs[0].contractPath), 'index.ts'),
    repositorySources.get(path.join(path.dirname(handlerSpecs[0].contractPath), 'index.ts')).replace(
      "export * from './contact-retention-command'",
      "export * from './retention-spoof-contract'",
    ),
  ),
  withSource(
    repositorySources,
    path.join(path.dirname(handlerSpecs[1].contractPath), 'index.ts'),
    `${repositorySources.get(path.join(path.dirname(handlerSpecs[1].contractPath), 'index.ts'))}\nexport { parseDetachContactConversationsCommandV1 } from './retention-spoof-contract'\n`,
  ),
  withSource(
    repositorySources,
    consumerPath,
    consumer.replace("import { prisma } from '@/lib/prisma'", "import { prisma } from '@/lib/retention-spoof-prisma'"),
  ),
  withSource(
    repositorySources,
    contactServicePath,
    contactService.replace(
      "import { ChatChannel, Prisma, type ContactPhoneSource } from '@prisma/client'",
      "import { ChatChannel, Prisma, type ContactPhoneSource } from '@/lib/retention-spoof-prisma'",
    ),
  ),
  withSource(
    repositorySources,
    handlerSpecs[1].file,
    messagingHandler.replace(
      'return async function detachContactConversationsV1(',
      'return async function* detachContactConversationsV1(',
    ),
  ),
  withSource(
    repositorySources,
    handlerSpecs[1].contractPath,
    messagingContract.replace(
      'export function parseDetachContactConversationsCommandV1(',
      'export function* parseDetachContactConversationsCommandV1(',
    ),
  ),
  withSource(
    repositorySources,
    path.join(path.dirname(handlerSpecs[1].contractPath), 'index.ts'),
      `${repositorySources.get(path.join(path.dirname(handlerSpecs[1].contractPath), 'index.ts'))}\nexport { spoof as "parseDetachContactConversationsCommandV1" } from './retention-spoof-contract'\n`,
  ),
  withSource(
    repositorySources,
    consumerPath,
    consumer.replace(
      'private static async _cleanupArchivedContacts(ageDays: number, limit: number, dryRun: boolean)',
      'private static async _cleanupArchivedContacts(ageDays: number, limit: number, ...dryRun: [boolean])',
    ),
  ),
  new Map([...repositorySources, [
    'gravity-mvp/src/app/retention-dynamic-contact-service-probe.ts',
    "import { ContactService } from '@/lib/ContactService'\nconst service = ContactService\nconst method = process.env.RETENTION_METHOD\nvoid service[method!]?.('hidden-id')\n",
  ]]),
  withSource(
    repositorySources,
    contactServicePath,
    contactService.replace("return 'ineligible'", "return 'in eligible'"),
  ),
  withSource(
    repositorySources,
    contactServicePath,
    `${contactService.replace('export class ContactService {', 'class DeadContactService {')}\nexport class ContactService {}\n`,
  ),
  withSource(
    repositorySources,
    consumerPath,
    consumer.replace('for (const { id } of candidates)', "for (const { id: id = 'hidden-id' } of candidates)"),
  ),
  withSource(
    repositorySources,
    literalRetentionAdapterSpecs[0].file,
    messagingAdapter.replace('prisma.$executeRawUnsafe(', 'prisma?.$executeRawUnsafe('),
  ),
  withSource(
    repositorySources,
    handlerSpecs[0].file,
    contactsHandler.replace(
      "Promise<'deleted' | 'missing' | 'ineligible'>",
      "Promise<'deleted' | 'missing' | 'ineligible' | 'ignored'>",
    ),
  ),
]
const astBoundaryProbePasses = astBoundaryPasses
const failClosedAstProbeResults = failClosedAstProbes.map(astBoundaryProbePasses)
const legacyCommentOnlyProbePasses = astBoundaryProbePasses(new Map([...repositorySources, [
  'gravity-mvp/src/app/retention-legacy-comment-probe.ts',
  '// legacyPrismaContactRetentionPortV1 is intentionally retired.\n',
]]))
const typeOnlyOperationDocumentationProbePasses = astBoundaryProbePasses(new Map([...repositorySources, [
  'gravity-mvp/src/app/retention-type-documentation-probe.ts',
  "export type RetentionOperationDocumentation = 'deleteContactForRetentionV1' | 'detachContactConversationsV1' | 'detachContactTasksV1'\n",
]]))
const interfaceOnlyOperationDocumentationProbePasses = astBoundaryProbePasses(new Map([...repositorySources, [
  'gravity-mvp/src/app/retention-interface-documentation-probe.ts',
  'export interface RetentionOperationDocumentation { deleteContactForRetentionV1?: never; detachContactConversationsV1?: never; detachContactTasksV1?: never }\n',
]]))
if (process.env.YOKO_DEBUG_ARCHIVED_CONTACT_BOUNDARY === '1') {
  process.stderr.write(`accepted fail-closed probe indexes: ${JSON.stringify(
    failClosedAstProbeResults.flatMap((accepted, index) => accepted ? [index] : []),
  )}\n`)
}

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
  currentAstBoundaryIsValid && failClosedAstProbes.length === 59
    && failClosedAstProbeResults.every(accepted => !accepted)
    && legacyCommentOnlyProbePasses
    && typeOnlyOperationDocumentationProbePasses
    && interfaceOnlyOperationDocumentationProbePasses,
  'AST detector accepted commented/spoofed SQL, hidden/direct/raw mutation, swallowed outcome, inactive owner block, spoofed contract/import, injected port, optional call, private/commonjs/dynamic/namespace/star bypass, legacy adapter, alias export, or extra consumer',
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
  'Contacts retention persistence delegates outcome to the admitted owner service',
  exactContactOwnershipRetentionPort(repositorySources) &&
    exactNoLegacyContactRetentionConsumers(repositorySources) &&
    contactDeleteCalls.length === 1 && contactDeleteCalls[0].arguments.length === 1 &&
    isIdentifier(contactDeleteCalls[0].arguments[0], 'contactId') &&
    !/\$(?:query|execute)Raw|\.contact\.(?:delete|deleteMany)/.test(contactsAdapter),
  'Contacts retention persistence bypassed owner admission or lost the explicit outcome',
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
  'dry run, missing final row, and eligibility drift preserve explicit count behavior',
  archivedMethod.indexOf('if (!dryRun) {') < archivedMethod.indexOf('await detachContactConversationsV1') &&
    archivedMethod.indexOf('await deleteContactForRetentionV1') < archivedMethod.indexOf('deleted++') &&
    archivedMethod.includes('error as { code?: unknown }') &&
    archivedMethod.includes('CONTACT_RETENTION_ELIGIBILITY_CHANGED_V1') &&
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
