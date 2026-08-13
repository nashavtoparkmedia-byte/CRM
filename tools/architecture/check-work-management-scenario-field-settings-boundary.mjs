#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

import {
  evaluateFindings,
  extractUnsafeApplicationCompositionExports,
  scanArchitecture,
} from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha = relative => createHash('sha256').update(readFileSync(path.join(root, relative))).digest('hex')
const paths = {
  contract: 'gravity-mvp/src/contracts/work-management/v1/scenario-field-settings.ts',
  contractIndex: 'gravity-mvp/src/contracts/work-management/v1/index.ts',
  handler: 'gravity-mvp/src/modules/work-management/public/v1/scenario-field-settings-handler.ts',
  adapter: 'gravity-mvp/src/modules/work-management/public/v1/legacy-prisma-scenario-field-settings-adapter.ts',
  publicIndex: 'gravity-mvp/src/modules/work-management/public/v1/index.ts',
  application: 'gravity-mvp/src/modules/work-management/application/task-operations.ts',
  actions: 'gravity-mvp/src/app/settings/scenarios/actions.ts',
  client: 'gravity-mvp/src/app/settings/scenarios/[id]/fields/ScenarioFieldsSettingsClient.tsx',
  internal: 'gravity-mvp/src/lib/tasks/scenario-settings.ts',
}
const source = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, read(value)]))
const frozenBehaviorSources = Object.entries(
  JSON.parse(read('architecture/isolation/work-management/scenario-field-settings-v1/BEHAVIOR-FREEZE.json'))
    .source_hashes_after ?? {},
).filter(([file]) => !file.startsWith('architecture/contexts/v1/'))
const historicalBehaviorPaths = Object.values(paths).filter(file => file !== paths.application)
const evidenceRoot = 'architecture/isolation/work-management/scenario-field-settings-v1'
const amendmentPath = `${evidenceRoot}/module-manifest-amendments.json`
const amendment = JSON.parse(read(amendmentPath))
const migration = JSON.parse(read(`${evidenceRoot}/migration-manifest.json`))
const verification = JSON.parse(read(`${evidenceRoot}/verification.json`))
const behavior = JSON.parse(read(`${evidenceRoot}/BEHAVIOR-FREEZE.json`))
const policy = JSON.parse(read('architecture/enforcement/v1/policy.json'))
const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const currentArchitectureScan = await scanArchitecture(root)
const currentEnforcement = evaluateFindings(
  currentArchitectureScan.findings,
  registry,
  currentArchitectureScan.policy,
)
const configurationManifest = JSON.parse(read('architecture/contexts/v1/manifests/configuration.json'))
const workManifest = JSON.parse(read('architecture/contexts/v1/manifests/work_management.json'))
const contextIndex = JSON.parse(read('architecture/contexts/v1/context-index.json'))
const checks = []
const failures = []
const check = (name, predicate, detail) => {
  if (predicate) checks.push(name)
  else failures.push({ check: name, detail })
}

const scenarioFactories = [
  'createGetMergedScenarioFieldsHandlerV1',
  'createResetScenarioFieldSettingHandlerV1',
  'createUpsertScenarioFieldSettingHandlerV1',
]
const scenarioCapabilities = [
  'getMergedScenarioFieldsV1',
  'resetScenarioFieldSettingV1',
  'upsertScenarioFieldSettingV1',
]
const scenarioAdapter = 'legacyPrismaScenarioFieldSettingsPortV1'
const handlerSpecifier = './scenario-field-settings-handler'
const applicationSpecifier = '../../application/task-operations'
const applicationHandlerSpecifier = '../public/v1/scenario-field-settings-handler'
const applicationAdapterSpecifier = '../public/v1/legacy-prisma-scenario-field-settings-adapter'
const reviewedEvidenceHashes = {
  behavior: 'ddcf306c2a6448245c0308b5ce75b0030889ae98caf768795dc37743a30deb96',
  verification: '7d5f1b397bc2a6fd1834c87749ec46e817efeeb9ef4d633cf44155730c64ced9',
  migration: '0638fdd4b04e4ed2dba96a4835d05c487b0604d6ecdcadf56d07539201128665',
}
const scenarioPort = 'ScenarioFieldSettingsPersistencePortV1'
const publicSpecifier = '@/modules/work-management/public/v1'
const compositionPairs = [
  {
    local: 'getMergedScenarioFields',
    factory: 'createGetMergedScenarioFieldsHandlerV1',
    capability: 'getMergedScenarioFieldsV1',
  },
  {
    local: 'resetScenarioFieldSetting',
    factory: 'createResetScenarioFieldSettingHandlerV1',
    capability: 'resetScenarioFieldSettingV1',
  },
  {
    local: 'upsertScenarioFieldSetting',
    factory: 'createUpsertScenarioFieldSettingHandlerV1',
    capability: 'upsertScenarioFieldSettingV1',
  },
]

function parseSource(relative, sourceText) {
  const kind = relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(relative, sourceText, ts.ScriptTarget.Latest, true, kind)
}

function hasModifier(node, kind) {
  return node.modifiers?.some(modifier => modifier.kind === kind) ?? false
}

function unwrapExpression(expression) {
  let current = expression
  while (
    ts.isAwaitExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(current))
  ) current = current.expression
  return current
}

function importSites(relative, sourceText) {
  const sourceFile = parseSource(relative, sourceText)
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
        ts.isCallExpression(initializer) &&
        initializer.expression.kind === ts.SyntaxKind.ImportKeyword &&
        initializer.arguments.length === 1 &&
        ts.isStringLiteralLike(initializer.arguments[0])
      ) {
        const bindings = ts.isObjectBindingPattern(node.name)
          ? node.name.elements.map(element => [
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

function exportBindings(relative, sourceText) {
  const sourceFile = parseSource(relative, sourceText)
  return sourceFile.statements.flatMap(statement => {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier ||
        !ts.isStringLiteralLike(statement.moduleSpecifier)) return []
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      return [{
        specifier: statement.moduleSpecifier.text,
        imported: '*',
        local: '*',
        typeOnly: Boolean(statement.isTypeOnly),
      }]
    }
    return statement.exportClause.elements.map(element => ({
      specifier: statement.moduleSpecifier.text,
      imported: (element.propertyName ?? element.name).text,
      local: element.name.text,
      typeOnly: Boolean(statement.isTypeOnly || element.isTypeOnly),
    }))
  })
}

function bindingNames(name, sourceFile) {
  if (ts.isIdentifier(name)) return [name.text]
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap(element => (
      ts.isBindingElement(element) ? bindingNames(element.name, sourceFile) : []
    ))
  }
  return [name.getText(sourceFile)]
}

function nonImportDeclarations(relative, sourceText) {
  const sourceFile = parseSource(relative, sourceText)
  const names = []
  function visit(node) {
    if (ts.isImportDeclaration(node)) return
    if (ts.isVariableDeclaration(node)) {
      const initializer = node.initializer && unwrapExpression(node.initializer)
      const isDynamicImport = initializer && ts.isCallExpression(initializer) &&
        initializer.expression.kind === ts.SyntaxKind.ImportKeyword
      if (!isDynamicImport) names.push(...bindingNames(node.name, sourceFile))
    } else if (ts.isParameter(node)) {
      names.push(...bindingNames(node.name, sourceFile))
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
       ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isEnumDeclaration(node)) &&
      node.name
    ) names.push(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return names
}

function callSites(relative, sourceText) {
  const sourceFile = parseSource(relative, sourceText)
  const calls = []
  function visit(node, containingFunction = null) {
    const nextFunction = ts.isFunctionDeclaration(node) && node.name
      ? node.name.text
      : containingFunction
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression)
      if (ts.isIdentifier(callee)) {
        calls.push({ kind: 'identifier', name: callee.text, containingFunction: nextFunction })
      } else if (ts.isPropertyAccessExpression(callee)) {
        calls.push({
          kind: 'property',
          object: callee.expression.getText(sourceFile),
          name: callee.name.text,
          containingFunction: nextFunction,
        })
      }
    }
    ts.forEachChild(node, child => visit(child, nextFunction))
  }
  visit(sourceFile)
  return calls
}

function variableDeclarations(sourceFile, name) {
  const matches = []
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        matches.push({ statement, declaration })
      }
    }
  }
  return matches
}

function assertFactoryBinding(sourceFile, { local, factory }) {
  const matches = variableDeclarations(sourceFile, local)
  assert.equal(matches.length, 1)
  const [{ statement, declaration }] = matches
  assert((statement.declarationList.flags & ts.NodeFlags.Const) !== 0)
  assert.equal(hasModifier(statement, ts.SyntaxKind.ExportKeyword), false)
  const initializer = declaration.initializer && unwrapExpression(declaration.initializer)
  assert(initializer && ts.isCallExpression(initializer))
  assert(ts.isIdentifier(initializer.expression) && initializer.expression.text === factory)
  assert.equal(initializer.arguments.length, 1)
  assert(ts.isIdentifier(initializer.arguments[0]) && initializer.arguments[0].text === scenarioAdapter)
}

function assertRestWrapper(sourceFile, { local, capability }) {
  const matches = variableDeclarations(sourceFile, capability)
  assert.equal(matches.length, 1)
  const [{ statement, declaration }] = matches
  assert((statement.declarationList.flags & ts.NodeFlags.Const) !== 0)
  assert(hasModifier(statement, ts.SyntaxKind.ExportKeyword))
  const initializer = declaration.initializer
  assert(initializer && ts.isArrowFunction(initializer))
  assert.equal(initializer.parameters.length, 1)
  const parameter = initializer.parameters[0]
  assert(parameter.dotDotDotToken)
  assert(ts.isIdentifier(parameter.name) && parameter.name.text === 'args')
  assert(parameter.type && ts.isTypeReferenceNode(parameter.type))
  assert(ts.isIdentifier(parameter.type.typeName) && parameter.type.typeName.text === 'Parameters')
  assert.equal(parameter.type.typeArguments?.length, 1)
  const typeArgument = parameter.type.typeArguments[0]
  assert(ts.isTypeQueryNode(typeArgument) && ts.isIdentifier(typeArgument.exprName) &&
    typeArgument.exprName.text === local)
  const returned = unwrapExpression(initializer.body)
  assert(ts.isCallExpression(returned))
  assert(ts.isIdentifier(returned.expression) && returned.expression.text === local)
  assert.equal(returned.arguments.length, 1)
  assert(ts.isSpreadElement(returned.arguments[0]))
  assert(ts.isIdentifier(returned.arguments[0].expression) && returned.arguments[0].expression.text === 'args')
}

function scenarioCompositionStructureIsExact(publicIndex, application) {
  try {
    const publicTargets = new Set([
      ...scenarioFactories,
      ...scenarioCapabilities,
      scenarioPort,
      scenarioAdapter,
    ])
    const actualPublicBindings = exportBindings(paths.publicIndex, publicIndex)
      .filter(binding => publicTargets.has(binding.imported) || publicTargets.has(binding.local) ||
        /scenario.*field/i.test(binding.imported) || /scenario.*field/i.test(binding.local) ||
        (binding.imported === '*' && [handlerSpecifier, applicationSpecifier].includes(binding.specifier)))
      .sort((left, right) => left.imported.localeCompare(right.imported))
    const expectedPublicBindings = [
      ...scenarioFactories.map(name => ({
        specifier: handlerSpecifier, imported: name, local: name, typeOnly: false,
      })),
      { specifier: handlerSpecifier, imported: scenarioPort, local: scenarioPort, typeOnly: true },
      ...scenarioCapabilities.map(name => ({
        specifier: applicationSpecifier, imported: name, local: name, typeOnly: false,
      })),
    ].sort((left, right) => left.imported.localeCompare(right.imported))
    assert.deepEqual(actualPublicBindings, expectedPublicBindings)
    assert.equal(exportBindings(paths.publicIndex, publicIndex).some(binding => (
      binding.specifier.includes('legacy-prisma-scenario-field-settings-adapter')
    )), false)
    const publicFile = parseSource(paths.publicIndex, publicIndex)
    const locallyDeclaredPublicScenarioNames = publicFile.statements.flatMap(statement => {
      if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return []
      if (ts.isVariableStatement(statement)) {
        return statement.declarationList.declarations.flatMap(declaration => (
          ts.isIdentifier(declaration.name) && /scenario.*field/i.test(declaration.name.text)
            ? [declaration.name.text]
            : []
        ))
      }
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
          statement.name && /scenario.*field/i.test(statement.name.text)) return [statement.name.text]
      return []
    })
    assert.deepEqual(locallyDeclaredPublicScenarioNames, [])

    const selectedApplicationNames = new Set([...scenarioFactories, scenarioAdapter])
    const actualApplicationBindings = importSites(paths.application, application)
      .flatMap(site => site.bindings.map(([imported, local, typeOnly]) => ({
        kind: site.kind, specifier: site.specifier, imported, local, typeOnly,
      })))
      .filter(binding => selectedApplicationNames.has(binding.imported) ||
        selectedApplicationNames.has(binding.local))
      .sort((left, right) => left.imported.localeCompare(right.imported))
    const expectedApplicationBindings = [
      ...scenarioFactories.map(name => ({
        kind: 'static',
        specifier: applicationHandlerSpecifier,
        imported: name,
        local: name,
        typeOnly: false,
      })),
      {
        kind: 'static',
        specifier: applicationAdapterSpecifier,
        imported: scenarioAdapter,
        local: scenarioAdapter,
        typeOnly: false,
      },
    ].sort((left, right) => left.imported.localeCompare(right.imported))
    assert.deepEqual(actualApplicationBindings, expectedApplicationBindings)

    const applicationFile = parseSource(paths.application, application)
    for (const pair of compositionPairs) {
      assertFactoryBinding(applicationFile, pair)
      assertRestWrapper(applicationFile, pair)
    }
    const declared = nonImportDeclarations(paths.application, application)
    for (const imported of [...scenarioFactories, scenarioAdapter]) {
      assert.equal(declared.filter(name => name === imported).length, 0)
    }
    for (const { local, capability } of compositionPairs) {
      assert.equal(declared.filter(name => name === local).length, 1)
      assert.equal(declared.filter(name => name === capability).length, 1)
    }
    const exportedScenarioNames = applicationFile.statements.flatMap(statement => {
      if (!ts.isVariableStatement(statement) || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return []
      return statement.declarationList.declarations.flatMap(declaration => (
        ts.isIdentifier(declaration.name) && /scenario.*field/i.test(declaration.name.text)
          ? [declaration.name.text]
          : []
      ))
    }).sort()
    assert.deepEqual(exportedScenarioNames, [...scenarioCapabilities].sort())
    assert.deepEqual(extractUnsafeApplicationCompositionExports(application), [])
    assert.equal(importSites(paths.application, application).some(site => (
      site.specifier === '@/lib/prisma' || site.specifier === '@prisma/client'
    )), false)
    assert.doesNotMatch(
      application,
      /(?:\$executeRaw|\$queryRaw|scenario_field_settings|\$transaction|\bcatch\b|\bretry\b|console\.|export\s+\*)/i,
    )
    return true
  } catch {
    return false
  }
}

function rejectsCompositionProbe(publicIndex, application) {
  return !scenarioCompositionStructureIsExact(publicIndex, application)
}

function targetCapabilityImportSites(relative, sourceText) {
  return importSites(relative, sourceText)
    .filter(site => site.bindings.some(([imported, local]) => (
      scenarioCapabilities.includes(imported) || scenarioCapabilities.includes(local)
    )))
    .map(({ kind, specifier, bindings }) => ({
      kind,
      specifier,
      bindings: bindings.filter(([imported, local]) => (
        scenarioCapabilities.includes(imported) || scenarioCapabilities.includes(local)
      )),
    }))
}

function exportedAsyncFunction(sourceFile, name) {
  const matches = sourceFile.statements.filter(statement => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === name
  ))
  assert.equal(matches.length, 1)
  const declaration = matches[0]
  assert(hasModifier(declaration, ts.SyntaxKind.ExportKeyword))
  assert(hasModifier(declaration, ts.SyntaxKind.AsyncKeyword))
  assert(declaration.body)
  return declaration
}

function assertAwaitedCapabilityCall(expression, capability) {
  assert(ts.isAwaitExpression(expression))
  const call = unwrapExpression(expression)
  assert(ts.isCallExpression(call))
  assert(ts.isIdentifier(call.expression) && call.expression.text === capability)
  assert.equal(call.arguments.length, 1)
  assert(ts.isObjectLiteralExpression(call.arguments[0]))
}

function assertActionConsumerStructureIsExact(actionsSource) {
  assert.deepEqual(targetCapabilityImportSites(paths.actions, actionsSource), [{
    kind: 'static',
    specifier: publicSpecifier,
    bindings: [
      ['getMergedScenarioFieldsV1', 'getMergedScenarioFieldsV1', false],
      ['resetScenarioFieldSettingV1', 'resetScenarioFieldSettingV1', false],
      ['upsertScenarioFieldSettingV1', 'upsertScenarioFieldSettingV1', false],
    ],
  }])
  assert.deepEqual(
    nonImportDeclarations(paths.actions, actionsSource)
      .filter(name => scenarioCapabilities.includes(name)),
    [],
  )
  for (const site of importSites(paths.actions, actionsSource)) {
    assert.notEqual(site.specifier, '@/lib/tasks/scenario-settings')
    assert.equal(site.specifier.includes('/modules/work-management/application/'), false)
    assert.equal(site.specifier.includes('legacy-prisma-scenario-field-settings-adapter'), false)
  }

  const sourceFile = parseSource(paths.actions, actionsSource)
  const get = exportedAsyncFunction(sourceFile, 'getScenarioFieldsConfig')
  assert.equal(get.body.statements.length, 2)
  const getResult = get.body.statements[0]
  assert(ts.isVariableStatement(getResult))
  assert((getResult.declarationList.flags & ts.NodeFlags.Const) !== 0)
  assert.equal(getResult.declarationList.declarations.length, 1)
  const getResultDeclaration = getResult.declarationList.declarations[0]
  assert(ts.isIdentifier(getResultDeclaration.name) && getResultDeclaration.name.text === 'result')
  assert(getResultDeclaration.initializer)
  assertAwaitedCapabilityCall(getResultDeclaration.initializer, 'getMergedScenarioFieldsV1')
  const getReturn = get.body.statements[1]
  assert(ts.isReturnStatement(getReturn) && getReturn.expression)
  assert(ts.isPropertyAccessExpression(getReturn.expression))
  assert(ts.isIdentifier(getReturn.expression.expression) && getReturn.expression.expression.text === 'result')
  assert.equal(getReturn.expression.name.text, 'fields')

  for (const [functionName, capability] of [
    ['updateScenarioFieldSetting', 'upsertScenarioFieldSettingV1'],
    ['reorderScenarioField', 'upsertScenarioFieldSettingV1'],
  ]) {
    const declaration = exportedAsyncFunction(sourceFile, functionName)
    assert.equal(declaration.body.statements.length, 4)
    const callStatement = declaration.body.statements[3]
    assert(ts.isExpressionStatement(callStatement))
    assertAwaitedCapabilityCall(callStatement.expression, capability)
  }

  const reset = exportedAsyncFunction(sourceFile, 'resetScenarioField')
  assert.equal(reset.body.statements.length, 1)
  assert(ts.isExpressionStatement(reset.body.statements[0]))
  assertAwaitedCapabilityCall(reset.body.statements[0].expression, 'resetScenarioFieldSettingV1')

  const targetCalls = callSites(paths.actions, actionsSource)
    .filter(call => scenarioCapabilities.includes(call.name))
    .map(({ kind, name, containingFunction }) => ({ kind, name, containingFunction }))
  assert.deepEqual(targetCalls, [
    { kind: 'identifier', name: 'getMergedScenarioFieldsV1', containingFunction: 'getScenarioFieldsConfig' },
    { kind: 'identifier', name: 'upsertScenarioFieldSettingV1', containingFunction: 'updateScenarioFieldSetting' },
    { kind: 'identifier', name: 'upsertScenarioFieldSettingV1', containingFunction: 'reorderScenarioField' },
    { kind: 'identifier', name: 'resetScenarioFieldSettingV1', containingFunction: 'resetScenarioField' },
  ])
}

function actionConsumerStructureIsExact(actionsSource) {
  try {
    assertActionConsumerStructureIsExact(actionsSource)
    return true
  } catch {
    return false
  }
}

function rejectsActionProbe(original, changed) {
  return changed !== original && !actionConsumerStructureIsExact(changed)
}

function discoverScenarioConsumers(entries) {
  return entries.filter(({ relative, sourceText }) => (
    targetCapabilityImportSites(relative, sourceText).length > 0 ||
    callSites(relative, sourceText).some(call => scenarioCapabilities.includes(call.name))
  )).map(({ relative }) => relative).sort()
}

function scenarioConsumerDenominatorIsExact(entries) {
  return JSON.stringify(discoverScenarioConsumers(entries)) === JSON.stringify([paths.actions])
}

function sourceOnlyEvidenceIsExact(verificationRecord, migrationRecord, behaviorRecord) {
  const sourceCommit = 'b1f911b7b17273363df764d6e312a40c9f0fa8fc'
  return verificationRecord.schema === 'yoko.crm.context-isolation-verification.v1' &&
    migrationRecord.schema === 'yoko.crm.context-isolation-migration.v1' &&
    behaviorRecord.schema === 'yoko.crm.behavior-freeze.v1' &&
    [verificationRecord, migrationRecord, behaviorRecord].every(record =>
      record.source_commit === sourceCommit && record.status === 'PASS_CONTINUE_SOURCE_GATE'
    ) &&
    verificationRecord.tests?.work_management_scenario_field_settings_boundary === '24/24 PASS' &&
    verificationRecord.source_control_only === true &&
    verificationRecord.database_accessed === false &&
    verificationRecord.scenario_field_settings_executed_against_database === false &&
    verificationRecord.runtime_or_provider_invoked === false &&
    verificationRecord.production_mutated === false &&
    verificationRecord.secret_values_read_or_emitted === false &&
    migrationRecord.plan?.role === 'production_source_inactive' &&
    migrationRecord.source_control_mutation?.source_only === true &&
    migrationRecord.execution_performed === false &&
    behaviorRecord.out_of_scope?.includes(
      'database access, runtime execution, provider calls, service activation, deployment, production mutation and secrets',
    )
}

function behaviorHashContinuityIsExact(behaviorRecord, frozenSources, publicIndex, application) {
  const frozen = Object.fromEntries(frozenSources)
  const recordedHistoricalSources = Object.entries(behaviorRecord.source_hashes_after ?? {})
    .filter(([file]) => !file.startsWith('architecture/contexts/v1/'))
  return behaviorRecord.source_commit === 'b1f911b7b17273363df764d6e312a40c9f0fa8fc' &&
    JSON.stringify(frozenSources.map(([file]) => file).sort()) ===
      JSON.stringify([...historicalBehaviorPaths].sort()) &&
    JSON.stringify([...frozenSources].sort(([left], [right]) => left.localeCompare(right))) ===
      JSON.stringify(recordedHistoricalSources.sort(([left], [right]) => left.localeCompare(right))) &&
    typeof frozen[paths.publicIndex] === 'string' &&
    /^[a-f0-9]{64}$/.test(frozen[paths.publicIndex]) &&
    frozenSources.filter(([file]) => file !== paths.publicIndex)
      .every(([file, expected]) => sha(file) === expected) &&
    scenarioCompositionStructureIsExact(publicIndex, application)
}

function filesUnder(directory) {
  const results = []
  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry)
    if (statSync(absolute).isDirectory()) results.push(...filesUnder(absolute))
    else if (/\.tsx?$/.test(entry)) results.push(absolute)
  }
  return results
}

const allApplicationSources = filesUnder(path.join(root, 'gravity-mvp/src'))
const runtimeSourceEntries = allApplicationSources
  .filter(absolute => !/\.(?:test|spec)\.tsx?$/.test(absolute) && !absolute.endsWith('.d.ts'))
  .map(absolute => ({
    relative: path.relative(root, absolute).split(path.sep).join('/'),
    sourceText: readFileSync(absolute, 'utf8'),
  }))
const writeOwners = { insert: [], delete: [] }
for (const absolute of allApplicationSources) {
  const body = readFileSync(absolute, 'utf8')
  const relative = path.relative(root, absolute)
  if (/INSERT\s+INTO\s+scenario_field_settings/i.test(body)) writeOwners.insert.push(relative)
  if (/DELETE\s+FROM\s+scenario_field_settings/i.test(body)) writeOwners.delete.push(relative)
}

check(
  'contract identities are exact',
  source.contract.includes("GET_MERGED_SCENARIO_FIELDS_QUERY_V1 = 'work_management.GetMergedScenarioFieldsQuery.v1'")
    && source.contract.includes("GET_MERGED_SCENARIO_FIELDS_RESULT_V1 = 'work_management.GetMergedScenarioFieldsResult.v1'")
    && source.contract.includes("UPSERT_SCENARIO_FIELD_SETTING_COMMAND_V1 = 'work_management.UpsertScenarioFieldSettingCommand.v1'")
    && source.contract.includes("RESET_SCENARIO_FIELD_SETTING_COMMAND_V1 = 'work_management.ResetScenarioFieldSettingCommand.v1'"),
  'one or more public identities drifted',
)

check(
  'contract patch remains exact nullable and finite',
  ['showInList', 'showInCard', 'filterable', 'sortable', 'groupable']
    .every(field => source.contract.includes(`${field}?: boolean | null`))
    && source.contract.includes('order?: number | null')
    && source.contract.includes('Number.isFinite(value.order)')
    && source.contract.includes('patch has unsupported field(s)')
    && source.contract.includes('export const MAX_LIST_PREVIEW_FIELDS = 8 as const'),
  'patch or preview policy widened',
)

check(
  'contract exposes no persistence mechanism',
  !/(prisma|next\/|@\/lib|@\/app|scenario_field_settings|\bSQL\b|tableName|rawSql|whereClause|orderBy|transaction)/i
    .test(source.contract),
  'contract leaks infrastructure or a generic capability',
)

check(
  'handler validates before each exact port operation',
  source.handler.indexOf('parseGetMergedScenarioFieldsQueryV1(query)')
      < source.handler.indexOf('port.getMerged(parsed.scenarioId)')
    && source.handler.indexOf('parseUpsertScenarioFieldSettingCommandV1(command)')
      < source.handler.indexOf('port.upsert({')
    && source.handler.indexOf('parseResetScenarioFieldSettingCommandV1(command)')
      < source.handler.indexOf('port.reset(parsed.scenarioId, parsed.fieldId)')
    && source.handler.includes('completed: true'),
  'handler validation/mapping drifted',
)

check(
  'handler remains persistence-neutral',
  !/(prisma|next\/|@\/lib|@\/app|scenario_field_settings|\$executeRaw|\$queryRaw)/i.test(source.handler),
  'handler owns infrastructure',
)

check(
  'adapter delegates merged reads to the unchanged Work internal reader',
  source.adapter.includes("import { getMergedFieldsForScenario } from '@/lib/tasks/scenario-settings'")
    && source.adapter.includes('return getMergedFieldsForScenario(scenarioId)')
    && !source.adapter.includes('$queryRaw'),
  'merged query was reimplemented or bypassed',
)

check(
  'adapter SQL is fixed private and fully positional',
  source.adapter.includes('const UPSERT_SCENARIO_FIELD_SETTING_SQL = `')
    && source.adapter.includes('const RESET_SCENARIO_FIELD_SETTING_SQL = `')
    && !source.adapter.includes('export const UPSERT_SCENARIO_FIELD_SETTING_SQL')
    && !source.adapter.includes('export const RESET_SCENARIO_FIELD_SETTING_SQL')
    && source.adapter.includes('$10::timestamp, $11')
    && source.adapter.includes('WHERE "scenarioId" = $1 AND "fieldId" = $2')
    && (source.adapter.match(/prisma\.\$executeRawUnsafe/g) ?? []).length === 2,
  'fixed private SQL surface drifted',
)

check(
  'adapter preserves deterministic id timestamp and nullish binds',
  source.adapter.includes('const id = `${input.scenarioId}_${input.fieldId}`')
    && source.adapter.includes('const nowIso = new Date().toISOString()')
    && ['showInList', 'showInCard', 'filterable', 'sortable', 'groupable', 'order']
      .every(field => source.adapter.includes(`input.patch.${field} ?? null`))
    && source.adapter.includes('input.userId ?? null'),
  'write mapping drifted',
)

check(
  'adapter exposes no generic transaction logging or retry lane',
  !/(\$transaction|\bcatch\b|\bretry\b|console\.|tableName|rawSql|whereClause|orderBy|transactionHandle)/i
    .test(source.adapter),
  'generic or policy-changing adapter capability found',
)

check(
  'scenario field setting writes have one Work-owned source',
  JSON.stringify(writeOwners.insert) === JSON.stringify([paths.adapter])
    && JSON.stringify(writeOwners.delete) === JSON.stringify([paths.adapter]),
  `insert=${JSON.stringify(writeOwners.insert)} delete=${JSON.stringify(writeOwners.delete)}`,
)

check(
  'legacy Work internal module retains reads and pure merge but no writes',
  (source.internal.match(/prisma\.\$queryRaw/g) ?? []).length === 2
    && source.internal.includes('export async function getAllScenarioSettingsMap')
    && source.internal.includes('export function mergeFieldsWithOverrides')
    && !source.internal.includes('upsertScenarioFieldSetting')
    && !source.internal.includes('resetScenarioFieldSetting')
    && !source.internal.includes('$executeRaw'),
  'Work internal reader/merge or write retirement drifted',
)

check(
  'Configuration actions execute the exact Work public scenario capabilities',
  source.actions.includes("from '@/contracts/work-management/v1'")
    && actionConsumerStructureIsExact(source.actions),
  'Configuration import, binding or executable call map drifted',
)

const commentOnlyActionsProbe = source.actions.replace(
  'getMergedScenarioFieldsV1({',
  'Promise.resolve({ // getMergedScenarioFieldsV1({',
)
const deadCallActionsProbe = source.actions.replace(
  'await resetScenarioFieldSettingV1({',
  'if (false) await resetScenarioFieldSettingV1({',
)
const shadowedActionsProbe = source.actions.replace(
  'export async function resetScenarioField(scenarioId: string, fieldId: string): Promise<void> {\n',
  'export async function resetScenarioField(scenarioId: string, fieldId: string): Promise<void> {\n' +
    '    const resetScenarioFieldSettingV1 = async () => undefined\n',
)
const extraConsumerPath = 'gravity-mvp/src/app/settings/scenarios/scenario-field-settings-probe.ts'
const extraConsumerSource = `import { getMergedScenarioFieldsV1 } from '${publicSpecifier}'\nif (false) void getMergedScenarioFieldsV1({ contract: 'probe', scenarioId: 'probe' })\n`
check(
  'repo-wide scenario capability denominator and executable-call probes fail closed',
  scenarioConsumerDenominatorIsExact(runtimeSourceEntries)
    && rejectsActionProbe(source.actions, commentOnlyActionsProbe)
    && rejectsActionProbe(source.actions, deadCallActionsProbe)
    && rejectsActionProbe(source.actions, shadowedActionsProbe)
    && !scenarioConsumerDenominatorIsExact([
      ...runtimeSourceEntries,
      { relative: extraConsumerPath, sourceText: extraConsumerSource },
    ]),
  'comment, dead call, shadowing or an extra consumer escaped the exact denominator',
)

check(
  'Configuration preserves actor acquisition before both writes',
  (source.actions.match(/const \{ cookies \} = await import\('next\/headers'\)/g) ?? []).length === 2
    && (source.actions.match(/store\.get\('crm_user_id'\)\?\.value \|\| null/g) ?? []).length === 2
    && source.actions.indexOf("store.get('crm_user_id')") < source.actions.indexOf('upsertScenarioFieldSettingV1({'),
  'cookie/actor ordering drifted',
)

check(
  'client consumes the Work DTO and preserves concurrent reorder',
  source.client.includes("from '@/contracts/work-management/v1'")
    && source.client.includes('type MergedScenarioFieldV1')
    && source.client.includes('await Promise.all(reordered.map')
    && source.client.indexOf('await Promise.all(reordered.map') < source.client.indexOf('await refresh()', source.client.indexOf('const move =')),
  'client type ownership or concurrency drifted',
)

check(
  'public indexes expose the exact typed Work surface through reviewed application composition',
  source.contractIndex.includes("export * from './scenario-field-settings'")
    && scenarioCompositionStructureIsExact(source.publicIndex, source.application)
    && rejectsCompositionProbe(
      source.publicIndex.replace(applicationSpecifier, './scenario-field-settings-handler'),
      source.application,
    )
    && rejectsCompositionProbe(
      source.publicIndex,
      source.application.replace(applicationAdapterSpecifier, '@/lib/prisma'),
    )
    && rejectsCompositionProbe(
      source.publicIndex,
      `${source.application}\nexport const deleteAllScenarioFieldSettingsV1 = async () => true\n`,
    )
    && rejectsCompositionProbe(
      source.publicIndex,
      source.application.replace(
        'getMergedScenarioFields(...args)',
        'undefined // getMergedScenarioFields(...args)',
      ),
    )
    && rejectsCompositionProbe(
      source.publicIndex.replace(
        'export { createGetMergedScenarioFieldsHandlerV1, createResetScenarioFieldSettingHandlerV1, createUpsertScenarioFieldSettingHandlerV1 } from \'./scenario-field-settings-handler\'',
        "export * from './scenario-field-settings-handler'",
      ),
      source.application,
    ),
  'public binding absent or widened',
)

const workSources = [
  ...filesUnder(path.join(root, 'gravity-mvp/src/contracts/work-management')),
  ...filesUnder(path.join(root, 'gravity-mvp/src/modules/work-management')),
  path.join(root, paths.internal),
]
check(
  'Work does not acquire a reverse Configuration dependency',
  workSources.every(absolute => !/@\/(?:contracts|modules)\/configuration|@\/app\/settings\/scenarios/.test(
    readFileSync(absolute, 'utf8'),
  )),
  'Work imports Configuration',
)

const scenarioOwnerEntries = [configurationManifest, workManifest]
  .flatMap(manifest => (manifest.owned_data ?? []).map(entry => ({ context: manifest.context.id, entry })))
  .filter(({ entry }) => entry.model === 'scenario_field_settings')
const configurationIndex = contextIndex.contexts.find(entry => entry.context === 'configuration')
const workIndex = contextIndex.contexts.find(entry => entry.context === 'work_management')
check(
  'D2 owner reassignment is unique exact and index-bound',
  scenarioOwnerEntries.length === 1 &&
    scenarioOwnerEntries[0].context === 'work_management' &&
    JSON.stringify(scenarioOwnerEntries[0].entry.current_writer_modules) === JSON.stringify(['tasks']) &&
    scenarioOwnerEntries[0].entry.id === 'gravity-mvp/prisma/schema.prisma:scenario_field_settings' &&
    scenarioOwnerEntries[0].entry.mapped_table === null &&
    scenarioOwnerEntries[0].entry.schema === 'gravity-mvp/prisma/schema.prisma' &&
    configurationIndex?.sha256 === sha('architecture/contexts/v1/manifests/configuration.json') &&
    workIndex?.sha256 === sha('architecture/contexts/v1/manifests/work_management.json'),
  'owner uniqueness, entry identity or context-index hash drifted',
)
check(
  'manifest amendment exposes only the exact Work surface and Configuration edge',
  amendment.amendments?.length === 2 &&
    amendment.amendments[0].context === 'work_management' &&
    JSON.stringify(amendment.amendments[0].add_commands) === JSON.stringify([
      'UpsertScenarioFieldSettingCommand.v1',
      'ResetScenarioFieldSettingCommand.v1',
    ]) &&
    JSON.stringify(amendment.amendments[0].add_public_surface) === JSON.stringify([
      'GetMergedScenarioFieldsQuery.v1',
    ]) &&
    amendment.amendments[0].add_allowed_dependencies === undefined &&
    amendment.amendments[1].context === 'configuration' &&
    JSON.stringify(amendment.amendments[1].add_allowed_dependencies) === JSON.stringify([
      { context: 'work_management', surface: 'work_management.public' },
    ]) &&
    amendment.amendments[1].add_commands === undefined &&
    amendment.amendments[1].add_public_surface === undefined,
  'module surface or dependency amendment widened',
)
check(
  'strict policy and migration bind D2 to the conversation-link parent',
  policy.manifest_amendments.includes(amendmentPath) &&
    migration.base_commit === '297bc2700eec77e2a06fbdfee4b57867650ba719' &&
    migration.source_commit === 'b1f911b7b17273363df764d6e312a40c9f0fa8fc',
  'policy or evidence lineage drifted',
)

const directSliceRetirements = [
  'arch_7a237a87ee8e273e95604997',
  'arch_12898585c8b3ccee8d3ea85a',
  'arch_d3a1aee5a5e33bdb5a5d6cce',
  'arch_b2695dfa3531c0d237e7fce3',
  'arch_4b2e1e3af0bdf531180daa15',
  'arch_5058caaa02cc2b4b461f5f6a',
  'arch_225fae9337a3c287581451da',
  'arch_a7e099839eaf42e321bcb61f',
  'arch_1a5dd98552731f69df510d4f',
  'arch_6f528eedb0009b2e5fda34d9',
  'arch_e9eae0979b7c84dba46941bb',
  'arch_dcd2086fa84a6f10de82654b',
  'arch_8b3e425d7529f4425243bd47',
  'arch_66a14ce1b5d8219d467235f1',
]
const structuralEdgeRetirements = [
  'arch_dffadff52c7f131dec9fb5df',
  'arch_6e7cdb68eb4f435d44dd2071',
  'arch_769499f033ab35fa6c893698',
  'arch_4f9652672c7bd39182b46e35',
  'arch_89026328f5535b239dafcfcc',
  'arch_898401b584810ba53832d60b',
  'arch_8d26dad454c1d5baba4ed885',
  'arch_d5f00eddbc56bb1d6520a79a',
  'arch_95fe787bec52d896b8755882',
  'arch_9741e0bb3407601906823452',
  'arch_41465e0831ba0392d03c0425',
  'arch_76820e608c8736956049675d',
]
const exactRetirements = [...directSliceRetirements, ...structuralEdgeRetirements]
const registryRules = [
  'direct_foreign_prisma_write',
  'direct_provider_transport_access',
  'internal_module_import',
  'non_public_cross_context_import',
  'undeclared_dependency',
]
const registryFingerprints = registry.exceptions.map(entry => entry.fingerprint)
const registrySummaryCount = rule => registry.summary?.[rule] ?? 0
const registrySummaryIsExact =
  registry.schema === 'yoko.crm.architecture-exception-registry.v1' &&
  registry.version === 1 &&
  registry.milestone === policy.registry_milestone &&
  registry.base_commit === policy.registry_base_commit &&
  registry.policy?.exact_fingerprint_only === true &&
  registry.policy?.stale_exceptions_fail === true &&
  registry.policy?.expired_exceptions_fail === true &&
  registry.policy?.uncovered_violations_fail === true &&
  registry.policy?.deadline === policy.exception_review_deadline &&
  Object.keys(registry.summary ?? {}).every(rule => registryRules.includes(rule)) &&
  registryRules.every(rule =>
    Number.isInteger(registrySummaryCount(rule)) &&
    registrySummaryCount(rule) >= 0 &&
    registrySummaryCount(rule) === registry.exceptions.filter(entry => entry.rule === rule).length
  ) &&
  registryRules.reduce((total, rule) => total + registrySummaryCount(rule), 0) === registry.exceptions.length &&
  registryFingerprints.every(fingerprint => typeof fingerprint === 'string' && /^arch_[a-f0-9]{24}$/.test(fingerprint)) &&
  new Set(registryFingerprints).size === registryFingerprints.length
const normalizedSuccessorRegistry =
  registrySummaryIsExact &&
  currentEnforcement.ok &&
  currentEnforcement.findings === 0 &&
  registry.exceptions.length === 0 &&
  Object.keys(registry.summary ?? {}).length === 0
check(
  'accepted D2 retirements remain closed in later strict registries',
  registrySummaryIsExact &&
    currentEnforcement.ok &&
    currentEnforcement.findings === registry.exceptions.length &&
    registry.exceptions.length <= 1381 &&
    registrySummaryCount('direct_foreign_prisma_write') <= 82 &&
    registrySummaryCount('direct_provider_transport_access') <= 38 &&
    registrySummaryCount('internal_module_import') <= 375 &&
    registrySummaryCount('non_public_cross_context_import') <= 532 &&
    registrySummaryCount('undeclared_dependency') <= 354 &&
    exactRetirements.every(fingerprint => !registry.exceptions.some(entry => entry.fingerprint === fingerprint)) &&
    !registry.exceptions.some(entry => entry.file.includes('legacy-prisma-scenario-field-settings-adapter.ts')),
  'registry monotonicity, retirements or owner-local classification drifted',
)
check(
  'non-public protections survive the context-edge undeclared retirement',
  normalizedSuccessorRegistry || (
    registry.exceptions.filter(entry =>
      entry.file === 'gravity-mvp/src/lib/config-validator.ts' &&
      entry.target_context === 'work_management' &&
      ['internal_module_import', 'non_public_cross_context_import'].includes(entry.rule)
    ).length === 22 &&
      registry.exceptions.filter(entry =>
        entry.file === 'gravity-mvp/src/app/settings/scenarios/[id]/fields/page.tsx' &&
        entry.target_context === 'work_management' &&
        ['internal_module_import', 'non_public_cross_context_import'].includes(entry.rule)
      ).length === 2
  ),
  'accepted edge erased a retained internal or non-public protection',
)
check(
  'verified comparison records fourteen direct and twelve structural retirements exactly',
  JSON.stringify(migration.enforcement?.direct_slice_retirements) === JSON.stringify(directSliceRetirements) &&
    JSON.stringify(migration.enforcement?.structural_edge_retirements) === JSON.stringify(structuralEdgeRetirements) &&
    migration.enforcement?.baseline_findings === 1407 &&
    migration.enforcement?.actual_findings === 1381 &&
    migration.enforcement?.actual_removed === 26 &&
    migration.enforcement?.actual_added === 0 &&
    migration.enforcement?.actual_changed_shared_entries === 0 &&
    migration.enforcement?.finding_digest === '679a367687a98ca41a9ca2a2bfff3b5af0a16e0cfe67dc663b01a13719875743' &&
    migration.enforcement?.registry_sha256 === 'c4b786276dd7e896f3cbc321b2eaa4e33a71296347c1cde3cdb68885b40727f0' &&
    migration.enforcement?.registry_deterministic === true,
  'registry comparison evidence drifted',
)
check(
  'historical Configuration-owner plan is preserved and explicitly superseded by D2',
  migration.historical_plan?.id === 'migration_cf5479ae3da99ee5' &&
    migration.historical_plan?.disposition === 'SUPERSEDED_BY_ARCHITECTURE_LEAD_D2' &&
    migration.historical_plan?.source_artifact_mutated === false,
  'historical plan disposition is absent or rewritten',
)
check(
  'historical frozen evidence remains exact while current composition is structural',
  behaviorHashContinuityIsExact(
    behavior,
    frozenBehaviorSources,
    source.publicIndex,
    source.application,
  ) &&
    !behaviorHashContinuityIsExact(
      behavior,
      frozenBehaviorSources.map(([file, expected]) => [
        file,
        file === paths.adapter ? '0'.repeat(64) : expected,
      ]),
      source.publicIndex,
      source.application,
    ) &&
    !behaviorHashContinuityIsExact(
      behavior,
      frozenBehaviorSources,
      `${source.publicIndex}\nexport const scenarioFieldHashDriftProbe = true\n`,
      source.application,
    ),
  'historical freeze or current structural composition drifted',
)
check(
  'verification retains the exact source-only non-execution boundary',
  sha(`${evidenceRoot}/BEHAVIOR-FREEZE.json`) === reviewedEvidenceHashes.behavior &&
    sha(`${evidenceRoot}/verification.json`) === reviewedEvidenceHashes.verification &&
    sha(`${evidenceRoot}/migration-manifest.json`) === reviewedEvidenceHashes.migration &&
    sourceOnlyEvidenceIsExact(verification, migration, behavior) &&
    !sourceOnlyEvidenceIsExact(
      { ...verification, database_accessed: true },
      migration,
      behavior,
    ) &&
    !sourceOnlyEvidenceIsExact(
      verification,
      { ...migration, execution_performed: true },
      behavior,
    ),
  'source-only or non-execution evidence drifted',
)

process.stdout.write(`${JSON.stringify({
  status: failures.length > 0 ? 'FAIL' : 'PASS',
  sourceOnly: true,
  reviewedComposition: 'PUBLIC_TO_APPLICATION_TO_HANDLER_ADAPTER',
  currentCompositionVerification: 'TYPESCRIPT_AST_NO_CURRENT_SOURCE_HASH',
  scenarioCapabilityConsumers: discoverScenarioConsumers(runtimeSourceEntries),
  negativeCompositionProbes: 5,
  negativeConsumerProbes: 4,
  negativeBehaviorHashProbes: 2,
  negativeNonExecutionProbes: 2,
  checks,
  failures,
}, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
