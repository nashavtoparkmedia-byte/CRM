#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const oldPath = 'gravity-mvp/src/lib/dictionaries/dictionary-service.ts'
const publicPath = 'gravity-mvp/src/modules/work-management/public/v1/task-dictionary-catalog.ts'
const storePath = 'gravity-mvp/src/modules/work-management/internal/task-dictionary-store.ts'
const applicationPath = 'gravity-mvp/src/modules/work-management/application/task-dictionary-operations.ts'
const taskConsumerPath = 'gravity-mvp/src/app/tasks/components/TaskDetailsPane.tsx'
const settingsConsumerPath = 'gravity-mvp/src/app/settings/dictionaries/page.tsx'
const publicSpecifier = '@/modules/work-management/public/v1/task-dictionary-catalog'
const exactCapabilities = [
  'addTaskDictionaryItemV1',
  'deleteTaskDictionaryItemV1',
  'getTaskDictionariesV1',
  'updateTaskDictionaryItemV1',
]
const consumerModel = new Map([
  [taskConsumerPath, {
    imports: ['getTaskDictionariesV1'],
    calls: { getTaskDictionariesV1: 1 },
  }],
  [settingsConsumerPath, {
    imports: exactCapabilities,
    calls: {
      addTaskDictionaryItemV1: 1,
      deleteTaskDictionaryItemV1: 1,
      getTaskDictionariesV1: 1,
      updateTaskDictionaryItemV1: 1,
    },
  }],
])

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
const exportedFunctions = (ast) => ast.statements.filter((statement) => (
  ts.isFunctionDeclaration(statement)
  && statement.name
  && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
))
const assertFunctionDelegate = (ast, name, target, parameters) => {
  const declarations = exportedFunctions(ast).filter((declaration) => declaration.name.text === name)
  assert.equal(declarations.length, 1, `${name}: exact public wrapper`)
  const declaration = declarations[0]
  assert(declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword), `${name}: async`)
  assert.deepEqual(declaration.parameters.map((parameter) => parameter.name.getText(ast)), parameters)
  assert.equal(declaration.body?.statements.length, 1, `${name}: one executable statement`)
  const returned = declaration.body.statements[0]
  assert(ts.isReturnStatement(returned) && returned.expression && ts.isCallExpression(returned.expression), `${name}: return call`)
  assert(ts.isIdentifier(returned.expression.expression) && returned.expression.expression.text === target, `${name}: target`)
  assert.deepEqual(returned.expression.arguments.map((argument) => argument.getText(ast)), parameters)
}
const assertArrowDelegate = (ast, name, target, parameters) => {
  const declarations = ast.statements.flatMap((statement) => (
    ts.isVariableStatement(statement)
    && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ? [...statement.declarationList.declarations]
      : []
  )).filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name)
  assert.equal(declarations.length, 1, `${name}: exact application wrapper`)
  const arrow = declarations[0].initializer
  assert(arrow && ts.isArrowFunction(arrow) && ts.isCallExpression(arrow.body), `${name}: direct arrow delegate`)
  assert.deepEqual(arrow.parameters.map((parameter) => parameter.name.getText(ast)), parameters)
  assert(ts.isIdentifier(arrow.body.expression) && arrow.body.expression.text === target, `${name}: target`)
  assert.deepEqual(arrow.body.arguments.map((argument) => argument.getText(ast)), parameters)
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
    const relevant = namedImports(ast).filter((binding) => exactCapabilities.includes(binding.imported))
    if (relevant.length > 0) observed.set(file, { ast, relevant })
  }
  assert.deepEqual([...observed.keys()].sort(), [...consumerModel.keys()].sort(), 'repo-wide task dictionary consumer denominator')
  for (const [file, expected] of consumerModel) {
    const { ast, relevant } = observed.get(file)
    assert.equal(relevant.length, expected.imports.length, `${file}: exact import count`)
    assert(relevant.every((binding) => binding.specifier === publicSpecifier && !binding.typeOnly && binding.imported === binding.local), `${file}: exact public named imports`)
    assert.deepEqual(relevant.map((binding) => binding.imported).sort(), [...expected.imports].sort(), `${file}: import symbol map`)
    for (const [name, count] of Object.entries(expected.calls)) {
      const calls = callsTo(ast, name)
      assert.equal(calls.length, count, `${file}: ${name} call denominator`)
      assert(calls.every((call) => !syntacticallyDead(call)), `${file}: ${name} dead-code call`)
    }
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

assert.equal(existsSync(path.join(root, oldPath)), false)
assertConsumerModel()
const publicSource = read(publicPath)
const publicAst = parse(publicPath, publicSource)
assert.deepEqual(exportedFunctions(publicAst).map((declaration) => declaration.name.text).sort(), exactCapabilities)
assertFunctionDelegate(publicAst, 'getTaskDictionariesV1', 'getTaskDictionariesOperation', [])
assertFunctionDelegate(publicAst, 'addTaskDictionaryItemV1', 'addTaskDictionaryItemOperation', ['type', 'item'])
assertFunctionDelegate(publicAst, 'updateTaskDictionaryItemV1', 'updateTaskDictionaryItemOperation', ['type', 'id', 'patch'])
assertFunctionDelegate(publicAst, 'deleteTaskDictionaryItemV1', 'deleteTaskDictionaryItemOperation', ['type', 'id'])
assert.doesNotMatch(publicSource, /fs\/promises|dictionaries\.json|writeFile|task-dictionary-store|prisma|transaction|repository|export \*/i)
assert.deepEqual(
  namedImports(publicAst)
    .filter((binding) => binding.specifier === '../../application/task-dictionary-operations')
    .map((binding) => binding.imported)
    .sort(),
  ['addTaskDictionaryItemOperation', 'deleteTaskDictionaryItemOperation', 'getTaskDictionariesOperation', 'updateTaskDictionaryItemOperation'],
)

const application = read(applicationPath)
const applicationAst = parse(applicationPath, application)
assertArrowDelegate(applicationAst, 'getTaskDictionariesOperation', 'getTaskDictionaries', [])
assertArrowDelegate(applicationAst, 'addTaskDictionaryItemOperation', 'addTaskDictionaryItem', ['type', 'item'])
assertArrowDelegate(applicationAst, 'updateTaskDictionaryItemOperation', 'updateTaskDictionaryItem', ['type', 'id', 'patch'])
assertArrowDelegate(applicationAst, 'deleteTaskDictionaryItemOperation', 'deleteTaskDictionaryItem', ['type', 'id'])
assert.doesNotMatch(application, /fs\/promises|dictionaries\.json|writeFile|prisma|transaction|repository/i)

const taskSource = baseSources.get(taskConsumerPath)
const removedTaskCall = taskSource.replace('getTaskDictionariesV1().then(setDicts)', 'removedTaskDictionariesV1().then(setDicts)')
const probes = [
  new Map([[taskConsumerPath, `${removedTaskCall}\n// getTaskDictionariesV1().then(setDicts)\n`]]),
  new Map([[taskConsumerPath, `${removedTaskCall}\nif (false) { void getTaskDictionariesV1() }\n`]]),
  new Map([[taskConsumerPath, taskSource.replace(publicSpecifier, '@/lib/dictionaries/dictionary-service')]]),
  new Map([[taskConsumerPath, removedTaskCall]]),
  new Map([[taskConsumerPath, `${taskSource}\nvoid getTaskDictionariesV1()\n`]]),
]
assert(probes.every((probe) => !acceptsConsumerModel(probe)), 'comment/dead-code/bypass/denominator probes must fail')

const store = read(storePath)
assert.match(store, /path\.join\(process\.cwd\(\), 'src\/data\/dictionaries\.json'\)/)
assert.match(store, /Math\.random\(\)\.toString\(36\)\.substring\(2, 9\)/)
assert.match(store, /dicts\[type\]\.push\(newItem\)/)
assert.match(store, /const idx = list\.findIndex\(\(item\) => item\.id === id\)/)
assert.match(store, /if \(idx !== -1\)/)
assert.match(store, /dicts\[type\] = dicts\[type\]\.filter\(\(item\) => item\.id !== id\)/)
assert.match(store, /console\.error\('Failed to read dictionaries:', error\)/)
assert.match(store, /return \{\} as TaskDictionariesV1/)

const configurationManifest = JSON.parse(read('architecture/contexts/v1/manifests/configuration.json'))
const workManifest = JSON.parse(read('architecture/contexts/v1/manifests/work_management.json'))
assert(!configurationManifest.internal_surface.includes('gravity-mvp/src/lib/dictionaries'))
assert(!configurationManifest.responsibility.includes('dictionaries'))
assert(workManifest.public_surface.includes('TaskDictionaryCatalog.v1'))
assert(workManifest.responsibility.includes('task dictionaries'))
assert.equal(sha256(read('gravity-mvp/src/data/dictionaries.json')), 'f936573c34c6365d8944dc2ce96567813b6a5bc8dd175f4ac7b066b534505899')

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
  [taskConsumerPath, settingsConsumerPath].includes(finding.file)
  && finding.details?.target === oldPath
)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  task_consumers: 1,
  configuration_consumers: 1,
  capabilities: exactCapabilities.length,
  negative_probes: probes.length,
  dictionary_data: 'BYTE_IDENTICAL',
  dependency_cycle: 'ABSENT',
  current_findings: scan.findings.length,
}, null, 2)}\n`)
