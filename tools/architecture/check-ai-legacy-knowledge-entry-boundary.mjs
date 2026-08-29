#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

const read = (file) => fs.readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, passed, detail) => passed ? checks.push(name) : failures.push({ check: name, detail })
const section = (source, startName, endName) => source.slice(
    source.indexOf(`export async function ${startName}`),
    source.indexOf(`export async function ${endName}`),
)

const contract = read('gravity-mvp/src/contracts/ai-knowledge/v1/legacy-knowledge-entry-commands.ts')
const contractIndex = read('gravity-mvp/src/contracts/ai-knowledge/v1/index.ts')
const handler = read('gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-knowledge-entry-handler.ts')
const adapter = read('gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-prisma-legacy-knowledge-entry-adapter.ts')
const publicIndex = read('gravity-mvp/src/modules/ai-knowledge/public/v1/index.ts')
const application = read('gravity-mvp/src/modules/ai-knowledge/application/knowledge-operations.ts')
const consumer = read('gravity-mvp/src/app/settings/ai/actions.ts')
const amendmentPath = 'architecture/isolation/ai-knowledge/legacy-knowledge-entry-v1/module-manifest-amendments.json'
const amendment = JSON.parse(read(amendmentPath))
const migration = JSON.parse(read('architecture/isolation/ai-knowledge/legacy-knowledge-entry-v1/migration-manifest.json'))
const policy = JSON.parse(read('architecture/enforcement/v1/policy.json'))
const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const create = section(consumer, 'createKnowledgeEntry', 'updateKnowledgeEntry')
const update = section(consumer, 'updateKnowledgeEntry', 'deleteKnowledgeEntry')
const del = section(consumer, 'deleteKnowledgeEntry', 'getDecisionLogs')
const forbiddenPublicSurface = /(KnowledgeBaseEntry|prisma|next\/|@\/lib|@\/app|apiKey|credential|provider|\bSQL\b|tableName)/i

const sourceRoot = 'gravity-mvp/src'
const applicationPath = 'gravity-mvp/src/modules/ai-knowledge/application/knowledge-operations.ts'
const publicIndexPath = 'gravity-mvp/src/modules/ai-knowledge/public/v1/index.ts'
const consumerPath = 'gravity-mvp/src/app/settings/ai/actions.ts'
const publicModule = '@/modules/ai-knowledge/public/v1'
const applicationModule = '../../application/knowledge-operations'
const adapterModule = '../public/v1/legacy-prisma-legacy-knowledge-entry-adapter'
const adapterName = 'legacyPrismaLegacyKnowledgeEntryPortV1'
const legacyOperations = [
    ['createLegacyKnowledgeEntry', 'createLegacyKnowledgeEntryV1', 'createCreateLegacyKnowledgeEntryHandlerV1'],
    ['updateLegacyKnowledgeEntry', 'updateLegacyKnowledgeEntryV1', 'createUpdateLegacyKnowledgeEntryHandlerV1'],
    ['deleteLegacyKnowledgeEntry', 'deleteLegacyKnowledgeEntryV1', 'createDeleteLegacyKnowledgeEntryHandlerV1'],
]

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
    ts.forEachChild(node, (child) => walk(child, visit))
}
const hasModifier = (node, kind) => node.modifiers?.some((modifier) => modifier.kind === kind) ?? false
const unwrap = (node) => {
    let current = node
    while (current && (
        ts.isParenthesizedExpression(current)
        || ts.isAsExpression(current)
        || ts.isTypeAssertionExpression(current)
        || ts.isNonNullExpression(current)
        || ts.isSatisfiesExpression(current)
    )) current = current.expression
    return current
}
const staticNamedBindings = (sourceFile, direction, specifier) => {
    const records = []
    for (const statement of sourceFile.statements) {
        if (direction === 'import' && ts.isImportDeclaration(statement)) {
            if (!ts.isStringLiteralLike(statement.moduleSpecifier) || statement.moduleSpecifier.text !== specifier) continue
            const clause = statement.importClause
            if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue
            for (const binding of clause.namedBindings.elements) {
                if (!binding.isTypeOnly) records.push({
                    imported: binding.propertyName?.text ?? binding.name.text,
                    local: binding.name.text,
                    statement,
                })
            }
        }
        if (direction === 'export' && ts.isExportDeclaration(statement)) {
            if (!statement.moduleSpecifier || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue
            if (statement.moduleSpecifier.text !== specifier || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue
            for (const binding of statement.exportClause.elements) records.push({
                imported: binding.propertyName?.text ?? binding.name.text,
                local: binding.name.text,
                statement,
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
        for (const binding of clause.namedBindings.elements) {
            if (!binding.isTypeOnly) records.push({
                module: statement.moduleSpecifier.text,
                imported: binding.propertyName?.text ?? binding.name.text,
                local: binding.name.text,
            })
        }
    }
    return records
}
const dynamicNamedImports = (sourceFile) => {
    const records = []
    walk(sourceFile, (node) => {
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
const variableDeclaration = (sourceFile, name) => sourceFile.statements.flatMap((statement) => (
    ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []
)).filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name)
const isConstDeclaration = (declaration) => (
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
)
const isIdentifier = (node, name) => ts.isIdentifier(unwrap(node)) && unwrap(node).text === name
const exactFactoryBinding = (sourceFile, local, factory) => {
    const declarations = variableDeclaration(sourceFile, local)
    if (declarations.length !== 1 || !isConstDeclaration(declarations[0])) return null
    const initializer = unwrap(declarations[0].initializer)
    return initializer && ts.isCallExpression(initializer)
        && isIdentifier(initializer.expression, factory)
        && initializer.arguments.length === 1
        && isIdentifier(initializer.arguments[0], adapterName)
        ? initializer
        : null
}
const exactForwardingWrapper = (sourceFile, exported, local) => {
    const declarations = variableDeclaration(sourceFile, exported)
    if (declarations.length !== 1 || !isConstDeclaration(declarations[0])) return null
    const statement = declarations[0].parent.parent
    const initializer = unwrap(declarations[0].initializer)
    if (!ts.isVariableStatement(statement) || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return null
    if (!initializer || !ts.isArrowFunction(initializer) || initializer.parameters.length !== 1) return null
    const parameter = initializer.parameters[0]
    if (!parameter.dotDotDotToken || !ts.isIdentifier(parameter.name) || parameter.name.text !== 'args') return null
    if (!parameter.type || !ts.isTypeReferenceNode(parameter.type)
        || !ts.isIdentifier(parameter.type.typeName) || parameter.type.typeName.text !== 'Parameters'
        || parameter.type.typeArguments?.length !== 1 || !ts.isTypeQueryNode(parameter.type.typeArguments[0])
        || !ts.isIdentifier(parameter.type.typeArguments[0].exprName)
        || parameter.type.typeArguments[0].exprName.text !== local) return null
    const body = unwrap(initializer.body)
    return ts.isCallExpression(body)
        && isIdentifier(body.expression, local)
        && body.arguments.length === 1
        && ts.isSpreadElement(body.arguments[0])
        && isIdentifier(body.arguments[0].expression, 'args')
        ? body
        : null
}
const callsOf = (sourceFile, name) => {
    const calls = []
    walk(sourceFile, (node) => {
        if (ts.isCallExpression(node) && isIdentifier(node.expression, name)) calls.push(node)
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
const callsByChain = (sourceFile, chain) => {
    const calls = []
    walk(sourceFile, (node) => {
        if (ts.isCallExpression(node) && propertyChain(node.expression) === chain) calls.push(node)
    })
    return calls
}
const findFunction = (sourceFile, name) => {
    const matches = sourceFile.statements.filter((statement) => (
        ts.isFunctionDeclaration(statement) && statement.name?.text === name && hasModifier(statement, ts.SyntaxKind.ExportKeyword)
    ))
    return matches.length === 1 ? matches[0] : null
}
const exactObjectEnvelope = (sourceFile, call, fields) => {
    if (!call || call.arguments.length !== 1 || !ts.isObjectLiteralExpression(unwrap(call.arguments[0]))) return false
    const properties = unwrap(call.arguments[0]).properties
    if (properties.length !== Object.keys(fields).length || !properties.every((property) => (
        ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
    ))) return false
    const actual = Object.fromEntries(properties.map((property) => [
        property.name.getText(sourceFile),
        ts.isShorthandPropertyAssignment(property) ? property.name : unwrap(property.initializer),
    ]))
    return Object.entries(fields).every(([key, identifier]) => isIdentifier(actual[key], identifier))
}
const exactAiConsumerOperations = (source) => {
    const sourceFile = parse(consumerPath, source)
    if (sourceFile.parseDiagnostics.length) return null
    const createFunction = findFunction(sourceFile, 'createKnowledgeEntry')
    const updateFunction = findFunction(sourceFile, 'updateKnowledgeEntry')
    const deleteFunction = findFunction(sourceFile, 'deleteKnowledgeEntry')
    if (!createFunction?.body || !updateFunction?.body || !deleteFunction?.body) return null
    const functionState = (fn, operation) => ({
        auth: callsOf(fn.body, 'assertCanEditAi'),
        operation: callsOf(fn.body, operation),
        revalidate: callsOf(fn.body, 'revalidatePath'),
    })
    const createState = functionState(createFunction, 'createLegacyKnowledgeEntryV1')
    const updateState = functionState(updateFunction, 'updateLegacyKnowledgeEntryV1')
    const deleteState = functionState(deleteFunction, 'deleteLegacyKnowledgeEntryV1')
    if ([createState, updateState, deleteState].some((state) => (
        state.auth.length !== 1 || state.operation.length !== 1 || state.revalidate.length !== 1
        || !ts.isAwaitExpression(state.auth[0].parent) || !ts.isAwaitExpression(state.operation[0].parent)
        || state.revalidate[0].arguments.length !== 1 || !ts.isStringLiteralLike(state.revalidate[0].arguments[0])
        || state.revalidate[0].arguments[0].text !== '/settings/ai'
    ))) return null
    const idDeclarations = []
    walk(createFunction.body, (node) => {
        if (ts.isVariableDeclaration(node) && isIdentifier(node.name, 'id')) idDeclarations.push(node)
    })
    if (idDeclarations.length !== 1
        || idDeclarations[0].initializer?.getText(sourceFile).replace(/\s+/g, '') !== '`kb_${Date.now()}`') return null
    const catches = []
    for (const fn of [createFunction, updateFunction, deleteFunction]) {
        walk(fn.body, (node) => {
            if (ts.isCatchClause(node)) catches.push(node)
        })
    }
    const ordered = (state) => state.auth[0].getStart(sourceFile) < state.operation[0].getStart(sourceFile)
        && state.operation[0].getStart(sourceFile) < state.revalidate[0].getStart(sourceFile)
    return {
        createOrder: ordered(createState)
            && idDeclarations[0].getStart(sourceFile) > createState.auth[0].getStart(sourceFile)
            && idDeclarations[0].getStart(sourceFile) < createState.operation[0].getStart(sourceFile),
        updateOrder: ordered(updateState),
        deleteOrder: ordered(deleteState),
        createMapping: exactObjectEnvelope(sourceFile, createState.operation[0], {
            contract: 'CREATE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1',
            entryId: 'id',
            data: 'data',
        }),
        updateMapping: exactObjectEnvelope(sourceFile, updateState.operation[0], {
            contract: 'UPDATE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1',
            entryId: 'id',
            patch: 'data',
        }),
        deleteMapping: exactObjectEnvelope(sourceFile, deleteState.operation[0], {
            contract: 'DELETE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1',
            entryId: 'id',
        }),
        successOnlyRevalidation: catches.length === 0
            && [createState, updateState, deleteState].every(ordered),
    }
}
const identifiersOf = (sourceFile, name) => {
    let count = 0
    walk(sourceFile, (node) => {
        if (ts.isIdentifier(node) && node.text === name) count += 1
    })
    return count
}
const exportedOperationNames = (sourceFile) => {
    const names = []
    for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement) || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue
        for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && /LegacyKnowledgeEntryV1$/.test(declaration.name.text)) {
                names.push(declaration.name.text)
            }
        }
    }
    return names.sort()
}
const exactRuntimeConsumers = (sources, operations) => {
    const wanted = new Set(operations)
    const found = []
    const callFiles = new Map(operations.map((operation) => [operation, []]))
    let propertyBypasses = 0
    for (const [file, source] of sources) {
        if (!operations.some((operation) => source.includes(operation))) continue
        const sourceFile = parse(file, source)
        for (const binding of [...allNamedImports(sourceFile), ...dynamicNamedImports(sourceFile)]) {
            if (wanted.has(binding.imported)) found.push({ file, ...binding })
        }
        walk(sourceFile, (node) => {
            if (ts.isPropertyAccessExpression(node) && wanted.has(node.name.text)) propertyBypasses += 1
            if (ts.isCallExpression(node) && ts.isIdentifier(unwrap(node.expression))
                && wanted.has(unwrap(node.expression).text)) callFiles.get(unwrap(node.expression).text).push(file)
        })
    }
    return propertyBypasses === 0 && operations.every((operation) => {
        const records = found.filter((record) => record.imported === operation)
        return records.length === 1
            && records[0].file === consumerPath
            && records[0].module === publicModule
            && records[0].local === operation
            && callFiles.get(operation).length === 1
            && callFiles.get(operation)[0] === consumerPath
    })
}

const hasLegacyKnowledgeApplicationWiring = (sources) => {
    const publicSource = sources.get(publicIndexPath) ?? ''
    const applicationSource = sources.get(applicationPath) ?? ''
    const consumerSource = sources.get(consumerPath) ?? ''
    const publicSourceFile = parse(publicIndexPath, publicSource)
    const applicationSourceFile = parse(applicationPath, applicationSource)
    const consumerSourceFile = parse(consumerPath, consumerSource)
    if ([publicSourceFile, applicationSourceFile, consumerSourceFile].some((sourceFile) => sourceFile.parseDiagnostics.length > 0)) return false
    const publicOperations = staticNamedBindings(publicSourceFile, 'export', applicationModule)
    const handlerFactories = staticNamedBindings(
        applicationSourceFile,
        'import',
        '../public/v1/legacy-knowledge-entry-handler',
    )
    const adapterBindings = staticNamedBindings(applicationSourceFile, 'import', adapterModule)
    const expectedPublicNames = legacyOperations.map(([, publicName]) => publicName).sort()
    const targetReexports = publicOperations
        .filter((binding) => /LegacyKnowledgeEntryV1$/.test(binding.local))
        .map((binding) => binding.local)
        .sort()
    const factoryCalls = legacyOperations.map(([local, , factory]) => exactFactoryBinding(
        applicationSourceFile,
        local,
        factory,
    ))
    const wrapperCalls = legacyOperations.map(([local, publicName]) => exactForwardingWrapper(
        applicationSourceFile,
        publicName,
        local,
    ))
    const adapterCalls = []
    walk(applicationSourceFile, (node) => {
        if (ts.isCallExpression(node) && node.arguments.some((argument) => isIdentifier(argument, adapterName))) {
            adapterCalls.push(node)
        }
    })
    const publicModules = []
    for (const statement of publicSourceFile.statements) {
        if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
            && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
            publicModules.push(statement.moduleSpecifier.text)
        }
    }

    return JSON.stringify(targetReexports) === JSON.stringify(expectedPublicNames)
        && legacyOperations.every(([, publicName]) => publicOperations.filter((binding) => (
            binding.imported === publicName && binding.local === publicName
        )).length === 1)
        && legacyOperations.every(([, , factory]) => handlerFactories.filter((binding) => (
            binding.imported === factory && binding.local === factory
        )).length === 1)
        && adapterBindings.length === 1
        && adapterBindings[0].imported === adapterName
        && adapterBindings[0].local === adapterName
        && factoryCalls.every(Boolean)
        && wrapperCalls.every(Boolean)
        && adapterCalls.length === legacyOperations.length
        && factoryCalls.every((call) => adapterCalls.includes(call))
        && legacyOperations.every(([local]) => callsOf(applicationSourceFile, local).length === 1)
        && identifiersOf(applicationSourceFile, adapterName) === legacyOperations.length + 1
        && JSON.stringify(exportedOperationNames(applicationSourceFile)) === JSON.stringify(expectedPublicNames)
        && !publicModules.some((specifier) => specifier.includes('legacy-prisma-legacy-knowledge-entry-adapter'))
        && exactRuntimeConsumers(sources, expectedPublicNames)
        && expectedPublicNames.every((name) => callsOf(consumerSourceFile, name).length === 1)
}

const withSource = (sources, file, source) => new Map([...sources, [file, source]])
const currentWiringIsValid = hasLegacyKnowledgeApplicationWiring(repositorySources)
const currentConsumerOperations = exactAiConsumerOperations(consumer)
const adapterSourceFile = parse(
    'gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-prisma-legacy-knowledge-entry-adapter.ts',
    adapter,
)
const adapterCreateCalls = callsByChain(adapterSourceFile, 'prisma.knowledgeBaseEntry.create')
const adapterUpdateCalls = callsByChain(adapterSourceFile, 'prisma.knowledgeBaseEntry.updateMany')
const adapterDeleteCalls = callsByChain(adapterSourceFile, 'prisma.knowledgeBaseEntry.deleteMany')
const deletedWrapper = 'export const deleteLegacyKnowledgeEntryV1 = (...args: Parameters<typeof deleteLegacyKnowledgeEntry>) => deleteLegacyKnowledgeEntry(...args)'
const failClosedWiringProbes = [
    withSource(repositorySources, applicationPath, application.replace(deletedWrapper, `// ${deletedWrapper}`)),
    withSource(repositorySources, applicationPath, `${application}\nconst archiveLegacyKnowledgeEntry = createCreateLegacyKnowledgeEntryHandlerV1(${adapterName})\nexport const archiveLegacyKnowledgeEntryV1 = (...args: Parameters<typeof archiveLegacyKnowledgeEntry>) => archiveLegacyKnowledgeEntry(...args)\n`),
    withSource(repositorySources, applicationPath, application.replace(
        'createUpdateLegacyKnowledgeEntryHandlerV1(legacyPrismaLegacyKnowledgeEntryPortV1)',
        'createUpdateLegacyKnowledgeEntryHandlerV1({} as never)',
    )),
    withSource(repositorySources, consumerPath, consumer.replace(publicModule, '@/modules/ai-knowledge/application/knowledge-operations')),
    new Map([...repositorySources, [
        'gravity-mvp/src/app/legacy-knowledge-entry-probe.ts',
        `import { createLegacyKnowledgeEntryV1 } from '${publicModule}'\nvoid createLegacyKnowledgeEntryV1\n`,
    ]]),
]

check('contract is storage and credential neutral', !forbiddenPublicSurface.test(contract), 'public contract leaks implementation or credential vocabulary')
check('handler is storage and credential neutral', !forbiddenPublicSurface.test(handler), 'public handler leaks implementation or credential vocabulary')
check('contract barrel exports commands', contractIndex.includes("export * from './legacy-knowledge-entry-commands'"), 'contract export absent')
check(
    'public barrel wires all three handlers',
    currentWiringIsValid,
    'public re-export, application handler/adapter composition, or narrow operation wrapper is absent',
)
check(
    'application wiring detector is fail-closed',
    currentWiringIsValid
        && failClosedWiringProbes.length === 5
        && failClosedWiringProbes.every((probe) => !hasLegacyKnowledgeApplicationWiring(probe)),
    'AST wiring detector accepted comment spoofing, an extra operation, an adapter bypass, or an extra consumer',
)
check(
    'three writes are isolated in owner adapter',
    adapterCreateCalls.length === 1
        && adapterUpdateCalls.length === 1
        && adapterDeleteCalls.length === 1
        && !adapter.includes('$executeRaw')
        && !adapter.includes('Prisma.raw')
        && !adapter.includes('Prisma.sql')
        && !create.includes('INSERT INTO "KnowledgeBaseEntry"')
        && !update.includes('UPDATE "KnowledgeBaseEntry"')
        && !del.includes('DELETE FROM "KnowledgeBaseEntry"'),
    'foreign write remains or owner write absent',
)
check(
    'legacy read remains caller-owned and unchanged',
    consumer.includes('SELECT * FROM "KnowledgeBaseEntry" ORDER BY "priority" DESC, "createdAt" ASC'),
    'read drift',
)
check(
    'create authorization and caller id precede command',
    currentConsumerOperations?.createOrder === true,
    'create ordering drift',
)
check(
    'create command mapping is exact',
    currentConsumerOperations?.createMapping === true,
    'create mapping drift',
)
check(
    'create caller response construction is retained',
    create.includes('return { id, ...data, active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }'),
    'create response drift',
)
check(
    'create field identity, active flag and single timestamp are retained',
    adapter.includes('sampleQuestions: data.sampleQuestions')
        && adapter.includes('tags: data.tags')
        && adapter.includes('channels: data.channels')
        && adapter.includes('active: true')
        && adapter.includes('priority: data.priority')
        && adapter.includes('createdAt: now')
        && adapter.includes('updatedAt: now'),
    'create persistence drift',
)
check(
    'update authorization and empty-patch no-op precede command',
    currentConsumerOperations?.updateOrder === true
        && update.indexOf('await assertCanEditAi()') < update.indexOf('const fields = Object.keys(data)')
        && update.indexOf('if (fields.length === 0) return') < update.indexOf('await updateLegacyKnowledgeEntryV1'),
    'update guard/no-op drift',
)
check(
    'update strict patch mapping and idempotent row targeting are retained',
    currentConsumerOperations?.updateMapping === true
        && adapter.includes('if (Object.keys(patch).length === 0) return')
        && adapter.includes('where: { id: entryId }')
        && adapter.includes('data: { ...patch, lastReviewedAt: now, updatedAt: now }'),
    'update mapping/target drift',
)
check(
    'update review and modification timestamps are retained',
    adapter.includes('const now = new Date()')
        && adapter.includes('lastReviewedAt: now')
        && adapter.includes('updatedAt: now'),
    'update timestamp drift',
)
check(
    'delete authorization and exact mapping are retained',
    currentConsumerOperations?.deleteOrder === true
        && currentConsumerOperations?.deleteMapping === true,
    'delete drift',
)
check(
    'all revalidation remains success-only',
    currentConsumerOperations?.successOnlyRevalidation === true,
    'failure visibility or revalidation drift',
)
check(
    'AI Knowledge manifest declares exactly the three owner commands',
    amendment.amendments?.length === 1
        && amendment.amendments[0].context === 'ai_knowledge'
        && JSON.stringify(amendment.amendments[0].add_commands) === JSON.stringify([
            'CreateLegacyKnowledgeEntryCommand.v1',
            'UpdateLegacyKnowledgeEntryCommand.v1',
            'DeleteLegacyKnowledgeEntryCommand.v1',
        ]),
    'manifest command amendment drift',
)
check(
    'accepted AI evidence stays bound to the parser parent',
    policy.manifest_amendments.includes(amendmentPath)
        && migration.base_commit === '653a802149a3526bd3ec99d24f71f00a88be81ef'
        && migration.enforcement?.before === 1433
        && migration.enforcement?.after === 1430
        && migration.enforcement?.direct_before === 103
        && migration.enforcement?.direct_after === 100,
    'accepted AI evidence identity drift',
)
check(
    'exact three findings remain retired with no replacement capacity',
    (registry.summary?.direct_foreign_prisma_write ?? 0) <= 100
        && registry.exceptions.length <= 1430
        && [
            'arch_4e0297ee9451d50de1fed034',
            'arch_1ad0c6177270bb0f0879e098',
            'arch_557d64553906286e94fdd4cc',
        ].every((fingerprint) => !registry.exceptions.some((entry) => entry.fingerprint === fingerprint)),
    'strict exception retirement drift',
)

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
