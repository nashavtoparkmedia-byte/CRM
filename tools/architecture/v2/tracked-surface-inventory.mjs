#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

export const TRACKED_EXECUTABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.sql', '.sh', '.py', '.ps1', '.bat',
  '.yml', '.yaml', '.prisma', '.dockerfile',
  '.package-json',
  // A Git executable bit is itself an executable-surface declaration.  The
  // synthetic extension keeps extensionless package hooks and executable
  // templates in the same deterministic inventory without pretending that
  // their filename has a language extension.
  '.git-executable',
  '.shebang-source',
])

export const SURFACE_LIFECYCLES = new Set([
  'APPLICATION_RUNTIME',
  'OPERATIONAL_SCRIPT',
  'MIGRATION',
  'TEST',
  'GENERATED',
  'FIXTURE',
  'DEAD_HISTORICAL',
])

export const OPERATIONAL_DISPOSITIONS = new Set([
  'ACTIVE',
  'MIGRATION_ONLY',
  'DEAD_HISTORICAL',
  'UNSAFE_LEGACY',
  'UNREVIEWED',
])

const MAINTENANCE_LIFECYCLES = new Set(['CLEANUP', 'RECOVERY'])
const MIGRATION_TARGET_KINDS = new Set(['DATABASE', 'MODEL', 'SCHEMA', 'TABLE'])
const CONFIRMED_PRODUCTION_REACHABILITY = new Set([
  'CONFIRMED_AUTOMATIC_DEPLOYMENT',
  'CONFIRMED_MANUAL_BASELINE',
  'CONFIRMED_MANUAL_DATA_MIGRATION',
  'CONFIRMED_MANUAL_DEPLOYMENT',
  'CONFIRMED_MANUAL_OPERATOR',
  'CONFIRMED_MANUAL_RESTORE',
])
const SHA256 = /^[a-f0-9]{64}$/u

function slash(value) {
  return value.split(path.sep).join('/')
}

function exactRegistryEntries(registry) {
  const entries = registry?.surfaces ?? []
  if (Array.isArray(entries)) {
    const result = new Map()
    for (const entry of entries) {
      if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) throw new Error('registry surface path is required')
      if (result.has(entry.path)) throw new Error(`duplicate registry surface path: ${entry.path}`)
      result.set(entry.path, entry)
    }
    return result
  }
  return new Map(Object.entries(entries).map(([entryPath, entry]) => [entryPath, { path: entryPath, ...entry }]))
}

function inferredLifecycle(file) {
  const lower = `/${file.toLowerCase()}`
  const basename = path.posix.basename(lower)
  const insideRuntimeTree = lower.includes('/src/') || lower.includes('/app/') || lower.includes('/pages/')
  const pathParts = file.toLowerCase().split('/')
  const extension = path.posix.extname(lower)
  const dockerfile = /(?:^|\/)dockerfile(?:\.[^/]*)?$/iu.test(file)
  const packageJson = basename === 'package.json'
  const packageRootTool = pathParts.length === 2 && new Set([
    'gravity-mvp', 'tg-bot', 'yandex-fleet-scraper',
  ]).has(pathParts[0]) && !(pathParts[0] === 'tg-bot' && basename === 'start.js')
  const exactMaxRootTool = pathParts.length === 2
    && pathParts[0] === 'max-web-scraper'
    && new Set(['parse.js', 'parse2.js', 'restart-graceful.js']).has(basename)
  if (
    lower.includes('/__tests__/')
    || lower.includes('/test/')
    || lower.includes('/tests/')
    || /^test(?:\d+|\.[^.]+$)/.test(basename)
    || /^test[_-].+\.[^.]+$/.test(basename)
    || /[_-]test\.[^.]+$/.test(basename)
    || /(?:^|\.)test\.[^.]+$/.test(basename)
    || /(?:^|\.)spec\.[^.]+$/.test(basename)
  ) return 'TEST'
  if (lower.includes('/fixtures/') || lower.includes('/fixture/') || /^gen-test[-_.]/.test(basename)) return 'FIXTURE'
  if (
    lower.includes('/generated/')
    || lower.includes('/.next/')
    || lower.includes('/dist/')
    || lower.includes('/build/')
    || basename === 'next-env.d.ts'
    || basename.endsWith('.generated.ts')
    || basename.endsWith('.generated.js')
  ) return 'GENERATED'
  if (lower.includes('/prisma/migrations/')) return 'MIGRATION'
  if (extension === '.prisma') return 'MIGRATION'
  if (
    lower.includes('/scripts/')
    || lower.startsWith('/scripts/')
    || lower.startsWith('/tools/architecture/')
    || lower.startsWith('/deploy/')
    || packageRootTool
    || exactMaxRootTool
    || lower.includes('/maintenance/')
    || (!insideRuntimeTree && /^(?:check|debug|diagnose|dump|fix|inspect|probe|run)(?:[-_.]|$)/.test(basename))
    || (!insideRuntimeTree && /(?:^|[-_.])(backfill|cleanup|repair|seed|import|export|reconcile|migrate|migration|sync)(?:[-_.]|$)/.test(basename))
    || (!insideRuntimeTree && /(?:^|\.)(?:config|setup)\.[cm]?[jt]s$/.test(basename))
    || path.posix.extname(lower) === '.sql'
    || path.posix.extname(lower) === '.sh'
    || path.posix.extname(lower) === '.ps1'
    || path.posix.extname(lower) === '.bat'
    || extension === '.yml'
    || extension === '.yaml'
    || dockerfile
    || packageJson
  ) return 'OPERATIONAL_SCRIPT'
  if (
    lower.includes('/migrations/')
    || /(?:^|[-_.])migrat(?:e|ion)/.test(basename)
  ) return 'MIGRATION'
  return 'APPLICATION_RUNTIME'
}

function validateOverride(file, override) {
  if (!SURFACE_LIFECYCLES.has(override.lifecycle)) {
    throw new Error(`invalid lifecycle for ${file}: ${String(override.lifecycle)}`)
  }
  if (
    override.lifecycle === 'OPERATIONAL_SCRIPT'
    && !OPERATIONAL_DISPOSITIONS.has(override.disposition)
  ) throw new Error(`invalid operational disposition for ${file}: ${String(override.disposition)}`)
  if (override.lifecycle === 'DEAD_HISTORICAL' && override.disposition !== 'DEAD_HISTORICAL') {
    throw new Error(`dead historical surface must use DEAD_HISTORICAL disposition: ${file}`)
  }
  if (override.lifecycle === 'DEAD_HISTORICAL') {
    if (!SHA256.test(override.source_sha256 ?? '')) throw new Error(`dead historical surface lacks exact source hash: ${file}`)
    if (override.production_capability !== 'NONE') throw new Error(`dead historical surface must have NONE production capability: ${file}`)
    if (typeof override.functional_owner !== 'string' || override.functional_owner.length === 0) {
      throw new Error(`dead historical surface lacks an independent functional owner: ${file}`)
    }
    if (
      typeof override.classification_artifact !== 'string'
      || override.classification_artifact.length === 0
      || override.classification_artifact === file
    ) throw new Error(`dead historical surface lacks an independent classification artifact: ${file}`)
    if (typeof override.rationale !== 'string' || override.rationale.length === 0) {
      throw new Error(`dead historical surface lacks exact review rationale: ${file}`)
    }
  }
  if (override.maintenance_lifecycle !== undefined) {
    if (override.lifecycle !== 'OPERATIONAL_SCRIPT' || !MAINTENANCE_LIFECYCLES.has(override.maintenance_lifecycle)) {
      throw new Error(`invalid exact maintenance lifecycle for ${file}: ${String(override.maintenance_lifecycle)}`)
    }
    if (!CONFIRMED_PRODUCTION_REACHABILITY.has(override.production_capability)) {
      throw new Error(`exact maintenance lifecycle lacks enumerated production reachability: ${file}`)
    }
  }
  if (override.migration_authority !== undefined) {
    const authority = override.migration_authority
    if (
      override.lifecycle !== 'MIGRATION'
      || typeof authority?.data_owner !== 'string'
      || authority.data_owner.length === 0
      || !MIGRATION_TARGET_KINDS.has(authority?.target_kind)
      || typeof authority?.exact_name !== 'string'
      || authority.exact_name.length === 0
      || typeof authority?.operation !== 'string'
      || !authority.operation.startsWith('mixed-script-command:')
    ) throw new Error(`invalid exact migration authority for ${file}`)
    if (!CONFIRMED_PRODUCTION_REACHABILITY.has(override.production_capability)) {
      throw new Error(`exact migration authority lacks enumerated production reachability: ${file}`)
    }
  }
  if (override.lifecycle === 'OPERATIONAL_SCRIPT' && override.disposition !== 'UNREVIEWED') {
    if (
      (typeof override.functional_owner !== 'string' || override.functional_owner.length === 0)
      && (typeof override.owner_context !== 'string' || override.owner_context.length === 0)
    ) {
      throw new Error(`classified operational surface must declare functional_owner: ${file}`)
    }
    if (typeof override.rationale !== 'string' || override.rationale.length === 0) {
      throw new Error(`classified operational surface must declare rationale: ${file}`)
    }
    if (
      typeof override.production_capability !== 'string'
      || override.production_capability.length === 0
      || override.production_capability === 'UNKNOWN'
    ) throw new Error(`classified operational surface must declare production_capability: ${file}`)
  }
}

export function classifyTrackedSurface(file, registry = null, options = {}) {
  const normalized = slash(file).replace(/^\.\//, '')
  const namedExtension = /(?:^|\/)dockerfile(?:\.[^/]*)?$/iu.test(normalized)
    ? '.dockerfile'
    : path.posix.basename(normalized).toLowerCase() === 'package.json'
      ? '.package-json'
      : path.posix.extname(normalized).toLowerCase()
  const lowerName = path.posix.basename(normalized).toLowerCase()
  const compoundTemplateExtension = [...TRACKED_EXECUTABLE_EXTENSIONS]
    .filter((candidate) => !['.dockerfile', '.package-json', '.git-executable', '.shebang-source'].includes(candidate))
    .find((candidate) => lowerName.endsWith(`${candidate}.in`) || lowerName.endsWith(`${candidate}.template`)) ?? null
  const gitExecutableFallback = options.gitMode === '100755'
    && !TRACKED_EXECUTABLE_EXTENSIONS.has(namedExtension)
  const shebangFallback = options.hasShebang === true
    && !gitExecutableFallback
    && !compoundTemplateExtension
    && !TRACKED_EXECUTABLE_EXTENSIONS.has(namedExtension)
  const extension = gitExecutableFallback
    ? '.git-executable'
    : compoundTemplateExtension ?? (shebangFallback ? '.shebang-source' : namedExtension)
  if (!TRACKED_EXECUTABLE_EXTENSIONS.has(extension)) return null

  const override = exactRegistryEntries(registry).get(normalized)
  if (override) validateOverride(normalized, override)
  const lifecycle = override?.lifecycle
    ?? (gitExecutableFallback || compoundTemplateExtension || shebangFallback ? 'OPERATIONAL_SCRIPT' : inferredLifecycle(normalized))
  const disposition = override?.disposition
    ?? (lifecycle === 'MIGRATION' ? 'MIGRATION_ONLY'
      : lifecycle === 'DEAD_HISTORICAL' ? 'DEAD_HISTORICAL'
        : lifecycle === 'OPERATIONAL_SCRIPT' ? 'UNREVIEWED'
          : null)
  return {
    path: normalized,
    extension,
    lifecycle,
    disposition,
    // Lifecycle metadata may name a functional owner for review/reporting,
    // but it must never become analyzer source ownership. Only an explicit
    // owner_context entry (used by narrowly controlled legacy fixtures) is
    // allowed to influence write classification.
    functional_owner: override?.functional_owner ?? null,
    owner_context: override?.owner_context ?? null,
    production_capability: override?.production_capability ?? (lifecycle === 'APPLICATION_RUNTIME' ? 'POSSIBLE' : 'UNKNOWN'),
    rationale: override?.rationale ?? null,
    migration_target: override?.migration_target ?? null,
    maintenance_lifecycle: override?.maintenance_lifecycle,
    migration_authority: override?.migration_authority,
    registered_source_sha256: override?.source_sha256 ?? null,
    registry_classified: Boolean(override),
    ...(gitExecutableFallback
      ? { executable_source: 'GIT_MODE_100755' }
      : compoundTemplateExtension
        ? { executable_source: 'COMPOUND_EXECUTABLE_TEMPLATE_SUFFIX' }
        : shebangFallback
          ? { executable_source: 'SHEBANG_SOURCE' }
          : {}),
  }
}

export function parseGitTrackedEntries(value) {
  const entries = Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
  const records = entries.split('\0').filter(Boolean).map((entry) => {
    const match = /^([0-7]{6}) [0-9a-f]+ ([0-3])\t([\s\S]+)$/u.exec(entry)
    if (!match) throw new Error('invalid git tracked-index record')
    if (match[2] !== '0') throw new Error(`unmerged git tracked-index record: ${match[3]}`)
    return { mode: match[1], path: match[3] }
  })
  const seen = new Set()
  for (const record of records) {
    if (seen.has(record.path)) throw new Error(`duplicate git tracked-index path: ${record.path}`)
    seen.add(record.path)
  }
  return records
}

async function gitTrackedEntries(repositoryRoot) {
  // Read the index with stage/mode metadata.  A name-only inventory cannot
  // distinguish executable extensionless hooks from ordinary documentation.
  const { stdout: indexed } = await execFileAsync('git', ['-C', repositoryRoot, 'ls-files', '-s', '-z'], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })
  return parseGitTrackedEntries(indexed)
}

async function gitDeletedFiles(repositoryRoot) {
  const { stdout } = await execFileAsync('git', ['-C', repositoryRoot, 'ls-files', '--deleted', '-z'], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout.toString('utf8').split('\0').filter(Boolean)
}

async function trackedFileHasShebang(repositoryRoot, relativePath) {
  let handle
  try {
    handle = await open(path.join(repositoryRoot, relativePath), 'r')
    const prefix = Buffer.alloc(2)
    const { bytesRead } = await handle.read(prefix, 0, 2, 0)
    return bytesRead === 2 && prefix[0] === 0x23 && prefix[1] === 0x21
  } catch {
    return false
  } finally {
    await handle?.close()
  }
}

function summarize(surfaces) {
  const byLifecycle = {}
  const byExtension = {}
  const operationalDisposition = {}
  for (const surface of surfaces) {
    byLifecycle[surface.lifecycle] = (byLifecycle[surface.lifecycle] ?? 0) + 1
    byExtension[surface.extension] = (byExtension[surface.extension] ?? 0) + 1
    if (surface.disposition) {
      operationalDisposition[surface.disposition] = (operationalDisposition[surface.disposition] ?? 0) + 1
    }
  }
  return {
    tracked_executable_surfaces: surfaces.length,
    by_lifecycle: Object.fromEntries(Object.entries(byLifecycle).sort()),
    by_extension: Object.fromEntries(Object.entries(byExtension).sort()),
    operational_dispositions: Object.fromEntries(Object.entries(operationalDisposition).sort()),
    unreviewed_operational_surfaces: surfaces.filter((surface) => surface.disposition === 'UNREVIEWED').length,
  }
}

export async function inventoryTrackedSurfaces(repositoryRoot, options = {}) {
  const registry = options.registry ?? null
  const workingTreeDeleted = options.trackedFiles ? [] : await gitDeletedFiles(repositoryRoot)
  const deletedSet = new Set(workingTreeDeleted)
  const injected = options.trackedFiles
  const trackedEntries = (injected ?? await gitTrackedEntries(repositoryRoot)).map((entry) => {
    if (typeof entry === 'string') return { mode: null, path: entry, hasShebang: null }
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) throw new Error('tracked-file injection path is required')
    if (entry.mode !== null && entry.mode !== undefined && !/^[0-7]{6}$/u.test(entry.mode)) throw new Error(`invalid tracked-file injection mode: ${entry.path}`)
    if (entry.hasShebang !== null && entry.hasShebang !== undefined && typeof entry.hasShebang !== 'boolean') throw new Error(`invalid tracked-file shebang declaration: ${entry.path}`)
    return { mode: entry.mode ?? null, path: entry.path, hasShebang: entry.hasShebang ?? null }
  }).filter((entry) => !deletedSet.has(entry.path))
  const surfaces = (await Promise.all(trackedEntries.map(async (entry) => {
    const initial = classifyTrackedSurface(entry.path, registry, { gitMode: entry.mode, hasShebang: entry.hasShebang === true })
    if (initial || entry.mode !== '100644' || entry.hasShebang === false) return initial
    const hasShebang = entry.hasShebang ?? await trackedFileHasShebang(repositoryRoot, entry.path)
    return classifyTrackedSurface(entry.path, registry, { gitMode: entry.mode, hasShebang })
  })))
    .filter(Boolean)
    .sort((left, right) => left.path.localeCompare(right.path))

  const providedHashes = options.sourceHashes instanceof Map
    ? options.sourceHashes
    : new Map(Object.entries(options.sourceHashes ?? {}))
  for (const surface of surfaces.filter((candidate) => candidate.registered_source_sha256 !== null)) {
    const actualSha256 = providedHashes.get(surface.path) ?? createHash('sha256')
      .update(await readFile(path.join(repositoryRoot, surface.path)))
      .digest('hex')
    if (actualSha256 !== surface.registered_source_sha256) {
      throw new Error(`registered lifecycle source hash drift: ${surface.path}`)
    }
  }

  const registered = exactRegistryEntries(registry)
  const trackedSet = new Set(surfaces.map((surface) => surface.path))
  const staleRegistryEntries = [...registered.keys()].filter((file) => !trackedSet.has(file)).sort()
  return {
    schema: 'yoko.crm.tracked-executable-surface-inventory.v2',
    // Evidence must be byte-reproducible from any immutable checkout path.
    // The actual root is an execution input, not source identity.
    repository_root: '.',
    controls: {
      extensions: [...TRACKED_EXECUTABLE_EXTENSIONS].sort(),
      exact_registry_only: true,
      duplicate_paths: [],
      stale_registry_entries: staleRegistryEntries,
      working_tree_deleted: workingTreeDeleted.sort(),
    },
    summary: summarize(surfaces),
    surfaces,
  }
}

async function main() {
  const modulePath = fileURLToPath(import.meta.url)
  const defaultRoot = path.resolve(path.dirname(modulePath), '../../..')
  const args = process.argv.slice(2)
  let repositoryRoot = defaultRoot
  let registry = null
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root') repositoryRoot = path.resolve(args[++index])
    else if (args[index] === '--registry') registry = JSON.parse(await readFile(path.resolve(args[++index]), 'utf8'))
    else throw new Error(`unknown argument: ${args[index]}`)
  }
  const inventory = await inventoryTrackedSurfaces(repositoryRoot, { registry })
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`)
  if (
    inventory.controls.duplicate_paths.length
    || inventory.controls.stale_registry_entries.length
    || inventory.summary.unreviewed_operational_surfaces > 0
  ) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  })
}
