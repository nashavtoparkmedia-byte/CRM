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
const implementationPath = 'gravity-mvp/src/lib/contacts/max-contact-resolution-shadow.ts'
const typesPath = 'gravity-mvp/src/lib/contacts/contact-resolution-shadow.types.ts'
const legacyPublicPath = 'gravity-mvp/src/modules/contacts/public/v1/max-contact-resolution-shadow.ts'
const publicBarrelPath = 'gravity-mvp/src/modules/contacts/public/v1/index.ts'
const publicAggregatorPath = 'gravity-mvp/src/modules/contacts/public/index.ts'
const moduleIndexPath = 'gravity-mvp/src/modules/contacts/index.ts'
const applicationPath = 'gravity-mvp/src/modules/contacts/application/contact-external-operations.ts'
const internalPath = 'gravity-mvp/src/modules/contacts/internal/external-contact-operations.ts'
const consumerPath = 'gravity-mvp/src/app/api/webhooks/max/route.ts'
const exactCapabilities = ['start']
const publicBarrelSpecifier = '@/modules/contacts/public/v1'
const applicationSpecifier = '../../application/contact-external-operations'
const internalSpecifier = '../internal/external-contact-operations'
const implementationSpecifier = '@/lib/contacts/max-contact-resolution-shadow'
const typesSpecifier = '@/lib/contacts/contact-resolution-shadow.types'

assert.equal(sha256(read(implementationPath)), '4405d7431b341e45b77508da145f676f3c604069533a554ecddd96da5f93ba54')
assert.equal(sha256(read(typesPath)), 'c54d32c1d37c28e137554d57e0178a7ea5c120d973efb3d48c1ac871ce06442d')

const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(absolute) : (/\.[cm]?[jt]sx?$/.test(entry.name) ? [absolute] : [])
})
const relative = (absolute) => path.relative(root, absolute).split(path.sep).join('/')
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
    ts.forEachChild(node, (child) => visit(child, callback))
}
const namedImports = (source, file = 'probe.ts') => parse(file, source).statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) return []
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) return []
    return bindings.elements.map((element) => ({
        imported: element.propertyName?.text ?? element.name.text,
        local: element.name.text,
        typeOnly: Boolean(statement.importClause?.isTypeOnly || element.isTypeOnly),
        source: statement.moduleSpecifier.text,
    }))
})
const namedReexports = (source, file = 'probe.ts') => parse(file, source).statements.flatMap((statement) => {
    if (!ts.isExportDeclaration(statement)
        || !statement.moduleSpecifier
        || !ts.isStringLiteralLike(statement.moduleSpecifier)
        || !statement.exportClause
        || !ts.isNamedExports(statement.exportClause)) return []
    return statement.exportClause.elements.map((element) => ({
        imported: element.propertyName?.text ?? element.name.text,
        local: element.name.text,
        typeOnly: Boolean(statement.isTypeOnly || element.isTypeOnly),
        source: statement.moduleSpecifier.text,
    }))
})

function capabilityObject(source, file = legacyPublicPath) {
    const sourceFile = parse(file, source)
    const declarations = exportedConst(sourceFile, 'maxContactResolutionShadowV1')
    assert.equal(declarations.length, 1, `${file}: exact frozen compatibility capability`)
    const initializer = unwrap(declarations[0].initializer)
    assert(initializer && ts.isCallExpression(initializer) && propertyPath(initializer.expression) === 'Object.freeze')
    assert.equal(initializer.arguments.length, 1)
    const object = unwrap(initializer.arguments[0])
    assert(object && ts.isObjectLiteralExpression(object), `${file}: frozen capability object literal`)
    return { sourceFile, object }
}

function capabilityKeys(source) {
    const { object } = capabilityObject(source)
    return object.properties.map((property) => {
        assert(ts.isPropertyAssignment(property), 'compatibility capability properties must be explicit assignments')
        assert(ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
        return property.name.text
    }).sort()
}

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
const calls = (sourceFile, expectedPath) => {
    const result = []
    visit(sourceFile, (node) => {
        if (ts.isCallExpression(node) && propertyPath(node.expression) === expectedPath) result.push(node)
    })
    return result
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
const assertImportedDirectCalls = (sourceFile, name, expectedCount, owner = null) => {
    const directCalls = []
    visit(sourceFile, (node) => {
        if (!ts.isIdentifier(node) || node.text !== name) return
        if (ts.isImportSpecifier(node.parent) && node.parent.name === node) return
        const call = directCallForIdentifier(node)
        assert(call, `${sourceFile.fileName}: ${name} must not be shadowed, copied, or referenced indirectly`)
        assert.equal(syntacticallyDead(call), false, `${sourceFile.fileName}: ${name} call is syntactically dead`)
        directCalls.push(call)
    })
    assert.equal(directCalls.length, expectedCount, `${sourceFile.fileName}: ${name} executable direct-call count`)
    if (owner) assert(directCalls.every((call) => enclosingFunctionName(call) === owner), `${sourceFile.fileName}: ${name} calls must stay in ${owner}`)
    return directCalls
}
const exportedConst = (sourceFile, name) => sourceFile.statements.flatMap((statement) => {
    if (!ts.isVariableStatement(statement)
        || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        || !(statement.declarationList.flags & ts.NodeFlags.Const)) return []
    return statement.declarationList.declarations.filter((declaration) => (
        ts.isIdentifier(declaration.name) && declaration.name.text === name
    ))
})
const assertDirectDelegate = (source, file, exportedName, target, parameter) => {
    const sourceFile = parse(file, source)
    const declarations = exportedConst(sourceFile, exportedName)
    assert.equal(declarations.length, 1, `${file}: ${exportedName} exact exported const`)
    const initializer = unwrap(declarations[0].initializer)
    assert(initializer && ts.isArrowFunction(initializer), `${file}: ${exportedName} arrow wrapper`)
    assert.equal(initializer.parameters.length, 1)
    assert(ts.isIdentifier(initializer.parameters[0].name) && initializer.parameters[0].name.text === parameter)
    const body = unwrap(initializer.body)
    assert(ts.isCallExpression(body), `${file}: ${exportedName} direct call return`)
    assert(ts.isIdentifier(body.expression) && body.expression.text === target)
    assert.deepEqual(body.arguments.map((argument) => argument.getText(sourceFile)), [parameter])
    assertImportedDirectCalls(sourceFile, target, 1)
    assert.equal(syntacticallyDead(body), false)
}

const assertLegacyPublicBoundary = (source) => {
    const imports = namedImports(source, legacyPublicPath)
    exactBinding(imports, 'startMaxContactResolutionShadow', {
        typeOnly: false,
        source: implementationSpecifier,
    })
    for (const imported of [
        'LegacyContactResolutionOutcome',
        'MaxContactResolutionShadowInput',
        'MaxContactResolutionShadowStart',
    ]) exactBinding(imports, imported, { typeOnly: true, source: typesSpecifier })
    const { sourceFile, object } = capabilityObject(source)
    assert.deepEqual(capabilityKeys(source), exactCapabilities)
    const start = object.properties[0]
    assert(ts.isPropertyAssignment(start) && start.name.getText(sourceFile) === 'start')
    const wrapper = unwrap(start.initializer)
    assert(wrapper && ts.isArrowFunction(wrapper) && wrapper.parameters.length === 1)
    assert(ts.isIdentifier(wrapper.parameters[0].name) && wrapper.parameters[0].name.text === 'input')
    const body = unwrap(wrapper.body)
    assert(body && ts.isCallExpression(body) && ts.isIdentifier(body.expression) && body.expression.text === 'startMaxContactResolutionShadow')
    assert.deepEqual(body.arguments.map((argument) => argument.getText(sourceFile)), ['input'])
    assertImportedDirectCalls(sourceFile, 'startMaxContactResolutionShadow', 1)
    const localTypeExports = sourceFile.statements.flatMap((statement) => (
        ts.isExportDeclaration(statement)
        && !statement.moduleSpecifier
        && statement.exportClause
        && ts.isNamedExports(statement.exportClause)
            ? statement.exportClause.elements.filter((element) => element.isTypeOnly || statement.isTypeOnly).map((element) => element.name.text)
            : []
    ))
    assert.deepEqual(localTypeExports, ['LegacyContactResolutionOutcome'])
}

function exactBinding(bindings, imported, expected) {
    const matches = bindings.filter((binding) => binding.imported === imported)
    assert.equal(matches.length, 1, `${imported} must have exactly one named boundary binding`)
    assert.deepEqual(matches[0], { imported, local: imported, ...expected })
    return matches[0]
}

function assertConsumerBoundary(source) {
    const imports = namedImports(source, consumerPath)
    exactBinding(imports, 'startMaxContactResolutionShadowV1', {
        typeOnly: false,
        source: publicBarrelSpecifier,
    })
    exactBinding(imports, 'LegacyContactResolutionOutcome', {
        typeOnly: true,
        source: publicBarrelSpecifier,
    })
    assert.doesNotMatch(source, /@\/modules\/contacts\/(?:application|internal)\//)
    assert.doesNotMatch(source, /@\/modules\/contacts\/public\/v1\/max-contact-resolution-shadow/)
    assert.doesNotMatch(source, /@\/lib\/contacts\/(?:max-contact-resolution-shadow|contact-resolution-shadow\.types)/)
    assert.doesNotMatch(source, /\bmaxContactResolutionShadowV1\b/)
    const sourceFile = parse(consumerPath, source)
    const startCalls = assertImportedDirectCalls(sourceFile, 'startMaxContactResolutionShadowV1', 1, 'POST')
    assert(ts.isAwaitExpression(startCalls[0].parent), 'shadow start must be awaited')
    const declaration = startCalls[0].parent.parent
    assert(ts.isVariableDeclaration(declaration)
        && ts.isIdentifier(declaration.name)
        && declaration.name.text === 'maxContactResolutionShadow')
    const completionCalls = calls(sourceFile, 'maxContactResolutionShadow.session.complete')
    assert.equal(completionCalls.length, 2)
    assert(completionCalls.every((call) => (
        ts.isAwaitExpression(call.parent)
        && !syntacticallyDead(call)
        && enclosingFunctionName(call) === 'POST'
    )))
    let shadowResultDeclarations = 0
    visit(sourceFile, (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'maxContactResolutionShadow') {
            shadowResultDeclarations += 1
        }
    })
    assert.equal(shadowResultDeclarations, 1, 'shadow session result must not be shadowed')
    const legacyMutationCalls = calls(sourceFile, 'prisma.chat.findUnique')
    assert(legacyMutationCalls.length > 0, 'legacy Chat read/mutation chain is absent')
    assert(startCalls[0].getStart(sourceFile) < legacyMutationCalls[0].getStart(sourceFile), 'shadow must start before the first legacy Chat mutation')
}

function assertBarrelBoundary(source) {
    const exports = namedReexports(source, publicBarrelPath)
    exactBinding(exports, 'startMaxContactResolutionShadowV1', {
        typeOnly: false,
        source: applicationSpecifier,
    })
    exactBinding(exports, 'LegacyContactResolutionOutcome', {
        typeOnly: true,
        source: applicationSpecifier,
    })
    assert.doesNotMatch(source, /(?:from|export)\s+['"][^'"]*(?:\/internal\/|@\/lib\/contacts\/)/)
    assert.doesNotMatch(source, /from\s+['"]\.\/max-contact-resolution-shadow['"]/)
}

function assertApplicationBoundary(source) {
    const imports = namedImports(source, applicationPath)
    exactBinding(imports, 'startMaxContactResolutionShadow', {
        typeOnly: false,
        source: internalSpecifier,
    })
    for (const imported of [
        'LegacyContactResolutionOutcome',
        'MaxContactResolutionShadowInput',
        'MaxContactResolutionShadowStart',
    ]) {
        exactBinding(imports, imported, { typeOnly: true, source: internalSpecifier })
    }
    const sourceFile = parse(applicationPath, source)
    const localTypeExports = sourceFile.statements.flatMap((statement) => (
        ts.isExportDeclaration(statement)
        && !statement.moduleSpecifier
        && statement.exportClause
        && ts.isNamedExports(statement.exportClause)
            ? statement.exportClause.elements.filter((element) => element.isTypeOnly || statement.isTypeOnly).map((element) => element.name.text)
            : []
    ))
    assert.deepEqual(localTypeExports, ['LegacyContactResolutionOutcome'])
    assertDirectDelegate(source, applicationPath, 'startMaxContactResolutionShadowV1', 'startMaxContactResolutionShadow', 'input')
    assert.doesNotMatch(source, /@\/lib\/contacts\/|\/public\/|\bprisma\b|compareContactResolution|isMaxContactResolutionShadowEnabled|Dependencies|export \*/)
}

function assertInternalBoundary(source) {
    const imports = namedImports(source, internalPath)
    const start = imports.filter((binding) => binding.imported === 'startMaxContactResolutionShadow')
    assert.deepEqual(start, [{
        imported: 'startMaxContactResolutionShadow',
        local: 'startShadow',
        typeOnly: false,
        source: implementationSpecifier,
    }])
    for (const imported of [
        'LegacyContactResolutionOutcome',
        'MaxContactResolutionShadowInput',
        'MaxContactResolutionShadowStart',
    ]) {
        exactBinding(imports, imported, { typeOnly: true, source: typesSpecifier })
    }
    assertDirectDelegate(source, internalPath, 'startMaxContactResolutionShadow', 'startShadow', 'input')
    assert.doesNotMatch(source, /compareContactResolution|isMaxContactResolutionShadowEnabled|MaxContactResolutionShadowDependencies|\bprisma\b|export \*/)
}

function rejectProbe(source, changed, validate) {
    assert.notEqual(changed, source, 'negative probe must alter its source')
    assert.throws(() => validate(changed))
}

const allSourcePaths = walk(path.join(root, 'gravity-mvp/src'))
    .map(relative)
    .filter((file) => !/(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))
const baseSources = new Map(allSourcePaths.map((file) => [file, read(file)]))
const rawCapability = 'startMaxContactResolutionShadow'
const publicCapability = 'startMaxContactResolutionShadowV1'
const expectedPublicCapabilityBindings = [
    {
        file: moduleIndexPath,
        kind: 'namespace-export',
        source: './public',
        imported: '*',
        local: 'ContactsPublic',
        typeOnly: false,
    },
    {
        file: legacyPublicPath,
        kind: 'import',
        source: implementationSpecifier,
        imported: rawCapability,
        local: rawCapability,
        typeOnly: false,
    },
    {
        file: internalPath,
        kind: 'import',
        source: implementationSpecifier,
        imported: rawCapability,
        local: 'startShadow',
        typeOnly: false,
    },
    {
        file: applicationPath,
        kind: 'import',
        source: internalSpecifier,
        imported: rawCapability,
        local: rawCapability,
        typeOnly: false,
    },
    {
        file: consumerPath,
        kind: 'import',
        source: publicBarrelSpecifier,
        imported: publicCapability,
        local: publicCapability,
        typeOnly: false,
    },
    {
        file: publicBarrelPath,
        kind: 'export',
        source: applicationSpecifier,
        imported: publicCapability,
        local: publicCapability,
        typeOnly: false,
    },
    {
        file: publicAggregatorPath,
        kind: 'export-star',
        source: './v1',
        imported: '*',
        local: '*',
        typeOnly: false,
    },
].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))

const withoutModuleSuffix = (value) => value.replace(/\.(?:[cm]?[jt]sx?)$/, '').replace(/\/index$/, '')
const resolveModule = (file, specifier) => {
    if (specifier.startsWith('@/')) return withoutModuleSuffix(`gravity-mvp/src/${specifier.slice(2)}`)
    if (specifier.startsWith('.')) return withoutModuleSuffix(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)))
    return specifier
}
const governedModules = new Set([
    withoutModuleSuffix(implementationPath),
    withoutModuleSuffix(internalPath),
    withoutModuleSuffix(applicationPath),
    withoutModuleSuffix(legacyPublicPath),
    withoutModuleSuffix(path.posix.dirname(publicBarrelPath)),
    withoutModuleSuffix(path.posix.dirname(publicAggregatorPath)),
])
const governedModule = (file, specifier) => {
    const resolved = resolveModule(file, specifier)
    const publicDirectory = withoutModuleSuffix(path.posix.dirname(publicBarrelPath))
    return governedModules.has(resolved)
        || resolved.startsWith(`${publicDirectory}/max-contact-resolution-shadow`)
}
const wildcardBindings = (source, file) => {
    const sourceFile = parse(file, source)
    const records = []
    for (const statement of sourceFile.statements) {
        const specifier = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
            ? (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null)
            : null
        if (!specifier || !governedModule(file, specifier)) continue
        if (ts.isImportDeclaration(statement)) {
            const clause = statement.importClause
            if (clause?.name) records.push({ file, kind: 'default-import', source: specifier, imported: 'default', local: clause.name.text, typeOnly: Boolean(clause.isTypeOnly) })
            if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
                records.push({ file, kind: 'namespace-import', source: specifier, imported: '*', local: clause.namedBindings.name.text, typeOnly: Boolean(clause.isTypeOnly) })
            }
        } else if (!statement.exportClause) {
            records.push({ file, kind: 'export-star', source: specifier, imported: '*', local: '*', typeOnly: Boolean(statement.isTypeOnly) })
        } else if (ts.isNamespaceExport(statement.exportClause)) {
            records.push({ file, kind: 'namespace-export', source: specifier, imported: '*', local: statement.exportClause.name.text, typeOnly: Boolean(statement.isTypeOnly) })
        }
    }
    visit(sourceFile, (node) => {
        if (!ts.isCallExpression(node) || node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) return
        const kind = node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? 'dynamic-import'
            : (ts.isIdentifier(node.expression) && node.expression.text === 'require' ? 'require' : null)
        const parent = node.parent
        const destructuredDynamic = kind === 'dynamic-import'
            && ts.isAwaitExpression(parent)
            && ts.isVariableDeclaration(parent.parent)
            && parent.parent.initializer === parent
            && ts.isObjectBindingPattern(parent.parent.name)
        const governedDestructuredName = destructuredDynamic && parent.parent.name.elements.some((element) => (
            publicCapability === (element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile))
                || rawCapability === (element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile))
        ))
        if (kind && governedModule(file, node.arguments[0].text) && (!destructuredDynamic || governedDestructuredName)) {
            records.push({ file, kind, source: node.arguments[0].text, imported: '*', local: '*', typeOnly: false })
        }
    })
    return records
}

function discoverPublicCapabilityBindings(sourceFiles = baseSources) {
    return [...sourceFiles].flatMap(([file, source]) => [
        ...namedImports(source, file).filter((binding) => binding.imported === rawCapability || binding.imported === publicCapability)
            .map((binding) => ({ file, kind: 'import', ...binding })),
        ...namedReexports(source, file).filter((binding) => binding.imported === rawCapability || binding.imported === publicCapability)
            .map((binding) => ({ file, kind: 'export', ...binding })),
        ...wildcardBindings(source, file),
    ]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function assertPublicCapabilityDenominator(sourceFiles = baseSources) {
    assert.deepEqual(
        discoverPublicCapabilityBindings(sourceFiles),
        expectedPublicCapabilityBindings,
        'repository-wide MAX shadow capability consumer denominator changed',
    )
}

const legacyPublicSource = read(legacyPublicPath)
assertLegacyPublicBoundary(legacyPublicSource)
assert.doesNotMatch(legacyPublicSource, /compareContactResolution|isMaxContactResolutionShadowEnabled|Dependencies|\bprisma\b|export \*/)
const unrelatedCapabilityProbe = legacyPublicSource.replace(
    /\n\}\)\n$/,
    "\n    compare: (plan, outcome) => compareContactResolution(plan, outcome),\n})\n",
)
assert.notDeepEqual(capabilityKeys(unrelatedCapabilityProbe), exactCapabilities)

const consumer = read(consumerPath)
const publicBarrel = read(publicBarrelPath)
const application = read(applicationPath)
const internal = read(internalPath)
assertConsumerBoundary(consumer)
assertBarrelBoundary(publicBarrel)
assertApplicationBoundary(application)
assertInternalBoundary(internal)
assertPublicCapabilityDenominator()

rejectProbe(
    consumer,
    consumer.replace(publicBarrelSpecifier, '@/modules/contacts/public/v1/max-contact-resolution-shadow'),
    assertConsumerBoundary,
)
rejectProbe(
    consumer,
    consumer.replace('startMaxContactResolutionShadowV1({', 'maxContactResolutionShadowV1.start({'),
    assertConsumerBoundary,
)
rejectProbe(
    publicBarrel,
    publicBarrel.replace(applicationSpecifier, '../internal/external-contact-operations'),
    assertBarrelBoundary,
)
rejectProbe(
    application,
    application.replace(internalSpecifier, implementationSpecifier),
    assertApplicationBoundary,
)

const commentedCallProbe = consumer.replace(
    'const maxContactResolutionShadow = await startMaxContactResolutionShadowV1({',
    'const maxContactResolutionShadow = await disabledShadowStart({ // startMaxContactResolutionShadowV1({',
)
rejectProbe(consumer, commentedCallProbe, assertConsumerBoundary)
const deadCallProbe = consumer.replace(
    'const maxContactResolutionShadow = await startMaxContactResolutionShadowV1({',
    'if (false) { void startMaxContactResolutionShadowV1({}) }\n    const maxContactResolutionShadow = await disabledShadowStart({',
)
rejectProbe(consumer, deadCallProbe, assertConsumerBoundary)
const shadowCallProbe = consumer.replace(
    'const maxContactResolutionShadow = await startMaxContactResolutionShadowV1({',
    'const shadowProbe = async (startMaxContactResolutionShadowV1: (input: never) => Promise<unknown>) => {\n'
        + '      const maxContactResolutionShadow = await startMaxContactResolutionShadowV1({} as never)\n'
        + '      return maxContactResolutionShadow\n'
        + '    }\n'
        + '    void shadowProbe\n'
        + '    const maxContactResolutionShadow = await disabledShadowStart({',
)
rejectProbe(consumer, shadowCallProbe, assertConsumerBoundary)
const aliasProbe = consumer
    .replace('startMaxContactResolutionShadowV1,', 'startMaxContactResolutionShadowV1 as startShadowV1,')
    .replace('await startMaxContactResolutionShadowV1({', 'await startShadowV1({')
rejectProbe(consumer, aliasProbe, assertConsumerBoundary)
const namespaceProbe = `${consumer}\nimport * as contactsBoundaryProbe from '${publicBarrelSpecifier}'\nvoid contactsBoundaryProbe\n`
const namespaceSources = new Map(baseSources)
namespaceSources.set(consumerPath, namespaceProbe)
assert.throws(() => assertPublicCapabilityDenominator(namespaceSources))
rejectProbe(
    application,
    application.replace('startMaxContactResolutionShadow(input)', 'Promise.resolve(input as never)'),
    assertApplicationBoundary,
)
rejectProbe(
    internal,
    internal.replace('startShadow(input)', 'Promise.resolve(input as never)'),
    assertInternalBoundary,
)
const extraConsumerPath = 'gravity-mvp/src/__architecture_probe__/extra-max-shadow-consumer.ts'
const extraConsumerSources = new Map(baseSources)
extraConsumerSources.set(
    extraConsumerPath,
    `import { startMaxContactResolutionShadowV1 as startShadow } from '${publicBarrelSpecifier}'\nvoid startShadow\n`,
)
assert.throws(() => assertPublicCapabilityDenominator(extraConsumerSources))
const rawBypassSources = new Map(baseSources)
rawBypassSources.set(
    'gravity-mvp/src/__architecture_probe__/raw-max-shadow-consumer.ts',
    `import { ${rawCapability} as startRawShadow } from '${implementationSpecifier}'\nvoid startRawShadow\n`,
)
assert.throws(() => assertPublicCapabilityDenominator(rawBypassSources))

const contactsManifest = JSON.parse(read('architecture/contexts/v1/manifests/contacts.json'))
const maxManifest = JSON.parse(read('architecture/contexts/v1/manifests/max_channel.json'))
assert(contactsManifest.public_surface.includes('MaxContactResolutionShadow.v1'))
assert(maxManifest.allowed_dependencies.some((dependency) => (
    dependency.context === 'contacts' && dependency.surface === 'contacts.public'
)))

const scan = await scanArchitecture(root)
const forbiddenConsumerTargets = new Set([
    implementationPath,
    typesPath,
    legacyPublicPath,
    applicationPath,
    internalPath,
])
assert.deepEqual(scan.findings.filter((finding) => (
    finding.file === consumerPath && forbiddenConsumerTargets.has(finding.details?.target)
)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    runtime_consumers: 1,
    shadow_capabilities: exactCapabilities.length,
    negative_unrelated_capability_probe: 'REJECTED',
    negative_boundary_bypass_probes: 11,
    public_composition: 'BARREL_TO_APPLICATION_TO_INTERNAL',
    dependency_cycle: 'ABSENT',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
