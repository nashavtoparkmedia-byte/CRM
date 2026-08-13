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
const publicBarrelSpecifier = '@/modules/calling/public/v1'
const applicationPath = 'gravity-mvp/src/modules/calling/application/calling-runtime-operations.ts'
const internalRuntimePath = 'gravity-mvp/src/modules/calling/internal/calling-runtime.ts'
const internalTelephonyPath = 'gravity-mvp/src/modules/calling/internal/telephony-runtime.ts'
const runtimeStartupPath = 'gravity-mvp/src/modules/calling/public/v1/runtime-startup.ts'
const telephonyHealthPath = 'gravity-mvp/src/modules/calling/public/v1/telephony-provider-health.ts'
const publicIndexPath = 'gravity-mvp/src/modules/calling/public/v1/index.ts'
const consumers = [
  'gravity-mvp/src/app/api/admin/reprocess-recordings/route.ts',
  'gravity-mvp/src/app/api/settings/telephony-status/route.ts',
  'gravity-mvp/src/instrumentation.ts',
]
const consumerPolicies = new Map([
  [consumers[0], {
    importSites: [{
      kind: 'static',
      specifier: publicBarrelSpecifier,
      bindings: [
        ['backfillCompletedCallTimelineV1', 'backfillCompletedCallTimelineV1', false],
        ['enqueueRecoveredCallTranscriptionV1', 'enqueueRecoveredCallTranscriptionV1', false],
        ['recoverCallRecordingV1', 'recoverCallRecordingV1', false],
      ],
    }],
    calls: {
      backfillCompletedCallTimelineV1: 1,
      enqueueRecoveredCallTranscriptionV1: 1,
      recoverCallRecordingV1: 1,
    },
  }],
  [consumers[1], {
    importSites: [{
      kind: 'static',
      specifier: publicBarrelSpecifier,
      bindings: [['readMegafonTelephonyHealthV1', 'readMegafonTelephonyHealthV1', false]],
    }],
    calls: { readMegafonTelephonyHealthV1: 1 },
  }],
  [consumers[2], {
    importSites: [
      {
        kind: 'dynamic',
        specifier: publicBarrelSpecifier,
        bindings: [['startCallingEslRuntimeV1', 'startCallingEslRuntimeV1', false]],
      },
      {
        kind: 'dynamic',
        specifier: publicBarrelSpecifier,
        bindings: [['startCallingProcessingRuntimeV1', 'startCallingProcessingRuntimeV1', false]],
      },
      {
        kind: 'dynamic',
        specifier: publicBarrelSpecifier,
        bindings: [['stopCallingProcessingRuntimeV1', 'stopCallingProcessingRuntimeV1', false]],
      },
    ],
    calls: {
      startCallingEslRuntimeV1: 1,
      startCallingProcessingRuntimeV1: 1,
      stopCallingProcessingRuntimeV1: 1,
    },
  }],
])
const exactCapabilities = [...new Set(
  [...consumerPolicies.values()].flatMap((policy) => Object.keys(policy.calls)),
)].sort()
const consumerDiscoveryExclusions = new Set([
  // This is the reviewed owner composition whose imports/wrappers are checked
  // separately below; it is not a client of its own public capability.
  applicationPath,
])

function parseSource(relative, source) {
  const kind = relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, kind)
}

function unwrapExpression(expression) {
  let current = expression
  while (
    ts.isAwaitExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(current))
  ) current = current.expression
  return current
}

function importSites(relative, source) {
  const sourceFile = parseSource(relative, source)
  const sites = []
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue
    const clause = statement.importClause
    const bindings = []
    if (clause?.name) bindings.push(['default', clause.name.text, Boolean(clause.isTypeOnly)])
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        bindings.push([
          (element.propertyName ?? element.name).text,
          element.name.text,
          Boolean(clause.isTypeOnly || element.isTypeOnly),
        ])
      }
    } else if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      bindings.push(['*', clause.namedBindings.name.text, Boolean(clause.isTypeOnly)])
    }
    sites.push({
      kind: 'static',
      specifier: statement.moduleSpecifier.text,
      bindings,
      index: statement.getStart(sourceFile),
    })
  }
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrapExpression(node.initializer)
      if (
        ts.isCallExpression(initializer)
        && initializer.expression.kind === ts.SyntaxKind.ImportKeyword
        && initializer.arguments.length === 1
        && ts.isStringLiteralLike(initializer.arguments[0])
      ) {
        const bindings = ts.isObjectBindingPattern(node.name)
          ? node.name.elements.map((element) => [
            (element.propertyName ?? element.name).getText(sourceFile),
            element.name.getText(sourceFile),
            false,
          ])
          : [['*', node.name.getText(sourceFile), false]]
        sites.push({
          kind: 'dynamic',
          specifier: initializer.arguments[0].text,
          bindings,
          index: node.getStart(sourceFile),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return sites.sort((left, right) => left.index - right.index)
}

function callSites(relative, source) {
  const sourceFile = parseSource(relative, source)
  const calls = []
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression)
      if (ts.isIdentifier(callee)) {
        calls.push({ kind: 'identifier', name: callee.text })
      } else if (ts.isPropertyAccessExpression(callee)) {
        calls.push({
          kind: 'property',
          object: callee.expression.getText(sourceFile),
          name: callee.name.text,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return calls
}

function bindingNames(name, sourceFile) {
  if (ts.isIdentifier(name)) return [name.text]
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap((element) => (
      ts.isBindingElement(element) ? bindingNames(element.name, sourceFile) : []
    ))
  }
  return [name.getText(sourceFile)]
}

function nonImportDeclarations(relative, source) {
  const sourceFile = parseSource(relative, source)
  const names = []
  function visit(node) {
    if (ts.isImportDeclaration(node)) return
    if (ts.isVariableDeclaration(node)) {
      const initializer = node.initializer && unwrapExpression(node.initializer)
      const isDynamicImport = initializer
        && ts.isCallExpression(initializer)
        && initializer.expression.kind === ts.SyntaxKind.ImportKeyword
      if (!isDynamicImport) names.push(...bindingNames(node.name, sourceFile))
    } else if (ts.isParameter(node)) {
      names.push(...bindingNames(node.name, sourceFile))
    } else if (
      (ts.isFunctionDeclaration(node)
        || ts.isFunctionExpression(node)
        || ts.isClassDeclaration(node)
        || ts.isClassExpression(node)
        || ts.isEnumDeclaration(node))
      && node.name
    ) names.push(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return names
}

function targetImportSites(relative, source) {
  return importSites(relative, source)
    .filter((site) => site.bindings.some(([imported, local]) => (
      exactCapabilities.includes(imported) || exactCapabilities.includes(local)
    )))
    .map(({ kind, specifier, bindings }) => ({
      kind,
      specifier,
      bindings: bindings.filter(([imported, local]) => (
        exactCapabilities.includes(imported) || exactCapabilities.includes(local)
      )),
    }))
}

function assertConsumerBoundary(relative, source) {
  const policy = consumerPolicies.get(relative)
  assert(policy, `missing exact Calling runtime consumer policy: ${relative}`)
  assert.deepEqual(targetImportSites(relative, source), policy.importSites)
  const calls = callSites(relative, source)
  for (const [local, count] of Object.entries(policy.calls)) {
    assert.equal(
      calls.filter((call) => call.kind === 'identifier' && call.name === local).length,
      count,
      `${relative} must call imported ${local} exactly ${count} time(s)`,
    )
  }
  const expectedLocals = new Set(Object.keys(policy.calls))
  assert.deepEqual(
    nonImportDeclarations(relative, source).filter((name) => expectedLocals.has(name)),
    [],
    `${relative} shadows an imported Calling runtime capability`,
  )
  assert.deepEqual(
    [...new Set(calls
      .filter((call) => exactCapabilities.includes(call.name))
      .map((call) => call.kind === 'identifier' ? call.name : `${call.object}.${call.name}`))]
      .filter((call) => !expectedLocals.has(call))
      .sort(),
    [],
    `${relative} has an unbound or member-style Calling runtime capability call`,
  )
  for (const site of importSites(relative, source)) {
    assert.equal(
      /@\/lib\/freeswitch\/(?:EslClient|recordingProcessor)|@\/lib\/queue(?:\/queues)?$/.test(site.specifier),
      false,
      `${relative} imports a retired Calling provider implementation`,
    )
    assert.equal(
      site.specifier.startsWith(`${publicBarrelSpecifier}/`),
      false,
      `${relative} bypasses the Calling public barrel`,
    )
  }
}

function namedExportSites(relative, source, specifier) {
  const sourceFile = parseSource(relative, source)
  return sourceFile.statements.flatMap((statement) => {
    if (
      !ts.isExportDeclaration(statement)
      || !statement.moduleSpecifier
      || !ts.isStringLiteralLike(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== specifier
    ) return []
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      return [{ bindings: [['*', '*', Boolean(statement.isTypeOnly)]] }]
    }
    return [{ bindings: statement.exportClause.elements.map((element) => [
      (element.propertyName ?? element.name).text,
      element.name.text,
      Boolean(statement.isTypeOnly || element.isTypeOnly),
    ]) }]
  })
}

function assertNamedExport(relative, source, specifier, expectedBindings) {
  assert.deepEqual(namedExportSites(relative, source, specifier), [{ bindings: expectedBindings }])
}

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false
}

function assertZeroArgumentConstWrapper(sourceFile, exportedName, targetName) {
  const matches = []
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === exportedName) matches.push(declaration)
    }
  }
  assert.equal(matches.length, 1, `expected one exported const wrapper ${exportedName}`)
  const initializer = matches[0].initializer
  assert(initializer && ts.isArrowFunction(initializer), `${exportedName} must be an arrow wrapper`)
  assert.equal(initializer.parameters.length, 0, `${exportedName} must expose no extra arguments`)
  const body = unwrapExpression(initializer.body)
  assert(ts.isCallExpression(body), `${exportedName} must directly return its owner call`)
  assert(ts.isIdentifier(body.expression) && body.expression.text === targetName)
  assert.equal(body.arguments.length, 0)
}

function assertApplicationBoundary(source) {
  const expectedImports = new Map([
    ['../internal/telephony-runtime', [[
      'readMegafonTelephonyHealth', 'readMegafonTelephonyHealth', false,
    ], [
      'rescanMegafonTelephonyGateway', 'rescanMegafonTelephonyGateway', false,
    ], [
      'MegafonTelephonyHealthV1', 'MegafonTelephonyHealthV1', true,
    ]]],
    ['../internal/calling-runtime', [[
      'startCallingEslRuntime', 'startCallingEslRuntime', false,
    ], [
      'startCallingProcessingRuntime', 'startCallingProcessingRuntime', false,
    ], [
      'stopCallingProcessingRuntime', 'stopCallingProcessingRuntime', false,
    ]]],
  ])
  const sites = importSites(applicationPath, source)
  for (const [specifier, bindings] of expectedImports) {
    assert.deepEqual(
      sites.filter((site) => site.specifier === specifier).map((site) => site.bindings),
      [bindings],
      `application must have one exact named import from ${specifier}`,
    )
  }
  const sourceFile = parseSource(applicationPath, source)
  const internalBindings = [...expectedImports.values()].flat()
    .filter(([, , typeOnly]) => !typeOnly)
    .map(([, local]) => local)
  assert.deepEqual(
    nonImportDeclarations(applicationPath, source).filter((name) => internalBindings.includes(name)),
    [],
    'application shadows an imported internal runtime binding',
  )
  for (const [exported, target] of [
    ['readMegafonTelephonyHealthV1', 'readMegafonTelephonyHealth'],
    ['rescanMegafonTelephonyGatewayV1', 'rescanMegafonTelephonyGateway'],
    ['startCallingEslRuntimeV1', 'startCallingEslRuntime'],
    ['startCallingProcessingRuntimeV1', 'startCallingProcessingRuntime'],
    ['stopCallingProcessingRuntimeV1', 'stopCallingProcessingRuntime'],
  ]) assertZeroArgumentConstWrapper(sourceFile, exported, target)
}

function runtimeSourcePaths(relativeDirectory) {
  const absoluteDirectory = path.join(root, relativeDirectory)
  return readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(relativeDirectory, entry.name)
    if (entry.isDirectory()) return runtimeSourcePaths(relative)
    if (!/\.(?:ts|tsx)$/.test(entry.name) || /\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name) || entry.name.endsWith('.d.ts')) return []
    return [relative.split(path.sep).join('/')]
  })
}

function discoverConsumers(entries) {
  return entries.filter(({ relative, source }) => {
    if (consumerDiscoveryExclusions.has(relative)) return false
    if (targetImportSites(relative, source).length > 0) return true
    return callSites(relative, source).some((call) => exactCapabilities.includes(call.name))
  }).map(({ relative }) => relative).sort()
}

function assertConsumerDenominator(entries) {
  assert.deepEqual(discoverConsumers(entries), [...consumers].sort())
}

function rejectProbe(original, changed, validate) {
  assert.notEqual(changed, original, 'negative probe must alter its source')
  assert.throws(() => validate(changed))
}

for (const consumer of consumers) assertConsumerBoundary(consumer, read(consumer))

const proxy = read('gravity-mvp/src/infrastructure/providers/process-proxy.ts')
assert.equal(sha256(proxy), '89e2e6bb6948ceff88eb9e5bec575a6f4bd1d716512408228097897dcd4ad152')
assert.deepEqual([...proxy.matchAll(/export\s+function\s+(\w+)/g)].map((match) => match[1]), ['initProxy'])
assert.match(proxy, /function redactProxy/)
assert.doesNotMatch(proxy, /export\s+(?:async\s+)?function\s+(?:redactProxy|getProxy|createProxyAgent)|export \*/)
const unrelatedProxyProbe = `${proxy}\nexport function getProxyCredentials() { return null }\n`
assert.notDeepEqual([...unrelatedProxyProbe.matchAll(/export\s+function\s+(\w+)/g)].map((match) => match[1]), ['initProxy'])

const application = read(applicationPath)
assertApplicationBoundary(application)
assertNamedExport(runtimeStartupPath, read(runtimeStartupPath), '../../application/calling-runtime-operations', [
  ['startCallingEslRuntimeV1', 'startCallingEslRuntimeV1', false],
  ['startCallingProcessingRuntimeV1', 'startCallingProcessingRuntimeV1', false],
  ['stopCallingProcessingRuntimeV1', 'stopCallingProcessingRuntimeV1', false],
])
const telephonyHealthExports = namedExportSites(
  telephonyHealthPath,
  read(telephonyHealthPath),
  '../../application/calling-runtime-operations',
)
assert.deepEqual(telephonyHealthExports, [{ bindings: [
  ['readMegafonTelephonyHealthV1', 'readMegafonTelephonyHealthV1', false],
  ['rescanMegafonTelephonyGatewayV1', 'rescanMegafonTelephonyGatewayV1', false],
] }, { bindings: [
  ['MegafonTelephonyHealthV1', 'MegafonTelephonyHealthV1', true],
] }])
assert.doesNotMatch(read(runtimeStartupPath), /getEslConnection|startEslListener|startCallProcessingWorkers|originate|cancel/)
assert.doesNotMatch(read(telephonyHealthPath), /getEslConnection|sofia status gateway megafon|sofia profile external/)
assert.match(read(internalRuntimePath), /startEslListener/)
assert.match(read(internalTelephonyPath), /sofia status gateway megafon/)

// The repository, not a handwritten list, establishes the consumer denominator.
const sourceEntries = runtimeSourcePaths('gravity-mvp/src').map((relative) => ({ relative, source: read(relative) }))
assertConsumerDenominator(sourceEntries)

const telephonyConsumer = read(consumers[1])
rejectProbe(
  telephonyConsumer,
  telephonyConsumer.replace('readMegafonTelephonyHealthV1(),', 'true, // readMegafonTelephonyHealthV1(),'),
  (probe) => assertConsumerBoundary(consumers[1], probe),
)
rejectProbe(
  telephonyConsumer,
  telephonyConsumer.replace('import { readMegafonTelephonyHealthV1 }', 'import type { readMegafonTelephonyHealthV1 }'),
  (probe) => assertConsumerBoundary(consumers[1], probe),
)
rejectProbe(
  telephonyConsumer,
  telephonyConsumer.replace('readMegafonTelephonyHealthV1(),', 'unrelated.readMegafonTelephonyHealthV1(),'),
  (probe) => assertConsumerBoundary(consumers[1], probe),
)
rejectProbe(
  application,
  application.replace(
    'readMegafonTelephonyHealthV1 = () => readMegafonTelephonyHealth()',
    'readMegafonTelephonyHealthV1 = () => undefined // readMegafonTelephonyHealth()',
  ),
  assertApplicationBoundary,
)
const fourthConsumerPath = 'gravity-mvp/src/app/api/probes/fourth-calling-runtime-consumer.ts'
const fourthConsumerSource = `import { readMegafonTelephonyHealthV1 } from '${publicBarrelSpecifier}'\nexport const probe = () => readMegafonTelephonyHealthV1()\n`
assert.throws(
  () => assertConsumerDenominator([
    ...sourceEntries,
    { relative: fourthConsumerPath, source: fourthConsumerSource },
  ]),
)

// The public index may expose more reviewed Calling operations, but each runtime
// capability must still be a named export from its reviewed owner surface.
const publicIndexExports = parseSource(publicIndexPath, read(publicIndexPath)).statements.flatMap((statement) => {
  if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) return []
  return statement.exportClause.elements.map((element) => ({
    name: element.name.text,
    typeOnly: Boolean(statement.isTypeOnly || element.isTypeOnly),
  }))
})
for (const capability of exactCapabilities) {
  assert.equal(publicIndexExports.filter((entry) => entry.name === capability && !entry.typeOnly).length, 1)
}

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
assert.equal(registry.exceptions.filter((entry) => (
  consumers.includes(entry.file) && entry.target_context === 'calling'
)).length, 0)

const scan = await scanArchitecture(root)
const boundaryFindings = scan.findings.filter((finding) => (
  consumers.includes(finding.file) && finding.target_context === 'calling'
))
assert.deepEqual(boundaryFindings, [])
process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  consumers: consumers.length,
  consumer_capabilities: exactCapabilities.length,
  negative_ast_probes: 5,
  negative_comment_probe: 'REJECTED',
  negative_type_only_probe: 'REJECTED',
  negative_unrelated_call_probe: 'REJECTED',
  negative_fourth_consumer_probe: 'REJECTED',
  closed_findings: 15,
  current_findings: scan.findings.length,
  registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
