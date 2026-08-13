#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const compositionPath = 'gravity-mvp/src/infrastructure/fleet/driver-max-messaging.ts'
const ownerIndexPath = 'gravity-mvp/src/modules/max-channel/public/v1/index.ts'
const ownerCapabilityPath = 'gravity-mvp/src/modules/max-channel/public/v1/driver-messaging-capability.ts'
const infrastructureSpecifier = '@/infrastructure/fleet/driver-max-messaging'
const ownerSpecifier = '@/modules/max-channel/public/v1'
const governedSymbols = ['listMaxDriverDeliveryConnectionsV1', 'sendMaxDriverMessageV1']
const expectedImports = new Map([
  [compositionPath, {
    specifier: ownerSpecifier,
    bindings: {
      listMaxDriverDeliveryConnectionsV1: 'listMaxOwnedDriverDeliveryConnectionsV1',
      sendMaxDriverMessageV1: 'sendMaxOwnedDriverMessageV1',
    },
    calls: { listMaxOwnedDriverDeliveryConnectionsV1: 1, sendMaxOwnedDriverMessageV1: 1 },
  }],
  ['gravity-mvp/src/app/drivers/DriversClient.tsx', {
    specifier: infrastructureSpecifier,
    bindings: { sendMaxDriverMessageV1: 'sendMaxDriverMessageV1' },
    calls: { sendMaxDriverMessageV1: 1 },
  }],
  ['gravity-mvp/src/app/drivers/[id]/page.tsx', {
    specifier: infrastructureSpecifier,
    bindings: { listMaxDriverDeliveryConnectionsV1: 'listMaxDriverDeliveryConnectionsV1' },
    calls: { listMaxDriverDeliveryConnectionsV1: 1 },
  }],
  ['gravity-mvp/src/app/drivers/cards/CardsClient.tsx', {
    specifier: infrastructureSpecifier,
    bindings: { sendMaxDriverMessageV1: 'sendMaxDriverMessageV1' },
    calls: { sendMaxDriverMessageV1: 1 },
  }],
])
const consumers = [...expectedImports.keys()].filter((file) => file !== compositionPath)

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
  }))
})
const literalFalse = (expression) => expression.kind === ts.SyntaxKind.FalseKeyword
  || (ts.isNumericLiteral(expression) && Number(expression.text) === 0)
const syntacticallyDead = (node) => {
  for (let child = node, current = node.parent; current; child = current, current = current.parent) {
    if (ts.isIfStatement(current)) {
      if (literalFalse(current.expression) && child === current.thenStatement) return true
      if (current.expression.kind === ts.SyntaxKind.TrueKeyword && child === current.elseStatement) return true
    }
    if ((ts.isWhileStatement(current) || ts.isDoStatement(current)) && literalFalse(current.expression)) return true
    if (ts.isConditionalExpression(current)) {
      if (literalFalse(current.condition) && child === current.whenTrue) return true
      if (current.condition.kind === ts.SyntaxKind.TrueKeyword && child === current.whenFalse) return true
    }
  }
  return false
}
const identifierCalls = (ast, name) => {
  const calls = []
  visit(ast, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) calls.push(node)
  })
  return calls
}
const namedReExports = (ast, specifier) => ast.statements.flatMap((statement) => {
  if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || statement.moduleSpecifier.text !== specifier) return []
  assert(statement.exportClause && ts.isNamedExports(statement.exportClause), 'wildcard export is forbidden')
  return statement.exportClause.elements.map((element) => ({
    imported: element.propertyName?.text ?? element.name.text,
    exported: element.name.text,
    typeOnly: statement.isTypeOnly || element.isTypeOnly,
  }))
})
const exportedFunction = (ast, name) => ast.statements.filter((statement) => (
  ts.isFunctionDeclaration(statement)
  && statement.name?.text === name
  && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
))
const assertSimpleDelegate = (ast, name, target, parameters) => {
  const functions = exportedFunction(ast, name)
  assert.equal(functions.length, 1, `${name}: exact exported wrapper`)
  const declaration = functions[0]
  assert(declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword), `${name}: async wrapper`)
  assert.deepEqual(declaration.parameters.map((parameter) => parameter.name.getText(ast)), parameters)
  assert.equal(declaration.body?.statements.length, 1, `${name}: one executable statement`)
  const returned = declaration.body.statements[0]
  assert(ts.isReturnStatement(returned) && returned.expression && ts.isCallExpression(returned.expression), `${name}: direct return delegate`)
  assert(ts.isIdentifier(returned.expression.expression) && returned.expression.expression.text === target, `${name}: exact delegate target`)
  assert.deepEqual(returned.expression.arguments.map((argument) => argument.getText(ast)), parameters)
}

const allSourcePaths = walk(path.join(root, 'gravity-mvp/src'))
  .map(relative)
  .filter((file) => !/(?:^|\/)__tests__\/|\.(?:test|spec)\.tsx?$/.test(file))
const baseSources = new Map(allSourcePaths.map((file) => [file, read(file)]))

function assertBoundaryModel(overrides = new Map()) {
  const sourceFor = (file) => overrides.get(file) ?? baseSources.get(file) ?? read(file)
  const observed = new Map()
  for (const file of allSourcePaths) {
    const ast = parse(file, sourceFor(file))
    const relevant = namedImports(ast).filter((binding) => governedSymbols.includes(binding.imported))
    if (relevant.length > 0) observed.set(file, { ast, relevant })
  }
  assert.deepEqual([...observed.keys()].sort(), [...expectedImports.keys()].sort(), 'repo-wide MAX consumer denominator')
  for (const [file, expected] of expectedImports) {
    const { ast, relevant } = observed.get(file)
    assert.equal(relevant.length, Object.keys(expected.bindings).length, `${file}: exact import binding count`)
    assert(relevant.every((binding) => !binding.typeOnly && binding.specifier === expected.specifier), `${file}: exact entrypoint`)
    assert.deepEqual(
      Object.fromEntries(relevant.map((binding) => [binding.imported, binding.local]).sort()),
      expected.bindings,
      `${file}: exact named imports and aliases`,
    )
    for (const [local, count] of Object.entries(expected.calls)) {
      const calls = identifierCalls(ast, local)
      assert.equal(calls.length, count, `${file}: ${local} call denominator`)
      assert(calls.every((call) => !syntacticallyDead(call)), `${file}: ${local} has a dead-code call`)
    }
  }

  const compositionAst = parse(compositionPath, sourceFor(compositionPath))
  const directive = compositionAst.statements[0]
  assert(ts.isExpressionStatement(directive) && ts.isStringLiteralLike(directive.expression) && directive.expression.text === 'use server')
  assertSimpleDelegate(compositionAst, 'listMaxDriverDeliveryConnectionsV1', 'listMaxOwnedDriverDeliveryConnectionsV1', [])
  assertSimpleDelegate(compositionAst, 'sendMaxDriverMessageV1', 'sendMaxOwnedDriverMessageV1', ['phone', 'message', 'options'])

  const ownerIndexAst = parse(ownerIndexPath, sourceFor(ownerIndexPath))
  assert.deepEqual(namedReExports(ownerIndexAst, './driver-messaging-capability'), [
    { imported: 'listMaxDriverDeliveryConnectionsV1', exported: 'listMaxDriverDeliveryConnectionsV1', typeOnly: false },
    { imported: 'sendMaxDriverMessageV1', exported: 'sendMaxDriverMessageV1', typeOnly: false },
    { imported: 'MaxDriverMessageOptionsV1', exported: 'MaxDriverMessageOptionsV1', typeOnly: true },
  ])

  const ownerAst = parse(ownerCapabilityPath, sourceFor(ownerCapabilityPath))
  assertSimpleDelegate(ownerAst, 'listMaxDriverDeliveryConnectionsV1', 'getMaxConnections', [])
  assertSimpleDelegate(ownerAst, 'sendMaxDriverMessageV1', 'sendMaxMessage', ['phone', 'message', 'options'])
}
const acceptsBoundaryModel = (overrides) => {
  try {
    assertBoundaryModel(overrides)
    return true
  } catch {
    return false
  }
}

assertBoundaryModel()
for (const consumer of consumers) {
  assert.doesNotMatch(read(consumer), /(?:\.\.\/)*max-actions|@\/app\/max-actions/)
}
const composition = read(compositionPath)
assert.doesNotMatch(composition, /export \*|Record<|\bany\b|execute|invoke|@\/app\/max-actions/)
const ownerCapability = read(ownerCapabilityPath)
assert.doesNotMatch(ownerCapability, /export \*|Record<|\bany\b|execute|invoke/)

const sendConsumer = consumers[0]
const sendSource = baseSources.get(sendConsumer)
const removedCall = sendSource.replace('await sendMaxDriverMessageV1(', 'await removedMaxDriverMessageV1(')
const probes = [
  new Map([[sendConsumer, `${removedCall}\n// await sendMaxDriverMessageV1(phone, message)\n`]]),
  new Map([[sendConsumer, `${removedCall}\nif (false) { void sendMaxDriverMessageV1('', '') }\n`]]),
  new Map([[sendConsumer, sendSource.replace(infrastructureSpecifier, ownerSpecifier)]]),
  new Map([[sendConsumer, removedCall]]),
  new Map([[sendConsumer, `${sendSource}\nvoid sendMaxDriverMessageV1('', '')\n`]]),
]
assert(probes.every((probe) => !acceptsBoundaryModel(probe)), 'comment/dead-code/bypass/denominator probes must fail')

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
assert.equal(registry.exceptions.filter((entry) => (
  consumers.includes(entry.file) && entry.target_context === 'max_channel'
)).length, 0)
const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
  consumers.includes(finding.file) && finding.target_context === 'max_channel'
)), [])
process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  consumers: consumers.length,
  governed_symbols: governedSymbols.length,
  negative_probes: probes.length,
  closed_findings: 12,
  current_findings: scan.findings.length,
  registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
