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
    'all', 'each', 'exec', 'execute', 'executeSql', 'get', 'query', 'run',
])

export const DRIZZLE_WRITE_METHODS = new Set(['insert', 'update', 'delete'])

const NON_RELATION_RESULT_MEMBERS = new Set([
    '_count', 'at', 'catch', 'concat', 'entries', 'every', 'filter', 'finally',
    'find', 'findIndex', 'findLast', 'findLastIndex', 'flat', 'flatMap', 'forEach',
    'includes', 'indexOf', 'join', 'keys', 'lastIndexOf', 'length', 'map', 'pop',
    'push', 'reduce', 'reduceRight', 'reverse', 'shift', 'slice', 'some', 'sort',
    'splice', 'then', 'toJSON', 'toString', 'unshift', 'values',
])

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
    if (!expression) return expression
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
    if (ts.isComputedPropertyName(node)) return '<dynamic>'
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
        return /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u.test(node.text)
            ? node.text
            : `<literal:${digest(node.text).slice(0, 16)}>`
    }
    return `<${ts.SyntaxKind[node.kind] ?? 'syntax'}>`
}

function structuralExpressionOrigin(expression) {
    const candidate = unwrapExpression(expression)
    if (ts.isIdentifier(candidate) || ts.isPrivateIdentifier(candidate)) return `identifier:${candidate.text}`
    if (candidate.kind === ts.SyntaxKind.ThisKeyword) return 'this'
    if (ts.isPropertyAccessExpression(candidate)) {
        return `${structuralExpressionOrigin(candidate.expression)}.${candidate.name.text}`
    }
    if (ts.isElementAccessExpression(candidate)) {
        const property = propertyName(candidate)
        return `${structuralExpressionOrigin(candidate.expression)}.[${property === null ? 'dynamic' : `key:${digest(property).slice(0, 16)}`}]`
    }
    if (ts.isCallExpression(candidate)) return `call:${structuralExpressionOrigin(candidate.expression)}`
    if (ts.isNewExpression(candidate)) return `new:${structuralExpressionOrigin(candidate.expression)}`
    return `syntax:${ts.SyntaxKind[candidate.kind] ?? 'unknown'}`
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
        prepared_sql: source.prepared_sql ?? null,
    }
}

function sqlStatement(sql, source) {
    return {
        kind: 'SQL_STATEMENT',
        sql,
        origin: source.origin,
        transaction: Boolean(source.transaction),
        confidence: source.confidence ?? 'MEDIUM',
    }
}

function sqlPrepareMethod(source) {
    return {
        kind: 'SQL_PREPARE_METHOD',
        origin: source.origin,
        transaction: Boolean(source.transaction),
        confidence: source.confidence ?? 'MEDIUM',
    }
}

function invocation(source, style) {
    return { kind: 'INVOCATION', source, style }
}

function modelResult(source) {
    return {
        kind: 'MODEL_RESULT',
        model: source.model,
        origin: source.origin,
        transaction: source.transaction,
        confidence: source.confidence,
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
    if (value.kind === 'SQL_STATEMENT') return `SQL_STATEMENT:${value.origin}:${JSON.stringify(value.sql)}`
    if (value.kind === 'SQL_PREPARE_METHOD') return `SQL_PREPARE:${value.origin}`
    if (value.kind === 'INVOCATION') return `INVOCATION:${value.style}:${valueIdentity(value.source)}`
    if (value.kind === 'MODEL_RESULT') return `MODEL_RESULT:${value.model}:${value.origin}`
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

function literalPropertyValue(expression) {
    const candidate = unwrapExpression(expression)
    if (ts.isStringLiteral(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate) || ts.isNumericLiteral(candidate)) return candidate.text
    if (ts.isBinaryExpression(candidate) && candidate.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = literalPropertyValue(candidate.left)
        const right = literalPropertyValue(candidate.right)
        return left !== null && right !== null ? left + right : null
    }
    return null
}

function propertyName(expression) {
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text
    if (ts.isElementAccessExpression(expression)) {
        return literalPropertyValue(expression.argumentExpression)
    }
    return null
}

function reflectivePropertyName(expression) {
    const literal = literalPropertyValue(expression)
    if (literal !== null) return literal
    const candidate = unwrapExpression(expression)
    if (
        ts.isCallExpression(candidate)
        && (ts.isPropertyAccessExpression(candidate.expression) || ts.isElementAccessExpression(candidate.expression))
        && ts.isIdentifier(unwrapExpression(candidate.expression.expression))
        && unwrapExpression(candidate.expression.expression).text === 'Symbol'
        && new Set(['for', 'keyFor']).has(propertyName(candidate.expression))
        && candidate.arguments[0]
    ) return literalPropertyValue(candidate.arguments[0])
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
    const knownPrismaModels = new Set(options.knownModels ?? [])
    const knownRelationFields = new Set([
        ...(options.relationFields ?? []),
        ...((options.relationMap instanceof Map) ? options.relationMap.keys() : []),
    ].map((value) => String(value).replace(/_/gu, '').toLowerCase()))
    const { checker, resolutionDiagnostics, sourceFile } = sourceContext(sourceText, fileName)
    const assignments = new Map()
    const memberAssignments = []
    const transactionCallbackOrigins = new Map()
    const transactionOperationNodes = new Set()
    const invocationParameterValues = new Map()

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

    function classIdentity(node) {
        for (let current = node; current; current = current.parent) {
            if (ts.isClassLike(current)) return current.getStart(sourceFile)
        }
        return null
    }

    function memberDescriptor(expression) {
        const pathParts = []
        let current = unwrapExpression(expression)
        while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
            const name = propertyName(current)
            if (name === null) return null
            pathParts.unshift(name)
            current = unwrapExpression(current.expression)
        }
        if (ts.isIdentifier(current)) {
            const symbol = symbolAt(current)
            return symbol ? { root: symbol, class_id: null, path: pathParts } : null
        }
        if (current?.kind === ts.SyntaxKind.ThisKeyword) {
            return { root: null, class_id: classIdentity(current), path: pathParts }
        }
        return null
    }

    function sameMemberRoot(left, right) {
        return left.root ? left.root === right.root : left.class_id !== null && left.class_id === right.class_id
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
            const descriptor = memberDescriptor(node.left)
            if (descriptor?.path.length > 0) memberAssignments.push({
                ...descriptor,
                node,
                expression: node.right,
                conditional: node.operatorToken.kind !== ts.SyntaxKind.EqualsToken,
            })
        }
        if (ts.isPropertyDeclaration(node) && node.initializer && !ts.isComputedPropertyName(node.name)) {
            const owner = classIdentity(node)
            if (owner !== null) memberAssignments.push({
                root: null,
                class_id: owner,
                path: [nodeName(node.name, sourceFile)],
                node,
                expression: node.initializer,
                conditional: false,
            })
        }
        ts.forEachChild(node, collectAssignments)
    }
    collectAssignments(sourceFile)
    for (const values of assignments.values()) values.sort((left, right) => left.node.getStart() - right.node.getStart())
    memberAssignments.sort((left, right) => left.node.getStart() - right.node.getStart())

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
            if (
                SQL_DRIVER_METHODS.has(binding.propertyPath.at(-1))
                && sqlDriverReceiverProven(binding.root.initializer, use)
            ) {
                return rawOperation(`sql-driver:${binding.propertyPath.at(-1)}`, {
                    origin: 'sql-driver:destructured-proven-receiver',
                    transaction: false,
                    confidence: 'MEDIUM',
                })
            }
            initializer = resolveExpression(binding.root.initializer, use, new Set(seen))
        } else if (ts.isParameter(binding.root)) {
            initializer = transactionParameter(binding.root, new Set(seen)) ?? unknown()
            if (
                initializer.kind === 'UNKNOWN'
                && binding.propertyPath.some((property) => /^(?:prisma|prismaClient)$/u.test(property))
            ) {
                const injectedAt = binding.propertyPath.findIndex((property) => /^(?:prisma|prismaClient)$/u.test(property))
                initializer = ambiguous('AMBIGUOUS_VALUE', ['unproven_prisma_dependency_injection'], [
                    client(`dependency-injected-parameter:${digest(`${fileName}:${binding.root.getStart(sourceFile)}`).slice(0, 16)}`, { confidence: 'CONSERVATIVE' }),
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
                const invokedValues = invocationParameterValues.get(symbol) ?? []
                if (invokedValues.length > 0) initializers.push(mergeValues(invokedValues, 'multiple_static_parameter_bindings'))
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
        if ((receiver.kind === 'OPERATION' || receiver.kind === 'READ_OPERATION') && property === 'bind') {
            return { kind: 'BOUND_OPERATION', source: receiver }
        }
        if ((receiver.kind === 'OPERATION' || receiver.kind === 'READ_OPERATION' || receiver.kind === 'RAW_OPERATION') && new Set(['apply', 'call']).has(property)) {
            return invocation(receiver, property)
        }
        if (receiver.kind === 'RAW_OPERATION' && property === 'bind') {
            return { kind: 'BOUND_OPERATION', source: receiver }
        }
        if (receiver.kind === 'SQL_STATEMENT' && new Set(['all', 'get', 'iterate', 'run']).has(property)) {
            return rawOperation(`sql-driver:prepared:${property}`, {
                origin: receiver.origin,
                transaction: receiver.transaction,
                confidence: receiver.confidence,
                prepared_sql: receiver.sql,
            })
        }
        if (receiver.kind === 'SQL_STATEMENT' && new Set(['bind', 'expand', 'pluck', 'raw', 'safeIntegers']).has(property)) {
            return { kind: 'BOUND_OPERATION', source: receiver }
        }
        if (receiver.kind === 'SQL_PREPARE_METHOD' && property === 'bind') {
            return { kind: 'BOUND_OPERATION', source: receiver }
        }
        if (receiver.kind === 'TRANSACTION_METHOD' && property === 'bind') {
            return { kind: 'BOUND_OPERATION', source: receiver }
        }
        if (receiver.kind === 'MODEL_RESULT' && property && !dynamicProperty) {
            if (NON_RELATION_RESULT_MEMBERS.has(property)) return unknown()
            return {
                ...readOperation(property, 'relation', receiver),
                relation_parent_model: receiver.model,
                relation_name: property,
            }
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
        if (!candidate) return unknown()
        // Member assignments, helper returns, and fluent call chains can form
        // real cycles (for example `this.transport = this.transport || ...`).
        // Track expression nodes as well as symbols/callables so repository
        // analysis fails closed instead of overflowing the process stack.
        if (seen.has(candidate)) {
            return ambiguous('AMBIGUOUS_VALUE', ['recursive_expression_resolution'])
        }
        seen = new Set(seen).add(candidate)
        if (ts.isIdentifier(candidate)) return resolveIdentifier(candidate, use, seen)
        if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) {
            return functionValue(candidate, `inline-function:${candidate.getStart(sourceFile)}`)
        }

        if (ts.isNewExpression(candidate)) {
            const callee = unwrapExpression(candidate.expression)
            if (ts.isIdentifier(callee) && callee.text === 'Proxy' && candidate.arguments[0]) {
                const target = resolveExpression(candidate.arguments[0], use, seen)
                if (target.kind === 'DELEGATE') {
                    return ambiguous('AMBIGUOUS_DELEGATE', ['proxy_delegate_requires_review'], [target])
                }
                if (target.kind === 'CLIENT') {
                    return ambiguous('AMBIGUOUS_VALUE', ['proxy_client_requires_review'], [target])
                }
            }
            const constructor = resolveExpression(callee, use, seen)
            if (constructor.kind === 'PRISMA_CONSTRUCTOR') return client(`new:${constructor.origin}`, { confidence: 'HIGH' })
            return unknown()
        }

        const moduleSpecifier = moduleSpecifierFromCall(candidate)
        if (moduleSpecifier && (isPrismaClientModule(moduleSpecifier) || isPrismaInstanceModule(moduleSpecifier))) {
            return prismaModule(moduleSpecifier, `module:${moduleSpecifier}`)
        }

        if (ts.isCallExpression(candidate)) {
            const directCallee = unwrapExpression(candidate.expression)
            if (
                ts.isPropertyAccessExpression(directCallee)
                && ts.isIdentifier(directCallee.expression)
                && directCallee.expression.text === 'Object'
                && directCallee.name.text === 'getOwnPropertyDescriptor'
                && candidate.arguments[0]
            ) {
                const property = candidate.arguments[1]
                    ? reflectivePropertyName(candidate.arguments[1])
                    : null
                let value
                if (
                    property
                    && SQL_DRIVER_METHODS.has(property)
                    && sqlDriverReceiverProven(candidate.arguments[0], use)
                ) {
                    value = rawOperation(`sql-driver:${property}`, {
                        origin: `sql-driver:descriptor:${structuralExpressionOrigin(candidate.arguments[0])}`,
                        transaction: false,
                        confidence: 'MEDIUM',
                    })
                } else {
                    value = applyProperty(
                        resolveExpression(candidate.arguments[0], use, new Set(seen)),
                        property,
                        property === null,
                    )
                }
                return objectValue(new Map([['value', value]]), `descriptor:${candidate.getStart(sourceFile)}`)
            }
            if (
                ts.isPropertyAccessExpression(directCallee)
                && ts.isIdentifier(directCallee.expression)
                && directCallee.expression.text === 'Object'
                && directCallee.name.text === 'assign'
            ) {
                const properties = new Map()
                const clients = []
                for (const argument of candidate.arguments) {
                    const value = resolveExpression(argument, use, new Set(seen))
                    if (value.kind === 'OBJECT') {
                        for (const [name, propertyValue] of value.properties) properties.set(name, propertyValue)
                    } else if (value.kind === 'CLIENT') clients.push(value)
                    else if (value.kind === 'AMBIGUOUS_VALUE') {
                        clients.push(...value.candidates.filter((entry) => entry.kind === 'CLIENT'))
                    }
                }
                if (properties.size > 0 && clients.length === 0) {
                    return objectValue(properties, `object-assign:${candidate.getStart(sourceFile)}`)
                }
                if (clients.length > 0) {
                    return ambiguous('AMBIGUOUS_VALUE', ['object_assign_client_boundary'], clients)
                }
                return objectValue(properties, `object-assign:${candidate.getStart(sourceFile)}`)
            }
            if (
                ts.isPropertyAccessExpression(directCallee)
                && ts.isIdentifier(directCallee.expression)
                && directCallee.expression.text === 'Reflect'
                && directCallee.name.text === 'get'
                && candidate.arguments[0]
            ) {
                const receiver = resolveExpression(candidate.arguments[0], use, seen)
                const key = candidate.arguments[1]
                    ? staticSqlExpression(candidate.arguments[1], checker, sourceFile)
                    : null
                const property = key && !key.dynamic ? key.sql : null
                if (
                    property
                    && SQL_DRIVER_METHODS.has(property)
                    && sqlDriverReceiverProven(candidate.arguments[0], use)
                ) {
                    return rawOperation(`sql-driver:${property}`, {
                        origin: `sql-driver:reflect-get:${structuralExpressionOrigin(candidate.arguments[0])}`,
                        transaction: false,
                        confidence: 'MEDIUM',
                    })
                }
                const dynamicClientBoundary = property === null
                    || (receiver.kind === 'CLIENT' && !knownPrismaModels.has(property))
                return applyProperty(receiver, property, dynamicClientBoundary)
            }
            if (
                (ts.isPropertyAccessExpression(directCallee) || ts.isElementAccessExpression(directCallee))
                && propertyName(directCallee) === 'prepare'
                && sqlDriverReceiverLooksIntentional(directCallee.expression)
            ) {
                const sql = candidate.arguments[0]
                    ? staticSqlExpression(candidate.arguments[0], checker, sourceFile)
                    : null
                return sqlStatement(sql, {
                    origin: `sql-driver:${structuralExpressionOrigin(directCallee.expression)}.prepare`,
                    transaction: false,
                    confidence: sql ? 'HIGH' : 'CONSERVATIVE',
                })
            }
            const callee = resolveExpression(candidate.expression, use, seen)
            if (callee.kind === 'CLIENT_EXTENSION') return client(`${callee.source.origin}:$extends`, {
                transaction: callee.source.transaction,
                confidence: callee.source.confidence,
            })
            if (callee.kind === 'BOUND_OPERATION') return callee.source
            if (callee.kind === 'READ_OPERATION') return modelResult(callee)
            if (callee.kind === 'SQL_PREPARE_METHOD') {
                const sql = candidate.arguments[0]
                    ? staticSqlExpression(candidate.arguments[0], checker, sourceFile)
                    : null
                return sqlStatement(sql, callee)
            }
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
                } else if (ts.isMethodDeclaration(property)) {
                    properties.set(nodeName(property.name, sourceFile), functionValue(property, `object-method:${property.getStart(sourceFile)}`))
                } else if (ts.isSpreadAssignment(property)) {
                    const spread = resolveExpression(property.expression, use, new Set(seen))
                    if (spread.kind === 'OBJECT') {
                        for (const [name, value] of spread.properties) properties.set(name, value)
                    }
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
            const descriptor = memberDescriptor(candidate)
            if (descriptor) {
                const assigned = memberAssignments.filter((assignment) => (
                    sameMemberRoot(assignment, descriptor)
                    && assignment.path.length === descriptor.path.length
                    && assignment.path.every((part, index) => part === descriptor.path[index])
                ))
                if (assigned.length > 0) {
                    const values = assigned.map((assignment) => resolveExpression(assignment.expression, use, new Set(seen)))
                    const merged = mergeValues(values, 'multiple_member_assignments')
                    if (merged.kind !== 'UNKNOWN') {
                        if (assigned.some((assignment) => assignment.conditional)) {
                            return ambiguous('AMBIGUOUS_VALUE', ['conditional_member_assignment'], [merged])
                        }
                        return merged
                    }
                }
            }
            let property = propertyName(candidate)
            if (property === null && ts.isElementAccessExpression(candidate)) {
                const argument = unwrapExpression(candidate.argumentExpression)
                const reflectiveProperty = reflectivePropertyName(argument)
                const staticProperty = staticSqlExpression(argument, checker, sourceFile)
                if (reflectiveProperty !== null) property = reflectiveProperty
                else if (staticProperty && !staticProperty.dynamic) property = staticProperty.sql
                else if (ts.isIdentifier(argument)) {
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
                    return client(`typed-member:${structuralExpressionOrigin(candidate)}`, {
                        transaction: typeText.includes('TransactionClient'),
                        confidence: 'MEDIUM',
                    })
                }
                if (SQL_DRIVER_METHODS.has(property) && sqlDriverReceiverProven(candidate.expression, use)) {
                    return rawOperation(`sql-driver:${property}`, {
                        origin: `sql-driver:${structuralExpressionOrigin(candidate.expression)}`,
                        transaction: false,
                        confidence: 'MEDIUM',
                    })
                }
                if (property === 'prepare' && sqlDriverReceiverLooksIntentional(candidate.expression)) {
                    return sqlPrepareMethod({
                        origin: `sql-driver:${structuralExpressionOrigin(candidate.expression)}.prepare`,
                        transaction: false,
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
                    client(`member:${structuralExpressionOrigin(candidate)}`, { confidence: 'CONSERVATIVE' }),
                ])
            }
            const computedClientBoundary = ts.isElementAccessExpression(candidate)
                && !knownPrismaModels.has(property)
                && (
                receiver.kind === 'CLIENT'
                || receiver.kind === 'MODEL_RESULT'
                || (
                    (receiver.kind === 'AMBIGUOUS_VALUE' || receiver.kind === 'AMBIGUOUS_DELEGATE')
                    && receiver.candidates.some((value) => value.kind === 'CLIENT')
                )
                )
            return applyProperty(receiver, property, property === null || computedClientBoundary)
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

        if (ts.isBinaryExpression(candidate) && candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            return resolveExpression(candidate.right, use, new Set(seen))
        }

        if (candidate.kind === ts.SyntaxKind.ThisKeyword) return unknown()
        return unknown()
    }

    function transactionAnnotation(node, resolved) {
        if (transactionOperationNodes.has(node)) {
            return { contained: true, origin: 'transaction-array:static-alias' }
        }
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

    function nestedWriteShapes(call, resolvedOperation) {
        if (!call.arguments[0]) return []
        const root = immutableProjectionObject(call.arguments[0], call)
        if (!root.object) return []
        const nestedMethods = new Set([
            'connect', 'connectOrCreate', 'create', 'createMany', 'delete', 'deleteMany',
            'disconnect', 'set', 'update', 'updateMany', 'upsert',
        ])
        const shapes = []
        const rootModels = [resolvedOperation.model, ...(resolvedOperation.candidate_models ?? [])].filter(Boolean)
        const isKnownRootRelation = (field) => rootModels.some((model) => knownRelationFields.has(
            `${String(model).replace(/_/gu, '').toLowerCase()}.${String(field).replace(/_/gu, '').toLowerCase()}`,
        ))
        const hasDynamicMembers = (object) => Boolean(object?.properties.some((property) => (
            ts.isSpreadAssignment(property)
            || !ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)
            || ts.isComputedPropertyName(property.name)
        )))
        function objectFieldNames(object) {
            if (!object) return []
            return [...new Set(object.properties.flatMap((property) => {
                if (ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name)) return ['<dynamic>']
                if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return ['<dynamic>']
                return [nodeName(property.name, sourceFile)]
            }))].sort()
        }
        function walk(object, pathParts, relationField = null) {
            for (const property of object.properties) {
                if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue
                const name = nodeName(property.name, sourceFile)
                const value = unwrapExpression(ts.isPropertyAssignment(property) ? property.initializer : property.name)
                const nextPath = [...pathParts, name]
                if (
                    nestedMethods.has(name)
                    && relationField
                    && pathParts[0] === 'data'
                ) {
                    const payload = immutableProjectionObject(value, call)
                    const staticScalarPayload = new Set([
                        ts.SyntaxKind.FalseKeyword,
                        ts.SyntaxKind.NullKeyword,
                        ts.SyntaxKind.TrueKeyword,
                    ]).has(value.kind)
                    shapes.push({
                        relation_field: relationField,
                        method: name,
                        path: nextPath.join('.'),
                        written_fields: objectFieldNames(payload.object),
                        payload_dynamic: payload.dynamic && !staticScalarPayload,
                    })
                }
                const nested = immutableProjectionObject(value, call)
                if (
                    pathParts.length === 1
                    && pathParts[0] === 'data'
                    && isKnownRootRelation(name)
                    && (!nested.object || nested.dynamic || hasDynamicMembers(nested.object))
                ) {
                    shapes.push({
                        relation_field: name,
                        method: 'dynamic',
                        path: nextPath.join('.'),
                        written_fields: objectFieldNames(nested.object),
                        payload_dynamic: true,
                    })
                }
                if (!nested.object) continue
                if (nestedMethods.has(name)) {
                    // create/update branches inside upsert/connectOrCreate are
                    // payload containers for the same relation, not a second
                    // relation operation. Nested relation fields inside those
                    // payloads establish their own relation context below.
                    walk(nested.object, nextPath, null)
                } else if (name === 'data' || name === 'where') {
                    walk(nested.object, nextPath, relationField)
                } else {
                    walk(nested.object, nextPath, name)
                }
            }
        }
        walk(root.object, [], null)
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

    function immutableProjectionObject(expression, use, seen = new Set()) {
        const candidate = unwrapExpression(expression)
        if (ts.isObjectLiteralExpression(candidate)) return { object: candidate, dynamic: false }
        if (!ts.isIdentifier(candidate)) return { object: null, dynamic: true }
        const symbol = symbolAt(candidate)
        if (!symbol || seen.has(symbol)) return { object: null, dynamic: true }
        const nextSeen = new Set(seen)
        nextSeen.add(symbol)
        const declarations = symbol.declarations ?? []
        if (declarations.length !== 1) return { object: null, dynamic: true }
        const declaration = declarations[0]
        if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) {
            return { object: null, dynamic: true }
        }

        // A projection alias is trusted only while it is demonstrably immutable.
        // `const` protects the binding but not its properties, and passing the
        // object to arbitrary code lets that code mutate it before the ORM call.
        let dynamic = (declaration.parent.flags & ts.NodeFlags.Const) === 0
        const candidateStart = candidate.getStart(sourceFile)
        const candidateEnd = candidate.getEnd()
        function visitReference(node) {
            if (dynamic) return
            if (ts.isIdentifier(node) && symbolAt(node) === symbol) {
                if (node.getStart(sourceFile) === candidateStart && node.getEnd() === candidateEnd) return
                if (declarations.some((item) => item.name === node)) return

                let current = node
                while (
                    current.parent
                    && (
                        ts.isParenthesizedExpression(current.parent)
                        || ts.isAsExpression(current.parent)
                        || ts.isTypeAssertionExpression(current.parent)
                        || ts.isNonNullExpression(current.parent)
                    )
                ) current = current.parent

                let target = current
                while (
                    target.parent
                    && (
                        (ts.isPropertyAccessExpression(target.parent) && target.parent.expression === target)
                        || (ts.isElementAccessExpression(target.parent) && target.parent.expression === target)
                    )
                ) target = target.parent
                const targetParent = target.parent
                if (
                    targetParent
                    && ts.isBinaryExpression(targetParent)
                    && targetParent.left === target
                    && targetParent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
                    && targetParent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
                ) {
                    dynamic = true
                    return
                }
                if (
                    targetParent
                    && (
                        ts.isDeleteExpression(targetParent)
                        || ((ts.isPrefixUnaryExpression(targetParent) || ts.isPostfixUnaryExpression(targetParent))
                            && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(targetParent.operator))
                    )
                ) {
                    dynamic = true
                    return
                }

                const parent = current.parent
                if (
                    parent
                    && ts.isPropertyAssignment(parent)
                    && parent.initializer === current
                    && new Set(['select', 'omit', 'columns', 'include', 'with']).has(nodeName(parent.name, sourceFile))
                ) return
                if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === current) return
                if (parent && ts.isElementAccessExpression(parent) && parent.expression === current) return

                // Any other reference is an escape or a reassignment source.
                // This deliberately includes function arguments, returns,
                // spreads, and alias creation.
                dynamic = true
                return
            }
            ts.forEachChild(node, visitReference)
        }
        visitReference(sourceFile)

        const nested = immutableProjectionObject(declaration.initializer, use, nextSeen)
        return { object: nested.object, dynamic: dynamic || nested.dynamic }
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
            if (ts.isComputedPropertyName(property.name)) {
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

    function nestedRelationProjection(expression, depth, use) {
        const candidate = unwrapExpression(expression)
        if (candidate.kind === ts.SyntaxKind.FalseKeyword || candidate.kind === ts.SyntaxKind.NullKeyword) return null
        if (candidate.kind === ts.SyntaxKind.TrueKeyword) {
            return { mode: 'FULL_ROW', selected_fields: [], omitted_fields: [], dynamic: false, nested_relations: [] }
        }
        const resolved = immutableProjectionObject(candidate, use)
        if (!resolved.object || depth >= 8) {
            return { mode: 'FULL_ROW', selected_fields: [], omitted_fields: [], dynamic: true, nested_relations: [] }
        }
        const projection = readProjectionFromOptions(resolved.object, 'findMany', depth + 1, use)
        return { ...projection, dynamic: projection.dynamic || resolved.dynamic }
    }

    function relationSelections(object, depth, use) {
        const relations = []
        for (const property of object.properties) {
            if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue
            if (ts.isComputedPropertyName(property.name)) {
                relations.push({
                    relation: '<dynamic>',
                    projection: { mode: 'FULL_ROW', selected_fields: [], omitted_fields: [], dynamic: true, nested_relations: [] },
                })
                continue
            }
            const relation = nodeName(property.name, sourceFile)
            const expression = ts.isPropertyAssignment(property) ? property.initializer : property.name
            const projection = nestedRelationProjection(expression, depth, use)
            if (projection) relations.push({ relation, projection })
        }
        return relations.sort((left, right) => left.relation.localeCompare(right.relation))
    }

    function readProjectionFromOptions(args, method, depth = 0, use = args) {
        const nestedRelations = []
        let optionsDynamic = args.properties.some((property) => (
            ts.isSpreadAssignment(property)
            || (ts.isPropertyAssignment(property) && (
                ts.isComputedPropertyName(property.name)
                || nodeName(property.name, sourceFile) === 'extras'
            ))
        ))
        for (const property of args.properties) {
            if (ts.isSpreadAssignment(property)) {
                optionsDynamic = true
                continue
            }
            if (!ts.isPropertyAssignment(property)) continue
            if (ts.isComputedPropertyName(property.name)) {
                optionsDynamic = true
                continue
            }
            const name = nodeName(property.name, sourceFile)
            if (name === 'extras') {
                optionsDynamic = true
                continue
            }
            if (name === 'include' || name === 'with') {
                const relationObject = immutableProjectionObject(property.initializer, use)
                optionsDynamic ||= relationObject.dynamic
                if (relationObject.object) nestedRelations.push(...relationSelections(relationObject.object, depth, use))
                else nestedRelations.push({
                    relation: '<dynamic>',
                    projection: { mode: 'FULL_ROW', selected_fields: [], omitted_fields: [], dynamic: true, nested_relations: [] },
                })
                continue
            }
            if (name !== 'select' && name !== 'omit' && name !== 'columns') continue
            const resolved = immutableProjectionObject(property.initializer, use)
            if (!resolved.object) return { mode: name.toUpperCase(), selected_fields: [], omitted_fields: [], dynamic: true, nested_relations: [] }
            const projected = projectionFields(resolved.object)
            if (name === 'select') nestedRelations.push(...relationSelections(resolved.object, depth, use))
            if (name === 'columns') {
                const falseFields = []
                let trueFields = 0
                for (const column of resolved.object.properties) {
                    if (!ts.isPropertyAssignment(column) || ts.isComputedPropertyName(column.name)) continue
                    const value = unwrapExpression(column.initializer)
                    if (value.kind === ts.SyntaxKind.FalseKeyword) falseFields.push(nodeName(column.name, sourceFile))
                    else if (value.kind === ts.SyntaxKind.TrueKeyword) trueFields += 1
                }
                if (falseFields.length > 0 && trueFields === 0) {
                    return {
                        mode: 'OMIT',
                        selected_fields: [],
                        omitted_fields: [...new Set(falseFields)].sort(),
                        dynamic: projected.dynamic || resolved.dynamic || optionsDynamic,
                        nested_relations: nestedRelations,
                    }
                }
            }
            return {
                mode: name === 'columns' ? 'SELECT' : name.toUpperCase(),
                selected_fields: name === 'select' || name === 'columns' ? projected.fields : [],
                omitted_fields: name === 'omit' ? projected.fields : [],
                dynamic: projected.dynamic || resolved.dynamic || optionsDynamic,
                nested_relations: nestedRelations,
            }
        }
        return { mode: 'FULL_ROW', selected_fields: [], omitted_fields: [], dynamic: optionsDynamic, nested_relations: nestedRelations }
    }

    function readProjection(call, method) {
        if (method === 'count') {
            return { mode: 'AGGREGATE', selected_fields: [], omitted_fields: [], dynamic: false, nested_relations: [] }
        }
        if (method === 'aggregate' || method === 'groupBy') {
            const args = call.arguments[0] && immutableProjectionObject(call.arguments[0], call)
            if (!args?.object) return {
                mode: 'AGGREGATE', selected_fields: [], omitted_fields: [], dynamic: Boolean(call.arguments[0]), nested_relations: [],
            }
            const fields = new Set()
            let dynamic = args.dynamic
            for (const property of args.object.properties) {
                if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) {
                    dynamic = true
                    continue
                }
                const name = nodeName(property.name, sourceFile)
                const value = unwrapExpression(property.initializer)
                if (method === 'groupBy' && name === 'by') {
                    if (!ts.isArrayLiteralExpression(value)) {
                        dynamic = true
                        continue
                    }
                    for (const element of value.elements) {
                        const field = literalPropertyValue(element)
                        if (field === null) dynamic = true
                        else fields.add(field)
                    }
                } else if (method === 'aggregate' && name !== '_count') {
                    const selection = immutableProjectionObject(value, call)
                    dynamic ||= selection.dynamic
                    if (!selection.object) continue
                    const projected = projectionFields(selection.object)
                    dynamic ||= projected.dynamic
                    for (const field of projected.fields) fields.add(field)
                }
            }
            return {
                mode: 'AGGREGATE', selected_fields: [...fields].sort(), omitted_fields: [], dynamic, nested_relations: [],
            }
        }
        const args = call.arguments[0] && immutableProjectionObject(call.arguments[0], call)
        if (!args?.object) return {
            mode: 'FULL_ROW',
            selected_fields: [],
            omitted_fields: [],
            dynamic: Boolean(call.arguments[0]),
            nested_relations: [],
        }
        const projection = readProjectionFromOptions(args.object, method, 0, call)
        return { ...projection, dynamic: projection.dynamic || args.dynamic }
    }

    function writePayloadShape(call) {
        const root = call.arguments[0] && immutableProjectionObject(call.arguments[0], call)
        if (!root?.object) return {
            written_fields: [],
            write_projection_dynamic: Boolean(call.arguments[0]),
        }
        let dynamic = root.dynamic
        const fields = new Set()
        for (const property of root.object.properties) {
            if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
                dynamic = true
                continue
            }
            if (ts.isComputedPropertyName(property.name)) {
                dynamic = true
                continue
            }
            if (!new Set(['create', 'data', 'update']).has(nodeName(property.name, sourceFile))) continue
            const data = unwrapExpression(ts.isPropertyAssignment(property) ? property.initializer : property.name)
            const payloads = ts.isArrayLiteralExpression(data)
                ? data.elements.filter((element) => !ts.isOmittedExpression(element) && !ts.isSpreadElement(element))
                : [data]
            if (ts.isArrayLiteralExpression(data) && data.elements.some((element) => ts.isSpreadElement(element))) dynamic = true
            for (const payload of payloads) {
                const resolved = immutableProjectionObject(payload, call)
                dynamic ||= resolved.dynamic
                if (!resolved.object) continue
                for (const field of resolved.object.properties) {
                    if (ts.isSpreadAssignment(field)) {
                        dynamic = true
                        continue
                    }
                    if (!ts.isPropertyAssignment(field) && !ts.isShorthandPropertyAssignment(field)) {
                        dynamic = true
                        continue
                    }
                    if (ts.isComputedPropertyName(field.name)) {
                        dynamic = true
                        continue
                    }
                    fields.add(nodeName(field.name, sourceFile))
                }
            }
        }
        return { written_fields: [...fields].sort(), write_projection_dynamic: dynamic }
    }

    function addModelSite(node, resolved) {
        const nestedOperations = nestedWriteShapes(node, resolved)
        const nestedAmbiguity = nestedOperations.length > 0
        const payload = writePayloadShape(node)
        const dynamicPayloadAmbiguity = payload.write_projection_dynamic
        sites.push({
            ...baseRecord(node, resolved),
            kind: resolved.ambiguous || nestedAmbiguity || dynamicPayloadAmbiguity ? 'ambiguous_model' : 'model',
            model: resolved.model,
            candidate_models: [...new Set(resolved.candidate_models ?? [])].sort(),
            method: resolved.method,
            ...payload,
            return_projection: new Set([
                'create', 'createManyAndReturn', 'delete', 'update', 'updateManyAndReturn', 'upsert',
            ]).has(resolved.method) ? readProjection(node, 'findMany') : null,
            nested_operations: nestedOperations,
            ambiguous: Boolean(resolved.ambiguous) || nestedAmbiguity || dynamicPayloadAmbiguity,
            ambiguity_reasons: [...new Set([
                ...(resolved.ambiguity_reasons ?? []),
                ...(nestedAmbiguity ? ['nested_relation_write_requires_schema_resolution'] : []),
                ...(dynamicPayloadAmbiguity ? ['dynamic_payload_may_contain_nested_write'] : []),
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
            relation_parent_model: resolved.relation_parent_model ?? null,
            relation_name: resolved.relation_name ?? null,
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

    function staticSqlContainer(expression) {
        const candidate = unwrapExpression(expression)
        const direct = staticSqlExpression(candidate, checker, sourceFile)
        if (direct) return direct
        if (!ts.isObjectLiteralExpression(candidate)) return null
        for (const property of candidate.properties) {
            if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) continue
            if (!new Set(['query', 'sql', 'text']).has(nodeName(property.name, sourceFile))) continue
            return staticSqlExpression(property.initializer, checker, sourceFile)
        }
        return null
    }

    function sqlForInvocation(node, resolved) {
        if (resolved.source?.prepared_sql) return resolved.source.prepared_sql
        if (resolved.style === 'call') return node.arguments[1] ? staticSqlContainer(node.arguments[1]) : null
        if (resolved.style === 'apply') {
            const args = node.arguments[1] && unwrapExpression(node.arguments[1])
            return args && ts.isArrayLiteralExpression(args) && args.elements[0]
                ? staticSqlContainer(args.elements[0])
                : null
        }
        return null
    }

    function addRawSite(node, resolved, sql) {
        const sqlAnalysis = analyzeSqlMutation(sql?.sql ?? null, { forceDynamic: sql?.dynamic ?? true })
        const queryMethod = resolved.method === '$queryRaw' || resolved.method === '$queryRawUnsafe'
        const genericDriver = resolved.method?.startsWith('sql-driver:')
        if (
            (queryMethod || genericDriver)
            && sqlAnalysis.is_mutation === false
            && !sqlAnalysis.dynamic
            && !options.includeRawReads
        ) return
        const retainedRead = options.includeRawReads && sqlAnalysis.is_mutation === false
        const executeWithoutMutation = !queryMethod && !genericDriver && sqlAnalysis.is_mutation === false && !retainedRead
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
            selected_column_sources: sqlAnalysis.selected_column_sources ?? [],
            written_columns: sqlAnalysis.written_columns ?? [],
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

    function sqlDriverReceiverProven(expression, use = expression, seen = new Set()) {
        const candidate = unwrapExpression(expression)
        if (!candidate) return false
        if (sqlDriverReceiverLooksIntentional(candidate)) return true
        if (ts.isNewExpression(candidate)) {
            const callee = unwrapExpression(candidate.expression)
            const name = ts.isIdentifier(callee) ? callee.text : propertyName(callee)
            if (/^(?:Client|Database|Pool|Sqlite|SQLite|Sqlite3)$/u.test(name ?? '')) return true
        }
        if (ts.isCallExpression(candidate)) {
            const callee = unwrapExpression(candidate.expression)
            const name = ts.isIdentifier(callee) ? callee.text : propertyName(callee)
            if (
                name === 'assign'
                && (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
                && ts.isIdentifier(unwrapExpression(callee.expression))
                && unwrapExpression(callee.expression).text === 'Object'
            ) return candidate.arguments.some((argument) => sqlDriverReceiverProven(argument, use, new Set(seen)))
            if (/^(?:connect|getDb|getDatabase|openDatabase)$/u.test(name ?? '')) {
                if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
                    return sqlDriverReceiverProven(callee.expression, use, new Set(seen))
                }
                return true
            }
        }
        if (ts.isIdentifier(candidate)) {
            const symbol = symbolAt(candidate)
            if (!symbol || seen.has(symbol)) return false
            const nextSeen = new Set(seen).add(symbol)
            for (const declaration of symbol.declarations ?? []) {
                const typeText = declaration.type?.getText(sourceFile) ?? ''
                if (/\b(?:Client|Database|Pool|PoolClient|Sqlite|SQLite)\b/u.test(typeText)) return true
                if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
                    if (sqlDriverReceiverProven(declaration.initializer, use, nextSeen)) return true
                }
            }
        }
        if (ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate)) {
            return sqlDriverReceiverProven(candidate.expression, use, seen)
        }
        return false
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
                        origin: `typed-drizzle-member:${structuralExpressionOrigin(candidate)}`,
                        confidence: 'HIGH',
                    }
                }
            }
        }
        return { proven: false }
    }

    function drizzleBindingReceiver(root, use, seen) {
        if (ts.isVariableDeclaration(root) && root.initializer) {
            return drizzleReceiver(root.initializer, use, new Set(seen))
        }
        if (ts.isParameter(root)) {
            const typeText = root.type?.getText(sourceFile) ?? ''
            if (/\b(?:Database|NodePgDatabase|PgDatabase|PostgresJsDatabase)\b/u.test(typeText)) {
                return {
                    proven: true,
                    transaction: /Transaction/u.test(typeText),
                    origin: `typed-drizzle-binding:${root.getStart(sourceFile)}`,
                    confidence: 'HIGH',
                }
            }
        }
        return { proven: false }
    }

    function drizzleObjectProperty(expression, property, use, seen) {
        const candidate = unwrapExpression(expression)
        if (ts.isObjectLiteralExpression(candidate)) {
            for (const member of [...candidate.properties].reverse()) {
                if (
                    (ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member))
                    && !ts.isComputedPropertyName(member.name)
                    && nodeName(member.name, sourceFile) === property
                ) {
                    return drizzleOperationReference(
                        ts.isPropertyAssignment(member) ? member.initializer : member.name,
                        use,
                        new Set(seen),
                    )
                }
                if (ts.isSpreadAssignment(member)) {
                    const spread = drizzleObjectProperty(member.expression, property, use, new Set(seen))
                    if (spread) return spread
                }
            }
            return null
        }
        if (ts.isCallExpression(candidate)) {
            const callee = unwrapExpression(candidate.expression)
            if (
                (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
                && ts.isIdentifier(unwrapExpression(callee.expression))
                && unwrapExpression(callee.expression).text === 'Object'
                && propertyName(callee) === 'assign'
            ) {
                for (const argument of [...candidate.arguments].reverse()) {
                    const assigned = drizzleObjectProperty(argument, property, use, new Set(seen))
                    if (assigned) return assigned
                    const receiver = drizzleReceiver(argument, use, new Set(seen))
                    if (receiver.proven && DRIZZLE_WRITE_METHODS.has(property)) {
                        return { method: property, receiver, expression: argument }
                    }
                }
            }
            return null
        }
        if (ts.isIdentifier(candidate)) {
            const symbol = symbolAt(candidate)
            if (!symbol || seen.has(symbol)) return null
            const nextSeen = new Set(seen).add(symbol)
            for (const declaration of symbol.declarations ?? []) {
                if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
                    const result = drizzleObjectProperty(declaration.initializer, property, use, nextSeen)
                    if (result) return result
                }
            }
        }
        return null
    }

    function drizzleOperationReference(expression, use, seen = new Set()) {
        const candidate = unwrapExpression(expression)
        if (!candidate || seen.has(candidate)) return null
        seen = new Set(seen).add(candidate)
        if (ts.isIdentifier(candidate)) {
            const symbol = symbolAt(candidate)
            if (!symbol || seen.has(symbol)) return null
            const nextSeen = new Set(seen).add(symbol)
            for (const declaration of symbol.declarations ?? []) {
                if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
                    const resolved = drizzleOperationReference(declaration.initializer, use, nextSeen)
                    if (resolved) return resolved
                }
                if (ts.isBindingElement(declaration)) {
                    const binding = bindingRootAndPath(declaration)
                    const method = binding?.propertyPath.at(-1)
                    if (!binding || !DRIZZLE_WRITE_METHODS.has(method)) continue
                    const receiver = drizzleBindingReceiver(binding.root, use, nextSeen)
                    if (receiver.proven) return { method, receiver, expression: binding.root }
                }
            }
            return null
        }
        if (ts.isCallExpression(candidate)) {
            const callee = unwrapExpression(candidate.expression)
            if (
                (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
                && propertyName(callee) === 'bind'
            ) return drizzleOperationReference(callee.expression, use, new Set(seen))
            if (
                ts.isPropertyAccessExpression(callee)
                && ts.isIdentifier(callee.expression)
                && callee.expression.text === 'Reflect'
                && callee.name.text === 'get'
                && candidate.arguments[0]
            ) {
                const method = candidate.arguments[1]
                    ? reflectivePropertyName(candidate.arguments[1])
                    : null
                const receiver = drizzleReceiver(candidate.arguments[0], use, new Set(seen))
                if (receiver.proven && (method === null || DRIZZLE_WRITE_METHODS.has(method))) {
                    return { method, receiver, expression: candidate.arguments[0] }
                }
            }
            return null
        }
        if (ts.isElementAccessExpression(candidate)) {
            const receiver = unwrapExpression(candidate.expression)
            const property = reflectivePropertyName(candidate.argumentExpression)
            if (ts.isArrayLiteralExpression(receiver) && property !== null) {
                const element = receiver.elements[Number(property)]
                if (element && !ts.isOmittedExpression(element) && !ts.isSpreadElement(element)) {
                    return drizzleOperationReference(element, use, new Set(seen))
                }
            }
        }
        if (ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate)) {
            const method = ts.isElementAccessExpression(candidate)
                ? reflectivePropertyName(candidate.argumentExpression)
                : propertyName(candidate)
            if (method === 'value') {
                const descriptor = unwrapExpression(candidate.expression)
                if (ts.isCallExpression(descriptor)) {
                    const callee = unwrapExpression(descriptor.expression)
                    if (
                        ts.isPropertyAccessExpression(callee)
                        && ts.isIdentifier(callee.expression)
                        && callee.expression.text === 'Object'
                        && callee.name.text === 'getOwnPropertyDescriptor'
                        && descriptor.arguments[0]
                    ) {
                        const describedMethod = descriptor.arguments[1]
                            ? reflectivePropertyName(descriptor.arguments[1])
                            : null
                        const receiver = drizzleReceiver(descriptor.arguments[0], use, new Set(seen))
                        if (receiver.proven && (describedMethod === null || DRIZZLE_WRITE_METHODS.has(describedMethod))) {
                            return { method: describedMethod, receiver, expression: descriptor.arguments[0] }
                        }
                    }
                }
            }
            const receiver = drizzleReceiver(candidate.expression, use, new Set(seen))
            if (receiver.proven && (method === null || DRIZZLE_WRITE_METHODS.has(method))) {
                return { method, receiver, expression: candidate.expression }
            }
            if (method !== null) {
                const assigned = drizzleObjectProperty(candidate.expression, method, use, new Set(seen))
                if (assigned) return assigned
            }
        }
        return null
    }

    function maybeAddDrizzleSite(node) {
        const callee = unwrapExpression(node.expression)
        const alias = drizzleOperationReference(callee, node)
        const reflected = ts.isCallExpression(callee)
            && ts.isPropertyAccessExpression(unwrapExpression(callee.expression))
            && ts.isIdentifier(unwrapExpression(callee.expression).expression)
            && unwrapExpression(callee.expression).expression.text === 'Reflect'
            && unwrapExpression(callee.expression).name.text === 'get'
            ? callee
            : null
        if (!alias && !reflected && !ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return false
        let method = alias?.method ?? (reflected
            ? (reflected.arguments[1]
                ? staticSqlExpression(reflected.arguments[1], checker, sourceFile)?.sql ?? null
                : null)
            : propertyName(callee))
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
        const receiverExpression = alias?.expression ?? (reflected ? reflected.arguments[0] : callee.expression)
        const receiver = alias?.receiver ?? drizzleReceiver(receiverExpression, node)
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
            receiver_origin: receiver.origin ?? `unproven-drizzle:${structuralExpressionOrigin(receiverExpression)}`,
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
        const selectMethod = propertyName(unwrapExpression(selectCall.expression)) ?? 'select'
        const projectionArgument = selectMethod === 'selectDistinctOn'
            ? selectCall.arguments[1]
            : selectCall.arguments[0]
        if (!projectionArgument) {
            return { mode: 'FULL_ROW', selected_fields: [], selected_field_sources: [], omitted_fields: [], dynamic: false }
        }
        const selected = immutableProjectionObject(projectionArgument, selectCall)
        if (!selected.object) return { mode: 'SELECT', selected_fields: [], selected_field_sources: [], omitted_fields: [], dynamic: true }
        const fields = []
        const sources = []
        let dynamic = selected.dynamic
        for (const property of selected.object.properties) {
            if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) {
                dynamic = true
                continue
            }
            const value = unwrapExpression(property.initializer)
            if (ts.isPropertyAccessExpression(value)) {
                fields.push(value.name.text)
                const target = drizzleTableTarget(value.expression)
                sources.push({ field: value.name.text, table: target?.table ?? null })
                if (!target) dynamic = true
            }
            else {
                fields.push(nodeName(property.name, sourceFile))
                sources.push({ field: nodeName(property.name, sourceFile), table: null })
                dynamic = true
            }
        }
        return {
            mode: 'SELECT',
            selected_fields: [...new Set(fields)].sort(),
            selected_field_sources: sources.sort((left, right) => left.field.localeCompare(right.field) || String(left.table).localeCompare(String(right.table))),
            omitted_fields: [],
            dynamic,
        }
    }

    function drizzleProjectionForTarget(projection, target) {
        if (projection.mode !== 'SELECT') return projection
        const normalizedTarget = String(target).toLowerCase()
        const sources = projection.selected_field_sources ?? []
        const selected = sources
            .filter((entry) => entry.table && String(entry.table).toLowerCase() === normalizedTarget)
            .map((entry) => entry.field)
        const unqualified = sources.filter((entry) => !entry.table).map((entry) => entry.field)
        return {
            ...projection,
            selected_fields: [...new Set([...selected, ...unqualified])].sort(),
            dynamic: projection.dynamic || unqualified.length > 0,
        }
    }

    function drizzleSelectCallInChain(expression) {
        let current = unwrapExpression(expression)
        while (ts.isCallExpression(current)) {
            const callee = unwrapExpression(current.expression)
            if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return null
            if (new Set(['select', 'selectDistinct', 'selectDistinctOn']).has(propertyName(callee))) return current
            current = unwrapExpression(callee.expression)
        }
        return null
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
            if (!new Set(['select', 'selectDistinct', 'selectDistinctOn']).has(propertyName(selectCallee))) return false
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
                method: `drizzle:${propertyName(selectCallee)}`,
                projection: drizzleProjectionForTarget(drizzleSelectProjection(selectCall), target.table),
                ambiguous: false,
                ambiguity_reasons: [],
            })
            return true
        }
        if (new Set(['fullJoin', 'innerJoin', 'leftJoin', 'rightJoin']).has(propertyName(callee)) && node.arguments[0]) {
            const target = drizzleTableTarget(node.arguments[0])
            const selectCall = drizzleSelectCallInChain(callee.expression)
            if (!target || !selectCall) return false
            const selectCallee = unwrapExpression(selectCall.expression)
            if (!ts.isPropertyAccessExpression(selectCallee) && !ts.isElementAccessExpression(selectCallee)) return false
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
                method: `drizzle:${propertyName(callee)}`,
                projection: drizzleProjectionForTarget(drizzleSelectProjection(selectCall), target.table),
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
        let method = propertyName(callee)
        if (method === null && ts.isElementAccessExpression(callee)) {
            method = reflectivePropertyName(callee.argumentExpression)
        }
        if (method !== null && !SQL_DRIVER_METHODS.has(method)) return false
        if (method === null && !ts.isElementAccessExpression(callee)) return false
        let sql = node.arguments.length > 0
            ? staticSqlContainer(node.arguments[0])
            : null
        if (method === null) sql = sql ? { ...sql, dynamic: true } : { sql: null, dynamic: true }
        const sqlAnalysis = analyzeSqlMutation(sql?.sql ?? null, { forceDynamic: sql?.dynamic ?? true })
        if (sqlAnalysis.is_mutation === false && !sqlAnalysis.ambiguous && !options.includeRawReads) return false
        // A SQL-looking string is not sufficient proof that an arbitrary
        // method named `run`, `get`, or `all` is a database call.  Require a
        // receiver whose declaration/type/name can be traced to a supported
        // SQL driver.  This still retains conventional/typed clients and
        // their immutable aliases while excluding ordinary application APIs.
        if (!sqlDriverReceiverProven(callee.expression, node)) return false
        addRawSite(node, rawOperation(`sql-driver:${method ?? '<dynamic>'}`, {
            origin: `sql-driver:${structuralExpressionOrigin(callee.expression)}`,
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
            else if (resolved.kind === 'INVOCATION') {
                if (resolved.source.kind === 'OPERATION') addModelSite(node, resolved.source)
                else if (resolved.source.kind === 'READ_OPERATION' && options.includeReads) addReadSite(node, resolved.source)
                else if (resolved.source.kind === 'RAW_OPERATION') addRawSite(node, resolved.source, sqlForInvocation(node, resolved))
            }
            else if (resolved.kind === 'RAW_OPERATION') {
                const sql = resolved.prepared_sql ?? (node.arguments.length > 0
                    ? staticSqlContainer(node.arguments[0])
                    : null)
                addRawSite(node, resolved, sql)
            } else {
                const callee = unwrapExpression(node.expression)
                const reflectApply = (
                    ts.isPropertyAccessExpression(callee)
                    && ts.isIdentifier(callee.expression)
                    && callee.expression.text === 'Reflect'
                    && callee.name.text === 'apply'
                    && node.arguments[0]
                ) ? resolveExpression(node.arguments[0], node) : null
                if (reflectApply?.kind === 'OPERATION') addModelSite(node, reflectApply)
                else if (reflectApply?.kind === 'READ_OPERATION' && options.includeReads) addReadSite(node, reflectApply)
                else if (reflectApply?.kind === 'RAW_OPERATION') {
                    const args = node.arguments[2] && unwrapExpression(node.arguments[2])
                    const sql = args && ts.isArrayLiteralExpression(args) && args.elements[0]
                        ? staticSqlContainer(args.elements[0])
                        : null
                    addRawSite(node, reflectApply, sql)
                } else if (!maybeAddDrizzleSite(node) && !maybeAddDrizzleReadSite(node)) maybeAddSqlDriverSite(node)
            }
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
                const collectArrayOperations = (expression, seen = new Set()) => {
                    const candidate = unwrapExpression(expression)
                    if (ts.isArrayLiteralExpression(candidate)) {
                        for (const element of candidate.elements) {
                            if (ts.isSpreadElement(element)) collectArrayOperations(element.expression, new Set(seen))
                            else if (!ts.isOmittedExpression(element)) {
                                const item = unwrapExpression(element)
                                if (ts.isCallExpression(item)) transactionOperationNodes.add(item)
                                else collectArrayOperations(item, new Set(seen))
                            }
                        }
                        return
                    }
                    if (!ts.isIdentifier(candidate)) return
                    const symbol = symbolAt(candidate)
                    if (!symbol || seen.has(symbol)) return
                    const nextSeen = new Set(seen).add(symbol)
                    for (const declaration of symbol.declarations ?? []) {
                        if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
                            collectArrayOperations(declaration.initializer, nextSeen)
                        }
                    }
                }
                collectArrayOperations(argument)
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
    function collectStaticInvocationParameters(node) {
        if (ts.isCallExpression(node)) {
            const callee = resolveExpression(node.expression, node)
            if (callee.kind === 'FUNCTION') {
                callee.node.parameters.forEach((parameter, index) => {
                    if (!ts.isIdentifier(parameter.name) || !node.arguments[index]) return
                    const parameterSymbol = symbolAt(parameter.name)
                    if (!parameterSymbol) return
                    const value = resolveExpression(node.arguments[index], node)
                    if (value.kind === 'UNKNOWN') return
                    const values = invocationParameterValues.get(parameterSymbol) ?? []
                    if (!values.some((candidate) => valueIdentity(candidate) === valueIdentity(value))) {
                        values.push(value)
                        invocationParameterValues.set(parameterSymbol, values)
                    }
                })
            }
        }
        ts.forEachChild(node, collectStaticInvocationParameters)
    }
    for (let pass = 0; pass < 3; pass += 1) collectStaticInvocationParameters(sourceFile)
    collectExternalTransactionCallbacks(sourceFile)
    visit(sourceFile)

    sites.sort((left, right) => left.index - right.index || left.kind.localeCompare(right.kind))
    const signatureCounts = new Map()
    for (const site of sites) signatureCounts.set(site.site_signature, (signatureCounts.get(site.site_signature) ?? 0) + 1)
    const fileDigest = digest(sourceText)
    const signatureOrdinals = new Map()
    for (const site of sites) {
        if ((signatureCounts.get(site.site_signature) ?? 0) > 1) {
            const original = site.site_signature
            const ordinal = signatureOrdinals.get(original) ?? 0
            signatureOrdinals.set(original, ordinal + 1)
            site.site_signature = digest(`${original}\nduplicate-set:${fileDigest}\nordinal:${ordinal}\nindex:${site.index}:${site.end}`)
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
