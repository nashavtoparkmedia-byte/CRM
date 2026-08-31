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
const implementationPath = 'gravity-mvp/src/lib/MessageService.ts'
const publicPath = 'gravity-mvp/src/modules/messaging/public/v1/delivery-recovery-operations.ts'
const publicBarrelPath = 'gravity-mvp/src/modules/messaging/public/v1/index.ts'
const publicAggregatorPath = 'gravity-mvp/src/modules/messaging/public/index.ts'
const moduleIndexPath = 'gravity-mvp/src/modules/messaging/index.ts'
const consumerPath = 'gravity-mvp/src/instrumentation.ts'
const publicBarrelSpecifier = '@/modules/messaging/public/v1'
const publicCapabilitySpecifier = './delivery-recovery-operations'
const messageServiceSpecifier = '@/lib/MessageService'
const exactFunctions = [
    'recoverStuckMessagingDeliveriesV1',
    'retryEligibleMessagingDeliveriesV1',
]
const exactConsumerImports = [
    'recoverStuckMessagingDeliveriesV1',
    'recoverStuckMessagingDeliveriesV1',
    'retryEligibleMessagingDeliveriesV1',
]
const rawDeliveryMethods = new Set(['recoverStuckMessages', 'retrySend'])

assert.equal(sha256(read(implementationPath)), '60fd0e9ffbace3c48290b5970d22f618ee96845eab7c2f0721cab49974d1e74a')

function hasModifier(node, kind) {
    return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false
}

function exportedRuntimeValues(source) {
    const sourceFile = ts.createSourceFile('delivery-recovery-operations.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const exported = []
    for (const statement of sourceFile.statements) {
        if (ts.isExportAssignment(statement)) {
            exported.push('default')
        } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
            if (!statement.exportClause) exported.push('*')
            else if (ts.isNamedExports(statement.exportClause)) {
                for (const element of statement.exportClause.elements) {
                    if (!element.isTypeOnly) exported.push(element.name.text)
                }
            }
        } else if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
            if (ts.isVariableStatement(statement)) {
                for (const declaration of statement.declarationList.declarations) {
                    exported.push(declaration.name.getText(sourceFile))
                }
            } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
                exported.push(statement.name?.text ?? 'default')
            } else if (ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) {
                exported.push(statement.name.getText(sourceFile))
            } else if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) {
                exported.push(`syntax:${statement.kind}`)
            }
        }
    }
    return exported.sort()
}

function hasExactCapabilitySurface(source) {
    return JSON.stringify(exportedRuntimeValues(source)) === JSON.stringify([...exactFunctions].sort())
}

function scriptKind(file) {
    return /\.(?:tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

function parseSource(file, source) {
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file))
    assert.equal(sourceFile.parseDiagnostics.length, 0, `${file}: TypeScript parse diagnostics`)
    return sourceFile
}

function checkedSource(file, source) {
    const virtualPath = path.join(root, file)
    const options = { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, noResolve: true }
    const host = ts.createCompilerHost(options)
    const originalGetSourceFile = host.getSourceFile.bind(host)
    host.getSourceFile = (fileName, languageVersion, ...rest) => (
        path.resolve(fileName) === path.resolve(virtualPath)
            ? ts.createSourceFile(virtualPath, source, languageVersion, true, scriptKind(file))
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

function visit(node, callback) {
    callback(node)
    ts.forEachChild(node, (child) => visit(child, callback))
}

function unwrapTransparent(expression) {
    let current = expression
    while (
        ts.isParenthesizedExpression(current)
        || ts.isAsExpression(current)
        || ts.isTypeAssertionExpression(current)
        || ts.isNonNullExpression(current)
        || (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(current))
    ) current = current.expression
    return current
}

const UNKNOWN_CONSTANT = Symbol('unknown-constant')
function primitiveConstant(expression, checker, seen = new Set()) {
    const node = unwrapTransparent(expression)
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true
    if (node.kind === ts.SyntaxKind.NullKeyword) return null
    if (ts.isStringLiteralLike(node)) return node.text
    if (ts.isNumericLiteral(node)) return Number(node.text)
    if (ts.isBigIntLiteral(node)) return BigInt(node.text.slice(0, -1))
    if (ts.isIdentifier(node)) {
        if (node.text === 'undefined') return undefined
        if (node.text === 'NaN') return Number.NaN
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
    if (ts.isBinaryExpression(node)) {
        const left = primitiveConstant(node.left, checker, seen)
        if (left === UNKNOWN_CONSTANT) return UNKNOWN_CONSTANT
        if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && !left) return left
        if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken && left) return left
        if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && left !== null && left !== undefined) return left
        const right = primitiveConstant(node.right, checker, seen)
        if (right === UNKNOWN_CONSTANT) return UNKNOWN_CONSTANT
        switch (node.operatorToken.kind) {
            case ts.SyntaxKind.PlusToken: return left + right
            case ts.SyntaxKind.EqualsEqualsEqualsToken: return left === right
            case ts.SyntaxKind.ExclamationEqualsEqualsToken: return left !== right
            case ts.SyntaxKind.EqualsEqualsToken: return left == right // eslint-disable-line eqeqeq
            case ts.SyntaxKind.ExclamationEqualsToken: return left != right // eslint-disable-line eqeqeq
            case ts.SyntaxKind.LessThanToken: return left < right
            case ts.SyntaxKind.LessThanEqualsToken: return left <= right
            case ts.SyntaxKind.GreaterThanToken: return left > right
            case ts.SyntaxKind.GreaterThanEqualsToken: return left >= right
            case ts.SyntaxKind.AmpersandAmpersandToken: return right
            case ts.SyntaxKind.BarBarToken: return right
            case ts.SyntaxKind.QuestionQuestionToken: return right
            default: return UNKNOWN_CONSTANT
        }
    }
    return UNKNOWN_CONSTANT
}

function isSyntacticallyDead(node, checker) {
    for (let child = node, current = node.parent; current; child = current, current = current.parent) {
        if (ts.isIfStatement(current)) {
            const condition = primitiveConstant(current.expression, checker)
            if (condition !== UNKNOWN_CONSTANT) {
                if (!condition && child === current.thenStatement) return true
                if (condition && child === current.elseStatement) return true
            }
        }
        if (ts.isWhileStatement(current) || ts.isForStatement(current)) {
            const conditionExpression = ts.isWhileStatement(current) ? current.expression : current.condition
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
    return false
}

function calleePath(expression) {
    const node = unwrapTransparent(expression)
    if (ts.isIdentifier(node)) return node.text
    if (ts.isPropertyAccessExpression(node)) {
        const owner = calleePath(node.expression)
        return owner ? `${owner}.${node.name.text}` : null
    }
    return null
}

function directIdentifierCall(identifier) {
    let expression = identifier
    while (expression.parent && (
        ts.isParenthesizedExpression(expression.parent)
        || ts.isAsExpression(expression.parent)
        || ts.isTypeAssertionExpression(expression.parent)
        || ts.isNonNullExpression(expression.parent)
        || (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(expression.parent))
    )) expression = expression.parent
    return expression.parent && ts.isCallExpression(expression.parent) && expression.parent.expression === expression
        ? expression.parent
        : null
}

function directlyAwaited(node) {
    let expression = node
    while (expression.parent && (
        ts.isParenthesizedExpression(expression.parent)
        || ts.isAsExpression(expression.parent)
        || ts.isTypeAssertionExpression(expression.parent)
        || ts.isNonNullExpression(expression.parent)
    )) expression = expression.parent
    return Boolean(expression.parent && ts.isAwaitExpression(expression.parent))
}

function enclosingInvocation(functionNode) {
    let expression = functionNode
    while (expression.parent && ts.isParenthesizedExpression(expression.parent)) expression = expression.parent
    return expression.parent && ts.isCallExpression(expression.parent) && expression.parent.arguments.includes(expression)
        ? expression.parent
        : null
}

function intervalVariable(call) {
    let expression = call
    while (expression.parent && ts.isParenthesizedExpression(expression.parent)) expression = expression.parent
    return expression.parent
        && ts.isVariableDeclaration(expression.parent)
        && expression.parent.initializer === expression
        && ts.isIdentifier(expression.parent.name)
        ? expression.parent.name.text
        : null
}

function executionContext(node, sourceFile, checker) {
    let functionDepth = 0
    let rootFunction = null
    let interval = null
    let job = null
    let startupDelay = null
    const namedHelpers = []
    for (let current = node.parent; current; current = current.parent) {
        if (!ts.isFunctionLike(current)) continue
        functionDepth += 1
        if (ts.isFunctionDeclaration(current) && current.name) {
            rootFunction = current.name.text
            if (current.name.text !== 'register') namedHelpers.push(current.name.text)
            continue
        }
        const invocation = enclosingInvocation(current)
        const invokedPath = invocation ? calleePath(invocation.expression) : null
        if (invokedPath === 'setInterval') {
            interval = intervalVariable(invocation)
        } else if (invokedPath === 'setTimeout') {
            const delay = invocation.arguments[1] ? primitiveConstant(invocation.arguments[1], checker) : UNKNOWN_CONSTANT
            startupDelay = typeof delay === 'number' ? delay : null
        } else if (invokedPath === 'runOperationalJobV1') {
            const label = invocation.arguments[0] ? primitiveConstant(invocation.arguments[0], checker) : UNKNOWN_CONSTANT
            job = typeof label === 'string' ? label : null
        } else if (ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) {
            namedHelpers.push(current.parent.name.text)
        } else {
            namedHelpers.push('<anonymous>')
        }
    }
    return { functionDepth, rootFunction, startupDelay, interval, job, namedHelpers: namedHelpers.sort() }
}

function bindingPropertyName(element, sourceFile, checker) {
    const property = element.propertyName ?? element.name
    if (ts.isIdentifier(property) || ts.isStringLiteralLike(property) || ts.isNumericLiteral(property)) return property.text
    if (ts.isComputedPropertyName(property)) {
        const value = primitiveConstant(property.expression, checker)
        return typeof value === 'string' || typeof value === 'number' ? String(value) : null
    }
    return null
}

function awaitedImportCall(initializer) {
    const outer = unwrapTransparent(initializer)
    if (!ts.isAwaitExpression(outer)) return null
    const call = unwrapTransparent(outer.expression)
    return ts.isCallExpression(call) && call.expression.kind === ts.SyntaxKind.ImportKeyword ? call : null
}

function consumerRuntimeModel(source) {
    const { sourceFile, checker } = checkedSource(consumerPath, source)
    const sites = []
    visit(sourceFile, (node) => {
        if (!ts.isVariableDeclaration(node) || !node.initializer || !ts.isObjectBindingPattern(node.name)) return
        const importCall = awaitedImportCall(node.initializer)
        if (!importCall || importCall.arguments.length !== 1) return
        const specifier = primitiveConstant(importCall.arguments[0], checker)
        for (const element of node.name.elements) {
            const imported = bindingPropertyName(element, sourceFile, checker)
            if (!imported || !exactFunctions.includes(imported)) continue
            assert(ts.isIdentifier(element.name), `${consumerPath}: delivery recovery binding must use an identifier`)
            const declarationList = node.parent
            assert(ts.isVariableDeclarationList(declarationList) && (declarationList.flags & ts.NodeFlags.Const), `${consumerPath}: ${imported} import must be immutable const`)
            assert.equal(node.name.elements.length, 1, `${consumerPath}: ${imported} import declaration must bind exactly one capability`)
            assert.equal(element.dotDotDotToken, undefined, `${consumerPath}: delivery recovery rest binding is forbidden`)
            assert.equal(specifier, publicBarrelSpecifier, `${consumerPath}: ${imported} must load from the public v1 barrel`)
            assert.equal(element.name.text, imported, `${consumerPath}: ${imported} alias is forbidden`)
            assert.equal(isSyntacticallyDead(node, checker), false, `${consumerPath}: ${imported} import is syntactically dead`)
            const symbol = checker.getSymbolAtLocation(element.name)
            assert(symbol, `${consumerPath}: ${imported} binding symbol is unavailable`)
            sites.push({
                name: imported,
                index: node.getStart(sourceFile),
                binding: element.name,
                symbol,
                importContext: executionContext(node, sourceFile, checker),
                calls: [],
            })
        }
    })
    for (const site of sites) {
        visit(sourceFile, (node) => {
            if (!ts.isIdentifier(node) || node === site.binding || checker.getSymbolAtLocation(node) !== site.symbol) return
            const call = directIdentifierCall(node)
            assert(call, `${consumerPath}: ${site.name} must not be rebound, copied, or referenced indirectly`)
            assert.equal(call.arguments.length, 0, `${consumerPath}: ${site.name} call must keep its closed input`)
            assert(directlyAwaited(call), `${consumerPath}: ${site.name} call must be awaited`)
            assert.equal(isSyntacticallyDead(call, checker), false, `${consumerPath}: ${site.name} call is syntactically dead`)
            site.calls.push({ call, callContext: executionContext(call, sourceFile, checker) })
        })
        assert.equal(site.calls.length, 1, `${consumerPath}: ${site.name} import must have exactly one direct executable call`)
    }
    return sites.sort((left, right) => left.index - right.index).map((site) => ({
        name: site.name,
        importContext: site.importContext,
        callContext: site.calls[0].callContext,
    }))
}

const withoutModuleSuffix = (value) => value.replace(/\.(?:[cm]?[jt]sx?)$/, '').replace(/\/index$/, '')
function resolveModule(file, specifier) {
    if (specifier.startsWith('@/')) return withoutModuleSuffix(`gravity-mvp/src/${specifier.slice(2)}`)
    if (specifier.startsWith('.')) return withoutModuleSuffix(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)))
    return specifier
}
const governedModulePaths = new Set([
    publicPath,
    path.posix.dirname(publicBarrelPath),
    path.posix.dirname(publicAggregatorPath),
    path.posix.dirname(moduleIndexPath),
].map(withoutModuleSuffix))
const governedModule = (file, specifier) => governedModulePaths.has(resolveModule(file, specifier))
const bindingSort = (left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))

function moduleLoadDeclaration(call) {
    let current = call
    while (current.parent && (
        ts.isAwaitExpression(current.parent)
        || ts.isParenthesizedExpression(current.parent)
        || ts.isAsExpression(current.parent)
        || ts.isTypeAssertionExpression(current.parent)
        || ts.isNonNullExpression(current.parent)
    )) current = current.parent
    return current.parent
        && ts.isVariableDeclaration(current.parent)
        && current.parent.initializer === current
        ? current.parent
        : null
}

function moduleBindingRecords(file, source) {
    const sourceFile = parseSource(file, source)
    const records = []
    const push = (kind, specifier, imported, local) => records.push({ file, kind, specifier, imported, local })
    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
            const specifier = statement.moduleSpecifier.text
            const clause = statement.importClause
            if (!clause || clause.isTypeOnly) {
                if (!clause && governedModule(file, specifier)) push('side-effect-import', specifier, '*', '*')
                continue
            }
            if (clause.name && governedModule(file, specifier)) push('default-import', specifier, 'default', clause.name.text)
            if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) && governedModule(file, specifier)) {
                push('namespace-import', specifier, '*', clause.namedBindings.name.text)
            }
            if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                for (const element of clause.namedBindings.elements) {
                    if (element.isTypeOnly) continue
                    const imported = (element.propertyName ?? element.name).text
                    if (exactFunctions.includes(imported)) push('static-import', specifier, imported, element.name.text)
                }
            }
        } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier) && !statement.isTypeOnly) {
            const specifier = statement.moduleSpecifier.text
            if (!statement.exportClause) {
                if (governedModule(file, specifier)) push('export-star', specifier, '*', '*')
            } else if (ts.isNamespaceExport(statement.exportClause)) {
                if (governedModule(file, specifier)) push('namespace-export', specifier, '*', statement.exportClause.name.text)
            } else if (ts.isNamedExports(statement.exportClause)) {
                for (const element of statement.exportClause.elements) {
                    if (element.isTypeOnly) continue
                    const imported = (element.propertyName ?? element.name).text
                    if (exactFunctions.includes(imported)) push('named-export', specifier, imported, element.name.text)
                }
            }
        } else if (
            ts.isImportEqualsDeclaration(statement)
            && ts.isExternalModuleReference(statement.moduleReference)
            && statement.moduleReference.expression
            && ts.isStringLiteralLike(statement.moduleReference.expression)
            && governedModule(file, statement.moduleReference.expression.text)
        ) {
            push('import-equals', statement.moduleReference.expression.text, '*', statement.name.text)
        }
    }
    visit(sourceFile, (node) => {
        if (!ts.isCallExpression(node) || node.arguments.length !== 1) return
        const kind = node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? 'dynamic-import'
            : (ts.isIdentifier(node.expression) && node.expression.text === 'require' ? 'require' : null)
        if (!kind) return
        const specifierValue = primitiveConstant(node.arguments[0], null)
        if (typeof specifierValue !== 'string') return
        const declaration = moduleLoadDeclaration(node)
        if (declaration && ts.isObjectBindingPattern(declaration.name)) {
            let unknownBinding = false
            for (const element of declaration.name.elements) {
                if (element.dotDotDotToken) {
                    unknownBinding = true
                    continue
                }
                const imported = bindingPropertyName(element, sourceFile, null)
                if (imported === null) {
                    unknownBinding = true
                } else if (exactFunctions.includes(imported) && ts.isIdentifier(element.name)) {
                    push(kind, specifierValue, imported, element.name.text)
                }
            }
            if (unknownBinding && governedModule(file, specifierValue)) push(kind, specifierValue, '*', '*')
            return
        }
        if (governedModule(file, specifierValue)) {
            const local = declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : '*'
            push(kind, specifierValue, '*', local)
        }
    })
    return records
}

function rawDeliveryMethodRecords(file, source) {
    const sourceFile = parseSource(file, source)
    const records = []
    visit(sourceFile, (node) => {
        let method = null
        if (ts.isPropertyAccessExpression(node)) method = node.name.text
        if (ts.isElementAccessExpression(node) && node.argumentExpression) {
            const value = primitiveConstant(node.argumentExpression, null)
            if (typeof value === 'string') method = value
        }
        if (!method || !rawDeliveryMethods.has(method)) return
        records.push({
            file,
            method,
            kind: node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node ? 'call' : 'reference',
        })
    })
    return records
}

function discoverCapabilityBindings(sources) {
    return [...sources].flatMap(([file, source]) => moduleBindingRecords(file, source)).sort(bindingSort)
}

function discoverRawDeliveryMethods(sources) {
    return [...sources].flatMap(([file, source]) => rawDeliveryMethodRecords(file, source)).sort(bindingSort)
}

function topLevelFunction(sourceFile, name) {
    return sourceFile.statements.filter((statement) => (
        ts.isFunctionDeclaration(statement) && statement.name?.text === name
    ))
}

function topLevelVariable(sourceFile, name) {
    return sourceFile.statements.flatMap((statement) => (
        ts.isVariableStatement(statement)
            ? statement.declarationList.declarations.filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name)
            : []
    ))
}

function assertExportedAsyncFunction(node, name) {
    assert(hasModifier(node, ts.SyntaxKind.ExportKeyword), `${publicPath}: ${name} must be exported`)
    assert(hasModifier(node, ts.SyntaxKind.AsyncKeyword), `${publicPath}: ${name} must be async`)
    assert.equal(node.parameters.length, 0, `${publicPath}: ${name} input must remain closed`)
    assert(node.body, `${publicPath}: ${name} body is missing`)
}

function assertPublicCapabilityImplementation(source) {
    const { sourceFile, checker } = checkedSource(publicPath, source)
    assert.equal(hasExactCapabilitySurface(source), true, `${publicPath}: runtime export surface drift`)
    const serviceImports = sourceFile.statements.flatMap((statement) => {
        if (!ts.isImportDeclaration(statement)
            || !ts.isStringLiteralLike(statement.moduleSpecifier)
            || statement.moduleSpecifier.text !== messageServiceSpecifier) return []
        const clause = statement.importClause
        assert(clause && !clause.isTypeOnly && !clause.name, `${publicPath}: MessageService import shape`)
        assert(clause.namedBindings && ts.isNamedImports(clause.namedBindings), `${publicPath}: MessageService must be a named import`)
        return clause.namedBindings.elements.filter((element) => (element.propertyName ?? element.name).text === 'MessageService')
    })
    assert.equal(serviceImports.length, 1, `${publicPath}: exact MessageService import`)
    assert.equal(serviceImports[0].name.text, 'MessageService', `${publicPath}: MessageService alias is forbidden`)
    const serviceSymbol = checker.getSymbolAtLocation(serviceImports[0].name)
    assert(serviceSymbol, `${publicPath}: MessageService import symbol unavailable`)

    const ageDeclarations = topLevelVariable(sourceFile, 'STUCK_MESSAGE_AGE_MINUTES_V1')
    assert.equal(ageDeclarations.length, 1, `${publicPath}: exact stuck-age constant`)
    const ageDeclaration = ageDeclarations[0]
    assert(ts.isVariableDeclarationList(ageDeclaration.parent) && (ageDeclaration.parent.flags & ts.NodeFlags.Const))
    assert.equal(primitiveConstant(ageDeclaration.initializer, checker), 5)
    const ageSymbol = checker.getSymbolAtLocation(ageDeclaration.name)

    const recoverFunctions = topLevelFunction(sourceFile, 'recoverStuckMessagingDeliveriesV1')
    assert.equal(recoverFunctions.length, 1)
    const recover = recoverFunctions[0]
    assertExportedAsyncFunction(recover, 'recoverStuckMessagingDeliveriesV1')
    assert.equal(recover.body.statements.length, 1, 'recovery wrapper must directly return its owner call')
    const recoverReturn = recover.body.statements[0]
    assert(ts.isReturnStatement(recoverReturn) && recoverReturn.expression)
    const recoverCall = unwrapTransparent(recoverReturn.expression)
    assert(ts.isCallExpression(recoverCall) && ts.isPropertyAccessExpression(unwrapTransparent(recoverCall.expression)))
    const recoverTarget = unwrapTransparent(recoverCall.expression)
    assert(ts.isIdentifier(recoverTarget.expression) && checker.getSymbolAtLocation(recoverTarget.expression) === serviceSymbol)
    assert.equal(recoverTarget.name.text, 'recoverStuckMessages')
    assert.equal(recoverCall.arguments.length, 1)
    assert(ts.isIdentifier(recoverCall.arguments[0]) && checker.getSymbolAtLocation(recoverCall.arguments[0]) === ageSymbol)
    assert.equal(isSyntacticallyDead(recoverCall, checker), false)

    const retryFunctions = topLevelFunction(sourceFile, 'retryEligibleMessagingDeliveriesV1')
    assert.equal(retryFunctions.length, 1)
    const retry = retryFunctions[0]
    assertExportedAsyncFunction(retry, 'retryEligibleMessagingDeliveriesV1')
    assert.equal(retry.body.statements.length, 4, 'retry wrapper orchestration statement count')
    const [candidateStatement, countStatement, loopStatement, returnStatement] = retry.body.statements
    assert(ts.isVariableStatement(candidateStatement) && (candidateStatement.declarationList.flags & ts.NodeFlags.Const))
    assert.equal(candidateStatement.declarationList.declarations.length, 1)
    const candidatesDeclaration = candidateStatement.declarationList.declarations[0]
    assert(ts.isIdentifier(candidatesDeclaration.name) && candidatesDeclaration.name.text === 'candidates' && candidatesDeclaration.initializer)
    const candidatesSymbol = checker.getSymbolAtLocation(candidatesDeclaration.name)
    const queryAwait = unwrapTransparent(candidatesDeclaration.initializer)
    assert(ts.isAwaitExpression(queryAwait))
    const query = unwrapTransparent(queryAwait.expression)
    assert(ts.isTaggedTemplateExpression(query) && calleePath(query.tag) === 'prisma.$queryRaw')

    assert(ts.isVariableStatement(countStatement) && !(countStatement.declarationList.flags & ts.NodeFlags.Const))
    assert.equal(countStatement.declarationList.declarations.length, 1)
    const countDeclaration = countStatement.declarationList.declarations[0]
    assert(ts.isIdentifier(countDeclaration.name) && countDeclaration.name.text === 'retriedCount')
    assert.equal(primitiveConstant(countDeclaration.initializer, checker), 0)

    assert(ts.isForOfStatement(loopStatement) && ts.isVariableDeclarationList(loopStatement.initializer))
    assert(loopStatement.initializer.flags & ts.NodeFlags.Const)
    assert.equal(loopStatement.initializer.declarations.length, 1)
    const idDeclaration = loopStatement.initializer.declarations[0]
    assert(ts.isObjectBindingPattern(idDeclaration.name) && idDeclaration.name.elements.length === 1)
    const idBinding = idDeclaration.name.elements[0]
    assert(ts.isIdentifier(idBinding.name) && idBinding.name.text === 'id')
    const idSymbol = checker.getSymbolAtLocation(idBinding.name)
    assert(ts.isIdentifier(loopStatement.expression) && checker.getSymbolAtLocation(loopStatement.expression) === candidatesSymbol)
    assert(ts.isBlock(loopStatement.statement) && loopStatement.statement.statements.length === 2)
    const resultStatement = loopStatement.statement.statements[0]
    assert(ts.isVariableStatement(resultStatement) && (resultStatement.declarationList.flags & ts.NodeFlags.Const))
    assert.equal(resultStatement.declarationList.declarations.length, 1)
    const resultDeclaration = resultStatement.declarationList.declarations[0]
    assert(ts.isIdentifier(resultDeclaration.name) && resultDeclaration.name.text === 'result' && resultDeclaration.initializer)
    const retryAwait = unwrapTransparent(resultDeclaration.initializer)
    assert(ts.isAwaitExpression(retryAwait))
    const retryCall = unwrapTransparent(retryAwait.expression)
    assert(ts.isCallExpression(retryCall) && ts.isPropertyAccessExpression(unwrapTransparent(retryCall.expression)))
    const retryTarget = unwrapTransparent(retryCall.expression)
    assert(ts.isIdentifier(retryTarget.expression) && checker.getSymbolAtLocation(retryTarget.expression) === serviceSymbol)
    assert.equal(retryTarget.name.text, 'retrySend')
    assert.equal(retryCall.arguments.length, 1)
    assert(ts.isIdentifier(retryCall.arguments[0]) && checker.getSymbolAtLocation(retryCall.arguments[0]) === idSymbol)
    assert.equal(isSyntacticallyDead(retryCall, checker), false)

    const resultIf = loopStatement.statement.statements[1]
    assert(ts.isIfStatement(resultIf) && resultIf.elseStatement === undefined)
    assert.equal(resultIf.expression.getText(sourceFile), "result.error !== 'Backoff not elapsed'")
    assert.equal(resultIf.thenStatement.getText(sourceFile).replace(/\s+/g, ''), '{retriedCount++}')
    assert(ts.isReturnStatement(returnStatement) && returnStatement.expression && ts.isObjectLiteralExpression(returnStatement.expression))
    assert.equal(returnStatement.expression.getText(sourceFile).replace(/\s+/g, ''), '{retriedCount,candidatesFound:candidates.length}')

    const serviceMethods = []
    visit(sourceFile, (node) => {
        if (!ts.isIdentifier(node) || checker.getSymbolAtLocation(node) !== serviceSymbol) return
        if (node === serviceImports[0].name) return
        assert(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node, `${publicPath}: indirect or shadowed MessageService use`)
        assert(ts.isCallExpression(node.parent.parent) && node.parent.parent.expression === node.parent, `${publicPath}: MessageService method must be called directly`)
        serviceMethods.push(node.parent.name.text)
    })
    assert.deepEqual(serviceMethods.sort(), [...rawDeliveryMethods].sort())

}

function assertPublicBarrelBoundary(source) {
    const deliveryExports = extractImports(source).filter((entry) => (
        entry.kind === 'export' && entry.specifier === publicCapabilitySpecifier
    ))
    assert.equal(deliveryExports.length, 1, 'delivery recovery must have one named public-barrel export')
    assert.deepEqual(
        deliveryExports[0].imports.map(({ imported, local }) => ({ imported, local })).sort((left, right) => left.imported.localeCompare(right.imported)),
        exactFunctions.map((name) => ({ imported: name, local: name })).sort((left, right) => left.imported.localeCompare(right.imported)),
    )
    assert.doesNotMatch(source, /export\s+\*\s+from\s+['"]\.\/delivery-recovery-operations['"]/)
}

const expectedConsumerBindings = exactConsumerImports.map((name) => ({
    file: consumerPath,
    kind: 'dynamic-import',
    specifier: publicBarrelSpecifier,
    imported: name,
    local: name,
})).sort(bindingSort)
const registerContext = { functionDepth: 2, rootFunction: 'register', startupDelay: 5000, interval: null, job: null, namedHelpers: [] }
const recoveryIntervalContext = { functionDepth: 3, rootFunction: 'register', startupDelay: 5000, interval: 'recoveryInterval', job: null, namedHelpers: [] }
const recoveryJobContext = { functionDepth: 4, rootFunction: 'register', startupDelay: 5000, interval: 'recoveryInterval', job: 'recovery', namedHelpers: [] }
const retryJobContext = { functionDepth: 4, rootFunction: 'register', startupDelay: 5000, interval: 'retryInterval', job: 'message_retry', namedHelpers: [] }
const expectedRuntimeModel = [
    {
        name: 'recoverStuckMessagingDeliveriesV1',
        importContext: registerContext,
        callContext: registerContext,
    },
    {
        name: 'recoverStuckMessagingDeliveriesV1',
        importContext: recoveryIntervalContext,
        callContext: recoveryJobContext,
    },
    {
        name: 'retryEligibleMessagingDeliveriesV1',
        importContext: retryJobContext,
        callContext: retryJobContext,
    },
]

function assertConsumerBoundary(source) {
    assert.deepEqual(moduleBindingRecords(consumerPath, source).sort(bindingSort), expectedConsumerBindings)
    assert.deepEqual(consumerRuntimeModel(source), expectedRuntimeModel)
    assert.doesNotMatch(source, /@\/modules\/messaging\/public\/v1\/delivery-recovery-operations/)
    assert.doesNotMatch(source, /@\/modules\/messaging\/(?:application|internal)(?:\/|['"])/)
    assert.doesNotMatch(source, /@\/lib\/MessageService/)
    assert.doesNotMatch(source, /SELECT id FROM "Message"|MessageService\.(?:recoverStuckMessages|retrySend)/)
}

function runtimeSourcePaths(relativeDirectory) {
    const absoluteDirectory = path.join(root, relativeDirectory)
    return readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
        const relative = path.join(relativeDirectory, entry.name)
        if (entry.isDirectory()) return runtimeSourcePaths(relative)
        if (!/\.[cm]?[jt]sx?$/.test(entry.name)
            || /(?:^|\/)__tests__\//.test(relative.split(path.sep).join('/'))
            || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)
            || entry.name.endsWith('.d.ts')) return []
        return [relative.split(path.sep).join('/')]
    })
}

function rejectProbe(source, changed, validate) {
    assert.notEqual(changed, source, 'negative probe must alter its source')
    assert.throws(() => validate(changed))
}

const publicSource = read(publicPath)
assert.equal(hasExactCapabilitySurface(publicSource), true)
assertPublicCapabilityImplementation(publicSource)
assert.match(publicSource, /const STUCK_MESSAGE_AGE_MINUTES_V1 = 5/)
assert.match(publicSource, /MessageService\.recoverStuckMessages\(STUCK_MESSAGE_AGE_MINUTES_V1\)/)
for (const policy of [
    "status = 'failed'",
    "direction = 'outbound'",
    "metadata->>'retryable'",
    "metadata->>'retryAttempt'",
    "metadata->>'maxRetries'",
    "INTERVAL '24 hours'",
    'ORDER BY "sentAt" ASC',
    'LIMIT 10',
]) assert.match(publicSource, new RegExp(policy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
assert.match(publicSource, /result\.error !== 'Backoff not elapsed'/)
assert.doesNotMatch(publicSource, /\$executeRaw|\$queryRawUnsafe|\b(?:INSERT|UPDATE|DELETE|UPSERT|TRUNCATE)\b|tableName|whereClause|rawSql/)
assert.doesNotMatch(publicSource, /export \*|export \{[^}]*MessageService|messageId\s*:/)

// Negative enforcement property: an unrelated exported operation makes this
// otherwise-approved writer surface invalid.
const unrelatedWriteProbe = `${publicSource}\nexport async function deleteUnrelatedContactV1() { return true }\n`
assert.equal(hasExactCapabilitySurface(unrelatedWriteProbe), false)
rejectProbe(
    publicSource,
    publicSource.replace(
        'return MessageService.recoverStuckMessages(STUCK_MESSAGE_AGE_MINUTES_V1)',
        'return 0 // MessageService.recoverStuckMessages(STUCK_MESSAGE_AGE_MINUTES_V1)',
    ),
    assertPublicCapabilityImplementation,
)

const consumerSource = read(consumerPath)
const publicBarrelSource = read(publicBarrelPath)
assertPublicBarrelBoundary(publicBarrelSource)
assertConsumerBoundary(consumerSource)

const baseRuntimeSources = new Map(runtimeSourcePaths('gravity-mvp/src').map((sourcePath) => [sourcePath, read(sourcePath)]))
const expectedRepositoryBindings = [
    ...expectedConsumerBindings,
    ...exactFunctions.map((name) => ({
        file: publicBarrelPath,
        kind: 'named-export',
        specifier: publicCapabilitySpecifier,
        imported: name,
        local: name,
    })),
    {
        file: publicAggregatorPath,
        kind: 'export-star',
        specifier: './v1',
        imported: '*',
        local: '*',
    },
    {
        file: moduleIndexPath,
        kind: 'namespace-export',
        specifier: './public',
        imported: '*',
        local: 'MessagingPublic',
    },
].sort(bindingSort)
const expectedRawDeliveryMethods = [
    { file: publicPath, method: 'recoverStuckMessages', kind: 'call' },
    { file: publicPath, method: 'retrySend', kind: 'call' },
].sort(bindingSort)
function assertRepositoryWideDenominator(sources = baseRuntimeSources) {
    assert.deepEqual(
        discoverCapabilityBindings(sources),
        expectedRepositoryBindings,
        'repository-wide delivery-recovery capability binding denominator changed',
    )
    assert.deepEqual(
        discoverRawDeliveryMethods(sources),
        expectedRawDeliveryMethods,
        'repository-wide raw MessageService delivery method denominator changed',
    )
}
assertRepositoryWideDenominator()
const runtimeConsumers = [...new Set(expectedConsumerBindings.map(({ file }) => file))]
assert.deepEqual(runtimeConsumers, [consumerPath])

rejectProbe(
    consumerSource,
    consumerSource.replace(publicBarrelSpecifier, `${publicBarrelSpecifier}/delivery-recovery-operations`),
    assertConsumerBoundary,
)

for (const deadConditionProbe of [
    {
        name: 'numeric false',
        replacement: 'let recovered = 0\n            if (0) recovered = await recoverStuckMessagingDeliveriesV1()',
    },
    {
        name: 'empty-string false',
        replacement: "let recovered = 0\n            if ('') recovered = await recoverStuckMessagingDeliveriesV1()",
    },
    {
        name: 'null false',
        replacement: 'let recovered = 0\n            if (null) recovered = await recoverStuckMessagingDeliveriesV1()',
    },
    {
        name: 'const false',
        replacement: 'const disabledDeliveryRecoveryProbe = false\n            let recovered = 0\n            if (disabledDeliveryRecoveryProbe) recovered = await recoverStuckMessagingDeliveriesV1()',
    },
]) {
    const changed = consumerSource.replace(
        'const recovered = await recoverStuckMessagingDeliveriesV1()',
        deadConditionProbe.replacement,
    )
    assert.notEqual(changed, consumerSource, `${deadConditionProbe.name} probe must alter its source`)
    assert.throws(() => assertConsumerBoundary(changed), undefined, `${deadConditionProbe.name} call must be rejected`)
}

rejectProbe(
    consumerSource,
    consumerSource.replace(
        'const recovered = await recoverStuckMessagingDeliveriesV1()',
        'let recovered = 0\n            async function neverRunDeliveryRecoveryProbe() { recovered = await recoverStuckMessagingDeliveriesV1() }',
    ),
    assertConsumerBoundary,
)

const reboundImportProbe = consumerSource
    .replace(
        `const { recoverStuckMessagingDeliveriesV1 } = await import('${publicBarrelSpecifier}')`,
        `let { recoverStuckMessagingDeliveriesV1 } = await import('${publicBarrelSpecifier}')`,
    )
    .replace(
        'const recovered = await recoverStuckMessagingDeliveriesV1()',
        'recoverStuckMessagingDeliveriesV1 = async () => 0\n            const recovered = await recoverStuckMessagingDeliveriesV1()',
    )
rejectProbe(consumerSource, reboundImportProbe, assertConsumerBoundary)

const aliasedImportProbe = consumerSource
    .replace(
        `const { recoverStuckMessagingDeliveriesV1 } = await import('${publicBarrelSpecifier}')`,
        `const { recoverStuckMessagingDeliveriesV1: recoverStuck } = await import('${publicBarrelSpecifier}')`,
    )
    .replace(
        'const recovered = await recoverStuckMessagingDeliveriesV1()',
        'const recovered = await recoverStuck()',
    )
rejectProbe(consumerSource, aliasedImportProbe, assertConsumerBoundary)

rejectProbe(
    consumerSource,
    `${consumerSource}\nvoid import('${publicBarrelSpecifier}').then(async (messaging) => {\n    await messaging['recoverStuckMessagingDeliveriesV1']()\n})\n`,
    assertConsumerBoundary,
)

rejectProbe(
    consumerSource,
    `${consumerSource}\nconst { 'recoverStuckMessagingDeliveriesV1': hiddenRecovery } = await import('${publicBarrelSpecifier}')\nawait hiddenRecovery()\n`,
    assertConsumerBoundary,
)

const computedConsumerSources = new Map(baseRuntimeSources)
computedConsumerSources.set(
    'gravity-mvp/src/__architecture_probe__/computed-delivery-recovery-consumer.ts',
    `const capabilityName = 'recover' + 'StuckMessagingDeliveriesV1'\nvoid import('${publicBarrelSpecifier}').then(async (messaging) => { await messaging[capabilityName]() })\n`,
)
assert.throws(() => assertRepositoryWideDenominator(computedConsumerSources))

const rawComputedConsumerSources = new Map(baseRuntimeSources)
rawComputedConsumerSources.set(
    'gravity-mvp/src/__architecture_probe__/raw-delivery-recovery-consumer.ts',
    `import { MessageService } from '${messageServiceSpecifier}'\nvoid MessageService['recover' + 'StuckMessages'](5)\n`,
)
assert.throws(() => assertRepositoryWideDenominator(rawComputedConsumerSources))
rejectProbe(
    consumerSource,
    consumerSource.replace(
        'const recovered = await recoverStuckMessagingDeliveriesV1()',
        'const recovered = await Promise.resolve(0) // recoverStuckMessagingDeliveriesV1()',
    ),
    assertConsumerBoundary,
)
rejectProbe(
    consumerSource,
    consumerSource.replace(
        'const count = await recoverStuckMessagingDeliveriesV1()',
        'const count = false ? await recoverStuckMessagingDeliveriesV1() : 0',
    ),
    assertConsumerBoundary,
)
rejectProbe(
    consumerSource,
    consumerSource.replace(
        'const result = await retryEligibleMessagingDeliveriesV1()',
        'const result = await (async () => {\n                    const retryEligibleMessagingDeliveriesV1 = async () => ({ attempted: 0 })\n                    return retryEligibleMessagingDeliveriesV1()\n                })()',
    ),
    assertConsumerBoundary,
)
rejectProbe(
    publicBarrelSource,
    publicBarrelSource.replace(publicCapabilitySpecifier, '../../application/messaging-operations'),
    assertPublicBarrelBoundary,
)
rejectProbe(
    consumerSource,
    consumerSource.replace(
        `const { recoverStuckMessagingDeliveriesV1 } = await import('${publicBarrelSpecifier}')`,
        '',
    ),
    assertConsumerBoundary,
)
rejectProbe(
    consumerSource,
    `${consumerSource}\nasync function duplicateDeliveryRecoveryConsumerProbe() {\n    const { retryEligibleMessagingDeliveriesV1 } = await import('${publicBarrelSpecifier}')\n    return retryEligibleMessagingDeliveriesV1()\n}\n`,
    assertConsumerBoundary,
)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/messaging.json'))
assert(manifest.public_surface.includes('DeliveryRecoveryOperations.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    finding.file === consumerPath
    && [implementationPath, publicPath].includes(finding.details?.target)
)), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    consumers: runtimeConsumers.length,
    consumer_import_sites: exactConsumerImports.length,
    capabilities: exactFunctions.length,
    negative_unrelated_write_probe: 'REJECTED',
    closed_original_bypass_categories: 7,
    negative_boundary_bypass_probes: 17,
    negative_repository_denominator_probes: 2,
    negative_dead_condition_variants: 4,
    public_entrypoint: publicBarrelSpecifier,
    current_findings: scan.findings.length,
}, null, 2)}\n`)
