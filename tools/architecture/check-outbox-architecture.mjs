#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

const root = process.cwd()
const failures = []
const checks = []
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const assertCheck = (name, condition, detail) => {
    if (condition) checks.push(name)
    else failures.push({ check: name, detail })
}
const assertStructuredCheck = (name, validator) => {
    try {
        validator()
        checks.push(name)
    } catch (error) {
        failures.push({
            check: name,
            detail: error instanceof Error ? error.message : String(error),
        })
    }
}

const sourceExtensions = /\.(?:[cm]?[jt]sx?)$/
const walkSourceFiles = (relativeDirectory) => {
    const absoluteDirectory = path.join(root, relativeDirectory)
    return fs.readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
        const relative = path.posix.join(relativeDirectory, entry.name)
        if (entry.isDirectory()) return walkSourceFiles(relative)
        return sourceExtensions.test(entry.name) ? [relative] : []
    })
}
const parse = (relative, source = read(relative)) => {
    const sourceFile = ts.createSourceFile(
        relative,
        source,
        ts.ScriptTarget.Latest,
        true,
        relative.endsWith('.tsx') || relative.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    assert.equal(sourceFile.parseDiagnostics.length, 0, `${relative}: TypeScript parse diagnostics`)
    return sourceFile
}
const visit = (node, callback) => {
    callback(node)
    ts.forEachChild(node, (child) => visit(child, callback))
}
const moduleText = (node) => (
    node && ts.isStringLiteralLike(node) ? node.text : null
)
const modifiersContain = (node, kind) => Boolean(node.modifiers?.some((modifier) => modifier.kind === kind))
const unwrap = (node) => {
    let current = node
    while (current && ts.isParenthesizedExpression(current)) current = current.expression
    return current
}
const propertyPath = (expression) => {
    const node = unwrap(expression)
    if (ts.isIdentifier(node)) return node.text
    if (ts.isPropertyAccessExpression(node)) {
        const owner = propertyPath(node.expression)
        return owner ? `${owner}.${node.name.text}` : null
    }
    return null
}
const callExpressions = (sourceFile) => {
    const calls = []
    visit(sourceFile, (node) => {
        if (ts.isCallExpression(node)) calls.push(node)
    })
    return calls
}
const callsNamed = (sourceFile, name) => callExpressions(sourceFile).filter((call) => (
    ts.isIdentifier(unwrap(call.expression)) && unwrap(call.expression).text === name
))
const callsPath = (sourceFile, expectedPath) => callExpressions(sourceFile).filter((call) => (
    propertyPath(call.expression) === expectedPath
))
const literalFalse = (expression) => expression.kind === ts.SyntaxKind.FalseKeyword
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
const assertImportedDirectCalls = (sourceFile, name, { count, awaited = false, owner = null }) => {
    const directCalls = []
    visit(sourceFile, (node) => {
        if (!ts.isIdentifier(node) || node.text !== name) return
        if (ts.isImportSpecifier(node.parent) && node.parent.name === node) return
        const call = directCallForIdentifier(node)
        assert(call, `${sourceFile.fileName}: ${name} must not be shadowed, copied, or referenced indirectly`)
        assert.equal(syntacticallyDead(call), false, `${sourceFile.fileName}: ${name} call is syntactically dead`)
        directCalls.push(call)
    })
    assert.equal(directCalls.length, count, `${sourceFile.fileName}: ${name} executable direct-call count`)
    if (awaited) assert(directCalls.every((call) => ts.isAwaitExpression(call.parent)), `${sourceFile.fileName}: ${name} calls must be awaited`)
    if (owner) assert(directCalls.every((call) => enclosingFunctionName(call) === owner), `${sourceFile.fileName}: ${name} calls must stay in ${owner}`)
    return directCalls
}
const namedModuleBindings = (relative, source = read(relative)) => {
    const bindings = []
    const sourceFile = parse(relative, source)
    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement)) {
            const specifier = moduleText(statement.moduleSpecifier)
            const clause = statement.importClause
            if (!specifier || !clause) continue
            if (clause.name) {
                bindings.push({
                    kind: 'default-import',
                    specifier,
                    imported: 'default',
                    local: clause.name.text,
                    typeOnly: Boolean(clause.isTypeOnly),
                })
            }
            if (!clause.namedBindings) continue
            if (ts.isNamespaceImport(clause.namedBindings)) {
                bindings.push({
                    kind: 'namespace-import',
                    specifier,
                    imported: '*',
                    local: clause.namedBindings.name.text,
                    typeOnly: Boolean(clause.isTypeOnly),
                })
                continue
            }
            for (const element of clause.namedBindings.elements) {
                bindings.push({
                    kind: 'import',
                    specifier,
                    imported: (element.propertyName ?? element.name).text,
                    local: element.name.text,
                    typeOnly: Boolean(clause.isTypeOnly || element.isTypeOnly),
                })
            }
        }
        if (ts.isExportDeclaration(statement)) {
            const specifier = moduleText(statement.moduleSpecifier)
            if (!specifier) continue
            if (!statement.exportClause) {
                bindings.push({ kind: 'export-star', specifier, imported: '*', local: '*', typeOnly: Boolean(statement.isTypeOnly) })
                continue
            }
            if (ts.isNamespaceExport(statement.exportClause)) {
                bindings.push({
                    kind: 'namespace-export',
                    specifier,
                    imported: '*',
                    local: statement.exportClause.name.text,
                    typeOnly: Boolean(statement.isTypeOnly),
                })
                continue
            }
            if (!ts.isNamedExports(statement.exportClause)) continue
            for (const element of statement.exportClause.elements) {
                bindings.push({
                    kind: 'export',
                    specifier,
                    imported: (element.propertyName ?? element.name).text,
                    local: element.name.text,
                    typeOnly: Boolean(statement.isTypeOnly || element.isTypeOnly),
                })
            }
        }
    }
    visit(sourceFile, (node) => {
        if (!ts.isCallExpression(node) || node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) return
        const kind = node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? 'dynamic-import'
            : (ts.isIdentifier(node.expression) && node.expression.text === 'require' ? 'require' : null)
        if (kind) {
            const parent = node.parent
            if (kind === 'dynamic-import'
                && ts.isAwaitExpression(parent)
                && ts.isVariableDeclaration(parent.parent)
                && parent.parent.initializer === parent
                && ts.isObjectBindingPattern(parent.parent.name)) {
                for (const element of parent.parent.name.elements) {
                    if (!ts.isIdentifier(element.name)) continue
                    bindings.push({
                        kind,
                        specifier: node.arguments[0].text,
                        imported: element.propertyName?.getText(sourceFile) ?? element.name.text,
                        local: element.name.text,
                        typeOnly: false,
                    })
                }
            } else {
                bindings.push({ kind, specifier: node.arguments[0].text, imported: '*', local: '*', typeOnly: false })
            }
        }
    })
    return bindings
}
const exactBinding = (relative, source, expected) => {
    const matches = namedModuleBindings(relative, source).filter((binding) => (
        binding.imported === expected.imported
    ))
    assert.deepEqual(matches, [expected])
}
const exportedConst = (sourceFile, name) => sourceFile.statements.flatMap((statement) => {
    if (!ts.isVariableStatement(statement)
        || !modifiersContain(statement, ts.SyntaxKind.ExportKeyword)
        || !(statement.declarationList.flags & ts.NodeFlags.Const)) return []
    return statement.declarationList.declarations.filter((declaration) => (
        ts.isIdentifier(declaration.name) && declaration.name.text === name
    ))
})
const objectProperty = (object, name) => object.properties.find((property) => (
    ts.isPropertyAssignment(property)
    && ((ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) && property.name.text === name)
))

const persistCapability = 'persistRecordingReadyV1'
const recordingApplicationPath = 'gravity-mvp/src/modules/calling/application/recording-ready.ts'
const recordingPublicIndexPath = 'gravity-mvp/src/modules/calling/public/v1/index.ts'
const recordingPublicAggregatorPath = 'gravity-mvp/src/modules/calling/public/index.ts'
const recordingModuleIndexPath = 'gravity-mvp/src/modules/calling/index.ts'
const recordingProcessorPath = 'gravity-mvp/src/lib/freeswitch/recordingProcessor.ts'
const internalAdapterSpecifier = '../internal/recording-ready-prisma-adapter'
const applicationSpecifier = '../../application/recording-ready'
const publicSpecifier = '@/modules/calling/public/v1'

function validateRecordingApplication(source) {
    exactBinding(recordingApplicationPath, source, {
        kind: 'import',
        specifier: internalAdapterSpecifier,
        imported: persistCapability,
        local: 'persistRecordingReadyWithPrismaV1',
        typeOnly: false,
    })
    const sourceFile = parse(recordingApplicationPath, source)
    const declarations = exportedConst(sourceFile, persistCapability)
    assert.equal(declarations.length, 1, 'application must export exactly one composed persistence capability')
    const declaration = declarations[0]
    assert(ts.isTypeReferenceNode(declaration.type) && declaration.type.typeName.getText(sourceFile) === 'PersistRecordingReadyV1')
    const initializer = unwrap(declaration.initializer)
    assert(initializer && ts.isArrowFunction(initializer), 'composition binding must be an arrow-function wrapper')
    assert.equal(initializer.parameters.length, 1)
    assert(ts.isIdentifier(initializer.parameters[0].name) && initializer.parameters[0].name.text === 'input')
    const body = unwrap(initializer.body)
    assert(ts.isCallExpression(body), 'composition wrapper must directly return the internal adapter call')
    assert(ts.isIdentifier(body.expression) && body.expression.text === 'persistRecordingReadyWithPrismaV1')
    assert.equal(body.arguments.length, 1)
    assert(ts.isIdentifier(body.arguments[0]) && body.arguments[0].text === 'input')
    assertImportedDirectCalls(sourceFile, 'persistRecordingReadyWithPrismaV1', { count: 1 })
}

function validateRecordingPublicIndex(source) {
    exactBinding(recordingPublicIndexPath, source, {
        kind: 'export',
        specifier: applicationSpecifier,
        imported: persistCapability,
        local: persistCapability,
        typeOnly: false,
    })
}

function validateRecordingProcessor(source) {
    exactBinding(recordingProcessorPath, source, {
        kind: 'import',
        specifier: publicSpecifier,
        imported: persistCapability,
        local: persistCapability,
        typeOnly: false,
    })
    const sourceFile = parse(recordingProcessorPath, source)
    assertImportedDirectCalls(sourceFile, persistCapability, { count: 1, awaited: true, owner: 'processRecording' })
    assert.equal(callsNamed(sourceFile, 'enqueueTranscribe').length, 0, 'lossy direct enqueue remains executable')
}

const withoutModuleSuffix = (value) => value.replace(/\.(?:[cm]?[jt]sx?)$/, '').replace(/\/index$/, '')
const resolveModule = (relative, specifier) => {
    if (specifier.startsWith('@/')) return withoutModuleSuffix(`gravity-mvp/src/${specifier.slice(2)}`)
    if (specifier.startsWith('.')) return withoutModuleSuffix(path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier)))
    return specifier
}
const governedRecordingModule = (relative, specifier) => {
    const resolved = resolveModule(relative, specifier)
    const publicDirectory = withoutModuleSuffix(path.posix.dirname(recordingPublicIndexPath))
    return resolved === publicDirectory
        || resolved === withoutModuleSuffix(path.posix.dirname(recordingPublicAggregatorPath))
        || resolved.startsWith(`${publicDirectory}/recording-ready`)
        || resolved === withoutModuleSuffix(recordingApplicationPath)
        || resolved === withoutModuleSuffix('gravity-mvp/src/modules/calling/internal/recording-ready-prisma-adapter.ts')
}
const wildcardBindingKinds = new Set(['namespace-import', 'namespace-export', 'export-star', 'dynamic-import', 'require', 'default-import'])
function discoverPersistBindings(entries) {
    return entries.flatMap(({ relative, source }) => namedModuleBindings(relative, source)
        .filter((binding) => binding.imported === persistCapability
            || (binding.imported === '*' && wildcardBindingKinds.has(binding.kind) && governedRecordingModule(relative, binding.specifier)))
        .map((binding) => ({ relative, ...binding })))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

const sourceEntries = walkSourceFiles('gravity-mvp/src')
    .filter((relative) => !/(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative))
    .map((relative) => ({ relative, source: read(relative) }))
const expectedPersistBindings = [
    {
        relative: recordingModuleIndexPath,
        kind: 'namespace-export',
        specifier: './public',
        imported: '*',
        local: 'CallingPublic',
        typeOnly: false,
    },
    {
        relative: recordingApplicationPath,
        kind: 'import',
        specifier: internalAdapterSpecifier,
        imported: persistCapability,
        local: 'persistRecordingReadyWithPrismaV1',
        typeOnly: false,
    },
    {
        relative: recordingProcessorPath,
        kind: 'import',
        specifier: publicSpecifier,
        imported: persistCapability,
        local: persistCapability,
        typeOnly: false,
    },
    {
        relative: recordingPublicAggregatorPath,
        kind: 'export-star',
        specifier: './v1',
        imported: '*',
        local: '*',
        typeOnly: false,
    },
    {
        relative: recordingPublicIndexPath,
        kind: 'export',
        specifier: applicationSpecifier,
        imported: persistCapability,
        local: persistCapability,
        typeOnly: false,
    },
].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
const assertPersistDenominator = (entries = sourceEntries) => assert.deepEqual(
    discoverPersistBindings(entries),
    expectedPersistBindings,
    'repository-wide production persistence-capability import/export denominator changed',
)

const migrationPath = 'gravity-mvp/prisma/migrations/20260809140000_add_domain_outbox/migration.sql'
const migration = read(migrationPath)
const schema = read('gravity-mvp/prisma/schema.prisma')
const eventContract = read('gravity-mvp/src/contracts/calling/v1/recording-ready-event.ts')
const finalizationEventContract = read('gravity-mvp/src/contracts/calling/v1/ai-call-finalization-follow-up-requested-event.ts')
const recordingOperation = read('gravity-mvp/src/modules/calling/public/v1/recording-ready-operation.ts')
const recordingPublicIndex = read('gravity-mvp/src/modules/calling/public/v1/index.ts')
const recordingComposition = read('gravity-mvp/src/modules/calling/application/recording-ready.ts')
const atomicAdapter = read('gravity-mvp/src/modules/calling/internal/recording-ready-prisma-adapter.ts')
const finalizationAdapter = read('gravity-mvp/src/modules/calling/internal/ai-calls/ai-call-finalization-prisma-adapter.ts')
const recordingProcessor = read('gravity-mvp/src/lib/freeswitch/recordingProcessor.ts')
const publisher = read('gravity-mvp/src/infrastructure/outbox/v1/outbox-publisher.ts')
const store = read('gravity-mvp/src/infrastructure/outbox/prisma-outbox-store.ts')
const consumer = read('gravity-mvp/src/modules/calling/public/v1/outbox-consumers.ts')
const queues = read('gravity-mvp/src/lib/queue/queues.ts')
const instrumentation = read('gravity-mvp/src/instrumentation.ts')
const composition = read('gravity-mvp/src/modules/platform-shell/public/v1/outbox-runtime.ts')
const manifestAmendments = JSON.parse(read('architecture/events/v1/module-manifest-amendments.json'))
const finalizationManifestAmendments = JSON.parse(read(
    'architecture/isolation/calling/ai-call-single-call-v1/module-manifest-amendments.json',
))
const finalizationRecoveryManifest = JSON.parse(read(
    'architecture/isolation/calling/ai-call-single-call-v1/recovery-manifest.json',
))
const concurrentOutboxTest = read('gravity-mvp/src/infrastructure/outbox/prisma-outbox-store.test.ts')
const architecturePolicy = JSON.parse(read('architecture/enforcement/v1/policy.json'))

assertCheck(
    'migration is expand-only',
    !/\b(?:DROP|TRUNCATE|DELETE|RENAME)\b/i.test(migration)
        && !/\bALTER\s+(?:TABLE|TYPE)\b/i.test(migration),
    'destructive or contract-phase SQL found',
)
assertCheck(
    'migration creates typed outbox and unique event identity',
    migration.includes('CREATE TYPE "DomainOutboxStatus"')
        && migration.includes('CREATE TABLE "domain_outbox_events"')
        && migration.includes('CREATE UNIQUE INDEX "domain_outbox_events_eventId_key"'),
    'required type, table, or unique event index missing',
)
assertCheck(
    'schema exposes bounded retry and poison state',
    schema.includes('model DomainOutboxEvent')
        && schema.includes('maxAttempts')
        && schema.includes('dead_letter')
        && schema.includes('lastError      String?            @db.VarChar(1000)'),
    'retry/dead-letter/last-error schema is incomplete',
)
assertCheck(
    'event contract is versioned and provider neutral',
    eventContract.includes("calling.RecordingReady.v1")
        && !/@\/lib\/|@prisma|bullmq|redis|freeswitch/i.test(eventContract),
    'event contract is unversioned or provider-bound',
)
assertCheck(
    'AI-call finalization recovery event is versioned, deterministic and provider neutral',
    finalizationEventContract.includes("calling.AiCallFinalizationFollowUpRequested.v1")
        && finalizationEventContract.includes('finalizationFingerprint')
        && finalizationEventContract.includes('eventId !==')
        && !/@\/lib\/|@prisma|bullmq|redis|freeswitch/i.test(finalizationEventContract),
    'AI-call finalization recovery event contract is incomplete or provider-bound',
)
assertCheck(
    'domain state and outbox append share one transaction',
    atomicAdapter.includes('$transaction')
        && atomicAdapter.includes('transaction.call.update')
        && atomicAdapter.includes('transaction.domainOutboxEvent.createMany')
        && atomicAdapter.includes('skipDuplicates: true'),
    'atomic transaction or idempotent append is missing',
)
assertCheck(
    'AI-call terminal state and recovery wake-up share one transaction',
    finalizationAdapter.includes('$transaction')
        && finalizationAdapter.includes('tx.call.update')
        && finalizationAdapter.includes('tx.domainOutboxEvent.create')
        && !finalizationAdapter.includes('tx.domainOutboxEvent.createMany')
        && finalizationAdapter.indexOf('tx.call.update') < finalizationAdapter.indexOf('tx.domainOutboxEvent.create'),
    'AI-call finalization can commit without its durable recovery wake-up',
)
assertCheck(
    'outbox selection has a supporting composite index',
    schema.includes('@@index([status, availableAt, createdAt])'),
    'outbox due-work selection index is missing',
)
assertCheck(
    'AI-call recovery contains no metadata scan or standalone polling loop',
    !/findRecoverableFollowUps|countTerminalFollowUpFailures|metadata"->|startAiCallFinalizationRecovery/.test(finalizationAdapter)
        && !read('gravity-mvp/src/modules/calling/application/ai-call-finalization-runtime.ts')
            .includes('AI_CALL_FINALIZATION_RECOVERY_POLL_MS'),
    'unindexed Call metadata recovery scan or polling loop remains',
)
assertCheck(
    'recording operation exposes business input without write-capability injection',
    recordingOperation.includes('PersistRecordingReadyInputV1')
        && recordingOperation.includes('PersistRecordingReadyV1')
        && !/(?:RecordingReadyTransactionV1|RecordingReadyUnitOfWorkV1|createPersistRecordingReadyV1|PrismaClient)/.test(recordingOperation),
    'public operation exposes an implementation or injectable write capability',
)
assertStructuredCheck(
    'recording operation is bound only at the owner application composition root',
    () => {
        validateRecordingApplication(recordingComposition)
        validateRecordingPublicIndex(recordingPublicIndex)
        validateRecordingProcessor(recordingProcessor)
        assertPersistDenominator()
    },
)
assertStructuredCheck(
    'recording flow no longer performs a lossy direct enqueue',
    () => validateRecordingProcessor(recordingProcessor),
)

assertStructuredCheck('recording boundary rejects comment dead-code shadow alias namespace deep-import no-op and denominator spoofs', () => {
    const commentedImportProbe = recordingProcessor.replace(
        "import { persistRecordingReadyV1 } from '@/modules/calling/public/v1'",
        "// import { persistRecordingReadyV1 } from '@/modules/calling/public/v1'",
    )
    assert.notEqual(commentedImportProbe, recordingProcessor)
    assert.throws(() => validateRecordingProcessor(commentedImportProbe), undefined, 'commented import probe must fail')

    const commentedCallProbe = recordingProcessor.replace(
        'const outboxEvent = await persistRecordingReadyV1({',
        'const outboxEvent = await disabledPersistRecordingReadyV1({ // persistRecordingReadyV1({',
    )
    assert.notEqual(commentedCallProbe, recordingProcessor)
    assert.throws(() => validateRecordingProcessor(commentedCallProbe), undefined, 'commented call probe must fail')

    const removedCallProbe = recordingProcessor.replace(
        'const outboxEvent = await persistRecordingReadyV1({',
        'const outboxEvent = await disabledPersistRecordingReadyV1({',
    )
    const deadCallProbe = removedCallProbe.replace(
        'export async function processRecording(args:',
        'export async function processRecording(args:',
    ).replace(
        '    // Per-stage logging is the explicit fix',
        '    if (false) { await persistRecordingReadyV1({} as never) }\n    // Per-stage logging is the explicit fix',
    )
    assert.notEqual(deadCallProbe, recordingProcessor)
    assert.throws(() => validateRecordingProcessor(deadCallProbe), undefined, 'syntactically dead call probe must fail')

    const shadowCallProbe = removedCallProbe.replace(
        '    // Per-stage logging is the explicit fix',
        '    const shadowProbe = async (persistRecordingReadyV1: (input: never) => Promise<unknown>) => { await persistRecordingReadyV1({} as never) }\n    void shadowProbe\n    // Per-stage logging is the explicit fix',
    )
    assert.notEqual(shadowCallProbe, recordingProcessor)
    assert.throws(() => validateRecordingProcessor(shadowCallProbe), undefined, 'shadowed call probe must fail')

    const aliasProbe = recordingProcessor
        .replace(`import { ${persistCapability} } from '${publicSpecifier}'`, `import { ${persistCapability} as persistRecording } from '${publicSpecifier}'`)
        .replace('await persistRecordingReadyV1({', 'await persistRecording({')
    assert.notEqual(aliasProbe, recordingProcessor)
    assert.throws(() => validateRecordingProcessor(aliasProbe), undefined, 'alias probe must fail')

    const namespaceProbe = recordingProcessor
        .replace(`import { ${persistCapability} } from '${publicSpecifier}'`, `import * as callingPublic from '${publicSpecifier}'`)
        .replace('await persistRecordingReadyV1({', 'await callingPublic.persistRecordingReadyV1({')
    assert.notEqual(namespaceProbe, recordingProcessor)
    assert.throws(() => validateRecordingProcessor(namespaceProbe), undefined, 'namespace probe must fail')
    const namespaceEntries = sourceEntries.map((entry) => entry.relative === recordingProcessorPath
        ? { ...entry, source: namespaceProbe }
        : entry)
    assert.throws(() => assertPersistDenominator(namespaceEntries), undefined, 'namespace denominator probe must fail')

    const deepImportProbe = recordingProcessor.replace(
        `import { ${persistCapability} } from '${publicSpecifier}'`,
        `import { ${persistCapability} } from '@/modules/calling/internal/recording-ready-prisma-adapter'`,
    )
    assert.notEqual(deepImportProbe, recordingProcessor)
    assert.throws(() => validateRecordingProcessor(deepImportProbe), undefined, 'deep import probe must fail')

    const commentedCompositionProbe = recordingComposition.replace(
        'persistRecordingReadyWithPrismaV1(input)',
        'disabledPersistRecordingReadyWithPrismaV1(input) // persistRecordingReadyWithPrismaV1(input)',
    )
    assert.notEqual(commentedCompositionProbe, recordingComposition)
    assert.throws(() => validateRecordingApplication(commentedCompositionProbe), undefined, 'commented composition probe must fail')

    const noOpCompositionProbe = recordingComposition.replace(
        'persistRecordingReadyWithPrismaV1(input)',
        'Promise.resolve({ eventId: input.callId } as never)',
    )
    assert.notEqual(noOpCompositionProbe, recordingComposition)
    assert.throws(() => validateRecordingApplication(noOpCompositionProbe), undefined, 'no-op composition probe must fail')

    const extraConsumerPath = 'gravity-mvp/src/__architecture_probe__/extra-recording-consumer.ts'
    const extraConsumerSource = `import { ${persistCapability} as persist } from '${publicSpecifier}'\nvoid persist\n`
    assert.throws(() => assertPersistDenominator([
        ...sourceEntries,
        { relative: extraConsumerPath, source: extraConsumerSource },
    ]), undefined, 'extra consumer probe must fail')

    const reducedEntries = sourceEntries.map((entry) => entry.relative === recordingPublicIndexPath
        ? { ...entry, source: entry.source.replace(`export { ${persistCapability} } from '${applicationSpecifier}'`, '') }
        : entry)
    assert.throws(() => assertPersistDenominator(reducedEntries), undefined, 'denominator-loss probe must fail')
})
assertCheck(
    'publisher has bounded batch, retry and dead-letter behavior',
    publisher.includes('OUTBOX_BATCH_LIMIT_V1 = 25')
        && publisher.includes('OUTBOX_PUBLISH_TIMEOUT_MS_V1 = 5_000')
        && publisher.includes("status: terminal ? 'dead_letter' : 'retry_wait'")
        && publisher.includes('normalizeOutboxErrorV1'),
    'publisher reliability bounds are incomplete',
)
assertCheck(
    'store uses compare-and-set claim and stale recovery',
    store.includes("status: 'processing'")
        && store.includes('attempts: candidate.attempts')
        && store.includes('STALE_CLAIM_RECOVERED'),
    'claim ownership or stale recovery is absent',
)
assertCheck(
    'exhausted stale claims become visible dead letters',
    store.includes('STALE_CLAIM_RETRY_BUDGET_EXHAUSTED')
        && store.includes('RETRY_BUDGET_EXHAUSTED'),
    'exhausted claims can remain stuck outside the publisher',
)
assertCheck(
    'consumer validates the event before delivery',
    consumer.includes('parseRecordingReadyEventV1(payload)')
        && consumer.includes('enqueueTranscribe(event.data.callId)')
        && consumer.includes('parseAiCallFinalizationFollowUpRequestedEventV1(payload)')
        && consumer.includes('recoverAiCallFinalizationFollowUpByIdentity('),
    'consumer skips contract validation or delivery adapter',
)
assertCheck(
    'consumer redelivery is idempotent',
    queues.includes('{ jobId: `transcribe-${callId}` }'),
    'stable BullMQ job id missing',
)
assertCheck(
    'publisher is registered at the application composition root',
    instrumentation.includes('startDomainOutboxPublisherV1')
        && instrumentation.includes('registerOperationalIntervalV1(outboxInterval)')
        && composition.includes('callingOutboxPublishersV1')
        && composition.includes('prismaOutboxStoreV1'),
    'runtime publisher registration missing',
)
assertCheck(
    'event envelope includes correlation and causation',
    eventContract.includes('correlationId') && eventContract.includes('causationId'),
    'correlation or causation field missing',
)
assertCheck(
    'new event and infrastructure state are declared in module manifests',
    manifestAmendments.amendments.some((item) =>
        item.context === 'calling' && item.add_events.includes('calling.RecordingReady.v1'))
        && manifestAmendments.amendments.some((item) =>
            item.context === 'platform_shell'
            && item.add_owned_infrastructure_state.includes('gravity-mvp/prisma/schema.prisma:DomainOutboxEvent'))
        && finalizationManifestAmendments.amendments.some((item) =>
            item.context === 'calling'
            && item.add_events.includes('calling.AiCallFinalizationFollowUpRequested.v1')),
    'Calling event or Platform Shell infrastructure ownership is undeclared',
)
assertCheck(
    'AI-call recovery manifest binds indexed bounded discovery and poison visibility',
    finalizationRecoveryManifest.full_call_scan === false
        && finalizationRecoveryManifest.application_side_call_filter === false
        && finalizationRecoveryManifest.batch_limit === 25
        && finalizationRecoveryManifest.poison_state === 'dead_letter'
        && JSON.stringify(finalizationRecoveryManifest.query_index) === JSON.stringify(['status', 'availableAt', 'createdAt']),
    'AI-call recovery authority permits an unbounded scan or lacks reliability bounds',
)
assertCheck(
    'AI-call outbox append is a declared exact shared-infrastructure writer',
    architecturePolicy.approved_infrastructure_writers.some((writer) => (
        writer.model === 'DomainOutboxEvent'
        && writer.file === 'gravity-mvp/src/modules/calling/internal/ai-calls/ai-call-finalization-prisma-adapter.ts'
    ))
        && architecturePolicy.manifest_amendments.includes(
            'architecture/isolation/calling/ai-call-single-call-v1/module-manifest-amendments.json',
        ),
    'finalization adapter writes shared outbox state without exact architecture authorization',
)
assertCheck(
    'multi-worker outbox claim has a concurrent deterministic test',
    concurrentOutboxTest.includes('Promise.all([')
        && concurrentOutboxTest.includes('allows only one of two concurrent workers')
        && concurrentOutboxTest.includes("expect([...left, ...right]).toHaveLength(1)"),
    'outbox claim safety is asserted only sequentially',
)

// ── Mobile Push v1 (MOBILE-PUSH-V1-P1): the outbox as an explicit multi-flow ──
// The Calling assertions above are unchanged. Everything below pins the v2
// manifest's flow set, keeps the recording-ready declaration exactly as
// CRM-ARCH-005 accepted it, and holds the two Messaging push flows to the same
// standard: exact writers, same-transaction append, deterministic identities,
// fixed payload fields with no token or content, parse-before-delivery.
const outboxManifest = JSON.parse(read('architecture/events/v1/outbox-manifest.json'))
const MESSAGING_INTENT_WRITERS = [
    'gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-channel-message-adapter.ts',
    'gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-external-message-adapter.ts',
    'gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-receive-message-adapter.ts',
]
const MESSAGING_FAN_OUT_WRITER = 'gravity-mvp/src/modules/messaging/internal/mobile-push/push-fan-out-prisma-adapter.ts'
const APPROVED_OUTBOX_WRITERS = [
    'gravity-mvp/src/modules/calling/internal/recording-ready-prisma-adapter.ts',
    'gravity-mvp/src/modules/calling/internal/ai-calls/ai-call-finalization-prisma-adapter.ts',
    ...MESSAGING_INTENT_WRITERS,
    MESSAGING_FAN_OUT_WRITER,
]
const messagingIntentWriters = MESSAGING_INTENT_WRITERS.map((file) => [file, read(file)])
const messagingFanOutAdapter = read(MESSAGING_FAN_OUT_WRITER)
const messagingIntentContract = read('gravity-mvp/src/contracts/messaging/v1/inbound-message-notification-requested-event.ts')
const messagingDeliveryContract = read('gravity-mvp/src/contracts/messaging/v1/mobile-push-delivery-requested-event.ts')
const messagingConsumers = read('gravity-mvp/src/modules/messaging/public/v1/mobile-push-outbox-consumers.ts')
const messagingDispatch = read('gravity-mvp/src/modules/messaging/internal/mobile-push/mobile-push-dispatch.ts')
const messagingPushAmendments = JSON.parse(read('architecture/isolation/messaging/mobile-push-v1/module-manifest-amendments.json'))
const flowsById = new Map((outboxManifest.flows ?? []).map((flow) => [flow.id, flow]))

assertCheck(
    'outbox manifest declares exactly the reviewed flows',
    outboxManifest.schema === 'yoko.crm.transactional-outbox-manifest.v2'
        && outboxManifest.table === 'domain_outbox_events'
        && outboxManifest.infrastructure_state_owner === 'platform_shell'
        && JSON.stringify([...flowsById.keys()]) === JSON.stringify([
            'calling.recording-ready',
            'messaging.inbound-notification-intent',
            'messaging.mobile-push-delivery',
        ])
        && JSON.stringify((outboxManifest.externally_governed_flows ?? []).map((flow) => [flow.event, flow.authority])) === JSON.stringify([[
            'calling.AiCallFinalizationFollowUpRequested.v1',
            'architecture/isolation/calling/ai-call-single-call-v1/recovery-manifest.json',
        ]])
        && outboxManifest.credentials_in_contract === false,
    'outbox flow set drifted from the reviewed declaration',
)
assertCheck(
    'recording-ready flow keeps its CRM-ARCH-005 declaration',
    JSON.stringify(flowsById.get('calling.recording-ready')) === JSON.stringify({
        id: 'calling.recording-ready',
        producer_context: 'calling',
        consumer_context: 'calling',
        event: 'calling.RecordingReady.v1',
        aggregate: 'Call',
        domain_state: 'Call.recordingPath',
        atomic_writer: 'gravity-mvp/src/modules/calling/internal/recording-ready-prisma-adapter.ts',
        public_facade: 'gravity-mvp/src/modules/calling/public/v1/index.ts',
        consumer: 'gravity-mvp/src/modules/calling/public/v1/outbox-consumers.ts',
        delivery_adapter: 'BullMQ call-transcribe',
        consumer_idempotency: 'BullMQ jobId transcribe-${callId}',
        correlation: { correlation_id: 'Call.id', causation_id: 'FreeSWITCH channel UUID' },
        manifest_amendment: 'architecture/events/v1/module-manifest-amendments.json',
    })
        && JSON.stringify(outboxManifest.reliability) === JSON.stringify({
            event_identity: 'unique deterministic eventId',
            transactional_append: true,
            claim: 'compare-and-set on id, status and attempts',
            batch_limit: 25,
            publish_timeout_ms: 5000,
            max_attempts: 5,
            retry_delays_ms: [5000, 30000, 120000, 600000, 1800000],
            stale_claim_ms: 300000,
            poison_state: 'dead_letter',
            last_error_max_chars: 1000,
            last_error_secret_redaction: true,
            publisher_idempotency: 'published status plus atomic claim',
        }),
    'recording-ready flow or shared reliability declaration drifted',
)
assertCheck(
    'approved outbox writer denominator is explicit',
    JSON.stringify(architecturePolicy.approved_infrastructure_writers
        .filter((writer) => writer.model === 'DomainOutboxEvent')
        .map((writer) => writer.file)
        .sort()) === JSON.stringify([...APPROVED_OUTBOX_WRITERS].sort()),
    'shared outbox writers differ from the exact reviewed set',
)
assertCheck(
    'Messaging intent writers are exact and append inside the Message transaction',
    JSON.stringify(flowsById.get('messaging.inbound-notification-intent')?.atomic_writers) === JSON.stringify(MESSAGING_INTENT_WRITERS)
        && messagingIntentWriters.every(([, source]) => /\$transaction\(async \(?transaction\)? ?=>/.test(source)
            && /transaction\.domainOutboxEvent\.createMany\(\{ ?data: ?\[intent\], ?skipDuplicates: ?true ?\}\)/.test(source)
            && source.includes('inboundNotificationOutboxRowV1(')
            && !/prisma\.domainOutboxEvent/.test(source)),
    'an intent writer is undeclared or appends outside the Message transaction',
)
assertCheck(
    'Messaging fan-out writer is exact and appends idempotently',
    JSON.stringify(flowsById.get('messaging.mobile-push-delivery')?.atomic_writers) === JSON.stringify([MESSAGING_FAN_OUT_WRITER])
        && messagingFanOutAdapter.includes('prisma.domainOutboxEvent.createMany(')
        && messagingFanOutAdapter.includes('skipDuplicates: true'),
    'fan-out writer is undeclared or not idempotent',
)
assertCheck(
    'Messaging event identities are deterministic',
    messagingIntentContract.includes('return `${INBOUND_MESSAGE_NOTIFICATION_REQUESTED_EVENT_V1}:${messageId}`')
        && messagingDeliveryContract.includes('return `${MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1}:${messageId}:${registrationId}`')
        && messagingIntentContract.includes("fail('eventId must be derived from data.messageId')")
        && messagingDeliveryContract.includes("fail('eventId must be derived from data.messageId and data.registrationId')"),
    'a Messaging event id is not derived from its identity',
)
assertCheck(
    'Messaging payload field sets are exact and carry no token or content',
    messagingIntentContract.includes("hasOnly(input.data, ['messageId', 'chatId', 'channel'], 'data')")
        && messagingDeliveryContract.includes("hasOnly(input.data, ['messageId', 'chatId', 'channel', 'registrationId', 'sessionBindingId'], 'data')")
        && JSON.stringify(flowsById.get('messaging.inbound-notification-intent')?.payload_fields) === JSON.stringify(['channel', 'chatId', 'messageId'])
        && JSON.stringify(flowsById.get('messaging.mobile-push-delivery')?.payload_fields) === JSON.stringify(['channel', 'chatId', 'messageId', 'registrationId', 'sessionBindingId'])
        && ![...flowsById.values()].some((flow) => (flow.payload_fields ?? []).some((field) => /token|content|text|phone|name/i.test(field))),
    'a Messaging payload can carry a token or content',
)
assertCheck(
    'Messaging push contracts are versioned and provider neutral',
    messagingIntentContract.includes("'messaging.InboundMessageNotificationRequested.v1'")
        && messagingDeliveryContract.includes("'messaging.MobilePushDeliveryRequested.v1'")
        && ![messagingIntentContract, messagingDeliveryContract].some((source) => /@\/lib\/|@prisma|firebase|googleapis|node:/i.test(source)),
    'a Messaging push contract is unversioned or provider-bound',
)
assertCheck(
    'Messaging consumers validate each event before acting on it',
    messagingConsumers.includes('[INBOUND_MESSAGE_NOTIFICATION_REQUESTED_EVENT_V1]')
        && messagingConsumers.includes('[MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1]')
        && messagingDispatch.includes('const intent = parseInboundMessageNotificationRequestedEventV1(payload)')
        && messagingDispatch.includes('const delivery = parseMobilePushDeliveryRequestedEventV1(payload)'),
    'a Messaging consumer acts on an unparsed payload',
)
assertCheck(
    'composition root registers Calling and Messaging publishers without shadowing',
    composition.includes('callingOutboxPublishersV1')
        && composition.includes('messagingOutboxPublishersV1')
        && composition.includes('DUPLICATE_OUTBOX_PUBLISHER')
        && composition.includes('publishers: domainOutboxPublishersV1'),
    'Messaging publishers are unregistered or may shadow Calling',
)
assertCheck(
    'Messaging push events are declared in module manifests',
    messagingPushAmendments.amendments.some((item) => item.context === 'messaging'
        && JSON.stringify(item.add_events) === JSON.stringify(['messaging.InboundMessageNotificationRequested.v1', 'messaging.MobilePushDeliveryRequested.v1']))
        && architecturePolicy.manifest_amendments.includes('architecture/isolation/messaging/mobile-push-v1/module-manifest-amendments.json')
        && [...flowsById.values()].filter((flow) => flow.id.startsWith('messaging.'))
            .every((flow) => flow.manifest_amendment === 'architecture/isolation/messaging/mobile-push-v1/module-manifest-amendments.json'),
    'Messaging push events are undeclared',
)

const result = {
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    checks,
    failures,
    migration: migrationPath,
}
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
if (failures.length > 0) process.exit(1)
