#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'
import { evaluateFindings, scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const sourceRoot = 'gravity-mvp/src'
const paths = {
  esl: 'gravity-mvp/src/lib/freeswitch/EslClient.ts',
  callingPort: 'gravity-mvp/src/modules/calling/public/v1/completed-call-timeline-projection.ts',
  callingIndex: 'gravity-mvp/src/modules/calling/public/v1/index.ts',
  messagingProjector: 'gravity-mvp/src/modules/messaging/public/v1/completed-call-timeline-projector.ts',
  messagingApplication: 'gravity-mvp/src/modules/messaging/application/messaging-operations.ts',
  messagingIndex: 'gravity-mvp/src/modules/messaging/public/v1/index.ts',
  instrumentation: 'gravity-mvp/src/instrumentation.ts',
}
const modules = {
  callingProjection: '@/modules/calling/public/v1/completed-call-timeline-projection',
  callingPublic: '@/modules/calling/public/v1',
  messagingPublic: '@/modules/messaging/public/v1',
  projectorImplementation: '../public/v1/completed-call-timeline-projector',
  projectorType: '../../../calling/public/v1/completed-call-timeline-projection',
  messagingApplication: '../../application/messaging-operations',
  messageBus: '@/lib/messageStreamBus',
}
const capabilities = {
  project: 'projectCompletedCallTimelineV1',
  register: 'registerCompletedCallTimelineProjectorV1',
  factory: 'createCompletedCallTimelineMessagingProjectorV1',
  messagingProjector: 'messagingCompletedCallTimelineProjectorV1',
  start: 'startCallingEslRuntimeV1',
}
const checks = []
const failures = []
const check = (name, condition, detail) => (condition ? checks.push(name) : failures.push({ name, detail }))

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
const isRuntimeFile = (file) => !/(?:^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.[^/]+$)/.test(file)
const staticBindings = (sourceFile, direction, specifier, includeTypeOnly = false) => {
  const records = []
  for (const statement of sourceFile.statements) {
    if (direction === 'import' && ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteralLike(statement.moduleSpecifier) || statement.moduleSpecifier.text !== specifier) continue
      const clause = statement.importClause
      if (!clause || (!includeTypeOnly && clause.isTypeOnly) || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue
      for (const binding of clause.namedBindings.elements) {
        const typeOnly = clause.isTypeOnly || binding.isTypeOnly
        if (!includeTypeOnly && typeOnly) continue
        records.push({
          imported: binding.propertyName?.text ?? binding.name.text,
          local: binding.name.text,
          typeOnly,
        })
      }
    }
    if (direction === 'export' && ts.isExportDeclaration(statement)) {
      if (!statement.moduleSpecifier || !ts.isStringLiteralLike(statement.moduleSpecifier)
        || statement.moduleSpecifier.text !== specifier || !statement.exportClause
        || !ts.isNamedExports(statement.exportClause)) continue
      for (const binding of statement.exportClause.elements) records.push({
        imported: binding.propertyName?.text ?? binding.name.text,
        local: binding.name.text,
        typeOnly: statement.isTypeOnly || binding.isTypeOnly,
      })
    }
  }
  return records
}
const allStaticImports = (sourceFile) => {
  const records = []
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue
    const clause = statement.importClause
    if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue
    for (const binding of clause.namedBindings.elements) if (!binding.isTypeOnly) records.push({
      module: statement.moduleSpecifier.text,
      imported: binding.propertyName?.text ?? binding.name.text,
      local: binding.name.text,
      kind: 'static',
    })
  }
  return records
}
const dynamicImports = (sourceFile) => {
  const records = []
  walk(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isObjectBindingPattern(node.name) || !node.initializer) return
    let initializer = unwrap(node.initializer)
    if (ts.isAwaitExpression(initializer)) initializer = unwrap(initializer.expression)
    if (!ts.isCallExpression(initializer) || initializer.expression.kind !== ts.SyntaxKind.ImportKeyword
      || initializer.arguments.length !== 1 || !ts.isStringLiteralLike(initializer.arguments[0])) return
    for (const binding of node.name.elements) {
      if (binding.dotDotDotToken || !ts.isIdentifier(binding.name)) continue
      const imported = binding.propertyName && (ts.isIdentifier(binding.propertyName) || ts.isStringLiteralLike(binding.propertyName))
        ? binding.propertyName.text : binding.name.text
      records.push({
        module: initializer.arguments[0].text,
        imported,
        local: binding.name.text,
        kind: 'dynamic',
      })
    }
  })
  return records
}
const moduleSpecifiers = (sourceFile) => {
  const specifiers = []
  walk(sourceFile, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) specifiers.push(node.arguments[0].text)
  })
  return specifiers
}
const identifierCalls = (sourceFile, name) => {
  const calls = []
  walk(sourceFile, (node) => {
    if (ts.isCallExpression(node) && isIdentifier(node.expression, name)) calls.push(node)
  })
  return calls
}
const propertyCalls = (sourceFile, object, method) => {
  const calls = []
  walk(sourceFile, (node) => {
    const expression = ts.isCallExpression(node) ? unwrap(node.expression) : null
    if (expression && ts.isPropertyAccessExpression(expression)
      && isIdentifier(expression.expression, object) && expression.name.text === method) calls.push(node)
  })
  return calls
}
const declarationsNamed = (sourceFile, name) => sourceFile.statements.flatMap(statement => (
  ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []
)).filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name)
const indexedCapabilities = new Set(Object.values(capabilities))
const sourceIndexCache = new WeakMap()
const sourceIndex = (sources) => {
  const cached = sourceIndexCache.get(sources)
  if (cached) return cached
  const bindings = new Map([...indexedCapabilities].map(capability => [capability, []]))
  const calls = new Map([...indexedCapabilities].map(capability => [capability, []]))
  const propertyBypasses = new Map([...indexedCapabilities].map(capability => [capability, 0]))
  for (const [file, source] of sources) {
    if (!isRuntimeFile(file)) continue
    if (![...indexedCapabilities].some(capability => source.includes(capability))) continue
    const sourceFile = parse(file, source)
    for (const binding of [...allStaticImports(sourceFile), ...dynamicImports(sourceFile)]) {
      if (indexedCapabilities.has(binding.imported)) bindings.get(binding.imported).push({ file, ...binding })
    }
    walk(sourceFile, (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(unwrap(node.expression))
        && indexedCapabilities.has(unwrap(node.expression).text)) {
        calls.get(unwrap(node.expression).text).push({ file, call: node })
      }
      if (ts.isPropertyAccessExpression(node) && indexedCapabilities.has(node.name.text)) {
        propertyBypasses.set(node.name.text, propertyBypasses.get(node.name.text) + 1)
      }
    })
  }
  const index = { bindings, calls, propertyBypasses }
  sourceIndexCache.set(sources, index)
  return index
}
const bindingRecords = (sources, capability) => {
  const index = sourceIndex(sources)
  return {
    records: index.bindings.get(capability) ?? [],
    propertyBypasses: index.propertyBypasses.get(capability) ?? 0,
  }
}
const callRecords = (sources, capability) => sourceIndex(sources).calls.get(capability) ?? []
const exactConsumer = (sources, capability, expected) => {
  const { records, propertyBypasses } = bindingRecords(sources, capability)
  const calls = callRecords(sources, capability)
  return propertyBypasses === 0 && records.length === 1
    && records[0].file === expected.file && records[0].module === expected.module
    && records[0].kind === expected.kind && records[0].local === capability
    && calls.length === expected.calls && calls.every(record => record.file === expected.file)
}
const exactEslProjection = (sources) => {
  const sourceFile = parse(paths.esl, sources.get(paths.esl) ?? '')
  if (sourceFile.parseDiagnostics.length) return false
  const bindings = staticBindings(sourceFile, 'import', modules.callingProjection)
  const calls = identifierCalls(sourceFile, capabilities.project)
  const importedModules = moduleSpecifiers(sourceFile)
  if (bindings.filter(binding => binding.imported === capabilities.project && binding.local === capabilities.project).length !== 1
    || calls.length !== 1 || !ts.isAwaitExpression(calls[0].parent)
    || calls[0].arguments.length !== 1 || !ts.isObjectLiteralExpression(unwrap(calls[0].arguments[0]))) return false
  const projection = unwrap(calls[0].arguments[0])
  const expectedFields = [
    'externalChatId', 'contactId', 'driverId', 'peer', 'callId', 'direction',
    'callStatus', 'durationSec', 'content', 'disposition', 'startedAt', 'endedAt',
  ].sort()
  const actualFields = projection.properties.map(property => property.name?.getText(sourceFile)).filter(Boolean).sort()
  const values = Object.fromEntries(projection.properties.map(property => [
    property.name?.getText(sourceFile),
    ts.isShorthandPropertyAssignment(property) ? property.name.getText(sourceFile)
      : ts.isPropertyAssignment(property) ? property.initializer.getText(sourceFile).replace(/\s+/g, '') : null,
  ]))
  return JSON.stringify(actualFields) === JSON.stringify(expectedFields)
    && JSON.stringify(values) === JSON.stringify({
      externalChatId: 'externalChatId',
      contactId: 'call.contactId',
      driverId: 'call.driverId??null',
      peer: 'peer',
      callId: 'call.id',
      direction: 'direction',
      callStatus: 'call.status',
      durationSec: 'call.durationSec??null',
      content: 'content',
      disposition: 'disposition',
      startedAt: 'call.startedAt',
      endedAt: 'call.endedAt??null',
    })
    && !importedModules.some(specifier => specifier.startsWith('@/modules/messaging/')
      || specifier.startsWith('@/contracts/messaging/') || specifier === modules.messageBus)
    && exactConsumer(sources, capabilities.project, {
      file: paths.esl,
      module: modules.callingProjection,
      kind: 'static',
      calls: 1,
    })
}
const exactMessagingProjector = (sources) => {
  const projector = parse(paths.messagingProjector, sources.get(paths.messagingProjector) ?? '')
  const application = parse(paths.messagingApplication, sources.get(paths.messagingApplication) ?? '')
  const publicIndex = parse(paths.messagingIndex, sources.get(paths.messagingIndex) ?? '')
  if ([projector, application, publicIndex].some(sourceFile => sourceFile.parseDiagnostics.length)) return false
  const typeBindings = staticBindings(projector, 'import', modules.projectorType, true)
  const factories = projector.statements.filter(statement => ts.isFunctionDeclaration(statement)
    && statement.name?.text === capabilities.factory && hasExport(statement))
  if (factories.length !== 1 || !factories[0].body) return false
  if (factories[0].parameters.length !== 1 || !isIdentifier(factories[0].parameters[0].name, 'dependencies')) return false
  const returns = factories[0].body.statements.filter(ts.isReturnStatement)
  const inner = returns.length === 1 ? unwrap(returns[0].expression) : null
  if (!inner || !ts.isArrowFunction(inner) || !inner.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    || inner.parameters.length !== 1 || !isIdentifier(inner.parameters[0].name, 'projection')
    || !ts.isBlock(inner.body) || inner.body.statements.length !== 2) return false
  const syncCalls = propertyCalls(projector, 'dependencies', 'sync')
  const broadcastCalls = propertyCalls(projector, 'dependencies', 'broadcast')
  if (syncCalls.length !== 1 || broadcastCalls.length !== 1 || !ts.isAwaitExpression(syncCalls[0].parent)) return false
  const syncArgument = syncCalls[0].arguments.length === 1 ? unwrap(syncCalls[0].arguments[0]) : null
  const resultStatement = inner.body.statements[0]
  const resultDeclaration = ts.isVariableStatement(resultStatement)
    && resultStatement.declarationList.declarations.length === 1
    ? resultStatement.declarationList.declarations[0] : null
  const resultInitializer = resultDeclaration ? unwrap(resultDeclaration.initializer) : null
  const resultAwait = resultInitializer && ts.isAwaitExpression(resultInitializer) ? unwrap(resultInitializer.expression) : null
  if (!resultDeclaration || !isIdentifier(resultDeclaration.name, 'result') || resultAwait !== syncCalls[0]) return false
  if (!syncArgument || !ts.isObjectLiteralExpression(syncArgument) || syncArgument.properties.length !== 2
    || !ts.isPropertyAssignment(syncArgument.properties[0])
    || syncArgument.properties[0].name.getText(projector) !== 'contract'
    || !isIdentifier(syncArgument.properties[0].initializer, 'SYNC_CALL_TIMELINE_COMMAND_V1')
    || !ts.isSpreadAssignment(syncArgument.properties[1])
    || !isIdentifier(syncArgument.properties[1].expression, 'projection')) return false
  const conditional = inner.body.statements[1]
  const condition = ts.isIfStatement(conditional) ? unwrap(conditional.expression) : null
  if (!condition || !ts.isBinaryExpression(condition)
    || condition.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken
    || !ts.isPropertyAccessExpression(unwrap(condition.left))
    || !isIdentifier(unwrap(condition.left).expression, 'result')
    || unwrap(condition.left).name.text !== 'action'
    || !ts.isStringLiteralLike(unwrap(condition.right))
    || unwrap(condition.right).text !== 'unchanged') return false
  const broadcast = broadcastCalls[0]
  if (broadcast.arguments.length !== 2 || !ts.isPropertyAccessExpression(unwrap(broadcast.arguments[0]))
    || !isIdentifier(unwrap(broadcast.arguments[0]).expression, 'result')
    || unwrap(broadcast.arguments[0]).name.text !== 'chatId'
    || !ts.isPropertyAccessExpression(unwrap(broadcast.arguments[1]))
    || !isIdentifier(unwrap(broadcast.arguments[1]).expression, 'result')
    || unwrap(broadcast.arguments[1]).name.text !== 'message') return false
  const thenCall = ts.isExpressionStatement(conditional.thenStatement)
    ? unwrap(conditional.thenStatement.expression) : null
  if (thenCall !== broadcast) return false

  const factoryImports = staticBindings(application, 'import', modules.projectorImplementation)
  const busImports = staticBindings(application, 'import', modules.messageBus)
  const compositionDeclarations = declarationsNamed(application, 'messagingCompletedCallTimelineProjector')
  if (factoryImports.filter(binding => binding.imported === capabilities.factory && binding.local === capabilities.factory).length !== 1
    || busImports.filter(binding => binding.imported === 'broadcastChatMessage' && binding.local === 'broadcastChatMessage').length !== 1
    || compositionDeclarations.length !== 1) return false
  const compositionCall = unwrap(compositionDeclarations[0].initializer)
  if (!compositionCall || !ts.isCallExpression(compositionCall)
    || !isIdentifier(compositionCall.expression, capabilities.factory) || compositionCall.arguments.length !== 1
    || !ts.isObjectLiteralExpression(unwrap(compositionCall.arguments[0]))) return false
  const dependencies = unwrap(compositionCall.arguments[0]).properties
  if (dependencies.length !== 2 || !dependencies.every(ts.isPropertyAssignment)) return false
  const dependencyMap = Object.fromEntries(dependencies.map(property => [
    property.name.getText(application),
    unwrap(property.initializer),
  ]))
  if (!isIdentifier(dependencyMap.sync, 'syncCallTimelineV1')
    || !isIdentifier(dependencyMap.broadcast, 'broadcastChatMessage')
    || identifierCalls(application, capabilities.factory).length !== 1) return false

  const wrappers = application.statements.filter(statement => ts.isFunctionDeclaration(statement)
    && statement.name?.text === capabilities.messagingProjector && hasExport(statement))
  if (wrappers.length !== 1 || !wrappers[0].body || wrappers[0].parameters.length !== 1
    || wrappers[0].body.statements.length !== 1 || !ts.isReturnStatement(wrappers[0].body.statements[0])) return false
  const parameter = wrappers[0].parameters[0]
  const wrapperCall = unwrap(wrappers[0].body.statements[0].expression)
  if (!parameter.dotDotDotToken || !isIdentifier(parameter.name, 'args') || !parameter.type
    || !ts.isTypeReferenceNode(parameter.type) || !isIdentifier(parameter.type.typeName, 'Parameters')
    || parameter.type.typeArguments?.length !== 1 || !ts.isTypeQueryNode(parameter.type.typeArguments[0])
    || !isIdentifier(parameter.type.typeArguments[0].exprName, 'messagingCompletedCallTimelineProjector')
    || !wrapperCall || !ts.isCallExpression(wrapperCall)
    || !isIdentifier(wrapperCall.expression, 'messagingCompletedCallTimelineProjector')
    || wrapperCall.arguments.length !== 1 || !ts.isSpreadElement(wrapperCall.arguments[0])
    || !isIdentifier(wrapperCall.arguments[0].expression, 'args')
    || identifierCalls(application, 'messagingCompletedCallTimelineProjector').length !== 1) return false

  const publicBindings = staticBindings(publicIndex, 'export', modules.messagingApplication)
  return ['CompletedCallTimelineProjectionV1', 'CompletedCallTimelineProjectorV1'].every(name => (
    typeBindings.filter(binding => binding.imported === name && binding.local === name && binding.typeOnly).length === 1
  ))
    && publicBindings.filter(binding => binding.imported === capabilities.messagingProjector
      && binding.local === capabilities.messagingProjector && !binding.typeOnly).length === 1
    && exactConsumer(sources, capabilities.factory, {
      file: paths.messagingApplication,
      module: modules.projectorImplementation,
      kind: 'static',
      calls: 1,
    })
    && exactConsumer(sources, capabilities.messagingProjector, {
      file: paths.instrumentation,
      module: modules.messagingPublic,
      kind: 'dynamic',
      calls: 0,
    })
}
const exactPlatformWiring = (sources) => {
  const sourceFile = parse(paths.instrumentation, sources.get(paths.instrumentation) ?? '')
  const callingIndex = parse(paths.callingIndex, sources.get(paths.callingIndex) ?? '')
  if (sourceFile.parseDiagnostics.length || callingIndex.parseDiagnostics.length) return false
  const callingExports = staticBindings(callingIndex, 'export', './completed-call-timeline-projection')
  if (![capabilities.project, capabilities.register].every(capability => (
    callingExports.filter(binding => binding.imported === capability && binding.local === capability && !binding.typeOnly).length === 1
  ))) return false
  const registrationCalls = identifierCalls(sourceFile, capabilities.register)
  const startCalls = identifierCalls(sourceFile, capabilities.start)
  if (registrationCalls.length !== 1 || startCalls.length !== 1
    || registrationCalls[0].arguments.length !== 1
    || !isIdentifier(registrationCalls[0].arguments[0], capabilities.messagingProjector)
    || startCalls[0].arguments.length !== 0 || !ts.isAwaitExpression(startCalls[0].parent)
    || registrationCalls[0].getStart(sourceFile) >= startCalls[0].getStart(sourceFile)) return false
  return exactConsumer(sources, capabilities.register, {
    file: paths.instrumentation,
    module: modules.callingPublic,
    kind: 'dynamic',
    calls: 1,
  }) && exactConsumer(sources, capabilities.start, {
    file: paths.instrumentation,
    module: modules.callingPublic,
    kind: 'dynamic',
    calls: 1,
  })
}
const exactTimelineAstBoundary = (sources) => exactEslProjection(sources)
  && exactMessagingProjector(sources)
  && exactPlatformWiring(sources)

const esl = read(paths.esl)
const callingPort = read(paths.callingPort)
const messagingProjector = read(paths.messagingProjector)
const callingManifest = JSON.parse(read('architecture/contexts/v1/manifests/calling.json'))
const messagingManifest = JSON.parse(read('architecture/contexts/v1/manifests/messaging.json'))
const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const policy = JSON.parse(read('architecture/enforcement/v1/policy.json'))
const currentAstBoundaryIsValid = exactTimelineAstBoundary(repositorySources)
const withSource = (sources, file, source) => new Map([...sources, [file, source]])
const projectionCall = `    await projectCompletedCallTimelineV1({
        externalChatId,
        contactId: call.contactId,
        driverId: call.driverId ?? null,
        peer,
        callId: call.id,
        direction,
        callStatus: call.status,
        durationSec: call.durationSec ?? null,
        content,
        disposition,
        startedAt: call.startedAt,
        endedAt: call.endedAt ?? null,
    })`
const commentProjectionCall = projectionCall.split('\n').map(line => `// ${line}`).join('\n')
const application = repositorySources.get(paths.messagingApplication) ?? ''
const failClosedAstProbes = [
  withSource(repositorySources, paths.esl, esl.replace(projectionCall, commentProjectionCall)),
  withSource(repositorySources, paths.messagingApplication, `${application}\nconst extraTimelineProjector = ${capabilities.factory}({ sync: syncCallTimelineV1, broadcast: broadcastChatMessage })\nvoid extraTimelineProjector\n`),
  withSource(repositorySources, paths.esl, esl.replace(modules.callingProjection, modules.messagingPublic)),
  new Map([...repositorySources, [
    'gravity-mvp/src/app/timeline-consumer-probe.ts',
    `import { ${capabilities.project} } from '${modules.callingProjection}'\nvoid ${capabilities.project}\n`,
  ]]),
]

check(
  'ESL depends only on the Calling-owned projection port',
  currentAstBoundaryIsValid,
  'Calling still reaches Messaging directly or the projection call/import is not exact',
)
check(
  'Calling projection port is narrow, validated and fail-closed',
  callingPort.includes('CompletedCallTimelineProjectionV1')
    && callingPort.includes('completed call timeline projector is not registered')
    && callingPort.includes('durationSec must be a finite non-negative number or null')
    && !/(prisma|messageStreamBus|syncCallTimeline|@\/modules\/messaging)/.test(callingPort),
  'Calling port widened or acquired a Messaging implementation dependency',
)
check(
  'Messaging owns exact sync and broadcast composition',
  exactMessagingProjector(repositorySources),
  'Messaging projector no longer preserves its exact imports, composition, wrapper, sync, or broadcast behavior',
)
check(
  'Platform Shell wires the sink before ESL starts',
  exactPlatformWiring(repositorySources),
  'ESL can start before its exact Messaging projection sink is registered',
)
check(
  'timeline AST boundary is fail-closed against spoofing and bypasses',
  currentAstBoundaryIsValid && failClosedAstProbes.length === 4
    && failClosedAstProbes.every(probe => !exactTimelineAstBoundary(probe)),
  'AST detector accepted a comment, extra composition operation, boundary bypass, or extra consumer',
)
const callingDependencies = new Set(callingManifest.allowed_dependencies.map((entry) => entry.context))
const messagingDependencies = new Set(messagingManifest.allowed_dependencies.map((entry) => entry.context))
check(
  'desired dependency direction remains Messaging to Calling',
  !callingDependencies.has('messaging') && messagingDependencies.has('calling')
    && callingManifest.public_surface.includes('CompletedCallTimelineProjectionPort.v1')
    && messagingManifest.public_surface.includes('CompletedCallTimelineProjector.v1'),
  'manifests legalized the former Calling to Messaging cycle or omitted the narrow surfaces',
)

const scan = await scanArchitecture(root)
const enforcement = evaluateFindings(scan.findings, registry, policy)
const eslMessagingFindings = scan.findings.filter((finding) =>
  finding.file === paths.esl && finding.target_context === 'messaging')
check(
  'detector finds no equivalent ESL to Messaging bypass',
  eslMessagingFindings.length === 0,
  JSON.stringify(eslMessagingFindings),
)
check(
  'the remediated messageStreamBus exception is retired',
  !registry.exceptions.some((entry) => entry.fingerprint === 'arch_de2f2d2400c2f4d5da3985e0'),
  'stale EslClient messageStreamBus exception remains',
)

process.stdout.write(`${JSON.stringify({
  status: failures.length === 0 ? 'PASS' : 'FAIL',
  checks,
  failures,
  ast_negative_probes: failClosedAstProbes.length,
  current_findings: scan.findings.length,
  current_registry_entries: registry.exceptions.length,
  strict_enforcement_ok: enforcement.ok,
}, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
