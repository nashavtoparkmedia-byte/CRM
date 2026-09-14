#!/usr/bin/env node

import assert from 'node:assert/strict'
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
const implementationPath = 'gravity-mvp/src/lib/contacts/yandex-link.ts'
const handlerPath = 'gravity-mvp/src/modules/contacts/public/v1/yandex-driver-contact-link.ts'
const portPath = 'gravity-mvp/src/modules/contacts/internal/yandex-driver-contact-link-port.ts'
const internalPath = 'gravity-mvp/src/modules/contacts/internal/external-contact-operations.ts'
const applicationPath = 'gravity-mvp/src/modules/contacts/application/contact-external-operations.ts'
const publicBarrelPath = 'gravity-mvp/src/modules/contacts/public/v1/index.ts'
const publicAggregatorPath = 'gravity-mvp/src/modules/contacts/public/index.ts'
const moduleIndexPath = 'gravity-mvp/src/modules/contacts/index.ts'
const consumerPath = 'gravity-mvp/src/app/drivers/actions.ts'
const publicSpecifier = '@/modules/contacts/public/v1'
const applicationSpecifier = '../../application/contact-external-operations'
const handlerSpecifier = '../public/v1/yandex-driver-contact-link'
const portSpecifier = '../internal/yandex-driver-contact-link-port'
const implementationSpecifier = '@/lib/contacts/yandex-link'
const coordinatorSpecifier = '@/modules/contacts/internal/contact-ownership-coordinator'
const exactApplicationCapabilities = [
    'linkContactToBestDriverV1',
    'startMaxContactResolutionShadowV1',
]
const exactInternalCapabilities = [
    'startMaxContactResolutionShadow',
]

function exactBindings(source, { kind, specifier, imported, local = imported, typeOnly = false }) {
    return extractImports(source).flatMap((entry) => (
        entry.kind === kind && entry.specifier === specifier
            ? (typeOnly ? entry.typeImports ?? [] : entry.imports)
                .filter((binding) => binding.imported === imported && binding.local === local)
            : []
    ))
}

function assertExactBinding(source, expected) {
    const matches = extractImports(source).flatMap((entry) => [
        ...entry.imports.map((binding) => ({ ...binding, typeOnly: false })),
        ...(entry.typeImports ?? []).map((binding) => ({ ...binding, typeOnly: true })),
    ]
        .filter((binding) => binding.imported === expected.imported)
        .map((binding) => ({
            kind: entry.kind,
            specifier: entry.specifier,
            bindingKind: binding.kind,
            imported: binding.imported,
            local: binding.local,
            typeOnly: binding.typeOnly,
        })))
    assert.deepEqual(matches, [{
        kind: expected.kind,
        specifier: expected.specifier,
        bindingKind: 'named',
        imported: expected.imported,
        local: expected.local ?? expected.imported,
        typeOnly: Boolean(expected.typeOnly),
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
    while (current && (
        ts.isParenthesizedExpression(current)
        || ts.isAsExpression(current)
        || ts.isTypeAssertionExpression(current)
        || ts.isNonNullExpression(current)
        || (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(current))
    )) current = current.expression
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
const checkedSource = (file, source) => {
    const virtualPath = path.join(root, file)
    const options = { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, noResolve: true }
    const host = ts.createCompilerHost(options)
    const originalGetSourceFile = host.getSourceFile.bind(host)
    host.getSourceFile = (fileName, languageVersion, ...rest) => (
        path.resolve(fileName) === path.resolve(virtualPath)
            ? ts.createSourceFile(virtualPath, source, languageVersion, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
            : originalGetSourceFile(fileName, languageVersion, ...rest)
    )
    host.fileExists = (fileName) => path.resolve(fileName) === path.resolve(virtualPath)
    host.readFile = (fileName) => path.resolve(fileName) === path.resolve(virtualPath) ? source : undefined
    const program = ts.createProgram([virtualPath], options, host)
    const sourceFile = program.getSourceFile(virtualPath)
    assert(sourceFile, `${file}: unable to create TypeScript source model`)
    assert.equal(program.getSyntacticDiagnostics(sourceFile).length, 0, `${file}: TypeScript syntactic diagnostics`)
    return { sourceFile, checker: program.getTypeChecker() }
}
const UNKNOWN_CONSTANT = Symbol('unknown-constant')
const primitiveConstant = (expression, checker, seen = new Set()) => {
    const node = unwrap(expression)
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true
    if (node.kind === ts.SyntaxKind.NullKeyword) return null
    if (ts.isStringLiteralLike(node)) return node.text
    if (ts.isNumericLiteral(node)) return Number(node.text)
    if (ts.isIdentifier(node)) {
        if (node.text === 'undefined') return undefined
        const symbol = checker?.getSymbolAtLocation(node)
        if (!symbol || seen.has(symbol)) return UNKNOWN_CONSTANT
        const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
        if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return UNKNOWN_CONSTANT
        const declarationList = declaration.parent
        if (!ts.isVariableDeclarationList(declarationList) || !(declarationList.flags & ts.NodeFlags.Const)) return UNKNOWN_CONSTANT
        seen.add(symbol)
        const value = primitiveConstant(declaration.initializer, checker, seen)
        seen.delete(symbol)
        return value
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
        const operand = primitiveConstant(node.operand, checker, seen)
        return operand === UNKNOWN_CONSTANT ? UNKNOWN_CONSTANT : !operand
    }
    if (!ts.isBinaryExpression(node)) return UNKNOWN_CONSTANT
    const left = primitiveConstant(node.left, checker, seen)
    if (left === UNKNOWN_CONSTANT) return UNKNOWN_CONSTANT
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && !left) return left
    if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken && left) return left
    const right = primitiveConstant(node.right, checker, seen)
    if (right === UNKNOWN_CONSTANT) return UNKNOWN_CONSTANT
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        || node.operatorToken.kind === ts.SyntaxKind.BarBarToken) return right
    return UNKNOWN_CONSTANT
}
const statementAlwaysTerminates = (statement, checker) => {
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true
    if (ts.isBlock(statement)) return statement.statements.some((child) => statementAlwaysTerminates(child, checker))
    if (ts.isIfStatement(statement)) {
        const condition = primitiveConstant(statement.expression, checker)
        if (condition !== UNKNOWN_CONSTANT) {
            return condition
                ? statementAlwaysTerminates(statement.thenStatement, checker)
                : Boolean(statement.elseStatement && statementAlwaysTerminates(statement.elseStatement, checker))
        }
        return Boolean(statement.elseStatement
            && statementAlwaysTerminates(statement.thenStatement, checker)
            && statementAlwaysTerminates(statement.elseStatement, checker))
    }
    return false
}
const followsUnconditionalTerminator = (node, checker) => {
    for (let child = node, current = node.parent; current; child = current, current = current.parent) {
        const statements = ts.isBlock(current) || ts.isSourceFile(current) ? current.statements : undefined
        if (!statements) continue
        const directChild = statements.find((statement) => statement === child || (
            statement.pos <= child.pos && statement.end >= child.end
        ))
        const index = directChild ? statements.indexOf(directChild) : -1
        if (index > 0 && statements.slice(0, index).some((statement) => statementAlwaysTerminates(statement, checker))) return true
    }
    return false
}
const syntacticallyDead = (node, checker = null) => {
    for (let child = node, current = node.parent; current; child = current, current = current.parent) {
        if (ts.isIfStatement(current)) {
            const condition = primitiveConstant(current.expression, checker)
            if (condition !== UNKNOWN_CONSTANT) {
                if (!condition && child === current.thenStatement) return true
                if (condition && child === current.elseStatement) return true
            }
        }
        if (ts.isWhileStatement(current) || ts.isForStatement(current) || ts.isDoStatement(current)) {
            const conditionExpression = ts.isForStatement(current) ? current.condition : current.expression
            if (conditionExpression) {
                const condition = primitiveConstant(conditionExpression, checker)
                if (condition !== UNKNOWN_CONSTANT && !condition) return true
            }
        }
        if (ts.isConditionalExpression(current)) {
            const condition = primitiveConstant(current.condition, checker)
            if (condition !== UNKNOWN_CONSTANT) {
                if (!condition && child === current.whenTrue) return true
                if (condition && child === current.whenFalse) return true
            }
        }
        if (ts.isBinaryExpression(current) && child === current.right) {
            const left = primitiveConstant(current.left, checker)
            if (left === UNKNOWN_CONSTANT) continue
            if (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && !left) return true
            if (current.operatorToken.kind === ts.SyntaxKind.BarBarToken && left) return true
        }
    }
    return followsUnconditionalTerminator(node, checker)
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
const assertImportedDirectCalls = (sourceFile, name, { count, awaited = false, owner = null, checker = null }) => {
    const calls = []
    visit(sourceFile, (node) => {
        if (!ts.isIdentifier(node) || node.text !== name) return
        if (ts.isImportSpecifier(node.parent) && node.parent.name === node) return
        if ((ts.isPropertyAssignment(node.parent) || ts.isMethodDeclaration(node.parent)) && node.parent.name === node) return
        const call = directCallForIdentifier(node)
        assert(call, `${sourceFile.fileName}: ${name} must not be shadowed, copied, or referenced indirectly`)
        assert.equal(syntacticallyDead(call, checker), false, `${sourceFile.fileName}: ${name} call is syntactically dead`)
        calls.push(call)
    })
    assert.equal(calls.length, count, `${sourceFile.fileName}: ${name} executable direct-call count`)
    if (awaited) assert(calls.every((call) => ts.isAwaitExpression(call.parent)), `${sourceFile.fileName}: ${name} calls must be awaited`)
    if (owner) assert(calls.every((call) => enclosingFunctionName(call) === owner), `${sourceFile.fileName}: ${name} calls must stay in ${owner}`)
    return calls
}

const assertLocalDirectCalls = (sourceFile, name, count) => {
    const calls = []
    visit(sourceFile, (node) => {
        if (!ts.isIdentifier(node) || node.text !== name) return
        if (ts.isVariableDeclaration(node.parent) && node.parent.name === node) return
        const call = directCallForIdentifier(node)
        assert(call, `${sourceFile.fileName}: ${name} local delegate must not be copied or referenced indirectly`)
        assert.equal(syntacticallyDead(call), false, `${sourceFile.fileName}: ${name} local delegate call is syntactically dead`)
        calls.push(call)
    })
    assert.equal(calls.length, count, `${sourceFile.fileName}: ${name} local direct-call count`)
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

const exportedConst = (sourceFile, name) => sourceFile.statements.flatMap((statement) => {
    if (!ts.isVariableStatement(statement)
        || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        || !(statement.declarationList.flags & ts.NodeFlags.Const)) return []
    return statement.declarationList.declarations.filter((declaration) => (
        ts.isIdentifier(declaration.name) && declaration.name.text === name
    ))
})

const exportedInterfaces = (sourceFile) => sourceFile.statements.flatMap((statement) => (
    ts.isInterfaceDeclaration(statement)
    && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        ? [statement]
        : []
))

const exactImportedLocalIdentifier = (sourceFile, specifier, imported) => {
    const bindings = sourceFile.statements.flatMap((statement) => {
        if (!ts.isImportDeclaration(statement)
            || !ts.isStringLiteralLike(statement.moduleSpecifier)
            || statement.moduleSpecifier.text !== specifier
            || !statement.importClause?.namedBindings
            || !ts.isNamedImports(statement.importClause.namedBindings)) return []
        return statement.importClause.namedBindings.elements.filter((element) => (
            (element.propertyName?.text ?? element.name.text) === imported
        )).map((element) => element.name)
    })
    assert.equal(bindings.length, 1, `${sourceFile.fileName}: exact ${imported} local import binding`)
    return bindings[0]
}

const assertExactIdentifierReferences = (sourceFile, name, expected) => {
    const references = []
    visit(sourceFile, (node) => {
        if (ts.isIdentifier(node) && node.text === name) references.push(node)
    })
    const orderedExpected = [...expected].sort((left, right) => left.getStart(sourceFile) - right.getStart(sourceFile))
    assert.equal(references.length, orderedExpected.length, `${sourceFile.fileName}: ${name} exact reference count`)
    references.forEach((reference, index) => {
        assert.equal(reference, orderedExpected[index], `${sourceFile.fileName}: ${name} unexpected reference`)
    })
}

const assertNoLocalAliasExports = (sourceFile) => {
    assert.equal(
        sourceFile.statements.filter((statement) => ts.isExportDeclaration(statement)).length,
        0,
        `${sourceFile.fileName}: local aliases and re-exports are forbidden`,
    )
}

function assertDirectDelegate(source, file, exportedName, target, parameter, targetBinding = 'imported') {
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
    assert.equal(initializer.parameters[0].type?.getText(sourceFile), 'string | null | undefined')
    assert.equal(initializer.type?.getText(sourceFile), 'Promise<YandexDriverContactLinkResultV1>')
    const body = unwrap(initializer.body)
    assert(ts.isCallExpression(body), `${file}: ${exportedName} direct call return`)
    assert(ts.isIdentifier(body.expression) && body.expression.text === target)
    assert.deepEqual(body.arguments.map((argument) => argument.getText(sourceFile)), [parameter])
    if (targetBinding === 'imported') {
        assertImportedDirectCalls(sourceFile, target, { count: 1 })
    } else {
        assert.equal(targetBinding, 'local')
        assertLocalDirectCalls(sourceFile, target, 1)
    }
    assert.equal(syntacticallyDead(body), false)
}

function assertImplementationBoundary(source) {
    for (const imported of [
        'assertContactOwnershipPostconditions',
        'lockContactOwnershipRows',
        'runContactOwnershipTransaction',
    ]) {
        assertExactBinding(source, {
            kind: 'static',
            specifier: coordinatorSpecifier,
            imported,
        })
    }
    assertExactBinding(source, {
        kind: 'static',
        specifier: '@/modules/contacts/public/v1/phone-identity',
        imported: 'normalizePhoneE164',
    })
    const { sourceFile, checker } = checkedSource(implementationPath, source)
    const functions = sourceFile.statements.filter((statement) => (
        ts.isFunctionDeclaration(statement)
        && statement.name?.text === 'linkContactToBestDriver'
        && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    ))
    assert.equal(functions.length, 1, `${implementationPath}: exact exported async implementation`)
    const body = functions[0].body
    assert(body && body.statements.length === 4, `${implementationPath}: exact guarded transaction envelope`)
    const [inputGuard, normalizedStatement, normalizationGuard, transactionReturn] = body.statements
    assert(ts.isIfStatement(inputGuard) && !inputGuard.elseStatement)
    assert.equal(inputGuard.getText(sourceFile).replace(/\s+/g, ''), "if(!phone)return{action:'noop',reason:'phoneisempty'}")
    assert(ts.isVariableStatement(normalizedStatement)
        && normalizedStatement.declarationList.declarations.length === 1)
    const normalizedDeclaration = normalizedStatement.declarationList.declarations[0]
    assert(ts.isIdentifier(normalizedDeclaration.name) && normalizedDeclaration.name.text === 'normalized')
    assert(normalizedDeclaration.initializer && ts.isCallExpression(unwrap(normalizedDeclaration.initializer)))
    assert.equal(propertyPath(unwrap(normalizedDeclaration.initializer).expression), 'normalizePhoneE164')
    assert.deepEqual(unwrap(normalizedDeclaration.initializer).arguments.map((argument) => argument.getText(sourceFile)), ['phone'])
    assert(ts.isIfStatement(normalizationGuard) && !normalizationGuard.elseStatement)
    assert.equal(normalizationGuard.getText(sourceFile).replace(/\s+/g, ''), "if(!normalized)return{action:'noop',reason:'phonecouldnotbenormalized'}")
    assert(ts.isReturnStatement(transactionReturn) && transactionReturn.expression)
    const transactionCall = unwrap(transactionReturn.expression)
    assert(ts.isCallExpression(transactionCall)
        && ts.isIdentifier(unwrap(transactionCall.expression))
        && unwrap(transactionCall.expression).text === 'runContactOwnershipTransaction'
        && transactionCall.arguments.length === 1, `${implementationPath}: ownership link must run inside runContactOwnershipTransaction admission`)
    const callback = unwrap(transactionCall.arguments[0])
    assert(ts.isArrowFunction(callback)
        && callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
        && callback.parameters.length === 1
        && ts.isIdentifier(callback.parameters[0].name)
        && callback.parameters[0].name.text === 'transaction'
        && ts.isBlock(callback.body))

    const runCall = assertImportedDirectCalls(sourceFile, 'runContactOwnershipTransaction', { count: 1, checker })[0]
    const lockCall = assertImportedDirectCalls(sourceFile, 'lockContactOwnershipRows', { count: 1, awaited: true, checker })[0]
    const postconditionCall = assertImportedDirectCalls(sourceFile, 'assertContactOwnershipPostconditions', { count: 1, awaited: true, checker })[0]
    const runBinding = exactImportedLocalIdentifier(sourceFile, coordinatorSpecifier, 'runContactOwnershipTransaction')
    const lockBinding = exactImportedLocalIdentifier(sourceFile, coordinatorSpecifier, 'lockContactOwnershipRows')
    const postconditionBinding = exactImportedLocalIdentifier(sourceFile, coordinatorSpecifier, 'assertContactOwnershipPostconditions')
    assertExactIdentifierReferences(sourceFile, 'runContactOwnershipTransaction', [runBinding, unwrap(runCall.expression)])
    assertExactIdentifierReferences(sourceFile, 'lockContactOwnershipRows', [lockBinding, unwrap(lockCall.expression)])
    assertExactIdentifierReferences(sourceFile, 'assertContactOwnershipPostconditions', [postconditionBinding, unwrap(postconditionCall.expression)])
    assert.equal(runCall, transactionCall)
    assert.equal(syntacticallyDead(runCall, checker), false)

    const firstCallbackStatement = callback.body.statements[0]
    assert(ts.isVariableStatement(firstCallbackStatement)
        && firstCallbackStatement.declarationList.declarations.length === 1)
    const scopeDeclaration = firstCallbackStatement.declarationList.declarations[0]
    assert(ts.isIdentifier(scopeDeclaration.name) && scopeDeclaration.name.text === 'scope')
    assert(scopeDeclaration.initializer && ts.isAwaitExpression(unwrap(scopeDeclaration.initializer)))
    assert.equal(unwrap(scopeDeclaration.initializer).expression, lockCall)
    assert.deepEqual(lockCall.arguments.map((argument) => argument.getText(sourceFile)), [
        'transaction',
        '{ normalizedPhones: [normalized] }',
    ])
    assert.equal(syntacticallyDead(lockCall, checker), false)

    const contactUpdates = []
    visit(callback.body, (node) => {
        if (ts.isCallExpression(node) && propertyPath(node.expression) === 'transaction.contact.update') {
            contactUpdates.push(node)
        }
    })
    assert.equal(contactUpdates.length, 1, `${implementationPath}: exact Contact mutation`)
    const contactUpdate = contactUpdates[0]
    assert(ts.isAwaitExpression(contactUpdate.parent)
        && ts.isExpressionStatement(contactUpdate.parent.parent)
        && contactUpdate.parent.parent.parent === callback.body)
    assert(ts.isAwaitExpression(postconditionCall.parent)
        && ts.isExpressionStatement(postconditionCall.parent.parent)
        && postconditionCall.parent.parent.parent === callback.body)
    assert(contactUpdate.getStart(sourceFile) < postconditionCall.getStart(sourceFile))
    assert.equal(syntacticallyDead(contactUpdate, checker), false)
    assert.equal(syntacticallyDead(postconditionCall, checker), false)
    assert.deepEqual(postconditionCall.arguments.map((argument) => argument.getText(sourceFile)), ['transaction', 'scope'])
    const tryStatements = []
    visit(functions[0], (node) => {
        if (ts.isTryStatement(node) || ts.isCatchClause(node)) tryStatements.push(node)
    })
    assert.deepEqual(tryStatements, [], `${implementationPath}: ownership failures must remain visible`)

    const bodySource = functions[0].getText(sourceFile)
    assert.doesNotMatch(bodySource, /\bprisma\.(?:contact|contactPhone|contactIdentity)\./, 'root Prisma ownership access bypass')
    assert.match(bodySource, /contactPhonesByContactId\.size > 1[\s\S]*action: 'ambiguous'/)
    assert.match(bodySource, /drivers\.length > 1[\s\S]*action: 'ambiguous'/)
    assert.match(bodySource, /contact\.yandexDriverId && contact\.yandexDriverId !== matched\.yandexDriverId[\s\S]*action: 'noop'/)
}

function assertPortBoundary(source) {
    assertExactBinding(source, {
        kind: 'static',
        specifier: implementationSpecifier,
        imported: 'linkContactToBestDriver',
    })
    assertExactBinding(source, {
        kind: 'static',
        specifier: handlerSpecifier,
        imported: 'YandexDriverContactLinkPortV1',
        typeOnly: true,
    })
    assert.deepEqual(exportedFunctionValues(source, portPath), ['yandexDriverContactLinkPortV1'])
    const sourceFile = parse(portPath, source)
    const declarations = exportedConst(sourceFile, 'yandexDriverContactLinkPortV1')
    assert.equal(declarations.length, 1, `${portPath}: exact exported port binding`)
    assert.equal(declarations[0].type?.getText(sourceFile), 'YandexDriverContactLinkPortV1')
    const object = unwrap(declarations[0].initializer)
    assert(object && ts.isObjectLiteralExpression(object) && object.properties.length === 1)
    const property = object.properties[0]
    assert(ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === 'link')
    assert.equal(propertyPath(property.initializer), 'linkContactToBestDriver')
    assert(ts.isIdentifier(property.initializer))
    const implementationBinding = exactImportedLocalIdentifier(sourceFile, implementationSpecifier, 'linkContactToBestDriver')
    assertExactIdentifierReferences(sourceFile, 'linkContactToBestDriver', [implementationBinding, property.initializer])
    assertNoLocalAliasExports(sourceFile)
    assert.doesNotMatch(source, /\bprisma\b|Object\.freeze|export \*/)
}

function assertHandlerBoundary(source) {
    assert.deepEqual(extractImports(source), [])
    assert.deepEqual(exportedFunctionValues(source, handlerPath), ['createYandexDriverContactLinkHandlerV1'])
    const sourceFile = parse(handlerPath, source)
    assertNoLocalAliasExports(sourceFile)
    assert.deepEqual(exportedInterfaces(sourceFile).map((declaration) => declaration.name.text).sort(), [
        'YandexDriverContactLinkPortV1',
        'YandexDriverContactLinkResultV1',
    ])
    const portInterface = exportedInterfaces(sourceFile).find((declaration) => declaration.name.text === 'YandexDriverContactLinkPortV1')
    assert(portInterface && portInterface.members.length === 1)
    const link = portInterface.members[0]
    assert(ts.isMethodSignature(link) && link.name.getText(sourceFile) === 'link')
    assert.equal(link.parameters.length, 1)
    assert.equal(link.parameters[0].name.getText(sourceFile), 'phone')
    assert.equal(link.parameters[0].type?.getText(sourceFile), 'string | null | undefined')
    assert.equal(link.type?.getText(sourceFile), 'Promise<YandexDriverContactLinkResultV1>')

    const factories = sourceFile.statements.filter((statement) => (
        ts.isFunctionDeclaration(statement)
        && statement.name?.text === 'createYandexDriverContactLinkHandlerV1'
        && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ))
    assert.equal(factories.length, 1, `${handlerPath}: exact exported handler factory`)
    const factory = factories[0]
    assert.equal(factory.parameters.length, 1)
    assert.equal(factory.parameters[0].name.getText(sourceFile), 'port')
    assert.equal(factory.parameters[0].type?.getText(sourceFile), 'YandexDriverContactLinkPortV1')
    assert(factory.body && factory.body.statements.length === 1 && ts.isReturnStatement(factory.body.statements[0]))
    const handler = unwrap(factory.body.statements[0].expression)
    assert(handler && ts.isArrowFunction(handler) && handler.parameters.length === 1)
    assert.equal(handler.parameters[0].name.getText(sourceFile), 'phone')
    assert.equal(handler.parameters[0].type?.getText(sourceFile), 'string | null | undefined')
    assert.equal(handler.type?.getText(sourceFile), 'Promise<YandexDriverContactLinkResultV1>')
    const call = unwrap(handler.body)
    assert(call && ts.isCallExpression(call) && propertyPath(call.expression) === 'port.link')
    assert.deepEqual(call.arguments.map((argument) => argument.getText(sourceFile)), ['phone'])
    assert.equal(syntacticallyDead(call), false)
    assert.doesNotMatch(source, /linkContactToBestDriver|@\/lib\/|@\/modules\/contacts\/(?:application|internal)|\bprisma\b|Object\.freeze|export \*/)
}

const implementationSource = read(implementationPath)
assertImplementationBoundary(implementationSource)

const portSource = read(portPath)
assertPortBoundary(portSource)

const handlerSource = read(handlerPath)
assertHandlerBoundary(handlerSource)

const internalSource = read(internalPath)
assert.deepEqual(extractUnsafeApplicationCompositionExports(internalSource), [])
assert.deepEqual(exportedFunctionValues(internalSource, internalPath), exactInternalCapabilities)
assert.doesNotMatch(internalSource, /linkContactToBestDriver|YandexDriverContactLink|@\/lib\/contacts\/yandex-link|\bprisma\b|Object\.freeze|export \*/)

function assertApplicationBoundary(source) {
    assert.deepEqual(extractUnsafeApplicationCompositionExports(source), [])
    assert.deepEqual(exportedFunctionValues(source, applicationPath), exactApplicationCapabilities)
    assertExactBinding(source, {
        kind: 'static',
        specifier: portSpecifier,
        imported: 'yandexDriverContactLinkPortV1',
    })
    assertExactBinding(source, {
        kind: 'static',
        specifier: handlerSpecifier,
        imported: 'createYandexDriverContactLinkHandlerV1',
    })
    assertExactBinding(source, {
        kind: 'static',
        specifier: handlerSpecifier,
        imported: 'YandexDriverContactLinkResultV1',
        typeOnly: true,
    })
    const sourceFile = parse(applicationPath, source)
    const yandexResultTypeExports = sourceFile.statements.flatMap((statement) => (
        ts.isExportDeclaration(statement)
        && !statement.moduleSpecifier
        && statement.exportClause
        && ts.isNamedExports(statement.exportClause)
            ? statement.exportClause.elements.filter((element) => (
                (statement.isTypeOnly || element.isTypeOnly)
                && (element.propertyName?.text ?? element.name.text) === 'YandexDriverContactLinkResultV1'
            )).map((element) => ({
                imported: element.propertyName?.text ?? element.name.text,
                exported: element.name.text,
            }))
            : []
    ))
    assert.deepEqual(yandexResultTypeExports, [{
        imported: 'YandexDriverContactLinkResultV1',
        exported: 'YandexDriverContactLinkResultV1',
    }])
    const composedHandlers = sourceFile.statements.flatMap((statement) => (
        ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)
            ? statement.declarationList.declarations.filter((declaration) => (
                ts.isIdentifier(declaration.name) && declaration.name.text === 'linkContactToBestDriver'
            ))
            : []
    ))
    assert.equal(composedHandlers.length, 1, `${applicationPath}: exact local composed handler`)
    const composition = unwrap(composedHandlers[0].initializer)
    assert(composition && ts.isCallExpression(composition))
    assert.equal(propertyPath(composition.expression), 'createYandexDriverContactLinkHandlerV1')
    assert.deepEqual(composition.arguments.map((argument) => argument.getText(sourceFile)), ['yandexDriverContactLinkPortV1'])
    assertImportedDirectCalls(sourceFile, 'createYandexDriverContactLinkHandlerV1', { count: 1 })
    const portBinding = exactImportedLocalIdentifier(sourceFile, portSpecifier, 'yandexDriverContactLinkPortV1')
    assert(ts.isIdentifier(composition.arguments[0]))
    assertExactIdentifierReferences(sourceFile, 'yandexDriverContactLinkPortV1', [portBinding, composition.arguments[0]])
    assertDirectDelegate(source, applicationPath, 'linkContactToBestDriverV1', 'linkContactToBestDriver', 'phone', 'local')
    assert.doesNotMatch(source, /@\/lib\/contacts\/yandex-link|\bprisma\b|Object\.freeze|export \*/)
}

const applicationSource = read(applicationPath)
assertApplicationBoundary(applicationSource)

const publicBarrelSource = read(publicBarrelPath)
assertExactBinding(publicBarrelSource, {
    kind: 'export',
    specifier: applicationSpecifier,
    imported: 'linkContactToBestDriverV1',
})
assertExactBinding(publicBarrelSource, {
    kind: 'export',
    specifier: applicationSpecifier,
    imported: 'YandexDriverContactLinkResultV1',
    typeOnly: true,
})
assert.doesNotMatch(publicBarrelSource, /@\/lib\/contacts\/yandex-link|\.\.\/internal\/|yandex-driver-contact-link|Object\.freeze/)

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
    assert.doesNotMatch(
        source,
        /\bprisma\.(?:contact|contactPhone|contactIdentity)\.(?:create|update|upsert|delete)\s*\(/,
        `${consumerPath}: consumer must not mutate Contacts-owned records directly`,
    )
}
assertConsumerBoundary(consumer)

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
const portCapability = 'yandexDriverContactLinkPortV1'
const handlerCapability = 'createYandexDriverContactLinkHandlerV1'
const publicCapability = 'linkContactToBestDriverV1'
const capabilityNames = new Set([rawCapability, portCapability, handlerCapability, publicCapability])
const expectedCapabilityBindings = [
    {
        file: moduleIndexPath,
        kind: 'export',
        specifier: './public',
        imported: '*',
        local: '*',
    },
    {
        file: portPath,
        kind: 'static',
        specifier: implementationSpecifier,
        imported: rawCapability,
        local: rawCapability,
    },
    {
        file: applicationPath,
        kind: 'static',
        specifier: portSpecifier,
        imported: portCapability,
        local: portCapability,
    },
    {
        file: applicationPath,
        kind: 'static',
        specifier: handlerSpecifier,
        imported: handlerCapability,
        local: handlerCapability,
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
        || resolved === withoutModuleSuffix(portPath)
        || resolved === withoutModuleSuffix(applicationPath)
        || resolved === withoutModuleSuffix(handlerPath)
        || resolved === publicDirectory
        || resolved === withoutModuleSuffix(path.posix.dirname(publicAggregatorPath))
}
const dynamicCapabilityBindings = (source, file) => {
    const sourceFile = parse(file, source)
    const records = []
    visit(sourceFile, node => {
        if (!ts.isCallExpression(node)
            || node.expression.kind !== ts.SyntaxKind.ImportKeyword
            || node.arguments.length < 1
            || !ts.isStringLiteralLike(node.arguments[0])
            || !governedModule(file, node.arguments[0].text)) return
        const parent = node.parent
        const declaration = ts.isAwaitExpression(parent)
            && ts.isVariableDeclaration(parent.parent)
            && parent.parent.initializer === parent
            ? parent.parent
            : null
        let touchesGovernedCapability = node.arguments.length !== 1 || !declaration || !ts.isObjectBindingPattern(declaration.name)
        if (declaration && ts.isObjectBindingPattern(declaration.name)) {
            for (const element of declaration.name.elements) {
                if (element.dotDotDotToken || !ts.isIdentifier(element.name)) {
                    touchesGovernedCapability = true
                    continue
                }
                const property = element.propertyName
                let imported = element.name.text
                if (property && (ts.isIdentifier(property) || ts.isStringLiteralLike(property))) imported = property.text
                else if (property) {
                    touchesGovernedCapability = true
                    continue
                }
                if (capabilityNames.has(imported)) touchesGovernedCapability = true
            }
        }
        if (!touchesGovernedCapability) return
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
assert.throws(() => assertApplicationBoundary(noOpApplicationProbe))
const bypassApplicationFactoryProbe = applicationSource.replace(
    'createYandexDriverContactLinkHandlerV1(yandexDriverContactLinkPortV1)',
    'yandexDriverContactLinkPortV1.link',
)
assert.notEqual(bypassApplicationFactoryProbe, applicationSource)
assert.throws(() => assertApplicationBoundary(bypassApplicationFactoryProbe))
const extraPortUseProbe = `${applicationSource}\nvoid yandexDriverContactLinkPortV1.link('+79990000000')\n`
assert.throws(() => assertApplicationBoundary(extraPortUseProbe))
const bypassPortProbe = portSource.replace(implementationSpecifier, '@/lib/prisma')
assert.notEqual(bypassPortProbe, portSource)
assert.throws(() => assertPortBoundary(bypassPortProbe))
const noOpPortProbe = portSource.replace(
    'link: linkContactToBestDriver',
    "link: async () => ({ action: 'noop' })",
)
assert.notEqual(noOpPortProbe, portSource)
assert.throws(() => assertPortBoundary(noOpPortProbe))
const extraImplementationUseProbe = `${portSource}\nvoid linkContactToBestDriver('+79990000000')\n`
assert.throws(() => assertPortBoundary(extraImplementationUseProbe))
const portAliasExportProbe = `${portSource}\nexport { yandexDriverContactLinkPortV1 as alternateYandexDriverContactLinkPortV1 }\n`
assert.throws(() => assertPortBoundary(portAliasExportProbe))
const noOpHandlerProbe = handlerSource.replace(
    'port.link(phone)',
    "Promise.resolve({ action: 'noop' })",
)
assert.notEqual(noOpHandlerProbe, handlerSource)
assert.throws(() => assertHandlerBoundary(noOpHandlerProbe))
const handlerAliasExportProbe = `${handlerSource}\nexport { createYandexDriverContactLinkHandlerV1 as alternateYandexDriverContactLinkHandlerV1 }\n`
assert.throws(() => assertHandlerBoundary(handlerAliasExportProbe))
const bypassTransactionProbe = implementationSource.replace(
    'runContactOwnershipTransaction(async transaction =>',
    'bypassContactOwnershipTransaction(async transaction =>',
)
assert.notEqual(bypassTransactionProbe, implementationSource)
assert.throws(() => assertImplementationBoundary(bypassTransactionProbe), /admission/)
const bypassLocksProbe = implementationSource.replace(
    'lockContactOwnershipRows(transaction, { normalizedPhones: [normalized] })',
    'bypassContactOwnershipRows(transaction, { normalizedPhones: [normalized] })',
)
assert.notEqual(bypassLocksProbe, implementationSource)
assert.throws(() => assertImplementationBoundary(bypassLocksProbe), /lockContactOwnershipRows/)
const bypassPostconditionsProbe = implementationSource.replace(
    'await assertContactOwnershipPostconditions(transaction, scope)',
    'await Promise.resolve(scope)',
)
assert.notEqual(bypassPostconditionsProbe, implementationSource)
assert.throws(() => assertImplementationBoundary(bypassPostconditionsProbe), /assertContactOwnershipPostconditions/)
const rootMutationProbe = implementationSource.replace(
    'await transaction.contact.update(',
    'await prisma.contact.update(',
)
assert.notEqual(rootMutationProbe, implementationSource)
assert.throws(() => assertImplementationBoundary(rootMutationProbe), /exact Contact mutation|root Prisma ownership access/)
const consumerForeignMutationProbe = `${consumer}\nvoid prisma.contactIdentity.update({ where: { id: 'probe' }, data: {} })\n`
assert.throws(() => assertConsumerBoundary(consumerForeignMutationProbe), /must not mutate Contacts-owned records directly/)
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
const extraFactoryConsumerSources = new Map(baseSources)
extraFactoryConsumerSources.set(
    'gravity-mvp/src/__architecture_probe__/extra-yandex-link-factory-consumer.ts',
    "import { createYandexDriverContactLinkHandlerV1 as createLink } from '@/modules/contacts/public/v1/yandex-driver-contact-link'\nvoid createLink\n",
)
assert.throws(() => assertCapabilityDenominator(extraFactoryConsumerSources))
const extraPortConsumerSources = new Map(baseSources)
extraPortConsumerSources.set(
    'gravity-mvp/src/__architecture_probe__/extra-yandex-link-port-consumer.ts',
    "import { yandexDriverContactLinkPortV1 as port } from '@/modules/contacts/internal/yandex-driver-contact-link-port'\nvoid port\n",
)
assert.throws(() => assertCapabilityDenominator(extraPortConsumerSources))
for (const [probeName, probeSource] of [
    ['dynamic-options', `void import('${publicSpecifier}', { with: { type: 'json' } })\n`],
    ['dynamic-computed', `const { ['linkContactToBestDriverV1']: link } = await import('${publicSpecifier}')\nvoid link\n`],
    ['dynamic-string', `const { 'linkContactToBestDriverV1': link } = await import('${publicSpecifier}')\nvoid link\n`],
    ['dynamic-rest', `const { ...contacts } = await import('${publicSpecifier}')\nvoid contacts\n`],
]) {
    const dynamicSources = new Map(baseSources)
    dynamicSources.set(`gravity-mvp/src/__architecture_probe__/${probeName}-yandex-link-consumer.ts`, probeSource)
    assert.throws(() => assertCapabilityDenominator(dynamicSources))
}

const contactsManifest = JSON.parse(read('architecture/contexts/v1/manifests/contacts.json'))
const fleetManifest = JSON.parse(read('architecture/contexts/v1/manifests/fleet_operations.json'))
assert(contactsManifest.public_surface.includes('YandexDriverContactLink.v1'))
assert(fleetManifest.allowed_dependencies.some((dependency) => (
    dependency.context === 'contacts' && dependency.surface === 'contacts.public'
)))

const scan = await scanArchitecture(root)
const chainPaths = new Set([
    consumerPath,
    publicBarrelPath,
    applicationPath,
    handlerPath,
    portPath,
    implementationPath,
    internalPath,
])
assert.deepEqual(scan.findings.filter((finding) => chainPaths.has(finding.file)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    runtime_consumers: 1,
    public_entrypoint: publicSpecifier,
    application_capabilities: exactApplicationCapabilities.length,
    yandex_link_capabilities: capabilityNames.size,
    negative_deep_import_probe: 'REJECTED',
    negative_skipped_application_probe: 'REJECTED',
    negative_capability_widening_probe: 'REJECTED',
    adversarial_boundary_probes: 32,
    implementation_enforcement: 'SEMANTIC_NO_IMPLEMENTATION_DIGEST',
    dependency_cycle: 'ABSENT',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
