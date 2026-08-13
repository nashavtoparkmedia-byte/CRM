#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

import {
    extractImports,
    extractUnsafeApplicationCompositionExports,
    scanArchitecture,
} from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPath = 'gravity-mvp/src/lib/contacts/yandex-link.ts'
const legacyPublicPath = 'gravity-mvp/src/modules/contacts/public/v1/yandex-driver-contact-link.ts'
const internalPath = 'gravity-mvp/src/modules/contacts/internal/external-contact-operations.ts'
const applicationPath = 'gravity-mvp/src/modules/contacts/application/contact-external-operations.ts'
const publicBarrelPath = 'gravity-mvp/src/modules/contacts/public/v1/index.ts'
const publicAggregatorPath = 'gravity-mvp/src/modules/contacts/public/index.ts'
const moduleIndexPath = 'gravity-mvp/src/modules/contacts/index.ts'
const consumerPath = 'gravity-mvp/src/app/drivers/actions.ts'
const publicSpecifier = '@/modules/contacts/public/v1'
const applicationSpecifier = '../../application/contact-external-operations'
const internalSpecifier = '../internal/external-contact-operations'
const implementationSpecifier = '@/lib/contacts/yandex-link'
const exactApplicationCapabilities = [
    'linkContactToBestDriverV1',
    'startMaxContactResolutionShadowV1',
]
const exactInternalCapabilities = [
    'linkContactToBestDriver',
    'startMaxContactResolutionShadow',
]

assert.equal(sha256(read(implementationPath)), 'a0ac8711a602ec8f6b7bbf3839afbf8ccb55cf6eccfd9e79d749012363a18018')

function exactBindings(source, { kind, specifier, imported, local = imported }) {
    return extractImports(source).flatMap((entry) => (
        entry.kind === kind && entry.specifier === specifier
            ? entry.imports.filter((binding) => binding.imported === imported && binding.local === local)
            : []
    ))
}

function assertExactBinding(source, expected) {
    const matches = extractImports(source).flatMap((entry) => entry.imports
        .filter((binding) => binding.imported === expected.imported)
        .map((binding) => ({
            kind: entry.kind,
            specifier: entry.specifier,
            bindingKind: binding.kind,
            imported: binding.imported,
            local: binding.local,
        })))
    assert.deepEqual(matches, [{
        kind: expected.kind,
        specifier: expected.specifier,
        bindingKind: 'named',
        imported: expected.imported,
        local: expected.local ?? expected.imported,
    }])
}

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
const unwrap = (node) => {
    let current = node
    while (current && ts.isParenthesizedExpression(current)) current = current.expression
    return current
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
const identifierCalls = (sourceFile, name) => {
    const calls = []
    visit(sourceFile, (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(unwrap(node.expression)) && unwrap(node.expression).text === name) {
            calls.push(node)
        }
    })
    return calls
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
    const calls = []
    visit(sourceFile, (node) => {
        if (!ts.isIdentifier(node) || node.text !== name) return
        if (ts.isImportSpecifier(node.parent) && node.parent.name === node) return
        if ((ts.isPropertyAssignment(node.parent) || ts.isMethodDeclaration(node.parent)) && node.parent.name === node) return
        const call = directCallForIdentifier(node)
        assert(call, `${sourceFile.fileName}: ${name} must not be shadowed, copied, or referenced indirectly`)
        assert.equal(syntacticallyDead(call), false, `${sourceFile.fileName}: ${name} call is syntactically dead`)
        calls.push(call)
    })
    assert.equal(calls.length, count, `${sourceFile.fileName}: ${name} executable direct-call count`)
    if (awaited) assert(calls.every((call) => ts.isAwaitExpression(call.parent)), `${sourceFile.fileName}: ${name} calls must be awaited`)
    if (owner) assert(calls.every((call) => enclosingFunctionName(call) === owner), `${sourceFile.fileName}: ${name} calls must stay in ${owner}`)
    return calls
}

function exportedFunctionValues(source, file = 'probe.ts') {
    return parse(file, source).statements.flatMap((statement) => {
        if (ts.isVariableStatement(statement)
            && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
            return statement.declarationList.declarations.flatMap((declaration) => (
                ts.isIdentifier(declaration.name) ? [declaration.name.text] : []
            ))
        }
        if (ts.isFunctionDeclaration(statement)
            && statement.name
            && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
            return [statement.name.text]
        }
        return []
    }).sort()
}

function assertDirectDelegate(source, file, exportedName, target, parameter) {
    const sourceFile = parse(file, source)
    const declarations = sourceFile.statements.flatMap((statement) => (
        ts.isVariableStatement(statement)
        && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        && (statement.declarationList.flags & ts.NodeFlags.Const)
            ? statement.declarationList.declarations.filter((declaration) => (
                ts.isIdentifier(declaration.name) && declaration.name.text === exportedName
            ))
            : []
    ))
    assert.equal(declarations.length, 1, `${file}: ${exportedName} exact exported const`)
    const initializer = unwrap(declarations[0].initializer)
    assert(initializer && ts.isArrowFunction(initializer), `${file}: ${exportedName} arrow wrapper`)
    assert.equal(initializer.parameters.length, 1)
    assert(ts.isIdentifier(initializer.parameters[0].name) && initializer.parameters[0].name.text === parameter)
    const body = unwrap(initializer.body)
    assert(ts.isCallExpression(body), `${file}: ${exportedName} direct call return`)
    assert(ts.isIdentifier(body.expression) && body.expression.text === target)
    assert.deepEqual(body.arguments.map((argument) => argument.getText(sourceFile)), [parameter])
    assertImportedDirectCalls(sourceFile, target, { count: 1 })
    assert.equal(syntacticallyDead(body), false)
}

function assertLegacyPublicBoundary(source) {
    assertExactBinding(source, {
        kind: 'static',
        specifier: implementationSpecifier,
        imported: 'linkContactToBestDriver',
    })
    const sourceFile = parse(legacyPublicPath, source)
    const declarations = sourceFile.statements.flatMap((statement) => (
        ts.isVariableStatement(statement)
        && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        && (statement.declarationList.flags & ts.NodeFlags.Const)
            ? statement.declarationList.declarations.filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'yandexDriverContactLinkV1')
            : []
    ))
    assert.equal(declarations.length, 1)
    const freeze = unwrap(declarations[0].initializer)
    assert(freeze && ts.isCallExpression(freeze) && freeze.expression.getText(sourceFile) === 'Object.freeze' && freeze.arguments.length === 1)
    const object = unwrap(freeze.arguments[0])
    assert(object && ts.isObjectLiteralExpression(object) && object.properties.length === 1)
    const property = object.properties[0]
    assert(ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === 'linkContactToBestDriver')
    const wrapper = unwrap(property.initializer)
    assert(wrapper && ts.isArrowFunction(wrapper) && wrapper.parameters.length === 1)
    assert(ts.isIdentifier(wrapper.parameters[0].name) && wrapper.parameters[0].name.text === 'phone')
    const body = unwrap(wrapper.body)
    assert(body && ts.isCallExpression(body) && ts.isIdentifier(body.expression) && body.expression.text === 'linkContactToBestDriver')
    assert.deepEqual(body.arguments.map((argument) => argument.getText(sourceFile)), ['phone'])
    assertImportedDirectCalls(sourceFile, 'linkContactToBestDriver', { count: 1 })
}

const internalSource = read(internalPath)
assert.deepEqual(extractUnsafeApplicationCompositionExports(internalSource), [])
assert.deepEqual(exportedFunctionValues(internalSource, internalPath), exactInternalCapabilities)
assertExactBinding(internalSource, {
    kind: 'static',
    specifier: implementationSpecifier,
    imported: 'linkContactToBestDriver',
    local: 'linkDriver',
})
assertDirectDelegate(internalSource, internalPath, 'linkContactToBestDriver', 'linkDriver', 'phone')
assert.doesNotMatch(internalSource, /\bprisma\b|Object\.freeze|export \*/)

const applicationSource = read(applicationPath)
assert.deepEqual(extractUnsafeApplicationCompositionExports(applicationSource), [])
assert.deepEqual(exportedFunctionValues(applicationSource, applicationPath), exactApplicationCapabilities)
assertExactBinding(applicationSource, {
    kind: 'static',
    specifier: internalSpecifier,
    imported: 'linkContactToBestDriver',
})
assertDirectDelegate(applicationSource, applicationPath, 'linkContactToBestDriverV1', 'linkContactToBestDriver', 'phone')
assert.doesNotMatch(applicationSource, /@\/lib\/contacts\/yandex-link|\bprisma\b|Object\.freeze|export \*/)

const publicBarrelSource = read(publicBarrelPath)
assertExactBinding(publicBarrelSource, {
    kind: 'export',
    specifier: applicationSpecifier,
    imported: 'linkContactToBestDriverV1',
})
assert.doesNotMatch(publicBarrelSource, /yandex-driver-contact-link|yandexDriverContactLinkV1|export \*/)

const consumer = read(consumerPath)
function assertConsumerBoundary(source) {
    assertExactBinding(source, {
        kind: 'static',
        specifier: publicSpecifier,
        imported: 'linkContactToBestDriverV1',
    })
    const sourceFile = parse(consumerPath, source)
    const calls = assertImportedDirectCalls(sourceFile, 'linkContactToBestDriverV1', {
        count: 1,
        awaited: true,
        owner: 'syncDriversByStatuses',
    })
    assert.deepEqual(calls[0].arguments.map((argument) => argument.getText(sourceFile)), ['phone'])
    assert.equal(syntacticallyDead(calls[0]), false)
    assert.equal(extractImports(source).some((entry) => entry.specifier.startsWith(`${publicSpecifier}/`)), false)
    assert.doesNotMatch(source, /@\/lib\/contacts\/yandex-link|@\/modules\/contacts\/(?:application|internal)(?:\/|['"])|yandexDriverContactLinkV1/)
}
assertConsumerBoundary(consumer)

const legacyPublicSource = read(legacyPublicPath)
assertLegacyPublicBoundary(legacyPublicSource)

const deepImportProbe = consumer.replace(publicSpecifier, `${publicSpecifier}/yandex-driver-contact-link`)
assert.throws(() => assertConsumerBoundary(deepImportProbe))
const skippedApplicationProbe = publicBarrelSource.replace(applicationSpecifier, '../internal/external-contact-operations')
assert.equal(exactBindings(skippedApplicationProbe, {
    kind: 'export',
    specifier: applicationSpecifier,
    imported: 'linkContactToBestDriverV1',
}).length, 0)
const widenedApplicationProbe = `${applicationSource}\nexport const updateContactV1 = (contactId: string) => contactId\n`
assert.notDeepEqual(exportedFunctionValues(widenedApplicationProbe), exactApplicationCapabilities)

const allSourcePaths = walk(path.join(root, 'gravity-mvp/src'))
    .map(relative)
    .filter((file) => !/(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))
const baseSources = new Map(allSourcePaths.map((file) => [file, read(file)]))
const rawCapability = 'linkContactToBestDriver'
const publicCapability = 'linkContactToBestDriverV1'
const legacyCapability = 'yandexDriverContactLinkV1'
const capabilityNames = new Set([rawCapability, publicCapability, legacyCapability])
const expectedCapabilityBindings = [
    {
        file: moduleIndexPath,
        kind: 'export',
        specifier: './public',
        imported: '*',
        local: '*',
    },
    {
        file: legacyPublicPath,
        kind: 'static',
        specifier: implementationSpecifier,
        imported: rawCapability,
        local: rawCapability,
    },
    {
        file: internalPath,
        kind: 'static',
        specifier: implementationSpecifier,
        imported: rawCapability,
        local: 'linkDriver',
    },
    {
        file: applicationPath,
        kind: 'static',
        specifier: internalSpecifier,
        imported: rawCapability,
        local: rawCapability,
    },
    {
        file: consumerPath,
        kind: 'static',
        specifier: publicSpecifier,
        imported: publicCapability,
        local: publicCapability,
    },
    {
        file: publicBarrelPath,
        kind: 'export',
        specifier: applicationSpecifier,
        imported: publicCapability,
        local: publicCapability,
    },
    {
        file: publicAggregatorPath,
        kind: 'export',
        specifier: './v1',
        imported: '*',
        local: '*',
    },
].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))

const withoutModuleSuffix = (value) => value.replace(/\.(?:[cm]?[jt]sx?)$/, '').replace(/\/index$/, '')
const resolveModule = (file, specifier) => {
    if (specifier.startsWith('@/')) return withoutModuleSuffix(`gravity-mvp/src/${specifier.slice(2)}`)
    if (specifier.startsWith('.')) return withoutModuleSuffix(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)))
    return specifier
}
const governedModule = (file, specifier) => {
    const resolved = resolveModule(file, specifier)
    const publicDirectory = withoutModuleSuffix(path.posix.dirname(publicBarrelPath))
    return resolved === withoutModuleSuffix(implementationPath)
        || resolved === withoutModuleSuffix(internalPath)
        || resolved === withoutModuleSuffix(applicationPath)
        || resolved === withoutModuleSuffix(legacyPublicPath)
        || resolved === publicDirectory
        || resolved === withoutModuleSuffix(path.posix.dirname(publicAggregatorPath))
        || resolved.startsWith(`${publicDirectory}/yandex-driver-contact-link`)
}
const dynamicCapabilityBindings = (source, file) => {
    const sourceFile = parse(file, source)
    const records = []
    visit(sourceFile, node => {
        if (!ts.isCallExpression(node)
            || node.expression.kind !== ts.SyntaxKind.ImportKeyword
            || node.arguments.length !== 1
            || !ts.isStringLiteralLike(node.arguments[0])
            || !governedModule(file, node.arguments[0].text)) return
        const parent = node.parent
        const declaration = ts.isAwaitExpression(parent)
            && ts.isVariableDeclaration(parent.parent)
            && parent.parent.initializer === parent
            ? parent.parent
            : null
        if (declaration && ts.isObjectBindingPattern(declaration.name)) {
            for (const element of declaration.name.elements) {
                if (!ts.isIdentifier(element.name)) continue
                const imported = element.propertyName?.getText(sourceFile) ?? element.name.text
                if (capabilityNames.has(imported)) {
                    records.push({ file, kind: 'dynamic', specifier: node.arguments[0].text, imported, local: element.name.text })
                }
            }
            return
        }
        records.push({ file, kind: 'dynamic', specifier: node.arguments[0].text, imported: '*', local: '*' })
    })
    return records
}

function discoverCapabilityBindings(sources = baseSources) {
    return [...sources].flatMap(([file, source]) => [...extractImports(source).flatMap((entry) => {
        const named = entry.imports
            .filter((binding) => capabilityNames.has(binding.imported))
            .map((binding) => ({
                file,
                kind: entry.kind,
                specifier: entry.specifier,
                imported: binding.imported,
                local: binding.local,
            }))
        const wildcard = governedModule(file, entry.specifier)
            && (entry.imports.some((binding) => binding.kind !== 'named')
                || (entry.imports.length === 0 && entry.kind !== 'static' && entry.kind !== 'dynamic'))
            ? [{ file, kind: entry.kind, specifier: entry.specifier, imported: '*', local: '*' }]
            : []
        return [...named, ...wildcard]
    }), ...dynamicCapabilityBindings(source, file)]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function assertCapabilityDenominator(sources = baseSources) {
    assert.deepEqual(
        discoverCapabilityBindings(sources),
        expectedCapabilityBindings,
        'repository-wide Yandex contact-link capability consumer denominator changed',
    )
}
assertCapabilityDenominator()

const commentedCallProbe = consumer.replace(
    'await linkContactToBestDriverV1(phone)',
    'await disabledLinkContact(phone) // await linkContactToBestDriverV1(phone)',
)
assert.notEqual(commentedCallProbe, consumer)
assert.throws(() => assertConsumerBoundary(commentedCallProbe))
const removedCallProbe = consumer.replace(
    'await linkContactToBestDriverV1(phone)',
    'await disabledLinkContact(phone)',
)
const deadCallProbe = `${removedCallProbe}\nif (false) { await linkContactToBestDriverV1(phone) }\n`
assert.throws(() => assertConsumerBoundary(deadCallProbe))
const shadowCallProbe = consumer.replace(
    'await linkContactToBestDriverV1(phone)',
    'const shadowProbe = async (linkContactToBestDriverV1: (value: string) => Promise<void>) => { await linkContactToBestDriverV1(phone) }\n'
        + '                        void shadowProbe\n'
        + '                        await disabledLinkContact(phone)',
)
assert.notEqual(shadowCallProbe, consumer)
assert.throws(() => assertConsumerBoundary(shadowCallProbe))
const aliasProbe = consumer
    .replace('import { linkContactToBestDriverV1 }', 'import { linkContactToBestDriverV1 as linkDriverV1 }')
    .replace('await linkContactToBestDriverV1(phone)', 'await linkDriverV1(phone)')
assert.notEqual(aliasProbe, consumer)
assert.throws(() => assertConsumerBoundary(aliasProbe))
const namespaceProbe = `${consumer}\nimport * as contactsBoundaryProbe from '${publicSpecifier}'\nvoid contactsBoundaryProbe\n`
const namespaceSources = new Map(baseSources)
namespaceSources.set(consumerPath, namespaceProbe)
assert.throws(() => assertCapabilityDenominator(namespaceSources))
const noOpApplicationProbe = applicationSource.replace(
    'linkContactToBestDriver(phone)',
    'Promise.resolve(phone as never)',
)
assert.notEqual(noOpApplicationProbe, applicationSource)
assert.throws(() => assertDirectDelegate(noOpApplicationProbe, applicationPath, 'linkContactToBestDriverV1', 'linkContactToBestDriver', 'phone'))
const noOpInternalProbe = internalSource.replace('linkDriver(phone)', 'Promise.resolve(phone as never)')
assert.notEqual(noOpInternalProbe, internalSource)
assert.throws(() => assertDirectDelegate(noOpInternalProbe, internalPath, 'linkContactToBestDriver', 'linkDriver', 'phone'))
const noOpLegacyProbe = legacyPublicSource.replace('linkContactToBestDriver(phone)', 'Promise.resolve(phone as never)')
assert.notEqual(noOpLegacyProbe, legacyPublicSource)
assert.throws(() => assertLegacyPublicBoundary(noOpLegacyProbe))
const extraConsumerSources = new Map(baseSources)
extraConsumerSources.set(
    'gravity-mvp/src/__architecture_probe__/extra-yandex-link-consumer.ts',
    `import { linkContactToBestDriverV1 as linkDriver } from '${publicSpecifier}'\nvoid linkDriver\n`,
)
assert.throws(() => assertCapabilityDenominator(extraConsumerSources))
const rawBypassSources = new Map(baseSources)
rawBypassSources.set(
    'gravity-mvp/src/__architecture_probe__/raw-yandex-link-consumer.ts',
    `import { ${rawCapability} as linkDriver } from '${implementationSpecifier}'\nvoid linkDriver\n`,
)
assert.throws(() => assertCapabilityDenominator(rawBypassSources))
const legacyDeepConsumerSources = new Map(baseSources)
legacyDeepConsumerSources.set(
    'gravity-mvp/src/__architecture_probe__/legacy-yandex-link-consumer.ts',
    `import { ${legacyCapability} as linkDriver } from '@/modules/contacts/public/v1/yandex-driver-contact-link'\nvoid linkDriver\n`,
)
assert.throws(() => assertCapabilityDenominator(legacyDeepConsumerSources))

const contactsManifest = JSON.parse(read('architecture/contexts/v1/manifests/contacts.json'))
const fleetManifest = JSON.parse(read('architecture/contexts/v1/manifests/fleet_operations.json'))
assert(contactsManifest.public_surface.includes('YandexDriverContactLink.v1'))
assert(fleetManifest.allowed_dependencies.some((dependency) => (
    dependency.context === 'contacts' && dependency.surface === 'contacts.public'
)))

const scan = await scanArchitecture(root)
const chainPaths = new Set([consumerPath, publicBarrelPath, applicationPath, internalPath])
assert.deepEqual(scan.findings.filter((finding) => chainPaths.has(finding.file)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    runtime_consumers: 1,
    public_entrypoint: publicSpecifier,
    application_capabilities: exactApplicationCapabilities.length,
    yandex_link_capabilities: 1,
    negative_deep_import_probe: 'REJECTED',
    negative_skipped_application_probe: 'REJECTED',
    negative_capability_widening_probe: 'REJECTED',
    adversarial_boundary_probes: 12,
    dependency_cycle: 'ABSENT',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
