#!/usr/bin/env node
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'
import { classifyTrackedSurface, inventoryTrackedSurfaces } from './v2/tracked-surface-inventory.mjs'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const COVERAGE_PATH = 'architecture/contexts/v1/executable-path-ownership-coverage.json'
export const CURRENT_DEPENDENCY_PATH = 'architecture/contexts/v1/executable-path-ownership-current-dependencies.json'
export const REGISTRY_PATH = 'architecture/recovery/whole-project-dod/v2/LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json'
export const REVIEWED_DECISION_SCHEMA = 'yoko.crm.reviewed-executable-path-ownership-decisions.v1'
export const REVIEWED_BASELINE_SCHEMA = 'yoko.crm.executable-path-ownership-coverage.v1'
export const INTERNAL_REVIEWER = 'INTERNAL_EXECUTOR_REVIEW_20260813'
export const INTERNAL_REVIEW_ROLE = 'SOL_HIGH_INTERNAL_REVIEW'
export const REVIEWED_DECISION_PATH = 'architecture/recovery/whole-project-dod/v2/EXECUTABLE_PATH_OWNERSHIP_REVIEW_20260813.json'
export const REVIEWED_BASELINE_PATH = 'architecture/recovery/whole-project-dod/v2/EXECUTABLE_PATH_OWNERSHIP_COVERAGE_BASELINE_2108.json'
export const REVIEWED_BASELINE_SHA256 = '429a48c9d257408025bbc273a4d6f1413ed78196549ed889118422b6caba5730'

const SHA256 = /^[0-9a-f]{64}$/u
const SHA1 = /^[0-9a-f]{40}$/u

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}
const digest = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const byteDigest = (value) => createHash('sha256').update(value).digest('hex')
const assert = (value, message) => { if (!value) throw new Error(message) }
const contains = (ownerPath, candidatePath) => candidatePath === ownerPath || candidatePath.startsWith(`${ownerPath}/`)

const CURRENT_DERIVATION_INPUTS = {
  context_manifest_index: 'architecture/contexts/v1/context-index.json',
  historical_baseline: REVIEWED_BASELINE_PATH,
  lifecycle_registry: REGISTRY_PATH,
  reviewed_decisions: REVIEWED_DECISION_PATH,
  tracked_surface_inventory: 'tools/architecture/v2/tracked-surface-inventory.mjs',
}
function exactRolePaths(records, expected, label) {
  assert(Array.isArray(records), `${label} missing`)
  const actual = new Map()
  for (const record of records) {
    assert(record && typeof record.role === 'string' && typeof record.path === 'string', `${label} entry malformed`)
    assert(!actual.has(record.role), `${label} contains duplicate role: ${record.role}`)
    actual.set(record.role, record.path)
  }
  assert(actual.size === Object.keys(expected).length, `${label} denominator mismatch`)
  for (const [role, expectedPath] of Object.entries(expected)) {
    assert(actual.get(role) === expectedPath, `${label} path mismatch: ${role}`)
  }
}

const AUTHORITY_STRING_REFERENCES = new Map([
  [COVERAGE_PATH, 'coverage_document'],
  [CURRENT_DEPENDENCY_PATH, 'dependency_manifest'],
  [REVIEWED_DECISION_PATH, 'reviewed_decisions'],
  [REVIEWED_BASELINE_PATH, 'historical_baseline'],
])
export const OWNERSHIP_VALIDATOR_PATH = 'tools/architecture/validate-executable-path-ownership.mjs'
const JAVASCRIPT_SOURCE = /\.(?:[cm]?js|jsx|ts|tsx)$/u
const FILESYSTEM_MODULES = new Set(['fs', 'fs/promises', 'node:fs', 'node:fs/promises'])
const FILESYSTEM_READ_EXPORTS = new Set(['createReadStream', 'open', 'readFile', 'readFileSync'])
const FILESYSTEM_PROVEN_NON_READER_EXPORTS = new Set([
  'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync',
  'rm', 'rmSync', 'unlink', 'unlinkSync', 'writeFile', 'writeFileSync',
])
const PATH_MODULES = new Set(['node:path', 'path'])
const PATH_BUILD_EXPORTS = new Set(['join', 'resolve'])
const ASSERT_MODULES = new Set(['assert', 'assert/strict', 'node:assert', 'node:assert/strict'])
const TEST_MODULES = new Set(['node:test'])
const GLOBAL_PROVEN_NON_READER_METHODS = new Map([
  ['Array', new Set(['isArray'])],
  ['Buffer', new Set(['from', 'isBuffer'])],
  ['JSON', new Set(['parse', 'stringify'])],
  ['Object', new Set(['entries', 'fromEntries', 'hasOwn', 'keys', 'values'])],
  ['console', new Set(['debug', 'error', 'info', 'log', 'warn'])],
])
const CONSUMER_DISCOVERY_CACHE = new Map()

function moduleSpecifierText(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null
}

function canonicalModulePath(relativePath, specifier) {
  if (!specifier?.startsWith('.')) return null
  return path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), specifier))
}

function importDeclarationFor(node) {
  let current = node
  while (current && !ts.isImportDeclaration(current) && !ts.isExportDeclaration(current)) current = current.parent
  return current ?? null
}

function variableDeclarationFor(node) {
  let current = node.parent
  while (current && (ts.isBindingElement(current) || ts.isObjectBindingPattern(current) || ts.isArrayBindingPattern(current))) current = current.parent
  return current && ts.isVariableDeclaration(current) ? current : null
}

function propertyNameText(node) {
  if (!node) return null
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
  return null
}

function unwrapExpression(node) {
  let current = node
  while (current && (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current))) current = current.expression
  return current
}

function repositoryTrackedJavaScriptSources(repositoryRoot) {
  const output = execFileSync('git', ['-C', repositoryRoot, 'ls-files', '-z'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  return output.toString('utf8').split('\0').filter((relativePath) => JAVASCRIPT_SOURCE.test(relativePath)).sort()
}

function trackedSourceSnapshot(repositoryRoot, relativePaths) {
  const snapshot = createHash('sha256')
  for (const relativePath of relativePaths) {
    const bytes = readFileSync(path.join(repositoryRoot, relativePath))
    snapshot.update(`${Buffer.byteLength(relativePath)}:`).update(relativePath)
      .update(`:${bytes.length}:`).update(byteDigest(bytes)).update('\n')
  }
  return snapshot.digest('hex')
}

function semanticProgram(repositoryRoot, relativePaths) {
  const options = {
    allowJs: true,
    allowNonTsExtensions: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
  }
  const rootNames = relativePaths.map((relativePath) => path.join(repositoryRoot, relativePath))
  const program = ts.createProgram(rootNames, options)
  const relativeByAbsolute = new Map(rootNames.map((absolutePath, index) => [path.resolve(absolutePath), relativePaths[index]]))
  const sources = new Map()
  const failures = []
  for (const sourceFile of program.getSourceFiles()) {
    const relativePath = relativeByAbsolute.get(path.resolve(sourceFile.fileName))
    if (!relativePath) continue
    sources.set(relativePath, sourceFile)
    for (const diagnostic of sourceFile.parseDiagnostics ?? []) {
      const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
      failures.push(`${relativePath}:${position.line + 1}:${position.character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`)
    }
  }
  for (const relativePath of relativePaths) assert(sources.has(relativePath), `consumer discovery parser omitted tracked source: ${relativePath}`)
  assert(failures.length === 0, `consumer discovery parse failure:\n${failures.join('\n')}`)
  return { checker: program.getTypeChecker(), sources }
}

function makeAuthorityExportResolver(sources, checker) {
  const extensions = ['', '.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx']
  const cache = new Map()
  const active = new Set()
  const symbolAt = (identifier) => checker.getSymbolAtLocation(identifier) ?? null

  function trackedModule(fromPath, specifier) {
    if (!specifier?.startsWith('.')) return null
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier))
    for (const candidate of extensions.flatMap((extension) => [`${base}${extension}`, `${base}/index${extension}`])) {
      if (sources.has(candidate)) return candidate
    }
    return null
  }

  function declarationModule(declaration) {
    const imported = importDeclarationFor(declaration)
    if (!imported) return null
    return moduleSpecifierText(imported.moduleSpecifier)
  }

  function expressionAuthority(fromPath, expression, seenSymbols = new Set()) {
    const node = unwrapExpression(expression)
    if (!node) return null
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return AUTHORITY_STRING_REFERENCES.get(node.text) ?? null
    if (ts.isIdentifier(node)) {
      const symbol = symbolAt(node)
      if (!symbol || seenSymbols.has(symbol)) return null
      const nextSeen = new Set(seenSymbols).add(symbol)
      for (const declaration of symbol.declarations ?? []) {
        if (ts.isImportClause(declaration) && declaration.name) {
          const target = trackedModule(fromPath, declarationModule(declaration))
          if (target) {
            const authorityUse = exportedAuthority(target, 'default')
            if (authorityUse) return authorityUse
          }
        }
        if (ts.isImportSpecifier(declaration)) {
          const target = trackedModule(fromPath, declarationModule(declaration))
          const importedName = propertyNameText(declaration.propertyName ?? declaration.name)
          if (target && importedName) {
            const authorityUse = exportedAuthority(target, importedName)
            if (authorityUse) return authorityUse
          }
        }
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
          const authorityUse = expressionAuthority(fromPath, declaration.initializer, nextSeen)
          if (authorityUse) return authorityUse
        }
      }
      return null
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      for (const declaration of symbolAt(node.expression)?.declarations ?? []) {
        if (!ts.isNamespaceImport(declaration)) continue
        const target = trackedModule(fromPath, declarationModule(declaration))
        if (target) {
          const authorityUse = exportedAuthority(target, node.name.text)
          if (authorityUse) return authorityUse
        }
      }
    }
    return null
  }

  function exportedAuthority(modulePath, exportName) {
    const key = `${modulePath}\0${exportName}`
    if (cache.has(key)) return cache.get(key)
    if (active.has(key)) return null
    active.add(key)
    const sourceFile = sources.get(modulePath)
    const matches = new Set()
    for (const statement of sourceFile?.statements ?? []) {
      if (exportName === 'default' && ts.isExportAssignment(statement) && !statement.isExportEquals) {
        const authorityUse = expressionAuthority(modulePath, statement.expression)
        if (authorityUse) matches.add(authorityUse)
      }
      if (ts.isVariableStatement(statement)
        && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === exportName && declaration.initializer) {
            const authorityUse = expressionAuthority(modulePath, declaration.initializer)
            if (authorityUse) matches.add(authorityUse)
          }
        }
      }
      if (!ts.isExportDeclaration(statement)) continue
      const target = trackedModule(modulePath, moduleSpecifierText(statement.moduleSpecifier))
      if (!statement.exportClause && target) {
        const authorityUse = exportedAuthority(target, exportName)
        if (authorityUse) matches.add(authorityUse)
        continue
      }
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue
      for (const element of statement.exportClause.elements) {
        if (element.name.text !== exportName) continue
        const localName = propertyNameText(element.propertyName ?? element.name)
        if (target && localName) {
          const authorityUse = exportedAuthority(target, localName)
          if (authorityUse) matches.add(authorityUse)
        } else if (!target && localName) {
          const authorityUse = expressionAuthority(modulePath, element.propertyName ?? element.name)
          if (authorityUse) matches.add(authorityUse)
        }
      }
    }
    active.delete(key)
    assert(matches.size <= 1, `ambiguous imported authority export: ${modulePath}#${exportName}`)
    const result = [...matches][0] ?? null
    cache.set(key, result)
    return result
  }

  return {
    importedAuthority(fromPath, specifier, exportName) {
      const target = trackedModule(fromPath, specifier)
      return target ? exportedAuthority(target, exportName) : null
    },
  }
}

function makeSemanticSourceAnalyzer(relativePath, sourceFile, checker, authorityExports) {
  const authorityUseForPath = (value) => AUTHORITY_STRING_REFERENCES.get(value) ?? null
  const substitutionsKey = (symbol, substitutions) => substitutions.get(symbol)
  const symbolAt = (identifier) => ts.isIdentifier(identifier)
    && ts.isShorthandPropertyAssignment(identifier.parent)
    && identifier.parent.name === identifier
    ? checker.getShorthandAssignmentValueSymbol(identifier.parent) ?? checker.getSymbolAtLocation(identifier) ?? null
    : checker.getSymbolAtLocation(identifier) ?? null
  const hasDeclaredSymbol = (identifier) => (symbolAt(identifier)?.declarations ?? []).length > 0
  const declarationsFor = (identifier) => symbolAt(identifier)?.declarations ?? []
  const sourceLocation = (node) => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    return `${relativePath}:${position.line + 1}:${position.character + 1}`
  }
  const assignmentCache = new Map()

  function assignmentsForSymbol(symbol) {
    if (assignmentCache.has(symbol)) return assignmentCache.get(symbol)
    const assignments = []
    const visit = (node) => {
      if (ts.isBinaryExpression(node)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && ts.isIdentifier(unwrapExpression(node.left))
        && symbolAt(unwrapExpression(node.left)) === symbol) assignments.push(node)
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
        && ts.isIdentifier(unwrapExpression(node.operand))
        && symbolAt(unwrapExpression(node.operand)) === symbol) assignments.push(node)
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    assignmentCache.set(symbol, assignments)
    return assignments
  }

  function directStatement(node) {
    let current = node
    while (current?.parent && !ts.isSourceFile(current.parent) && !ts.isBlock(current.parent)) current = current.parent
    return current?.parent && (ts.isSourceFile(current.parent) || ts.isBlock(current.parent)) ? current : null
  }

  function deterministicAssignmentValue(assignment, useNode) {
    if (!ts.isBinaryExpression(assignment) || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken
      || !ts.isExpressionStatement(assignment.parent)) return null
    const assignmentStatement = directStatement(assignment)
    const useStatement = directStatement(useNode)
    if (!assignmentStatement || !useStatement || assignmentStatement.parent !== useStatement.parent) return null
    const statements = assignmentStatement.parent.statements
    return statements.indexOf(assignmentStatement) < statements.indexOf(useStatement) ? assignment.right : null
  }

  function isUnshadowedRequireCall(node, expectedModules) {
    const call = unwrapExpression(node)
    if (!call || !ts.isCallExpression(call) || call.arguments.length !== 1 || !ts.isIdentifier(call.expression) || call.expression.text !== 'require') return false
    if (hasDeclaredSymbol(call.expression)) return false
    const specifier = moduleSpecifierText(call.arguments[0])
    return specifier !== null && expectedModules.has(specifier)
  }

  function importBinding(node) {
    const declaration = importDeclarationFor(node)
    if (!declaration || !ts.isImportDeclaration(declaration)) return null
    return { declaration, specifier: moduleSpecifierText(declaration.moduleSpecifier) }
  }

  function bindingElementProperty(declaration) {
    if (!ts.isBindingElement(declaration)) return null
    return propertyNameText(declaration.propertyName ?? declaration.name)
  }

  function variableInitializer(declaration) {
    if (ts.isVariableDeclaration(declaration)) return declaration.initializer ?? null
    if (ts.isBindingElement(declaration)) return variableDeclarationFor(declaration)?.initializer ?? null
    return null
  }

  function bindingResolvesToNamespace(identifier, modules, seen = new Set()) {
    const expression = unwrapExpression(identifier)
    if (!expression) return false
    if (isUnshadowedRequireCall(expression, modules)) return true
    if (ts.isPropertyAccessExpression(expression)
      && (modules === FILESYSTEM_MODULES && expression.name.text === 'promises'
        || modules === PATH_MODULES && ['posix', 'win32'].includes(expression.name.text))
      && bindingResolvesToNamespace(expression.expression, modules, seen)) return true
    if (!ts.isIdentifier(expression)) return false
    const symbol = symbolAt(expression)
    if (!symbol || seen.has(symbol)) return false
    if (assignmentsForSymbol(symbol).length > 0) return false
    seen.add(symbol)
    for (const declaration of symbol.declarations ?? []) {
      const imported = importBinding(declaration)
      if (imported && modules.has(imported.specifier)
        && (ts.isNamespaceImport(declaration) || ts.isImportClause(declaration))) return true
      if (imported && modules.has(imported.specifier) && ts.isImportSpecifier(declaration)
        && modules === FILESYSTEM_MODULES && propertyNameText(declaration.propertyName ?? declaration.name) === 'promises') return true
      if (ts.isBindingElement(declaration) && modules === FILESYSTEM_MODULES
        && bindingElementProperty(declaration) === 'promises'
        && isUnshadowedRequireCall(variableInitializer(declaration), modules)) return true
      if (ts.isVariableDeclaration(declaration) && declaration.initializer
        && bindingResolvesToNamespace(declaration.initializer, modules, seen)) return true
    }
    return false
  }

  function bindingResolvesToExport(identifier, modules, exports, seen = new Set()) {
    const expression = unwrapExpression(identifier)
    if (!expression) return false
    if (ts.isPropertyAccessExpression(expression)) {
      return exports.has(expression.name.text) && bindingResolvesToNamespace(expression.expression, modules, seen)
    }
    if (ts.isElementAccessExpression(expression)
      && (ts.isStringLiteral(expression.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression))) {
      return exports.has(expression.argumentExpression.text) && bindingResolvesToNamespace(expression.expression, modules, seen)
    }
    if (!ts.isIdentifier(expression)) return false
    const symbol = symbolAt(expression)
    if (!symbol || seen.has(symbol)) return false
    if (assignmentsForSymbol(symbol).length > 0) return false
    seen.add(symbol)
    for (const declaration of symbol.declarations ?? []) {
      const imported = importBinding(declaration)
      if (imported && modules.has(imported.specifier) && ts.isImportSpecifier(declaration)
        && exports.has(propertyNameText(declaration.propertyName ?? declaration.name))) return true
      if (ts.isBindingElement(declaration)) {
        const property = bindingElementProperty(declaration)
        if (property && exports.has(property) && isUnshadowedRequireCall(variableInitializer(declaration), modules)) return true
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer
        && bindingResolvesToExport(declaration.initializer, modules, exports, seen)) return true
    }
    return false
  }

  const isFilesystemReader = (expression) => bindingResolvesToExport(expression, FILESYSTEM_MODULES, FILESYSTEM_READ_EXPORTS)
  const isPathBuilder = (expression) => bindingResolvesToExport(expression, PATH_MODULES, PATH_BUILD_EXPORTS)

  const CALLABLE_READER = 'PROVEN_FILESYSTEM_READER'
  const CALLABLE_NON_READER = 'PROVEN_NON_FILESYSTEM_READER'
  const CALLABLE_LOCAL = 'PROVEN_LOCAL_FUNCTION'
  const CALLABLE_UNKNOWN = 'UNKNOWN_RELEVANT_CALLABLE'
  const callable = (kind, functionNode = null) => ({ functionNode, kind })

  function isProvenNonReader(expression) {
    const node = unwrapExpression(expression)
    if (!node) return false
    if (isPathBuilder(node)
      || bindingResolvesToExport(node, FILESYSTEM_MODULES, FILESYSTEM_PROVEN_NON_READER_EXPORTS)
      || bindingResolvesToNamespace(node, ASSERT_MODULES)
      || bindingResolvesToNamespace(node, TEST_MODULES)) return true
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      const receiver = unwrapExpression(node.expression)
      const property = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : propertyNameText(unwrapExpression(node.argumentExpression))
      if (receiver && bindingResolvesToNamespace(receiver, ASSERT_MODULES)) return true
      if (receiver && bindingResolvesToNamespace(receiver, TEST_MODULES)) return true
      if (receiver && ts.isIdentifier(receiver) && !hasDeclaredSymbol(receiver)
        && GLOBAL_PROVEN_NON_READER_METHODS.get(receiver.text)?.has(property)) return true
    }
    return false
  }

  function resolveCallableExpression(expression, useNode, seen = new Set(), substitutions = new Map()) {
    const node = unwrapExpression(expression)
    if (!node) return callable(CALLABLE_UNKNOWN)
    if (isFilesystemReader(node)) return callable(CALLABLE_READER)
    if (isProvenNonReader(node)) return callable(CALLABLE_NON_READER)
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) return callable(CALLABLE_LOCAL, node)
    if (ts.isIdentifier(node)) {
      const symbol = symbolAt(node)
      if (!symbol || seen.has(symbol)) return callable(CALLABLE_UNKNOWN)
      const nextSeen = new Set(seen).add(symbol)
      const substitution = substitutionsKey(symbol, substitutions)
      if (substitution) return resolveCallableExpression(substitution, useNode, nextSeen, substitutions)
      const functionDeclarations = (symbol.declarations ?? []).filter((declaration) => ts.isFunctionDeclaration(declaration) && declaration.body)
      if (functionDeclarations.length === 1 && assignmentsForSymbol(symbol).length === 0) return callable(CALLABLE_LOCAL, functionDeclarations[0])
      if (functionDeclarations.length > 0) return callable(CALLABLE_UNKNOWN)
      const value = localIdentifierValue(node, useNode, nextSeen)
      return value.status === 'resolved'
        ? resolveCallableExpression(value.value, useNode, nextSeen, substitutions)
        : callable(CALLABLE_UNKNOWN)
    }
    const property = localObjectPropertyResult(node, useNode, seen)
    if (property.status === 'resolved') return resolveCallableExpression(property.value, useNode, seen, substitutions)
    if (property.status === 'unknown') return callable(CALLABLE_UNKNOWN)
    if (ts.isConditionalExpression(node)) {
      const branches = [
        resolveCallableExpression(node.whenTrue, useNode, seen, substitutions),
        resolveCallableExpression(node.whenFalse, useNode, seen, substitutions),
      ]
      if (branches.every((branch) => branch.kind === CALLABLE_READER)) return callable(CALLABLE_READER)
      if (branches.every((branch) => branch.kind === CALLABLE_NON_READER)) return callable(CALLABLE_NON_READER)
      if (branches.every((branch) => branch.kind === CALLABLE_LOCAL
        && branch.functionNode === branches[0].functionNode)) return branches[0]
    }
    return callable(CALLABLE_UNKNOWN)
  }

  function importedAuthority(identifier) {
    if (!ts.isIdentifier(identifier)) return null
    for (const declaration of declarationsFor(identifier)) {
      const imported = importBinding(declaration)
      if (imported && ts.isImportClause(declaration) && declaration.name) {
        const authorityUse = authorityExports.importedAuthority(relativePath, imported.specifier, 'default')
        if (authorityUse) return authorityUse
      }
      if (imported && ts.isImportSpecifier(declaration)) {
        const authorityUse = authorityExports.importedAuthority(
          relativePath, imported.specifier, propertyNameText(declaration.propertyName ?? declaration.name),
        )
        if (authorityUse) return authorityUse
      }
    }
    return null
  }

  function canonicalImportedExport(identifier) {
    if (!ts.isIdentifier(identifier)) return null
    for (const declaration of declarationsFor(identifier)) {
      const imported = importBinding(declaration)
      if (imported && ts.isImportSpecifier(declaration)
        && canonicalModulePath(relativePath, imported.specifier) === OWNERSHIP_VALIDATOR_PATH) {
        return propertyNameText(declaration.propertyName ?? declaration.name)
      }
    }
    return null
  }

  function loadedDependencyAuthorityProjection(expression) {
    const properties = []
    let base = unwrapExpression(expression)
    while (base && ts.isPropertyAccessExpression(base)) {
      properties.unshift(base.name.text)
      base = unwrapExpression(base.expression)
    }
    if (!base || !ts.isIdentifier(base)
      || JSON.stringify(properties) !== JSON.stringify(['current_live', 'authority', 'path'])) return null
    for (const declaration of declarationsFor(base)) {
      let initializer = unwrapExpression(variableInitializer(declaration))
      if (initializer && ts.isAwaitExpression(initializer)) initializer = unwrapExpression(initializer.expression)
      if (initializer && ts.isCallExpression(initializer)
        && canonicalImportedExport(unwrapExpression(initializer.expression)) === 'loadExecutablePathOwnershipDependencies') return 'coverage_document'
    }
    return null
  }

  function importedNamespaceAuthority(expression) {
    const node = unwrapExpression(expression)
    if (!node || !ts.isPropertyAccessExpression(node)) return null
    if (!ts.isIdentifier(node.expression)) return null
    for (const declaration of declarationsFor(node.expression)) {
      const imported = importBinding(declaration)
      if (imported && ts.isNamespaceImport(declaration)) {
        const authorityUse = authorityExports.importedAuthority(relativePath, imported.specifier, node.name.text)
        if (authorityUse) return authorityUse
      }
    }
    return null
  }

  const resolvedLocalValue = (value) => ({ status: 'resolved', value })
  const absentLocalValue = () => ({ status: 'absent', value: null })
  const unknownLocalValue = () => ({ status: 'unknown', value: null })
  const propertyMutationCache = new Map()

  function localIdentifierValue(identifier, useNode, seen = new Set()) {
    const symbol = symbolAt(identifier)
    if (!symbol) return absentLocalValue()
    const declarations = symbol.declarations ?? []
    const localVariables = declarations.filter((declaration) => ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name))
    const bindings = declarations.filter((declaration) => ts.isBindingElement(declaration))
    const assignments = assignmentsForSymbol(symbol)
    const initialized = localVariables.filter((declaration) => declaration.initializer)
    if (assignments.length > 0) {
      if (initialized.length > 0 || bindings.length > 0 || localVariables.length !== 1 || assignments.length !== 1) return unknownLocalValue()
      const value = deterministicAssignmentValue(assignments[0], useNode)
      return value ? resolvedLocalValue(value) : unknownLocalValue()
    }
    if (initialized.length === 1 && localVariables.length === 1) return resolvedLocalValue(initialized[0].initializer)
    if (bindings.length === 1 && localVariables.length === 0) {
      const binding = bindings[0]
      if (!ts.isObjectBindingPattern(binding.parent) || binding.dotDotDotToken) return unknownLocalValue()
      const property = bindingElementProperty(binding)
      const initializer = variableDeclarationFor(binding)?.initializer
      if (!property || !initializer) return unknownLocalValue()
      return localObjectPropertyByName(initializer, property, useNode, seen)
    }
    if (localVariables.length > 0 || bindings.length > 0) return unknownLocalValue()
    return absentLocalValue()
  }

  function localObjectIdentity(expression, seen = new Set()) {
    const node = unwrapExpression(expression)
    if (!node) return absentLocalValue()
    if (ts.isObjectLiteralExpression(node)) return resolvedLocalValue(node)
    if (ts.isCallExpression(node)) {
      const returned = deterministicLocalReturnExpression(node, seen)
      return returned ? localObjectIdentity(returned, seen) : absentLocalValue()
    }
    if (!ts.isIdentifier(node)) return absentLocalValue()
    const symbol = symbolAt(node)
    if (!symbol) return absentLocalValue()
    if (seen.has(symbol) || assignmentsForSymbol(symbol).length > 0) return unknownLocalValue()
    const nextSeen = new Set(seen).add(symbol)
    const declarations = (symbol.declarations ?? []).filter((declaration) => ts.isVariableDeclaration(declaration)
      && ts.isIdentifier(declaration.name) && declaration.initializer)
    if (declarations.length === 0) return absentLocalValue()
    if (declarations.length !== 1) return unknownLocalValue()
    const nested = localObjectIdentity(declarations[0].initializer, nextSeen)
    return nested.status === 'absent' ? unknownLocalValue() : nested
  }

  function deterministicLocalReturnExpression(call, seen = new Set()) {
    const classification = resolveCallableExpression(call.expression, call, seen)
    if (classification.kind !== CALLABLE_LOCAL || !classification.functionNode
      || classification.functionNode.parameters.length !== 0) return null
    const body = classification.functionNode.body
    if (!body) return null
    if (!ts.isBlock(body)) return body
    if (body.statements.length !== 1 || !ts.isReturnStatement(body.statements[0])) return null
    return body.statements[0].expression ?? null
  }

  function objectPropertyIsMutated(objectLiteral, property) {
    let byProperty = propertyMutationCache.get(objectLiteral)
    if (!byProperty) {
      byProperty = new Map()
      propertyMutationCache.set(objectLiteral, byProperty)
    }
    if (byProperty.has(property)) return byProperty.get(property)
    let mutated = false
    const visit = (node) => {
      if (mutated) return
      let target = null
      if (ts.isBinaryExpression(node)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) target = unwrapExpression(node.left)
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) target = unwrapExpression(node.operand)
      if (target && (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))) {
        const targetProperty = ts.isPropertyAccessExpression(target)
          ? target.name.text
          : propertyNameText(unwrapExpression(target.argumentExpression))
        const identity = localObjectIdentity(target.expression)
        if (identity.status === 'resolved' && identity.value === objectLiteral
          && (targetProperty === null || targetProperty === property)) mutated = true
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Object'
        && !hasDeclaredSymbol(node.expression.expression) && node.expression.name.text === 'assign'
        && node.arguments.length > 0) {
        const identity = localObjectIdentity(node.arguments[0])
        if (identity.status === 'resolved' && identity.value === objectLiteral) mutated = true
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    byProperty.set(property, mutated)
    return mutated
  }

  function localObjectPropertyByName(objectExpression, property, useNode, seen = new Set()) {
    const identity = localObjectIdentity(objectExpression, seen)
    if (identity.status !== 'resolved') return identity.status === 'unknown' ? unknownLocalValue() : absentLocalValue()
    const objectLiteral = identity.value
    if (objectPropertyIsMutated(objectLiteral, property)) return unknownLocalValue()
    const matches = []
    let hasUnsupportedMember = false
    for (const member of objectLiteral.properties) {
      if (ts.isSpreadAssignment(member) || propertyNameText(member.name) === null) {
        hasUnsupportedMember = true
        continue
      }
      if (propertyNameText(member.name) !== property) continue
      if (ts.isPropertyAssignment(member)) matches.push(member.initializer)
      else if (ts.isShorthandPropertyAssignment(member)) matches.push(member.name)
      else if (ts.isMethodDeclaration(member) && member.body) matches.push(member)
      else hasUnsupportedMember = true
    }
    if (matches.length === 1 && !hasUnsupportedMember) return resolvedLocalValue(matches[0])
    if (matches.length > 0 || hasUnsupportedMember) return unknownLocalValue()
    return absentLocalValue()
  }

  function localObjectPropertyResult(expression, useNode, seen = new Set()) {
    const node = unwrapExpression(expression)
    if (!node || (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node))) return absentLocalValue()
    const property = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : propertyNameText(unwrapExpression(node.argumentExpression))
    if (property === null) {
      const identity = localObjectIdentity(node.expression, seen)
      return identity.status === 'absent' ? absentLocalValue() : unknownLocalValue()
    }
    return localObjectPropertyByName(node.expression, property, useNode, seen)
  }

  function localObjectProperty(expression, seen = new Set()) {
    const result = localObjectPropertyResult(expression, expression, seen)
    return result.status === 'resolved' ? result.value : null
  }

  const none = () => ({ exact: true, uses: new Set() })
  const target = (authorityUse) => ({ exact: true, uses: new Set([authorityUse]) })
  const union = (values) => ({
    exact: values.every((value) => value.exact),
    uses: new Set(values.flatMap((value) => [...value.uses])),
  })

  function resolveAuthorityExpression(expression, substitutions = new Map(), seen = new Set()) {
    const node = unwrapExpression(expression)
    if (!node) return none()
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const authorityUse = authorityUseForPath(node.text)
      return authorityUse ? target(authorityUse) : none()
    }
    if (ts.isIdentifier(node)) {
      const symbol = symbolAt(node)
      if (symbol) {
        if (seen.has(symbol)) return none()
        const nextSeen = new Set(seen).add(symbol)
        const substitution = substitutionsKey(symbol, substitutions)
        if (substitution) return resolveAuthorityExpression(substitution, substitutions, nextSeen)
        const imported = importedAuthority(node)
        if (imported) return target(imported)
        for (const declaration of symbol.declarations ?? []) {
          const initializer = variableInitializer(declaration)
          if (initializer) {
            const resolved = resolveAuthorityExpression(initializer, substitutions, nextSeen)
            if (resolved.uses.size > 0) return resolved
          }
        }
      }
      return none()
    }
    const namespaceAuthority = importedNamespaceAuthority(node)
    if (namespaceAuthority) return target(namespaceAuthority)
    const projectedAuthority = loadedDependencyAuthorityProjection(node)
    if (projectedAuthority) return target(projectedAuthority)
    const propertyValue = localObjectProperty(node)
    if (propertyValue) return resolveAuthorityExpression(propertyValue, substitutions, seen)
    if (ts.isAwaitExpression(node)) return resolveAuthorityExpression(node.expression, substitutions, seen)
    if (ts.isConditionalExpression(node)) {
      const branches = [
        resolveAuthorityExpression(node.whenTrue, substitutions, seen),
        resolveAuthorityExpression(node.whenFalse, substitutions, seen),
      ]
      if (branches.some((branch) => branch.uses.size > 0)) {
        return { exact: branches.every((branch) => branch.exact), uses: union(branches).uses }
      }
      return none()
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
      const alternatives = [
        resolveAuthorityExpression(node.left, substitutions, seen),
        resolveAuthorityExpression(node.right, substitutions, seen),
      ]
      return alternatives.some((alternative) => alternative.uses.size > 0) ? union(alternatives) : none()
    }
    if (ts.isCallExpression(node) && isPathBuilder(node.expression)) {
      const argumentsResolved = node.arguments.map((argument) => resolveAuthorityExpression(argument, substitutions, seen))
      const withAuthority = argumentsResolved.map((value, index) => ({ index, value })).filter(({ value }) => value.uses.size > 0)
      if (withAuthority.length === 0) return none()
      const last = withAuthority.at(-1)
      return {
        exact: withAuthority.length === 1 && last.value.exact && last.index === node.arguments.length - 1,
        uses: union(argumentsResolved).uses,
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && !hasDeclaredSymbol(node.expression)) {
      const first = resolveAuthorityExpression(node.arguments?.[0], substitutions, seen)
      return first.uses.size > 0 ? first : none()
    }
    if (ts.isTemplateExpression(node)) {
      const spans = node.templateSpans.map((span) => resolveAuthorityExpression(span.expression, substitutions, seen))
      const merged = union(spans)
      if (merged.uses.size === 0) return none()
      const authorityIndexes = spans.map((value, index) => ({ index, value })).filter(({ value }) => value.uses.size > 0)
      return {
        exact: merged.exact && authorityIndexes.length === 1 && authorityIndexes[0].index === spans.length - 1
          && node.templateSpans.at(-1).literal.text === '',
        uses: merged.uses,
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = resolveAuthorityExpression(node.left, substitutions, seen)
      const right = resolveAuthorityExpression(node.right, substitutions, seen)
      if (left.uses.size === 0 && right.uses.size === 0) return none()
      const rightIsEmpty = (ts.isStringLiteral(node.right) || ts.isNoSubstitutionTemplateLiteral(node.right)) && node.right.text === ''
      return {
        exact: right.exact && right.uses.size > 0 && left.uses.size === 0
          || left.exact && left.uses.size > 0 && right.uses.size === 0 && rightIsEmpty,
        uses: union([left, right]).uses,
      }
    }
    return none()
  }

  function expressionReferencesAuthority(expression, substitutions = new Map(), seen = new Set()) {
    const node = unwrapExpression(expression)
    if (!node) return false
    if (ts.isCallExpression(node) && (isFilesystemReader(node.expression)
      || ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'JSON'
        && node.expression.name.text === 'parse'
        && !hasDeclaredSymbol(node.expression.expression))) return false
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return authorityUseForPath(node.text) !== null
    if (ts.isIdentifier(node)) {
      const symbol = symbolAt(node)
      if (!symbol || seen.has(symbol)) return false
      const nextSeen = new Set(seen).add(symbol)
      const substitution = substitutionsKey(symbol, substitutions)
      if (substitution) return expressionReferencesAuthority(substitution, substitutions, nextSeen)
      if (importedAuthority(node)) return true
      return (symbol.declarations ?? []).some((declaration) => {
        const initializer = variableInitializer(declaration)
        return initializer ? expressionReferencesAuthority(initializer, substitutions, nextSeen) : false
      })
    }
    if (importedNamespaceAuthority(node)) return true
    if (loadedDependencyAuthorityProjection(node)) return true
    const propertyValue = localObjectProperty(node)
    if (propertyValue) return expressionReferencesAuthority(propertyValue, substitutions, seen)
    let referenced = false
    ts.forEachChild(node, (child) => { if (!referenced && expressionReferencesAuthority(child, substitutions, seen)) referenced = true })
    return referenced
  }

  function readUsesFromCall(call, substitutions = new Map(), activeFunctions = new Set()) {
    const classification = resolveCallableExpression(call.expression, call, new Set(), substitutions)
    if (classification.kind === CALLABLE_READER) {
      assert(call.arguments.length > 0, `authority consumer filesystem read has no path argument: ${sourceLocation(call)}`)
      const resolved = resolveAuthorityExpression(call.arguments[0], substitutions)
      if (resolved.uses.size > 0) {
        assert(resolved.exact, `unsupported authority path expression in filesystem read: ${sourceLocation(call)}`)
        return resolved.uses
      }
      assert(!expressionReferencesAuthority(call.arguments[0], substitutions), `unsupported authority dataflow into filesystem read: ${sourceLocation(call)}`)
      return new Set()
    }
    const relevantArguments = call.arguments.some((argument) => resolveAuthorityExpression(argument, substitutions).uses.size > 0)
    if (classification.kind === CALLABLE_NON_READER || !relevantArguments) return new Set()
    assert(classification.kind !== CALLABLE_UNKNOWN,
      `unsupported relevant callable dataflow: ${sourceLocation(call)}; classification=${CALLABLE_UNKNOWN}`)
    const functionNode = classification.functionNode
    assert(classification.kind === CALLABLE_LOCAL && functionNode && !activeFunctions.has(functionNode),
      `unsupported relevant callable dataflow: ${sourceLocation(call)}; classification=${CALLABLE_UNKNOWN}`)
    assert(functionNode.parameters.every((parameter) => ts.isIdentifier(parameter.name)), `unsupported authority wrapper parameter pattern: ${sourceLocation(functionNode)}`)
    const nestedSubstitutions = new Map(substitutions)
    functionNode.parameters.forEach((parameter, index) => {
      const symbol = symbolAt(parameter.name)
      if (symbol && call.arguments[index]) nestedSubstitutions.set(symbol, call.arguments[index])
    })
    const uses = new Set()
    const nextActive = new Set(activeFunctions).add(functionNode)
    const visit = (node) => {
      if (ts.isCallExpression(node)) for (const authorityUse of readUsesFromCall(node, nestedSubstitutions, nextActive)) uses.add(authorityUse)
      ts.forEachChild(node, visit)
    }
    if (functionNode.body) visit(functionNode.body)
    return uses
  }

  function consumesOwnershipValidator(authorityUses) {
    const referencedOutside = (symbol, declaration, acceptReference) => {
      let referenced = false
      const visit = (node) => {
        if (referenced) return
        if (ts.isIdentifier(node) && node !== declaration.name && symbolAt(node) === symbol && acceptReference(node)) referenced = true
        ts.forEachChild(node, visit)
      }
      visit(sourceFile)
      return referenced
    }
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement)
        || canonicalModulePath(relativePath, moduleSpecifierText(statement.moduleSpecifier)) !== OWNERSHIP_VALIDATOR_PATH
        || !statement.importClause) continue
      const bindings = statement.importClause.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const symbol = symbolAt(element.name)
          if (!symbol) continue
          const authorityUse = importedAuthority(element.name)
          if (authorityUse && authorityUses.has(authorityUse)) return true
          if (!authorityUse && referencedOutside(symbol, element, () => true)) return true
        }
      }
      if (bindings && ts.isNamespaceImport(bindings)) {
        const symbol = symbolAt(bindings.name)
        if (symbol && referencedOutside(symbol, bindings, (reference) => {
          const parent = reference.parent
          if (!ts.isPropertyAccessExpression(parent) || parent.expression !== reference) return true
          const authorityUse = authorityExports.importedAuthority(relativePath, moduleSpecifierText(statement.moduleSpecifier), parent.name.text)
          return authorityUse ? authorityUses.has(authorityUse) : true
        })) return true
      }
      if (statement.importClause.name) {
        const symbol = symbolAt(statement.importClause.name)
        const authorityUse = importedAuthority(statement.importClause.name)
        if (symbol && (authorityUse
          ? authorityUses.has(authorityUse)
          : referencedOutside(symbol, statement.importClause, () => true))) return true
      }
    }
    return false
  }

  function authoritySeeds() {
    let imported = false
    let literal = false
    const visit = (node) => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        && authorityUseForPath(node.text)) literal = true
      if (ts.isImportSpecifier(node) && importedAuthority(node.name)) literal = true
      if (ts.isImportClause(node) && node.name && importedAuthority(node.name)) literal = true
      if (ts.isPropertyAccessExpression(node) && importedNamespaceAuthority(node)) literal = true
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && canonicalModulePath(relativePath, moduleSpecifierText(node.moduleSpecifier)) === OWNERSHIP_VALIDATOR_PATH) imported = true
      if (ts.isCallExpression(node) && isUnshadowedRequireCall(node, new Set([
        path.posix.relative(path.posix.dirname(relativePath), OWNERSHIP_VALIDATOR_PATH),
        `./${path.posix.relative(path.posix.dirname(relativePath), OWNERSHIP_VALIDATOR_PATH)}`,
      ]))) imported = true
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return { imported, literal }
  }

  const authorityUses = new Set()
  const seeds = authoritySeeds()
  if (!seeds.imported && !seeds.literal) return []
  const visit = (node) => {
    if (ts.isCallExpression(node)) for (const authorityUse of readUsesFromCall(node)) authorityUses.add(authorityUse)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (seeds.imported && consumesOwnershipValidator(authorityUses)) authorityUses.add('ownership_validator_module')
  return [...authorityUses].sort()
}

export function discoverExecutablePathOwnershipConsumers(repositoryRoot) {
  assert(ts.version === '5.9.3', `consumer discovery parser version mismatch: ${ts.version}`)
  const relativePaths = repositoryTrackedJavaScriptSources(repositoryRoot)
  const snapshot = trackedSourceSnapshot(repositoryRoot, relativePaths)
  const cacheKey = path.resolve(repositoryRoot)
  const cached = CONSUMER_DISCOVERY_CACHE.get(cacheKey)
  if (cached?.snapshot === snapshot) return cached.consumers.map((consumer) => ({
    path: consumer.path,
    authority_uses: [...consumer.authority_uses],
  }))
  const consumers = []
  const parsed = semanticProgram(repositoryRoot, relativePaths)
  const authorityExports = makeAuthorityExportResolver(parsed.sources, parsed.checker)
  for (const relativePath of relativePaths) {
    const authorityUses = makeSemanticSourceAnalyzer(relativePath, parsed.sources.get(relativePath), parsed.checker, authorityExports)
    if (authorityUses.length > 0) consumers.push({
      path: relativePath,
      authority_uses: authorityUses,
    })
  }
  CONSUMER_DISCOVERY_CACHE.set(cacheKey, { consumers, snapshot })
  return consumers.map((consumer) => ({ path: consumer.path, authority_uses: [...consumer.authority_uses] }))
}

export function validateExecutablePathOwnershipConsumerClosure(value, repositoryRoot = root) {
  const declared = value?.current_live?.consumers
  assert(Array.isArray(declared) && declared.length > 0, 'executable ownership current consumers missing')
  const declaredByPath = new Map()
  const roles = new Set()
  for (const consumer of declared) {
    assert(consumer && typeof consumer.role === 'string' && consumer.role.length > 0
      && typeof consumer.path === 'string' && consumer.path.length > 0
      && Array.isArray(consumer.authority_uses) && consumer.authority_uses.length > 0,
    'executable ownership current consumer declaration malformed')
    assert(!roles.has(consumer.role), `executable ownership current consumer role duplicated: ${consumer.role}`)
    assert(!declaredByPath.has(consumer.path), `executable ownership current consumer path duplicated: ${consumer.path}`)
    roles.add(consumer.role)
    declaredByPath.set(consumer.path, [...consumer.authority_uses].sort())
  }
  const discovered = discoverExecutablePathOwnershipConsumers(repositoryRoot)
  const discoveredByPath = new Map(discovered.map((consumer) => [consumer.path, consumer.authority_uses]))
  const undeclared = discovered.filter((consumer) => !declaredByPath.has(consumer.path)).map((consumer) => consumer.path)
  const stale = [...declaredByPath.keys()].filter((consumerPath) => !discoveredByPath.has(consumerPath))
  assert(undeclared.length === 0, `executable ownership undeclared current consumers: ${undeclared.join(', ')}`)
  assert(stale.length === 0, `executable ownership stale declared consumers: ${stale.join(', ')}`)
  for (const [consumerPath, declaredUses] of declaredByPath) {
    assert(JSON.stringify(declaredUses) === JSON.stringify(discoveredByPath.get(consumerPath)), `executable ownership consumer authority uses drift: ${consumerPath}`)
  }
  return discovered
}

function gitObject(repositoryRoot, args, encoding = 'utf8') {
  return execFileSync('git', ['-C', repositoryRoot, ...args], { encoding, maxBuffer: 64 * 1024 * 1024 })
}

function historicalScopedInventory(commit, tree, historicalPath, controls, surfaces) {
  return {
    schema: 'yoko.crm.executable-path-ownership-historical-scoped-inventory.v1',
    version: 1,
    source: { commit, tree, exact_paths: [historicalPath] },
    controls,
    surfaces,
  }
}

export function deriveHistoricalExecutablePathOwnershipFixture(repositoryRoot, incident) {
  assert(incident?.schema === 'yoko.crm.executable-path-ownership-historical-working-tree-deletion.v2'
    && SHA1.test(incident.candidate ?? '')
    && typeof incident.path === 'string' && incident.path.length > 0,
  'executable ownership historical fixture malformed')
  assert(gitObject(repositoryRoot, ['cat-file', '-t', incident.candidate]).trim() === 'commit', 'executable ownership historical candidate is not a commit')
  const candidateTree = gitObject(repositoryRoot, ['rev-parse', `${incident.candidate}^{tree}`]).trim()
  const beforeEntry = gitObject(repositoryRoot, ['ls-tree', '-z', incident.candidate, '--', incident.path], 'buffer')
  assert(beforeEntry.length > 0, `executable ownership historical path missing from before commit: ${incident.path}`)
  const entryMatch = /^([0-7]{6}) blob ([0-9a-f]{40})\t([^\0]+)\0$/u.exec(beforeEntry.toString('utf8'))
  assert(entryMatch && entryMatch[3] === incident.path, `executable ownership historical before-path identity mismatch: ${incident.path}`)
  const [gitMode, blobOid] = [entryMatch[1], entryMatch[2]]
  const sourceBytes = gitObject(repositoryRoot, ['cat-file', 'blob', blobOid], 'buffer')
  const classified = classifyTrackedSurface(incident.path, null, {
    gitMode,
    hasShebang: sourceBytes[0] === 0x23 && sourceBytes[1] === 0x21,
  })
  assert(classified !== null, `executable ownership historical path is not an executable surface: ${incident.path}`)
  const surface = { ...classified, git_mode: gitMode, blob_oid: blobOid, source_sha256: byteDigest(sourceBytes) }
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'yoko-historical-working-tree-deletion-'))
  try {
    const alternateWorktree = path.join(temporary, 'worktree')
    const alternateIndex = path.join(temporary, 'index')
    const historicalWorktreePath = path.join(alternateWorktree, incident.path)
    mkdirSync(path.dirname(historicalWorktreePath), { recursive: true })
    writeFileSync(historicalWorktreePath, sourceBytes)
    const gitDirectory = gitObject(repositoryRoot, ['rev-parse', '--absolute-git-dir']).trim()
    const environment = { ...process.env, GIT_INDEX_FILE: alternateIndex }
    const fixtureGit = (args, encoding = 'buffer') => execFileSync(
      'git', ['--git-dir', gitDirectory, '--work-tree', alternateWorktree, ...args],
      { encoding, env: environment, maxBuffer: 64 * 1024 * 1024 },
    )
    fixtureGit(['read-tree', incident.candidate])
    const cleanDeleted = fixtureGit(['ls-files', '--deleted', '-z', '--', incident.path])
    assert(cleanDeleted.length === 0, 'executable ownership historical clean path is unexpectedly deleted')
    unlinkSync(historicalWorktreePath)
    const deleted = fixtureGit(['ls-files', '--deleted', '-z', '--', incident.path]).toString('utf8')
    assert(deleted === `${incident.path}\0`, `executable ownership historical working-tree deletion did not reproduce exactly: ${incident.path}`)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  const cleanInventory = historicalScopedInventory(
    incident.candidate, candidateTree, incident.path,
    { working_tree_deleted: [], committed_deletion: false }, [surface],
  )
  const workingTreeDeletedInventory = historicalScopedInventory(
    incident.candidate, candidateTree, incident.path,
    { working_tree_deleted: [incident.path], committed_deletion: false }, [],
  )
  const mutationProvenance = {
    schema: 'yoko.crm.executable-path-ownership-historical-working-tree-mutation.v1',
    candidate: incident.candidate,
    candidate_tree: candidateTree,
    mutation: { kind: 'working_tree_deleted', path: incident.path },
    indexed_source: { git_mode: gitMode, blob_oid: blobOid, source_sha256: surface.source_sha256 },
    reproduced_git_deleted_paths: [incident.path],
  }
  return {
    candidate_tree: candidateTree,
    git_mode: gitMode,
    blob_oid: blobOid,
    source_sha256: surface.source_sha256,
    clean_inventory_sha256: digest(cleanInventory),
    working_tree_deleted_inventory_sha256: digest(workingTreeDeletedInventory),
    mutation_provenance_sha256: digest(mutationProvenance),
  }
}

export function validateHistoricalExecutablePathOwnershipFixtures(value, repositoryRoot = root) {
  const historical = value?.historical_negative_fixtures
  assert(Array.isArray(historical) && historical.length === 1, 'executable ownership historical fixture denominator mismatch')
  const incident = historical[0]
  const derived = deriveHistoricalExecutablePathOwnershipFixture(repositoryRoot, incident)
  assert(incident.mutation?.kind === 'working_tree_deleted'
    && incident.expected_failure === 'materialization requires a clean exact candidate checkout',
  'executable ownership historical fixture semantics malformed')
  assert(incident.expected && Object.keys(derived).every((key) => incident.expected[key] === derived[key])
    && Object.keys(incident.expected).length === Object.keys(derived).length,
  'executable ownership historical fixture exact reproduction mismatch')
  return derived
}

export function validateExecutablePathOwnershipDependencies(value, options = {}) {
  assert(value?.schema === 'yoko.crm.executable-path-ownership-current-dependencies.v1' && value.version === 1, 'executable ownership current dependency identity mismatch')
  const current = value.current_live
  assert(current && typeof current === 'object', 'executable ownership current dependency declaration missing')
  assert(current.authority?.path === COVERAGE_PATH
    && current.authority?.schema === 'yoko.crm.executable-path-ownership-coverage.v1', 'executable ownership current authority mismatch')
  assert(JSON.stringify(current.derived_fields) === JSON.stringify({
    tracked_executable_surfaces: '/source/tracked_executable_surfaces',
    tracked_inventory_sha256: '/source/tracked_inventory_sha256',
    coverage_sha256: '/coverage_sha256',
  }), 'executable ownership current derived-field declaration mismatch')
  exactRolePaths(current.derivation_inputs, CURRENT_DERIVATION_INPUTS, 'executable ownership current derivation inputs')
  validateExecutablePathOwnershipConsumerClosure(value, options.repositoryRoot ?? root)
  assert(JSON.stringify(current.authority_direction) === JSON.stringify([
    'repository_tracked_paths_modes_and_lifecycle_metadata',
    'tracked_surface_inventory',
    'reviewed_decisions_over_historical_baseline',
    'materialized_coverage',
    'validators',
  ]), 'executable ownership authority direction mismatch')
  assert(JSON.stringify(current.inventory_identity_inputs) === JSON.stringify([
    'tracked_path', 'git_mode', 'lifecycle_and_registry_metadata', 'working_tree_deleted',
  ]) && JSON.stringify(current.inventory_identity_excludes) === JSON.stringify([
    'ordinary_unregistered_source_bytes',
  ]), 'executable ownership inventory identity declaration mismatch')
  validateHistoricalExecutablePathOwnershipFixtures(value, options.repositoryRoot ?? root)
  if (options.contextIndex) {
    const indexed = options.contextIndex.outputs?.executable_path_ownership_current_dependencies
    assert(indexed?.path === CURRENT_DEPENDENCY_PATH && SHA256.test(indexed.sha256 ?? ''), 'executable ownership current dependencies are absent from the context index')
  }
  return value
}

export async function loadExecutablePathOwnershipDependencies(repositoryRoot, options = {}) {
  const relativePath = options.path ?? CURRENT_DEPENDENCY_PATH
  assert(relativePath === CURRENT_DEPENDENCY_PATH, 'executable ownership current dependency path is not authoritative')
  const bytes = await readFile(path.join(repositoryRoot, relativePath))
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('executable ownership current dependency document malformed')
  }
  validateExecutablePathOwnershipDependencies(value, { ...options, repositoryRoot })
  if (options.contextIndex) {
    assert(byteDigest(bytes) === options.contextIndex.outputs.executable_path_ownership_current_dependencies.sha256, 'executable ownership current dependency index hash drift')
  }
  return { bytes, value }
}

function dirtySourceSummary(statusBytes) {
  const counts = {
    working_tree_deleted: 0,
    tracked_modified: 0,
    staged_changes: 0,
    untracked_files: 0,
  }
  for (const record of statusBytes.toString('utf8').split('\0').filter(Boolean)) {
    if (record.startsWith('?? ')) {
      counts.untracked_files += 1
      continue
    }
    if (record.length < 3 || record[2] !== ' ') continue
    const indexState = record[0]
    const worktreeState = record[1]
    if (indexState !== ' ') counts.staged_changes += 1
    if (indexState === 'D' || worktreeState === 'D') counts.working_tree_deleted += 1
    if (['M', 'T'].includes(indexState) || ['M', 'T'].includes(worktreeState)) counts.tracked_modified += 1
  }
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind}=${count}`)
    .join(', ')
}

export async function assertCleanExactCandidateCheckout(repositoryRoot, expectedCommit) {
  assert(SHA1.test(expectedCommit ?? ''), 'materialization requires explicit --candidate <full-40-character-commit>')
  const { stdout: headBytes } = await execFileAsync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD^{commit}'], {
    encoding: 'buffer',
    maxBuffer: 1024 * 1024,
  })
  const head = headBytes.toString('ascii').trim()
  assert(head === expectedCommit, `materialization candidate mismatch: expected ${expectedCommit}, checkout HEAD is ${head}`)
  const { stdout: statusBytes } = await execFileAsync('git', ['-C', repositoryRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (statusBytes.length > 0) {
    const summary = dirtySourceSummary(statusBytes) || 'unclassified_dirty_state=1'
    throw new Error(`materialization requires a clean exact candidate checkout; ${summary}; no source was cleaned or materialized`)
  }
  return { candidate: head, status_porcelain_bytes: 0 }
}

function matchesExclusion(surface, rule) {
  if (rule.lifecycles && !rule.lifecycles.includes(surface.lifecycle)) return false
  if (rule.path && surface.path !== rule.path) return false
  if (rule.path_prefix && !contains(rule.path_prefix, surface.path)) return false
  return Boolean(rule.path || rule.path_prefix)
}

export function deriveExecutablePathOwnershipCoverage(inventory, manifests, coverage, options = {}) {
  assert(inventory?.schema === 'yoko.crm.tracked-executable-surface-inventory.v2' && Array.isArray(inventory.surfaces), 'tracked executable inventory identity mismatch')
  assert(coverage?.schema === 'yoko.crm.executable-path-ownership-coverage.v1' && coverage.version === 1, 'executable ownership coverage identity mismatch')
  assert(Array.isArray(coverage.governed_exclusions) && coverage.governed_exclusions.length > 0, 'governed executable exclusions missing')
  assert(Array.isArray(coverage.functional_owner_registry) && coverage.functional_owner_registry.length > 0, 'functional owner registry missing')
  const owners = new Map()
  for (const owner of coverage.functional_owner_registry) {
    assert(typeof owner.id === 'string' && owner.id.length > 0 && !owners.has(owner.id), 'duplicate or invalid functional owner id')
    assert(['CONTEXT', 'LEGACY_RUNTIME', 'MIGRATION_AUTHORITY', 'OPERATIONS', 'EVIDENCE'].includes(owner.owner_class) && Array.isArray(owner.allowed_lifecycles) && owner.allowed_lifecycles.length > 0 && typeof owner.accountability === 'string' && owner.accountability.length > 0, `functional owner vocabulary invalid: ${owner.id}`)
    owners.set(owner.id, owner)
  }
  const exclusionIds = new Set()
  for (const rule of coverage.governed_exclusions) {
    assert(typeof rule.id === 'string' && rule.id.length > 0 && !exclusionIds.has(rule.id), 'duplicate or invalid executable exclusion id')
    exclusionIds.add(rule.id)
    assert((typeof rule.path === 'string' && rule.path.length > 0) !== (typeof rule.path_prefix === 'string' && rule.path_prefix.length > 0), `executable exclusion selector invalid: ${rule.id}`)
    assert(typeof rule.functional_owner === 'string' && owners.has(rule.functional_owner) && typeof rule.rationale === 'string' && rule.rationale.length > 0 && typeof rule.review_artifact === 'string' && rule.review_artifact.length > 0, `executable exclusion governance incomplete: ${rule.id}`)
    assert(!(rule.exact_runtime_inventory && rule.exact_path_inventory), `executable exclusion has ambiguous exact inventory kinds: ${rule.id}`)
    if (rule.exact_runtime_inventory) assert(typeof rule.exact_runtime_inventory.path_sha256 === 'string' && /^[0-9a-f]{64}$/.test(rule.exact_runtime_inventory.path_sha256) && Number.isInteger(rule.exact_runtime_inventory.path_count) && rule.exact_runtime_inventory.path_count >= 0, `exact runtime inventory invalid: ${rule.id}`)
    if (rule.exact_path_inventory) assert(typeof rule.exact_path_inventory.path_sha256 === 'string' && /^[0-9a-f]{64}$/.test(rule.exact_path_inventory.path_sha256) && Number.isInteger(rule.exact_path_inventory.path_count) && rule.exact_path_inventory.path_count >= 0, `exact path inventory invalid: ${rule.id}`)
  }
  const ownershipClaims = []
  for (const manifest of manifests) {
    const context = manifest?.context?.id
    assert(typeof context === 'string' && context.length > 0 && Array.isArray(manifest.owned_paths), 'manifest executable ownership declaration invalid')
    for (const ownedPath of manifest.owned_paths) {
      assert(typeof ownedPath === 'string' && ownedPath.length > 0, `manifest owned path invalid: ${context}`)
      ownershipClaims.push({ context, path: ownedPath })
    }
  }
  for (let leftIndex = 0; leftIndex < ownershipClaims.length; leftIndex += 1) {
    const left = ownershipClaims[leftIndex]
    for (let rightIndex = leftIndex + 1; rightIndex < ownershipClaims.length; rightIndex += 1) {
      const right = ownershipClaims[rightIndex]
      if (left.context === right.context) continue
      assert(
        !contains(left.path, right.path) && !contains(right.path, left.path),
        `manifest owned_paths overlap across contexts: ${left.context}:${left.path} <> ${right.context}:${right.path}`,
      )
    }
  }
  const records = inventory.surfaces.map((surface) => {
    const contextOwners = manifests.filter((manifest) => manifest.owned_paths.some((ownedPath) => contains(ownedPath, surface.path))).map((manifest) => manifest.context.id)
    assert(contextOwners.length <= 1, `executable path has overlapping context ownership: ${surface.path}`)
    if (contextOwners.length === 1) return { context: contextOwners[0], path: surface.path, type: 'context' }
    const exclusions = coverage.governed_exclusions.filter((rule) => matchesExclusion(surface, rule))
    assert(exclusions.length > 0, `executable path lacks context owner or governed exclusion: ${surface.path}`)
    const specificity = (rule) => (rule.path ?? rule.path_prefix).length
    const best = Math.max(...exclusions.map(specificity))
    const selected = exclusions.filter((rule) => specificity(rule) === best)
    assert(selected.length === 1, `executable path has ambiguous governed exclusions: ${surface.path}`)
    const rule = selected[0]
    const owner = owners.get(rule.functional_owner)
    assert(owner.allowed_lifecycles.includes(surface.lifecycle), `functional owner lifecycle incompatible: ${rule.functional_owner}/${surface.path}`)
    if (surface.lifecycle === 'APPLICATION_RUNTIME' && owner.owner_class !== 'CONTEXT') {
      assert(rule.exact_runtime_inventory && owner.owner_class === 'LEGACY_RUNTIME' || rule.exact_runtime_inventory && owner.owner_class === 'EVIDENCE', `application-runtime path requires exact legacy/evidence inventory ownership: ${surface.path}`)
    }
    return { exclusion: rule.id, functional_owner: rule.functional_owner, lifecycle: surface.lifecycle, path: surface.path, type: 'governed_exclusion' }
  }).sort((left, right) => left.path.localeCompare(right.path))
  for (const rule of coverage.governed_exclusions.filter((candidate) => candidate.exact_runtime_inventory)) {
    const paths = records.filter((record) => record.type === 'governed_exclusion' && record.exclusion === rule.id && record.lifecycle === 'APPLICATION_RUNTIME').map((record) => record.path)
    if (!options.allowExactInventoryRefresh) assert(paths.length === rule.exact_runtime_inventory.path_count && digest(paths) === rule.exact_runtime_inventory.path_sha256, `exact runtime inventory drift: ${rule.id} (${paths.length}/${digest(paths)})`)
  }
  for (const rule of coverage.governed_exclusions.filter((candidate) => candidate.exact_path_inventory)) {
    const paths = records.filter((record) => record.type === 'governed_exclusion' && record.exclusion === rule.id).map((record) => record.path)
    if (!options.allowExactInventoryRefresh) assert(paths.length === rule.exact_path_inventory.path_count && digest(paths) === rule.exact_path_inventory.path_sha256, `exact path inventory drift: ${rule.id} (${paths.length}/${digest(paths)})`)
  }
  const contextOwned = records.filter((record) => record.type === 'context').length
  const governedExcluded = records.length - contextOwned
  return {
    coverage_sha256: digest(records),
    governed_exclusion_paths: governedExcluded,
    records,
    tracked_executable_surfaces: records.length,
    tracked_inventory_sha256: digest(inventory),
    context_owned_paths: contextOwned,
  }
}

export function validateExecutablePathOwnershipCoverage(inventory, manifests, coverage) {
  const derived = deriveExecutablePathOwnershipCoverage(inventory, manifests, coverage)
  assert(coverage.source?.tracked_executable_surfaces === derived.tracked_executable_surfaces, 'executable ownership denominator drift')
  assert(coverage.source?.tracked_inventory_sha256 === derived.tracked_inventory_sha256, 'executable ownership source inventory drift')
  assert(coverage.coverage_sha256 === derived.coverage_sha256, 'executable ownership coverage assignment drift')
  assert(coverage.summary?.context_owned_paths === derived.context_owned_paths && coverage.summary?.governed_exclusion_paths === derived.governed_exclusion_paths && coverage.summary?.tracked_executable_surfaces === derived.tracked_executable_surfaces, 'executable ownership coverage summary drift')
  return derived
}

function exactInventoryDrift(coverage, derived) {
  const changes = []
  for (const rule of coverage.governed_exclusions) {
    const inventoryKind = rule.exact_runtime_inventory
      ? 'exact_runtime_inventory'
      : rule.exact_path_inventory
        ? 'exact_path_inventory'
        : null
    if (!inventoryKind) continue
    const records = derived.records.filter((record) => record.type === 'governed_exclusion'
      && record.exclusion === rule.id
      && (inventoryKind !== 'exact_runtime_inventory' || record.lifecycle === 'APPLICATION_RUNTIME'))
    const paths = records.map((record) => record.path)
    const currentInventory = { path_count: paths.length, path_sha256: digest(paths) }
    const previousInventory = rule[inventoryKind]
    if (currentInventory.path_count !== previousInventory.path_count || currentInventory.path_sha256 !== previousInventory.path_sha256) {
      changes.push({
        exclusion: rule.id,
        inventory_kind: inventoryKind,
        previous_inventory: { ...previousInventory },
        current_inventory: currentInventory,
        records,
      })
    }
  }
  return changes.sort((left, right) => left.exclusion.localeCompare(right.exclusion) || left.inventory_kind.localeCompare(right.inventory_kind))
}

function sourceHash(sourceSha256ByPath, relativePath) {
  return sourceSha256ByPath instanceof Map
    ? sourceSha256ByPath.get(relativePath)
    : sourceSha256ByPath?.[relativePath]
}

export function validateReviewedExactInventoryDecisions(coverage, derived, decisions, options = {}) {
  assert(decisions && typeof decisions === 'object', 'explicit reviewed executable ownership decisions are required')
  assert(decisions.schema === REVIEWED_DECISION_SCHEMA && decisions.version === 1, 'reviewed executable ownership decision registry identity mismatch')
  assert(decisions.review?.status === 'COMPLETED_EXACT_PATH_REVIEW'
    && decisions.review.reviewed_by === INTERNAL_REVIEWER
    && decisions.review.role === INTERNAL_REVIEW_ROLE
    && decisions.review.external_acceptance === false
    && decisions.review.independent_acceptance === false
    && typeof decisions.review.decision === 'string'
    && decisions.review.decision.length >= 48, 'reviewed executable ownership decision metadata incomplete')
  assert(typeof options.baselineCoverageSha256 === 'string' && SHA256.test(options.baselineCoverageSha256), 'baseline executable ownership coverage hash is required')
  assert(typeof options.baselineCoveragePath === 'string' && options.baselineCoveragePath.length > 0, 'baseline executable ownership coverage path is required')
  assert(decisions.baseline?.coverage_path === options.baselineCoveragePath
    && decisions.baseline?.coverage_sha256 === options.baselineCoverageSha256, 'reviewed executable ownership decisions are stale for the baseline coverage')
  assert(decisions.current?.tracked_inventory_sha256 === derived.tracked_inventory_sha256
    && decisions.current?.tracked_executable_surfaces === derived.tracked_executable_surfaces
    && decisions.current?.coverage_sha256 === derived.coverage_sha256, 'reviewed executable ownership decisions are stale for the current denominator')

  const changes = exactInventoryDrift(coverage, derived)
  assert(Array.isArray(decisions.exact_inventory_changes) && decisions.exact_inventory_changes.length === changes.length, 'reviewed exact inventory change set is missing, mismatched, or stale')
  const decisionChanges = new Map()
  for (const decisionChange of decisions.exact_inventory_changes) {
    const key = `${decisionChange?.exclusion ?? ''}|${decisionChange?.inventory_kind ?? ''}`
    assert(!decisionChanges.has(key), `duplicate reviewed exact inventory change: ${key}`)
    decisionChanges.set(key, decisionChange)
  }
  for (const { records: _records, ...expectedChange } of changes) {
    const key = `${expectedChange.exclusion}|${expectedChange.inventory_kind}`
    const decisionChange = decisionChanges.get(key)
    assert(decisionChange, `missing reviewed exact inventory change: ${key}`)
    assert(decisionChange.review_decision === 'APPROVED_EXACT_INVENTORY_TRANSITION'
      && typeof decisionChange.review_rationale === 'string'
      && decisionChange.review_rationale.length >= 48, `reviewed exact inventory change lacks an explicit internal decision: ${key}`)
    for (const field of ['exclusion', 'inventory_kind', 'previous_inventory', 'current_inventory']) {
      assert(JSON.stringify(stable(decisionChange[field])) === JSON.stringify(stable(expectedChange[field])), `reviewed exact inventory change ${field} mismatch: ${key}`)
    }
    assert(Array.isArray(decisionChange.previous_paths)
      && new Set(decisionChange.previous_paths).size === decisionChange.previous_paths.length
      && decisionChange.previous_paths.every((entry) => typeof entry === 'string' && entry.length > 0)
      && decisionChange.previous_paths.length === expectedChange.previous_inventory.path_count
      && digest([...decisionChange.previous_paths].sort()) === expectedChange.previous_inventory.path_sha256, `reviewed previous exact path inventory mismatch: ${key}`)
  }
  assert(Array.isArray(decisions.assignments), 'reviewed exact inventory assignments missing')

  const expectedByPath = new Map()
  for (const change of changes) {
    for (const record of change.records) {
      assert(!expectedByPath.has(record.path), `exact inventory path is claimed by multiple reviewed denominators: ${record.path}`)
      const currentSourceSha256 = sourceHash(options.sourceSha256ByPath, record.path)
      assert(typeof currentSourceSha256 === 'string' && SHA256.test(currentSourceSha256), `current exact inventory source hash unavailable: ${record.path}`)
      expectedByPath.set(record.path, {
        path: record.path,
        lifecycle: record.lifecycle,
        functional_owner: record.functional_owner,
        exclusion: record.exclusion,
        inventory_kind: change.inventory_kind,
        source_sha256: currentSourceSha256,
      })
    }
  }

  const actualByPath = new Map()
  for (const assignment of decisions.assignments) {
    assert(assignment && typeof assignment.path === 'string' && assignment.path.length > 0, 'reviewed exact inventory assignment path missing')
    assert(!actualByPath.has(assignment.path), `duplicate reviewed exact inventory assignment: ${assignment.path}`)
    assert(assignment.review_decision === 'APPROVED_CURRENT_ASSIGNMENT'
      && typeof assignment.review_rationale === 'string'
      && assignment.review_rationale.length >= 48, `reviewed exact inventory assignment lacks an explicit internal decision: ${assignment.path}`)
    actualByPath.set(assignment.path, assignment)
  }
  for (const [assignmentPath, assignment] of actualByPath) {
    const expected = expectedByPath.get(assignmentPath)
    assert(expected, `stale reviewed exact inventory assignment: ${assignmentPath}`)
    for (const field of ['lifecycle', 'functional_owner', 'exclusion', 'inventory_kind', 'source_sha256']) {
      assert(assignment[field] === expected[field], `reviewed exact inventory assignment ${field} mismatch: ${assignmentPath}`)
    }
  }
  for (const expectedPath of expectedByPath.keys()) {
    assert(actualByPath.has(expectedPath), `missing reviewed exact inventory assignment: ${expectedPath}`)
  }
  assert(actualByPath.size === expectedByPath.size, 'reviewed exact inventory assignment denominator mismatch')
  return { changes, reviewedAssignments: actualByPath.size }
}

export function materializeReviewedExecutablePathOwnershipCoverage(inventory, manifests, coverage, decisions, options = {}) {
  const provisional = deriveExecutablePathOwnershipCoverage(inventory, manifests, coverage, { allowExactInventoryRefresh: true })
  const review = validateReviewedExactInventoryDecisions(coverage, provisional, decisions, options)
  assert(typeof options.decisionRegistryPath === 'string' && options.decisionRegistryPath.length > 0, 'reviewed executable ownership decision registry path is required')
  assert(typeof options.decisionRegistrySha256 === 'string' && SHA256.test(options.decisionRegistrySha256), 'reviewed executable ownership decision registry hash is required')
  const refreshed = structuredClone(coverage)
  for (const change of review.changes) refreshed.governed_exclusions.find((rule) => rule.id === change.exclusion)[change.inventory_kind] = { ...change.current_inventory }
  const derived = deriveExecutablePathOwnershipCoverage(inventory, manifests, refreshed)
  assert(derived.coverage_sha256 === provisional.coverage_sha256, 'mechanical executable ownership materialization changed reviewed assignments')
  refreshed.source = {
    tracked_executable_surfaces: derived.tracked_executable_surfaces,
    tracked_inventory_sha256: derived.tracked_inventory_sha256,
  }
  refreshed.coverage_sha256 = derived.coverage_sha256
  refreshed.summary = {
    tracked_executable_surfaces: derived.tracked_executable_surfaces,
    context_owned_paths: derived.context_owned_paths,
    governed_exclusion_paths: derived.governed_exclusion_paths,
  }
  refreshed.reviewed_exact_inventory_materialization = {
    decision_registry_path: options.decisionRegistryPath,
    decision_registry_sha256: options.decisionRegistrySha256,
    baseline_coverage_path: options.baselineCoveragePath,
    baseline_coverage_sha256: options.baselineCoverageSha256,
    tracked_inventory_sha256: derived.tracked_inventory_sha256,
    exact_inventory_change_count: review.changes.length,
    reviewed_assignment_count: review.reviewedAssignments,
  }
  return refreshed
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? null : process.argv[index + 1]
}

function repositoryRelative(resolvedPath) {
  const relative = path.relative(root, resolvedPath)
  assert(relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative), 'reviewed executable ownership decision registry must be inside the repository')
  return relative.split(path.sep).join('/')
}

export async function validateExecutablePathOwnershipProvenance(repositoryRoot, coverage, inventory, manifests, options = {}) {
  const provenance = coverage.reviewed_exact_inventory_materialization
  assert(provenance, 'reviewed executable ownership materialization provenance missing')
  const expectedDecisionRegistryPath = options.expectedDecisionRegistryPath ?? REVIEWED_DECISION_PATH
  const expectedBaselineCoveragePath = options.expectedBaselineCoveragePath ?? REVIEWED_BASELINE_PATH
  const expectedBaselineCoverageSha256 = options.expectedBaselineCoverageSha256 ?? REVIEWED_BASELINE_SHA256
  assert(provenance.decision_registry_path === expectedDecisionRegistryPath, 'reviewed executable ownership decision registry path is not authoritative')
  assert(provenance.baseline_coverage_path === expectedBaselineCoveragePath
    && provenance.baseline_coverage_sha256 === expectedBaselineCoverageSha256, 'reviewed executable ownership baseline trust anchor mismatch')
  assert(typeof provenance.decision_registry_path === 'string' && provenance.decision_registry_path.length > 0, 'reviewed executable ownership materialization decision path missing')
  assert(SHA256.test(provenance.decision_registry_sha256 ?? '')
    && SHA256.test(provenance.baseline_coverage_sha256 ?? '')
    && provenance.tracked_inventory_sha256 === coverage.source?.tracked_inventory_sha256
    && Number.isInteger(provenance.exact_inventory_change_count)
    && provenance.exact_inventory_change_count >= 0
    && Number.isInteger(provenance.reviewed_assignment_count)
    && provenance.reviewed_assignment_count >= 0, 'reviewed executable ownership materialization provenance invalid')
  const canonicalRelative = (resolvedPath) => {
    const relative = path.relative(repositoryRoot, resolvedPath)
    assert(relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative), 'reviewed executable ownership provenance must stay inside the repository')
    return relative.split(path.sep).join('/')
  }
  const decisionPath = path.resolve(repositoryRoot, provenance.decision_registry_path)
  assert(canonicalRelative(decisionPath) === provenance.decision_registry_path, 'reviewed executable ownership materialization decision path is not canonical')
  const decisionBytes = await readFile(decisionPath)
  assert(byteDigest(decisionBytes) === provenance.decision_registry_sha256, 'reviewed executable ownership decision registry hash drift')
  const decisions = JSON.parse(decisionBytes.toString('utf8'))
  assert(typeof provenance.baseline_coverage_path === 'string' && provenance.baseline_coverage_path.length > 0, 'reviewed executable ownership baseline path missing')
  const baselinePath = path.resolve(repositoryRoot, provenance.baseline_coverage_path)
  assert(canonicalRelative(baselinePath) === provenance.baseline_coverage_path, 'reviewed executable ownership baseline path is not canonical')
  const baselineBytes = await readFile(baselinePath)
  assert(byteDigest(baselineBytes) === provenance.baseline_coverage_sha256, 'reviewed executable ownership baseline hash drift')
  const baseline = JSON.parse(baselineBytes.toString('utf8'))
  assert(baseline.schema === REVIEWED_BASELINE_SCHEMA && baseline.version === 1, 'reviewed executable ownership baseline identity mismatch')
  assert(decisions.schema === REVIEWED_DECISION_SCHEMA && decisions.version === 1
    && decisions.baseline?.coverage_path === provenance.baseline_coverage_path
    && decisions.baseline?.coverage_sha256 === provenance.baseline_coverage_sha256
    && decisions.current?.tracked_inventory_sha256 === provenance.tracked_inventory_sha256
    && decisions.assignments?.length === provenance.reviewed_assignment_count
    && decisions.exact_inventory_changes?.length === provenance.exact_inventory_change_count, 'reviewed executable ownership materialization provenance contradiction')
  assert(inventory?.schema === 'yoko.crm.tracked-executable-surface-inventory.v2' && Array.isArray(manifests), 'current executable ownership inventory/manifests are required for provenance validation')
  const provisional = deriveExecutablePathOwnershipCoverage(inventory, manifests, baseline, { allowExactInventoryRefresh: true })
  const changedPaths = exactInventoryDrift(baseline, provisional).flatMap((change) => change.records.map((record) => record.path))
  const sourceSha256ByPath = new Map(await Promise.all(changedPaths.map(async (relativePath) => [relativePath, byteDigest(await readFile(path.join(repositoryRoot, relativePath)))])))
  const expectedCoverage = materializeReviewedExecutablePathOwnershipCoverage(inventory, manifests, baseline, decisions, {
    baselineCoveragePath: provenance.baseline_coverage_path,
    baselineCoverageSha256: provenance.baseline_coverage_sha256,
    sourceSha256ByPath,
    decisionRegistryPath: provenance.decision_registry_path,
    decisionRegistrySha256: provenance.decision_registry_sha256,
  })
  assert(JSON.stringify(stable(coverage)) === JSON.stringify(stable(expectedCoverage)), 'current executable ownership coverage is not the exact reviewed mechanical materialization')
  return { decisions, baseline, expectedCoverage }
}

async function main() {
  const materializing = process.argv.includes('--materialize-reviewed-current-denominator')
  const candidateArgument = materializing ? option('--candidate') : null
  if (materializing) await assertCleanExactCandidateCheckout(root, candidateArgument)
  const [registry, coverageBytes, index] = await Promise.all([
    readFile(path.join(root, REGISTRY_PATH), 'utf8').then(JSON.parse),
    readFile(path.join(root, COVERAGE_PATH)),
    readFile(path.join(root, 'architecture/contexts/v1/context-index.json'), 'utf8').then(JSON.parse),
  ])
  await loadExecutablePathOwnershipDependencies(root, { contextIndex: index })
  const coverage = JSON.parse(coverageBytes.toString('utf8'))
  const manifests = await Promise.all(index.contexts.map(async (entry) => JSON.parse(await readFile(path.join(root, entry.path), 'utf8'))))
  const inventory = await inventoryTrackedSurfaces(root, { registry })
  if (materializing) {
    const decisionArgument = option('--reviewed-decisions')
    assert(decisionArgument, 'explicit --reviewed-decisions <registry.json> input is required for materialization')
    const decisionPath = path.resolve(root, decisionArgument)
    const decisionRegistryPath = repositoryRelative(decisionPath)
    assert(decisionRegistryPath === REVIEWED_DECISION_PATH, `materialization requires authoritative reviewed decisions at ${REVIEWED_DECISION_PATH}`)
    const decisionBytes = await readFile(path.join(root, REVIEWED_DECISION_PATH))
    const decisions = JSON.parse(decisionBytes.toString('utf8'))
    assert(typeof decisions.baseline?.coverage_path === 'string' && decisions.baseline.coverage_path.length > 0, 'reviewed executable ownership baseline path missing')
    const baselinePath = path.resolve(root, decisions.baseline.coverage_path)
    const baselineCoveragePath = repositoryRelative(baselinePath)
    assert(baselineCoveragePath === REVIEWED_BASELINE_PATH, `materialization requires authoritative baseline at ${REVIEWED_BASELINE_PATH}`)
    const baselineBytes = await readFile(path.join(root, REVIEWED_BASELINE_PATH))
    assert(byteDigest(baselineBytes) === REVIEWED_BASELINE_SHA256, 'reviewed executable ownership baseline trust anchor mismatch')
    const baselineCoverage = JSON.parse(baselineBytes.toString('utf8'))
    assert(baselineCoverage.schema === REVIEWED_BASELINE_SCHEMA && baselineCoverage.version === 1, 'reviewed executable ownership baseline identity mismatch')
    const provisional = deriveExecutablePathOwnershipCoverage(inventory, manifests, baselineCoverage, { allowExactInventoryRefresh: true })
    const changedPaths = exactInventoryDrift(baselineCoverage, provisional).flatMap((change) => change.records.map((record) => record.path))
    const sourceSha256ByPath = new Map(await Promise.all(changedPaths.map(async (relativePath) => [relativePath, byteDigest(await readFile(path.join(root, relativePath)))])))
    const refreshed = materializeReviewedExecutablePathOwnershipCoverage(inventory, manifests, baselineCoverage, decisions, {
      baselineCoveragePath,
      baselineCoverageSha256: byteDigest(baselineBytes),
      sourceSha256ByPath,
      decisionRegistryPath,
      decisionRegistrySha256: byteDigest(decisionBytes),
    })
    await assertCleanExactCandidateCheckout(root, candidateArgument)
    await writeFile(path.join(root, COVERAGE_PATH), `${JSON.stringify(refreshed, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify({ materialized: true, candidate: candidateArgument, source_was_clean: true, ...refreshed.summary, coverage_sha256: refreshed.coverage_sha256 })}\n`)
    return
  }
  const result = validateExecutablePathOwnershipCoverage(inventory, manifests, coverage)
  await validateExecutablePathOwnershipProvenance(root, coverage, inventory, manifests)
  process.stdout.write(`${JSON.stringify({ ok: true, ...coverage.summary, coverage_sha256: result.coverage_sha256 })}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
