#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPath = 'gravity-mvp/src/lib/TransportRegistry.ts'
const healthPath = 'gravity-mvp/src/modules/messaging/public/v1/transport-registry-health.ts'
const lifecyclePath = 'gravity-mvp/src/modules/messaging/public/v1/transport-registry-lifecycle.ts'
const projectionPath = 'gravity-mvp/src/modules/messaging/public/v1/transport-registry-types.ts'
const compatibilityProjectionPath = 'gravity-mvp/src/modules/messaging/internal/transport-registry-projection.ts'
const implementationSpecifier = '@/lib/TransportRegistry'
const healthSpecifier = '@/modules/messaging/public/v1/transport-registry-health'
const lifecycleSpecifier = '@/modules/messaging/public/v1/transport-registry-lifecycle'
const healthSymbol = 'transportRegistryHealthV1'
const lifecycleSymbol = 'transportRegistryLifecycleV1'
const healthCapabilities = ['getAllEntries', 'getDegradedDuration']
const lifecycleCapabilities = [
  'beginNewInstance',
  'ensureEntry',
  'getAllEntries',
  'getDegradedDuration',
  'getEntry',
  'getInstanceId',
  'isCurrentInstance',
  'scheduleReconnect',
  'setFailed',
  'setReady',
  'setReconnecting',
  'setStopped',
  'touch',
  'touchLastSeen',
]
const consumerModel = new Map([
  ['gravity-mvp/src/app/api/health/route.ts', {
    symbol: healthSymbol,
    local: healthSymbol,
    specifier: healthSpecifier,
    calls: { getAllEntries: 1, getDegradedDuration: 1 },
  }],
  ['gravity-mvp/src/app/api/transport/health/route.ts', {
    symbol: healthSymbol,
    local: healthSymbol,
    specifier: healthSpecifier,
    calls: { getAllEntries: 1 },
  }],
  ['gravity-mvp/src/app/tg-actions.ts', {
    symbol: lifecycleSymbol,
    local: 'registry',
    specifier: lifecycleSpecifier,
    calls: {
      beginNewInstance: 1,
      ensureEntry: 1,
      getAllEntries: 1,
      getDegradedDuration: 1,
      getEntry: 1,
      scheduleReconnect: 1,
      setReady: 1,
      setReconnecting: 1,
      touch: 3,
    },
  }],
  ['gravity-mvp/src/lib/whatsapp/WhatsAppService.ts', {
    symbol: lifecycleSymbol,
    local: 'registry',
    specifier: lifecycleSpecifier,
    calls: {
      beginNewInstance: 1,
      ensureEntry: 1,
      getAllEntries: 3,
      getEntry: 3,
      getInstanceId: 2,
      isCurrentInstance: 9,
      scheduleReconnect: 2,
      setFailed: 10,
      setReady: 1,
      setReconnecting: 2,
      setStopped: 1,
      touch: 5,
      touchLastSeen: 1,
    },
  }],
])
const healthConsumers = [...consumerModel].filter(([, model]) => model.symbol === healthSymbol).map(([file]) => file)
const lifecycleConsumers = [...consumerModel].filter(([, model]) => model.symbol === lifecycleSymbol).map(([file]) => file)

const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const absolute = path.join(directory, entry.name)
  return entry.isDirectory() ? walk(absolute) : (/\.tsx?$/.test(entry.name) ? [absolute] : [])
})
const relative = (absolute) => path.relative(root, absolute).split(path.sep).join('/')
const parse = (file, source) => {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  assert.equal(ast.parseDiagnostics.length, 0, `${file}: TypeScript parse diagnostics`)
  return ast
}
const visit = (node, visitor) => {
  visitor(node)
  ts.forEachChild(node, (child) => visit(child, visitor))
}
const namedImports = (ast) => ast.statements.flatMap((statement) => {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) return []
  const bindings = statement.importClause?.namedBindings
  if (!bindings || !ts.isNamedImports(bindings)) return []
  return bindings.elements.map((element) => ({
    specifier: statement.moduleSpecifier.text,
    imported: element.propertyName?.text ?? element.name.text,
    local: element.name.text,
    typeOnly: statement.importClause?.isTypeOnly || element.isTypeOnly,
    node: element.name,
  }))
})
const falseLiteral = (node) => node.kind === ts.SyntaxKind.FalseKeyword
  || (ts.isNumericLiteral(node) && Number(node.text) === 0)
const syntacticallyDead = (node) => {
  for (let child = node, current = node.parent; current; child = current, current = current.parent) {
    if (ts.isIfStatement(current)) {
      if (falseLiteral(current.expression) && child === current.thenStatement) return true
      if (current.expression.kind === ts.SyntaxKind.TrueKeyword && child === current.elseStatement) return true
    }
    if ((ts.isWhileStatement(current) || ts.isDoStatement(current)) && falseLiteral(current.expression)) return true
  }
  return false
}
const identifierCalls = (node, name) => {
  const calls = []
  visit(node, (candidate) => {
    if (ts.isCallExpression(candidate) && ts.isIdentifier(candidate.expression) && candidate.expression.text === name) calls.push(candidate)
  })
  return calls
}
const memberCalls = (ast, receiver) => {
  const calls = []
  visit(ast, (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === receiver
    ) calls.push({ member: node.expression.name.text, node })
  })
  return calls
}
const assertNoIndirectReceiverUse = (ast, receiver) => {
  const bad = []
  visit(ast, (node) => {
    if (!ts.isIdentifier(node) || node.text !== receiver) return
    if (ts.isImportSpecifier(node.parent) && node.parent.name === node) return
    if (
      ts.isPropertyAccessExpression(node.parent)
      && node.parent.expression === node
      && ts.isCallExpression(node.parent.parent)
      && node.parent.parent.expression === node.parent
    ) return
    bad.push(node)
  })
  assert.equal(bad.length, 0, `${receiver}: indirect/computed capability use`)
}
const frozenObject = (ast, variableName) => {
  const declarations = ast.statements.flatMap((statement) => (
    ts.isVariableStatement(statement)
    && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ? [...statement.declarationList.declarations]
      : []
  )).filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === variableName)
  assert.equal(declarations.length, 1, `${variableName}: one exported capability object`)
  const initializer = declarations[0].initializer
  assert(initializer && ts.isCallExpression(initializer), `${variableName}: Object.freeze call`)
  assert(ts.isPropertyAccessExpression(initializer.expression) && initializer.expression.getText(ast) === 'Object.freeze')
  assert.equal(initializer.arguments.length, 1)
  assert(ts.isObjectLiteralExpression(initializer.arguments[0]), `${variableName}: frozen literal`)
  return initializer.arguments[0]
}
const staticName = (name) => ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined

const sourcePaths = walk(path.join(root, 'gravity-mvp/src'))
  .map(relative)
  .filter((file) => !/(?:^|\/)__tests__\/|\.(?:test|spec)\.tsx?$/.test(file))
const baseSources = new Map(sourcePaths.map((file) => [file, read(file)]))

function assertCapabilitySurface(file, source, variableName, expectedCapabilities) {
  const ast = parse(file, source)
  const implementationImports = namedImports(ast).filter((binding) => binding.specifier === implementationSpecifier && !binding.typeOnly)
  assert.deepEqual(implementationImports.map((binding) => binding.imported).sort(), [...expectedCapabilities].sort(), `${file}: exact owner imports`)
  assert(implementationImports.every((binding) => binding.imported === binding.local), `${file}: owner imports cannot alias`)
  const literal = frozenObject(ast, variableName)
  assert(literal.properties.every(ts.isPropertyAssignment), `${file}: no spreads, methods, accessors or shorthands`)
  assert.deepEqual(literal.properties.map((property) => staticName(property.name)).sort(), [...expectedCapabilities].sort(), `${file}: exact capability keys`)
  for (const property of literal.properties) {
    const name = staticName(property.name)
    assert(name && ts.isArrowFunction(property.initializer), `${file}: ${name} exact arrow wrapper`)
    const calls = identifierCalls(property.initializer, name)
    assert.equal(calls.length, 1, `${file}: ${name} one owner call`)
    assert(calls.every((call) => !syntacticallyDead(call)), `${file}: ${name} dead owner call`)
  }
}

function assertConsumerModel(overrides = new Map()) {
  const sourceFor = (file) => overrides.get(file) ?? baseSources.get(file) ?? read(file)
  const observed = []
  for (const file of sourcePaths) {
    const ast = parse(file, sourceFor(file))
    const imports = namedImports(ast).filter((binding) => [healthSymbol, lifecycleSymbol].includes(binding.imported))
    if (imports.length > 0) observed.push({ file, ast, imports })
  }
  assert.deepEqual(observed.map(({ file }) => file).sort(), [...consumerModel.keys()].sort(), 'repo-wide transport consumer denominator')
  for (const { file, ast, imports } of observed) {
    const expected = consumerModel.get(file)
    assert.deepEqual(imports.map(({ node: _node, ...binding }) => binding), [{
      specifier: expected.specifier,
      imported: expected.symbol,
      local: expected.local,
      typeOnly: false,
    }], `${file}: exact capability import`)
    assertNoIndirectReceiverUse(ast, expected.local)
    const calls = memberCalls(ast, expected.local)
    const observedCounts = Object.fromEntries([...new Set(calls.map(({ member }) => member))]
      .sort()
      .map((member) => [member, calls.filter((call) => call.member === member).length]))
    assert.deepEqual(observedCounts, expected.calls, `${file}: exact per-symbol call map`)
    assert(calls.every(({ node }) => !syntacticallyDead(node)), `${file}: syntactically dead registry call`)
  }
}
const acceptsConsumerModel = (overrides) => {
  try {
    assertConsumerModel(overrides)
    return true
  } catch {
    return false
  }
}

assert.equal(sha256(read(implementationPath)), '7b3333eea11b397ea577061d77a7f98569c692f4bf13ace6ceb6db1bcefe8937')
const healthSource = read(healthPath)
const lifecycleSource = read(lifecyclePath)
assertCapabilitySurface(healthPath, healthSource, healthSymbol, healthCapabilities)
assertCapabilitySurface(lifecyclePath, lifecycleSource, lifecycleSymbol, lifecycleCapabilities)
assertConsumerModel()

const projectionSource = read(projectionPath)
const projectionAst = parse(projectionPath, projectionSource)
const projectionFunctions = projectionAst.statements.filter((statement) => (
  ts.isFunctionDeclaration(statement)
  && statement.name?.text === 'projectTransportConnectionEntryV1'
  && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
))
assert.equal(projectionFunctions.length, 1)
assert.equal(projectionFunctions[0].body?.statements.length, 1)
const projectionReturn = projectionFunctions[0].body.statements[0]
assert(ts.isReturnStatement(projectionReturn) && projectionReturn.expression && ts.isCallExpression(projectionReturn.expression))
assert(ts.isPropertyAccessExpression(projectionReturn.expression.expression) && projectionReturn.expression.expression.getText(projectionAst) === 'Object.freeze')
assert.equal(projectionReturn.expression.arguments.length, 1)
assert(ts.isObjectLiteralExpression(projectionReturn.expression.arguments[0]))
const projectionProperties = projectionReturn.expression.arguments[0].properties
assert(projectionProperties.every(ts.isPropertyAssignment))
assert.deepEqual(Object.fromEntries(projectionProperties.map((property) => [
  staticName(property.name),
  property.initializer.getText(projectionAst).replace(/\s+/g, ''),
])), {
  connectionId: 'entry.connectionId',
  channel: 'entry.channel',
  instanceId: 'entry.instanceId',
  state: 'entry.state',
  lastSeen: 'entry.lastSeen?newDate(entry.lastSeen):null',
  lastError: 'entry.lastError',
  retryAttempt: 'entry.retryAttempt',
  startedAt: 'newDate(entry.startedAt)',
  readyAt: 'entry.readyAt?newDate(entry.readyAt):null',
  reconnectInFlight: 'entry.reconnectInFlight',
  degradedAt: 'entry.degradedAt?newDate(entry.degradedAt):null',
})
const compatibilityAst = parse(compatibilityProjectionPath, read(compatibilityProjectionPath))
assert.equal(compatibilityAst.statements.length, 1)
const compatibilityExport = compatibilityAst.statements[0]
assert(ts.isExportDeclaration(compatibilityExport) && compatibilityExport.moduleSpecifier?.text === '../public/v1/transport-registry-types')
assert(compatibilityExport.exportClause && ts.isNamedExports(compatibilityExport.exportClause))
assert.deepEqual(compatibilityExport.exportClause.elements.map((element) => element.name.text), ['projectTransportConnectionEntryV1'])

const healthConsumer = healthConsumers[0]
const healthConsumerSource = baseSources.get(healthConsumer)
const removedCall = healthConsumerSource.replace('transportRegistryHealthV1.getAllEntries()', 'removedTransportRegistryHealthV1.getAllEntries()')
const consumerProbes = [
  new Map([[healthConsumer, `${removedCall}\n// transportRegistryHealthV1.getAllEntries()\n`]]),
  new Map([[healthConsumer, `${removedCall}\nif (false) { void transportRegistryHealthV1.getAllEntries() }\n`]]),
  new Map([[healthConsumer, healthConsumerSource.replace(healthSpecifier, implementationSpecifier)]]),
  new Map([[healthConsumer, removedCall]]),
  new Map([[healthConsumer, `${healthConsumerSource}\nvoid transportRegistryHealthV1.getAllEntries()\n`]]),
]
assert(consumerProbes.every((probe) => !acceptsConsumerModel(probe)), 'comment/dead-code/bypass/denominator probes must fail')
const surfaceProbes = [
  `${healthSource.replace('    getDegradedDuration:', '    removedGetDegradedDuration:')}\n// getDegradedDuration: (id) => getDegradedDuration(id)\n`,
  healthSource.replace(/\n\}\)\s*$/u, '\n    setStopped: (id: string) => setStopped(id),\n})\n'),
]
assert(surfaceProbes.every((source) => {
  try {
    assertCapabilitySurface(healthPath, source, healthSymbol, healthCapabilities)
    return false
  } catch {
    return true
  }
}), 'capability comment/addition probes must fail')

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/messaging.json'))
assert(manifest.public_surface.includes('TransportRegistryHealth.v1'))
assert(manifest.public_surface.includes('TransportRegistryLifecycle.v1'))
const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
  [...healthConsumers, ...lifecycleConsumers].includes(finding.file)
  && finding.details?.target === implementationPath
)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  health_consumers: healthConsumers.length,
  lifecycle_consumers: lifecycleConsumers.length,
  health_capabilities: healthCapabilities.length,
  lifecycle_capabilities: lifecycleCapabilities.length,
  negative_probes: consumerProbes.length + surfaceProbes.length,
  mutable_entry_exposure: 'ABSENT',
  dependency_cycle: 'ABSENT',
  current_findings: scan.findings.length,
}, null, 2)}\n`)
