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
const publicRootSpecifier = '@/modules/fleet-operations/public/v1'
const capabilitySpecifier = `${publicRootSpecifier}/yandex-fleet-operations`
const allowedConsumerSpecifiers = new Set([publicRootSpecifier, capabilitySpecifier])
const localCapabilitySpecifier = './yandex-fleet-operations'
const shimPath = 'gravity-mvp/src/app/actions.ts'
const publicIndexPath = 'gravity-mvp/src/modules/fleet-operations/public/v1/index.ts'
const capabilityPath = 'gravity-mvp/src/modules/fleet-operations/public/v1/yandex-fleet-operations.ts'
const shimValueExports = [
  'addApiConnection',
  'changeDriverLimit',
  'deleteApiConnection',
  'getApiConnections',
  'getApiLogs',
  'getCarById',
  'getDriverById',
  'getDrivers',
  'testApiRequest',
  'updateApiConnectionName',
]
const shimTypeExports = ['Car', 'Driver', 'DriverStatus']
const consumerModel = new Map([
  ['gravity-mvp/src/modules/fleet-operations/public/v1/client-ui/ApiListClient.tsx', {
    imports: ['addApiConnection', 'deleteApiConnection', 'testApiRequest', 'updateApiConnectionName'],
    calls: { addApiConnection: 1, deleteApiConnection: 1, testApiRequest: 2, updateApiConnectionName: 1 },
  }],
  ['gravity-mvp/src/app/api/webhook/telegram/route.ts', {
    imports: ['changeDriverLimit'],
    calls: { changeDriverLimit: 2 },
  }],
  ['gravity-mvp/src/app/drivers/[id]/page.tsx', {
    imports: ['getCarById', 'getDriverById'],
    calls: { getCarById: 1, getDriverById: 1 },
  }],
  ['gravity-mvp/src/app/logs/page.tsx', {
    imports: ['getApiLogs'],
    calls: { getApiLogs: 1 },
  }],
  ['gravity-mvp/src/app/settings/api/page.tsx', {
    imports: ['getApiConnections'],
    calls: { getApiConnections: 1 },
  }],
  ['gravity-mvp/src/app/settings/integrations/telegram/TelegramManualLinkClient.tsx', {
    imports: ['getDrivers'],
    calls: { getDrivers: 0 },
  }],
])
const consumers = [...consumerModel.keys()]

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
const importBindings = (ast) => ast.statements.flatMap((statement) => {
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
const parseReExports = (ast) => ast.statements.flatMap((statement) => {
  if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteralLike(statement.moduleSpecifier)) return []
  return [{
    specifier: statement.moduleSpecifier.text,
    star: !statement.exportClause || !ts.isNamedExports(statement.exportClause),
    bindings: statement.exportClause && ts.isNamedExports(statement.exportClause)
      ? statement.exportClause.elements.map((element) => ({
        imported: element.propertyName?.text ?? element.name.text,
        exported: element.name.text,
        typeOnly: statement.isTypeOnly || element.isTypeOnly,
      }))
      : [],
  }]
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
const callsTo = (ast, name) => {
  const calls = []
  visit(ast, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) calls.push(node)
  })
  return calls
}
const assertNoIndirectUse = (ast, name) => {
  const bad = []
  visit(ast, (node) => {
    if (!ts.isIdentifier(node) || node.text !== name) return
    if (ts.isImportSpecifier(node.parent) && node.parent.name === node) return
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) return
    bad.push(node)
  })
  assert.equal(bad.length, 0, `${name}: indirect governed capability use`)
}
const exactReExport = (ast, specifier, expectedValues, expectedTypes) => {
  const declarations = parseReExports(ast).filter((declaration) => declaration.specifier === specifier)
  assert.equal(declarations.length, 2, `${specifier}: exact value/type export declarations`)
  assert(declarations.every((declaration) => !declaration.star), `${specifier}: wildcard export forbidden`)
  const values = declarations.flatMap((declaration) => declaration.bindings.filter((binding) => !binding.typeOnly))
  const types = declarations.flatMap((declaration) => declaration.bindings.filter((binding) => binding.typeOnly))
  assert(values.every((binding) => binding.imported === binding.exported))
  assert(types.every((binding) => binding.imported === binding.exported))
  assert.deepEqual(values.map((binding) => binding.imported).sort(), [...expectedValues].sort())
  assert.deepEqual(types.map((binding) => binding.imported).sort(), [...expectedTypes].sort())
}

const sourcePaths = walk(path.join(root, 'gravity-mvp/src'))
  .map(relative)
  .filter((file) => !/(?:^|\/)__tests__\/|\.(?:test|spec)\.tsx?$/.test(file))
const baseSources = new Map(sourcePaths.map((file) => [file, read(file)]))

function assertConsumerModel(overrides = new Map()) {
  const sourceFor = (file) => overrides.get(file) ?? baseSources.get(file) ?? read(file)
  const observed = new Map()
  for (const file of sourcePaths) {
    const ast = parse(file, sourceFor(file))
    const relevant = importBindings(ast).filter((binding) => shimValueExports.includes(binding.imported))
    if (relevant.length > 0) observed.set(file, { ast, relevant })
  }
  assert.deepEqual([...observed.keys()].sort(), [...consumerModel.keys()].sort(), 'repo-wide root/deep Yandex consumer denominator')
  const allImported = []
  for (const [file, expected] of consumerModel) {
    const { ast, relevant } = observed.get(file)
    assert.equal(relevant.length, expected.imports.length, `${file}: exact governed import count`)
    assert(relevant.every((binding) => (
      allowedConsumerSpecifiers.has(binding.specifier)
      && !binding.typeOnly
      && binding.imported === binding.local
    )), `${file}: root/deep named import only`)
    assert.deepEqual(relevant.map((binding) => binding.imported).sort(), [...expected.imports].sort(), `${file}: import symbol map`)
    allImported.push(...relevant.map((binding) => binding.imported))
    for (const [name, count] of Object.entries(expected.calls)) {
      const calls = callsTo(ast, name)
      assert.equal(calls.length, count, `${file}: ${name} call denominator`)
      assert(calls.every((call) => !syntacticallyDead(call)), `${file}: ${name} dead-code call`)
      assertNoIndirectUse(ast, name)
    }
  }
  assert.equal(allImported.length, 10, 'ten governed import bindings')
  assert.deepEqual(allImported.sort(), [...shimValueExports].sort(), 'all ten governed symbols imported exactly once')
}
const acceptsConsumerModel = (overrides) => {
  try {
    assertConsumerModel(overrides)
    return true
  } catch {
    return false
  }
}

const apiSettingsPage = read('gravity-mvp/src/app/settings/api/page.tsx')
const apiSettingsAst = parse('gravity-mvp/src/app/settings/api/page.tsx', apiSettingsPage)
assert(apiSettingsAst.statements.some((statement) => (
  ts.isImportDeclaration(statement)
  && statement.moduleSpecifier.text === '@/modules/fleet-operations/public/v1/client-ui/ApiListClient'
)))
const apiClientPath = consumers[0]
const apiClient = baseSources.get(apiClientPath)
assert.equal(sha256(apiClient), '160bd1468acf4712d90f9b9f6f4bbef3ef3de0b670f0b1c668858874cf90309c')
const apiClientAst = parse(apiClientPath, apiClient)
const defaultFunctions = apiClientAst.statements.filter((statement) => (
  ts.isFunctionDeclaration(statement)
  && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
))
assert.deepEqual(defaultFunctions.map((statement) => statement.name?.text), ['ApiListClient'])
assert.doesNotMatch(apiClient, /conn\.apiKey\b|from ["']@prisma\/client["']|export \*/)

assertConsumerModel()
const shim = read(shimPath)
const shimAst = parse(shimPath, shim)
assert.equal(shimAst.statements.length, 3, 'shim has directive plus exact value/type exports')
const directive = shimAst.statements[0]
assert(ts.isExpressionStatement(directive) && ts.isStringLiteralLike(directive.expression) && directive.expression.text === 'use server')
exactReExport(shimAst, publicRootSpecifier, shimValueExports, shimTypeExports)
const publicIndex = read(publicIndexPath)
const publicIndexAst = parse(publicIndexPath, publicIndex)
exactReExport(publicIndexAst, localCapabilitySpecifier, shimValueExports, shimTypeExports)

const firstCallSource = apiClient
const removedCall = firstCallSource.replace('await testApiRequest(conn.id)', 'await removedTestApiRequest(conn.id)')
const consumerProbes = [
  new Map([[apiClientPath, `${removedCall}\n// await testApiRequest(conn.id)\n`]]),
  new Map([[apiClientPath, `${removedCall}\nif (false) { void testApiRequest('') }\n`]]),
  new Map([[apiClientPath, firstCallSource.replace(capabilitySpecifier, '@/app/actions')]]),
  new Map([[apiClientPath, removedCall]]),
  new Map([[apiClientPath, `${firstCallSource}\nvoid testApiRequest('')\n`]]),
  new Map([[apiClientPath, `${firstCallSource}\nimport { getDrivers } from '${publicRootSpecifier}'\n`]]),
]
assert(consumerProbes.every((probe) => !acceptsConsumerModel(probe)), 'comment/dead-code/bypass/root-or-deep denominator probes must fail')

const shimProbes = [
  shim.replaceAll(publicRootSpecifier, capabilitySpecifier),
  shim.replace('export {', `export * from '${publicRootSpecifier}'\nexport {`),
  shim.replace('  getDrivers,\n', ''),
]
assert(shimProbes.every((source) => {
  try {
    const ast = parse(shimPath, source)
    assert.equal(ast.statements.length, 3)
    exactReExport(ast, publicRootSpecifier, shimValueExports, shimTypeExports)
    return false
  } catch {
    return true
  }
}), 'shim bypass/wildcard/denominator probes must fail')

const capability = read(capabilityPath)
const capabilityAst = parse(capabilityPath, capability)
const capabilityDirective = capabilityAst.statements[0]
assert(ts.isExpressionStatement(capabilityDirective) && ts.isStringLiteralLike(capabilityDirective.expression) && capabilityDirective.expression.text === 'use server')
assert(importBindings(capabilityAst).some((binding) => binding.imported === 'requireIntegrationAdminAccess'))
assert(importBindings(capabilityAst).some((binding) => binding.imported === 'getYandexConnectionCredentialsV1'))
assert.doesNotMatch(capability, /prisma\.apiConnection\.(?:create|update|delete)|prisma\.apiLog\.(?:create|deleteMany)/)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/fleet_operations.json'))
assert(manifest.public_surface.includes('YandexFleetOperations.v1'))
assert(manifest.public_surface.includes('ApiConnectionClientUi.v1'))
const scan = await scanArchitecture(root)
const boundaryFiles = [...consumers, shimPath]
assert.deepEqual(scan.findings.filter((finding) => (
  boundaryFiles.includes(finding.file)
  && (finding.details?.target === shimPath
    || finding.details?.target?.endsWith('/modules/fleet-operations/public/v1/index.ts')
    || finding.details?.target?.endsWith('/modules/fleet-operations/public/v1/yandex-fleet-operations.ts'))
)), [])
const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const live = new Set(scan.findings.map((finding) => finding.fingerprint))
assert.equal(registry.exceptions.filter((entry) => (
  boundaryFiles.includes(entry.file) && !live.has(entry.fingerprint)
)).length, 0)

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  consumers: consumers.length,
  consumer_symbols: shimValueExports.length,
  shim_value_exports: shimValueExports.length,
  shim_type_exports: shimTypeExports.length,
  negative_probes: consumerProbes.length + shimProbes.length,
  current_findings: scan.findings.length,
  registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
