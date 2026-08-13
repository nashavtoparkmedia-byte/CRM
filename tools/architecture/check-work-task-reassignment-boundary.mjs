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
const legacyConsumerPath = 'gravity-mvp/src/app/team-overview/actions.ts'
const routePath = 'gravity-mvp/src/app/api/tasks/reassign/route.ts'
const workPublicPath = 'gravity-mvp/src/modules/work-management/public/v1/index.ts'
const workApplicationPath = 'gravity-mvp/src/modules/work-management/application/task-operations.ts'
const workHandlerPath = 'gravity-mvp/src/modules/work-management/public/v1/reassign-tasks-handler.ts'
const identityAdapterPath = 'gravity-mvp/src/modules/identity-access/public/v1/legacy-prisma-crm-user-query-adapter.ts'
const publicSpecifier = '@/modules/work-management/public/v1'
const governedSymbol = 'reassignTasksV1'

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
const callsTo = (ast, name) => {
  const calls = []
  visit(ast, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) calls.push(node)
  })
  return calls
}
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
const namedReExports = (ast, specifier, name) => ast.statements.flatMap((statement) => {
  if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier?.text !== specifier) return []
  assert(statement.exportClause && ts.isNamedExports(statement.exportClause), 'wildcard export is forbidden')
  return statement.exportClause.elements.filter((element) => (
    (element.propertyName?.text ?? element.name.text) === name
  )).map((element) => ({
    imported: element.propertyName?.text ?? element.name.text,
    exported: element.name.text,
    typeOnly: statement.isTypeOnly || element.isTypeOnly,
  }))
})
const propertyMap = (literal, ast) => Object.fromEntries(literal.properties.map((property) => {
  if (ts.isShorthandPropertyAssignment(property)) return [property.name.text, property.name.text]
  assert(ts.isPropertyAssignment(property), 'command must use exact property assignments or shorthand')
  const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : undefined
  assert(name, 'command property name must be static')
  return [name, property.initializer.getText(ast)]
}))

const sourcePaths = walk(path.join(root, 'gravity-mvp/src'))
  .map(relative)
  .filter((file) => !/(?:^|\/)__tests__\/|\.(?:test|spec)\.tsx?$/.test(file))
const baseSources = new Map(sourcePaths.map((file) => [file, read(file)]))

function assertBoundaryModel(overrides = new Map()) {
  const sourceFor = (file) => overrides.get(file) ?? baseSources.get(file) ?? read(file)
  const observed = []
  for (const file of sourcePaths) {
    const ast = parse(file, sourceFor(file))
    const imports = namedImports(ast).filter((binding) => binding.imported === governedSymbol)
    if (imports.length > 0) observed.push({ file, ast, imports })
  }
  assert.deepEqual(observed.map(({ file }) => file), [routePath], 'repo-wide task reassignment consumer denominator')
  const routeAst = observed[0].ast
  assert.deepEqual(observed[0].imports, [{
    specifier: publicSpecifier,
    imported: governedSymbol,
    local: governedSymbol,
    typeOnly: false,
  }], 'route exact public import')
  const calls = callsTo(routeAst, governedSymbol)
  assert.equal(calls.length, 1, 'route exact call denominator')
  assert(!syntacticallyDead(calls[0]), 'route call cannot be syntactically dead')
  assert(ts.isAwaitExpression(calls[0].parent), 'route call must be awaited')
  assert.equal(calls[0].arguments.length, 1, 'route command argument')
  assert(ts.isObjectLiteralExpression(calls[0].arguments[0]), 'route command literal')
  assert.deepEqual(propertyMap(calls[0].arguments[0], routeAst), {
    contract: 'REASSIGN_TASKS_COMMAND_V1',
    taskIds: 'taskIds',
    newAssigneeId: 'newAssigneeId',
  })

  const publicAst = parse(workPublicPath, sourceFor(workPublicPath))
  assert.deepEqual(
    namedReExports(publicAst, '../../application/task-operations', governedSymbol),
    [{ imported: governedSymbol, exported: governedSymbol, typeOnly: false }],
    'one exact public application re-export',
  )

  const applicationAst = parse(workApplicationPath, sourceFor(workApplicationPath))
  const wrapper = applicationAst.statements.filter((statement) => (
    ts.isFunctionDeclaration(statement)
    && statement.name?.text === governedSymbol
    && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  ))
  assert.equal(wrapper.length, 1, 'one exported application wrapper')
  assert(wrapper[0].modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword), 'application wrapper async')
  assert.equal(wrapper[0].body?.statements.length, 1, 'application wrapper one executable statement')
  const returned = wrapper[0].body.statements[0]
  assert(ts.isReturnStatement(returned) && returned.expression && ts.isCallExpression(returned.expression), 'application direct return call')
  assert(ts.isIdentifier(returned.expression.expression) && returned.expression.expression.text === 'reassignTasks', 'application exact handler delegate')
  assert.equal(returned.expression.arguments.length, 1)
  assert(ts.isSpreadElement(returned.expression.arguments[0]) && returned.expression.arguments[0].expression.getText(applicationAst) === 'args')

  const handlerFactories = callsTo(applicationAst, 'createReassignTasksHandlerV1')
  assert.equal(handlerFactories.length, 1, 'one executable handler composition')
  assert(!syntacticallyDead(handlerFactories[0]), 'handler composition cannot be dead')
  assert.equal(handlerFactories[0].arguments.length, 1)
  assert(ts.isObjectLiteralExpression(handlerFactories[0].arguments[0]), 'handler composition uses explicit port')
  assert.deepEqual(handlerFactories[0].arguments[0].properties.map((property) => property.name?.getText(applicationAst)), ['findTargetUser', 'assign'])

  const queryCalls = callsTo(applicationAst, 'queryCrmUserV1')
  assert.equal(queryCalls.length, 1, 'one identity query call')
  assert(ts.isAwaitExpression(queryCalls[0].parent), 'identity query awaited')
  assert.equal(queryCalls[0].arguments.length, 1)
  assert(ts.isObjectLiteralExpression(queryCalls[0].arguments[0]))
  assert.deepEqual(propertyMap(queryCalls[0].arguments[0], applicationAst), {
    contract: 'CRM_USER_QUERY_V1',
    userId: 'userId',
  })
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
const route = baseSources.get(routePath)
const removedCall = route.replace('await reassignTasksV1({', 'await removedReassignTasksV1({')
const probes = [
  new Map([[routePath, `${removedCall}\n// await reassignTasksV1({})\n`]]),
  new Map([[routePath, `${removedCall}\nif (false) { void reassignTasksV1({ contract: REASSIGN_TASKS_COMMAND_V1, taskIds, newAssigneeId }) }\n`]]),
  new Map([[routePath, route.replace(publicSpecifier, '@/app/team-overview/actions')]]),
  new Map([[routePath, removedCall]]),
  new Map([[routePath, `${route}\nvoid reassignTasksV1({ contract: REASSIGN_TASKS_COMMAND_V1, taskIds: [], newAssigneeId: '' })\n`]]),
]
assert(probes.every((probe) => !acceptsBoundaryModel(probe)), 'comment/dead-code/bypass/denominator probes must fail')

const legacyConsumer = read(legacyConsumerPath)
assert.doesNotMatch(legacyConsumer, /export async function reassignTasks/)
assert.doesNotMatch(legacyConsumer, /crmUser\.findUnique/)
const identityAdapter = read(identityAdapterPath)
assert.match(identityAdapter, /prisma\.crmUser\.findUnique\(\{/)
assert.match(identityAdapter, /select: \{ id: true, name: true \}/)
assert.doesNotMatch(identityAdapter, /\.(?:create|update|updateMany|upsert|delete|deleteMany)\s*\(/)
const workHandler = read(workHandlerPath)
assert.match(workHandler, /if \(parsed\.taskIds\.length === 0\)/)
assert(workHandler.indexOf('parsed.taskIds.length === 0') < workHandler.indexOf('port.findTargetUser'))
assert.match(workHandler, /throw new Error\('Target user not found'\)/)
assert.match(workHandler, /for \(const taskId of parsed\.taskIds\)/)
assert.match(workHandler, /if \(status === 'reassigned'\) reassigned\+\+/)
assert.equal(
  sha256(read('gravity-mvp/src/modules/work-management/public/v1/legacy-prisma-assignment-adapter.ts')),
  'c5be7f588d2f4b8c7dcb67abc244f8281c5e5b6af356b580963d49bcdb8a8f35',
)

const identityManifest = JSON.parse(read('architecture/contexts/v1/manifests/identity_access.json'))
const workManifest = JSON.parse(read('architecture/contexts/v1/manifests/work_management.json'))
assert(identityManifest.public_surface.includes('CrmUserQuery.v1'))
assert(workManifest.commands.includes('ReassignTasksCommand.v1'))
assert(workManifest.public_surface.includes('TaskReassignment.v1'))
assert(workManifest.allowed_dependencies.some((dependency) => (
  dependency.context === 'identity_access' && dependency.surface === 'identity_access.public'
)))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
  finding.file === routePath && finding.details?.target === legacyConsumerPath
)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  runtime_consumers: 1,
  write_capabilities: 1,
  negative_probes: probes.length,
  legacy_identity_source: 'PRESERVED',
  dependency_cycle: 'ABSENT',
  current_findings: scan.findings.length,
}, null, 2)}\n`)
