#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
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
const template = (source, name) => {
    const match = new RegExp('const ' + name + ' = `([\\s\\S]*?)`').exec(source)
    return match?.[1] ?? null
}

const sourceRoot = 'gravity-mvp/src'
const applicationPath = 'gravity-mvp/src/modules/operations-observability/application/observability-operations.ts'
const publicIndexPath = 'gravity-mvp/src/modules/operations-observability/public/v1/index.ts'
const consumerPath = 'gravity-mvp/src/app/team-overview/actions.ts'
const publicModule = '@/modules/operations-observability/public/v1'
const applicationModule = '../../application/observability-operations'
const handlerModule = '../public/v1/manager-health-repository-handler'
const adapterModule = '../public/v1/legacy-prisma-manager-health-repository'
const adapterName = 'legacyPrismaManagerHealthRepositoryPortV1'
const healthOperations = [
    ['ensureManagerHealthRepository', 'ensureManagerHealthRepositoryV1', 'createEnsureManagerHealthRepositoryHandlerV1'],
    ['listManagerHealthSnapshots', 'listManagerHealthSnapshotsV1', 'createListManagerHealthSnapshotsHandlerV1'],
    ['saveManagerHealthScores', 'saveManagerHealthScoresV1', 'createSaveManagerHealthScoresHandlerV1'],
    ['listManagerHealthHistory', 'listManagerHealthHistoryV1', 'createListManagerHealthHistoryHandlerV1'],
]
const handlerSpecs = [
    {
        factory: 'createEnsureManagerHealthRepositoryHandlerV1',
        inner: 'ensureManagerHealthRepositoryV1',
        parser: 'parseEnsureManagerHealthRepositoryCommandV1',
        input: 'command',
        portMethod: 'ensure',
        portArguments: [],
    },
    {
        factory: 'createListManagerHealthSnapshotsHandlerV1',
        inner: 'listManagerHealthSnapshotsV1',
        parser: 'parseListManagerHealthSnapshotsQueryV1',
        input: 'query',
        portMethod: 'listSnapshots',
        portArguments: [],
    },
    {
        factory: 'createSaveManagerHealthScoresHandlerV1',
        inner: 'saveManagerHealthScoresV1',
        parser: 'parseSaveManagerHealthScoresCommandV1',
        input: 'command',
        portMethod: 'saveScores',
        portArguments: ['parsed.items'],
    },
    {
        factory: 'createListManagerHealthHistoryHandlerV1',
        inner: 'listManagerHealthHistoryV1',
        parser: 'parseListManagerHealthHistoryQueryV1',
        input: 'query',
        portMethod: 'listHistory',
        portArguments: ['parsed.managerIds', 'parsed.periodDays'],
    },
]
const expectedConsumerCalls = new Map([
    ['ensureManagerHealthRepositoryV1', 3],
    ['listManagerHealthSnapshotsV1', 1],
    ['saveManagerHealthScoresV1', 1],
    ['listManagerHealthHistoryV1', 1],
])
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
            for (const binding of statement.exportClause.elements) if (!binding.isTypeOnly) records.push({
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
const dynamicNamedImports = (sourceFile) => {
    const records = []
    walk(sourceFile, node => {
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
const identifierCalls = (node, name) => {
    const calls = []
    walk(node, candidate => {
        if (ts.isCallExpression(candidate) && isIdentifier(candidate.expression, name)) calls.push(candidate)
    })
    return calls
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
const callsByChain = (node, chain) => {
    const calls = []
    walk(node, candidate => {
        if (ts.isCallExpression(candidate) && propertyChain(candidate.expression) === chain) calls.push(candidate)
    })
    return calls
}
const exactFactoryBinding = (sourceFile, local, factory) => {
    const declarations = declarationsNamed(sourceFile, local)
    if (declarations.length !== 1 || (declarations[0].parent.flags & ts.NodeFlags.Const) === 0) return null
    const initializer = unwrap(declarations[0].initializer)
    return initializer && ts.isCallExpression(initializer) && isIdentifier(initializer.expression, factory)
        && initializer.arguments.length === 1 && isIdentifier(initializer.arguments[0], adapterName)
        ? initializer : null
}
const exactForwardingWrapper = (sourceFile, exported, local) => {
    const declarations = declarationsNamed(sourceFile, exported)
    if (declarations.length !== 1 || (declarations[0].parent.flags & ts.NodeFlags.Const) === 0) return null
    const statement = declarations[0].parent.parent
    const initializer = unwrap(declarations[0].initializer)
    if (!ts.isVariableStatement(statement) || !hasExport(statement)
        || !initializer || !ts.isArrowFunction(initializer) || initializer.parameters.length !== 1) return null
    const parameter = initializer.parameters[0]
    const body = unwrap(initializer.body)
    if (!parameter.dotDotDotToken || !isIdentifier(parameter.name, 'args') || !parameter.type
        || !ts.isTypeReferenceNode(parameter.type) || !isIdentifier(parameter.type.typeName, 'Parameters')
        || parameter.type.typeArguments?.length !== 1 || !ts.isTypeQueryNode(parameter.type.typeArguments[0])
        || !isIdentifier(parameter.type.typeArguments[0].exprName, local)) return null
    return ts.isCallExpression(body) && isIdentifier(body.expression, local)
        && body.arguments.length === 1 && ts.isSpreadElement(body.arguments[0])
        && isIdentifier(body.arguments[0].expression, 'args') ? body : null
}
const sourceIndexCache = new WeakMap()
const sourceIndex = (sources) => {
    const cached = sourceIndexCache.get(sources)
    if (cached) return cached
    const targets = new Set([
        adapterName,
        ...healthOperations.flatMap(([, operation, factory]) => [operation, factory]),
    ])
    const imports = []
    const calls = new Map([...targets].map(target => [target, []]))
    const propertyBypasses = new Map([...targets].map(target => [target, 0]))
    for (const [file, source] of sources) {
        if (![...targets].some(target => source.includes(target))) continue
        const sourceFile = parse(file, source)
        for (const binding of [...allNamedImports(sourceFile), ...dynamicNamedImports(sourceFile)]) {
            if (targets.has(binding.imported)) imports.push({ file, ...binding })
        }
        walk(sourceFile, node => {
            if (ts.isCallExpression(node) && ts.isIdentifier(unwrap(node.expression))
                && targets.has(unwrap(node.expression).text)) calls.get(unwrap(node.expression).text).push({ file, node })
            if (ts.isPropertyAccessExpression(node) && targets.has(node.name.text)) {
                propertyBypasses.set(node.name.text, propertyBypasses.get(node.name.text) + 1)
            }
        })
    }
    const index = { imports, calls, propertyBypasses }
    sourceIndexCache.set(sources, index)
    return index
}
const exactRepositoryConsumers = (sources) => {
    const index = sourceIndex(sources)
    return healthOperations.every(([, operation, factory]) => {
        const operationImports = index.imports.filter(record => record.imported === operation)
        const factoryImports = index.imports.filter(record => record.imported === factory)
        return operationImports.length === 1 && operationImports[0].file === consumerPath
            && operationImports[0].module === publicModule && operationImports[0].local === operation
            && index.calls.get(operation).length === expectedConsumerCalls.get(operation)
            && index.calls.get(operation).every(record => record.file === consumerPath)
            && index.propertyBypasses.get(operation) === 0
            && factoryImports.length === 1 && factoryImports[0].file === applicationPath
            && factoryImports[0].module === handlerModule && factoryImports[0].local === factory
    }) && (() => {
        const adapterImports = index.imports.filter(record => record.imported === adapterName)
        return adapterImports.length === 1 && adapterImports[0].file === applicationPath
            && adapterImports[0].module === adapterModule && adapterImports[0].local === adapterName
            && index.propertyBypasses.get(adapterName) === 0
    })()
}
const exactHealthComposition = (sources) => {
    const application = parse(applicationPath, sources.get(applicationPath) ?? '')
    const publicIndex = parse(publicIndexPath, sources.get(publicIndexPath) ?? '')
    if (application.parseDiagnostics.length || publicIndex.parseDiagnostics.length) return false
    const factoryBindings = staticNamedBindings(application, 'import', handlerModule)
    const adapterBindings = staticNamedBindings(application, 'import', adapterModule)
    const publicBindings = staticNamedBindings(publicIndex, 'export', applicationModule)
    const factories = healthOperations.map(([local, , factory]) => exactFactoryBinding(application, local, factory))
    const wrappers = healthOperations.map(([local, operation]) => exactForwardingWrapper(application, operation, local))
    const adapterCalls = []
    let adapterIdentifiers = 0
    walk(application, node => {
        if (ts.isIdentifier(node) && node.text === adapterName) adapterIdentifiers += 1
        if (ts.isCallExpression(node) && node.arguments.some(argument => isIdentifier(argument, adapterName))) {
            adapterCalls.push(node)
        }
    })
    const exposedModules = publicIndex.statements.filter(statement => (
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
        && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
    )).map(statement => statement.moduleSpecifier.text)
    const expectedNames = healthOperations.map(([, operation]) => operation).sort()
    const targetPublicBindings = publicBindings.filter(binding => /ManagerHealth(?:Repository|Snapshots|Scores|History)V1$/.test(binding.local))
        .map(binding => binding.local).sort()
    return healthOperations.every(([, operation, factory]) => (
        factoryBindings.filter(binding => binding.imported === factory && binding.local === factory).length === 1
        && publicBindings.filter(binding => binding.imported === operation && binding.local === operation).length === 1
    ))
        && adapterBindings.length === 1 && adapterBindings[0].imported === adapterName && adapterBindings[0].local === adapterName
        && factories.every(Boolean) && wrappers.every(Boolean)
        && adapterCalls.length === healthOperations.length && factories.every(call => adapterCalls.includes(call))
        && adapterIdentifiers === healthOperations.length + 1
        && healthOperations.every(([local]) => identifierCalls(application, local).length === 1)
        && JSON.stringify(targetPublicBindings) === JSON.stringify(expectedNames)
        && !exposedModules.some(module => module.includes('legacy-prisma-manager-health-repository'))
        && exactRepositoryConsumers(sources)
}
const findFunction = (sourceFile, name) => {
    const functions = []
    walk(sourceFile, node => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) functions.push(node)
    })
    return functions.length === 1 ? functions[0] : null
}
const exactHealthHandlers = (source) => {
    const sourceFile = parse('manager-health-repository-handler.ts', source)
    if (sourceFile.parseDiagnostics.length) return false
    return handlerSpecs.every(spec => {
        const factory = sourceFile.statements.filter(statement => ts.isFunctionDeclaration(statement)
            && statement.name?.text === spec.factory && hasExport(statement))
        if (factory.length !== 1 || !factory[0].body || factory[0].parameters.length !== 1
            || !isIdentifier(factory[0].parameters[0].name, 'port')) return false
        const returns = factory[0].body.statements.filter(ts.isReturnStatement)
        const inner = returns.length === 1 ? unwrap(returns[0].expression) : null
        if (!inner || !ts.isFunctionExpression(inner)
            || !inner.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
            || inner.name?.text !== spec.inner || !inner.body || inner.parameters.length !== 1
            || !isIdentifier(inner.parameters[0].name, spec.input)) return false
        const parserCalls = identifierCalls(inner.body, spec.parser)
        const portCalls = callsByChain(inner.body, `port.${spec.portMethod}`)
        const catches = []
        walk(inner.body, node => {
            if (ts.isCatchClause(node)) catches.push(node)
        })
        return parserCalls.length === 1 && parserCalls[0].arguments.length === 1
            && isIdentifier(parserCalls[0].arguments[0], spec.input)
            && portCalls.length === 1 && ts.isAwaitExpression(portCalls[0].parent)
            && portCalls[0].arguments.length === spec.portArguments.length
            && portCalls[0].arguments.every((argument, index) => (
                argument.getText(sourceFile).replace(/\s+/g, '') === spec.portArguments[index]
            ))
            && parserCalls[0].getStart(sourceFile) < portCalls[0].getStart(sourceFile)
            && catches.length === 0
    })
}
const exactCallEnvelope = (sourceFile, call, fields) => {
    if (call.arguments.length !== 1 || !ts.isObjectLiteralExpression(unwrap(call.arguments[0]))) return false
    const properties = unwrap(call.arguments[0]).properties
    if (properties.length !== Object.keys(fields).length || !properties.every(property => (
        ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
    ))) return false
    const actual = Object.fromEntries(properties.map(property => [
        property.name.getText(sourceFile),
        ts.isShorthandPropertyAssignment(property) ? property.name : unwrap(property.initializer),
    ]))
    return Object.entries(fields).every(([key, identifier]) => isIdentifier(actual[key], identifier))
}
const exactHealthConsumerWrappers = (source) => {
    const sourceFile = parse(consumerPath, source)
    if (sourceFile.parseDiagnostics.length) return false
    const previous = findFunction(sourceFile, 'getPreviousHealthScores')
    const save = findFunction(sourceFile, 'saveHealthScores')
    const history = findFunction(sourceFile, 'getHealthHistory')
    if (!previous?.body || !save?.body || !history?.body) return false
    const ensurePrevious = identifierCalls(previous.body, 'ensureManagerHealthRepositoryV1')
    const snapshots = identifierCalls(previous.body, 'listManagerHealthSnapshotsV1')
    const ensureSave = identifierCalls(save.body, 'ensureManagerHealthRepositoryV1')
    const saves = identifierCalls(save.body, 'saveManagerHealthScoresV1')
    const ensureHistory = identifierCalls(history.body, 'ensureManagerHealthRepositoryV1')
    const histories = identifierCalls(history.body, 'listManagerHealthHistoryV1')
    const all = [ensurePrevious, snapshots, ensureSave, saves, ensureHistory, histories]
    if (all.some(calls => calls.length !== 1 || !ts.isAwaitExpression(calls[0].parent))) return false
    const wrapperOperations = healthOperations.map(([, operation]) => operation)
    if ([previous, save, history].some(fn => wrapperOperations.reduce(
        (count, operation) => count + identifierCalls(fn.body, operation).length,
        0,
    ) !== 2)) return false
    return ensurePrevious[0].getStart(sourceFile) < snapshots[0].getStart(sourceFile)
        && ensureSave[0].getStart(sourceFile) < saves[0].getStart(sourceFile)
        && ensureHistory[0].getStart(sourceFile) < histories[0].getStart(sourceFile)
        && exactCallEnvelope(sourceFile, ensurePrevious[0], { contract: 'ENSURE_MANAGER_HEALTH_REPOSITORY_COMMAND_V1' })
        && exactCallEnvelope(sourceFile, snapshots[0], { contract: 'LIST_MANAGER_HEALTH_SNAPSHOTS_QUERY_V1' })
        && exactCallEnvelope(sourceFile, ensureSave[0], { contract: 'ENSURE_MANAGER_HEALTH_REPOSITORY_COMMAND_V1' })
        && exactCallEnvelope(sourceFile, saves[0], {
            contract: 'SAVE_MANAGER_HEALTH_SCORES_COMMAND_V1',
            items: 'snapshots',
        })
        && exactCallEnvelope(sourceFile, ensureHistory[0], { contract: 'ENSURE_MANAGER_HEALTH_REPOSITORY_COMMAND_V1' })
        && exactCallEnvelope(sourceFile, histories[0], {
            contract: 'LIST_MANAGER_HEALTH_HISTORY_QUERY_V1',
            managerIds: 'managerIds',
            periodDays: 'days',
        })
}
const exactHealthAstBoundary = (sources) => exactHealthComposition(sources)
    && exactHealthConsumerWrappers(sources.get(consumerPath) ?? '')
    && exactHealthHandlers(sources.get('gravity-mvp/src/modules/operations-observability/public/v1/manager-health-repository-handler.ts') ?? '')

const contract = read('gravity-mvp/src/contracts/operations-observability/v1/manager-health-repository.ts')
const handler = read('gravity-mvp/src/modules/operations-observability/public/v1/manager-health-repository-handler.ts')
const adapter = read('gravity-mvp/src/modules/operations-observability/public/v1/legacy-prisma-manager-health-repository.ts')
const publicIndex = read('gravity-mvp/src/modules/operations-observability/public/v1/index.ts')
const applicationOperations = read('gravity-mvp/src/modules/operations-observability/application/observability-operations.ts')
const consumer = read('gravity-mvp/src/app/team-overview/actions.ts')
const config = read('gravity-mvp/src/lib/tasks/manager-health-config.ts')
const amendmentPath = 'architecture/isolation/operations-observability/manager-health-v1/module-manifest-amendments.json'
const amendment = JSON.parse(read(amendmentPath))
const migration = JSON.parse(read('architecture/isolation/operations-observability/manager-health-v1/migration-manifest.json'))
const verification = JSON.parse(read('architecture/isolation/operations-observability/manager-health-v1/verification.json'))
const behavior = JSON.parse(read('architecture/isolation/operations-observability/manager-health-v1/BEHAVIOR-FREEZE.json'))
const policy = JSON.parse(read('architecture/enforcement/v1/policy.json'))
const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const ensureFunction = sliceBetween(adapter, 'async function ensureTable', 'export const legacyPrismaManagerHealthRepositoryPortV1')
const previousWrapper = sliceBetween(consumer, 'async function getPreviousHealthScores', 'async function saveHealthScores')
const saveWrapper = sliceBetween(consumer, 'async function saveHealthScores', 'async function getHealthHistory')
const historyWrapper = sliceBetween(consumer, 'async function getHealthHistory', 'export async function getTeamOverview')
const adapterSourceFile = parse(
    'gravity-mvp/src/modules/operations-observability/public/v1/legacy-prisma-manager-health-repository.ts',
    adapter,
)
const ensureFunctionNode = findFunction(adapterSourceFile, 'ensureTable')
const ensureExecuteCalls = ensureFunctionNode?.body
    ? callsByChain(ensureFunctionNode.body, 'prisma.$executeRawUnsafe') : []
const adapterExecuteCalls = callsByChain(adapterSourceFile, 'prisma.$executeRawUnsafe')
const adapterQueryCalls = callsByChain(adapterSourceFile, 'prisma.$queryRawUnsafe')
const currentAstBoundaryIsValid = exactHealthAstBoundary(repositorySources)
const withSource = (sources, file, source) => new Map([...sources, [file, source]])
const ensureWrapper = 'export const ensureManagerHealthRepositoryV1 = (...args: Parameters<typeof ensureManagerHealthRepository>) => ensureManagerHealthRepository(...args)'
const ensureEnvelope = `    await ensureManagerHealthRepositoryV1({
        contract: ENSURE_MANAGER_HEALTH_REPOSITORY_COMMAND_V1,
    })`
const failClosedAstProbes = [
    withSource(
        repositorySources,
        applicationPath,
        applicationOperations.replace(ensureWrapper, `// ${ensureWrapper}`),
    ),
    withSource(repositorySources, consumerPath, consumer.replace(ensureEnvelope, `${ensureEnvelope}\n${ensureEnvelope}`)),
    withSource(repositorySources, consumerPath, consumer.replace(publicModule, '@/modules/operations-observability/application/observability-operations')),
    new Map([...repositorySources, [
        'gravity-mvp/src/app/manager-health-consumer-probe.ts',
        `import { listManagerHealthHistoryV1 } from '${publicModule}'\nvoid listManagerHealthHistoryV1\n`,
    ]]),
]

const expectedDdl = {
    ENSURE_TABLE_SQL: `
CREATE TABLE IF NOT EXISTS health_snapshots (
  manager_id TEXT PRIMARY KEY,
  score INTEGER NOT NULL,
  decline_streak INTEGER NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
    ENSURE_COLUMN_SQL: `
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'health_snapshots' AND column_name = 'decline_streak'
  ) THEN
    ALTER TABLE health_snapshots ADD COLUMN decline_streak INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$`,
    ENSURE_HISTORY_TABLE_SQL: `
CREATE TABLE IF NOT EXISTS health_score_history (
  id SERIAL PRIMARY KEY,
  manager_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  health_level TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
    ENSURE_HISTORY_INDEX_SQL: `
CREATE INDEX IF NOT EXISTS idx_hsh_manager_date
  ON health_score_history (manager_id, recorded_at DESC)`,
}

check(
    'contract and handler are infrastructure neutral',
    !/(prisma|next\/|@\/lib|@\/app)/i.test(contract + handler),
    'public surface leaks infrastructure',
)
check(
    'four exact request envelopes and results are versioned',
    (contract.match(/operations_observability\.[A-Za-z]+(?:Command|Query)\.v1/g) || []).length === 4 &&
        (contract.match(/operations_observability\.[A-Za-z]+Result\.v1/g) || []).length === 4,
    'contract identity count drift',
)
check(
    'public capability is closed and repository specific',
    !/(tableName|sql|filterBy|sortBy|page|transaction|predicate|whereClause)/i.test(contract + handler) &&
        contract.includes("['healthy', 'warning', 'critical'] as const") &&
        contract.includes('managerIds: string[]') &&
        contract.includes('periodDays: number') &&
        contract.includes('MANAGER_HEALTH_MAX_HISTORY_PERIOD_DAYS_V1 = 30 as const'),
    'generic or open-ended repository capability leaked',
)
check(
    'strict parsers reject extra fields and unsupported versions',
    (contract.match(/export function parse[A-Za-z]+(?:Command|Query)V1/g) || []).length === 4 &&
        contract.includes("extra.sort().join(', ')") &&
        contract.includes("'UNSUPPORTED_CONTRACT_VERSION'") &&
        contract.includes('Number.isFinite(value)') &&
        contract.includes("value.trim() !== ''") &&
        contract.includes('value.periodDays > MANAGER_HEALTH_MAX_HISTORY_PERIOD_DAYS_V1'),
    'parser coverage or validation policy drift',
)
check(
    'arrays preserve order and duplicates without deduplication',
    contract.includes('value.items.forEach((item, index)') &&
        contract.includes('value.managerIds.forEach((managerId, index)') &&
        !/(new Set\(value\.(?:items|managerIds)|value\.(?:items|managerIds)\.(?:filter|sort)\()/.test(contract),
    'contract reorders or deduplicates caller input',
)
check(
    'one named repository port owns one compatibility ensure two reads and one composite write',
    handler.includes('export interface ManagerHealthRepositoryPortV1') &&
        ['ensure():', 'listSnapshots():', 'saveScores(items:', 'listHistory(managerIds:'].every(value => handler.includes(value)),
    'repository port shape drift',
)
check(
    'handlers parse before ports and never catch failures',
    exactHealthHandlers(handler),
    'handler validation or failure visibility drift',
)
check(
    'application composition binds all public facades to the same owner repository',
    currentAstBoundaryIsValid,
    'application repository composition or narrow public export drift',
)
check(
    'manager-health AST boundary is fail-closed against spoofing and bypasses',
    currentAstBoundaryIsValid && failClosedAstProbes.length === 4
        && failClosedAstProbes.every(probe => !exactHealthAstBoundary(probe)),
    'AST detector accepted a comment, extra operation, private bypass, or extra consumer',
)
check(
    'compatibility DDL bytes are exact',
    Object.entries(expectedDdl).every(([name, sql]) => template(adapter, name) === sql),
    'compatibility DDL byte drift',
)
check(
    'DDL remains four separate sequential autocommit awaits',
    ensureExecuteCalls.length === 4 && ensureExecuteCalls.every(call => ts.isAwaitExpression(call.parent)) &&
        ensureExecuteCalls.map(call => call.arguments.length === 1 ? call.arguments[0].getText(adapterSourceFile) : null).join(',') ===
            'ENSURE_TABLE_SQL,ENSURE_COLUMN_SQL,ENSURE_HISTORY_TABLE_SQL,ENSURE_HISTORY_INDEX_SQL' &&
        ensureExecuteCalls[3].getStart(adapterSourceFile) < ensureFunction.indexOf('tableEnsured = true') + ensureFunctionNode.getStart(adapterSourceFile) &&
        !/Promise\.all|\$transaction/.test(ensureFunction),
    'DDL state-machine order or autocommit behavior drift',
)
check(
    'ensure flag preserves retry and uncoalesced first-call race',
    ensureFunction.indexOf('if (tableEnsured) return') < ensureFunction.indexOf('await prisma.$executeRawUnsafe') &&
        !/(ensurePromise|inFlight|pendingEnsure|mutex|lock)/i.test(adapter),
    'ensure state acquired a lock or changed retry behavior',
)
check(
    'empty writes and history reads return before ensure',
    adapter.indexOf('if (items.length === 0) return') < adapter.indexOf('await ensureTable()', adapter.indexOf('async saveScores')) &&
        adapter.indexOf('if (managerIds.length === 0) return []') < adapter.indexOf('await ensureTable()', adapter.indexOf('async listHistory')),
    'empty-input compatibility guard moved',
)
check(
    'primary batch write is one fixed bound statement retaining order and duplicates',
    adapter.includes('FROM UNNEST($1::text[], $2::integer[], $3::integer[])') &&
        adapter.includes('WITH ORDINALITY AS v(manager_id, score, decline_streak, ordinal)') &&
        adapter.includes('ORDER BY v.ordinal\nON CONFLICT (manager_id)') &&
        adapter.includes('await prisma.$executeRawUnsafe(SAVE_SNAPSHOTS_SQL, managerIds, scores, declineStreaks)') &&
        !/(new Set|\$transaction|Promise\.all)/.test(adapter),
    'primary batch mapping or same-statement duplicate behavior drift',
)
check(
    'history append remains a second best-effort fixed bound statement',
    adapter.includes('FROM UNNEST($1::text[], $2::integer[], $3::text[])') &&
        adapter.includes("h.recorded_at > NOW() - INTERVAL '1 hour'") &&
        adapter.includes("console.error('[health-history] Failed to write history, continuing:', error)") &&
        adapter.indexOf('await prisma.$executeRawUnsafe(SAVE_SNAPSHOTS_SQL') < adapter.indexOf('try {') &&
        adapter.indexOf('try {') < adapter.indexOf('await prisma.$executeRawUnsafe(APPEND_HISTORY_SQL'),
    'history statement ordering, predicate, or error policy drift',
)
check(
    'history query is fixed bound ordered and retains permissive period values',
    adapter.includes('manager_id = ANY($1::text[])') &&
        adapter.includes("$2::double precision * INTERVAL '1 day'") &&
        adapter.includes('ORDER BY manager_id, recorded_at ASC') &&
        adapter.includes('LIST_HISTORY_SQL, managerIds, periodDays'),
    'history query acquired interpolation or policy drift',
)
check(
    'adapter contains no dynamic SQL fragments clocks or transactions',
    !/\$\{/.test(adapter) &&
        !/new Date|Date\.now|\$transaction/.test(adapter) &&
        adapterExecuteCalls.length === 6 && adapterExecuteCalls.every(call => ts.isAwaitExpression(call.parent)) &&
        adapterQueryCalls.length === 2 && adapterQueryCalls.every(call => ts.isAwaitExpression(call.parent)),
    'adapter expanded SQL authority or moved clock ownership',
)
check(
    'pure manager health module is persistence free',
    !/(prisma|operations-observability|\$executeRaw|\$queryRaw|CREATE TABLE|INSERT INTO|SELECT manager_id)/i.test(config) &&
        config.includes('export interface HealthSnapshot') &&
        config.includes('export interface PreviousHealthData') &&
        config.includes('export function updateDeclineStreak') &&
        config.includes('export function isSustainedDecline'),
    'persistence remains in the Work-owned pure module',
)
check(
    'Analytics imports Operations only after inherited pure imports',
    consumer.indexOf("from '@/lib/tasks/volatility-config'") <
        consumer.indexOf("from '@/contracts/operations-observability/v1'") &&
        consumer.indexOf("from '@/contracts/operations-observability/v1'") <
        consumer.indexOf("from '@/modules/operations-observability/public/v1'"),
    'inherited import placement shifted',
)
check(
    'previous snapshot wrapper preserves ensure read and map order',
    exactHealthConsumerWrappers(consumer) &&
        previousWrapper.includes('result.set(item.managerId, { score: item.score, declineStreak: item.declineStreak })') &&
        !/try|catch/.test(previousWrapper),
    'previous snapshot failure or mapping semantics drift',
)
check(
    'save wrapper preserves empty guard ensure and visible primary failures',
    exactHealthConsumerWrappers(consumer) &&
        saveWrapper.indexOf('if (snapshots.length === 0) return') < saveWrapper.indexOf('await ensureManagerHealthRepositoryV1') &&
        !/try|catch/.test(saveWrapper),
    'save orchestration or failure policy drift',
)
check(
    'history wrapper preserves cap mapping and exact read fallback',
    exactHealthConsumerWrappers(consumer) &&
        historyWrapper.indexOf('if (managerIds.length === 0) return result') < historyWrapper.indexOf('try {') &&
        historyWrapper.indexOf('await ensureManagerHealthRepositoryV1') < historyWrapper.indexOf('const days = Math.min(') &&
        historyWrapper.includes('periodDays ?? HEALTH_HISTORY_CONFIG.defaultPeriodDays') &&
        historyWrapper.includes('HEALTH_HISTORY_CONFIG.maxPeriodDays') &&
        historyWrapper.includes('periodDays: days') &&
        historyWrapper.includes('healthLevel: item.healthLevel as HealthLevel') &&
        historyWrapper.includes("console.error('[health-history] Failed to read history, returning empty:', e)") &&
        historyWrapper.trimEnd().endsWith('return result\n}'),
    'history cap, mapping, or failure-tolerant policy drift',
)
check(
    'consumer contains no manager-health repository SQL or direct persistence',
    !/CREATE TABLE IF NOT EXISTS health_|INSERT INTO health_|FROM health_|prisma\.health/i.test(consumer),
    'manager-health persistence remains in Analytics',
)
check(
    'manifest amendment exposes only the exact owner repository surface',
    amendment.amendments?.length === 1 &&
        amendment.amendments[0].context === 'operations_observability' &&
        JSON.stringify(amendment.amendments[0].add_commands) === JSON.stringify([
            'EnsureManagerHealthRepositoryCommand.v1',
            'SaveManagerHealthScoresCommand.v1',
        ]) &&
        JSON.stringify(amendment.amendments[0].add_public_surface) === JSON.stringify([
            'ListManagerHealthSnapshotsQuery.v1',
            'ListManagerHealthHistoryQuery.v1',
        ]) &&
        amendment.amendments[0].add_allowed_dependencies === undefined,
    'manifest amendment widened or added a dependency',
)
check(
    'strict policy retains the amendment and migration binds the slice to the intervention parent',
    policy.manifest_amendments.includes(amendmentPath) &&
        migration.base_commit === '61f0afc9c22590d3344dfbcea6c5f4a580459a7d' &&
        migration.source_commit === '8aeccb755b3fad942a69a23799f76f7a480f4d4f',
    'policy or evidence identity drift',
)
check(
    'six accepted manager-health write retirements remain closed in later strict registries',
    registry.exceptions.length <= 1408 &&
        (registry.summary?.direct_foreign_prisma_write ?? 0) <= 85 &&
        (registry.summary?.direct_provider_transport_access ?? 0) <= 38 &&
        (registry.summary?.internal_module_import ?? 0) <= 379 &&
        (registry.summary?.non_public_cross_context_import ?? 0) <= 536 &&
        (registry.summary?.undeclared_dependency ?? 0) <= 370 &&
        [
            'arch_880b7dfae43971c822502b90',
            'arch_3251166f174bce021d52ecef',
            'arch_10ee9720cfdccbead6e5ce70',
            'arch_c03fd6c4c21c0595bbc73678',
            'arch_4115f2efad420d474a99e256',
            'arch_9379c33dd717fc04b6f50ea3',
        ].every(fingerprint => !registry.exceptions.some(entry => entry.fingerprint === fingerprint)) &&
        !registry.exceptions.some(entry =>
            entry.file.includes('legacy-prisma-manager-health-repository.ts')
        ),
    'strict registry delta or owner-local classification drift',
)
check(
    'archived accepted registry identity and zero-change set comparison remain exact',
    migration.enforcement?.actual_findings === 1408 &&
        migration.enforcement?.actual_direct_foreign_prisma_write === 85 &&
        migration.enforcement?.actual_undeclared_dependency === 370 &&
        migration.enforcement?.actual_removed === 6 &&
        migration.enforcement?.actual_added === 0 &&
        migration.enforcement?.actual_changed_shared_entries === 0 &&
        migration.enforcement?.finding_digest === 'f1508b169b806c8a8b2b6cdf2ff5feb0b3235296d9fb24fa93e3c955242f10e8' &&
        migration.enforcement?.registry_sha256 === 'fc04f70cb1a6898275a6ad70668f67245d994802a4e55f10e996b47b49881f1d',
    'verified registry evidence drift',
)
check(
    'behavior and verification evidence bind the frozen source and non-execution boundary',
    behavior.source_commit === '8aeccb755b3fad942a69a23799f76f7a480f4d4f' &&
        behavior.consumer_before_sha256 === 'f9529a3d36604c938035c2ed4b4064c15ff3c5e17634668b88e512190c2cf2db' &&
        behavior.consumer_after_sha256 === '2fea6763e1eba0247589c4b0f9ea0a88e4571f67ffe102c57660d34140cc21bc' &&
        behavior.pure_module_before_sha256 === 'b911692a7f5e735af482c0a202e5c86b5900ed7d89fbd16fcd1339c9ffef7b47' &&
        behavior.pure_module_after_sha256 === '58931ef529031ca72e104b315cf8a296547a9196963f5f05490f77b72771ef5f' &&
        verification.database_accessed === false &&
        verification.manager_health_repository_executed_against_database === false &&
        verification.production_mutated === false &&
        verification.secret_values_read_or_emitted === false,
    'source hash or non-execution evidence drift',
)

process.stdout.write(`${JSON.stringify({
    status: failures.length > 0 ? 'FAIL' : 'PASS',
    checks,
    failures,
}, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
