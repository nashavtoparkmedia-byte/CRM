#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

import { extractImports, scanArchitecture } from './enforce-architecture.mjs'

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
const yandexLinkPortSpecifier = '../internal/yandex-driver-contact-link-port'
const yandexLinkHandlerSpecifier = '../public/v1/yandex-driver-contact-link'
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
    if (ts.isVoidExpression(node)) return undefined
    if (ts.isPrefixUnaryExpression(node)) {
        const operand = primitiveConstant(node.operand, checker, seen)
        if (operand === UNKNOWN_CONSTANT) return UNKNOWN_CONSTANT
        if (node.operator === ts.SyntaxKind.ExclamationToken) return !operand
        if (node.operator === ts.SyntaxKind.PlusToken) return Number(operand)
        if (node.operator === ts.SyntaxKind.MinusToken) return -Number(operand)
        return UNKNOWN_CONSTANT
    }
    if (ts.isConditionalExpression(node)) {
        const condition = primitiveConstant(node.condition, checker, seen)
        if (condition === UNKNOWN_CONSTANT) return UNKNOWN_CONSTANT
        return primitiveConstant(condition ? node.whenTrue : node.whenFalse, checker, seen)
    }
    if (!ts.isBinaryExpression(node)) return UNKNOWN_CONSTANT
    const left = primitiveConstant(node.left, checker, seen)
    if (left === UNKNOWN_CONSTANT) return UNKNOWN_CONSTANT
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && !left) return left
    if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken && left) return left
    if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && left !== null && left !== undefined) return left
    const right = primitiveConstant(node.right, checker, seen)
    if (right === UNKNOWN_CONSTANT) return UNKNOWN_CONSTANT
    switch (node.operatorToken.kind) {
        case ts.SyntaxKind.AmpersandAmpersandToken: return right
        case ts.SyntaxKind.BarBarToken: return right
        case ts.SyntaxKind.QuestionQuestionToken: return right
        case ts.SyntaxKind.EqualsEqualsEqualsToken: return left === right
        case ts.SyntaxKind.ExclamationEqualsEqualsToken: return left !== right
        default: return UNKNOWN_CONSTANT
    }
}
const unconditionalTerminator = (node) => ts.isReturnStatement(node)
    || ts.isThrowStatement(node)
    || ts.isBreakStatement(node)
    || ts.isContinueStatement(node)
const statementAlwaysTerminates = (statement, checker) => {
    if (unconditionalTerminator(statement)) return true
    if (ts.isBlock(statement)) return statement.statements.some((child) => statementAlwaysTerminates(child, checker))
    if (ts.isLabeledStatement(statement)) return statementAlwaysTerminates(statement.statement, checker)
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
    if (ts.isTryStatement(statement)) {
        if (statement.finallyBlock && statementAlwaysTerminates(statement.finallyBlock, checker)) return true
        return statementAlwaysTerminates(statement.tryBlock, checker)
            && (!statement.catchClause || statementAlwaysTerminates(statement.catchClause.block, checker))
    }
    return false
}
const followsUnconditionalTerminator = (node, checker) => {
    for (let child = node, current = node.parent; current; child = current, current = current.parent) {
        const statements = ts.isBlock(current) || ts.isSourceFile(current)
            || ts.isCaseClause(current) || ts.isDefaultClause(current)
            ? current.statements
            : undefined
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
            if (current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && left !== null && left !== undefined) return true
        }
    }
    return followsUnconditionalTerminator(node, checker)
}
const commonJsRequireAliases = (sourceFile) => {
    const aliases = new Set(['require'])
    for (let pass = 0; pass < sourceFile.statements.length + 2; pass += 1) {
        let changed = false
        visit(sourceFile, (node) => {
            if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return
            const initializer = unwrap(node.initializer)
            const aliasesRequire = ts.isIdentifier(initializer) && aliases.has(initializer.text)
            const aliasesModuleRequire = ts.isPropertyAccessExpression(initializer)
                && ts.isIdentifier(initializer.expression)
                && initializer.expression.text === 'module'
                && initializer.name.text === 'require'
            if ((aliasesRequire || aliasesModuleRequire) && !aliases.has(node.name.text)) {
                aliases.add(node.name.text)
                changed = true
            }
        })
        if (!changed) break
    }
    return aliases
}
const isCommonJsRequireCall = (expression, aliases) => {
    const candidate = unwrap(expression)
    return (ts.isIdentifier(candidate) && aliases.has(candidate.text))
        || (ts.isPropertyAccessExpression(candidate)
            && ts.isIdentifier(candidate.expression)
            && candidate.expression.text === 'module'
            && candidate.name.text === 'require')
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
const expressionRootIdentifier = (expression) => {
    let current = unwrap(expression)
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
        current = unwrap(current.expression)
    }
    return ts.isIdentifier(current) ? current : null
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
const isValueBindingIdentifier = (node) => {
    if (!ts.isIdentifier(node)) return false
    const parent = node.parent
    return (ts.isVariableDeclaration(parent) && parent.name === node)
        || (ts.isParameter(parent) && parent.name === node)
        || (ts.isBindingElement(parent) && parent.name === node)
        || (ts.isFunctionDeclaration(parent) && parent.name === node)
        || (ts.isFunctionExpression(parent) && parent.name === node)
        || (ts.isClassDeclaration(parent) && parent.name === node)
        || (ts.isClassExpression(parent) && parent.name === node)
        || (ts.isEnumDeclaration(parent) && parent.name === node)
        || (ts.isImportClause(parent) && parent.name === node)
        || (ts.isImportSpecifier(parent) && parent.name === node)
        || (ts.isNamespaceImport(parent) && parent.name === node)
        || (ts.isImportEqualsDeclaration(parent) && parent.name === node)
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
const enclosingFunctionChain = (node) => {
    const names = []
    for (let current = node.parent; current; current = current.parent) {
        if (!ts.isFunctionLike(current)) continue
        if (ts.isFunctionDeclaration(current) && current.name) names.push(current.name.text)
        else if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current))
            && ts.isVariableDeclaration(current.parent)
            && ts.isIdentifier(current.parent.name)) names.push(current.parent.name.text)
        else if (current.name && ts.isIdentifier(current.name)) names.push(current.name.text)
        else names.push(null)
    }
    return names
}
const assertImportedDirectCalls = (sourceFile, name, expectedCount, owner = null, checker = null) => {
    const directCalls = []
    visit(sourceFile, (node) => {
        if (!ts.isIdentifier(node) || node.text !== name) return
        if (ts.isImportSpecifier(node.parent) && node.parent.name === node) return
        const call = directCallForIdentifier(node)
        assert(call, `${sourceFile.fileName}: ${name} must not be shadowed, copied, or referenced indirectly`)
        assert.equal(syntacticallyDead(call, checker), false, `${sourceFile.fileName}: ${name} call is syntactically dead`)
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
            ? statement.exportClause.elements
                .filter((element) => element.isTypeOnly || statement.isTypeOnly)
                .map((element) => ({
                    imported: element.propertyName?.text ?? element.name.text,
                    exported: element.name.text,
                }))
            : []
    ))
    assert.deepEqual(localTypeExports, [{
        imported: 'LegacyContactResolutionOutcome',
        exported: 'LegacyContactResolutionOutcome',
    }])
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
    const { sourceFile, checker } = checkedSource(consumerPath, source)
    const startCalls = assertImportedDirectCalls(sourceFile, 'startMaxContactResolutionShadowV1', 1, 'POST', checker)
    assert(ts.isAwaitExpression(startCalls[0].parent), 'shadow start must be awaited')
    const declaration = startCalls[0].parent.parent
    assert(ts.isVariableDeclaration(declaration)
        && ts.isIdentifier(declaration.name)
        && declaration.name.text === 'maxContactResolutionShadow')
    const completionCalls = calls(sourceFile, 'maxContactResolutionShadow.session.complete')
    const completionOutcomes = completionCalls.map((call) => {
        assert.equal(call.arguments.length, 1, 'shadow completion accepts one exact legacy outcome')
        assert(ts.isAwaitExpression(call.parent), 'shadow completion must be awaited')
        assert.equal(syntacticallyDead(call, checker), false, 'shadow completion must remain live')
        const argument = unwrap(call.arguments[0])
        if (ts.isIdentifier(argument)) {
            return {
                owner_chain: enclosingFunctionChain(call),
                argument_kind: 'identifier',
                outcome: argument.text,
            }
        }
        assert(ts.isObjectLiteralExpression(argument), 'shadow completion outcome must remain explicit')
        assert.equal(argument.properties.length, 2, 'early shadow completion has exact status and reason')
        const fields = new Map(argument.properties.map((property) => {
            assert(ts.isPropertyAssignment(property), 'shadow completion fields must be explicit assignments')
            assert(ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
            return [property.name.text, unwrap(property.initializer)]
        }))
        assert.deepEqual([...fields.keys()].sort(), ['reason', 'status'])
        const status = fields.get('status')
        assert(status && ts.isStringLiteralLike(status) && status.text === 'no_contact')
        const reason = fields.get('reason')
        assert(reason && (ts.isIdentifier(reason) || ts.isStringLiteralLike(reason)))
        return {
            owner_chain: enclosingFunctionChain(call),
            argument_kind: 'object',
            status_kind: 'literal',
            status: status.text,
            reason_kind: ts.isIdentifier(reason) ? 'identifier' : 'literal',
            reason: reason.text,
        }
    })
    assert.deepEqual(completionOutcomes, [
        {
            owner_chain: ['rejectExistingChatCollision', 'POST'],
            argument_kind: 'object',
            status_kind: 'literal',
            status: 'no_contact',
            reason_kind: 'identifier',
            reason: 'collisionReason',
        },
        {
            owner_chain: ['POST'],
            argument_kind: 'object',
            status_kind: 'literal',
            status: 'no_contact',
            reason_kind: 'literal',
            reason: 'deleted_provider_message',
        },
        {
            owner_chain: ['POST'],
            argument_kind: 'object',
            status_kind: 'literal',
            status: 'no_contact',
            reason_kind: 'literal',
            reason: 'existing_provider_message',
        },
        {
            owner_chain: ['POST'],
            argument_kind: 'object',
            status_kind: 'literal',
            status: 'no_contact',
            reason_kind: 'literal',
            reason: 'legacy_contact_resolution_not_reached',
        },
        {
            owner_chain: ['POST'],
            argument_kind: 'identifier',
            outcome: 'legacyContactResolution',
        },
    ], `${consumerPath}: exact shadow completion outcomes`)
    const completionReceivers = completionCalls.map((call) => {
        const receiver = expressionRootIdentifier(call.expression)
        assert(receiver, 'shadow completion receiver must have a direct identifier root')
        return receiver
    })
    const shadowResultBindings = []
    const shadowResultIdentifiers = []
    visit(sourceFile, (node) => {
        if (ts.isIdentifier(node) && node.text === 'maxContactResolutionShadow') shadowResultIdentifiers.push(node)
        if (isValueBindingIdentifier(node) && node.text === 'maxContactResolutionShadow') shadowResultBindings.push(node)
    })
    assert.deepEqual(shadowResultBindings, [declaration.name], 'shadow session result must have one exact value binding')
    assert.deepEqual(
        shadowResultIdentifiers,
        [declaration.name, ...completionReceivers],
        'shadow session result may only be declared once and used by the five exact completions',
    )
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
    const sourceFile = parse(applicationPath, source)
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
    exactBinding(imports, 'yandexDriverContactLinkPortV1', {
        typeOnly: false,
        source: yandexLinkPortSpecifier,
    })
    exactBinding(imports, 'createYandexDriverContactLinkHandlerV1', {
        typeOnly: false,
        source: yandexLinkHandlerSpecifier,
    })
    exactBinding(imports, 'YandexDriverContactLinkResultV1', {
        typeOnly: true,
        source: yandexLinkHandlerSpecifier,
    })
    const isPublicSpecifier = (specifier) => /(?:^|\/)public(?:\/|$)/u.test(specifier)
    const publicModuleEdges = extractImports(source)
        .filter((entry) => isPublicSpecifier(entry.specifier))
        .map((entry) => ({
            kind: entry.kind,
            specifier: entry.specifier,
            bindings: [
                ...entry.imports.map((binding) => ({
                    imported: binding.imported,
                    local: binding.local,
                    typeOnly: false,
                })),
                ...(entry.typeImports ?? []).map((binding) => ({
                    imported: binding.imported,
                    local: binding.local,
                    typeOnly: true,
                })),
            ],
        }))
    const requireAliases = commonJsRequireAliases(sourceFile)
    visit(sourceFile, (node) => {
        if (!ts.isCallExpression(node)
            || node.expression.kind !== ts.SyntaxKind.ImportKeyword
            || node.arguments.length === 1
            || !ts.isStringLiteralLike(node.arguments[0])
            || !isPublicSpecifier(node.arguments[0].text)) return
        publicModuleEdges.push({
            kind: 'noncanonical-dynamic-import',
            specifier: node.arguments[0].text,
            bindings: [],
        })
    })
    visit(sourceFile, (node) => {
        if (!ts.isCallExpression(node)
            || node.arguments.length < 1
            || !ts.isStringLiteralLike(node.arguments[0])
            || !isPublicSpecifier(node.arguments[0].text)
            || !isCommonJsRequireCall(node.expression, requireAliases)
            || (ts.isIdentifier(unwrap(node.expression)) && unwrap(node.expression).text === 'require')
            || (ts.isPropertyAccessExpression(unwrap(node.expression))
                && ts.isIdentifier(unwrap(node.expression).expression)
                && unwrap(node.expression).expression.text === 'module')) return
        publicModuleEdges.push({
            kind: 'aliased-require',
            specifier: node.arguments[0].text,
            bindings: [],
        })
    })
    visit(sourceFile, (node) => {
        if (!ts.isImportTypeNode(node)
            || !ts.isLiteralTypeNode(node.argument)
            || !ts.isStringLiteralLike(node.argument.literal)
            || !isPublicSpecifier(node.argument.literal.text)) return
        if (!publicModuleEdges.some((edge) => (
            edge.kind === 'type-import'
            && edge.specifier === node.argument.literal.text
        ))) {
            publicModuleEdges.push({
                kind: 'type-import',
                specifier: node.argument.literal.text,
                bindings: [],
            })
        }
    })
    assert.deepEqual(publicModuleEdges, [{
        kind: 'static',
        specifier: yandexLinkHandlerSpecifier,
        bindings: [
            {
                imported: 'createYandexDriverContactLinkHandlerV1',
                local: 'createYandexDriverContactLinkHandlerV1',
                typeOnly: false,
            },
            {
                imported: 'YandexDriverContactLinkResultV1',
                local: 'YandexDriverContactLinkResultV1',
                typeOnly: true,
            },
        ],
    }], `${applicationPath}: exact unrelated public type/handler module edge`)
    const localTypeExports = sourceFile.statements.flatMap((statement) => (
        ts.isExportDeclaration(statement)
        && !statement.moduleSpecifier
        && statement.exportClause
        && ts.isNamedExports(statement.exportClause)
            ? statement.exportClause.elements
                .filter((element) => element.isTypeOnly || statement.isTypeOnly)
                .map((element) => ({
                    imported: element.propertyName?.text ?? element.name.text,
                    exported: element.name.text,
                }))
            : []
    ))
    assert.deepEqual(localTypeExports, [
        {
            imported: 'LegacyContactResolutionOutcome',
            exported: 'LegacyContactResolutionOutcome',
        },
        {
            imported: 'YandexDriverContactLinkResultV1',
            exported: 'YandexDriverContactLinkResultV1',
        },
    ])
    assertDirectDelegate(source, applicationPath, 'startMaxContactResolutionShadowV1', 'startMaxContactResolutionShadow', 'input')
    assert.doesNotMatch(source, /@\/lib\/contacts\/|\bprisma\b|compareContactResolution|isMaxContactResolutionShadowEnabled|Dependencies|export \*/)
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
    const requireAliases = commonJsRequireAliases(sourceFile)
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
    for (const entry of extractImports(source)) {
        if (!governedModule(file, entry.specifier)
            || !['require', 'type-import'].includes(entry.kind)) continue
        records.push({
            file,
            kind: entry.kind === 'dynamic' ? 'dynamic-import' : entry.kind,
            source: entry.specifier,
            imported: '*',
            local: '*',
            typeOnly: entry.kind === 'type-import',
        })
    }
    visit(sourceFile, (node) => {
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
                if (imported === publicCapability || imported === rawCapability) touchesGovernedCapability = true
            }
        }
        if (!touchesGovernedCapability) return
        records.push({
            file,
            kind: node.arguments.length === 1 ? 'dynamic-import' : 'noncanonical-dynamic-import',
            source: node.arguments[0].text,
            imported: '*',
            local: '*',
            typeOnly: false,
        })
    })
    visit(sourceFile, (node) => {
        const expression = ts.isCallExpression(node) ? unwrap(node.expression) : null
        if (!expression
            || node.arguments.length < 1
            || !ts.isStringLiteralLike(node.arguments[0])
            || !governedModule(file, node.arguments[0].text)
            || !isCommonJsRequireCall(expression, requireAliases)
            || (ts.isIdentifier(expression) && expression.text === 'require')
            || (ts.isPropertyAccessExpression(expression)
                && ts.isIdentifier(expression.expression)
                && expression.expression.text === 'module')) return
        records.push({
            file,
            kind: 'aliased-require',
            source: node.arguments[0].text,
            imported: '*',
            local: '*',
            typeOnly: false,
        })
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
rejectProbe(
    application,
    `${application}\nimport * as publicHandlerProbe from '${yandexLinkHandlerSpecifier}'\nvoid publicHandlerProbe\n`,
    assertApplicationBoundary,
)
rejectProbe(
    application,
    `${application}\nvoid import('${yandexLinkHandlerSpecifier}', { with: { type: 'json' } })\n`,
    assertApplicationBoundary,
)
rejectProbe(
    application,
    `${application}\nconst loadPublicHandler = require\nvoid loadPublicHandler('${yandexLinkHandlerSpecifier}')\n`,
    assertApplicationBoundary,
)
rejectProbe(
    application,
    `${application}\nvoid module.require('${yandexLinkHandlerSpecifier}')\n`,
    assertApplicationBoundary,
)
rejectProbe(
    application,
    `${application}\ntype ExtraPublicHandler = import('${yandexLinkHandlerSpecifier}').YandexDriverContactLinkResultV1\n`,
    assertApplicationBoundary,
)
rejectProbe(
    application,
    application
        .replace(
            'export type { LegacyContactResolutionOutcome }',
            'export type { YandexDriverContactLinkResultV1 as LegacyContactResolutionOutcome }',
        )
        .replace(
            'export type { YandexDriverContactLinkResultV1 }',
            'export type { LegacyContactResolutionOutcome as YandexDriverContactLinkResultV1 }',
        ),
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
rejectProbe(
    consumer,
    consumer.replace("reason: 'deleted_provider_message'", "reason: 'existing_provider_message'"),
    assertConsumerBoundary,
)
rejectProbe(
    consumer,
    consumer.replace(
        "status: 'no_contact',\n          reason: collisionReason,\n        })",
        "status: 'no_contact',\n          reason: 'collisionReason',\n        })",
    ),
    assertConsumerBoundary,
)
rejectProbe(
    consumer,
    consumer.replace('complete(legacyContactResolution)', "complete({ status: 'no_contact', reason: 'legacy_contact_resolution_not_reached' })"),
    assertConsumerBoundary,
)
rejectProbe(
    consumer,
    consumer.replace(
        '      } = {},\n    ) => {\n      const existingMetadata = metadataRecord(existingChat.metadata)',
        '      } = {},\n      maxContactResolutionShadow = { session: null },\n    ) => {\n      const existingMetadata = metadataRecord(existingChat.metadata)',
    ),
    assertConsumerBoundary,
)
rejectProbe(
    consumer,
    consumer.replace(
        '    await maxContactResolutionShadow.session?.complete(legacyContactResolution)',
        '    const shadowCompletionAlias = maxContactResolutionShadow\n'
            + '    await shadowCompletionAlias.session?.complete(legacyContactResolution)\n'
            + '    await maxContactResolutionShadow.session?.complete(legacyContactResolution)',
    ),
    assertConsumerBoundary,
)
for (const completionReplacement of [
    "    const shadowCompletionEnabled = false\n    if (shadowCompletionEnabled) {\n      await maxContactResolutionShadow.session?.complete(legacyContactResolution)\n    }",
    "    const shadowCompletionEnabled = false\n    shadowCompletionEnabled && await maxContactResolutionShadow.session?.complete(legacyContactResolution)",
    "    const shadowCompletionEnabled = false\n    shadowCompletionEnabled ? await maxContactResolutionShadow.session?.complete(legacyContactResolution) : undefined",
    "    return NextResponse.json({ ok: false }, { status: 500 })\n    await maxContactResolutionShadow.session?.complete(legacyContactResolution)",
]) {
    rejectProbe(
        consumer,
        consumer.replace(
            '    await maxContactResolutionShadow.session?.complete(legacyContactResolution)',
            completionReplacement,
        ),
        assertConsumerBoundary,
    )
}
rejectProbe(
    consumer,
    consumer.replace(
        '    const maxContactResolutionShadow = await startMaxContactResolutionShadowV1({',
        "    const maxShadowEnabled = false\n"
            + "    if (!maxShadowEnabled) return NextResponse.json({ ok: false }, { status: 500 })\n"
            + '    const maxContactResolutionShadow = await startMaxContactResolutionShadowV1({',
    ),
    assertConsumerBoundary,
)
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
for (const [probeName, probeSource] of [
    ['aliased-require', `const loadContacts = require\nvoid loadContacts('${publicBarrelSpecifier}')\n`],
    ['module-require', `void module.require('${publicBarrelSpecifier}')\n`],
    ['import-type', `type ContactsBoundaryProbe = import('${publicBarrelSpecifier}').LegacyContactResolutionOutcome\n`],
]) {
    const moduleLoadSources = new Map(baseSources)
    moduleLoadSources.set(`gravity-mvp/src/__architecture_probe__/${probeName}-max-shadow-consumer.ts`, probeSource)
    assert.throws(() => assertPublicCapabilityDenominator(moduleLoadSources))
}

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
    negative_boundary_bypass_probes: 17,
    negative_shadow_completion_probes: 3,
    negative_shadow_binding_probes: 2,
    negative_shadow_liveness_probes: 5,
    negative_application_composition_probes: 6,
    public_composition: 'BARREL_TO_APPLICATION_TO_INTERNAL',
    dependency_cycle: 'ABSENT',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
