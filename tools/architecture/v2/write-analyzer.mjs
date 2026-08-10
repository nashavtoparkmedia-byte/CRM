import { createHash } from 'node:crypto'
import path from 'node:path'

import ts from '../../../gravity-mvp/node_modules/typescript/lib/typescript.js'

import { analyzeSqlMutation, SQL_DYNAMIC_MARKER } from './sql-mutation-analyzer.mjs'

export const PRISMA_WRITE_METHODS = new Set([
    'create',
    'createMany',
    'createManyAndReturn',
    'update',
    'updateMany',
    'updateManyAndReturn',
    'upsert',
    'delete',
    'deleteMany',
])

export const PRISMA_RAW_METHODS = new Set([
    '$executeRaw',
    '$executeRawUnsafe',
    '$queryRaw',
    '$queryRawUnsafe',
])

export const SQL_DRIVER_METHODS = new Set([
    'exec', 'execute', 'executeSql', 'query', 'run',
])

export const DRIZZLE_WRITE_METHODS = new Set(['insert', 'update', 'delete'])

export const PRISMA_READ_METHODS = new Set([
    'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany',
    'count', 'aggregate', 'groupBy', 'findRaw', 'aggregateRaw',
])

function digest(value) {
    return createHash('sha256').update(value).digest('hex')
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}

function scriptKind(fileName) {
    const extension = path.extname(fileName).toLowerCase()
    if (extension === '.tsx') return ts.ScriptKind.TSX
    if (extension === '.jsx') return ts.ScriptKind.JSX
    if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS
    return ts.ScriptKind.TS
}

export function unwrapExpression(expression) {
    let current = expression
    while (
        ts.isParenthesizedExpression(current)
        || ts.isAsExpression(current)
        || ts.isTypeAssertionExpression(current)
        || ts.isNonNullExpression(current)
        || ts.isSatisfiesExpression(current)
        || ts.isAwaitExpression(current)
        || ts.isPartiallyEmittedExpression(current)
    ) current = current.expression
    return current
}

function nodeName(node, sourceFile) {
    if (!node) return '<anonymous>'
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
    return node.getText(sourceFile)
}

export function writeSiteScope(node, sourceFile) {
    const scope = []
    for (let current = node.parent; current; current = current.parent) {
        if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
            scope.push(`Class:${nodeName(current.name, sourceFile)}`)
        } else if (ts.isFunctionDeclaration(current)) {
            scope.push(`Function:${nodeName(current.name, sourceFile)}`)
        } else if (
            ts.isMethodDeclaration(current)
            || ts.isGetAccessorDeclaration(current)
            || ts.isSetAccessorDeclaration(current)
        ) {
            scope.push(`Method:${nodeName(current.name, sourceFile)}`)
        } else if (
            ts.isVariableDeclaration(current)
            && current.initializer
            && (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
        ) {
            scope.push(`Variable:${nodeName(current.name, sourceFile)}`)
        } else if (ts.isPropertyAssignment(current)) {
            scope.push(`Property:${nodeName(current.name, sourceFile)}`)
        }
    }
    return scope.reverse().join('/') || '<module>'
}

function sourceContext(sourceText, fileName) {
    const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKind(fileName))
    const options = {
        allowJs: true,
        checkJs: false,
        jsx: ts.JsxEmit.Preserve,
        noLib: true,
        noResolve: true,
        target: ts.ScriptTarget.Latest,
    }
    const host = ts.createCompilerHost(options)
    host.getSourceFile = (requested) => requested === fileName ? sourceFile : undefined
    host.fileExists = (requested) => requested === fileName
    host.readFile = (requested) => requested === fileName ? sourceText : undefined
    host.writeFile = () => {}
    host.getDefaultLibFileName = () => 'lib.d.ts'
    const rawChecker = ts.createProgram({ rootNames: [fileName], options, host }).getTypeChecker()
    const resolutionDiagnostics = []
    const seenResolutionFailures = new Set()
    const safeResolution = (method, node) => {
        try {
            return rawChecker[method]?.(node)
        } catch (error) {
            if (!(error instanceof RangeError)) throw error
            const start = Math.max(0, node?.pos ?? 0)
            const key = `${method}:${start}`
            if (!seenResolutionFailures.has(key)) {
                seenResolutionFailures.add(key)
                const position = sourceFile.getLineAndCharacterOfPosition(start)
                resolutionDiagnostics.push({
                    code: 'AST_SYMBOL_RESOLUTION_LIMIT',
                    line: position.line + 1,
                    column: position.character + 1,
                    message: `${method} exceeded the TypeScript flow-analysis stack; the site was retained conservatively where possible`,
                })
            }
            return undefined
        }
    }
    const checker = {
        getSymbolAtLocation: (node) => safeResolution('getSymbolAtLocation', node),
        getShorthandAssignmentValueSymbol: (node) => safeResolution('getShorthandAssignmentValueSymbol', node),
    }
    return { checker, resolutionDiagnostics, sourceFile }
}

function unknown() {
    return { kind: 'UNKNOWN' }
}

function prismaModule(module, origin) {
    return { kind: 'PRISMA_MODULE', module, origin, confidence: 'HIGH' }
}

function prismaConstructor(module, origin) {
    return { kind: 'PRISMA_CONSTRUCTOR', module, origin, confidence: 'HIGH' }
}

function client(origin, options = {}) {
    return {
        kind: 'CLIENT',
        origin,
        transaction: Boolean(options.transaction),
        confidence: options.confidence ?? 'HIGH',
    }
}

function delegate(model, source) {
    return {
        kind: 'DELEGATE',
        model,
        origin: source.origin,
        transaction: Boolean(source.transaction),
        confidence: source.confidence ?? 'HIGH',
    }
}

function operation(model, method, source, options = {}) {
    return {
        kind: 'OPERATION',
        model,
        method,
        candidate_models: options.candidateModels ?? (model ? [model] : []),
        origin: source.origin,
        transaction: Boolean(source.transaction),
        confidence: source.confidence ?? 'HIGH',
        ambiguous: Boolean(options.ambiguous),
        ambiguity_reasons: [...new Set(options.reasons ?? [])].sort(),
    }
}

function readOperation(model, method, source, options = {}) {
    return {
        kind: 'READ_OPERATION',
        model,
        method,
        candidate_models: options.candidateModels ?? (model ? [model] : []),
        origin: source.origin,
        transaction: Boolean(source.transaction),
        confidence: source.confidence ?? 'HIGH',
        ambiguous: Boolean(options.ambiguous),
        ambiguity_reasons: [...new Set(options.reasons ?? [])].sort(),
    }
}

function rawOperation(method, source) {
    return {
        kind: 'RAW_OPERATION',
        method,
        origin: source.origin,
        transaction: Boolean(source.transaction),
        confidence: source.confidence ?? 'HIGH',
    }
}

function functionValue(node, origin) {
    return { kind: 'FUNCTION', node, origin, confidence: 'MEDIUM' }
}

function objectValue(properties, origin) {
    return { kind: 'OBJECT', properties, origin, confidence: 'MEDIUM' }
}

function arrayValue(elements, origin) {
    return { kind: 'ARRAY', elements, origin, confidence: 'MEDIUM' }
}

function transactionMethod(source) {
    return {
        kind: 'TRANSACTION_METHOD',
        origin: source.origin,
        transaction: Boolean(source.transaction),
        confidence: source.confidence ?? 'HIGH',
    }
}

function ambiguous(kind, reasons, candidates = []) {
    return {
        kind,
        reasons: [...new Set(reasons)].sort(),
        candidates,
    }
}

function valueIdentity(value) {
    if (!value) return 'UNKNOWN'
    if (value.kind === 'CLIENT') return `CLIENT:${value.origin}:${value.transaction}`
    if (value.kind === 'PRISMA_MODULE') return `MODULE:${value.module}`
    if (value.kind === 'PRISMA_CONSTRUCTOR') return `CONSTRUCTOR:${value.module}`
    if (value.kind === 'DELEGATE') return `DELEGATE:${value.model}:${value.origin}:${value.transaction}`
    if (value.kind === 'OPERATION') return `OPERATION:${value.model}:${value.method}:${value.origin}:${value.transaction}`
    if (value.kind === 'READ_OPERATION') return `READ:${value.model}:${value.method}:${value.origin}:${value.transaction}`
    if (value.kind === 'RAW_OPERATION') return `RAW:${value.method}:${value.origin}:${value.transaction}`
    if (value.kind === 'FUNCTION') return `FUNCTION:${value.node.getStart()}`
    return `${value.kind}:${JSON.stringify(stable(value.reasons ?? []))}`
}

function mergeValues(values, reason) {
    const material = values.filter((value) => value.kind !== 'UNKNOWN')
    if (material.length === 0) return unknown()
    const identities = new Set(material.map(valueIdentity))
    if (identities.size === 1 && material.length === values.length) return material[0]
    return ambiguous('AMBIGUOUS_VALUE', [reason], material)
}

function propertyName(expression) {
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text
    if (ts.isElementAccessExpression(expression)) {
        const argument = unwrapExpression(expression.argumentExpression)
        if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument) || ts.isNumericLiteral(argument)) return argument.text
    }
    return null
}

function moduleSpecifierFromCall(expression) {
    const candidate = unwrapExpression(expression)
    if (!ts.isCallExpression(candidate) || candidate.arguments.length !== 1) return null
    const argument = unwrapExpression(candidate.arguments[0])
    if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
        if (candidate.expression.kind === ts.SyntaxKind.ImportKeyword) return argument.text
        if (ts.isIdentifier(candidate.expression) && candidate.expression.text === 'require') return argument.text
    }
    if (
        ts.isIdentifier(candidate.expression)
        && candidate.expression.text === 'require'
        && (
            /['"](?:[^'"]*\/)?@prisma\/client(?:\/[^'"]*)?['"]/u.test(argument.getText())
            || /['"]@prisma['"][\s\S]*['"]client['"]/u.test(argument.getText())
        )
    ) return '@prisma/client/computed-path'
    return null
}

function isPrismaClientModule(specifier) {
    return specifier === '@prisma/client' || specifier.startsWith('@prisma/client/') || /(?:^|\/)generated\/prisma(?:\/|$)/u.test(specifier)
}

function isPrismaInstanceModule(specifier) {
    return /(?:^|\/)(?:lib\/)?prisma(?:\.[cm]?[jt]s)?$/u.test(specifier)
}

function nearestFunction(node) {
    for (let current = node.parent; current; current = current.parent) {
        if (ts.isFunctionLike(current)) return current
    }
    return null
}

function statementAndBlock(node) {
    let current = node
    while (current.parent && !ts.isBlock(current.parent) && !ts.isSourceFile(current.parent)) {
        if (
            ts.isIfStatement(current.parent)
            || ts.isIterationStatement(current.parent, false)
            || ts.isSwitchStatement(current.parent)
            || ts.isConditionalExpression(current.parent)
        ) return null
        current = current.parent
    }
    return current.parent ? { statement: current, block: current.parent } : null
}

function assignmentDominates(assignment, use) {
    if (nearestFunction(assignment) !== nearestFunction(use)) return false
    const location = statementAndBlock(assignment)
    if (!location) return false
    let useChild = use
    while (useChild.parent && useChild.parent !== location.block) {
        if (ts.isFunctionLike(useChild.parent) && useChild.parent !== nearestFunction(use)) return false
        useChild = useChild.parent
    }
    return useChild.parent === location.block && location.statement.getStart() < useChild.getStart()
}

function staticSqlExpression(expression, checker, sourceFile, seen = new Set()) {
    const candidate = unwrapExpression(expression)
    if (ts.isStringLiteral(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate)) {
        return { sql: candidate.text, dynamic: false }
    }
    if (ts.isTemplateExpression(candidate)) {
        let sql = candidate.head.text
        for (const span of candidate.templateSpans) sql += `${SQL_DYNAMIC_MARKER}${span.literal.text}`
        return { sql, dynamic: candidate.templateSpans.length > 0 }
    }
    if (ts.isBinaryExpression(candidate) && candidate.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = staticSqlExpression(candidate.left, checker, sourceFile, new Set(seen))
        const right = staticSqlExpression(candidate.right, checker, sourceFile, new Set(seen))
        if (!left || !right) return null
        return { sql: left.sql + right.sql, dynamic: left.dynamic || right.dynamic }
    }
    if (!ts.isIdentifier(candidate)) return null
    const symbol = checker.getSymbolAtLocation(candidate)
    if (!symbol || seen.has(symbol)) return null
    seen.add(symbol)
    const declarations = symbol.declarations ?? []
    if (declarations.length !== 1) return null
    const declaration = declarations[0]
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer || declaration.getStart() >= candidate.getStart()) return null
    if (!ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) return null
    return staticSqlExpression(declaration.initializer, checker, sourceFile, seen)
}

function definitelyScalarExpression(expression, checker, seen = new Set()) {
    const candidate = unwrapExpression(expression)
    if (
        ts.isStringLiteral(candidate)
        || ts.isNumericLiteral(candidate)
        || ts.isBigIntLiteral(candidate)
        || ts.isNoSubstitutionTemplateLiteral(candidate)
        || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(candidate.kind)
    ) return true
    if (!ts.isIdentifier(candidate)) return false
    const symbol = checker.getSymbolAtLocation(candidate)
    if (!symbol || seen.has(symbol)) return false
    seen.add(symbol)
    const declarations = symbol.declarations ?? []
    if (declarations.length !== 1) return false
    const declaration = declarations[0]
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return definitelyScalarExpression(declaration.initializer, checker, seen)
    }
    if (ts.isParameter(declaration)) {
        const type = declaration.type?.getText() ?? ''
        return /^(?:string|number|bigint|boolean|Date|null|undefined)(?:\s*\|\s*(?:string|number|bigint|boolean|Date|null|undefined))*$/u.test(type)
    }
    return false
}

function returnExpressionsFromCallable(callable) {
    if (ts.isArrowFunction(callable) && !ts.isBlock(callable.body)) return [callable.body]
    const returns = []
    const pending = callable.body ? [callable.body] : []
    while (pending.length > 0) {
        const node = pending.pop()
        if (node !== callable.body && ts.isFunctionLike(node)) continue
        if (ts.isReturnStatement(node) && node.expression) {
            returns.push(node.expression)
            continue
        }
        ts.forEachChild(node, (child) => { pending.push(child) })
    }
    return returns
}

function returnedExpressionFromCallable(callable) {
    const returns = returnExpressionsFromCallable(callable)
    return returns.length === 1 ? returns[0] : null
}

function interpolationSql(expression, checker, sourceFile, seen = new Set()) {
    const candidate = unwrapExpression(expression)
    if (definitelyScalarExpression(candidate, checker)) return { sql: 'NULL', dynamic: false }
    if (ts.isTaggedTemplateExpression(candidate)) {
        const nested = taggedTemplateSql(candidate.template, checker, sourceFile, seen)
        return { sql: nested?.sql ?? SQL_DYNAMIC_MARKER, dynamic: true }
    }
    if (ts.isIdentifier(candidate)) {
        const symbol = checker.getSymbolAtLocation(candidate)
        if (symbol && !seen.has(symbol)) {
            const nextSeen = new Set(seen).add(symbol)
            const declarations = symbol.declarations ?? []
            if (declarations.length === 1) {
                const declaration = declarations[0]
                if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
                    return interpolationSql(declaration.initializer, checker, sourceFile, nextSeen)
                }
                if (ts.isFunctionDeclaration(declaration)) {
                    const returned = returnedExpressionFromCallable(declaration)
                    if (returned) return interpolationSql(returned, checker, sourceFile, nextSeen)
                }
            }
        }
    }
    if (ts.isCallExpression(candidate)) {
        const callee = unwrapExpression(candidate.expression)
        if (ts.isIdentifier(callee)) {
            const symbol = checker.getSymbolAtLocation(callee)
            if (symbol && !seen.has(symbol)) {
                const declaration = (symbol.declarations ?? []).find((item) => ts.isFunctionLike(item))
                const returned = declaration ? returnedExpressionFromCallable(declaration) : null
                if (returned) return interpolationSql(returned, checker, sourceFile, new Set(seen).add(symbol))
            }
        }
        const embedded = candidate.arguments
            .map((argument) => staticSqlExpression(argument, checker, sourceFile))
            .filter(Boolean)
            .map((value) => value.sql)
            .join(' ')
        return { sql: embedded || SQL_DYNAMIC_MARKER, dynamic: true }
    }
    return { sql: SQL_DYNAMIC_MARKER, dynamic: true }
}

function taggedTemplateSql(template, checker, sourceFile, seen = new Set()) {
    if (ts.isNoSubstitutionTemplateLiteral(template)) return { sql: template.text, dynamic: false }
    if (!ts.isTemplateExpression(template)) return null
    let sql = template.head.text
    let dynamic = false
    for (const span of template.templateSpans) {
        const interpolation = interpolationSql(span.expression, checker, sourceFile, new Set(seen))
        sql += `${interpolation.sql}${span.literal.text}`
        dynamic ||= interpolation.dynamic
    }
    return { sql, dynamic }
}

function diagnostics(sourceFile) {
    return (sourceFile.parseDiagnostics ?? []).map((diagnostic) => {
        const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
        return {
            code: diagnostic.code,
            line: position.line + 1,
            column: position.character + 1,
            message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        }
    })
}

export function analyzePrismaWriteSites(sourceText, options = {}) {
    const fileName = options.fileName ?? 'architecture-write-scan.tsx'
    const { checker, resolutionDiagnostics, sourceFile } = sourceContext(sourceText, fileName)
    const assignments = new Map()
    const transactionCallbackOrigins = new Map()

    function symbolAt(identifier) {
        if (ts.isShorthandPropertyAssignment(identifier.parent) && identifier.parent.name === identifier) {
            const valueSymbol = checker.getShorthandAssignmentValueSymbol?.(identifier.parent)
            if (valueSymbol) return valueSymbol
        }
        return checker.getSymbolAtLocation(identifier)
    }

    function recordAssignment(identifier, node, expression, propertyPath = [], conditional = false) {
        const symbol = symbolAt(identifier)
        if (!symbol) return
        if (!assignments.has(symbol)) assignments.set(symbol, [])
        assignments.get(symbol).push({ node, expression, propertyPath, conditional })
    }

    function collectAssignmentPattern(pattern, node, expression, propertyPath = [], conditional = false) {
        const target = unwrapExpression(pattern)
        if (ts.isIdentifier(target)) {
            recordAssignment(target, node, expression, propertyPath, conditional)
            return
        }
        if (ts.isObjectLiteralExpression(target)) {
            for (const property of target.properties) {
                if (ts.isShorthandPropertyAssignment(property)) {
                    collectAssignmentPattern(property.name, node, expression, [...propertyPath, property.name.text], conditional)
                } else if (ts.isPropertyAssignment(property)) {
                    collectAssignmentPattern(property.initializer, node, expression, [
                        ...propertyPath,
                        nodeName(property.name, sourceFile),
                    ], conditional)
                }
            }
            return
        }
        if (ts.isArrayLiteralExpression(target)) {
            target.elements.forEach((element, index) => {
                if (!ts.isOmittedExpression(element) && !ts.isSpreadElement(element)) {
                    collectAssignmentPattern(element, node, expression, [...propertyPath, String(index)], conditional)
                }
            })
        }
    }

    function collectAssignments(node) {
        if (
            ts.isBinaryExpression(node)
            && [
                ts.SyntaxKind.EqualsToken,
                ts.SyntaxKind.QuestionQuestionEqualsToken,
                ts.SyntaxKind.BarBarEqualsToken,
                ts.SyntaxKind.AmpersandAmpersandEqualsToken,
            ].includes(node.operatorToken.kind)
        ) {
            collectAssignmentPattern(node.left, node, node.right, [], node.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
        }
        ts.forEachChild(node, collectAssignments)
    }
    collectAssignments(sourceFile)
    for (const values of assignments.values()) values.sort((left, right) => left.node.getStart() - right.node.getStart())

    function transactionParameter(declaration, seen) {
        if (!ts.isParameter(declaration)) return null
        const callable = declaration.parent
        if (!ts.isFunctionLike(callable)) return null
        if (transactionCallbackOrigins.has(callable)) {
            return client(`transaction-callback:${transactionCallbackOrigins.get(callable)}`, {
                transaction: true,
                confidence: 'HIGH',
            })
        }
        let parent = callable.parent
        while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent))) parent = parent.parent
        if (!parent || !ts.isCallExpression(parent) || !parent.arguments.includes(callable)) return null
        const resolved = resolveExpression(parent.expression, callable, new Set(seen))
        if (resolved.kind !== 'TRANSACTION_METHOD') return null
        const parameterIndex = callable.parameters.indexOf(declaration)
        if (parameterIndex !== 0) return null
        return client(`transaction-callback:${resolved.origin}`, {
            transaction: true,
            confidence: resolved.confidence,
        })
    }

    function bindingRootAndPath(declaration) {
        const propertyPath = []
        let current = declaration
        while (ts.isBindingElement(current)) {
            const pattern = current.parent
            if (ts.isObjectBindingPattern(pattern)) {
                propertyPath.unshift(nodeName(current.propertyName ?? current.name, sourceFile))
            } else if (ts.isArrayBindingPattern(pattern)) {
                propertyPath.unshift(String(pattern.elements.indexOf(current)))
            } else return null
            const parent = pattern.parent
            if (ts.isBindingElement(parent)) current = parent
            else return { root: parent, propertyPath }
        }
        return null
    }

    function applyPropertyPath(value, propertyPath) {
        let current = value
        for (const property of propertyPath) current = applyProperty(current, property, false)
        return current
    }

    function resolveBindingElement(declaration, use, seen) {
        if (!ts.isBindingElement(declaration)) return unknown()
        const binding = bindingRootAndPath(declaration)
        if (!binding) return unknown()
        let initializer = unknown()
        let propertyPath = binding.propertyPath
        if (ts.isVariableDeclaration(binding.root) && binding.root.initializer) {
            initializer = resolveExpression(binding.root.initializer, use, new Set(seen))
        } else if (ts.isParameter(binding.root)) {
            initializer = transactionParameter(binding.root, new Set(seen)) ?? unknown()
            if (
                initializer.kind === 'UNKNOWN'
                && binding.propertyPath.some((property) => /^(?:prisma|prismaClient)$/u.test(property))
            ) {
                const injectedAt = binding.propertyPath.findIndex((property) => /^(?:prisma|prismaClient)$/u.test(property))
                initializer = ambiguous('AMBIGUOUS_VALUE', ['unproven_prisma_dependency_injection'], [
                    client(`dependency-injected-parameter:${binding.root.getText(sourceFile)}`, { confidence: 'CONSERVATIVE' }),
                ])
                propertyPath = binding.propertyPath.slice(injectedAt + 1)
            }
        }
        return applyPropertyPath(initializer, propertyPath)
    }

    function resolveIdentifier(identifier, use, seen) {
        const symbol = symbolAt(identifier)
        if (!symbol) {
            if (identifier.text === 'prisma' || identifier.text === 'prismaClient') {
                return client(`well-known-identifier:${identifier.text}`, { confidence: 'CONSERVATIVE' })
            }
            return unknown()
        }
        if (seen.has(symbol)) return ambiguous('AMBIGUOUS_VALUE', ['alias_cycle'])
        const nextSeen = new Set(seen)
        nextSeen.add(symbol)

        const declarations = symbol.declarations ?? []
        const initializers = []
        for (const declaration of declarations) {
            const tx = transactionParameter(declaration, nextSeen)
            if (tx) initializers.push(tx)

            if (ts.isImportSpecifier(declaration)) {
                const importDeclaration = declaration.parent.parent.parent
                const specifier = ts.isImportDeclaration(importDeclaration) && ts.isStringLiteral(importDeclaration.moduleSpecifier)
                    ? importDeclaration.moduleSpecifier.text
                    : null
                const importedName = declaration.propertyName?.text ?? declaration.name.text
                if (specifier && isPrismaInstanceModule(specifier) && importedName === 'prisma') {
                    initializers.push(client(`import:${specifier}`, { confidence: 'HIGH' }))
                } else if (specifier && isPrismaClientModule(specifier) && importedName === 'PrismaClient') {
                    initializers.push(prismaConstructor(specifier, `import:${specifier}`))
                }
            } else if (ts.isNamespaceImport(declaration)) {
                const importDeclaration = declaration.parent.parent
                const specifier = ts.isImportDeclaration(importDeclaration) && ts.isStringLiteral(importDeclaration.moduleSpecifier)
                    ? importDeclaration.moduleSpecifier.text
                    : null
                if (specifier && isPrismaClientModule(specifier)) initializers.push(prismaModule(specifier, `import:${specifier}`))
            } else if (ts.isImportClause(declaration)) {
                const importDeclaration = declaration.parent
                const specifier = ts.isImportDeclaration(importDeclaration) && ts.isStringLiteral(importDeclaration.moduleSpecifier)
                    ? importDeclaration.moduleSpecifier.text
                    : null
                if (specifier && isPrismaInstanceModule(specifier)) initializers.push(client(`import:${specifier}`))
            } else if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
                if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
                    initializers.push(functionValue(declaration.initializer, `function:${identifier.text}`))
                } else initializers.push(resolveExpression(declaration.initializer, use, nextSeen))
            } else if (ts.isBindingElement(declaration)) {
                initializers.push(resolveBindingElement(declaration, use, nextSeen))
            } else if (ts.isFunctionDeclaration(declaration)) {
                initializers.push(functionValue(declaration, `function:${identifier.text}`))
            } else if (ts.isParameter(declaration)) {
                const typeText = declaration.type?.getText(sourceFile) ?? ''
                if (/\b(?:TransactionClient|PrismaClient)\b/u.test(typeText)) {
                    initializers.push(client(`typed-parameter:${identifier.text}`, {
                        transaction: typeText.includes('TransactionClient'),
                        confidence: 'MEDIUM',
                    }))
                } else if (/^(?:prisma|prismaClient)$/u.test(identifier.text)) {
                    initializers.push(ambiguous('AMBIGUOUS_VALUE', ['unproven_prisma_dependency_injection'], [
                        client(`dependency-injected-parameter:${identifier.text}`, { confidence: 'CONSERVATIVE' }),
                    ]))
                }
            }
        }

        const priorAssignments = (assignments.get(symbol) ?? []).filter((assignment) => assignment.node.getStart() < use.getStart())
        if (priorAssignments.length > 0) {
            if (priorAssignments.length !== 1 || initializers.some((value) => value.kind !== 'UNKNOWN')) {
                const assignedValues = priorAssignments.map((assignment) => applyPropertyPath(
                    resolveExpression(assignment.expression, use, new Set(nextSeen)),
                    assignment.propertyPath,
                ))
                return ambiguous('AMBIGUOUS_VALUE', ['delegate_reassigned'], [...initializers, ...assignedValues])
            }
            if (!assignmentDominates(priorAssignments[0].node, use)) {
                const assignedValue = applyPropertyPath(
                    resolveExpression(priorAssignments[0].expression, use, new Set(nextSeen)),
                    priorAssignments[0].propertyPath,
                )
                return ambiguous('AMBIGUOUS_VALUE', ['assignment_not_proven_dominating'], [assignedValue])
            }
            const assignedValue = applyPropertyPath(
                resolveExpression(priorAssignments[0].expression, use, nextSeen),
                priorAssignments[0].propertyPath,
            )
            if (priorAssignments[0].conditional) {
                return ambiguous('AMBIGUOUS_VALUE', ['conditional_assignment'], [assignedValue])
            }
            return assignedValue
        }

        const material = initializers.filter((value) => value.kind !== 'UNKNOWN' && value.kind !== 'PRISMA_MODULE')
        if (material.length > 0) return mergeValues(material, 'multiple_alias_declarations')
        return unknown()
    }

    function applyProperty(receiver, property, dynamicProperty) {
        if (receiver.kind === 'PRISMA_MODULE') {
            if (property === 'prisma') return client(`${receiver.origin}:prisma`, { confidence: receiver.confidence })
            if (property === 'PrismaClient') return prismaConstructor(receiver.module, `${receiver.origin}:PrismaClient`)
            return unknown()
        }
        if (receiver.kind === 'OBJECT') return receiver.properties.get(property) ?? unknown()
        if (receiver.kind === 'ARRAY') return receiver.elements[Number(property)] ?? unknown()
        if (receiver.kind === 'OPERATION' && property === 'bind') {
            return { kind: 'BOUND_OPERATION', source: receiver }
        }
        if (receiver.kind === 'CLIENT') {
            if (dynamicProperty) {
                return ambiguous('AMBIGUOUS_DELEGATE', ['dynamic_prisma_delegate'], [receiver])
            }
            if (property === '$transaction') return transactionMethod(receiver)
            if (PRISMA_RAW_METHODS.has(property)) return rawOperation(property, receiver)
            if (property === '$extends') return { kind: 'CLIENT_EXTENSION', source: receiver }
            if (property?.startsWith('$')) return unknown()
            return delegate(property, receiver)
        }
        if (receiver.kind === 'DELEGATE') {
            if (dynamicProperty) {
                return ambiguous('AMBIGUOUS_OPERATION', ['dynamic_prisma_operation'], [receiver])
            }
            if (PRISMA_WRITE_METHODS.has(property)) return operation(receiver.model, property, receiver)
            if (PRISMA_READ_METHODS.has(property)) return readOperation(receiver.model, property, receiver)
            return unknown()
        }
        if (receiver.kind === 'AMBIGUOUS_VALUE' || receiver.kind === 'AMBIGUOUS_DELEGATE') {
            if (dynamicProperty) {
                return ambiguous('AMBIGUOUS_OPERATION', [...receiver.reasons, 'dynamic_prisma_operation'], receiver.candidates)
            }
            const delegates = receiver.candidates.filter((candidate) => candidate.kind === 'DELEGATE')
            const clients = receiver.candidates.filter((candidate) => candidate.kind === 'CLIENT')
            if (
                clients.length > 0
                && property
                && !property.startsWith('$')
                && !PRISMA_WRITE_METHODS.has(property)
                && !(options.includeReads && PRISMA_READ_METHODS.has(property))
            ) {
                return ambiguous('AMBIGUOUS_DELEGATE', [...receiver.reasons, 'unproven_prisma_client'], clients.map((candidate) => (
                    delegate(property, candidate)
                )))
            }
            if (PRISMA_WRITE_METHODS.has(property) && (delegates.length > 0 || receiver.kind === 'AMBIGUOUS_DELEGATE')) {
                return operation(null, property, delegates[0] ?? clients[0] ?? { origin: 'ambiguous', transaction: false, confidence: 'CONSERVATIVE' }, {
                    ambiguous: true,
                    candidateModels: delegates.map((candidate) => candidate.model),
                    reasons: [...receiver.reasons, 'ambiguous_prisma_delegate'],
                })
            }
            if (options.includeReads && PRISMA_READ_METHODS.has(property) && (delegates.length > 0 || receiver.kind === 'AMBIGUOUS_DELEGATE')) {
                return readOperation(null, property, delegates[0] ?? clients[0] ?? { origin: 'ambiguous', transaction: false, confidence: 'CONSERVATIVE' }, {
                    ambiguous: true,
                    candidateModels: delegates.map((candidate) => candidate.model),
                    reasons: [...receiver.reasons, 'ambiguous_prisma_delegate'],
                })
            }
            if (receiver.kind === 'AMBIGUOUS_DELEGATE' && property && !PRISMA_READ_METHODS.has(property)) {
                return ambiguous('AMBIGUOUS_OPERATION', [...receiver.reasons, 'unknown_delegate_model'], receiver.candidates)
            }
        }
        return unknown()
    }

    function resolveExpression(expression, use = expression, seen = new Set()) {
        const candidate = unwrapExpression(expression)
        if (ts.isIdentifier(candidate)) return resolveIdentifier(candidate, use, seen)

        if (ts.isNewExpression(candidate)) {
            const callee = unwrapExpression(candidate.expression)
            const constructor = resolveExpression(callee, use, seen)
            if (constructor.kind === 'PRISMA_CONSTRUCTOR') return client(`new:${constructor.origin}`, { confidence: 'HIGH' })
            return unknown()
        }

        const moduleSpecifier = moduleSpecifierFromCall(candidate)
        if (moduleSpecifier && (isPrismaClientModule(moduleSpecifier) || isPrismaInstanceModule(moduleSpecifier))) {
            return prismaModule(moduleSpecifier, `module:${moduleSpecifier}`)
        }

        if (ts.isCallExpression(candidate)) {
            const callee = resolveExpression(candidate.expression, use, seen)
            if (callee.kind === 'CLIENT_EXTENSION') return client(`${callee.source.origin}:$extends`, {
                transaction: callee.source.transaction,
                confidence: callee.source.confidence,
            })
            if (callee.kind === 'BOUND_OPERATION') return callee.source
            if (callee.kind === 'FUNCTION') {
                const callable = callee.node
                if (seen.has(callable)) return ambiguous('AMBIGUOUS_VALUE', ['recursive_helper_call'])
                const callableSeen = new Set(seen).add(callable)
                const returns = returnExpressionsFromCallable(callable)
                if (returns.length > 0) {
                    const parameterValues = new Map()
                    callable.parameters.forEach((parameter, index) => {
                        if (ts.isIdentifier(parameter.name) && candidate.arguments[index]) {
                            const parameterSymbol = symbolAt(parameter.name)
                            if (parameterSymbol) parameterValues.set(
                                parameterSymbol,
                                resolveExpression(candidate.arguments[index], use, new Set(callableSeen)),
                            )
                        }
                    })
                    const resolveReturned = (returned) => {
                        const unwrapped = unwrapExpression(returned)
                        if (ts.isIdentifier(unwrapped)) {
                            const value = parameterValues.get(symbolAt(unwrapped))
                            if (value) return value
                            return resolveExpression(unwrapped, use, new Set(callableSeen))
                        }
                        if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
                            const receiver = resolveReturned(unwrapped.expression)
                            let returnedProperty = propertyName(unwrapped)
                            if (returnedProperty === null && ts.isElementAccessExpression(unwrapped)) {
                                const argument = unwrapExpression(unwrapped.argumentExpression)
                                if (ts.isIdentifier(argument)) {
                                    const value = parameterValues.get(symbolAt(argument))
                                    if (value?.kind === 'STATIC_PROPERTY') returnedProperty = value.value
                                }
                            }
                            return applyProperty(receiver, returnedProperty, returnedProperty === null)
                        }
                        if (ts.isConditionalExpression(unwrapped)) {
                            return mergeValues([
                                resolveReturned(unwrapped.whenTrue),
                                resolveReturned(unwrapped.whenFalse),
                            ], 'conditional_function_return')
                        }
                        if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken) {
                            return resolveReturned(unwrapped.right)
                        }
                        return resolveExpression(unwrapped, use, new Set(callableSeen))
                    }
                    const returnedValues = returns.map((returned) => {
                        return resolveReturned(returned)
                    })
                    return mergeValues(returnedValues, 'multiple_function_returns')
                }
            }
            return unknown()
        }

        if (ts.isObjectLiteralExpression(candidate)) {
            const properties = new Map()
            for (const property of candidate.properties) {
                if (ts.isPropertyAssignment(property)) {
                    properties.set(nodeName(property.name, sourceFile), resolveExpression(property.initializer, use, new Set(seen)))
                } else if (ts.isShorthandPropertyAssignment(property)) {
                    properties.set(property.name.text, resolveIdentifier(property.name, use, new Set(seen)))
                }
            }
            return objectValue(properties, `object:${candidate.getStart()}`)
        }

        if (ts.isArrayLiteralExpression(candidate)) {
            return arrayValue(candidate.elements.map((element) => (
                ts.isOmittedExpression(element) || ts.isSpreadElement(element)
                    ? unknown()
                    : resolveExpression(element, use, new Set(seen))
            )), `array:${candidate.getStart()}`)
        }

        if (ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate)) {
            let property = propertyName(candidate)
            if (property === null && ts.isElementAccessExpression(candidate)) {
                const argument = unwrapExpression(candidate.argumentExpression)
                if (ts.isIdentifier(argument)) {
                    const symbol = symbolAt(argument)
                    const declarations = symbol?.declarations ?? []
                    if (declarations.length === 1 && ts.isVariableDeclaration(declarations[0]) && declarations[0].initializer) {
                        const initializer = unwrapExpression(declarations[0].initializer)
                        if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) property = initializer.text
                    }
                }
            }
            const receiver = resolveExpression(candidate.expression, use, seen)
            if (receiver.kind === 'UNKNOWN') {
                const memberSymbol = checker.getSymbolAtLocation(candidate.name ?? candidate.argumentExpression)
                const typedDeclaration = (memberSymbol?.declarations ?? []).find((declaration) => {
                    const typeText = declaration.type?.getText(sourceFile) ?? ''
                    return /\b(?:PrismaClient|TransactionClient)\b/u.test(typeText)
                })
                if (typedDeclaration) {
                    const typeText = typedDeclaration.type?.getText(sourceFile) ?? ''
                    return client(`typed-member:${candidate.getText(sourceFile)}`, {
                        transaction: typeText.includes('TransactionClient'),
                        confidence: 'MEDIUM',
                    })
                }
            }
            // Prisma clients are commonly installed on request/class objects
            // in the JavaScript services. Only a member literally named
            // `prisma` is a conservative client seed; an arbitrary `db`
            // member is not sufficient evidence.
            if (property === 'prisma' && receiver.kind === 'UNKNOWN') {
                return ambiguous('AMBIGUOUS_VALUE', ['unproven_prisma_member'], [
                    client(`member:${candidate.getText(sourceFile)}`, { confidence: 'CONSERVATIVE' }),
                ])
            }
            return applyProperty(receiver, property, property === null)
        }

        if (ts.isConditionalExpression(candidate)) {
            return mergeValues([
                resolveExpression(candidate.whenTrue, use, new Set(seen)),
                resolveExpression(candidate.whenFalse, use, new Set(seen)),
            ], 'conditional_delegate')
        }

        if (
            ts.isBinaryExpression(candidate)
            && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(candidate.operatorToken.kind)
        ) {
            return mergeValues([
                resolveExpression(candidate.left, use, new Set(seen)),
                resolveExpression(candidate.right, use, new Set(seen)),
            ], 'logical_delegate_union')
        }

        if (ts.isBinaryExpression(candidate) && candidate.operatorToken.kind === ts.SyntaxKind.CommaToken) {
            return resolveExpression(candidate.right, use, new Set(seen))
        }

        if (candidate.kind === ts.SyntaxKind.ThisKeyword) return unknown()
        return unknown()
    }

    function transactionAnnotation(node, resolved) {
        if (resolved.transaction) {
            return { contained: true, origin: resolved.origin }
        }
        for (let current = node.parent; current; current = current.parent) {
            // A write passed directly in the array form is transaction-owned.
            // Merely being lexically inside a callback is insufficient: global
            // clients and detached callbacks do not use the transaction client.
            if (ts.isCallExpression(current)) {
                const callee = resolveExpression(current.expression, current)
                if (callee.kind === 'TRANSACTION_METHOD') {
                    const firstArgument = current.arguments[0]
                    if (firstArgument && ts.isArrayLiteralExpression(unwrapExpression(firstArgument))) {
                        return { contained: true, origin: callee.origin }
                    }
                }
            }
            if (ts.isFunctionLike(current)) break
        }
        return { contained: false, origin: null }
    }

    function baseRecord(node, resolved) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        const scope = writeSiteScope(node, sourceFile)
        return {
            file: fileName,
            index: node.getStart(sourceFile),
            end: node.getEnd(),
            line: position.line + 1,
            column: position.character + 1,
            scope,
            transaction: transactionAnnotation(node, resolved),
            receiver_origin: resolved.origin ?? null,
            confidence: resolved.confidence ?? 'CONSERVATIVE',
            site_signature: digest(`${scope}\n${node.getText(sourceFile)}`),
        }
    }

    const sites = []

    function nestedWriteShapes(call) {
        const root = unwrapExpression(call.arguments[0])
        if (!root || !ts.isObjectLiteralExpression(root)) return []
        const nestedMethods = new Set([
            'connect', 'connectOrCreate', 'create', 'createMany', 'delete', 'deleteMany',
            'disconnect', 'set', 'update', 'updateMany', 'upsert',
        ])
        const shapes = []
        function walk(object, pathParts) {
            for (const property of object.properties) {
                if (!ts.isPropertyAssignment(property)) continue
                const name = nodeName(property.name, sourceFile)
                const value = unwrapExpression(property.initializer)
                const nextPath = [...pathParts, name]
                if (
                    nestedMethods.has(name)
                    && nextPath.length >= 3
                    && nextPath[0] === 'data'
                ) {
                    shapes.push({
                        relation_field: nextPath[nextPath.length - 2],
                        method: name,
                        path: nextPath.join('.'),
                    })
                }
                if (ts.isObjectLiteralExpression(value)) walk(value, nextPath)
            }
        }
        walk(root, [])
        return shapes.sort((left, right) => left.path.localeCompare(right.path))
    }

    function staticObjectExpression(expression, seen = new Set()) {
        const candidate = unwrapExpression(expression)
        if (ts.isObjectLiteralExpression(candidate)) return candidate
        if (!ts.isIdentifier(candidate)) return null
        const symbol = symbolAt(candidate)
        if (!symbol || seen.has(symbol)) return null
        seen.add(symbol)
        const declarations = symbol.declarations ?? []
        if (declarations.length !== 1) return null
        const declaration = declarations[0]
        if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return null
        return staticObjectExpression(declaration.initializer, seen)
    }

    function projectionFields(object) {
        const fields = []
        let dynamic = false
        for (const property of object.properties) {
            if (ts.isSpreadAssignment(property)) {
                dynamic = true
                continue
            }
            if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
                dynamic = true
                continue
            }
            const name = nodeName(property.name, sourceFile)
            const value = ts.isPropertyAssignment(property) ? unwrapExpression(property.initializer) : null
            if (!value || value.kind === ts.SyntaxKind.TrueKeyword || ts.isObjectLiteralExpression(value)) fields.push(name)
            else if (value.kind !== ts.SyntaxKind.FalseKeyword) dynamic = true
        }
        return { fields: [...new Set(fields)].sort(), dynamic }
    }

    function readProjection(call, method) {
        if (new Set(['count', 'aggregate', 'groupBy']).has(method)) {
            return { mode: 'AGGREGATE', selected_fields: [], omitted_fields: [], dynamic: false }
        }
        const args = call.arguments[0] && staticObjectExpression(call.arguments[0])
        if (!args) return { mode: 'FULL_ROW', selected_fields: [], omitted_fields: [], dynamic: Boolean(call.arguments[0]) }
        for (const property of args.properties) {
            if (!ts.isPropertyAssignment(property)) continue
            const name = nodeName(property.name, sourceFile)
            if (name !== 'select' && name !== 'omit' && name !== 'columns') continue
            const object = staticObjectExpression(property.initializer)
            if (!object) return { mode: name.toUpperCase(), selected_fields: [], omitted_fields: [], dynamic: true }
            const projected = projectionFields(object)
            return {
                mode: name === 'columns' ? 'SELECT' : name.toUpperCase(),
                selected_fields: name === 'select' || name === 'columns' ? projected.fields : [],
                omitted_fields: name === 'omit' ? projected.fields : [],
                dynamic: projected.dynamic,
            }
        }
        return { mode: 'FULL_ROW', selected_fields: [], omitted_fields: [], dynamic: false }
    }

    function addModelSite(node, resolved) {
        const nestedOperations = nestedWriteShapes(node)
        const nestedAmbiguity = nestedOperations.length > 0
        sites.push({
            ...baseRecord(node, resolved),
            kind: resolved.ambiguous || nestedAmbiguity ? 'ambiguous_model' : 'model',
            model: resolved.model,
            candidate_models: [...new Set(resolved.candidate_models ?? [])].sort(),
            method: resolved.method,
            nested_operations: nestedOperations,
            ambiguous: Boolean(resolved.ambiguous) || nestedAmbiguity,
            ambiguity_reasons: [...new Set([
                ...(resolved.ambiguity_reasons ?? []),
                ...(nestedAmbiguity ? ['nested_relation_write_requires_schema_resolution'] : []),
            ])].sort(),
        })
    }

    function addReadSite(node, resolved) {
        sites.push({
            ...baseRecord(node, resolved),
            kind: resolved.ambiguous ? 'ambiguous_read' : 'model_read',
            model: resolved.model,
            candidate_models: [...new Set(resolved.candidate_models ?? [])].sort(),
            method: resolved.method,
            projection: readProjection(node, resolved.method),
            ambiguous: Boolean(resolved.ambiguous),
            ambiguity_reasons: resolved.ambiguity_reasons ?? [],
        })
    }

    function addAmbiguousOperation(node, resolved) {
        sites.push({
            ...baseRecord(node, resolved),
            kind: 'ambiguous_model',
            model: null,
            candidate_models: resolved.candidates?.filter((candidate) => candidate.kind === 'DELEGATE').map((candidate) => candidate.model).sort() ?? [],
            method: null,
            ambiguous: true,
            ambiguity_reasons: [...new Set([...(resolved.reasons ?? []), 'operation_not_statically_resolved'])].sort(),
        })
    }

    function addRawSite(node, resolved, sql) {
        const sqlAnalysis = analyzeSqlMutation(sql?.sql ?? null, { forceDynamic: sql?.dynamic ?? true })
        const queryMethod = resolved.method === '$queryRaw' || resolved.method === '$queryRawUnsafe'
        if (queryMethod && sqlAnalysis.is_mutation === false && !sqlAnalysis.dynamic && !options.includeRawReads) return
        const retainedRead = options.includeRawReads && sqlAnalysis.is_mutation === false
        const executeWithoutMutation = !queryMethod && sqlAnalysis.is_mutation === false && !retainedRead
        const reasons = new Set(sqlAnalysis.reasons)
        if (queryMethod && sqlAnalysis.is_mutation === null) reasons.add('query_raw_intent_unresolved')
        if (queryMethod && sqlAnalysis.is_mutation === false && sqlAnalysis.dynamic) reasons.add('query_raw_dynamic_intent_unresolved')
        if (executeWithoutMutation) reasons.add('execute_raw_mutation_not_recognized')
        sites.push({
            ...baseRecord(node, resolved),
            kind: 'raw',
            model: null,
            candidate_models: [],
            method: resolved.method,
            tables: sqlAnalysis.tables.length > 0 ? sqlAnalysis.tables : (options.includeRawReads ? sqlAnalysis.read_tables : []),
            read_tables: sqlAnalysis.read_tables,
            selected_columns: sqlAnalysis.selected_columns,
            select_all: sqlAnalysis.select_all,
            read_projection_dynamic: sqlAnalysis.read_projection_dynamic,
            operations: sqlAnalysis.operations,
            dynamic: sqlAnalysis.dynamic,
            ambiguous: sqlAnalysis.ambiguous || executeWithoutMutation || sqlAnalysis.is_mutation === null,
            ambiguity_reasons: [...reasons].sort(),
            sql_sha256: sqlAnalysis.sql_sha256,
        })
    }

    function sqlDriverReceiverLooksIntentional(expression) {
        const candidate = unwrapExpression(expression)
        if (candidate.kind === ts.SyntaxKind.ThisKeyword) {
            for (let current = candidate.parent; current; current = current.parent) {
                if (ts.isClassLike(current)) return /(?:database|repository|store|sqlite|postgres|mysql)/iu.test(nodeName(current.name, sourceFile))
            }
            return false
        }
        const text = candidate.getText(sourceFile)
        return /(?:^|\.)(?:db|database|pool|connection|client|queryRunner|sqlite)$/iu.test(text)
    }

    function importSourceForDeclaration(declaration) {
        let current = declaration
        while (current && !ts.isImportDeclaration(current)) current = current.parent
        return current && ts.isStringLiteral(current.moduleSpecifier) ? current.moduleSpecifier.text : null
    }

    function drizzleTableTarget(expression, seen = new Set()) {
        const candidate = unwrapExpression(expression)
        if (ts.isIdentifier(candidate)) {
            const symbol = symbolAt(candidate)
            if (symbol && seen.has(symbol)) return null
            if (symbol) seen.add(symbol)
            const declarations = symbol?.declarations ?? []
            for (const declaration of declarations) {
                if (ts.isImportSpecifier(declaration)) {
                    const specifier = importSourceForDeclaration(declaration)
                    if (specifier && (specifier.includes('/schema') || specifier === '@avito/db')) {
                        return { table: declaration.propertyName?.text ?? candidate.text, confidence: 'HIGH' }
                    }
                }
                if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
                    const initializer = unwrapExpression(declaration.initializer)
                    const aliased = drizzleTableTarget(initializer, seen)
                    if (aliased) return aliased
                    if (ts.isCallExpression(initializer)) {
                        const calleeName = propertyName(initializer.expression)
                            ?? (ts.isIdentifier(initializer.expression) ? initializer.expression.text : null)
                        const firstArgument = initializer.arguments[0] && unwrapExpression(initializer.arguments[0])
                        if (
                            /^(?:pgTable|sqliteTable|mysqlTable)$/u.test(calleeName ?? '')
                            && firstArgument
                            && (ts.isStringLiteral(firstArgument) || ts.isNoSubstitutionTemplateLiteral(firstArgument))
                        ) return { table: firstArgument.text, confidence: 'HIGH' }
                    }
                }
            }
            return null
        }
        if (ts.isPropertyAccessExpression(candidate)) {
            const receiver = unwrapExpression(candidate.expression)
            if (ts.isIdentifier(receiver)) {
                const declaration = (symbolAt(receiver)?.declarations ?? []).find((item) => ts.isNamespaceImport(item))
                const specifier = declaration ? importSourceForDeclaration(declaration) : null
                if (specifier && (specifier.includes('/schema') || specifier === '@avito/db')) return { table: candidate.name.text, confidence: 'HIGH' }
            }
        }
        return null
    }

    function drizzleReceiver(expression, use, seen = new Set()) {
        const candidate = unwrapExpression(expression)
        if (ts.isCallExpression(candidate)) {
            const calleeName = propertyName(candidate.expression)
                ?? (ts.isIdentifier(candidate.expression) ? candidate.expression.text : null)
            if (calleeName === 'drizzle' || calleeName === 'getDb') {
                return { proven: true, transaction: false, origin: `drizzle-factory:${calleeName}`, confidence: 'HIGH' }
            }
            return { proven: false }
        }
        if (ts.isIdentifier(candidate)) {
            const symbol = symbolAt(candidate)
            if (!symbol || seen.has(symbol)) return { proven: false }
            const nextSeen = new Set(seen).add(symbol)
            for (const declaration of symbol.declarations ?? []) {
                const typeText = declaration.type?.getText(sourceFile) ?? ''
                if (/\b(?:Database|NodePgDatabase|PgDatabase|PostgresJsDatabase)\b/u.test(typeText)) {
                    return {
                        proven: true,
                        transaction: /Transaction/u.test(typeText),
                        origin: `typed-drizzle:${candidate.text}`,
                        confidence: 'HIGH',
                    }
                }
                if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
                    const resolved = drizzleReceiver(declaration.initializer, use, nextSeen)
                    if (resolved.proven) return resolved
                }
                if (ts.isParameter(declaration)) {
                    const callable = declaration.parent
                    if (ts.isFunctionLike(callable)) {
                        let parent = callable.parent
                        while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent))) parent = parent.parent
                        if (parent && ts.isCallExpression(parent) && parent.arguments.includes(callable)) {
                            const transactionCallee = unwrapExpression(parent.expression)
                            if (
                                (ts.isPropertyAccessExpression(transactionCallee) || ts.isElementAccessExpression(transactionCallee))
                                && propertyName(transactionCallee) === 'transaction'
                                && drizzleReceiver(transactionCallee.expression, parent, nextSeen).proven
                            ) return {
                                proven: true,
                                transaction: true,
                                origin: `drizzle-transaction:${candidate.text}`,
                                confidence: 'HIGH',
                            }
                        }
                    }
                }
            }
            return { proven: false }
        }
        if (ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate)) {
            const member = checker.getSymbolAtLocation(candidate.name ?? candidate.argumentExpression)
            for (const declaration of member?.declarations ?? []) {
                const typeText = declaration.type?.getText(sourceFile) ?? ''
                if (/\b(?:Database|NodePgDatabase|PgDatabase|PostgresJsDatabase)\b/u.test(typeText)) {
                    return {
                        proven: true,
                        transaction: /Transaction/u.test(typeText),
                        origin: `typed-drizzle-member:${candidate.getText(sourceFile)}`,
                        confidence: 'HIGH',
                    }
                }
            }
        }
        return { proven: false }
    }

    function maybeAddDrizzleSite(node) {
        const callee = unwrapExpression(node.expression)
        if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return false
        let method = propertyName(callee)
        if (method === null && ts.isElementAccessExpression(callee)) {
            const argument = unwrapExpression(callee.argumentExpression)
            if (ts.isIdentifier(argument)) {
                const declarations = symbolAt(argument)?.declarations ?? []
                if (declarations.length === 1 && ts.isVariableDeclaration(declarations[0]) && declarations[0].initializer) {
                    const value = unwrapExpression(declarations[0].initializer)
                    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) method = value.text
                }
            }
        }
        if (node.arguments.length === 0) return false
        const target = drizzleTableTarget(node.arguments[0])
        const receiver = drizzleReceiver(callee.expression, node)
        if (!receiver.proven && (!target || !DRIZZLE_WRITE_METHODS.has(method))) return false
        if (!DRIZZLE_WRITE_METHODS.has(method) && method !== null) return false
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        const scope = writeSiteScope(node, sourceFile)
        const reasons = []
        if (!receiver.proven) reasons.push('unproven_drizzle_receiver')
        if (!target) reasons.push('dynamic_drizzle_table')
        if (method === null) reasons.push('dynamic_drizzle_operation')
        const ambiguousSite = reasons.length > 0
        sites.push({
            file: fileName,
            index: node.getStart(sourceFile),
            end: node.getEnd(),
            line: position.line + 1,
            column: position.character + 1,
            scope,
            transaction: { contained: Boolean(receiver.transaction), origin: receiver.transaction ? receiver.origin : null },
            receiver_origin: receiver.origin ?? `unproven-drizzle:${callee.expression.getText(sourceFile)}`,
            confidence: receiver.confidence ?? 'CONSERVATIVE',
            site_signature: digest(`${scope}\n${node.getText(sourceFile)}`),
            kind: ambiguousSite ? 'ambiguous_model' : 'drizzle',
            model: target?.table ?? null,
            candidate_models: target ? [target.table] : [],
            method,
            ambiguous: ambiguousSite,
            ambiguity_reasons: reasons.sort(),
        })
        return true
    }

    function drizzleSelectProjection(selectCall) {
        if (selectCall.arguments.length === 0) {
            return { mode: 'FULL_ROW', selected_fields: [], omitted_fields: [], dynamic: false }
        }
        const selected = staticObjectExpression(selectCall.arguments[0])
        if (!selected) return { mode: 'SELECT', selected_fields: [], omitted_fields: [], dynamic: true }
        const fields = []
        let dynamic = false
        for (const property of selected.properties) {
            if (!ts.isPropertyAssignment(property)) {
                dynamic = true
                continue
            }
            const value = unwrapExpression(property.initializer)
            if (ts.isPropertyAccessExpression(value)) fields.push(value.name.text)
            else {
                fields.push(nodeName(property.name, sourceFile))
                dynamic = true
            }
        }
        return { mode: 'SELECT', selected_fields: [...new Set(fields)].sort(), omitted_fields: [], dynamic }
    }

    function maybeAddDrizzleReadSite(node) {
        if (!options.includeReads) return false
        const callee = unwrapExpression(node.expression)
        if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return false
        if (propertyName(callee) === 'from' && node.arguments[0]) {
            const target = drizzleTableTarget(node.arguments[0])
            const selectCall = unwrapExpression(callee.expression)
            if (!target || !ts.isCallExpression(selectCall)) return false
            const selectCallee = unwrapExpression(selectCall.expression)
            if (
                !ts.isPropertyAccessExpression(selectCallee)
                && !ts.isElementAccessExpression(selectCallee)
            ) return false
            if (propertyName(selectCallee) !== 'select') return false
            const receiver = drizzleReceiver(selectCallee.expression, node)
            if (!receiver.proven) return false
            const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            const scope = writeSiteScope(node, sourceFile)
            sites.push({
                file: fileName,
                index: node.getStart(sourceFile),
                end: node.getEnd(),
                line: position.line + 1,
                column: position.character + 1,
                scope,
                transaction: { contained: Boolean(receiver.transaction), origin: receiver.transaction ? receiver.origin : null },
                receiver_origin: receiver.origin,
                confidence: receiver.confidence,
                site_signature: digest(`${scope}\n${node.getText(sourceFile)}`),
                kind: 'model_read',
                model: target.table,
                candidate_models: [target.table],
                method: 'drizzle:select',
                projection: drizzleSelectProjection(selectCall),
                ambiguous: false,
                ambiguity_reasons: [],
            })
            return true
        }
        const method = propertyName(callee)
        if (!PRISMA_READ_METHODS.has(method)) return false
        const tableReceiver = unwrapExpression(callee.expression)
        if (!ts.isPropertyAccessExpression(tableReceiver)) return false
        const queryReceiver = unwrapExpression(tableReceiver.expression)
        if (!ts.isPropertyAccessExpression(queryReceiver) || queryReceiver.name.text !== 'query') return false
        const receiver = drizzleReceiver(queryReceiver.expression, node)
        if (!receiver.proven) return false
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        const scope = writeSiteScope(node, sourceFile)
        sites.push({
            file: fileName,
            index: node.getStart(sourceFile),
            end: node.getEnd(),
            line: position.line + 1,
            column: position.character + 1,
            scope,
            transaction: { contained: Boolean(receiver.transaction), origin: receiver.transaction ? receiver.origin : null },
            receiver_origin: receiver.origin,
            confidence: receiver.confidence,
            site_signature: digest(`${scope}\n${node.getText(sourceFile)}`),
            kind: 'model_read',
            model: tableReceiver.name.text,
            candidate_models: [tableReceiver.name.text],
            method: `drizzle:${method}`,
            projection: readProjection(node, method),
            ambiguous: false,
            ambiguity_reasons: [],
        })
        return true
    }

    function maybeAddSqlDriverSite(node) {
        const callee = unwrapExpression(node.expression)
        if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return false
        const method = propertyName(callee)
        if (!SQL_DRIVER_METHODS.has(method)) return false
        const sql = node.arguments.length > 0
            ? staticSqlExpression(node.arguments[0], checker, sourceFile)
            : null
        const sqlAnalysis = analyzeSqlMutation(sql?.sql ?? null, { forceDynamic: sql?.dynamic ?? true })
        if (sqlAnalysis.is_mutation === false && !sqlAnalysis.ambiguous && !options.includeRawReads) return false
        if (!sqlDriverReceiverLooksIntentional(callee.expression)) return false
        addRawSite(node, rawOperation(`sql-driver:${method}`, {
            origin: `sql-driver:${callee.expression.getText(sourceFile)}`,
            transaction: false,
            confidence: sqlAnalysis.is_mutation ? 'MEDIUM' : 'CONSERVATIVE',
        }), sql)
        return true
    }

    function visit(node) {
        if (ts.isCallExpression(node)) {
            const resolved = resolveExpression(node.expression, node)
            if (resolved.kind === 'OPERATION') addModelSite(node, resolved)
            else if (resolved.kind === 'READ_OPERATION' && options.includeReads) addReadSite(node, resolved)
            else if (resolved.kind === 'AMBIGUOUS_OPERATION') addAmbiguousOperation(node, resolved)
            else if (resolved.kind === 'RAW_OPERATION') {
                const sql = node.arguments.length > 0
                    ? staticSqlExpression(node.arguments[0], checker, sourceFile)
                    : null
                addRawSite(node, resolved, sql)
            } else if (!maybeAddDrizzleSite(node) && !maybeAddDrizzleReadSite(node)) maybeAddSqlDriverSite(node)
        } else if (ts.isTaggedTemplateExpression(node)) {
            const resolved = resolveExpression(node.tag, node)
            if (resolved.kind === 'RAW_OPERATION') addRawSite(node, resolved, taggedTemplateSql(node.template, checker, sourceFile))
        }
        ts.forEachChild(node, visit)
    }

    function collectExternalTransactionCallbacks(node) {
        if (ts.isCallExpression(node)) {
            const callee = resolveExpression(node.expression, node)
            if (callee.kind === 'TRANSACTION_METHOD' && node.arguments[0]) {
                const argument = unwrapExpression(node.arguments[0])
                let callable = ts.isFunctionLike(argument) ? argument : null
                if (!callable && ts.isIdentifier(argument)) {
                    const declarations = symbolAt(argument)?.declarations ?? []
                    for (const declaration of declarations) {
                        if (ts.isFunctionDeclaration(declaration)) callable = declaration
                        else if (
                            ts.isVariableDeclaration(declaration)
                            && declaration.initializer
                            && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
                        ) callable = declaration.initializer
                    }
                }
                if (callable) transactionCallbackOrigins.set(callable, callee.origin)
            }
        }
        ts.forEachChild(node, collectExternalTransactionCallbacks)
    }
    collectExternalTransactionCallbacks(sourceFile)
    visit(sourceFile)

    sites.sort((left, right) => left.index - right.index || left.kind.localeCompare(right.kind))
    const signatureCounts = new Map()
    for (const site of sites) signatureCounts.set(site.site_signature, (signatureCounts.get(site.site_signature) ?? 0) + 1)
    const fileDigest = digest(sourceText)
    for (const site of sites) {
        if ((signatureCounts.get(site.site_signature) ?? 0) > 1) {
            site.site_signature = digest(`${site.site_signature}\nduplicate-set:${fileDigest}`)
        }
    }

    return {
        file: fileName,
        sites,
        diagnostics: [...diagnostics(sourceFile), ...resolutionDiagnostics],
        source_sha256: fileDigest,
    }
}

export function extractPrismaWrites(sourceText, options = {}) {
    return analyzePrismaWriteSites(sourceText, options).sites
}
