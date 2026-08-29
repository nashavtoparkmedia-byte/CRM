#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const WRITE_METHODS = new Set([
    'create', 'createMany', 'createManyAndReturn', 'update', 'updateMany',
    'upsert', 'delete', 'deleteMany',
])
const PERSISTENCE_CAPABILITY = /(?:Prisma|Transaction|UnitOfWork|WriteCapability|(?:Writer|Repository|Store)(?:Port|Adapter|Client|V[0-9]+))/iu
const PRIVATE_IMPLEMENTATION_TYPE = /(?:Prisma|Transaction|UnitOfWork|WriteCapability|Repository|Adapter|Persistence|(?:Provider|Transport|Database|Db|Sql|Redis|S3|OpenAi|OpenAI)[A-Za-z0-9_]*(?:Client|Handle|Connection)|Client(?:V[0-9]+)?$)/iu

function stable(value) {
    if (Array.isArray(value)) return value.map(stable)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}

function digest(value) {
    return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stable(value))).digest('hex')
}

function lineAt(text, index) {
    let line = 1
    for (let cursor = 0; cursor < index; cursor += 1) if (text.charCodeAt(cursor) === 10) line += 1
    return line
}

function executablePositions(text) {
    const positions = new Uint8Array(text.length)
    let state = 'code'
    let escaped = false
    const templateExpressionDepths = []
    for (let index = 0; index < text.length; index += 1) {
        const current = text[index]
        const next = text[index + 1]
        if (state === 'line') {
            if (current === '\n') state = 'code'
            continue
        }
        if (state === 'block') {
            if (current === '*' && next === '/') {
                index += 1
                state = 'code'
            }
            continue
        }
        if (state === 'single' || state === 'double') {
            if (escaped) escaped = false
            else if (current === '\\') escaped = true
            else if ((state === 'single' && current === "'") || (state === 'double' && current === '"')) state = 'code'
            continue
        }
        if (state === 'template') {
            if (escaped) escaped = false
            else if (current === '\\') escaped = true
            else if (current === '`') state = 'code'
            else if (current === '$' && next === '{') {
                templateExpressionDepths.push(1)
                index += 1
                state = 'code'
            }
            continue
        }

        positions[index] = 1
        if (current === '/' && next === '/') {
            positions[index + 1] = 1
            index += 1
            state = 'line'
        } else if (current === '/' && next === '*') {
            positions[index + 1] = 1
            index += 1
            state = 'block'
        } else if (current === "'") state = 'single'
        else if (current === '"') state = 'double'
        else if (current === '`') state = 'template'
        else if (templateExpressionDepths.length > 0 && current === '{') {
            templateExpressionDepths[templateExpressionDepths.length - 1] += 1
        } else if (templateExpressionDepths.length > 0 && current === '}') {
            templateExpressionDepths[templateExpressionDepths.length - 1] -= 1
            if (templateExpressionDepths.at(-1) === 0) {
                templateExpressionDepths.pop()
                state = 'template'
            }
        }
    }
    return positions
}

function importBindings(clause) {
    if (!clause || clause.isTypeOnly) return []
    const bindings = []
    if (clause.name) bindings.push({ kind: 'default', imported: 'default', local: clause.name.text })
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        bindings.push({ kind: 'namespace', imported: '*', local: clause.namedBindings.name.text })
    } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
            if (!element.isTypeOnly) {
                bindings.push({ kind: 'named', imported: element.propertyName?.text ?? element.name.text, local: element.name.text })
            }
        }
    }
    return bindings
}

function typeImportBindings(clause) {
    if (!clause) return []
    const bindings = []
    if (clause.isTypeOnly && clause.name) bindings.push({ kind: 'default', imported: 'default', local: clause.name.text })
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) && clause.isTypeOnly) {
        bindings.push({ kind: 'namespace', imported: '*', local: clause.namedBindings.name.text })
    } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
            if (clause.isTypeOnly || element.isTypeOnly) {
                bindings.push({ kind: 'named', imported: element.propertyName?.text ?? element.name.text, local: element.name.text })
            }
        }
    }
    return bindings
}

function commonJsRequireAliases(sourceFile) {
    const createRequireFactories = new Set()
    const requireAliases = new Set(['require'])
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue
        if (statement.moduleSpecifier.text !== 'module' && statement.moduleSpecifier.text !== 'node:module') continue
        const clause = statement.importClause
        if (!clause || clause.isTypeOnly) continue
        if (clause.name) createRequireFactories.add(clause.name.text)
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) createRequireFactories.add(clause.namedBindings.name.text)
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const binding of clause.namedBindings.elements) {
                if (!binding.isTypeOnly && (binding.propertyName?.text ?? binding.name.text) === 'createRequire') {
                    createRequireFactories.add(binding.name.text)
                }
            }
        }
    }
    const isCreateRequireFactory = (expression) => {
        const candidate = unwrapExpression(expression)
        if (ts.isIdentifier(candidate)) return createRequireFactories.has(candidate.text)
        return ts.isPropertyAccessExpression(candidate)
            && candidate.name.text === 'createRequire'
            && (ts.isIdentifier(candidate.expression) || ts.isPropertyAccessExpression(candidate.expression))
    }
    const isModuleRequire = (expression) => {
        const candidate = unwrapExpression(expression)
        return ts.isPropertyAccessExpression(candidate)
            && candidate.name.text === 'require'
            && ts.isIdentifier(candidate.expression)
            && candidate.expression.text === 'module'
    }
    for (let pass = 0; pass < sourceFile.statements.length + 2; pass += 1) {
        let changed = false
        function visit(node) {
            if (ts.isVariableDeclaration(node) && node.initializer) {
                const initializer = unwrapExpression(node.initializer)
                const nodeModuleRequire = ts.isCallExpression(initializer)
                    && ts.isIdentifier(initializer.expression)
                    && requireAliases.has(initializer.expression.text)
                    && initializer.arguments.length === 1
                    && ts.isStringLiteralLike(initializer.arguments[0])
                    && (initializer.arguments[0].text === 'module' || initializer.arguments[0].text === 'node:module')
                if (nodeModuleRequire && ts.isObjectBindingPattern(node.name)) {
                    for (const element of node.name.elements) {
                        const imported = element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile)
                        if (imported === 'createRequire' && ts.isIdentifier(element.name) && !createRequireFactories.has(element.name.text)) {
                            createRequireFactories.add(element.name.text)
                            changed = true
                        }
                    }
                }
                if (!ts.isIdentifier(node.name)) {
                    ts.forEachChild(node, visit)
                    return
                }
                const factoryCall = ts.isCallExpression(initializer) && isCreateRequireFactory(initializer.expression)
                const moduleRequire = isModuleRequire(initializer)
                const aliasCall = ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) && requireAliases.has(initializer.expression.text)
                if ((factoryCall || moduleRequire || aliasCall) && !requireAliases.has(node.name.text)) {
                    requireAliases.add(node.name.text)
                    changed = true
                }
            }
            ts.forEachChild(node, visit)
        }
        visit(sourceFile)
        if (!changed) break
    }
    return requireAliases
}

function moduleLoadKind(expression, requireAliases = new Set(['require'])) {
    const candidate = unwrapExpression(expression)
    if (candidate.kind === ts.SyntaxKind.ImportKeyword) return 'dynamic'
    if (ts.isIdentifier(candidate) && requireAliases.has(candidate.text)) return 'require'
    if (
        ts.isPropertyAccessExpression(candidate)
        && candidate.name.text === 'require'
        && ts.isIdentifier(candidate.expression)
        && candidate.expression.text === 'module'
    ) return 'require'
    return null
}

function moduleLoadCalls(sourceFile) {
    const requireAliases = commonJsRequireAliases(sourceFile)
    const records = []
    function visit(node) {
        if (ts.isCallExpression(node)) {
            const kind = moduleLoadKind(node.expression, requireAliases)
            if (kind) {
                const argument = node.arguments[0]
                records.push({
                    kind,
                    specifier: node.arguments.length === 1 && argument && ts.isStringLiteralLike(argument) ? argument.text : null,
                    index: node.getStart(sourceFile),
                })
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return records
}

function requireBindingRecords(sourceFile) {
    const aliases = commonJsRequireAliases(sourceFile)
    const records = []
    function visit(node) {
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(unwrapExpression(node.initializer))) {
            const call = unwrapExpression(node.initializer)
            const kind = moduleLoadKind(call.expression, aliases)
            const argument = call.arguments[0]
            if (kind === 'require' && call.arguments.length === 1 && argument && ts.isStringLiteralLike(argument)) {
                if (ts.isIdentifier(node.name)) {
                    records.push({ specifier: argument.text, local: node.name.text, imported: '*', namespace: true })
                } else if (ts.isObjectBindingPattern(node.name)) {
                    for (const element of node.name.elements) {
                        if (ts.isIdentifier(element.name)) {
                            records.push({
                                specifier: argument.text,
                                local: element.name.text,
                                imported: element.propertyName?.getText(sourceFile) ?? element.name.text,
                                namespace: false,
                            })
                        }
                    }
                } else {
                    for (const local of declarationNames(node.name)) records.push({ specifier: argument.text, local, imported: '*', namespace: false })
                }
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return records
}

export function extractImports(text) {
    const sourceFile = ts.createSourceFile('module-load.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const found = []
    const push = (record) => found.push(record)
    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
            const types = typeImportBindings(statement.importClause)
            push({
                kind: 'static',
                specifier: statement.moduleSpecifier.text,
                index: statement.getStart(sourceFile),
                imports: importBindings(statement.importClause),
                ...(types.length > 0 ? { typeImports: types } : {}),
            })
        } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
            const imports = statement.exportClause && ts.isNamedExports(statement.exportClause)
                ? statement.exportClause.elements.filter((element) => !statement.isTypeOnly && !element.isTypeOnly).map((element) => ({
                    kind: 'named', imported: element.propertyName?.text ?? element.name.text, local: element.name.text,
                }))
                : []
            const typeImports = statement.exportClause && ts.isNamedExports(statement.exportClause)
                ? statement.exportClause.elements.filter((element) => statement.isTypeOnly || element.isTypeOnly).map((element) => ({
                    kind: 'named', imported: element.propertyName?.text ?? element.name.text, local: element.name.text,
                }))
                : []
            push({
                kind: 'export',
                specifier: statement.moduleSpecifier.text,
                index: statement.getStart(sourceFile),
                imports,
                ...(typeImports.length > 0 ? { typeImports } : {}),
            })
        } else if (
            ts.isImportEqualsDeclaration(statement)
            && ts.isExternalModuleReference(statement.moduleReference)
            && statement.moduleReference.expression
            && ts.isStringLiteralLike(statement.moduleReference.expression)
        ) {
            push({
                kind: 'require',
                specifier: statement.moduleReference.expression.text,
                index: statement.getStart(sourceFile),
                imports: [{ kind: 'namespace', imported: '*', local: statement.name.text }],
            })
        }
    }
    for (const loaded of moduleLoadCalls(sourceFile)) {
        if (loaded.specifier) push({ kind: loaded.kind, specifier: loaded.specifier, index: loaded.index, imports: [] })
    }
    function visitImportTypes(node) {
        if (
            ts.isImportTypeNode(node)
            && ts.isLiteralTypeNode(node.argument)
            && ts.isStringLiteralLike(node.argument.literal)
        ) {
            push({
                kind: 'type-import',
                specifier: node.argument.literal.text,
                index: node.getStart(sourceFile),
                imports: [],
            })
        }
        ts.forEachChild(node, visitImportTypes)
    }
    visitImportTypes(sourceFile)
    const seen = new Set()
    return found.filter((record) => {
        const key = `${record.kind}:${record.index}:${record.specifier}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    }).sort((left, right) => left.index - right.index || left.specifier.localeCompare(right.specifier))
}

function extractClosureImports(text) {
    return extractImports(text)
}

export function extractNonliteralModuleLoads(text) {
    const sourceFile = ts.createSourceFile('module-load.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    return moduleLoadCalls(sourceFile)
        .filter((record) => !record.specifier)
        .map((record) => ({ kind: record.kind === 'dynamic' ? 'dynamic-import' : 'require', index: record.index }))
}

export function extractCommonJsPublicExposure(text) {
    const sourceFile = ts.createSourceFile('commonjs-public.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const records = []
    const add = (index, subject) => records.push({ index, subject })
    function visit(node) {
        if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
            add(node.getStart(sourceFile), 'public-commonjs-import-equals')
        } else if (ts.isBinaryExpression(node) && assignmentOperator(node.operatorToken.kind) && isCommonJsExportTarget(node.left)) {
            add(node.getStart(sourceFile), 'public-commonjs-export-assignment')
        } else if (ts.isCallExpression(node)) {
            const kind = mutationCallKind(node.expression)
            if (kind && node.arguments[0] && isCommonJsExportTarget(node.arguments[0])) {
                add(node.getStart(sourceFile), `public-commonjs-${kind}`)
            }
            const expression = unwrapExpression(node.expression)
            if (
                ts.isPropertyAccessExpression(expression)
                && expression.name.text === 'require'
                && ts.isIdentifier(expression.expression)
                && expression.expression.text === 'module'
            ) add(node.getStart(sourceFile), 'public-commonjs-module-require')
        }
        ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return records
}

function hasExportModifier(node) {
    return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

export function extractPublicWriteCapabilityExposure(text) {
    const sourceFile = ts.createSourceFile('public-facade.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const records = []
    const recordParameters = (node, name) => {
        for (const parameter of node.parameters ?? []) {
            const parameterText = parameter.getText(sourceFile)
            if (PERSISTENCE_CAPABILITY.test(parameterText)) {
                records.push({ index: parameter.getStart(sourceFile), subject: `${name}:parameter:${parameterText}` })
            }
        }
    }
    for (const statement of sourceFile.statements) {
        if (!hasExportModifier(statement)) continue
        if (
            ts.isInterfaceDeclaration(statement)
            || ts.isTypeAliasDeclaration(statement)
            || ts.isClassDeclaration(statement)
        ) {
            const name = statement.name?.text ?? '<anonymous>'
            if (PERSISTENCE_CAPABILITY.test(name) || PERSISTENCE_CAPABILITY.test(statement.getText(sourceFile))) {
                records.push({ index: statement.getStart(sourceFile), subject: `exported-capability:${name}` })
            }
            continue
        }
        if (ts.isFunctionDeclaration(statement)) {
            recordParameters(statement, statement.name?.text ?? '<anonymous>')
            continue
        }
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (!declaration.initializer) continue
                const initializer = unwrapExpression(declaration.initializer)
                if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
                    recordParameters(initializer, declaration.name.getText(sourceFile))
                }
            }
        }
    }
    return records
}

export function extractUnsafeApplicationCompositionExports(text) {
    const sourceFile = ts.createSourceFile('application-composition.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const records = []
    for (const statement of sourceFile.statements) {
        if (ts.isExportDeclaration(statement)) {
            if (!statement.isTypeOnly) records.push({ index: statement.getStart(sourceFile), subject: 'composition-value-reexport' })
            continue
        }
        if (ts.isExportAssignment(statement)) {
            records.push({ index: statement.getStart(sourceFile), subject: 'composition-default-export' })
            continue
        }
        if (!hasExportModifier(statement)) continue
        if (ts.isFunctionDeclaration(statement)) continue
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                const initializer = declaration.initializer && unwrapExpression(declaration.initializer)
                if (!initializer || (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer))) {
                    records.push({ index: declaration.getStart(sourceFile), subject: `composition-nonfunction-export:${declaration.name.getText(sourceFile)}` })
                }
            }
            continue
        }
        if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) {
            records.push({ index: statement.getStart(sourceFile), subject: `composition-unsupported-export:${ts.SyntaxKind[statement.kind]}` })
        }
    }
    return records
}

export function extractUnsafeContactMergeCompositionExports(text) {
    const sourceFile = ts.createSourceFile('contact-merge-composition.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const records = []
    const exactFactoryImports = []
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue
        if (statement.moduleSpecifier.text !== '@/modules/contacts/public/v1') continue
        for (const binding of importBindings(statement.importClause)) {
            if (binding.kind === 'named' && binding.imported === 'createMergeContactsHandlerV1' && binding.local === 'createMergeContactsHandlerV1') {
                exactFactoryImports.push(binding)
            }
        }
    }
    if (exactFactoryImports.length !== 1) {
        records.push({ index: 0, subject: 'contact-merge-unproven-factory-provenance' })
    }
    let factoryShadow = null
    function visitFactoryShadow(node) {
        if (factoryShadow) return
        const declaresFactory = (name) => declarationNames(name).includes('createMergeContactsHandlerV1')
        if (
            (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
                || ts.isParameter(node) || ts.isImportEqualsDeclaration(node))
            && node.name
            && declaresFactory(node.name)
        ) factoryShadow = node
        ts.forEachChild(node, visitFactoryShadow)
    }
    visitFactoryShadow(sourceFile)
    if (factoryShadow) {
        records.push({
            index: factoryShadow.getStart(sourceFile),
            subject: 'contact-merge-shadowed-factory-provenance',
        })
    }
    for (const statement of sourceFile.statements) {
        if (ts.isExportDeclaration(statement)) {
            if (!statement.isTypeOnly) records.push({ index: statement.getStart(sourceFile), subject: 'contact-merge-value-reexport' })
            continue
        }
        if (ts.isExportAssignment(statement)) {
            records.push({ index: statement.getStart(sourceFile), subject: 'contact-merge-default-export' })
            continue
        }
        if (!hasExportModifier(statement)) continue
        if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue
        if (!ts.isVariableStatement(statement)) {
            records.push({ index: statement.getStart(sourceFile), subject: `contact-merge-unsupported-export:${ts.SyntaxKind[statement.kind]}` })
            continue
        }
        for (const declaration of statement.declarationList.declarations) {
            const initializer = declaration.initializer && unwrapExpression(declaration.initializer)
            const exactBusinessComposition = ts.isIdentifier(declaration.name)
                && declaration.name.text === 'mergeContactsV1'
                && initializer
                && ts.isCallExpression(initializer)
                && ts.isIdentifier(initializer.expression)
                && initializer.expression.text === 'createMergeContactsHandlerV1'
            if (!exactBusinessComposition) {
                records.push({
                    index: declaration.getStart(sourceFile),
                    subject: `contact-merge-nonbusiness-export:${declaration.name.getText(sourceFile)}`,
                })
            }
        }
    }
    return records
}

export function extractEnvironmentAccess(text) {
    const records = []
    const executable = executablePositions(text)
    const patterns = [
        /process\.env\.([A-Z][A-Z0-9_]*)/g,
        /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
        /\benv\(['"]([A-Z][A-Z0-9_]*)['"]\)/g,
    ]
    const seen = new Set()
    for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
            if (!executable[match.index]) continue
            const key = `${match.index}:${match[1]}`
            if (seen.has(key)) continue
            seen.add(key)
            records.push({ index: match.index, name: match[1] })
        }
    }
    return records
}

function isPrismaNamespace(expression, checker, seen = new Set()) {
    const candidate = unwrapExpression(expression)
    if (ts.isIdentifier(candidate) && candidate.text === 'Prisma') return true
    if (!ts.isIdentifier(candidate)) return false
    const symbol = checker.getSymbolAtLocation(candidate)
    if (!symbol || seen.has(symbol)) return false
    seen.add(symbol)
    for (const declaration of symbol.declarations ?? []) {
        if (
            ts.isVariableDeclaration(declaration)
            && declaration.initializer
            && declaration.getStart() < candidate.getStart()
            && isPrismaNamespace(declaration.initializer, checker, seen)
        ) return true
    }
    return false
}

function prismaFragmentMemberKind(expression, checker, seen = new Set()) {
    const candidate = unwrapExpression(expression)
    if (ts.isPropertyAccessExpression(candidate)) {
        const kind = candidate.name.text
        return (kind === 'raw' || kind === 'sql') && isPrismaNamespace(candidate.expression, checker, seen)
            ? kind
            : null
    }
    if (
        ts.isElementAccessExpression(candidate)
        && (ts.isStringLiteral(candidate.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(candidate.argumentExpression))
    ) {
        const kind = candidate.argumentExpression.text
        return (kind === 'raw' || kind === 'sql') && isPrismaNamespace(candidate.expression, checker, seen)
            ? kind
            : null
    }
    if (!ts.isIdentifier(candidate)) return null
    const symbol = checker.getSymbolAtLocation(candidate)
    if (!symbol || seen.has(symbol)) return null
    seen.add(symbol)
    for (const declaration of symbol.declarations ?? []) {
        if (
            ts.isVariableDeclaration(declaration)
            && declaration.initializer
            && declaration.getStart() < candidate.getStart()
        ) {
            const kind = prismaFragmentMemberKind(declaration.initializer, checker, seen)
            if (kind) return kind
        }
        if (ts.isBindingElement(declaration)) {
            const kind = ts.isIdentifier(declaration.propertyName ?? declaration.name)
                ? (declaration.propertyName ?? declaration.name).text
                : null
            const variable = declaration.parent.parent
            if (
                (kind === 'raw' || kind === 'sql')
                && ts.isVariableDeclaration(variable)
                && variable.initializer
                && isPrismaNamespace(variable.initializer, checker, seen)
            ) return kind
        }
        if (ts.isImportSpecifier(declaration)) {
            const kind = declaration.propertyName?.text ?? declaration.name.text
            if (kind === 'raw' || kind === 'sql') return kind
        }
    }
    return null
}

function initializerCouldCarrySql(expression, checker, seen = new Set()) {
    const candidate = unwrapExpression(expression)
    if (ts.isAwaitExpression(candidate)) return initializerCouldCarrySql(candidate.expression, checker, seen)
    if (ts.isTaggedTemplateExpression(candidate)) return true
    if (ts.isCallExpression(candidate)) {
        if (prismaFragmentMemberKind(candidate.expression, checker, new Set(seen))) return true
        const callee = unwrapExpression(candidate.expression)
        const symbol = checker.getSymbolAtLocation(callee)
            ?? (ts.isPropertyAccessExpression(callee) ? checker.getSymbolAtLocation(callee.name) : null)
        if (!symbol || seen.has(symbol)) return false
        seen.add(symbol)
        for (const declaration of symbol.declarations ?? []) {
            let body = null
            if (
                ts.isFunctionDeclaration(declaration)
                || ts.isMethodDeclaration(declaration)
                || ts.isFunctionExpression(declaration)
                || ts.isArrowFunction(declaration)
            ) body = declaration.body ?? null
            if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
                const initializer = unwrapExpression(declaration.initializer)
                if (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer)) body = initializer.body
            }
            if (!body) continue
            if (!ts.isBlock(body)) {
                if (initializerCouldCarrySql(body, checker, seen)) return true
                continue
            }
            let carries = false
            function inspect(node) {
                if (ts.isReturnStatement(node)) {
                    if (node.expression && initializerCouldCarrySql(node.expression, checker, seen)) carries = true
                    return
                }
                if (
                    ts.isFunctionDeclaration(node)
                    || ts.isFunctionExpression(node)
                    || ts.isArrowFunction(node)
                    || ts.isMethodDeclaration(node)
                ) return
                if (!carries) ts.forEachChild(node, inspect)
            }
            inspect(body)
            if (carries) return true
        }
        return false
    }
    if (ts.isIdentifier(candidate)) {
        if (prismaFragmentMemberKind(candidate, checker, new Set(seen))) return true
        const symbol = checker.getSymbolAtLocation(candidate)
        if (!symbol || seen.has(symbol)) return false
        seen.add(symbol)
        for (const declaration of symbol.declarations ?? []) {
            if (
                ts.isVariableDeclaration(declaration)
                && declaration.initializer
                && initializerCouldCarrySql(declaration.initializer, checker, seen)
            ) return true
        }
        return false
    }
    if (ts.isConditionalExpression(candidate)) {
        return initializerCouldCarrySql(candidate.whenTrue, checker, seen)
            || initializerCouldCarrySql(candidate.whenFalse, checker, seen)
    }
    if (ts.isBinaryExpression(candidate)) {
        return initializerCouldCarrySql(candidate.left, checker, seen)
            || initializerCouldCarrySql(candidate.right, checker, seen)
    }
    return false
}

function hasSqlFragment(expression, checker, seen = new Set()) {
    let found = false
    function visitCallableReturns(call, unknownCallIsDynamic) {
        const memberKind = prismaFragmentMemberKind(call.expression, checker, new Set(seen))
        if (memberKind) {
            found = true
            return
        }
        const callee = unwrapExpression(call.expression)
        const symbol = checker.getSymbolAtLocation(callee)
            ?? (ts.isPropertyAccessExpression(callee) ? checker.getSymbolAtLocation(callee.name) : null)
        if (!symbol || seen.has(symbol)) return
        seen.add(symbol)
        for (const declaration of symbol.declarations ?? []) {
            if (
                ts.isImportSpecifier(declaration)
                || ts.isImportClause(declaration)
                || ts.isNamespaceImport(declaration)
            ) {
                if (unknownCallIsDynamic) found = true
                return
            }
            if (
                ts.isFunctionDeclaration(declaration)
                || ts.isMethodDeclaration(declaration)
                || ts.isFunctionExpression(declaration)
                || ts.isArrowFunction(declaration)
            ) {
                if (declaration.body) visitReturnExpressions(declaration.body)
            } else if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
                const initializer = unwrapExpression(declaration.initializer)
                if (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer)) visitReturnExpressions(initializer.body)
            }
            if (found) return
        }
    }
    function visitReturnExpressions(body) {
        if (!ts.isBlock(body)) {
            visit(body, true)
            return
        }
        function inspect(node) {
            if (ts.isReturnStatement(node)) {
                if (node.expression) visit(node.expression, true)
                return
            }
            if (
                ts.isFunctionDeclaration(node)
                || ts.isFunctionExpression(node)
                || ts.isArrowFunction(node)
                || ts.isMethodDeclaration(node)
            ) return
            if (!found) ts.forEachChild(node, inspect)
        }
        inspect(body)
    }
    function visit(node, unknownCallIsDynamic = true) {
        if (ts.isTaggedTemplateExpression(node)) {
            const memberKind = prismaFragmentMemberKind(node.tag, checker, new Set(seen))
            if (memberKind === 'sql') {
                const chunks = ts.isNoSubstitutionTemplateLiteral(node.template)
                    ? node.template.text
                    : node.template.head.text + node.template.templateSpans.map((span) => '${}' + span.literal.text).join('')
                const analysis = sqlTables(chunks, '$executeRaw')
                if (analysis.dynamic || analysis.tables.length > 0) found = true
                if (!found && ts.isTemplateExpression(node.template)) {
                    for (const span of node.template.templateSpans) visit(span.expression)
                }
                return
            }
            if (memberKind === 'raw' || memberKind === null) found = true
            return
        }
        if (ts.isCallExpression(node)) {
            visitCallableReturns(node, unknownCallIsDynamic)
            if (found) return
        }
        const memberKind = prismaFragmentMemberKind(node, checker, new Set(seen))
        if (memberKind) {
            found = true
            return
        }
        if (ts.isIdentifier(node) && !found) {
            const symbol = checker.getSymbolAtLocation(node)
            if (symbol && !seen.has(symbol)) {
                seen.add(symbol)
                for (const declaration of symbol.declarations ?? []) {
                    if (
                        ts.isVariableDeclaration(declaration)
                        && declaration.initializer
                        && initializerCouldCarrySql(declaration.initializer, checker)
                    ) visit(declaration.initializer, false)
                }
            }
        }
        if (!found) ts.forEachChild(node, (child) => visit(child, unknownCallIsDynamic))
    }
    visit(expression)
    return found
}

function templateSql(template, checker, forceAllInterpolation = false) {
    if (ts.isNoSubstitutionTemplateLiteral(template)) return { sql: template.text, dynamic: false }
    if (!ts.isTemplateExpression(template)) return null
    let sql = template.head.text
    let dynamic = false
    for (const span of template.templateSpans) {
        sql += '${}'
        dynamic ||= forceAllInterpolation || hasSqlFragment(span.expression, checker)
        sql += span.literal.text
    }
    return { sql, dynamic }
}

function unwrapExpression(expression) {
    let current = expression
    while (
        ts.isParenthesizedExpression(current)
        || ts.isAsExpression(current)
        || ts.isTypeAssertionExpression(current)
        || ts.isNonNullExpression(current)
        || ts.isSatisfiesExpression(current)
    ) current = current.expression
    return current
}

function prismaRawMethod(expression) {
    const candidate = unwrapExpression(expression)
    if (!ts.isPropertyAccessExpression(candidate)) return null
    if (candidate.name.text !== '$executeRaw' && candidate.name.text !== '$executeRawUnsafe') return null
    const receiver = unwrapExpression(candidate.expression)
    return ts.isIdentifier(receiver) && ['prisma', 'prismaClient', 'tx', 'transaction', 'db'].includes(receiver.text)
        ? candidate.name.text
        : null
}

function staticSqlExpression(expression, checker, forceAllInterpolation = false) {
    const candidate = unwrapExpression(expression)
    if (ts.isStringLiteral(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate)) {
        return { sql: candidate.text, dynamic: false }
    }
    if (ts.isTemplateExpression(candidate)) return templateSql(candidate, checker, forceAllInterpolation)
    if (!ts.isIdentifier(candidate)) return null
    const symbol = checker.getSymbolAtLocation(candidate)
    if (!symbol || symbol.declarations?.length !== 1) return null
    const declaration = symbol.declarations[0]
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer || declaration.getStart() >= candidate.getStart()) return null
    const declarationList = declaration.parent
    if (!ts.isVariableDeclarationList(declarationList) || !(declarationList.flags & ts.NodeFlags.Const)) return null
    const initializer = unwrapExpression(declaration.initializer)
    if (!ts.isStringLiteral(initializer) && !ts.isNoSubstitutionTemplateLiteral(initializer)) return null
    return { sql: initializer.text, dynamic: false }
}

function rawSiteScope(node, sourceFile) {
    const scope = []
    for (let current = node.parent; current; current = current.parent) {
        if (ts.isClassDeclaration(current) || ts.isFunctionDeclaration(current)) {
            scope.push(`${ts.SyntaxKind[current.kind]}:${current.name?.getText(sourceFile) ?? '<anonymous>'}`)
        } else if (
            ts.isMethodDeclaration(current)
            || ts.isGetAccessorDeclaration(current)
            || ts.isSetAccessorDeclaration(current)
        ) {
            scope.push(`${ts.SyntaxKind[current.kind]}:${current.name.getText(sourceFile)}`)
        } else if (
            ts.isVariableDeclaration(current)
            && current.initializer
            && (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
        ) {
            scope.push(`Variable:${current.name.getText(sourceFile)}`)
        } else if (
            ts.isPropertyAssignment(current)
            && (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
        ) {
            scope.push(`Property:${current.name.getText(sourceFile)}`)
        }
    }
    return scope.reverse().join('/') || '<module>'
}

function rawSiteSignature(node, sourceFile) {
    return digest(`${rawSiteScope(node, sourceFile)}\n${node.getText(sourceFile)}`)
}

function extractRawPrismaWrites(text) {
    if (!text.includes('$executeRaw')) return []
    const fileName = 'architecture-scan.tsx'
    const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const options = { target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve, noResolve: true, noLib: true }
    const host = ts.createCompilerHost(options)
    host.getSourceFile = (requested) => requested === fileName ? sourceFile : undefined
    host.fileExists = (requested) => requested === fileName
    host.readFile = (requested) => requested === fileName ? text : undefined
    host.writeFile = () => {}
    host.getDefaultLibFileName = () => 'lib.d.ts'
    const checker = ts.createProgram({ rootNames: [fileName], options, host }).getTypeChecker()
    const records = []
    function visit(node) {
        if (ts.isCallExpression(node)) {
            const method = prismaRawMethod(node.expression)
            if (method) {
                const resolved = node.arguments.length === 0
                    ? null
                    : staticSqlExpression(node.arguments[0], checker, method === '$executeRawUnsafe')
                const analysis = sqlTables(resolved?.sql ?? null, method, resolved?.dynamic ?? true)
                records.push({
                    index: node.expression.getStart(sourceFile),
                    kind: 'raw',
                    method,
                    siteSignature: rawSiteSignature(node, sourceFile),
                    ...analysis,
                })
            }
        } else if (ts.isTaggedTemplateExpression(node)) {
            const method = prismaRawMethod(node.tag)
            if (method) {
                // Prisma template values can themselves be Sql objects. No
                // bounded local dataflow analysis can prove that aliases,
                // object/array members or callable wrappers are plain values,
                // so every interpolated execute template remains fail-closed.
                const resolved = templateSql(node.template, checker, true)
                const analysis = sqlTables(resolved?.sql ?? null, method, resolved?.dynamic ?? true)
                records.push({
                    index: node.tag.getStart(sourceFile),
                    kind: 'raw',
                    method,
                    siteSignature: rawSiteSignature(node, sourceFile),
                    ...analysis,
                })
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    const signatureCounts = new Map()
    for (const record of records) {
        signatureCounts.set(record.siteSignature, (signatureCounts.get(record.siteSignature) ?? 0) + 1)
    }
    const fileSignature = digest(text)
    for (const record of records) {
        if ((signatureCounts.get(record.siteSignature) ?? 0) > 1) {
            record.siteSignature = digest(`${record.siteSignature}\nduplicate-set:${fileSignature}`)
        }
    }
    return records
}

function normalizeSqlIdentifier(raw) {
    const parts = [...raw.matchAll(/"((?:[^"]|"")*)"|([A-Za-z_][A-Za-z0-9_$]*)/g)]
        .map((match) => match[1] !== undefined ? match[1].replaceAll('""', '"') : match[2])
    if (parts.length === 1) return parts[0]
    if (parts.length === 2 && parts[0].toLowerCase() === 'public') return parts[1]
    return parts.join('.')
}

function sqlTables(sql, method, forceDynamic = false) {
    if (sql === null) return { tables: [], dynamic: true }
    let state = 'code'
    let masked = ''
    for (let index = 0; index < sql.length; index += 1) {
        const current = sql[index]
        const next = sql[index + 1]
        if (state === 'line-comment') {
            if (current === '\n') {
                state = 'code'
                masked += '\n'
            } else masked += ' '
            continue
        }
        if (state === 'block-comment') {
            if (current === '*' && next === '/') {
                masked += '  '
                index += 1
                state = 'code'
            } else masked += current === '\n' ? '\n' : ' '
            continue
        }
        if (state === 'single-quote') {
            if (current === "'" && next === "'") {
                masked += '  '
                index += 1
            } else if (current === "'") {
                masked += ' '
                state = 'code'
            } else masked += current === '\n' ? '\n' : ' '
            continue
        }
        if (current === '-' && next === '-') {
            masked += '  '
            index += 1
            state = 'line-comment'
        } else if (current === '/' && next === '*') {
            masked += '  '
            index += 1
            state = 'block-comment'
        } else if (current === "'") {
            masked += ' '
            state = 'single-quote'
        } else masked += current
    }
    const dynamicMarker = '__YOKO_DYNAMIC_SQL__'
    masked = masked.replace(/\$\{[^}]*\}/g, dynamicMarker)
    const token = '(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)'
    const identifier = `${token}(?:\\s*\\.\\s*${token})?`
    const boundary = '(?![\\p{L}\\p{N}_$".])'
    const simpleMutation = '(?:INSERT\\s+INTO|UPDATE\\s+(?!SET\\b)|DELETE\\s+FROM|MERGE\\s+INTO|CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?|ALTER\\s+TABLE(?:\\s+IF\\s+EXISTS)?)'
    const simplePattern = new RegExp(`\\b${simpleMutation}\\s*(${identifier})${boundary}`, 'giu')
    const indexPattern = new RegExp(`\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+${identifier}${boundary}\\s+ON\\s+(${identifier})${boundary}`, 'giu')
    const patterns = [simplePattern, indexPattern]
    const tables = []
    let dynamic = forceDynamic
    for (const pattern of patterns) {
        for (const match of masked.matchAll(pattern)) {
            const table = normalizeSqlIdentifier(match[1])
            if (table.includes(dynamicMarker)) {
                dynamic = true
                continue
            }
            tables.push(table)
        }
    }
    const simpleIntentCount = [...masked.matchAll(new RegExp(`\\b${simpleMutation}`, 'giu'))].length
    const simpleTargetCount = [...masked.matchAll(new RegExp(simplePattern.source, simplePattern.flags))].length
    const indexIntentCount = [...masked.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+/giu)].length
    const indexTargetCount = [...masked.matchAll(new RegExp(indexPattern.source, indexPattern.flags))].length
    if (simpleIntentCount !== simpleTargetCount || indexIntentCount !== indexTargetCount) dynamic = true

    const listPattern = new RegExp(`\\b(?:DROP\\s+TABLE(?:\\s+IF\\s+EXISTS)?|TRUNCATE(?:\\s+TABLE)?)\\s+([^;]+)`, 'giu')
    const listIntentCount = [...masked.matchAll(/\b(?:DROP\s+TABLE(?:\s+IF\s+EXISTS)?|TRUNCATE(?:\s+TABLE)?)\s+/giu)].length
    let listTargetCount = 0
    for (const match of masked.matchAll(listPattern)) {
        listTargetCount += 1
        for (const target of match[1].split(',')) {
            const candidate = new RegExp(`^\\s*(${identifier})${boundary}`, 'u').exec(target)?.[1]
            if (!candidate) {
                dynamic = true
                continue
            }
            const table = normalizeSqlIdentifier(candidate)
            if (table.includes(dynamicMarker)) dynamic = true
            else tables.push(table)
        }
    }
    if (listIntentCount !== listTargetCount) dynamic = true
    return { tables: [...new Set(tables)].sort(), dynamic }
}

export function extractPrismaWrites(text) {
    const executable = executablePositions(text)
    const records = []
    const modelPattern = /\b(prisma|prismaClient|tx|transaction|db)\b(?:\s+as\s+any)?\s*\)?\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*(createManyAndReturn|createMany|create|updateMany|update|upsert|deleteMany|delete)\s*\(/g
    for (const match of text.matchAll(modelPattern)) {
        if (!executable[match.index]) continue
        if (!WRITE_METHODS.has(match[3])) continue
        records.push({ index: match.index, kind: 'model', model: match[2], method: match[3] })
    }
    records.push(...extractRawPrismaWrites(text))
    return records.sort((left, right) => left.index - right.index)
}

async function exists(candidate) {
    try {
        await access(candidate)
        return true
    } catch {
        return false
    }
}

async function walk(directory, excludes, result = []) {
    if (!(await exists(directory))) return result
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
        if (entry.name === '.git' || excludes.has(entry.name)) continue
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) await walk(absolute, excludes, result)
        else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name))) result.push(absolute)
    }
    return result
}

async function loadJson(root, relative) {
    return JSON.parse(await readFile(path.join(root, relative), 'utf8'))
}

function slugContext(slug) {
    const aliases = {
        'work-management': 'work_management',
        'platform-shell': 'platform_shell',
        calling: 'calling',
    }
    return aliases[slug] ?? slug.replaceAll('-', '_')
}

function applyManifestAmendments(manifests, amendments) {
    const byContext = new Map(manifests.map((manifest) => [manifest.context.id, structuredClone(manifest)]))
    for (const bundle of amendments) {
        for (const amendment of bundle.amendments) {
            const manifest = byContext.get(amendment.context)
            if (!manifest) continue
            const additions = [
                ['add_public_surface', 'public_surface'],
                ['add_internal_surface', 'internal_surface'],
                ['add_events', 'events'],
                ['add_commands', 'commands'],
            ]
            for (const [source, target] of additions) {
                if (amendment[source]) manifest[target] = [...new Set([...(manifest[target] ?? []), ...amendment[source]])]
            }
            manifest.owned_infrastructure_state = [
                ...new Set([...(manifest.owned_infrastructure_state ?? []), ...(amendment.add_owned_infrastructure_state ?? [])]),
            ]
            for (const dependency of amendment.add_allowed_dependencies ?? []) {
                if (!manifest.allowed_dependencies.some((item) => item.context === dependency.context && item.surface === dependency.surface)) manifest.allowed_dependencies.push(dependency)
            }
        }
    }
    return [...byContext.values()]
}

function dependencyCycles(manifests) {
    const adjacency = new Map(manifests.map((manifest) => [
        manifest.context.id,
        manifest.allowed_dependencies.map((dependency) => dependency.context),
    ]))
    const visiting = new Set()
    const visited = new Set()
    const cycles = []
    function visit(node, trail) {
        if (visiting.has(node)) {
            cycles.push([...trail.slice(trail.indexOf(node)), node])
            return
        }
        if (visited.has(node)) return
        visiting.add(node)
        for (const target of adjacency.get(node) ?? []) visit(target, [...trail, target])
        visiting.delete(node)
        visited.add(node)
    }
    for (const node of adjacency.keys()) visit(node, [node])
    return cycles
}

export function validateManifestPolicy(manifests, amendments) {
    const findings = []
    const contextIds = new Set(manifests.map((manifest) => manifest.context.id))
    for (const manifest of manifests) {
        for (const value of [...manifest.public_surface, ...manifest.events, ...manifest.commands]) {
            if (!/\.v[1-9][0-9]*$/.test(value)) {
                findings.push({ rule: 'manifest_inconsistency', file: 'architecture/contexts/v1', subject: `${manifest.context.id}:unversioned:${value}` })
            }
        }
        for (const dependency of manifest.allowed_dependencies) {
            if (!contextIds.has(dependency.context) || dependency.context === manifest.context.id) {
                findings.push({ rule: 'manifest_inconsistency', file: 'architecture/contexts/v1', subject: `${manifest.context.id}:dependency:${dependency.context}` })
            }
        }
    }
    for (const bundle of amendments) {
        for (const amendment of bundle.amendments) {
            if (!contextIds.has(amendment.context)) {
                findings.push({ rule: 'manifest_inconsistency', file: 'architecture/events/v1/module-manifest-amendments.json', subject: `unknown-context:${amendment.context}` })
            }
        }
    }
    for (const cycle of dependencyCycles(manifests)) {
        findings.push({ rule: 'dependency_graph_cycle', file: 'architecture/contexts/v1', subject: cycle.join('>') })
    }
    return findings
}

function contextState(policy, moduleRules, manifests, amendments) {
    const effectiveManifests = applyManifestAmendments(manifests, amendments)
    const moduleContext = new Map()
    for (const manifest of effectiveManifests) {
        for (const module of manifest.technical_modules) moduleContext.set(module, manifest.context.id)
    }
    const compiledRules = moduleRules.modules.map((rule) => ({ ...rule, regex: new RegExp(rule.match) }))
    const manifestsByContext = new Map(effectiveManifests.map((manifest) => [manifest.context.id, manifest]))

    function classifyFile(relative) {
        const moduleMatch = relative.match(/^gravity-mvp\/src\/modules\/([^/]+)\//)
        if (moduleMatch) {
            const context = slugContext(moduleMatch[1])
            return { module: `module:${context}`, context }
        }
        const contractMatch = relative.match(/^gravity-mvp\/src\/contracts\/([^/]+)\//)
        if (contractMatch) {
            const context = slugContext(contractMatch[1])
            return { module: `contract:${context}`, context }
        }
        if (relative.startsWith('gravity-mvp/src/infrastructure/')) {
            return { module: 'shared_infrastructure', context: 'platform_shell' }
        }
        const module = compiledRules.find((rule) => rule.regex.test(relative))?.id ?? 'unclassified'
        return { module, context: moduleContext.get(module) ?? null }
    }

    const providerAllowedContexts = new Map()
    for (const manifest of effectiveManifests) {
        for (const relationship of manifest.provider_relationships ?? []) {
            const provider = policy.provider_aliases?.[relationship.name] ?? relationship.name
            if (!providerAllowedContexts.has(provider)) providerAllowedContexts.set(provider, new Set())
            providerAllowedContexts.get(provider).add(manifest.context.id)
        }
    }
    for (const [provider, contexts] of Object.entries(policy.provider_allowed_context_overrides ?? {})) {
        if (!providerAllowedContexts.has(provider)) providerAllowedContexts.set(provider, new Set())
        contexts.forEach((context) => providerAllowedContexts.get(provider).add(context))
    }

    const modelOwners = new Map()
    const tableOwners = new Map()
    for (const manifest of effectiveManifests) {
        for (const data of manifest.owned_data ?? []) {
            if (data.model) {
                modelOwners.set(data.model.toLowerCase(), { model: data.model, context: manifest.context.id })
                tableOwners.set(data.model.toLowerCase(), manifest.context.id)
            }
            if (data.mapped_table) tableOwners.set(data.mapped_table.toLowerCase(), manifest.context.id)
        }
        for (const id of manifest.owned_infrastructure_state ?? []) {
            const model = id.split(':').at(-1)
            modelOwners.set(model.toLowerCase(), { model, context: manifest.context.id })
        }
    }

    return {
        classifyFile,
        effectiveManifests,
        manifestsByContext,
        modelOwners,
        moduleContext,
        providerAllowedContexts,
        tableOwners,
    }
}

function resolveImport(root, source, specifier, fileSet) {
    let base
    if (specifier.startsWith('.')) base = path.resolve(path.dirname(path.join(root, source)), specifier)
    else if (specifier.startsWith('@/') && source.startsWith('gravity-mvp/')) {
        base = path.join(root, 'gravity-mvp/src', specifier.slice(2))
    } else return { relationship: 'external', target: specifier }

    if (path.extname(base) && existsSync(base)) {
        return { relationship: 'internal', target: path.relative(root, base).split(path.sep).join('/') }
    }

    const candidates = [base]
    if (/\.[cm]?js$/.test(base)) {
        const withoutJs = base.replace(/\.[cm]?js$/, '')
        for (const extension of ['.ts', '.tsx', '.mts', '.cts']) candidates.push(`${withoutJs}${extension}`)
    }
    for (const extension of CODE_EXTENSIONS) candidates.push(`${base}${extension}`)
    for (const extension of CODE_EXTENSIONS) candidates.push(path.join(base, `index${extension}`))
    for (const candidate of candidates) {
        const relative = path.relative(root, candidate).split(path.sep).join('/')
        if (fileSet.has(relative)) return { relationship: 'internal', target: relative }
    }
    return {
        relationship: 'unresolved_internal',
        target: path.relative(root, base).split(path.sep).join('/'),
    }
}

function isTestFile(relative, policy) {
    return policy.test_path_patterns.some((pattern) => relative.includes(pattern))
}

function matchesSurface(target, surface) {
    return target === surface || target.startsWith(`${surface}/`)
}

function isVersionedPublicTarget(target) {
    return /^gravity-mvp\/src\/modules\/[^/]+\/public\/v[1-9][0-9]*(?:\/|$)/.test(target)
        || /^gravity-mvp\/src\/contracts\/[^/]+\/v[1-9][0-9]*(?:\/|$)/.test(target)
}

function isPublicFacadeSource(source) {
    return /^gravity-mvp\/src\/modules\/[^/]+\/public(?:\/|$)/.test(source)
}

function isPublicBusinessFacadeSource(source) {
    return isPublicFacadeSource(source)
}

function directPublicImplementationSources({ root, files, fileSet, bodies, policy, providersByFile }) {
    const result = new Set()
    for (const file of files) {
        if (!isPublicFacadeSource(file)) continue
        const body = bodies.get(file)
        let directImplementationDependency = (providersByFile.get(file)?.size ?? 0) > 0
        for (const imported of extractImports(body)) {
            const resolution = resolveImport(root, file, imported.specifier, fileSet)
            if (
                providerForSpecifier(imported.specifier, policy)
                || isPrismaSpecifier(imported.specifier)
                || resolution.target === 'gravity-mvp/src/lib/prisma.ts'
                || (providersByFile.get(resolution.target)?.size ?? 0) > 0
            ) {
                directImplementationDependency = true
                break
            }
        }
        // A write against the conventional in-scope Prisma binding is still
        // a primitive dependency if a legacy source omitted its import (for
        // example through generated ambient wiring).  It is implementation
        // only by behaviour, never by filename.
        if (extractPrismaWrites(body).length > 0) directImplementationDependency = true
        // A source file which binds a persistence/provider primitive is an
        // implementation regardless of its filename or its exported DTO
        // shape.  Public folders contain compatibility adapters, but their
        // physical location cannot turn their implementation identities into
        // a public surface.  Any public barrel which re-exports one is still
        // rejected by the closure analysis below.
        if (directImplementationDependency) result.add(file)
    }
    return result
}

function isPrismaSpecifier(specifier) {
    return specifier === '@prisma/client' || specifier === '@/lib/prisma'
}

function isOwnerApplicationCompositionTarget(target) {
    return /^gravity-mvp\/src\/modules\/[^/]+\/application(?:\/|$)/.test(target)
}

function isSharedInfrastructure(target, policy) {
    return policy.shared_infrastructure_targets.some((prefix) => target === prefix || target.startsWith(prefix))
}

const CONTACT_MERGE_COMPOSITION_BINDINGS = new Map([
    ['gravity-mvp/src/modules/contacts/public/v1/legacy-prisma-contact-merge-adapter.ts', new Set([
        'legacyPrismaContactMergeQueriesV1',
        'makeLegacyPrismaContactMergeRepositoriesV1',
    ])],
    ['gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-contact-merge-adapter.ts', new Set([
        'makeMessagingContactMergeRepositories',
    ])],
    ['gravity-mvp/src/modules/work-management/public/v1/legacy-prisma-contact-merge-adapter.ts', new Set([
        'makeWorkContactMergeRepositories',
    ])],
])

/**
 * The contact merge is one cross-owner transaction and therefore has one
 * named shared-infrastructure composition root.  It may bind the three owner
 * adapters, but this does not make those adapters part of any public surface.
 */
export function isApprovedContactMergeCompositionImport(source, target, imported = null) {
    if (source !== 'gravity-mvp/src/infrastructure/contact-merge-composition.ts') return false
    const allowed = CONTACT_MERGE_COMPOSITION_BINDINGS.get(target)
    if (!allowed || !imported || imported.kind !== 'static') return false
    const bindings = imported.imports ?? []
    return bindings.length > 0 && bindings.every((binding) => (
        binding.kind === 'named'
        && binding.imported === binding.local
        && allowed.has(binding.imported)
    ))
}

function providerForSpecifier(specifier, policy) {
    for (const [provider, patterns] of Object.entries(policy.provider_transport_packages)) {
        if (patterns.some((pattern) => new RegExp(pattern).test(specifier))) return provider
    }
    return null
}

function cleanExposure() {
    return {
        identityTainted: false,
        resultTainted: false,
        effectTainted: false,
        identityTrace: [],
        resultTrace: [],
        effectTrace: [],
        namespaceTarget: null,
        knownCallable: false,
        knownDto: false,
        callerControlled: false,
        mutationKind: null,
        argumentMutationFlows: [],
        argumentEscapeFlows: [],
        resultArgumentIndexes: [],
    }
}

function taintedExposure(trace, { identity = true, result = true } = {}) {
    return {
        identityTainted: identity,
        resultTainted: result,
        effectTainted: false,
        identityTrace: identity ? [trace] : [],
        resultTrace: result ? [trace] : [],
        effectTrace: [],
        namespaceTarget: null,
        knownCallable: false,
        knownDto: false,
        callerControlled: false,
        mutationKind: null,
        argumentMutationFlows: [],
        argumentEscapeFlows: [],
        resultArgumentIndexes: [],
    }
}

function taintedEffectExposure(trace) {
    return {
        ...cleanExposure(),
        effectTainted: true,
        effectTrace: [trace],
    }
}

function mergeExposure(...values) {
    const output = cleanExposure()
    for (const value of values) {
        if (!value) continue
        if (!output.identityTainted && value.identityTainted) {
            output.identityTainted = true
            output.identityTrace = value.identityTrace ?? []
        }
        if (!output.resultTainted && value.resultTainted) {
            output.resultTainted = true
            output.resultTrace = value.resultTrace ?? []
        }
        if (!output.effectTainted && value.effectTainted) {
            output.effectTainted = true
            output.effectTrace = value.effectTrace ?? []
        }
        output.namespaceTarget ??= value.namespaceTarget ?? null
        output.knownCallable ||= value.knownCallable ?? false
        output.knownDto ||= value.knownDto ?? false
        output.callerControlled ||= value.callerControlled ?? false
        output.mutationKind ??= value.mutationKind ?? null
        for (const flow of value.argumentMutationFlows ?? []) {
            const key = `${flow.targetIndex}:${flow.valueIndexes.join(',')}`
            if (!output.argumentMutationFlows.some((candidate) => `${candidate.targetIndex}:${candidate.valueIndexes.join(',')}` === key)) {
                output.argumentMutationFlows.push(flow)
            }
        }
        for (const flow of value.argumentEscapeFlows ?? []) {
            const key = `${flow.sinkIndex}:${flow.valueIndexes.join(',')}`
            if (!output.argumentEscapeFlows.some((candidate) => `${candidate.sinkIndex}:${candidate.valueIndexes.join(',')}` === key)) {
                output.argumentEscapeFlows.push(flow)
            }
        }
        for (const index of value.resultArgumentIndexes ?? []) {
            if (!output.resultArgumentIndexes.includes(index)) output.resultArgumentIndexes.push(index)
        }
    }
    return output
}

function exposureIsTainted(value) {
    return Boolean(value?.identityTainted || value?.resultTainted || value?.effectTainted)
}

function exposureTrace(value) {
    if (value.identityTainted) return value.identityTrace
    if (value.resultTainted) return value.resultTrace
    return value.effectTrace
}

function exposureSignature(value) {
    const mutationFlows = (value?.argumentMutationFlows ?? [])
        .map((flow) => `${flow.targetIndex}>${flow.valueIndexes.join(',')}`)
        .join(';')
    const escapeFlows = (value?.argumentEscapeFlows ?? [])
        .map((flow) => `${flow.sinkIndex}>${flow.valueIndexes.join(',')}`)
        .join(';')
    return `${value?.identityTainted ? 1 : 0}:${value?.resultTainted ? 1 : 0}:${value?.effectTainted ? 1 : 0}:${value?.knownCallable ? 1 : 0}:${value?.knownDto ? 1 : 0}:${value?.callerControlled ? 1 : 0}:${value?.mutationKind ?? ''}:${mutationFlows}:${escapeFlows}:${(value?.resultArgumentIndexes ?? []).join(',')}`
}

function dtoExposure() {
    return { ...cleanExposure(), knownDto: true }
}

function implementationIdentity(summary, target, reason) {
    if (summary.identityTainted) return summary
    return {
        ...summary,
        identityTainted: true,
        identityTrace: [`${reason}:${target}`, ...(summary.identityTrace ?? [])],
    }
}

function callResultExposure(callee) {
    if (!callee?.resultTainted) return cleanExposure()
    return taintedExposure(callee.resultTrace?.[0] ?? 'tainted-call-result', { identity: true, result: false })
}

function callEffectExposure(callee) {
    if (!callee?.effectTainted) return cleanExposure()
    return taintedEffectExposure(callee.effectTrace?.[0] ?? 'tainted-call-effect')
}

function callerControlledCallResult(callee, receiver, argumentsExposure) {
    const returnedArguments = callee?.knownCallable
        ? callee.resultArgumentIndexes.map((index) => argumentsExposure[index]).filter(Boolean)
        : argumentsExposure
    return callee?.callerControlled
        || receiver?.callerControlled
        || returnedArguments.some((value) => value?.callerControlled)
        ? { ...cleanExposure(), callerControlled: true }
        : cleanExposure()
}

function callReceiverExposure(node, environment, context, depth) {
    const expression = unwrapExpression(node)
    if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return cleanExposure()
    return expressionExposure(expression.expression, environment, context, depth + 1)
}

function isPromiseContinuationCall(node) {
    const expression = unwrapExpression(node)
    if (ts.isPropertyAccessExpression(expression)) return ['then', 'catch', 'finally'].includes(expression.name.text)
    return ts.isElementAccessExpression(expression)
        && ts.isStringLiteralLike(expression.argumentExpression)
        && ['then', 'catch', 'finally'].includes(expression.argumentExpression.text)
}

function isKnownProviderDataMethodCall(node, receiver) {
    const expression = unwrapExpression(node)
    if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== 'send') return false
    return (receiver.identityTrace ?? []).some((trace) => trace.includes('implementation-package:@aws-sdk/'))
}

function taintedCallValue(values, fallback) {
    const tainted = values.find((value) => value?.identityTainted || value?.resultTainted)
    return tainted
        ? taintedExposure(exposureTrace(tainted)?.[0] ?? fallback, { identity: true, result: false })
        : cleanExposure()
}

function callerControlledCallEffect(callee, receiver, argumentsExposure, context) {
    if (callee?.callerControlled || receiver?.callerControlled) {
        const escaped = argumentsExposure.find((value) => value?.identityTainted || value?.resultTainted)
        if (escaped) {
            return taintedEffectExposure(exposureTrace(escaped)?.[0] ?? `${context.file}:caller-controlled-call-argument-escape`)
        }
    }
    for (const flow of callee?.argumentEscapeFlows ?? []) {
        if (!argumentsExposure[flow.sinkIndex]?.callerControlled) continue
        const escaped = flow.valueIndexes
            .map((index) => argumentsExposure[index])
            .find((value) => value?.identityTainted || value?.resultTainted)
        if (escaped) {
            return taintedEffectExposure(exposureTrace(escaped)?.[0] ?? `${context.file}:caller-controlled-callback-wrapper-escape`)
        }
    }
    return cleanExposure()
}

function functionReturnArgumentIndexes(node) {
    const parameterIndexes = new Map()
    for (const [index, parameter] of (node.parameters ?? []).entries()) {
        for (const name of declarationNames(parameter.name)) parameterIndexes.set(name, index)
    }
    const indexes = new Set()
    function visit(nodeToVisit) {
        if (nodeToVisit !== node && (
            ts.isArrowFunction(nodeToVisit)
            || ts.isFunctionExpression(nodeToVisit)
            || ts.isFunctionDeclaration(nodeToVisit)
            || ts.isMethodDeclaration(nodeToVisit)
            || ts.isGetAccessorDeclaration(nodeToVisit)
            || ts.isSetAccessorDeclaration(nodeToVisit)
        )) return
        if (ts.isReturnStatement(nodeToVisit) && nodeToVisit.expression) {
            function inspect(expression) {
                const candidate = unwrapExpression(expression)
                if (ts.isIdentifier(candidate) && parameterIndexes.has(candidate.text)) {
                    indexes.add(parameterIndexes.get(candidate.text))
                    return
                }
                if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate) || ts.isFunctionDeclaration(candidate)) return
                ts.forEachChild(candidate, inspect)
            }
            inspect(nodeToVisit.expression)
            return
        }
        ts.forEachChild(nodeToVisit, visit)
    }
    if (!ts.isBlock(node.body)) {
        const expression = node.body
        function inspect(expressionToInspect) {
            const candidate = unwrapExpression(expressionToInspect)
            if (ts.isIdentifier(candidate) && parameterIndexes.has(candidate.text)) {
                indexes.add(parameterIndexes.get(candidate.text))
                return
            }
            if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) return
            ts.forEachChild(candidate, inspect)
        }
        inspect(expression)
    } else visit(node.body)
    return [...indexes].sort((left, right) => left - right)
}

function parameterIndexesInExpression(node, parameterIndexes) {
    const indexes = new Set()
    function visit(current) {
        const candidate = unwrapExpression(current)
        if (ts.isIdentifier(candidate) && parameterIndexes.has(candidate.text)) {
            indexes.add(parameterIndexes.get(candidate.text))
            return
        }
        if (candidate !== node && (
            ts.isArrowFunction(candidate)
            || ts.isFunctionExpression(candidate)
            || ts.isFunctionDeclaration(candidate)
        )) return
        ts.forEachChild(candidate, visit)
    }
    if (node) visit(node)
    return [...indexes].sort((left, right) => left - right)
}

function mutationTargetParameterIndex(node, parameterIndexes) {
    let candidate = unwrapExpression(node)
    while (ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate)) {
        candidate = unwrapExpression(candidate.expression)
    }
    return ts.isIdentifier(candidate) ? parameterIndexes.get(candidate.text) ?? null : null
}

function functionArgumentMutationFlows(node, environment, context, depth = 0) {
    if (!node.body) return []
    const parameterIndexes = new Map()
    for (const [index, parameter] of (node.parameters ?? []).entries()) {
        for (const name of declarationNames(parameter.name)) parameterIndexes.set(name, index)
    }
    const flows = []
    const add = (targetIndex, valueIndexes) => {
        if (targetIndex === null || valueIndexes.length === 0) return
        const flow = { targetIndex, valueIndexes: [...new Set(valueIndexes)].sort((left, right) => left - right) }
        const key = `${flow.targetIndex}:${flow.valueIndexes.join(',')}`
        if (!flows.some((candidate) => `${candidate.targetIndex}:${candidate.valueIndexes.join(',')}` === key)) flows.push(flow)
    }
    for (const call of scopeMutationCalls(node.body)) {
        const kind = mutationCallKind(call.expression, environment)
        if (kind && call.arguments[0]) {
            add(
                mutationTargetParameterIndex(call.arguments[0], parameterIndexes),
                mutationValueArguments(kind, call).flatMap((argument) => parameterIndexesInExpression(argument, parameterIndexes)),
            )
            continue
        }
        const callee = expressionExposure(call.expression, environment, context, depth + 1)
        for (const flow of callee.argumentMutationFlows ?? []) {
            const targetArgument = call.arguments[flow.targetIndex]
            if (!targetArgument) continue
            add(
                mutationTargetParameterIndex(targetArgument, parameterIndexes),
                flow.valueIndexes.flatMap((index) => (
                    call.arguments[index]
                        ? parameterIndexesInExpression(call.arguments[index], parameterIndexes)
                        : []
                )),
            )
        }
    }
    for (const assignment of scopeAssignments(node.body)) {
        const target = unwrapExpression(assignment.left)
        if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) continue
        add(
            mutationTargetParameterIndex(target.expression, parameterIndexes),
            parameterIndexesInExpression(assignment.right, parameterIndexes),
        )
    }
    return flows
}

function functionArgumentEscapeFlows(node, environment, context, depth = 0) {
    if (!node.body) return []
    const parameterIndexes = new Map()
    for (const [index, parameter] of (node.parameters ?? []).entries()) {
        for (const name of declarationNames(parameter.name)) parameterIndexes.set(name, index)
    }
    const flows = []
    const add = (sinkIndex, valueIndexes) => {
        if (sinkIndex === null || valueIndexes.length === 0) return
        const flow = { sinkIndex, valueIndexes: [...new Set(valueIndexes)].sort((left, right) => left - right) }
        const key = `${flow.sinkIndex}:${flow.valueIndexes.join(',')}`
        if (!flows.some((candidate) => `${candidate.sinkIndex}:${candidate.valueIndexes.join(',')}` === key)) flows.push(flow)
    }
    for (const call of scopeMutationCalls(node.body)) {
        const directSinkIndex = mutationTargetParameterIndex(call.expression, parameterIndexes)
        if (directSinkIndex !== null) {
            add(
                directSinkIndex,
                call.arguments.flatMap((argument) => parameterIndexesInExpression(argument, parameterIndexes)),
            )
            continue
        }
        const callee = expressionExposure(call.expression, environment, context, depth + 1)
        for (const flow of callee.argumentEscapeFlows ?? []) {
            const sinkArgument = call.arguments[flow.sinkIndex]
            if (!sinkArgument) continue
            add(
                mutationTargetParameterIndex(sinkArgument, parameterIndexes),
                flow.valueIndexes.flatMap((index) => (
                    call.arguments[index]
                        ? parameterIndexesInExpression(call.arguments[index], parameterIndexes)
                        : []
                )),
            )
        }
    }
    return flows
}

function functionExposure(node, environment, context, depth = 0) {
    const returned = functionReturnExposure(node, environment, context, depth + 1)
    return {
        ...((returned.identityTainted || returned.resultTainted)
            ? taintedExposure(exposureTrace(returned)?.[0] ?? `${context.file}:tainted-callback`)
            : cleanExposure()),
        effectTainted: returned.effectTainted,
        effectTrace: returned.effectTrace,
        knownCallable: true,
        argumentMutationFlows: functionArgumentMutationFlows(node, environment, context, depth + 1),
        argumentEscapeFlows: functionArgumentEscapeFlows(node, environment, context, depth + 1),
        resultArgumentIndexes: functionReturnArgumentIndexes(node),
    }
}

function declarationNames(name, output = []) {
    if (ts.isIdentifier(name)) output.push(name.text)
    else for (const element of name.elements ?? []) {
        if (!ts.isOmittedExpression(element)) declarationNames(element.name, output)
    }
    return output
}

function moduleExports(previous, target) {
    return previous.get(target) ?? new Map()
}

function aggregateModuleExposure(previous, target) {
    return mergeExposure(...moduleExports(previous, target).values())
}

function isInternalImplementationTarget(target) {
    return /^gravity-mvp\/src\/modules\/[^/]+\/internal(?:\/|$)/.test(target)
}

function localReferenceExposure({
    source,
    specifier,
    importedName,
    resolution,
    previous,
    policy,
    providersByFile,
    publicImplementationSources,
}) {
    if (resolution.relationship === 'unresolved_internal') {
        return taintedExposure(`${source}:unresolved-local-module:${specifier}`)
    }
    if (resolution.relationship === 'external') {
        const provider = providerForSpecifier(specifier, policy)
        if (provider || isPrismaSpecifier(specifier)) {
            return taintedExposure(`${source}:implementation-package:${specifier}`, {
                identity: true,
                result: false,
            })
        }
        return cleanExposure()
    }

    const targetSummary = importedName === '*'
        ? aggregateModuleExposure(previous, resolution.target)
        : (moduleExports(previous, resolution.target).get(importedName) ?? cleanExposure())
    const implementationIdentityTarget = isInternalImplementationTarget(resolution.target)
        || resolution.target === 'gravity-mvp/src/lib/prisma.ts'
        || (providersByFile.get(resolution.target)?.size ?? 0) > 0
    // A public-path compatibility adapter is semantically internal once it
    // binds a primitive, but its narrow callable result is not itself a
    // persistence handle.  Preserve the symbol-level result summary for this
    // one case.  The import remains an internal target for cross-context
    // policy, and any actual handle exported by the adapter stays tainted.
    const publicPathImplementationTarget = publicImplementationSources?.has(resolution.target)
    if (publicPathImplementationTarget) return targetSummary
    return implementationIdentityTarget
        ? implementationIdentity(targetSummary, resolution.target, `${source}:private-implementation-import`)
        : targetSummary
}

function expressionExposure(node, environment, context, depth = 0) {
    if (!node) return cleanExposure()
    if (depth > 80) return taintedExposure(`${context.file}:export-analysis-depth-exceeded`)
    const candidate = unwrapExpression(node)

    if (ts.isIdentifier(candidate)) return environment.get(candidate.text) ?? cleanExposure()
    if (
        ts.isStringLiteralLike(candidate)
        || ts.isNumericLiteral(candidate)
        || candidate.kind === ts.SyntaxKind.TrueKeyword
        || candidate.kind === ts.SyntaxKind.FalseKeyword
        || candidate.kind === ts.SyntaxKind.NullKeyword
        || candidate.kind === ts.SyntaxKind.UndefinedKeyword
        || candidate.kind === ts.SyntaxKind.ThisKeyword
    ) return dtoExposure()

    if (ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate)) {
        const mutationKind = mutationCallKind(candidate)
        if (mutationKind) return { ...cleanExposure(), knownCallable: true, mutationKind }
        const receiver = candidate.expression
        if (ts.isIdentifier(receiver)) {
            const namespace = environment.get(receiver.text)?.namespaceTarget
            if (namespace) {
                const memberName = ts.isPropertyAccessExpression(candidate)
                    ? candidate.name.text
                    : (ts.isStringLiteralLike(candidate.argumentExpression) ? candidate.argumentExpression.text : '*')
                return localReferenceExposure({
                    source: context.file,
                    specifier: namespace.specifier,
                    importedName: memberName,
                    resolution: namespace.resolution,
                    previous: context.previous,
                    policy: context.policy,
                    providersByFile: context.providersByFile,
                    publicImplementationSources: context.publicImplementationSources,
                })
            }
        }
        const base = expressionExposure(receiver, environment, context, depth + 1)
        return (base.identityTainted || base.resultTainted)
            ? taintedExposure(exposureTrace(base)?.[0] ?? `${context.file}:tainted-member-access`, { identity: true, result: false })
            : (base.callerControlled ? { ...cleanExposure(), callerControlled: true } : cleanExposure())
    }

    if (ts.isCallExpression(candidate)) {
        const moduleLoad = moduleLoadKind(candidate.expression, context.requireAliases)
        if (moduleLoad) {
            const argument = candidate.arguments[0]
            if (candidate.arguments.length !== 1 || !argument || !ts.isStringLiteralLike(argument)) {
                return taintedExposure(`${context.file}:nonliteral-${moduleLoad === 'dynamic' ? 'dynamic-import' : 'require'}`)
            }
            const resolution = resolveImport(context.root, context.file, argument.text, context.fileSet)
            const summary = localReferenceExposure({
                source: context.file,
                specifier: argument.text,
                importedName: '*',
                resolution,
                previous: context.previous,
                policy: context.policy,
                providersByFile: context.providersByFile,
                publicImplementationSources: context.publicImplementationSources,
            })
            return resolution.relationship === 'internal' && (
                isInternalImplementationTarget(resolution.target)
                || context.publicImplementationSources?.has(resolution.target)
            )
                ? implementationIdentity(summary, resolution.target, `${context.file}:${moduleLoad}-private-module-exposure`)
                : summary
        }
        // Calls are opaque across the public boundary.  A callee can retain
        // and return any argument (pass(prisma), Promise.resolve(prisma)) or
        // a method can return a value from its tainted receiver
        // (import(...).then(...)).  Narrow internal business calls remain
        // valid when every argument and receiver is clean.
        const callee = expressionExposure(candidate.expression, environment, context, depth + 1)
        const argumentsExposure = candidate.arguments.map((argument) => expressionExposure(argument, environment, context, depth + 1))
        const receiver = callReceiverExposure(candidate.expression, environment, context, depth + 1)
        return mergeExposure(
            callResultExposure(callee),
            callEffectExposure(callee),
            callerControlledCallResult(callee, receiver, argumentsExposure),
            callerControlledCallEffect(callee, receiver, argumentsExposure, context),
            taintedCallValue(
                callee.knownCallable
                    ? callee.resultArgumentIndexes.map((index) => argumentsExposure[index]).filter(Boolean)
                    : (isKnownProviderDataMethodCall(candidate.expression, receiver) ? [] : argumentsExposure),
                `${context.file}:tainted-call-argument`,
            ),
            isPromiseContinuationCall(candidate.expression)
                ? taintedCallValue([receiver], `${context.file}:tainted-promise-continuation-receiver`)
                : cleanExposure(),
        )
    }

    if (ts.isNewExpression(candidate)) {
        const constructor = expressionExposure(candidate.expression, environment, context, depth + 1)
        const argumentsExposure = candidate.arguments?.map((argument) => expressionExposure(argument, environment, context, depth + 1)) ?? []
        return mergeExposure(
            exposureIsTainted(constructor)
                ? taintedExposure(exposureTrace(constructor)?.[0] ?? `${context.file}:tainted-constructor`, { identity: true, result: false })
                : cleanExposure(),
            taintedCallValue(argumentsExposure, `${context.file}:tainted-constructor-argument`),
        )
    }

    if (ts.isClassExpression(candidate)) return classExposure(candidate, environment, context, depth + 1)

    if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) {
        return functionExposure(candidate, environment, context, depth + 1)
    }

    if (ts.isObjectLiteralExpression(candidate)) {
        const values = []
        for (const property of candidate.properties) {
            if (ts.isPropertyAssignment(property)) values.push(expressionExposure(property.initializer, environment, context, depth + 1))
            else if (ts.isShorthandPropertyAssignment(property)) values.push(environment.get(property.name.text) ?? cleanExposure())
            else if (ts.isSpreadAssignment(property)) values.push(expressionExposure(property.expression, environment, context, depth + 1))
            else if (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property)) {
                values.push(functionReturnExposure(property, environment, context, depth + 1))
            }
        }
        const nested = mergeExposure(...values)
        return exposureIsTainted(nested)
            ? taintedExposure(exposureTrace(nested)?.[0] ?? `${context.file}:tainted-object-member`, { identity: true, result: false })
            : dtoExposure()
    }

    if (ts.isArrayLiteralExpression(candidate)) {
        const nested = mergeExposure(...candidate.elements.map((element) => expressionExposure(element, environment, context, depth + 1)))
        return exposureIsTainted(nested)
            ? taintedExposure(exposureTrace(nested)?.[0] ?? `${context.file}:tainted-array-member`, { identity: true, result: false })
            : dtoExposure()
    }

    if (ts.isConditionalExpression(candidate)) {
        return mergeExposure(
            expressionExposure(candidate.whenTrue, environment, context, depth + 1),
            expressionExposure(candidate.whenFalse, environment, context, depth + 1),
        )
    }
    if (ts.isBinaryExpression(candidate)) {
        if (
            candidate.operatorToken.kind === ts.SyntaxKind.BarBarToken
            || candidate.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
            || candidate.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
            || candidate.operatorToken.kind === ts.SyntaxKind.CommaToken
            || candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) return mergeExposure(
            expressionExposure(candidate.left, environment, context, depth + 1),
            expressionExposure(candidate.right, environment, context, depth + 1),
        )
        return cleanExposure()
    }
    if (ts.isAwaitExpression(candidate) || ts.isYieldExpression(candidate) || ts.isSpreadElement(candidate)) {
        return expressionExposure(candidate.expression, environment, context, depth + 1)
    }
    if (ts.isCommaListExpression(candidate)) {
        return expressionExposure(candidate.elements.at(-1), environment, context, depth + 1)
    }
    return cleanExposure()
}

function functionScopeDeclarations(body) {
    const declarations = []
    function visit(node) {
        if (node !== body && (
            ts.isArrowFunction(node)
            || ts.isFunctionExpression(node)
            || ts.isFunctionDeclaration(node)
            || ts.isMethodDeclaration(node)
            || ts.isGetAccessorDeclaration(node)
            || ts.isSetAccessorDeclaration(node)
        )) {
            if (ts.isFunctionDeclaration(node) && node.name) declarations.push(node)
            return
        }
        if (ts.isVariableDeclaration(node)) declarations.push(node)
        ts.forEachChild(node, visit)
    }
    visit(body)
    return declarations
}

function assignmentOperator(kind) {
    return kind === ts.SyntaxKind.EqualsToken
        || kind === ts.SyntaxKind.BarBarEqualsToken
        || kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
        || kind === ts.SyntaxKind.QuestionQuestionEqualsToken
}

function scopeAssignments(body) {
    const assignments = []
    function visit(node) {
        if (node !== body && (
            ts.isArrowFunction(node)
            || ts.isFunctionExpression(node)
            || ts.isFunctionDeclaration(node)
            || ts.isMethodDeclaration(node)
            || ts.isGetAccessorDeclaration(node)
            || ts.isSetAccessorDeclaration(node)
        )) return
        if (ts.isBinaryExpression(node) && assignmentOperator(node.operatorToken.kind)) assignments.push(node)
        ts.forEachChild(node, visit)
    }
    visit(body)
    return assignments
}

function scopeMutationCalls(body) {
    const calls = []
    function visit(node) {
        if (node !== body && (
            ts.isArrowFunction(node)
            || ts.isFunctionExpression(node)
            || ts.isFunctionDeclaration(node)
            || ts.isMethodDeclaration(node)
            || ts.isGetAccessorDeclaration(node)
            || ts.isSetAccessorDeclaration(node)
        )) return
        if (ts.isCallExpression(node)) calls.push(node)
        ts.forEachChild(node, visit)
    }
    visit(body)
    return calls
}

function mutationCallKind(expression, environment = null) {
    const candidate = unwrapExpression(expression)
    if (ts.isIdentifier(candidate)) return environment?.get(candidate.text)?.mutationKind ?? null
    if (!ts.isPropertyAccessExpression(candidate) && !ts.isElementAccessExpression(candidate)) return null
    const receiver = unwrapExpression(candidate.expression)
    const member = ts.isPropertyAccessExpression(candidate)
        ? candidate.name.text
        : (ts.isStringLiteralLike(candidate.argumentExpression) ? candidate.argumentExpression.text : null)
    if (!member) return null
    if (ts.isIdentifier(receiver) && receiver.text === 'Object' && ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'].includes(member)) return member
    if (ts.isIdentifier(receiver) && receiver.text === 'Reflect' && ['set', 'defineProperty', 'setPrototypeOf'].includes(member)) {
        if (member === 'set') return 'reflectSet'
        if (member === 'defineProperty') return 'defineProperty'
        return 'setPrototypeOf'
    }
    return null
}

function mutationValueArguments(kind, call) {
    if (kind === 'assign') return call.arguments.slice(1)
    if (kind === 'defineProperties' || kind === 'setPrototypeOf') return call.arguments.slice(1, 2)
    if (kind === 'defineProperty' || kind === 'reflectSet') return call.arguments.slice(2, 3)
    return []
}

function isModuleExportsExpression(node) {
    const candidate = unwrapExpression(node)
    return ts.isPropertyAccessExpression(candidate)
        && candidate.name.text === 'exports'
        && ts.isIdentifier(candidate.expression)
        && candidate.expression.text === 'module'
}

function isCommonJsExportTarget(node) {
    const candidate = unwrapExpression(node)
    if (ts.isIdentifier(candidate) && candidate.text === 'exports') return true
    if (isModuleExportsExpression(candidate)) return true
    return (ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate))
        && isCommonJsExportTarget(candidate.expression)
}

function commonJsExportName(node) {
    const target = unwrapExpression(node)
    if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return null
    if (!isCommonJsExportTarget(target.expression)) return null
    if (ts.isPropertyAccessExpression(target)) return target.name.text
    return ts.isStringLiteralLike(target.argumentExpression) ? target.argumentExpression.text : null
}

function mutationTargetName(expression) {
    const target = unwrapExpression(expression)
    if (ts.isIdentifier(target)) return target.text
    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
        const receiver = unwrapExpression(target.expression)
        return ts.isIdentifier(receiver) ? receiver.text : null
    }
    return null
}

function applyMutationCallSummary(environment, call, context, depth = 0) {
    const kind = mutationCallKind(call.expression, environment)
    const flows = kind && call.arguments[0]
        ? [{
            target: call.arguments[0],
            values: mutationValueArguments(kind, call),
            reason: kind,
        }]
        : (expressionExposure(call.expression, environment, context, depth + 1).argumentMutationFlows ?? []).map((flow) => ({
            target: call.arguments[flow.targetIndex],
            values: flow.valueIndexes.map((index) => call.arguments[index]).filter(Boolean),
            reason: 'callable',
        }))
    let changed = false
    for (const flow of flows) {
        if (!flow.target) continue
        const target = mutationTargetName(flow.target)
        if (!target) continue
        const summary = mergeExposure(...flow.values.map((argument) => expressionExposure(argument, environment, context, depth + 1)))
        if (!exposureIsTainted(summary)) continue
        changed ||= setEnvironmentSummary(
            environment,
            target,
            taintedExposure(exposureTrace(summary)?.[0] ?? `${context.file}:tainted-${flow.reason}-mutation`, { identity: true, result: false }),
        )
    }
    return changed
}

function objectLiteralPropertyExpression(source, name) {
    if (!source) return null
    const candidate = unwrapExpression(source)
    if (!ts.isObjectLiteralExpression(candidate)) return null
    for (const property of candidate.properties) {
        const propertyName = (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name))
            ? property.name.text
            : null
        if (propertyName !== name) continue
        if (ts.isPropertyAssignment(property)) return property.initializer
        if (ts.isShorthandPropertyAssignment(property)) return property.name
    }
    return null
}

function applyAssignmentTargetSummary(environment, targetNode, sourceNode, summary, context, depth = 0) {
    const target = unwrapExpression(targetNode)
    if (ts.isIdentifier(target)) return setEnvironmentSummary(environment, target.text, summary)
    if (ts.isBinaryExpression(target) && assignmentOperator(target.operatorToken.kind)) {
        return applyAssignmentTargetSummary(
            environment,
            target.left,
            sourceNode,
            mergeExposure(summary, expressionExposure(target.right, environment, context, depth + 1)),
            context,
            depth + 1,
        )
    }
    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
        const receiver = unwrapExpression(target.expression)
        if (ts.isIdentifier(receiver) && (summary.identityTainted || summary.resultTainted)) {
            return setEnvironmentSummary(
                environment,
                receiver.text,
                taintedExposure(exposureTrace(summary)?.[0] ?? 'tainted-property-assignment', { identity: true, result: false }),
            )
        }
        return false
    }
    if (ts.isObjectLiteralExpression(target)) {
        let changed = false
        for (const property of target.properties) {
            if (ts.isSpreadAssignment(property)) {
                changed ||= applyAssignmentTargetSummary(environment, property.expression, sourceNode, summary, context, depth + 1)
                continue
            }
            if (ts.isShorthandPropertyAssignment(property)) {
                const source = objectLiteralPropertyExpression(sourceNode, property.name.text)
                const sourceSummary = source
                    ? expressionExposure(source, environment, context, depth + 1)
                    : summary
                const propertySummary = property.objectAssignmentInitializer
                    ? mergeExposure(sourceSummary, expressionExposure(property.objectAssignmentInitializer, environment, context, depth + 1))
                    : sourceSummary
                changed ||= applyAssignmentTargetSummary(environment, property.name, source, propertySummary, context, depth + 1)
                continue
            }
            if (ts.isPropertyAssignment(property)) {
                const name = (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name))
                    ? property.name.text
                    : null
                const source = name === null ? null : objectLiteralPropertyExpression(sourceNode, name)
                const propertySummary = source
                    ? expressionExposure(source, environment, context, depth + 1)
                    : summary
                changed ||= applyAssignmentTargetSummary(environment, property.initializer, source, propertySummary, context, depth + 1)
            }
        }
        return changed
    }
    if (ts.isArrayLiteralExpression(target)) {
        const source = sourceNode ? unwrapExpression(sourceNode) : null
        let changed = false
        for (const [index, element] of target.elements.entries()) {
            if (ts.isOmittedExpression(element)) continue
            const sourceElement = ts.isArrayLiteralExpression(source) ? source.elements[index] : null
            const elementSummary = sourceElement
                ? expressionExposure(sourceElement, environment, context, depth + 1)
                : summary
            const elementTarget = ts.isSpreadElement(element) ? element.expression : element
            changed ||= applyAssignmentTargetSummary(environment, elementTarget, sourceElement, elementSummary, context, depth + 1)
        }
        return changed
    }
    return false
}

function applyAssignmentSummary(environment, assignment, summary, context, depth = 0) {
    return applyAssignmentTargetSummary(environment, assignment.left, assignment.right, summary, context, depth)
}

function mutationEscapeExposure(environment, call, context, depth = 0) {
    const kind = mutationCallKind(call.expression, environment)
    const flows = kind && call.arguments[0]
        ? [{ target: call.arguments[0], values: mutationValueArguments(kind, call), reason: kind }]
        : (expressionExposure(call.expression, environment, context, depth + 1).argumentMutationFlows ?? []).map((flow) => ({
            target: call.arguments[flow.targetIndex],
            values: flow.valueIndexes.map((index) => call.arguments[index]).filter(Boolean),
            reason: 'callable',
        }))
    for (const flow of flows) {
        if (!flow.target) continue
        const target = expressionExposure(flow.target, environment, context, depth + 1)
        if (!target.callerControlled) continue
        const values = flow.values.map((argument) => expressionExposure(argument, environment, context, depth + 1))
        const escaped = values.find((value) => value.identityTainted || value.resultTainted)
        if (escaped) {
            return taintedEffectExposure(exposureTrace(escaped)?.[0] ?? `${context.file}:caller-controlled-${flow.reason}-mutation-escape`)
        }
    }
    return cleanExposure()
}

function assignmentEscapeExposure(environment, assignment, context, depth = 0) {
    const target = unwrapExpression(assignment.left)
    if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return cleanExposure()
    const receiver = expressionExposure(target.expression, environment, context, depth + 1)
    if (!receiver.callerControlled) return cleanExposure()
    const value = expressionExposure(assignment.right, environment, context, depth + 1)
    return (value.identityTainted || value.resultTainted)
        ? taintedEffectExposure(exposureTrace(value)?.[0] ?? `${context.file}:caller-controlled-property-mutation-escape`)
        : cleanExposure()
}

function setEnvironmentSummary(environment, name, summary) {
    const current = environment.get(name)
    const merged = current ? mergeExposure(current, summary) : summary
    const changed = !current
        || exposureSignature(current) !== exposureSignature(merged)
        || current.namespaceTarget !== merged.namespaceTarget
    environment.set(name, merged)
    return changed
}

function classExposure(node, environment, context, depth = 0) {
    const exposures = []
    for (const heritage of node.heritageClauses ?? []) {
        for (const type of heritage.types) exposures.push(expressionExposure(type.expression, environment, context, depth + 1))
    }
    for (const member of node.members ?? []) {
        if (ts.isPropertyDeclaration(member) && member.initializer) {
            exposures.push(expressionExposure(member.initializer, environment, context, depth + 1))
        } else if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member)) {
            exposures.push(functionReturnExposure(member, environment, context, depth + 1))
        } else if (ts.isConstructorDeclaration(member) && member.body) {
            for (const assignment of scopeAssignments(member.body)) exposures.push(expressionExposure(assignment.right, environment, context, depth + 1))
            for (const mutation of scopeMutationCalls(member.body)) {
                const kind = mutationCallKind(mutation.expression, environment)
                const mutationArgs = kind ? mutationValueArguments(kind, mutation) : []
                exposures.push(...mutationArgs.map((argument) => expressionExposure(argument, environment, context, depth + 1)))
            }
        }
    }
    const summary = mergeExposure(...exposures)
    return exposureIsTainted(summary)
        ? taintedExposure(exposureTrace(summary)?.[0] ?? `${context.file}:tainted-class-expression`, { identity: true, result: false })
        : cleanExposure()
}

function functionReturnExposure(node, outerEnvironment, context, depth = 0) {
    if (depth > 40) return taintedExposure(`${context.file}:function-export-analysis-depth-exceeded`)
    const environment = new Map(outerEnvironment)
    for (const parameter of node.parameters ?? []) {
        const defaultExposure = parameter.initializer
            ? expressionExposure(parameter.initializer, outerEnvironment, context, depth + 1)
            : cleanExposure()
        const parameterExposure = { ...defaultExposure, callerControlled: true }
        for (const name of declarationNames(parameter.name)) environment.set(name, parameterExposure)
    }
    if (!node.body) return cleanExposure()
    if (!ts.isBlock(node.body)) return expressionExposure(node.body, environment, context, depth + 1)

    const declarations = functionScopeDeclarations(node.body)
    const assignments = scopeAssignments(node.body)
    const mutationCalls = scopeMutationCalls(node.body)
    for (let iteration = 0; iteration < Math.min(24, declarations.length + assignments.length + mutationCalls.length + 2); iteration += 1) {
        let changed = false
        for (const declaration of declarations) {
            if (ts.isFunctionDeclaration(declaration)) {
                const summary = functionExposure(declaration, environment, context, depth + 1)
                changed ||= setEnvironmentSummary(environment, declaration.name.text, summary)
                continue
            }
            const initializer = declaration.initializer
                ? expressionExposure(declaration.initializer, environment, context, depth + 1)
                : cleanExposure()
            for (const name of declarationNames(declaration.name)) changed ||= setEnvironmentSummary(environment, name, initializer)
        }
        for (const assignment of assignments) {
            changed ||= applyAssignmentSummary(
                environment,
                assignment,
                expressionExposure(assignment.right, environment, context, depth + 1),
                context,
                depth + 1,
            )
        }
        for (const mutation of mutationCalls) {
            changed ||= applyMutationCallSummary(environment, mutation, context, depth + 1)
        }
        if (!changed) break
    }

    const returned = []
    function visitReturns(current) {
        if (current !== node.body && (
            ts.isArrowFunction(current)
            || ts.isFunctionExpression(current)
            || ts.isFunctionDeclaration(current)
            || ts.isMethodDeclaration(current)
            || ts.isGetAccessorDeclaration(current)
            || ts.isSetAccessorDeclaration(current)
        )) return
        if (ts.isReturnStatement(current)) {
            returned.push(expressionExposure(current.expression, environment, context, depth + 1))
            return
        }
        if (ts.isThrowStatement(current)) {
            returned.push(expressionExposure(current.expression, environment, context, depth + 1))
            return
        }
        if (ts.isYieldExpression(current)) {
            returned.push(expressionExposure(current.expression, environment, context, depth + 1))
            return
        }
        ts.forEachChild(current, visitReturns)
    }
    visitReturns(node.body)
    const effects = [
        ...mutationCalls.map((call) => {
            const evaluated = expressionExposure(call, environment, context, depth + 1)
            return evaluated.effectTainted
                ? taintedEffectExposure(exposureTrace(evaluated)?.[0] ?? `${context.file}:tainted-call-effect`)
                : cleanExposure()
        }),
        ...mutationCalls.map((call) => mutationEscapeExposure(environment, call, context, depth + 1)),
        ...assignments.map((assignment) => assignmentEscapeExposure(environment, assignment, context, depth + 1)),
    ]
    return mergeExposure(...returned, ...effects)
}

function moduleEnvironment(file, sourceFile, context) {
    const environment = new Map()
    const requireAliases = commonJsRequireAliases(sourceFile)
    const scopedContext = { ...context, requireAliases }
    const bindReference = (localName, specifier, importedName, namespace = false) => {
        const resolution = resolveImport(context.root, file, specifier, context.fileSet)
        const summary = localReferenceExposure({
            source: file,
            specifier,
            importedName,
            resolution,
            previous: context.previous,
            policy: context.policy,
            providersByFile: context.providersByFile,
            publicImplementationSources: context.publicImplementationSources,
        })
        environment.set(localName, namespace
            ? { ...summary, namespaceTarget: { specifier, resolution } }
            : summary)
    }
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue
        const clause = statement.importClause
        if (!clause || clause.isTypeOnly) continue
        const specifier = statement.moduleSpecifier.text
        if (clause.name) bindReference(clause.name.text, specifier, 'default')
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) bindReference(clause.namedBindings.name.text, specifier, '*', true)
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
                if (!element.isTypeOnly) bindReference(element.name.text, specifier, element.propertyName?.text ?? element.name.text)
            }
        }
    }
    for (const binding of requireBindingRecords(sourceFile)) {
        bindReference(binding.local, binding.specifier, binding.imported, binding.namespace)
    }

    const assignments = scopeAssignments(sourceFile)
    const mutationCalls = scopeMutationCalls(sourceFile)
    for (let iteration = 0; iteration < Math.min(28, sourceFile.statements.length + assignments.length + mutationCalls.length + 2); iteration += 1) {
        let changed = false
        for (const statement of sourceFile.statements) {
            if (ts.isFunctionDeclaration(statement) && statement.name) {
                const summary = functionExposure(statement, environment, scopedContext)
                changed ||= setEnvironmentSummary(environment, statement.name.text, summary)
            } else if (ts.isVariableStatement(statement)) {
                for (const declaration of statement.declarationList.declarations) {
                    const summary = declaration.initializer
                        ? expressionExposure(declaration.initializer, environment, scopedContext)
                        : cleanExposure()
                    for (const name of declarationNames(declaration.name)) changed ||= setEnvironmentSummary(environment, name, summary)
                }
            } else if (ts.isClassDeclaration(statement) && statement.name) {
                changed ||= setEnvironmentSummary(environment, statement.name.text, classExposure(statement, environment, scopedContext))
            }
        }
        for (const assignment of assignments) {
            changed ||= applyAssignmentSummary(
                environment,
                assignment,
                expressionExposure(assignment.right, environment, scopedContext),
                scopedContext,
            )
        }
        for (const mutation of mutationCalls) {
            changed ||= applyMutationCallSummary(environment, mutation, scopedContext)
        }
        if (!changed) break
    }
    return environment
}

function moduleExportSummary(file, sourceFile, context) {
    const scopedContext = { ...context, requireAliases: commonJsRequireAliases(sourceFile) }
    const environment = moduleEnvironment(file, sourceFile, scopedContext)
    const exported = new Map()
    const add = (name, summary, identityName = false) => {
        const runtimeCapability = identityName && !context.suppressRuntimeIdentityName && PERSISTENCE_CAPABILITY.test(name)
            ? taintedExposure(`${file}:exported-runtime-persistence-identity:${name}`, { identity: true, result: false })
            : cleanExposure()
        exported.set(name, mergeExposure(exported.get(name), summary, runtimeCapability))
    }
    const exportedName = (statement) => statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
        ? 'default'
        : statement.name?.text
    const addCommonJsObject = (expression) => {
        const candidate = unwrapExpression(expression)
        if (!ts.isObjectLiteralExpression(candidate)) return false
        for (const property of candidate.properties) {
            if (ts.isPropertyAssignment(property)) {
                const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name)
                    ? property.name.text
                    : null
                if (name) add(name, expressionExposure(property.initializer, environment, scopedContext))
            } else if (ts.isShorthandPropertyAssignment(property)) {
                add(property.name.text, environment.get(property.name.text) ?? cleanExposure())
            } else if (ts.isSpreadAssignment(property)) {
                add('*', expressionExposure(property.expression, environment, scopedContext))
            }
        }
        return true
    }

    for (const statement of sourceFile.statements) {
        if (ts.isExportDeclaration(statement)) {
            if (statement.isTypeOnly) continue
            if (!statement.moduleSpecifier) {
                if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
                    for (const element of statement.exportClause.elements) {
                        if (!element.isTypeOnly) add(element.name.text, environment.get(element.propertyName?.text ?? element.name.text) ?? cleanExposure())
                    }
                }
                continue
            }
            if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue
            const specifier = statement.moduleSpecifier.text
            const resolution = resolveImport(context.root, file, specifier, context.fileSet)
            if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
                for (const element of statement.exportClause.elements) {
                    if (element.isTypeOnly) continue
                    add(element.name.text, localReferenceExposure({
                        source: file,
                        specifier,
                        importedName: element.propertyName?.text ?? element.name.text,
                        resolution,
                        previous: scopedContext.previous,
                        policy: scopedContext.policy,
                        providersByFile: scopedContext.providersByFile,
                        publicImplementationSources: scopedContext.publicImplementationSources,
                    }))
                }
            } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
                add(statement.exportClause.name.text, localReferenceExposure({
                    source: file,
                    specifier,
                    importedName: '*',
                    resolution,
                    previous: scopedContext.previous,
                    policy: scopedContext.policy,
                    providersByFile: scopedContext.providersByFile,
                    publicImplementationSources: scopedContext.publicImplementationSources,
                }))
            } else if (resolution.relationship === 'internal') {
                for (const [name, summary] of moduleExports(scopedContext.previous, resolution.target)) {
                    if (name === 'default') continue
                    add(name, isInternalImplementationTarget(resolution.target)
                        || scopedContext.publicImplementationSources?.has(resolution.target)
                        ? implementationIdentity(summary, resolution.target, `${file}:private-implementation-reexport`)
                        : summary)
                }
            } else if (resolution.relationship !== 'external') {
                add('*', taintedExposure(`${file}:unresolved-export-star:${specifier}`))
            }
            continue
        }

        if (ts.isExportAssignment(statement)) {
            add('default', expressionExposure(statement.expression, environment, scopedContext))
            continue
        }
        if (!hasExportModifier(statement)) continue
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                const initializer = declaration.initializer && unwrapExpression(declaration.initializer)
                const identityValue = Boolean(initializer && (
                    ts.isObjectLiteralExpression(initializer)
                    || ts.isNewExpression(initializer)
                    || ts.isClassExpression(initializer)
                ))
                for (const name of declarationNames(declaration.name)) add(name, environment.get(name) ?? cleanExposure(), identityValue)
            }
            continue
        }
        if (
            ts.isFunctionDeclaration(statement)
            || ts.isClassDeclaration(statement)
            || ts.isEnumDeclaration(statement)
            || ts.isInterfaceDeclaration(statement)
            || ts.isTypeAliasDeclaration(statement)
        ) {
            const name = exportedName(statement)
            if (!name) continue
            add(name, environment.get(statement.name?.text) ?? cleanExposure(), ts.isClassDeclaration(statement))
        }
    }
    function visitCommonJs(node) {
        if (ts.isBinaryExpression(node) && assignmentOperator(node.operatorToken.kind) && isCommonJsExportTarget(node.left)) {
            const name = commonJsExportName(node.left)
            if (name) add(name, expressionExposure(node.right, environment, scopedContext))
            else {
                add('default', expressionExposure(node.right, environment, scopedContext))
                addCommonJsObject(node.right)
            }
        } else if (ts.isCallExpression(node)) {
            const kind = mutationCallKind(node.expression, environment)
            if (kind === 'assign' && node.arguments[0] && isCommonJsExportTarget(node.arguments[0])) {
                for (const argument of node.arguments.slice(1)) {
                    add('*', expressionExposure(argument, environment, scopedContext))
                    addCommonJsObject(argument)
                }
            } else if ((kind === 'defineProperty' || kind === 'reflectSet') && node.arguments[0] && isCommonJsExportTarget(node.arguments[0])) {
                const nameArgument = node.arguments[1]
                const name = nameArgument && ts.isStringLiteralLike(nameArgument) ? nameArgument.text : '*'
                const value = kind === 'reflectSet' ? node.arguments[2] : node.arguments[2]
                if (value) add(name, expressionExposure(value, environment, scopedContext))
            }
        }
        ts.forEachChild(node, visitCommonJs)
    }
    visitCommonJs(sourceFile)
    return exported
}

function cleanTypeExposure(namespaceTarget = null) {
    return { tainted: false, trace: [], namespaceTarget }
}

function taintedTypeExposure(trace) {
    return { tainted: true, trace: [trace], namespaceTarget: null }
}

function mergeTypeExposure(...values) {
    const tainted = values.find((value) => value?.tainted)
    if (tainted) return taintedTypeExposure(tainted.trace?.[0] ?? 'private-implementation-type')
    return values.find((value) => value?.namespaceTarget) ?? cleanTypeExposure()
}

function typeModuleExports(previous, target) {
    return previous.get(target) ?? new Map()
}

function aggregateTypeModuleExposure(previous, target) {
    return mergeTypeExposure(...typeModuleExports(previous, target).values())
}

function localTypeReferenceExposure({ source, specifier, importedName, resolution, context }) {
    if (resolution.relationship === 'unresolved_internal') {
        return taintedTypeExposure(`${source}:unresolved-private-type:${specifier}`)
    }
    if (resolution.relationship === 'external') {
        return (providerForSpecifier(specifier, context.policy) || isPrismaSpecifier(specifier))
            && (importedName === '*' || PRIVATE_IMPLEMENTATION_TYPE.test(importedName))
            ? taintedTypeExposure(`${source}:implementation-package-type:${specifier}`)
            : cleanTypeExposure()
    }
    if (
        (
            isInternalImplementationTarget(resolution.target)
            || resolution.target === 'gravity-mvp/src/lib/prisma.ts'
            || (context.providersByFile.get(resolution.target)?.size ?? 0) > 0
        )
        && (importedName === '*' || PRIVATE_IMPLEMENTATION_TYPE.test(importedName))
    ) return taintedTypeExposure(`${source}:private-implementation-type:${resolution.target}`)
    return importedName === '*'
        ? aggregateTypeModuleExposure(context.previousTypes, resolution.target)
        : (typeModuleExports(context.previousTypes, resolution.target).get(importedName) ?? cleanTypeExposure())
}

function entityNameParts(node) {
    if (ts.isIdentifier(node)) return [node.text]
    if (ts.isQualifiedName(node)) return [...entityNameParts(node.left), node.right.text]
    if (ts.isPropertyAccessExpression(node)) return [...entityNameParts(node.expression), node.name.text]
    return []
}

function typeEntityExposure(node, environment, context) {
    const parts = entityNameParts(node)
    if (parts.length === 0) return cleanTypeExposure()
    const binding = environment.get(parts[0]) ?? cleanTypeExposure()
    if (!binding.namespaceTarget || parts.length === 1) return binding
    return localTypeReferenceExposure({
        source: context.file,
        specifier: binding.namespaceTarget.specifier,
        importedName: parts[1],
        resolution: binding.namespaceTarget.resolution,
        context,
    })
}

function typeSyntaxExposure(node, environment, context, depth = 0) {
    if (!node) return cleanTypeExposure()
    if (depth > 80) return taintedTypeExposure(`${context.file}:type-export-analysis-depth-exceeded`)
    if (ts.isImportTypeNode(node)) {
        if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteralLike(node.argument.literal)) {
            return taintedTypeExposure(`${context.file}:nonliteral-import-type`)
        }
        const specifier = node.argument.literal.text
        const resolution = resolveImport(context.root, context.file, specifier, context.fileSet)
        const qualifierParts = node.qualifier ? entityNameParts(node.qualifier) : []
        return mergeTypeExposure(
            localTypeReferenceExposure({
                source: context.file,
                specifier,
                importedName: qualifierParts[0] ?? '*',
                resolution,
                context,
            }),
            ...(node.typeArguments ?? []).map((argument) => typeSyntaxExposure(argument, environment, context, depth + 1)),
        )
    }
    if (ts.isTypeReferenceNode(node)) {
        return mergeTypeExposure(
            typeEntityExposure(node.typeName, environment, context),
            ...(node.typeArguments ?? []).map((argument) => typeSyntaxExposure(argument, environment, context, depth + 1)),
        )
    }
    if (ts.isTypeQueryNode(node)) {
        return mergeTypeExposure(
            typeEntityExposure(node.exprName, environment, context),
            ...(node.typeArguments ?? []).map((argument) => typeSyntaxExposure(argument, environment, context, depth + 1)),
        )
    }
    if (ts.isExpressionWithTypeArguments(node)) {
        return mergeTypeExposure(
            typeEntityExposure(node.expression, environment, context),
            ...(node.typeArguments ?? []).map((argument) => typeSyntaxExposure(argument, environment, context, depth + 1)),
        )
    }
    const nested = []
    ts.forEachChild(node, (child) => nested.push(typeSyntaxExposure(child, environment, context, depth + 1)))
    return mergeTypeExposure(...nested)
}

function declarationTypeExposure(statement, environment, context) {
    const parts = []
    const add = (node) => { if (node) parts.push(typeSyntaxExposure(node, environment, context)) }
    const addTypeParameters = (node) => { for (const parameter of node.typeParameters ?? []) add(parameter) }
    const addParameters = (node) => {
        for (const parameter of node.parameters ?? []) {
            add(parameter.type)
            for (const typeParameter of parameter.typeParameters ?? []) add(typeParameter)
        }
    }
    const addCallable = (node) => {
        addTypeParameters(node)
        addParameters(node)
        add(node.type)
    }
    if (ts.isTypeAliasDeclaration(statement)) {
        addTypeParameters(statement)
        add(statement.type)
    } else if (ts.isInterfaceDeclaration(statement)) {
        addTypeParameters(statement)
        for (const heritage of statement.heritageClauses ?? []) add(heritage)
        for (const member of statement.members) add(member)
    } else if (ts.isFunctionDeclaration(statement) || ts.isMethodDeclaration(statement) || ts.isMethodSignature(statement)) {
        addCallable(statement)
    } else if (ts.isClassDeclaration(statement) || ts.isClassExpression(statement)) {
        addTypeParameters(statement)
        for (const heritage of statement.heritageClauses ?? []) add(heritage)
        for (const member of statement.members) {
            if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member) || ts.isConstructorDeclaration(member)) addCallable(member)
            else if (ts.isPropertyDeclaration(member)) add(member.type)
        }
    } else if (ts.isVariableDeclaration(statement) || ts.isPropertyDeclaration(statement)) {
        add(statement.type)
        const initializer = statement.initializer && unwrapExpression(statement.initializer)
        if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) addCallable(initializer)
    }
    return mergeTypeExposure(...parts)
}

function moduleTypeEnvironment(file, sourceFile, context) {
    const environment = new Map()
    const bindReference = (localName, specifier, importedName, namespace = false) => {
        const resolution = resolveImport(context.root, file, specifier, context.fileSet)
        const summary = localTypeReferenceExposure({ source: file, specifier, importedName, resolution, context })
        environment.set(localName, namespace
            ? mergeTypeExposure(summary, cleanTypeExposure({ specifier, resolution }))
            : summary)
    }
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue
        const clause = statement.importClause
        if (!clause) continue
        const specifier = statement.moduleSpecifier.text
        if (clause.name) bindReference(clause.name.text, specifier, 'default')
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) bindReference(clause.namedBindings.name.text, specifier, '*', true)
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
                bindReference(element.name.text, specifier, element.propertyName?.text ?? element.name.text)
            }
        }
    }
    for (let iteration = 0; iteration < sourceFile.statements.length + 2; iteration += 1) {
        let changed = false
        for (const statement of sourceFile.statements) {
            const declarations = ts.isVariableStatement(statement)
                ? [...statement.declarationList.declarations]
                : [statement]
            for (const declaration of declarations) {
                const name = declaration.name && ts.isIdentifier(declaration.name) ? declaration.name.text : null
                if (!name) continue
                const summary = declarationTypeExposure(declaration, environment, context)
                const current = environment.get(name)
                const merged = mergeTypeExposure(current, summary)
                if (!current || current.tainted !== merged.tainted || current.namespaceTarget !== merged.namespaceTarget) {
                    environment.set(name, merged)
                    changed = true
                }
            }
        }
        if (!changed) break
    }
    return environment
}

function moduleTypeExportSummary(file, sourceFile, context) {
    const environment = moduleTypeEnvironment(file, sourceFile, context)
    const exported = new Map()
    const add = (name, summary) => exported.set(name, mergeTypeExposure(exported.get(name), summary))
    const reference = (specifier, importedName) => {
        const resolution = resolveImport(context.root, file, specifier, context.fileSet)
        return localTypeReferenceExposure({ source: file, specifier, importedName, resolution, context })
    }
    for (const statement of sourceFile.statements) {
        if (ts.isExportDeclaration(statement)) {
            if (!statement.moduleSpecifier) {
                if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
                    for (const element of statement.exportClause.elements) {
                        add(element.name.text, environment.get(element.propertyName?.text ?? element.name.text) ?? cleanTypeExposure())
                    }
                }
                continue
            }
            if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue
            const specifier = statement.moduleSpecifier.text
            if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
                for (const element of statement.exportClause.elements) {
                    add(element.name.text, reference(specifier, element.propertyName?.text ?? element.name.text))
                }
            } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
                add(statement.exportClause.name.text, reference(specifier, '*'))
            } else {
                const resolution = resolveImport(context.root, file, specifier, context.fileSet)
                if (resolution.relationship === 'internal' && !isInternalImplementationTarget(resolution.target)) {
                    for (const [name, summary] of typeModuleExports(context.previousTypes, resolution.target)) {
                        if (name !== 'default') add(name, summary)
                    }
                } else add('*', reference(specifier, '*'))
            }
            continue
        }
        if (!hasExportModifier(statement)) continue
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                for (const name of declarationNames(declaration.name)) add(name, declarationTypeExposure(declaration, environment, context))
            }
            continue
        }
        const name = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
            ? 'default'
            : statement.name?.text
        if (name) add(name, declarationTypeExposure(statement, environment, context))
    }
    return exported
}

function typeExportMapsEqual(left, right) {
    if (left.size !== right.size) return false
    for (const [file, exports] of left) {
        const other = right.get(file)
        if (!other || exports.size !== other.size) return false
        for (const [name, summary] of exports) {
            if (summary.tainted !== other.get(name)?.tainted) return false
        }
    }
    return true
}

function exportMapsEqual(left, right) {
    if (left.size !== right.size) return false
    for (const [file, exports] of left) {
        const other = right.get(file)
        if (!other || exports.size !== other.size) return false
        for (const [name, summary] of exports) {
            if (exposureSignature(summary) !== exposureSignature(other.get(name))) return false
        }
    }
    return true
}

function derivePublicFacadeExportAnalysis({ root, files, fileSet, bodies, policy, providersByFile, publicImplementationSources }) {
    const roots = files.filter((file) => (
        isPublicFacadeSource(file)
        && !publicImplementationSources.has(file)
        && !isTestFile(file, policy)
    ))
    const parsed = new Map()
    const graph = new Map()
    const sourceFile = (file) => {
        if (!parsed.has(file)) parsed.set(file, ts.createSourceFile(file, bodies.get(file), ts.ScriptTarget.Latest, true))
        return parsed.get(file)
    }
    const dependencies = (file) => {
        if (graph.has(file)) return graph.get(file)
        const resolved = extractClosureImports(bodies.get(file), sourceFile(file)).map((imported) => ({
            imported,
            resolution: resolveImport(root, file, imported.specifier, fileSet),
        })).filter((entry) => entry.resolution.relationship === 'internal')
        graph.set(file, resolved)
        return resolved
    }
    const closures = new Map()
    const relevant = new Set()
    const addClosure = (seed, closure = null) => {
        const queue = [seed]
        const seen = closure ?? new Map([[seed, 0]])
        while (queue.length > 0) {
            const file = queue.shift()
            const distance = seen.get(file)
            for (const { resolution } of dependencies(file)) {
                if (!bodies.has(resolution.target) || seen.has(resolution.target)) continue
                seen.set(resolution.target, distance + 1)
                queue.push(resolution.target)
            }
        }
        return seen
    }
    for (const publicSource of roots) {
        const closure = addClosure(publicSource)
        closures.set(publicSource, closure)
        for (const file of closure.keys()) relevant.add(file)
    }
    // Semantic public-path implementations are intentionally not public
    // roots, but they must participate in the same fixed point. Otherwise a
    // cross-context named business operation can never be proved clean merely
    // because its owner facade does not barrel-re-export it.
    for (const implementationSource of publicImplementationSources) {
        if (isTestFile(implementationSource, policy)) continue
        for (const file of addClosure(implementationSource).keys()) relevant.add(file)
    }

    let previous = new Map([...relevant].map((file) => [file, new Map()]))
    for (let iteration = 0; iteration < relevant.size + 3; iteration += 1) {
        const next = new Map()
        for (const file of relevant) {
            next.set(file, moduleExportSummary(file, sourceFile(file), {
                root,
                file,
                fileSet,
                previous,
                policy,
                providersByFile,
                publicImplementationSources,
            }))
        }
        if (exportMapsEqual(previous, next)) {
            previous = next
            break
        }
        previous = next
    }

    let previousTypes = new Map([...relevant].map((file) => [file, new Map()]))
    for (let iteration = 0; iteration < relevant.size + 3; iteration += 1) {
        const next = new Map()
        for (const file of relevant) {
            next.set(file, moduleTypeExportSummary(file, sourceFile(file), {
                root,
                file,
                fileSet,
                previousTypes,
                policy,
                providersByFile,
                publicImplementationSources,
            }))
        }
        if (typeExportMapsEqual(previousTypes, next)) {
            previousTypes = next
            break
        }
        previousTypes = next
    }

    return { roots, sourceFile, closures, exportSummaries: previous, typeExportSummaries: previousTypes }
}

function isCleanPublicImplementationBinding({
    source,
    target,
    imported,
    sourceContext,
    targetContext,
    exportSummaries,
    allowCrossContext = false,
}) {
    const sameContext = sourceContext === targetContext
    // The source file is semantic implementation because it binds a
    // primitive.  Its *individual* public business operations are still a
    // versioned contract when their export summary proves they attenuate that
    // primitive.  Same-context barrels must remain exact/unaliased; a
    // cross-context consumer may use a named import alias because the AST
    // binding retains the exact originating symbol.
    if (sameContext) {
        if (!isPublicFacadeSource(source)) return false
    } else if (!allowCrossContext || !isVersionedPublicTarget(target)) {
        return false
    }
    if (!imported || (sameContext ? !['static', 'export'].includes(imported.kind) : imported.kind !== 'static')) return false
    const bindings = imported.imports ?? []
    if (bindings.length === 0) return false
    const targetExports = moduleExports(exportSummaries, target)
    return bindings.every((binding) => {
        if (binding.kind !== 'named') return false
        if (sameContext && binding.imported !== binding.local) return false
        // The same-context compatibility escape applies only to business
        // operations and inert DTOs. A value that names an adapter, port,
        // repository or concrete Prisma primitive is still implementation
        // identity even when a shallow result scan is clean.
        if (/(?:^legacyPrisma|(?:Adapter|Repository|Port|PrismaClient)(?:V[0-9]+)?$)/iu.test(binding.imported)) return false
        if (!targetExports.has(binding.imported)) return false
        const summary = targetExports.get(binding.imported)
        return !exposureIsTainted(summary) && Boolean(summary.knownCallable || summary.knownDto)
    })
}

function isCleanPublicImplementationTypeBinding({
    source,
    target,
    imported,
    sourceContext,
    targetContext,
    typeExportSummaries,
    allowCrossContext = false,
}) {
    const sameContext = sourceContext === targetContext
    if (sameContext) {
        if (!isPublicFacadeSource(source)) return false
    } else if (!allowCrossContext || !isVersionedPublicTarget(target)) {
        return false
    }
    if (!imported || (sameContext ? !['static', 'export'].includes(imported.kind) : imported.kind !== 'static')) return false
    const bindings = imported.typeImports ?? []
    if (bindings.length === 0 || (imported.imports ?? []).length > 0) return false
    const targetExports = typeModuleExports(typeExportSummaries, target)
    return bindings.every((binding) => {
        if (binding.kind !== 'named') return false
        if (sameContext && binding.imported !== binding.local) return false
        const summary = targetExports.get(binding.imported)
        return Boolean(summary && !summary.tainted)
    })
}

function publicClosureFindings({ root, files, fileSet, bodies, policy, providersByFile, publicImplementationSources, analysis = null }) {
    const derived = analysis ?? derivePublicFacadeExportAnalysis({
        root,
        files,
        fileSet,
        bodies,
        policy,
        providersByFile,
        publicImplementationSources,
    })
    const { roots, sourceFile, closures, exportSummaries: previous, typeExportSummaries } = derived
    const findings = []

    // Primitive-binding files under a legacy public path are semantic
    // implementation sources, not public roots. Still reject an actual
    // handle if such a file exports one directly. This is result-taint only:
    // a narrow callable returning a DTO remains usable through its owner
    // barrel, while `export const client = prisma` cannot hide behind an
    // arbitrary filename.
    for (const file of publicImplementationSources) {
        if (isTestFile(file, policy)) continue
        const exports = moduleExportSummary(file, sourceFile(file), {
            root,
            file,
            fileSet,
            previous: new Map(),
            policy,
            providersByFile,
            publicImplementationSources,
            suppressRuntimeIdentityName: true,
        })
        for (const [name, summary] of exports) {
            if (!exposureIsTainted(summary)) continue
            findings.push(makeFinding({
                rule: 'public_facade_implementation_laundering',
                file,
                subject: `reachable-export-implementation:${name}`,
                details: {
                    public_source: file,
                    export: name,
                    reason: 'a public-path implementation source directly exports a persistence/provider identity',
                    trace: exposureTrace(summary),
                },
            }))
        }
    }
    for (const publicSource of roots) {
        for (const [name, summary] of typeModuleExports(typeExportSummaries, publicSource)) {
            if (!summary.tainted) continue
            findings.push(makeFinding({
                rule: 'public_facade_implementation_laundering',
                file: publicSource,
                sourceContext: null,
                subject: `reachable-export-internal-type:${name}`,
                details: {
                    public_source: publicSource,
                    export: name,
                    reason: 'public export can expose a private persistence/provider implementation type',
                    trace: summary.trace,
                },
            }))
        }
        for (const [name, summary] of moduleExports(previous, publicSource)) {
            if (!exposureIsTainted(summary)) continue
            findings.push(makeFinding({
                rule: 'public_facade_implementation_laundering',
                file: publicSource,
                sourceContext: null,
                subject: `reachable-export-implementation:${name}`,
                details: {
                    public_source: publicSource,
                    export: name,
                    reason: 'public export can expose a private persistence/provider implementation value',
                    trace: exposureTrace(summary),
                },
            }))
        }

        for (const file of closures.get(publicSource).keys()) {
            const applicationOrPublic = (
                isPublicFacadeSource(file) && !publicImplementationSources.has(file)
            ) || isOwnerApplicationCompositionTarget(file)
            if (!applicationOrPublic) continue
            const body = bodies.get(file)
            for (const loaded of extractNonliteralModuleLoads(body)) {
                findings.push(makeFinding({
                    rule: 'public_facade_implementation_laundering', file, line: lineAt(body, loaded.index),
                    subject: `reachable-nonliteral-${loaded.kind}`,
                    details: { public_source: publicSource, reason: 'public/application closure contains a nonliteral module load' },
                }))
            }
            if (!isOwnerApplicationCompositionTarget(file)) continue
            for (const write of extractPrismaWrites(body)) {
                findings.push(makeFinding({
                    rule: 'public_facade_implementation_laundering', file, line: lineAt(body, write.index),
                    subject: write.kind === 'model' ? `reachable-write:${write.model}.${write.method}` : `reachable-write:raw:${write.method}`,
                    siteSignature: write.siteSignature,
                    details: { public_source: publicSource, reason: 'public application closure performs a persistence write' },
                }))
            }
            for (const imported of extractImports(body)) {
                const resolution = resolveImport(root, file, imported.specifier, fileSet)
                const provider = providerForSpecifier(imported.specifier, policy)
                const targetProviders = resolution.relationship === 'internal'
                    ? [...(providersByFile.get(resolution.target) ?? [])]
                    : []
                if (
                    provider
                    || isPrismaSpecifier(imported.specifier)
                    || resolution.target === 'gravity-mvp/src/lib/prisma.ts'
                    || targetProviders.length > 0
                ) findings.push(makeFinding({
                    rule: 'public_facade_implementation_laundering', file, line: lineAt(body, imported.index),
                    subject: `reachable-implementation-import:${imported.specifier}`,
                    details: { public_source: publicSource, provider, target: resolution.target, target_providers: targetProviders },
                }))
            }
        }
    }
    return findings
}

function makeFinding(input) {
    return {
        rule: input.rule,
        file: input.file,
        line: input.line ?? null,
        source_context: input.sourceContext ?? null,
        target_context: input.targetContext ?? null,
        subject: input.subject,
        site_signature: input.siteSignature ?? null,
        details: input.details ?? {},
    }
}

function finalizeFindings(findings) {
    const ordinals = new Map()
    return findings
        .sort((left, right) => left.file.localeCompare(right.file) || (left.line ?? 0) - (right.line ?? 0) || left.rule.localeCompare(right.rule) || left.subject.localeCompare(right.subject))
        .map((finding) => {
            const ordinalKey = `${finding.rule}|${finding.file}|${finding.subject}|${finding.site_signature ?? ''}`
            const ordinal = (ordinals.get(ordinalKey) ?? 0) + 1
            ordinals.set(ordinalKey, ordinal)
            const identity = {
                rule: finding.rule,
                file: finding.file,
                source_context: finding.source_context,
                target_context: finding.target_context,
                subject: finding.subject,
                site_signature: finding.site_signature,
                ordinal,
            }
            return { ...finding, ordinal, fingerprint: `arch_${digest(identity).slice(0, 24)}` }
        })
}

export async function scanArchitecture(root = repositoryRoot) {
    const policy = await loadJson(root, 'architecture/enforcement/v1/policy.json')
    const moduleRules = await loadJson(root, 'architecture/evidence/v1/module-rules.json')
    const providerEvidence = await loadJson(root, 'architecture/evidence/v1/provider-dependencies.json')
    const index = await loadJson(root, 'architecture/contexts/v1/context-index.json')
    const manifestIntegrityFindings = []
    const baseManifests = await Promise.all(index.contexts.map(async (entry) => {
        const raw = await readFile(path.join(root, entry.path), 'utf8')
        if (digest(raw) !== entry.sha256) {
            manifestIntegrityFindings.push({
                rule: 'manifest_inconsistency',
                file: entry.path,
                subject: `sha256:${entry.sha256}->${digest(raw)}`,
            })
        }
        const manifest = JSON.parse(raw)
        if (manifest.context?.id !== entry.context) {
            manifestIntegrityFindings.push({
                rule: 'manifest_inconsistency',
                file: entry.path,
                subject: `index-context:${entry.context}->${manifest.context?.id ?? 'missing'}`,
            })
        }
        return manifest
    }))
    const duplicateContexts = index.contexts
        .map((entry) => entry.context)
        .filter((context, position, contexts) => contexts.indexOf(context) !== position)
    for (const context of new Set(duplicateContexts)) {
        manifestIntegrityFindings.push({
            rule: 'manifest_inconsistency',
            file: 'architecture/contexts/v1/context-index.json',
            subject: `duplicate-context:${context}`,
        })
    }
    const amendments = await Promise.all(policy.manifest_amendments.map((item) => loadJson(root, item)))
    const state = contextState(policy, moduleRules, baseManifests, amendments)
    const excludes = new Set(policy.exclude_segments)
    const absoluteFiles = []
    for (const sourceRoot of policy.source_roots) await walk(path.join(root, sourceRoot), excludes, absoluteFiles)
    const files = absoluteFiles.map((absolute) => path.relative(root, absolute).split(path.sep).join('/')).sort()
    const fileSet = new Set(files)
    const bodies = new Map(await Promise.all(files.map(async (file) => [file, await readFile(path.join(root, file), 'utf8')])))
    const findings = [...manifestIntegrityFindings, ...validateManifestPolicy(state.effectiveManifests, amendments)]
    const observedCrossContextImports = []
    const sensitiveEnvironment = new RegExp(policy.sensitive_environment_pattern, 'i')
    const approvedWriters = new Set(policy.approved_infrastructure_writers.map((item) => `${item.file}|${item.model}`))
    const providersByFile = new Map()
    for (const provider of providerEvidence.providers) {
        const canonicalProvider = policy.provider_aliases?.[provider.provider] ?? provider.provider
        for (const evidence of provider.evidence) {
            // The CRM-ARCH-002 evidence inventory intentionally records broad
            // textual mentions.  Only a path match identifies a provider-facing
            // module strongly enough to enforce transport ownership here.  SDK
            // imports are enforced independently by providerForSpecifier().
            if (evidence.match_kind !== 'path') continue
            if (!providersByFile.has(evidence.file)) providersByFile.set(evidence.file, new Set())
            providersByFile.get(evidence.file).add(canonicalProvider)
        }
    }
    const publicImplementationSources = directPublicImplementationSources({
        root,
        files,
        fileSet,
        bodies,
        policy,
        providersByFile,
    })
    const publicFacadeExportAnalysis = derivePublicFacadeExportAnalysis({
        root,
        files,
        fileSet,
        bodies,
        policy,
        providersByFile,
        publicImplementationSources,
    })

    for (const file of files) {
        if (isTestFile(file, policy)) continue
        const body = bodies.get(file)
        const source = state.classifyFile(file)
        if (!source.context) {
            findings.push(makeFinding({
                rule: 'unclassified_production_source', file, sourceContext: null,
                subject: source.module,
            }))
            continue
        }
        const manifest = state.manifestsByContext.get(source.context)
        const effectivePublicFacade = isPublicFacadeSource(file) && !publicImplementationSources.has(file)
        const addPublicImplementationFinding = (finding) => findings.push(finding)

        if (file === 'gravity-mvp/src/infrastructure/contact-merge-composition.ts') {
            for (const exposure of extractUnsafeContactMergeCompositionExports(body)) {
                findings.push(makeFinding({
                    rule: 'public_facade_implementation_laundering',
                    file,
                    line: lineAt(body, exposure.index),
                    sourceContext: source.context,
                    subject: exposure.subject,
                    details: { reason: 'the shared contact-merge root may export only its exact composed business operation' },
                }))
            }
        }

        if (effectivePublicFacade) {
            for (const loaded of extractNonliteralModuleLoads(body)) {
                addPublicImplementationFinding(makeFinding({
                    rule: 'public_facade_internal_import', file, line: lineAt(body, loaded.index),
                    sourceContext: source.context,
                    subject: `${source.module}:nonliteral-${loaded.kind}`,
                    details: { kind: loaded.kind, reason: 'public facades must use statically resolvable module specifiers' },
                }))
            }
            for (const commonJs of extractCommonJsPublicExposure(body)) {
                addPublicImplementationFinding(makeFinding({
                    rule: 'public_facade_implementation_laundering', file, line: lineAt(body, commonJs.index),
                    sourceContext: source.context,
                    subject: commonJs.subject,
                    details: { reason: 'public facades must use ESM business-operation exports; CommonJS export and require forms are implementation-only' },
                }))
            }
        }
        for (const imported of extractImports(body)) {
            const resolution = resolveImport(root, file, imported.specifier, fileSet)
            if (resolution.relationship === 'unresolved_internal') {
                findings.push(makeFinding({
                    rule: 'unresolved_internal_import', file, line: lineAt(body, imported.index),
                    sourceContext: source.context, subject: `${imported.specifier}->${resolution.target}`,
                }))
                continue
            }
            if (resolution.relationship === 'external') {
                const provider = providerForSpecifier(imported.specifier, policy)
                if (provider && !state.providerAllowedContexts.get(provider)?.has(source.context)) {
                    findings.push(makeFinding({
                        rule: 'direct_provider_transport_access', file, line: lineAt(body, imported.index),
                        sourceContext: source.context, subject: `${provider}:${imported.specifier}`,
                        details: { provider, specifier: imported.specifier },
                    }))
                }
                continue
            }

            const target = state.classifyFile(resolution.target)
            const directInternalTarget = /^gravity-mvp\/src\/modules\/[^/]+\/internal(?:\/|$)/.test(resolution.target)
            const internalTarget = directInternalTarget || publicImplementationSources.has(resolution.target)
            const cleanSameContextPublicImplementationBinding = publicImplementationSources.has(resolution.target)
                && isCleanPublicImplementationBinding({
                    source: file,
                    target: resolution.target,
                    imported,
                    sourceContext: source.context,
                    targetContext: target.context,
                    exportSummaries: publicFacadeExportAnalysis.exportSummaries,
                })
            const cleanCrossContextPublicImplementationBinding = publicImplementationSources.has(resolution.target)
                && isCleanPublicImplementationBinding({
                    source: file,
                    target: resolution.target,
                    imported,
                    sourceContext: source.context,
                    targetContext: target.context,
                    exportSummaries: publicFacadeExportAnalysis.exportSummaries,
                    allowCrossContext: true,
                })
            const cleanSameContextPublicImplementationTypeBinding = publicImplementationSources.has(resolution.target)
                && isCleanPublicImplementationTypeBinding({
                    source: file,
                    target: resolution.target,
                    imported,
                    sourceContext: source.context,
                    targetContext: target.context,
                    typeExportSummaries: publicFacadeExportAnalysis.typeExportSummaries,
                })
            const cleanCrossContextPublicImplementationTypeBinding = publicImplementationSources.has(resolution.target)
                && isCleanPublicImplementationTypeBinding({
                    source: file,
                    target: resolution.target,
                    imported,
                    sourceContext: source.context,
                    targetContext: target.context,
                    typeExportSummaries: publicFacadeExportAnalysis.typeExportSummaries,
                    allowCrossContext: true,
                })
            const approvedContactMergeBinding = isApprovedContactMergeCompositionImport(file, resolution.target, imported)
            const targetProviders = [...(providersByFile.get(resolution.target) ?? [])]
            if (effectivePublicFacade && isOwnerApplicationCompositionTarget(resolution.target)) {
                const compositionBody = bodies.get(resolution.target)
                if (target.context !== source.context || !compositionBody) {
                    findings.push(makeFinding({
                        rule: 'public_facade_implementation_laundering', file, line: lineAt(body, imported.index),
                        sourceContext: source.context, targetContext: target.context,
                        subject: `invalid-application-composition:${resolution.target}`,
                    }))
                } else {
                    for (const exposure of extractUnsafeApplicationCompositionExports(compositionBody)) {
                        findings.push(makeFinding({
                            rule: 'public_facade_implementation_laundering', file: resolution.target,
                            line: lineAt(compositionBody, exposure.index), sourceContext: source.context,
                            subject: `transitive:${exposure.subject}`,
                            details: { public_source: file, reason: 'public application composition may export only narrow business functions' },
                        }))
                    }
                    for (const loaded of extractNonliteralModuleLoads(compositionBody)) {
                        findings.push(makeFinding({
                            rule: 'public_facade_implementation_laundering', file: resolution.target,
                            line: lineAt(compositionBody, loaded.index), sourceContext: source.context,
                            subject: `transitive:nonliteral-${loaded.kind}`,
                            details: { public_source: file },
                        }))
                    }
                    for (const write of extractPrismaWrites(compositionBody)) {
                        findings.push(makeFinding({
                            rule: 'public_facade_implementation_laundering', file: resolution.target,
                            line: lineAt(compositionBody, write.index), sourceContext: source.context,
                            subject: write.kind === 'model' ? `transitive-write:${write.model}.${write.method}` : `transitive-write:raw:${write.method}`,
                            siteSignature: write.siteSignature, details: { public_source: file },
                        }))
                    }
                    for (const nested of extractImports(compositionBody)) {
                        const nestedResolution = resolveImport(root, resolution.target, nested.specifier, fileSet)
                        const nestedProvider = providerForSpecifier(nested.specifier, policy)
                        const nestedTargetProviders = nestedResolution.relationship === 'internal'
                            ? [...(providersByFile.get(nestedResolution.target) ?? [])]
                            : []
                        if (
                            nestedProvider
                            || isPrismaSpecifier(nested.specifier)
                            || nestedResolution.target === 'gravity-mvp/src/lib/prisma.ts'
                            || nestedTargetProviders.length > 0
                        ) {
                            findings.push(makeFinding({
                                rule: 'public_facade_implementation_laundering', file: resolution.target,
                                line: lineAt(compositionBody, nested.index), sourceContext: source.context,
                                subject: `transitive-implementation-import:${nested.specifier}`,
                                details: { public_source: file, provider: nestedProvider, target: nestedResolution.target },
                            }))
                        }
                    }
                }
            }
            if (
                effectivePublicFacade
                && internalTarget
                && !cleanSameContextPublicImplementationBinding
                && !cleanSameContextPublicImplementationTypeBinding
            ) {
                addPublicImplementationFinding(makeFinding({
                    rule: 'public_facade_internal_import', file, line: lineAt(body, imported.index),
                    sourceContext: source.context, targetContext: target.context,
                    subject: `${source.module}>${target.module}:${resolution.target}`,
                    details: { specifier: imported.specifier, target: resolution.target },
                }))
            }
            if (!target.context || target.context === source.context) continue
            observedCrossContextImports.push({
                kind: imported.kind,
                source_context: source.context,
                source_file: file,
                specifier: imported.specifier,
                target_context: target.context,
                target_file: resolution.target,
            })
            for (const provider of providersByFile.get(resolution.target) ?? []) {
                if (!state.providerAllowedContexts.get(provider)?.has(source.context)) {
                    findings.push(makeFinding({
                        rule: 'direct_provider_transport_access', file, line: lineAt(body, imported.index),
                        sourceContext: source.context, targetContext: target.context,
                        subject: `provider-module:${provider}:${resolution.target}`,
                        details: { provider, specifier: imported.specifier, target: resolution.target },
                    }))
                }
            }

            if (isSharedInfrastructure(resolution.target, policy)) continue
            const targetManifest = state.manifestsByContext.get(target.context)
            const crossContextInternalTarget = targetManifest.internal_surface.some((surface) => matchesSurface(resolution.target, surface))
                || (internalTarget && !cleanCrossContextPublicImplementationBinding && !cleanCrossContextPublicImplementationTypeBinding)
            if (crossContextInternalTarget && !approvedContactMergeBinding) {
                findings.push(makeFinding({
                    rule: 'internal_module_import', file, line: lineAt(body, imported.index),
                    sourceContext: source.context, targetContext: target.context,
                    subject: `${source.module}>${target.module}:${resolution.target}`,
                    details: { specifier: imported.specifier, target: resolution.target },
                }))
            }
            const allowed = manifest.allowed_dependencies.some((dependency) => dependency.context === target.context)
            if (!allowed) {
                findings.push(makeFinding({
                    rule: 'undeclared_dependency', file, line: lineAt(body, imported.index),
                    sourceContext: source.context, targetContext: target.context,
                    subject: `${source.module}>${target.module}:${resolution.target}`,
                    details: { specifier: imported.specifier, target: resolution.target },
                }))
            }
            const versionedPublicTarget = (
                isVersionedPublicTarget(resolution.target)
                && (
                    !publicImplementationSources.has(resolution.target)
                    || cleanCrossContextPublicImplementationBinding
                    || cleanCrossContextPublicImplementationTypeBinding
                )
            ) || approvedContactMergeBinding
            if (!versionedPublicTarget) {
                findings.push(makeFinding({
                    rule: 'non_public_cross_context_import', file, line: lineAt(body, imported.index),
                    sourceContext: source.context, targetContext: target.context,
                    subject: `${source.module}>${target.module}:${resolution.target}`,
                    details: { specifier: imported.specifier, target: resolution.target },
                }))
            }
            const contractTarget = /^gravity-mvp\/src\/(?:contracts\/[^/]+|modules\/[^/]+\/public)(?:\/|$)/.test(resolution.target)
            if (contractTarget && !versionedPublicTarget) {
                findings.push(makeFinding({
                    rule: 'contract_version_violation', file, line: lineAt(body, imported.index),
                    sourceContext: source.context, targetContext: target.context,
                    subject: `${imported.specifier}->${resolution.target}`,
                }))
            }
        }

        const allowedEnvironment = new Set(manifest.credential_relationships?.environment_names ?? [])
        for (const accessSite of extractEnvironmentAccess(body)) {
            if (sensitiveEnvironment.test(accessSite.name) && !allowedEnvironment.has(accessSite.name)) {
                findings.push(makeFinding({
                    rule: 'disallowed_credential_access', file, line: lineAt(body, accessSite.index),
                    sourceContext: source.context, subject: `environment:${accessSite.name}`,
                    details: { name: accessSite.name, type: 'environment' },
                }))
            }
        }

        for (const write of extractPrismaWrites(body)) {
            if (write.kind === 'model') {
                const owner = state.modelOwners.get(write.model.toLowerCase())
                if (!owner) {
                    findings.push(makeFinding({
                        rule: 'direct_foreign_prisma_write', file, line: lineAt(body, write.index),
                        sourceContext: source.context, subject: `UNOWNED:${write.model}.${write.method}`,
                        siteSignature: write.siteSignature,
                        details: { model: write.model, method: write.method, owner: null },
                    }))
                } else if (
                    owner.context !== source.context
                    && !approvedWriters.has(`${file}|${owner.model}`)
                ) {
                    findings.push(makeFinding({
                        rule: 'direct_foreign_prisma_write', file, line: lineAt(body, write.index),
                        sourceContext: source.context, targetContext: owner.context,
                        subject: `${owner.model}.${write.method}`,
                        siteSignature: write.siteSignature,
                        details: { model: owner.model, method: write.method, owner: owner.context },
                    }))
                }
            } else {
                const resolvedOwners = write.tables.map((table) => state.tableOwners.get(table.toLowerCase()) ?? null)
                const owners = [...new Set(resolvedOwners.filter(Boolean))]
                const unresolved = write.tables.filter((_, index) => resolvedOwners[index] === null)
                if (write.dynamic || unresolved.length > 0 || owners.length !== 1 || owners[0] !== source.context) {
                    findings.push(makeFinding({
                        rule: 'direct_foreign_prisma_write', file, line: lineAt(body, write.index),
                        sourceContext: source.context, targetContext: !write.dynamic && unresolved.length === 0 && owners.length === 1 ? owners[0] : null,
                        subject: `raw:${write.method}:${write.dynamic ? 'dynamic' : write.tables.join(',') || 'dynamic'}`,
                        siteSignature: write.siteSignature,
                        details: { method: write.method, tables: write.tables, owners, unresolved, dynamic: write.dynamic },
                    }))
                }
            }
        }
    }

    const existingPublicFindingKeys = new Set(findings.map((finding) => [
        finding.rule,
        finding.file,
        finding.line ?? null,
        finding.subject,
        finding.site_signature ?? null,
    ].join('|')))
    for (const finding of publicClosureFindings({
        root,
        files,
        fileSet,
        bodies,
        policy,
        providersByFile,
        publicImplementationSources,
        analysis: publicFacadeExportAnalysis,
    })) {
        const key = [finding.rule, finding.file, finding.line ?? null, finding.subject, finding.site_signature ?? null].join('|')
        if (!existingPublicFindingKeys.has(key)) {
            existingPublicFindingKeys.add(key)
            findings.push(finding)
        }
    }

    let finalizedFindings = finalizeFindings(findings)
    if (policy.legacy_write_supplement) {
        const supplement = await loadJson(root, policy.legacy_write_supplement)
        const supplementalErrors = []
        const supplementalFingerprints = new Set()
        if (
            supplement.schema !== 'yoko.crm.architecture-legacy-write-supplement.v1'
            || supplement.controls?.site_count !== supplement.sites?.length
            || supplement.controls?.deadline !== policy.exception_review_deadline
            || supplement.controls?.wildcards !== false
        ) supplementalErrors.push('identity-or-controls')
        for (const site of supplement.sites ?? []) {
            if (supplementalFingerprints.has(site.fingerprint)) supplementalErrors.push(`duplicate:${site.fingerprint}`)
            supplementalFingerprints.add(site.fingerprint)
            const finding = finalizedFindings.find((item) => item.fingerprint === site.fingerprint)
            if (
                finding?.rule !== 'direct_foreign_prisma_write'
                || finding.file !== site.file
                || finding.source_context !== site.caller_context
                || finding.target_context !== site.owner_context
                || finding.subject !== site.operation
            ) supplementalErrors.push(`site-mismatch:${site.fingerprint}`)
        }
        if (supplementalErrors.length > 0) {
            finalizedFindings = finalizeFindings([
                ...findings,
                ...supplementalErrors.map((subject) => ({
                    rule: 'manifest_inconsistency',
                    file: policy.legacy_write_supplement,
                    subject: `legacy-write-supplement:${subject}`,
                })),
            ])
        }
    }

    return {
        policy,
        findings: finalizedFindings,
        observed_cross_context_imports: observedCrossContextImports.sort((left, right) => left.source_context.localeCompare(right.source_context) || left.target_context.localeCompare(right.target_context) || left.source_file.localeCompare(right.source_file) || left.target_file.localeCompare(right.target_file) || left.specifier.localeCompare(right.specifier)),
        scanned_files: files.length,
        contexts: state.effectiveManifests.length,
    }
}

export function evaluateFindings(findings, registry, policy, now = new Date()) {
    const errors = []
    const findingByFingerprint = new Map(findings.map((finding) => [finding.fingerprint, finding]))
    const exceptionByFingerprint = new Map()
    const unexceptionable = new Set(policy.unexceptionable_rules)

    if (policy.strict_exception_registry) {
        if (
            registry.schema !== 'yoko.crm.architecture-exception-registry.v1'
            || registry.version !== 1
            || registry.milestone !== policy.registry_milestone
            || registry.base_commit !== policy.registry_base_commit
            || registry.policy?.exact_fingerprint_only !== true
            || registry.policy?.stale_exceptions_fail !== true
            || registry.policy?.expired_exceptions_fail !== true
            || registry.policy?.uncovered_violations_fail !== true
            || registry.policy?.deadline !== policy.exception_review_deadline
        ) errors.push({ type: 'INVALID_REGISTRY_IDENTITY' })
        if (registry.finding_digest !== digest(findings)) {
            errors.push({ type: 'FINDING_DIGEST_MISMATCH', expected: digest(findings), actual: registry.finding_digest ?? null })
        }
    }

    for (const exception of registry.exceptions ?? []) {
        if (!exception.fingerprint || !exception.rule || !exception.file || !exception.owner_context
            || !exception.rationale || !exception.retirement || !exception.expires_on) {
            errors.push({ type: 'INVALID_EXCEPTION', exception })
            continue
        }
        if (exceptionByFingerprint.has(exception.fingerprint)) {
            errors.push({ type: 'DUPLICATE_EXCEPTION', fingerprint: exception.fingerprint })
            continue
        }
        exceptionByFingerprint.set(exception.fingerprint, exception)
        if (unexceptionable.has(exception.rule)) {
            errors.push({ type: 'UNEXCEPTIONABLE_RULE', fingerprint: exception.fingerprint, rule: exception.rule })
        }
        const expiry = new Date(`${exception.expires_on}T23:59:59.999Z`)
        if (Number.isNaN(expiry.getTime()) || now > expiry) {
            errors.push({ type: 'EXPIRED_EXCEPTION', fingerprint: exception.fingerprint, expires_on: exception.expires_on })
        }
    }

    for (const finding of findings) {
        if (unexceptionable.has(finding.rule) || !exceptionByFingerprint.has(finding.fingerprint)) {
            errors.push({ type: 'UNCOVERED_VIOLATION', finding })
        } else {
            const exception = exceptionByFingerprint.get(finding.fingerprint)
            if (
                exception.rule !== finding.rule
                || exception.file !== finding.file
                || exception.owner_context !== finding.source_context
                || (exception.target_context ?? null) !== finding.target_context
                || exception.subject !== finding.subject
                || exception.ordinal !== finding.ordinal
                || (exception.site_signature ?? null) !== (finding.site_signature ?? null)
            ) {
                errors.push({ type: 'EXCEPTION_IDENTITY_MISMATCH', finding, exception })
            }
        }
    }
    for (const exception of registry.exceptions ?? []) {
        if (!findingByFingerprint.has(exception.fingerprint)) {
            errors.push({ type: 'STALE_EXCEPTION', fingerprint: exception.fingerprint, rule: exception.rule, file: exception.file })
        }
    }

    return {
        ok: errors.length === 0,
        errors,
        findings: findings.length,
        exceptions: registry.exceptions?.length ?? 0,
        by_rule: Object.fromEntries([...new Set(findings.map((finding) => finding.rule))].sort().map((rule) => [
            rule,
            findings.filter((finding) => finding.rule === rule).length,
        ])),
    }
}

async function main() {
    const candidatesOnly = process.argv.includes('--candidates')
    const scan = await scanArchitecture(repositoryRoot)
    if (candidatesOnly) {
        process.stdout.write(`${JSON.stringify({
            schema: 'yoko.crm.architecture-finding-candidates.v1',
            generated_from: digest(scan.findings),
            scanned_files: scan.scanned_files,
            contexts: scan.contexts,
            findings: scan.findings,
        }, null, 2)}\n`)
        return
    }
    const registry = await loadJson(repositoryRoot, scan.policy.exception_registry)
    const result = evaluateFindings(scan.findings, registry, scan.policy)
    process.stdout.write(`${JSON.stringify({
        schema: 'yoko.crm.architecture-enforcement-result.v1',
        ...result,
        scanned_files: scan.scanned_files,
        contexts: scan.contexts,
    }, null, 2)}\n`)
    if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`${error.stack ?? error.message}\n`)
        process.exitCode = 1
    })
}
