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
const componentPath = 'gravity-mvp/src/app/messages/components/AiInternToggle.tsx'
const oldTargetPath = 'gravity-mvp/src/app/settings/ai/actions.ts'
const actionsPath = 'gravity-mvp/src/modules/calling/public/v1/ai-intern-control-actions.ts'
const applicationPath = 'gravity-mvp/src/modules/calling/application/ai-intern-control-operations.ts'
const adapterPath = 'gravity-mvp/src/modules/calling/public/v1/legacy-prisma-ai-intern-control-adapter.ts'
const publicActionSpecifier = '@/modules/calling/public/v1/ai-intern-control-actions'
const applicationSpecifier = '../../application/ai-intern-control-operations'
const exactCapabilities = ['getAiInternStateV1', 'setAiInternStateV1']
const exactApplicationBindings = [
    ['getAiInternStateV1', 'executeGetAiInternStateV1', false],
    ['setAiInternStateV1', 'executeSetAiInternStateV1', false],
]

function parseSource(relative, source) {
    const kind = relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    return ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, kind)
}

function hasModifier(node, kind) {
    return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false
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

function exactNamedImport(relative, source, specifier, expected) {
    assert.deepEqual(
        importSites(relative, source)
            .filter((site) => site.kind === 'static' && site.specifier === specifier)
            .map((site) => site.bindings),
        [expected],
    )
}

function functionDeclaration(sourceFile, name) {
    const matches = sourceFile.statements.filter((statement) => (
        ts.isFunctionDeclaration(statement) && statement.name?.text === name
    ))
    assert.equal(matches.length, 1, `expected one ${name} wrapper`)
    const declaration = matches[0]
    assert(hasModifier(declaration, ts.SyntaxKind.ExportKeyword), `${name} must be exported`)
    assert(hasModifier(declaration, ts.SyntaxKind.AsyncKeyword), `${name} must be async`)
    assert(declaration.body)
    return declaration
}

function assertAwaitedIdentifierCall(statement, name) {
    assert(ts.isExpressionStatement(statement))
    assert(ts.isAwaitExpression(statement.expression))
    const call = unwrapExpression(statement.expression)
    assert(ts.isCallExpression(call))
    assert(ts.isIdentifier(call.expression) && call.expression.text === name)
    assert.equal(call.arguments.length, 0)
}

function assertAwaitedPortCall(expression, method, argument) {
    assert(ts.isAwaitExpression(expression))
    const call = unwrapExpression(expression)
    assert(ts.isCallExpression(call))
    assert(ts.isPropertyAccessExpression(call.expression))
    assert(ts.isIdentifier(call.expression.expression) && call.expression.expression.text === 'aiInternControl')
    assert.equal(call.expression.name.text, method)
    assert.equal(call.arguments.length, 1)
    assert(ts.isIdentifier(call.arguments[0]) && call.arguments[0].text === argument)
}

function assertApplicationBoundary(source) {
    exactNamedImport(applicationPath, source, '../../identity-access/public/v1', [
        ['requireIntegrationAdminAccess', 'requireIntegrationAdminAccess', false],
    ])
    exactNamedImport(applicationPath, source, '../public/v1/ai-intern-control-handler', [
        ['createAiInternControlHandlerV1', 'createAiInternControlHandlerV1', false],
    ])
    exactNamedImport(applicationPath, source, '../public/v1/legacy-prisma-ai-intern-control-adapter', [
        ['legacyPrismaAiInternControlPortV1', 'legacyPrismaAiInternControlPortV1', false],
    ])
    const sourceFile = parseSource(applicationPath, source)
    assert.deepEqual(
        nonImportDeclarations(applicationPath, source).filter((name) => [
            'requireIntegrationAdminAccess',
            'createAiInternControlHandlerV1',
            'legacyPrismaAiInternControlPortV1',
        ].includes(name)),
        [],
        'application shadows an imported authorization, factory or adapter binding',
    )
    const bindings = []
    for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) continue
        for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === 'aiInternControl') {
                bindings.push({ statement, declaration })
            }
        }
    }
    assert.equal(bindings.length, 1)
    const [{ statement: bindingStatement, declaration: binding }] = bindings
    assert((bindingStatement.declarationList.flags & ts.NodeFlags.Const) !== 0)
    assert.equal(hasModifier(bindingStatement, ts.SyntaxKind.ExportKeyword), false)
    const bindingCall = binding.initializer && unwrapExpression(binding.initializer)
    assert(bindingCall && ts.isCallExpression(bindingCall))
    assert(ts.isIdentifier(bindingCall.expression) && bindingCall.expression.text === 'createAiInternControlHandlerV1')
    assert.equal(bindingCall.arguments.length, 1)
    assert(ts.isIdentifier(bindingCall.arguments[0]) && bindingCall.arguments[0].text === 'legacyPrismaAiInternControlPortV1')

    const getState = functionDeclaration(sourceFile, 'getAiInternStateV1')
    assert.equal(getState.parameters.length, 1)
    assert(ts.isIdentifier(getState.parameters[0].name) && getState.parameters[0].name.text === 'query')
    assert.equal(getState.body.statements.length, 2)
    assertAwaitedIdentifierCall(getState.body.statements[0], 'requireIntegrationAdminAccess')
    const getTry = getState.body.statements[1]
    assert(ts.isTryStatement(getTry) && getTry.catchClause && !getTry.finallyBlock)
    assert.equal(getTry.tryBlock.statements.length, 1)
    const getReturn = getTry.tryBlock.statements[0]
    assert(ts.isReturnStatement(getReturn) && getReturn.expression)
    assertAwaitedPortCall(getReturn.expression, 'getState', 'query')
    assert.equal(getTry.catchClause.block.statements.length, 1)
    const getFallback = getTry.catchClause.block.statements[0]
    assert(ts.isReturnStatement(getFallback) && getFallback.expression)
    assert.equal(
        getFallback.expression.getText(sourceFile).replace(/\s+/g, ''),
        '{contract:GET_AI_INTERN_STATE_RESULT_V1,internEnabled:null}',
    )

    const setState = functionDeclaration(sourceFile, 'setAiInternStateV1')
    assert.equal(setState.parameters.length, 1)
    assert(ts.isIdentifier(setState.parameters[0].name) && setState.parameters[0].name.text === 'command')
    assert.equal(setState.body.statements.length, 2)
    assertAwaitedIdentifierCall(setState.body.statements[0], 'requireIntegrationAdminAccess')
    const setTry = setState.body.statements[1]
    assert(ts.isTryStatement(setTry) && setTry.catchClause && !setTry.finallyBlock)
    assert.equal(setTry.tryBlock.statements.length, 3)
    const resultStatement = setTry.tryBlock.statements[0]
    assert(ts.isVariableStatement(resultStatement))
    assert((resultStatement.declarationList.flags & ts.NodeFlags.Const) !== 0)
    assert.equal(resultStatement.declarationList.declarations.length, 1)
    const resultDeclaration = resultStatement.declarationList.declarations[0]
    assert(ts.isIdentifier(resultDeclaration.name) && resultDeclaration.name.text === 'result')
    assert(resultDeclaration.initializer)
    assertAwaitedPortCall(resultDeclaration.initializer, 'setState', 'command')
    const revalidation = setTry.tryBlock.statements[1]
    assert(ts.isExpressionStatement(revalidation))
    const revalidationCall = unwrapExpression(revalidation.expression)
    assert(ts.isCallExpression(revalidationCall))
    assert(ts.isIdentifier(revalidationCall.expression) && revalidationCall.expression.text === 'revalidatePath')
    assert.equal(revalidationCall.arguments.length, 1)
    assert(ts.isStringLiteralLike(revalidationCall.arguments[0]) && revalidationCall.arguments[0].text === '/settings/ai')
    const setReturn = setTry.tryBlock.statements[2]
    assert(ts.isReturnStatement(setReturn) && setReturn.expression)
    assert(ts.isIdentifier(setReturn.expression) && setReturn.expression.text === 'result')
    assert.equal(setTry.catchClause.block.statements.length, 3)
    assert(ts.isVariableStatement(setTry.catchClause.block.statements[0]))
    assert(ts.isExpressionStatement(setTry.catchClause.block.statements[1]))
    assert(ts.isThrowStatement(setTry.catchClause.block.statements[2]))

    const exportedRuntime = sourceFile.statements.filter((candidate) => (
        ts.isFunctionDeclaration(candidate)
        && candidate.name
        && hasModifier(candidate, ts.SyntaxKind.ExportKeyword)
    )).map((candidate) => candidate.name.text)
    assert.deepEqual(exportedRuntime, exactCapabilities)
    const ownerCalls = callSites(applicationPath, source).filter((call) => (
        call.kind === 'property' && call.object === 'aiInternControl'
    ))
    assert.deepEqual(ownerCalls.map(({ object, name }) => [object, name]), [
        ['aiInternControl', 'getState'],
        ['aiInternControl', 'setState'],
    ])
}

function assertPublicActionBoundary(source) {
    assert.deepEqual(namedExportSites(actionsPath, source, applicationSpecifier), [])
    exactNamedImport(actionsPath, source, applicationSpecifier, exactApplicationBindings)
    const sourceFile = parseSource(actionsPath, source)
    const wrappers = [
        ['getAiInternStateV1', 'query', 'executeGetAiInternStateV1'],
        ['setAiInternStateV1', 'command', 'executeSetAiInternStateV1'],
    ]
    for (const [publicName, parameterName, applicationName] of wrappers) {
        const declaration = functionDeclaration(sourceFile, publicName)
        assert.equal(declaration.parameters.length, 1)
        assert(ts.isIdentifier(declaration.parameters[0].name))
        assert.equal(declaration.parameters[0].name.text, parameterName)
        assert.equal(declaration.body.statements.length, 1)
        const returned = declaration.body.statements[0]
        assert(ts.isReturnStatement(returned) && returned.expression)
        assert(ts.isAwaitExpression(returned.expression))
        const call = unwrapExpression(returned.expression)
        assert(ts.isCallExpression(call))
        assert(ts.isIdentifier(call.expression) && call.expression.text === applicationName)
        assert.equal(call.arguments.length, 1)
        assert(ts.isIdentifier(call.arguments[0]) && call.arguments[0].text === parameterName)
    }
    assert.deepEqual(
        sourceFile.statements.filter((statement) => (
            ts.isFunctionDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)
        )).map((statement) => statement.name?.text),
        exactCapabilities,
    )
    assert.deepEqual(
        nonImportDeclarations(actionsPath, source).filter((name) => (
            exactApplicationBindings.some(([, local]) => local === name)
        )),
        [],
        'public action shadows an imported application capability',
    )
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

function assertComponentBoundary(source) {
    assert.deepEqual(targetImportSites(componentPath, source), [{
        kind: 'static',
        specifier: publicActionSpecifier,
        bindings: exactCapabilities.map((name) => [name, name, false]),
    }])
    const calls = callSites(componentPath, source).filter((call) => exactCapabilities.includes(call.name))
    assert.deepEqual(calls.map(({ kind, name }) => [kind, name]), [
        ['identifier', 'getAiInternStateV1'],
        ['identifier', 'setAiInternStateV1'],
    ])
    assert.deepEqual(
        nonImportDeclarations(componentPath, source).filter((name) => exactCapabilities.includes(name)),
        [],
        'Messaging consumer shadows an imported AI-intern capability',
    )
    for (const site of importSites(componentPath, source)) {
        assert.notEqual(site.specifier, '@/app/settings/ai/actions')
        assert.equal(site.specifier.includes('/modules/calling/application/'), false)
        assert.equal(site.specifier.includes('/modules/calling/internal/'), false)
        assert.equal(site.specifier.includes('legacy-prisma-ai-intern-control-adapter'), false)
    }
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
    return entries.filter(({ relative, source }) => (
        targetImportSites(relative, source).length > 0
        || callSites(relative, source).some((call) => exactCapabilities.includes(call.name))
    )).map(({ relative }) => relative).sort()
}

function assertConsumerDenominator(entries) {
    assert.deepEqual(
        discoverConsumers(entries.filter(({ relative }) => relative !== actionsPath)),
        [componentPath],
    )
}

function rejectProbe(original, changed, validate) {
    assert.notEqual(changed, original, 'negative probe must alter its source')
    assert.throws(() => validate(changed))
}

const component = read(componentPath)
const actions = read(actionsPath)
const application = read(applicationPath)
const adapter = read(adapterPath)

assertPublicActionBoundary(actions)
assertApplicationBoundary(application)
assertComponentBoundary(component)
assert.doesNotMatch(actions, /apiKeyEncrypted|providerCredential|export \*/)
assert.doesNotMatch(application, /apiKeyEncrypted|providerCredential|export \*/)

rejectProbe(
    application,
    application.replace(
        'createAiInternControlHandlerV1(legacyPrismaAiInternControlPortV1)',
        'createAiInternControlHandlerV1({} as never)',
    ),
    assertApplicationBoundary,
)
rejectProbe(
    application,
    application.replace(
        'try { return await aiInternControl.getState(query) }',
        'try { return { contract: GET_AI_INTERN_STATE_RESULT_V1, internEnabled: null } } // aiInternControl.getState(query)',
    ),
    assertApplicationBoundary,
)
rejectProbe(
    actions,
    actions.replace(
        'return await executeGetAiInternStateV1(query)',
        'return { internEnabled: true } // executeGetAiInternStateV1(query)',
    ),
    assertPublicActionBoundary,
)
rejectProbe(
    actions,
    actions.replace(
        'return await executeSetAiInternStateV1(command)',
        'return await executeGetAiInternStateV1(command)',
    ),
    assertPublicActionBoundary,
)
rejectProbe(
    component,
    component.replace(
        'getAiInternStateV1({ contract: GET_AI_INTERN_STATE_QUERY_V1 })',
        'Promise.resolve({ internEnabled: true }) // getAiInternStateV1({ contract: GET_AI_INTERN_STATE_QUERY_V1 })',
    ),
    assertComponentBoundary,
)

assert.match(component, /result\.internEnabled \?\? true/)
assert.match(component, /setEnabled\(newVal\)/)
assert.match(component, /setEnabled\(!newVal\)/)
assert.match(component, /SET_AI_INTERN_STATE_COMMAND_V1/)
assert.match(application, /console\.error\('\[AI Config\] saveAiConfig error:', detail\)/)
assert.match(application, /throw new Error\(`Не удалось сохранить настройки AI: \$\{detail\}`\)/)

assert.match(adapter, /select: \{ internEnabled: true \}/)
assert.match(adapter, /entries: \[\{ field: 'internEnabled', value: enabled \}\]/)
assert.doesNotMatch(adapter, /apiKeyEncrypted|providerCredential/)
assert.equal(
    sha256(read('gravity-mvp/src/modules/calling/public/v1/legacy-prisma-ai-agent-config-adapter.ts')),
    '4af2571e34729732839a99fd09f82ffbcc386adc2d29b1cfb1903734f649a7d0',
)

const sourceEntries = runtimeSourcePaths('gravity-mvp/src').map((relative) => ({ relative, source: read(relative) }))
assertConsumerDenominator(sourceEntries)
const extraConsumerPath = 'gravity-mvp/src/app/probes/extra-ai-intern-consumer.ts'
const extraConsumerSource = `import { getAiInternStateV1 } from '${publicActionSpecifier}'\nexport const probe = () => getAiInternStateV1({ contract: 'calling.GetAiInternStateQuery.v1' })\n`
assert.throws(
    () => assertConsumerDenominator([
        ...sourceEntries,
        { relative: extraConsumerPath, source: extraConsumerSource },
    ]),
)

const callingManifest = JSON.parse(read('architecture/contexts/v1/manifests/calling.json'))
const messagingManifest = JSON.parse(read('architecture/contexts/v1/manifests/messaging.json'))
assert(callingManifest.public_surface.includes('AiInternControl.v1'))
assert(callingManifest.commands.includes('SetAiInternStateCommand.v1'))
assert(messagingManifest.allowed_dependencies.some((dependency) => (
    dependency.context === 'calling' && dependency.surface === 'calling.public'
)))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    finding.file === componentPath && finding.details?.target === oldTargetPath
)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    runtime_consumers: 1,
    read_capabilities: 1,
    write_capabilities: 1,
    negative_application_wiring_probes: 4,
    negative_comment_consumer_probes: 1,
    negative_consumer_denominator_probes: 1,
    credential_fields_exposed: 0,
    dependency_cycle: 'ABSENT',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
