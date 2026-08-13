#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

import {
    extractImports,
    extractUnsafeApplicationCompositionExports,
} from './enforce-architecture.mjs'

const read = file => fs.readFileSync(file, 'utf8')
const root = process.cwd()
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
const template = (source, name) => {
    const match = new RegExp('const ' + name + ' = `([\\s\\S]*?)`').exec(source)
    return match?.[1] ?? null
}

const contract = read('gravity-mvp/src/contracts/operations-observability/v1/intervention-actions-repository.ts')
const handler = read('gravity-mvp/src/modules/operations-observability/public/v1/intervention-actions-repository-handler.ts')
const adapter = read('gravity-mvp/src/modules/operations-observability/public/v1/legacy-prisma-intervention-actions-repository.ts')
const publicIndex = read('gravity-mvp/src/modules/operations-observability/public/v1/index.ts')
const application = read('gravity-mvp/src/modules/operations-observability/application/observability-operations.ts')
const consumer = read('gravity-mvp/src/app/team-overview/actions.ts')
const callerActionConfig = read('gravity-mvp/src/lib/tasks/intervention-action-config.ts')
const amendmentPath = 'architecture/isolation/operations-observability/intervention-actions-v1/module-manifest-amendments.json'
const amendment = JSON.parse(read(amendmentPath))
const migration = JSON.parse(read('architecture/isolation/operations-observability/intervention-actions-v1/migration-manifest.json'))
const policy = JSON.parse(read('architecture/enforcement/v1/policy.json'))
const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const timing = sliceBetween(consumer, 'async function getOutcomeTimingStats', '// ─── Intervention Actions')
const logAction = sliceBetween(consumer, 'export async function logInterventionAction', '/**\n * Get the last intervention action')
const latest = sliceBetween(consumer, 'async function getLastInterventionActions', '/**\n * Evaluate and persist outcomes')
const evaluate = sliceBetween(consumer, 'async function evaluateInterventionOutcomes', '/**\n * Aggregate intervention effectiveness')
const effectiveness = sliceBetween(consumer, 'async function getInterventionEffectiveness', null)
const ensureFunction = sliceBetween(adapter, 'async function ensureInterventionTable', 'export const legacyPrismaInterventionActionsRepositoryPortV1')

const expectedDdl = {
    ENSURE_INTERVENTION_TABLE_SQL: `
CREATE TABLE IF NOT EXISTS intervention_actions (
  id TEXT PRIMARY KEY,
  manager_id TEXT NOT NULL,
  action TEXT NOT NULL,
  comment TEXT,
  score_at_action INTEGER,
  outcome TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
    ENSURE_INTERVENTION_COLUMNS_SQL: `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'intervention_actions' AND column_name = 'score_at_action') THEN
    ALTER TABLE intervention_actions ADD COLUMN score_at_action INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'intervention_actions' AND column_name = 'outcome') THEN
    ALTER TABLE intervention_actions ADD COLUMN outcome TEXT;
  END IF;
END $$`,
    ENSURE_INTERVENTION_INDEX_SQL: `
CREATE INDEX IF NOT EXISTS idx_intervention_actions_manager
ON intervention_actions (manager_id, created_at DESC)`,
}

const actionLiterals = source => {
    const match = /(?:INTERVENTION_ACTIONS_V1|INTERVENTION_ACTIONS)\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(source)
    return [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map(value => value[1])
}
const interventionBindings = [
    {
        factory: 'createEnsureInterventionActionsRepositoryHandlerV1',
        local: 'ensureInterventionActionsRepository',
        exported: 'ensureInterventionActionsRepositoryV1',
    },
    {
        factory: 'createCreateInterventionActionHandlerV1',
        local: 'createInterventionAction',
        exported: 'createInterventionActionV1',
    },
    {
        factory: 'createListPendingInterventionActionsHandlerV1',
        local: 'listPendingInterventionActions',
        exported: 'listPendingInterventionActionsV1',
    },
    {
        factory: 'createSetInterventionOutcomeHandlerV1',
        local: 'setInterventionOutcome',
        exported: 'setInterventionOutcomeV1',
    },
    {
        factory: 'createListLatestInterventionActionsHandlerV1',
        local: 'listLatestInterventionActions',
        exported: 'listLatestInterventionActionsV1',
    },
    {
        factory: 'createListInterventionOutcomeCountsHandlerV1',
        local: 'listInterventionOutcomeCounts',
        exported: 'listInterventionOutcomeCountsV1',
    },
    {
        factory: 'createListCompletedInterventionTimesHandlerV1',
        local: 'listCompletedInterventionTimes',
        exported: 'listCompletedInterventionTimesV1',
    },
]
const interventionApplicationSpecifier = '../../application/observability-operations'
const interventionHandlerSpecifier = '../public/v1/intervention-actions-repository-handler'
const interventionAdapterSpecifier = '../public/v1/legacy-prisma-intervention-actions-repository'
const interventionPublicSpecifier = '@/modules/operations-observability/public/v1'
const interventionRepository = 'legacyPrismaInterventionActionsRepositoryPortV1'
const moduleBindings = (source, { kind, specifier }) => extractImports(source).flatMap(entry => (
    entry.kind === kind && entry.specifier === specifier ? entry.imports : []
))
const exactBindingSet = (actual, expected) => (
    actual.length === expected.length &&
    expected.every(binding => actual.filter(candidate => (
        candidate.kind === 'named' &&
        candidate.imported === binding.imported &&
        candidate.local === binding.local
    )).length === 1)
)
const parse = (file, source) => {
    const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    assert.equal(sourceFile.parseDiagnostics.length, 0, `${file}: TypeScript parse diagnostics`)
    return sourceFile
}
const visit = (node, callback) => {
    callback(node)
    ts.forEachChild(node, child => visit(child, callback))
}
const unwrap = (node) => {
    let current = node
    while (current && ts.isParenthesizedExpression(current)) current = current.expression
    return current
}
const literalFalse = expression => expression.kind === ts.SyntaxKind.FalseKeyword
    || (ts.isNumericLiteral(expression) && Number(expression.text) === 0)
const syntacticallyDead = (node) => {
    for (let child = node, current = node.parent; current; child = current, current = current.parent) {
        if (ts.isIfStatement(current)) {
            if (literalFalse(current.expression) && child === current.thenStatement) return true
            if (current.expression.kind === ts.SyntaxKind.TrueKeyword && child === current.elseStatement) return true
        }
        if (ts.isWhileStatement(current) && literalFalse(current.expression)) return true
        if (ts.isConditionalExpression(current)) {
            if (literalFalse(current.condition) && child === current.whenTrue) return true
            if (current.condition.kind === ts.SyntaxKind.TrueKeyword && child === current.whenFalse) return true
        }
    }
    return false
}
const directCallForIdentifier = (identifier) => {
    let expression = identifier
    while (expression.parent && ts.isParenthesizedExpression(expression.parent)) expression = expression.parent
    return expression.parent && ts.isCallExpression(expression.parent) && expression.parent.expression === expression
        ? expression.parent
        : null
}
const enclosingFunctionName = (node) => {
    for (let current = node.parent; current; current = current.parent) {
        if (!ts.isFunctionLike(current)) continue
        if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
        if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current))
            && ts.isVariableDeclaration(current.parent)
            && ts.isIdentifier(current.parent.name)) return current.parent.name.text
        if (current.name && ts.isIdentifier(current.name)) return current.name.text
        return null
    }
    return null
}
const topLevelConst = (sourceFile, name, exported) => sourceFile.statements.flatMap(statement => (
    ts.isVariableStatement(statement)
    && Boolean(statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) === exported
    && (statement.declarationList.flags & ts.NodeFlags.Const)
        ? statement.declarationList.declarations.filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name)
        : []
))
const assertImportedDirectCalls = (sourceFile, name, { count, awaited = false, callers = null }) => {
    const calls = []
    visit(sourceFile, node => {
        if (!ts.isIdentifier(node) || node.text !== name) return
        if (ts.isImportSpecifier(node.parent) && node.parent.name === node) return
        const call = directCallForIdentifier(node)
        assert(call, `${sourceFile.fileName}: ${name} must not be shadowed, copied, or referenced indirectly`)
        assert.equal(syntacticallyDead(call), false, `${sourceFile.fileName}: ${name} call is syntactically dead`)
        calls.push(call)
    })
    assert.equal(calls.length, count, `${sourceFile.fileName}: ${name} executable direct-call count`)
    if (awaited) assert(calls.every(candidate => ts.isAwaitExpression(candidate.parent)), `${sourceFile.fileName}: ${name} calls must be awaited`)
    if (callers) assert.deepEqual(calls.map(enclosingFunctionName).sort(), [...callers].sort(), `${sourceFile.fileName}: ${name} call owners`)
    return calls
}
const assertRepositoryArguments = (sourceFile) => {
    const uses = []
    visit(sourceFile, node => {
        if (!ts.isIdentifier(node) || node.text !== interventionRepository) return
        if (ts.isImportSpecifier(node.parent) && node.parent.name === node) return
        assert(ts.isCallExpression(node.parent) && node.parent.arguments.includes(node), `${interventionRepository} must only be passed directly to a factory`)
        assert.equal(syntacticallyDead(node.parent), false)
        uses.push(node.parent)
    })
    assert.equal(uses.length, interventionBindings.length)
    assert.deepEqual(
        uses.map(call => ts.isIdentifier(unwrap(call.expression)) ? unwrap(call.expression).text : null).sort(),
        interventionBindings.map(({ factory }) => factory).sort(),
    )
}
const assertLocalHandlerUse = (sourceFile, local, declaration, wrapperCall) => {
    let declarations = 0
    let typeQueries = 0
    let calls = 0
    visit(sourceFile, node => {
        if (!ts.isIdentifier(node) || node.text !== local) return
        if (ts.isVariableDeclaration(node.parent) && node.parent.name === node) {
            assert.equal(node.parent, declaration)
            declarations += 1
            return
        }
        if (ts.isTypeQueryNode(node.parent) && node.parent.exprName === node) {
            typeQueries += 1
            return
        }
        const call = directCallForIdentifier(node)
        assert.equal(call, wrapperCall, `${sourceFile.fileName}: ${local} indirect or shadowed use`)
        calls += 1
    })
    assert.equal(declarations, 1)
    assert.equal(typeQueries, 1)
    assert.equal(calls, 1)
}
const assertNoWildcardModuleAccess = (source, specifiers) => {
    for (const entry of extractImports(source)) {
        if (![...specifiers].some(specifier => entry.specifier === specifier || entry.specifier.startsWith(`${specifier}/`))) continue
        assert.equal(entry.imports.some(binding => binding.kind !== 'named'), false, `${entry.specifier}: namespace/default boundary access`)
        assert(!(entry.imports.length === 0 && entry.kind !== 'static'), `${entry.specifier}: wildcard/dynamic boundary access`)
    }
}
const consumerCallers = new Map([
    ['ensureInterventionActionsRepositoryV1', [
        'getOutcomeTimingStats',
        'logInterventionAction',
        'getLastInterventionActions',
        'evaluateInterventionOutcomes',
        'getInterventionEffectiveness',
    ]],
    ['createInterventionActionV1', ['logInterventionAction']],
    ['listPendingInterventionActionsV1', ['evaluateInterventionOutcomes']],
    ['setInterventionOutcomeV1', ['evaluateInterventionOutcomes']],
    ['listLatestInterventionActionsV1', ['getLastInterventionActions']],
    ['listInterventionOutcomeCountsV1', ['getInterventionEffectiveness']],
    ['listCompletedInterventionTimesV1', ['getOutcomeTimingStats']],
])
const assertExactInterventionComposition = (publicSource, applicationSource, consumerSource) => {
    const expectedFactories = interventionBindings.map(({ factory }) => ({
        imported: factory,
        local: factory,
    }))
    const expectedOperations = interventionBindings.map(({ exported }) => ({
        imported: exported,
        local: exported,
    }))
    const operationNames = new Set(expectedOperations.map(({ imported }) => imported))
    const scopedOperations = bindings => bindings.filter(binding => (
        operationNames.has(binding.imported) ||
        /intervention/i.test(binding.imported) ||
        /intervention/i.test(binding.local)
    ))
    assert.equal(interventionBindings.length, 7)
    assert.equal(new Set(interventionBindings.map(({ factory }) => factory)).size, 7)
    assert.equal(new Set(interventionBindings.map(({ local }) => local)).size, 7)
    assert.equal(new Set(interventionBindings.map(({ exported }) => exported)).size, 7)
    assert(exactBindingSet(
            moduleBindings(applicationSource, { kind: 'static', specifier: interventionHandlerSpecifier }),
            expectedFactories,
        ))
    assert(exactBindingSet(
            moduleBindings(applicationSource, { kind: 'static', specifier: interventionAdapterSpecifier }),
            [{ imported: interventionRepository, local: interventionRepository }],
        ))
    assert(exactBindingSet(
            scopedOperations(moduleBindings(publicSource, { kind: 'export', specifier: interventionApplicationSpecifier })),
            expectedOperations,
        ))
    assert(exactBindingSet(
            scopedOperations(moduleBindings(consumerSource, { kind: 'static', specifier: interventionPublicSpecifier })),
            expectedOperations,
        ))
    assert.deepEqual(extractUnsafeApplicationCompositionExports(applicationSource), [])
    assertNoWildcardModuleAccess(applicationSource, new Set([interventionHandlerSpecifier, interventionAdapterSpecifier]))
    assertNoWildcardModuleAccess(publicSource, new Set([interventionApplicationSpecifier]))
    assertNoWildcardModuleAccess(consumerSource, new Set([interventionPublicSpecifier]))
    assert.equal(extractImports(publicSource).some(entry => entry.specifier === interventionAdapterSpecifier || /legacy-prisma-intervention-actions-repository/.test(entry.specifier)), false)
    assert.equal(extractImports(consumerSource).some(entry => /legacy-prisma-intervention-actions-repository/.test(entry.specifier)), false)

    const applicationAst = parse('gravity-mvp/src/modules/operations-observability/application/observability-operations.ts', applicationSource)
    for (const { factory, local, exported } of interventionBindings) {
        const factoryCalls = assertImportedDirectCalls(applicationAst, factory, { count: 1 })
        const localDeclarations = topLevelConst(applicationAst, local, false)
        assert.equal(localDeclarations.length, 1, `${local}: exact local handler binding`)
        assert.equal(unwrap(localDeclarations[0].initializer), factoryCalls[0], `${local}: direct factory composition`)
        assert.deepEqual(factoryCalls[0].arguments.map(argument => argument.getText(applicationAst)), [interventionRepository])

        const exportedDeclarations = topLevelConst(applicationAst, exported, true)
        assert.equal(exportedDeclarations.length, 1, `${exported}: exact exported wrapper`)
        const wrapper = unwrap(exportedDeclarations[0].initializer)
        assert(wrapper && ts.isArrowFunction(wrapper) && wrapper.parameters.length === 1)
        const parameter = wrapper.parameters[0]
        assert(parameter.dotDotDotToken && ts.isIdentifier(parameter.name) && parameter.name.text === 'args')
        assert.equal(parameter.type?.getText(applicationAst), `Parameters<typeof ${local}>`)
        const wrapperCall = unwrap(wrapper.body)
        assert(wrapperCall && ts.isCallExpression(wrapperCall) && ts.isIdentifier(wrapperCall.expression) && wrapperCall.expression.text === local)
        assert.equal(syntacticallyDead(wrapperCall), false)
        assert.equal(wrapperCall.arguments.length, 1)
        assert(ts.isSpreadElement(wrapperCall.arguments[0]) && ts.isIdentifier(wrapperCall.arguments[0].expression) && wrapperCall.arguments[0].expression.text === 'args')
        assertLocalHandlerUse(applicationAst, local, localDeclarations[0], wrapperCall)
    }
    assertRepositoryArguments(applicationAst)

    const consumerAst = parse('gravity-mvp/src/app/team-overview/actions.ts', consumerSource)
    for (const { exported } of interventionBindings) {
        const callers = consumerCallers.get(exported)
        assertImportedDirectCalls(consumerAst, exported, { count: callers.length, awaited: true, callers })
    }
}
const hasExactInterventionComposition = (publicSource, applicationSource, consumerSource) => {
    try {
        assertExactInterventionComposition(publicSource, applicationSource, consumerSource)
        return true
    } catch {
        return false
    }
}
const runtimeSourceFiles = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return runtimeSourceFiles(absolute)
    if (!/\.[cm]?[jt]sx?$/.test(entry.name)) return []
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    return /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative) ? [] : [relative]
})
const operationNames = new Set(interventionBindings.map(({ exported }) => exported))
const factoryNames = new Set(interventionBindings.map(({ factory }) => factory))
const governedNames = new Set([...operationNames, ...factoryNames, interventionRepository])
const applicationPath = 'gravity-mvp/src/modules/operations-observability/application/observability-operations.ts'
const publicIndexPath = 'gravity-mvp/src/modules/operations-observability/public/v1/index.ts'
const publicAggregatorPath = 'gravity-mvp/src/modules/operations-observability/public/index.ts'
const moduleIndexPath = 'gravity-mvp/src/modules/operations-observability/index.ts'
const consumerPath = 'gravity-mvp/src/app/team-overview/actions.ts'
const handlerPath = 'gravity-mvp/src/modules/operations-observability/public/v1/intervention-actions-repository-handler.ts'
const adapterPath = 'gravity-mvp/src/modules/operations-observability/public/v1/legacy-prisma-intervention-actions-repository.ts'
const expectedOperationBindings = [
    {
        file: moduleIndexPath,
        kind: 'export',
        specifier: './public',
        imported: '*',
        local: '*',
    },
    ...interventionBindings.map(({ factory }) => ({
        file: applicationPath,
        kind: 'static',
        specifier: interventionHandlerSpecifier,
        imported: factory,
        local: factory,
    })),
    {
        file: applicationPath,
        kind: 'static',
        specifier: interventionAdapterSpecifier,
        imported: interventionRepository,
        local: interventionRepository,
    },
    ...interventionBindings.map(({ exported }) => ({
        file: publicIndexPath,
        kind: 'export',
        specifier: interventionApplicationSpecifier,
        imported: exported,
        local: exported,
    })),
    ...interventionBindings.map(({ factory }) => ({
        file: publicIndexPath,
        kind: 'export',
        specifier: './intervention-actions-repository-handler',
        imported: factory,
        local: factory,
    })),
    {
        file: publicAggregatorPath,
        kind: 'export',
        specifier: './v1',
        imported: '*',
        local: '*',
    },
    ...interventionBindings.map(({ exported }) => ({
        file: consumerPath,
        kind: 'static',
        specifier: interventionPublicSpecifier,
        imported: exported,
        local: exported,
    })),
].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
const baseRuntimeSources = new Map(runtimeSourceFiles(path.join(root, 'gravity-mvp/src')).map(file => [file, read(file)]))
const withoutModuleSuffix = value => value.replace(/\.(?:[cm]?[jt]sx?)$/, '').replace(/\/index$/, '')
const resolveModule = (file, specifier) => {
    if (specifier.startsWith('@/')) return withoutModuleSuffix(`gravity-mvp/src/${specifier.slice(2)}`)
    if (specifier.startsWith('.')) return withoutModuleSuffix(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)))
    return specifier
}
const governedModulePaths = new Set([
    applicationPath,
    publicIndexPath,
    handlerPath,
    adapterPath,
    path.posix.dirname(publicAggregatorPath),
].map(withoutModuleSuffix))
const governedModule = (file, specifier) => {
    const resolved = resolveModule(file, specifier)
    const publicDirectory = withoutModuleSuffix(path.posix.dirname(publicIndexPath))
    return governedModulePaths.has(resolved)
        || resolved === publicDirectory
}
const discoverOperationBindings = (sources = baseRuntimeSources) => [...sources].flatMap(([file, source]) => (
    extractImports(source).flatMap(entry => {
        const named = entry.imports
            .filter(binding => governedNames.has(binding.imported))
            .map(binding => ({
            file,
            kind: entry.kind,
            specifier: entry.specifier,
            imported: binding.imported,
            local: binding.local,
            }))
        const wildcard = governedModule(file, entry.specifier)
            && (entry.imports.some(binding => binding.kind !== 'named')
                || (entry.imports.length === 0 && entry.kind !== 'static'))
            ? [{ file, kind: entry.kind, specifier: entry.specifier, imported: '*', local: '*' }]
            : []
        return [...named, ...wildcard]
    })
)).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
const hasExactRepositoryWideConsumerDenominator = (sources = baseRuntimeSources) => (
    JSON.stringify(discoverOperationBindings(sources)) === JSON.stringify(expectedOperationBindings)
)

check(
    'contract and handler are infrastructure neutral',
    !/(prisma|next\/|@\/lib|@\/app)/i.test(contract + handler),
    'public surface leaks infrastructure',
)
check(
    'seven request envelopes and results are versioned',
    (contract.match(/operations_observability\.[A-Za-z]+(?:Command|Query)\.v1/g) || []).length === 7 &&
        (contract.match(/operations_observability\.[A-Za-z]+Result\.v1/g) || []).length === 7,
    'contract identity count drift',
)
check(
    'public surface exposes no generic repository capability',
    !/(tableName|sql|filterBy|sortBy|page|transaction|predicate|whereClause)/i.test(contract + handler) &&
        contract.includes('eligibleAtOrBefore: Date') &&
        contract.includes("export type InterventionOutcomeV1 = 'improved' | 'unchanged' | 'worsened'") &&
        contract.includes("export type InterventionActionV1 = typeof INTERVENTION_ACTIONS_V1[number]") &&
        contract.includes("'coaching',\n    'reassigned_tasks',\n    'workload_adjusted',\n    'escalation_reviewed',\n    'no_action_needed'") &&
        contract.includes('export interface LatestInterventionActionV1') &&
        sliceBetween(contract, 'export interface LatestInterventionActionV1', 'export interface ListLatestInterventionActionsResultV1').includes('action: string'),
    'generic query/write capability leaked',
)
check(
    'create vocabulary exactly mirrors the caller action vocabulary',
    JSON.stringify(actionLiterals(contract)) === JSON.stringify(actionLiterals(callerActionConfig)) &&
        actionLiterals(contract).length === 5,
    'versioned create vocabulary diverged from the closed caller vocabulary',
)
check(
    'strict parsers cover all seven requests',
        (contract.match(/export function parse[A-Za-z]+(?:Command|Query)V1/g) || []).length === 7 &&
        contract.includes("value.eligibleAtOrBefore instanceof Date") &&
        contract.includes("!ACTIONS.has(value.action as InterventionActionV1)") &&
        contract.includes("!OUTCOMES.has(value.outcome as InterventionOutcomeV1)"),
    'strict parser coverage drift',
)
check(
    'one named repository port owns three writes and four reads',
    handler.includes('export interface InterventionActionsRepositoryPortV1') &&
        ['ensure()', 'create(input:', 'listPending(', 'setOutcome(', 'listLatest()', 'listOutcomeCounts()', 'listCompletedTimes()']
            .every(value => handler.includes(value)),
    'repository port shape drift',
)
check(
    'handlers parse before ports and never catch failures',
    (handler.match(/parse[A-Za-z]+(?:Command|Query)V1/g) || []).length === 14 &&
        (handler.match(/await port\./g) || []).length === 7 &&
        !/\b(?:try|catch)\b/.test(handler),
    'handler validation, port mapping, or failure visibility drift',
)
check(
    'all public facades bind the same owner repository',
    hasExactInterventionComposition(publicIndex, application, consumer),
    'public repository binding drift',
)
check(
    'repository-wide intervention-operation consumer denominator is exact',
    hasExactRepositoryWideConsumerDenominator(),
    'an intervention operation acquired an unreviewed import, re-export, alias, or entrypoint',
)
const directAdapterFacadeProbe = publicIndex.replace(
    interventionApplicationSpecifier,
    './legacy-prisma-intervention-actions-repository',
)
const splitRepositoryProbe = application.replace(
    `createSetInterventionOutcomeHandlerV1(${interventionRepository})`,
    'createSetInterventionOutcomeHandlerV1(alternateInterventionActionsRepositoryPortV1)',
)
const reducedDenominatorProbe = publicIndex.replace('    listCompletedInterventionTimesV1,\n', '')
const extraConsumerProbe = new Map(baseRuntimeSources)
extraConsumerProbe.set(
    'gravity-mvp/src/__architecture_probe__/extra-intervention-consumer.ts',
    `import { createInterventionActionV1 as createAction } from '${interventionPublicSpecifier}'\nvoid createAction\n`,
)
const commentedConsumerCallProbe = consumer.replace(
    'await createInterventionActionV1({',
    'await disabledCreateInterventionActionV1({ // await createInterventionActionV1({',
)
const removedConsumerCallProbe = consumer.replace('await createInterventionActionV1({', 'await disabledCreateInterventionActionV1({')
const deadConsumerCallProbe = `${removedConsumerCallProbe}\nif (false) { await createInterventionActionV1({} as never) }\n`
const shadowConsumerCallProbe = removedConsumerCallProbe.replace(
    'export async function logInterventionAction',
    'const shadowProbe = async (createInterventionActionV1: (input: never) => Promise<void>) => { await createInterventionActionV1({} as never) }\nvoid shadowProbe\n\nexport async function logInterventionAction',
)
const aliasConsumerProbe = consumer
    .replace('    createInterventionActionV1,', '    createInterventionActionV1 as createActionV1,')
    .replace('await createInterventionActionV1({', 'await createActionV1({')
const namespaceConsumerProbe = `${consumer}\nimport * as interventionBoundaryProbe from '${interventionPublicSpecifier}'\nvoid interventionBoundaryProbe\n`
const namespaceConsumerSources = new Map(baseRuntimeSources)
namespaceConsumerSources.set(consumerPath, namespaceConsumerProbe)
const deepImportConsumerProbe = consumer.replace(
    interventionPublicSpecifier,
    '@/modules/operations-observability/application/observability-operations',
)
const noOpWrapperProbe = application.replace(
    '=> createInterventionAction(...args)',
    '=> Promise.resolve(args as never)',
)
const deadFactoryProbe = application.replace(
    `const createInterventionAction = createCreateInterventionActionHandlerV1(${interventionRepository})`,
    `if (false) { createCreateInterventionActionHandlerV1(${interventionRepository}) }\nconst createInterventionAction = disabledCreateInterventionActionHandlerV1(${interventionRepository})`,
)
check(
    'negative probes reject facade ownership denominator comment dead shadow alias namespace deep-import and no-op bypasses',
    directAdapterFacadeProbe !== publicIndex &&
        splitRepositoryProbe !== application &&
        reducedDenominatorProbe !== publicIndex &&
        !hasExactInterventionComposition(directAdapterFacadeProbe, application, consumer) &&
        !hasExactInterventionComposition(publicIndex, splitRepositoryProbe, consumer) &&
        !hasExactInterventionComposition(reducedDenominatorProbe, application, consumer) &&
        !hasExactRepositoryWideConsumerDenominator(extraConsumerProbe) &&
        commentedConsumerCallProbe !== consumer &&
        deadConsumerCallProbe !== consumer &&
        shadowConsumerCallProbe !== consumer &&
        aliasConsumerProbe !== consumer &&
        namespaceConsumerProbe !== consumer &&
        deepImportConsumerProbe !== consumer &&
        noOpWrapperProbe !== application &&
        deadFactoryProbe !== application &&
        !hasExactInterventionComposition(publicIndex, application, commentedConsumerCallProbe) &&
        !hasExactInterventionComposition(publicIndex, application, deadConsumerCallProbe) &&
        !hasExactInterventionComposition(publicIndex, application, shadowConsumerCallProbe) &&
        !hasExactInterventionComposition(publicIndex, application, aliasConsumerProbe) &&
        !hasExactRepositoryWideConsumerDenominator(namespaceConsumerSources) &&
        !hasExactInterventionComposition(publicIndex, application, deepImportConsumerProbe) &&
        !hasExactInterventionComposition(publicIndex, noOpWrapperProbe, consumer) &&
        !hasExactInterventionComposition(publicIndex, deadFactoryProbe, consumer),
    'an adversarial intervention boundary bypass was accepted',
)
check(
    'compatibility DDL bytes are exact',
    Object.entries(expectedDdl).every(([name, sql]) => template(adapter, name) === sql),
    'compatibility DDL byte drift',
)
check(
    'DDL remains three separate autocommit awaits in exact order',
    (ensureFunction.match(/await prisma\.\$executeRawUnsafe/g) || []).length === 3 &&
        ensureFunction.indexOf('ENSURE_INTERVENTION_TABLE_SQL') < ensureFunction.indexOf('ENSURE_INTERVENTION_COLUMNS_SQL') &&
        ensureFunction.indexOf('ENSURE_INTERVENTION_COLUMNS_SQL') < ensureFunction.indexOf('ENSURE_INTERVENTION_INDEX_SQL') &&
        ensureFunction.indexOf('ENSURE_INTERVENTION_INDEX_SQL') < ensureFunction.indexOf('interventionTableEnsured = true') &&
        !/Promise\.all|\$transaction/.test(ensureFunction),
    'DDL state-machine order or autocommit behavior drift',
)
check(
    'ensure flag preserves retry and first-call race semantics',
    ensureFunction.indexOf('if (interventionTableEnsured) return') < ensureFunction.indexOf('await prisma.$executeRawUnsafe') &&
        !/(ensurePromise|inFlight|pendingEnsure)/.test(adapter),
    'ensure state acquired a lock or changed retry behavior',
)
check(
    'every owner method defensively ensures',
    (adapter.match(/await ensureInterventionTable\(\)/g) || []).length === 7,
    'owner defensive ensure coverage drift',
)
check(
    'writes use typed create and updateMany exact mappings',
    adapter.includes('await prisma.intervention_actions.create({') &&
        adapter.includes('manager_id: input.managerId') &&
        adapter.includes('score_at_action: input.scoreAtAction') &&
        adapter.includes('await prisma.intervention_actions.updateMany({') &&
        adapter.includes('where: { id: input.id }') &&
        adapter.includes('data: { outcome: input.outcome }') &&
        !/intervention_actions\.(?:create|updateMany)[\s\S]{0,300}(?:created_at|count)/.test(adapter),
    'typed write mapping or zero-row behavior drift',
)
check(
    'owner retains exactly four fixed raw reads',
    (adapter.match(/prisma\.\$queryRawUnsafe</g) || []).length === 4 &&
        adapter.includes('WHERE outcome IS NULL AND score_at_action IS NOT NULL AND created_at <= $1') &&
        adapter.includes('SELECT DISTINCT ON (manager_id)') &&
        adapter.includes('GROUP BY action, outcome') &&
        adapter.includes('SELECT created_at') &&
        !/(queryText|tableName|filter|sort|page|transaction)/i.test(adapter),
    'fixed read set drift or generic input appeared',
)
check(
    'Analytics imports Operations only after inherited imports',
    consumer.indexOf("from '@/lib/tasks/volatility-config'") <
        consumer.indexOf("from '@/contracts/operations-observability/v1'") &&
        consumer.indexOf("from '@/contracts/operations-observability/v1'") <
        consumer.indexOf("from '@/modules/operations-observability/public/v1'"),
    'inherited import line identities shifted',
)
check(
    'explicit ensure remains before every clock random and cutoff',
    timing.indexOf('await ensureInterventionActionsRepositoryV1') < timing.indexOf('Date.now()') &&
        logAction.indexOf('await ensureInterventionActionsRepositoryV1') < logAction.indexOf('Date.now()') &&
        logAction.indexOf('await ensureInterventionActionsRepositoryV1') < logAction.indexOf('Math.random()') &&
        evaluate.indexOf('await ensureInterventionActionsRepositoryV1') < evaluate.indexOf('const cutoff') &&
        latest.indexOf('await ensureInterventionActionsRepositoryV1') < latest.indexOf('await listLatestInterventionActionsV1') &&
        effectiveness.indexOf('await ensureInterventionActionsRepositoryV1') < effectiveness.indexOf('await listInterventionOutcomeCountsV1'),
    'explicit ensure ordering drift',
)
check(
    'Analytics retains ID comment and score projections',
    logAction.includes('const id = `ia_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`') &&
        logAction.includes('const comment = params.comment?.trim() || null') &&
        logAction.includes('const score = params.scoreAtAction ?? null') &&
        logAction.includes('scoreAtAction: score'),
    'caller-owned create projection drift',
)
check(
    'latest-action mapping remains caller-owned',
    latest.includes('map.set(r.managerId, {') &&
        latest.includes('timestamp: r.createdAt.toISOString()') &&
        latest.includes('scoreAtAction: r.scoreAtAction') &&
        latest.includes('outcome: (r.outcome as InterventionOutcome) ?? null'),
    'latest action mapping drift',
)
check(
    'outcome cutoff score map evaluation and sequential writes remain caller-owned',
    evaluate.includes('const windowMs = INTERVENTION_OUTCOME_CONFIG.outcomeWindowHours * 60 * 60 * 1000') &&
        evaluate.includes('const cutoff = new Date(Date.now() - windowMs)') &&
        evaluate.includes('const scoreMap = new Map(managers.map(m => [m.managerId, m.healthScore]))') &&
        evaluate.includes('if (currentScore === undefined) continue') &&
        evaluate.includes('const outcome = evaluateOutcome(row.scoreAtAction, currentScore)') &&
        (evaluate.match(/await setInterventionOutcomeV1/g) || []).length === 1 &&
        !/Promise\.all/.test(evaluate),
    'outcome orchestration drift',
)
check(
    'effectiveness parsing labels rates and sort remain caller-owned',
    effectiveness.includes('const count = parseInt(r.total, 10) || 0') &&
        effectiveness.includes('INTERVENTION_ACTION_LABELS[action as InterventionAction] ?? action') &&
        effectiveness.includes('Math.round((counts.improved / total) * 100)') &&
        effectiveness.includes('b.improvementRate - a.improvementRate || b.total - a.total'),
    'effectiveness mapping drift',
)
check(
    'timing math and fallback remain unchanged',
    timing.includes('if (rows.length < cfg.minCompletedForStats) return insufficient') &&
        timing.includes('const recentCutoff = now - cfg.recentPeriodDays * 24 * 60 * 60 * 1000') &&
        timing.includes('newestDaysAgo: Math.max(0, newestDaysAgo)') &&
        timing.includes("console.error('[outcome-timing] Failed to query, returning insufficient:', e)") &&
        timing.includes('return insufficient'),
    'outcome timing or fallback drift',
)
check(
    'team projection still evaluates before loading latest actions',
    consumer.indexOf('await evaluateInterventionOutcomes(') < consumer.indexOf('const lastActions = await getLastInterventionActions()'),
    'team projection ordering drift',
)
check(
    'Analytics contains no intervention repository SQL or direct persistence',
    !/FROM intervention_actions|INSERT INTO intervention_actions|UPDATE intervention_actions|CREATE TABLE IF NOT EXISTS intervention_actions/.test(consumer) &&
        !/prisma\.intervention_actions\./.test(consumer),
    'intervention repository persistence remains in Analytics',
)
check(
    'manifest amendment exposes only the exact repository surface and Analytics edge',
    amendment.amendments?.length === 2 &&
        amendment.amendments[0].context === 'operations_observability' &&
        JSON.stringify(amendment.amendments[0].add_commands) === JSON.stringify([
            'EnsureInterventionActionsRepositoryCommand.v1',
            'CreateInterventionActionCommand.v1',
            'SetInterventionOutcomeCommand.v1',
        ]) &&
        JSON.stringify(amendment.amendments[0].add_public_surface) === JSON.stringify([
            'ListPendingInterventionActionsQuery.v1',
            'ListLatestInterventionActionsQuery.v1',
            'ListInterventionOutcomeCountsQuery.v1',
            'ListCompletedInterventionTimesQuery.v1',
        ]) &&
        amendment.amendments[1].context === 'analytics_reporting' &&
        JSON.stringify(amendment.amendments[1].add_allowed_dependencies) === JSON.stringify([
            { context: 'operations_observability', surface: 'operations_observability.public' },
        ]),
    'manifest amendment widened or drifted',
)
check(
    'strict policy and migration bind the slice to the archived-contact parent',
    policy.manifest_amendments.includes(amendmentPath) &&
        migration.base_commit === 'e8811394458d2ee7e731aa51f5ff00c65d958901' &&
        migration.source_commit === 'fb53587e5377c272fefa58c58d521c8524a8e511',
    'policy or evidence identity drift',
)
check(
    'five accepted write retirements remain closed in later strict registries',
    registry.exceptions.length <= 1414 &&
        (registry.summary?.direct_foreign_prisma_write ?? 0) <= 91 &&
        (registry.summary?.undeclared_dependency ?? 0) <= 370 &&
        [
            'arch_88826812df7607334fe418c0',
            'arch_797839b976905d3a7fc723b8',
            'arch_b6c2382b10f9b0d97aab482a',
            'arch_be72e901fee4b2693481ee1d',
            'arch_e6b0081069429a87f802c5e8',
        ].every(fingerprint => !registry.exceptions.some(entry => entry.fingerprint === fingerprint)) &&
        !registry.exceptions.some(entry =>
            entry.file.includes('legacy-prisma-intervention-actions-repository.ts')
        ),
    'strict registry delta or owner-local classification drift',
)
check(
    'archived accepted registry identity and zero-change comparison remain exact',
    migration.enforcement?.actual_findings === 1414 &&
        migration.enforcement?.actual_direct_foreign_prisma_write === 91 &&
        migration.enforcement?.actual_added === 0 &&
        migration.enforcement?.actual_changed_shared_entries === 0 &&
        migration.enforcement?.finding_digest === '2d262852d9b5e78314a109ea830bc1afbd34b69811fed95fc09f7caf0f0e9f43' &&
        migration.enforcement?.registry_sha256 === 'ec5829f8140b841448e26e9bd4d8d055cc41ea7ddeb8db2728668ee8797843a9',
    'verified registry evidence drift',
)

process.stdout.write(`${JSON.stringify({
    status: failures.length > 0 ? 'FAIL' : 'PASS',
    checks,
    failures,
}, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
