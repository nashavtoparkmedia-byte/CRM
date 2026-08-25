#!/usr/bin/env node
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'
import { classifyTrackedSurface, inventoryTrackedSurfaces } from './v2/tracked-surface-inventory.mjs'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const COVERAGE_PATH = 'architecture/contexts/v1/executable-path-ownership-coverage.json'
const CURRENT_DEPENDENCY_PATH = 'architecture/contexts/v1/executable-path-ownership-current-dependencies.json'
const REGISTRY_PATH = 'architecture/recovery/whole-project-dod/v2/LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json'
export const REVIEWED_DECISION_SCHEMA = 'yoko.crm.reviewed-executable-path-ownership-decisions.v1'
export const REVIEWED_BASELINE_SCHEMA = 'yoko.crm.executable-path-ownership-coverage.v1'
export const INTERNAL_REVIEWER = 'INTERNAL_EXECUTOR_REVIEW_20260813'
export const INTERNAL_REVIEW_ROLE = 'SOL_HIGH_INTERNAL_REVIEW'
const REVIEWED_DECISION_PATH = 'architecture/recovery/whole-project-dod/v2/EXECUTABLE_PATH_OWNERSHIP_REVIEW_20260813.json'
const REVIEWED_BASELINE_PATH = 'architecture/recovery/whole-project-dod/v2/EXECUTABLE_PATH_OWNERSHIP_COVERAGE_BASELINE_2108.json'
export const REVIEWED_BASELINE_SHA256 = '429a48c9d257408025bbc273a4d6f1413ed78196549ed889118422b6caba5730'
const OWNERSHIP_VALIDATOR_PATH = 'tools/architecture/validate-executable-path-ownership.mjs'

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

const JAVASCRIPT_SOURCE = /\.(?:[cm]?js|jsx|ts|tsx)$/u
const AUTHORITY_CAPABILITY_CONTRACT = [
  { export: 'readCurrentOwnershipCoverage', authority_use: 'coverage_document', artifact_path: COVERAGE_PATH },
  { export: 'readCurrentOwnershipDependencies', authority_use: 'dependency_manifest', artifact_path: CURRENT_DEPENDENCY_PATH },
  { export: 'readHistoricalOwnershipBaseline', authority_use: 'historical_baseline', artifact_path: REVIEWED_BASELINE_PATH },
  { export: 'readReviewedOwnershipDecisions', authority_use: 'reviewed_decisions', artifact_path: REVIEWED_DECISION_PATH },
]

async function readJsonAuthority(repositoryRoot, relativePath, label) {
  const bytes = await readFile(path.join(repositoryRoot, relativePath))
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) }
  } catch {
    throw new Error(label + ' document malformed')
  }
}

export function readCurrentOwnershipCoverage(repositoryRoot = root) {
  return readJsonAuthority(repositoryRoot, COVERAGE_PATH, 'current executable ownership coverage')
}

export function readCurrentOwnershipDependencies(repositoryRoot = root) {
  return readJsonAuthority(repositoryRoot, CURRENT_DEPENDENCY_PATH, 'current executable ownership dependencies')
}

export function readReviewedOwnershipDecisions(repositoryRoot = root) {
  return readJsonAuthority(repositoryRoot, REVIEWED_DECISION_PATH, 'reviewed executable ownership decisions')
}

export function readHistoricalOwnershipBaseline(repositoryRoot = root) {
  return readJsonAuthority(repositoryRoot, REVIEWED_BASELINE_PATH, 'historical executable ownership baseline')
}

function moduleSpecifierText(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null
}

function repositoryTrackedJavaScriptSources(repositoryRoot) {
  const output = execFileSync('git', ['-C', repositoryRoot, 'ls-files', '-z'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  return output.toString('utf8').split('\0').filter((relativePath) => JAVASCRIPT_SOURCE.test(relativePath)).sort()
}

function parseTrackedSources(repositoryRoot, relativePaths) {
  const sources = new Map()
  const failures = []
  for (const relativePath of relativePaths) {
    const sourceBytes = readFileSync(path.join(repositoryRoot, relativePath))
    const sourceText = sourceBytes[0] === 0xff && sourceBytes[1] === 0xfe
      ? sourceBytes.subarray(2).toString('utf16le')
      : sourceBytes.toString('utf8')
    const sourceFile = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true)
    sources.set(relativePath, { sourceFile, sourceText })
    for (const diagnostic of sourceFile.parseDiagnostics ?? []) {
      const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
      failures.push(relativePath + ':' + (position.line + 1) + ':' + (position.character + 1) + ': ' + ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))
    }
  }
  assert(failures.length === 0, 'structural authority import parse failure:\n' + failures.join('\n'))
  return sources
}

function exportedNames(sourceFile) {
  const names = new Set()
  for (const statement of sourceFile.statements) {
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    if (exported && statement.name && ts.isIdentifier(statement.name)) names.add(statement.name.text)
    if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text)
      }
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.add(element.name.text)
    }
  }
  return names
}

function assertNoRawAuthorityExports(sourceFile, sourceText) {
  const protectedTokens = new Set(AUTHORITY_CAPABILITY_CONTRACT.flatMap(({ artifact_path: artifactPath }) => [artifactPath, path.posix.basename(artifactPath)]))
  for (const statement of sourceFile.statements) {
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      || ts.isExportDeclaration(statement)
    if (!exported) continue
    const statementText = sourceText.slice(statement.getStart(sourceFile), statement.getEnd())
    assert(![...protectedTokens].some((token) => statementText.includes(token)), 'raw executable ownership authority path export forbidden')
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        assert(!/(?:PATH|FILE|LOCATION)$/u.test((element.propertyName ?? element.name).text), 'raw executable ownership authority path export forbidden')
      }
    }
    if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) assert(!/(?:PATH|FILE|LOCATION)$/u.test(declaration.name.text), 'raw executable ownership authority path export forbidden')
      }
    }
  }
}

const MODULE_EXTENSIONS = ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx']

function trackedModuleSpecifierIdentity(repositoryRoot, relativePath, specifier, trackedPaths) {
  const claimedLocal = typeof specifier === 'string'
    && (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/') || specifier.startsWith('file:'))
  if (!claimedLocal) {
    return { kind: 'non_local', target: null, has_search: false, has_hash: false }
  }
  let resolvedUrl
  try {
    resolvedUrl = new URL(specifier, pathToFileURL(path.resolve(repositoryRoot, relativePath)))
  } catch {
    return { kind: 'unsupported_local', target: null, has_search: false, has_hash: false }
  }
  if (resolvedUrl.protocol !== 'file:') {
    return { kind: 'unsupported_local', target: null, has_search: false, has_hash: false }
  }
  const withoutSearch = new URL(resolvedUrl.href)
  const withoutHash = new URL(resolvedUrl.href)
  withoutSearch.search = ''
  withoutHash.hash = ''
  const hasSearch = withoutSearch.href !== resolvedUrl.href
  const hasHash = withoutHash.href !== resolvedUrl.href
  let absoluteTarget
  try {
    absoluteTarget = fileURLToPath(resolvedUrl)
  } catch {
    return { kind: 'unsupported_local', target: null, has_search: hasSearch, has_hash: hasHash }
  }
  const repositoryPath = path.resolve(repositoryRoot)
  const platformRelative = path.relative(repositoryPath, absoluteTarget)
  if (path.isAbsolute(platformRelative) || platformRelative === '..' || platformRelative.startsWith(`..${path.sep}`)) {
    return { kind: 'outside_repository', target: null, has_search: hasSearch, has_hash: hasHash }
  }
  const base = platformRelative.split(path.sep).join('/')
  const candidates = [
    base,
    ...MODULE_EXTENSIONS.map((extension) => base + extension),
    ...MODULE_EXTENSIONS.map((extension) => path.posix.join(base, 'index' + extension)),
  ]
  const matches = [...new Set(candidates.filter((candidate) => trackedPaths.has(candidate)))]
  assert(matches.length <= 1, 'tracked module edge resolves ambiguously: ' + relativePath + '#' + specifier)
  return {
    kind: matches.length === 1 ? 'tracked_local' : 'untracked_local',
    target: matches[0] ?? null,
    has_search: hasSearch,
    has_hash: hasHash,
  }
}

function sourceModuleEdges(sourceFile, repositoryRoot, relativePath, trackedPaths) {
  const edges = []
  const add = (kind, specifierNode, declarationNode) => {
    const specifier = moduleSpecifierText(specifierNode)
    const identity = trackedModuleSpecifierIdentity(repositoryRoot, relativePath, specifier, trackedPaths)
    if (identity.target) edges.push({
      source: relativePath,
      target: identity.target,
      kind,
      specifier,
      declarationNode,
      specifierNode,
      has_search: identity.has_search,
      has_hash: identity.has_hash,
    })
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) add('static_import', node.moduleSpecifier, node)
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) add('static_reexport', node.moduleSpecifier, node)
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add('import_equals', node.moduleReference.expression, node)
    if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require')) add('literal_dynamic_import', node.arguments[0], node)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return edges
}

function propertyAccessParts(expression) {
  if (ts.isPropertyAccessExpression(expression)) return { object: expression.expression, property: expression.name.text }
  if (ts.isElementAccessExpression(expression)) {
    const property = moduleSpecifierText(expression.argumentExpression)
    return property === null ? null : { object: expression.expression, property }
  }
  return null
}

function isModuleExports(expression) {
  const access = propertyAccessParts(expression)
  return Boolean(access && ts.isIdentifier(access.object) && access.object.text === 'module' && access.property === 'exports')
}

function isCommonJsExportTarget(expression) {
  if (isModuleExports(expression)) return true
  const access = propertyAccessParts(expression)
  return Boolean(access && (ts.isIdentifier(access.object) && access.object.text === 'exports' || isModuleExports(access.object)))
}

function moduleExportKinds(sourceFile) {
  const exports = []
  const visit = (node) => {
    if (ts.isExportDeclaration(node) || ts.isExportAssignment(node) || node.kind === ts.SyntaxKind.NamespaceExportDeclaration) {
      exports.push(ts.SyntaxKind[node.kind])
    } else if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      exports.push(ts.SyntaxKind[node.kind])
    } else if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && isCommonJsExportTarget(node.left)) {
      exports.push('CommonJsExportAssignment')
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return exports
}

function validateAuthorityAccessDeclaration(value) {
  const access = value?.current_live?.authority_access
  assert(access && access.module === OWNERSHIP_VALIDATOR_PATH && Array.isArray(access.capabilities)
    && Array.isArray(access.non_authority_exports), 'executable ownership canonical authority access declaration malformed')
  const expected = new Map(AUTHORITY_CAPABILITY_CONTRACT.map((capability) => [capability.export, capability]))
  const actual = new Map()
  for (const capability of access.capabilities) {
    assert(capability && typeof capability.export === 'string' && typeof capability.authority_use === 'string'
      && typeof capability.artifact_path === 'string', 'executable ownership authority capability malformed')
    assert(!actual.has(capability.export), 'executable ownership authority capability duplicated: ' + capability.export)
    actual.set(capability.export, capability)
  }
  assert(actual.size === expected.size, 'executable ownership authority capability denominator mismatch')
  for (const [exportName, expectedCapability] of expected) {
    assert(JSON.stringify(actual.get(exportName)) === JSON.stringify(expectedCapability), 'executable ownership authority capability contract mismatch: ' + exportName)
  }
  assert(access.non_authority_exports.every((exportName) => typeof exportName === 'string' && exportName.length > 0)
    && new Set(access.non_authority_exports).size === access.non_authority_exports.length
    && access.non_authority_exports.every((exportName) => !expected.has(exportName)), 'executable ownership non-authority export declaration malformed')
  return { accessModulePath: access.module, capabilities: expected, nonAuthorityExports: new Set(access.non_authority_exports) }
}

function sourceImports(sourceFile, relativePath, accessModulePath, exported, capabilities, moduleEdges) {
  const importedCapabilities = new Set()
  const allowedRawRanges = []
  for (const edge of moduleEdges.filter((candidate) => candidate.kind === 'static_import' && candidate.target === accessModulePath)) {
    const node = edge.declarationNode
    allowedRawRanges.push([edge.specifierNode.getStart(sourceFile), edge.specifierNode.getEnd()])
    const bindings = node.importClause?.namedBindings
    assert(node.importClause && !node.importClause.name && bindings && ts.isNamedImports(bindings), 'canonical authority access requires direct named imports: ' + relativePath)
    for (const element of bindings.elements) {
      const importedName = (element.propertyName ?? element.name).text
      assert(exported.has(importedName), 'unauthorized canonical authority capability import: ' + relativePath + '#' + importedName)
      if (capabilities.has(importedName)) importedCapabilities.add(importedName)
    }
  }
  return { allowedRawRanges, importedCapabilities }
}

function qualifierKind(edge) {
  if (edge.has_search && edge.has_hash) return 'query+fragment'
  if (edge.has_search) return 'query'
  if (edge.has_hash) return 'fragment'
  return null
}

function assertNoRawAuthorityBypass(relativePath, sourceText, allowedRawRanges) {
  if (relativePath === OWNERSHIP_VALIDATOR_PATH) return
  const protectedTokens = new Set(AUTHORITY_CAPABILITY_CONTRACT.flatMap(({ artifact_path: artifactPath }) => [artifactPath, path.posix.basename(artifactPath)]))
  for (const token of protectedTokens) {
    let offset = sourceText.indexOf(token)
    while (offset >= 0) {
      const allowed = allowedRawRanges.some(([start, end]) => offset >= start && offset + token.length <= end)
      assert(allowed, 'forbidden raw executable ownership authority identity: ' + relativePath)
      offset = sourceText.indexOf(token, offset + 1)
    }
  }
}

export function discoverExecutablePathOwnershipConsumers(repositoryRoot, declaration = null) {
  assert(ts.version === '5.9.3', 'structural authority parser version mismatch: ' + ts.version)
  const value = declaration ?? JSON.parse(readFileSync(path.join(repositoryRoot, CURRENT_DEPENDENCY_PATH), 'utf8'))
  const { accessModulePath, capabilities, nonAuthorityExports } = validateAuthorityAccessDeclaration(value)
  const relativePaths = repositoryTrackedJavaScriptSources(repositoryRoot)
  const trackedPaths = new Set(relativePaths)
  assert(relativePaths.includes(accessModulePath), 'canonical authority access module missing: ' + accessModulePath)
  const sources = parseTrackedSources(repositoryRoot, relativePaths)
  const exported = exportedNames(sources.get(accessModulePath).sourceFile)
  assertNoRawAuthorityExports(sources.get(accessModulePath).sourceFile, sources.get(accessModulePath).sourceText)
  for (const capability of capabilities.keys()) assert(exported.has(capability), 'canonical authority capability export missing: ' + capability)
  const declaredExports = new Set([...capabilities.keys(), ...nonAuthorityExports])
  const undeclaredExports = [...exported].filter((exportName) => !declaredExports.has(exportName))
  const missingExports = [...declaredExports].filter((exportName) => !exported.has(exportName))
  assert(undeclaredExports.length === 0, 'canonical authority module undeclared exports: ' + undeclaredExports.join(', '))
  assert(missingExports.length === 0, 'canonical authority module declared exports missing: ' + missingExports.join(', '))
  const consumers = []
  const moduleEdges = []
  for (const relativePath of relativePaths) {
    const { sourceFile, sourceText } = sources.get(relativePath)
    const currentModuleEdges = sourceModuleEdges(sourceFile, repositoryRoot, relativePath, trackedPaths)
    for (const edge of currentModuleEdges) {
      const qualifier = edge.target === accessModulePath ? qualifierKind(edge) : null
      assert(!qualifier, 'qualified canonical authority module edge forbidden: ' + relativePath + '#' + edge.kind + '#' + qualifier)
      assert(edge.target !== accessModulePath || edge.kind === 'static_import', 'canonical authority access requires a static direct import: ' + relativePath)
    }
    const { allowedRawRanges, importedCapabilities } = sourceImports(
      sourceFile, relativePath, accessModulePath, exported, capabilities, currentModuleEdges,
    )
    assertNoRawAuthorityBypass(relativePath, sourceText, allowedRawRanges)
    moduleEdges.push(...currentModuleEdges)
    if (relativePath !== accessModulePath && importedCapabilities.size > 0) {
      const exportKinds = moduleExportKinds(sourceFile)
      assert(exportKinds.length === 0, 'authority consumer has module export: ' + relativePath + '#' + exportKinds.join(','))
      consumers.push({ path: relativePath, capabilities: [...importedCapabilities].sort(), terminal_leaf: true })
    }
  }
  const consumerPaths = new Set(consumers.map(({ path: consumerPath }) => consumerPath))
  for (const edge of moduleEdges) {
    if (consumerPaths.has(edge.target) && edge.source !== edge.target) {
      const qualifier = qualifierKind(edge)
      assert(!qualifier, 'qualified authority terminal consumer inbound edge forbidden: ' + edge.target + '<-' + edge.source + '#' + edge.kind + '#' + qualifier)
      throw new Error('authority terminal consumer has inbound tracked module edge: ' + edge.target + '<-' + edge.source + '#' + edge.kind)
    }
  }
  return consumers
}

export function validateExecutablePathOwnershipConsumerClosure(value, repositoryRoot = root) {
  const { capabilities } = validateAuthorityAccessDeclaration(value)
  const declared = value?.current_live?.consumers
  assert(Array.isArray(declared) && declared.length > 0, 'executable ownership current consumers missing')
  const roles = new Set()
  const declaredByPath = new Map()
  for (const consumer of declared) {
    assert(consumer && typeof consumer.role === 'string' && consumer.role.length > 0
      && typeof consumer.path === 'string' && consumer.path.length > 0
      && Array.isArray(consumer.capabilities) && consumer.capabilities.length > 0
      && consumer.terminal_leaf === true,
    'executable ownership current consumer declaration malformed')
    assert(!roles.has(consumer.role), 'executable ownership current consumer role duplicated: ' + consumer.role)
    assert(!declaredByPath.has(consumer.path), 'executable ownership current consumer path duplicated: ' + consumer.path)
    assert(new Set(consumer.capabilities).size === consumer.capabilities.length
      && consumer.capabilities.every((capability) => capabilities.has(capability)), 'executable ownership consumer capability declaration malformed: ' + consumer.path)
    roles.add(consumer.role)
    declaredByPath.set(consumer.path, [...consumer.capabilities].sort())
  }
  const discovered = discoverExecutablePathOwnershipConsumers(repositoryRoot, value)
  const discoveredByPath = new Map(discovered.map((consumer) => [consumer.path, consumer.capabilities]))
  const undeclared = discovered.filter((consumer) => !declaredByPath.has(consumer.path)).map((consumer) => consumer.path)
  const stale = [...declaredByPath.keys()].filter((consumerPath) => !discoveredByPath.has(consumerPath))
  assert(undeclared.length === 0, 'executable ownership undeclared current consumers: ' + undeclared.join(', '))
  assert(stale.length === 0, 'executable ownership stale declared consumers: ' + stale.join(', '))
  for (const [consumerPath, declaredCapabilities] of declaredByPath) {
    assert(JSON.stringify(declaredCapabilities) === JSON.stringify(discoveredByPath.get(consumerPath)), 'executable ownership consumer capability imports drift: ' + consumerPath)
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
  const [registry, coverageInput, index] = await Promise.all([
    readFile(path.join(root, REGISTRY_PATH), 'utf8').then(JSON.parse),
    readCurrentOwnershipCoverage(root),
    readFile(path.join(root, 'architecture/contexts/v1/context-index.json'), 'utf8').then(JSON.parse),
  ])
  const dependencyInput = await readCurrentOwnershipDependencies(root)
  validateExecutablePathOwnershipDependencies(dependencyInput.value, { contextIndex: index, repositoryRoot: root })
  assert(byteDigest(dependencyInput.bytes) === index.outputs.executable_path_ownership_current_dependencies.sha256, 'executable ownership current dependency index hash drift')
  const coverage = coverageInput.value
  const manifests = await Promise.all(index.contexts.map(async (entry) => JSON.parse(await readFile(path.join(root, entry.path), 'utf8'))))
  const inventory = await inventoryTrackedSurfaces(root, { registry })
  if (materializing) {
    const decisionArgument = option('--reviewed-decisions')
    assert(decisionArgument, 'explicit --reviewed-decisions <registry.json> input is required for materialization')
    const decisionPath = path.resolve(root, decisionArgument)
    const decisionRegistryPath = repositoryRelative(decisionPath)
    assert(decisionRegistryPath === REVIEWED_DECISION_PATH, `materialization requires authoritative reviewed decisions at ${REVIEWED_DECISION_PATH}`)
    const { bytes: decisionBytes, value: decisions } = await readReviewedOwnershipDecisions(root)
    assert(typeof decisions.baseline?.coverage_path === 'string' && decisions.baseline.coverage_path.length > 0, 'reviewed executable ownership baseline path missing')
    const baselinePath = path.resolve(root, decisions.baseline.coverage_path)
    const baselineCoveragePath = repositoryRelative(baselinePath)
    assert(baselineCoveragePath === REVIEWED_BASELINE_PATH, `materialization requires authoritative baseline at ${REVIEWED_BASELINE_PATH}`)
    const { bytes: baselineBytes, value: baselineCoverage } = await readHistoricalOwnershipBaseline(root)
    assert(byteDigest(baselineBytes) === REVIEWED_BASELINE_SHA256, 'reviewed executable ownership baseline trust anchor mismatch')
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
