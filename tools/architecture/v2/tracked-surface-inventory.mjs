#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

export const TRACKED_EXECUTABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.sql', '.sh', '.py', '.ps1', '.bat',
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
  if (override.lifecycle === 'OPERATIONAL_SCRIPT' && override.disposition !== 'UNREVIEWED') {
    if (typeof override.owner_context !== 'string' || override.owner_context.length === 0) {
      throw new Error(`classified operational surface must declare owner_context: ${file}`)
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

export function classifyTrackedSurface(file, registry = null) {
  const normalized = slash(file).replace(/^\.\//, '')
  const extension = path.posix.extname(normalized).toLowerCase()
  if (!TRACKED_EXECUTABLE_EXTENSIONS.has(extension)) return null

  const override = exactRegistryEntries(registry).get(normalized)
  if (override) validateOverride(normalized, override)
  const lifecycle = override?.lifecycle ?? inferredLifecycle(normalized)
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
    owner_context: override?.owner_context ?? null,
    production_capability: override?.production_capability ?? (lifecycle === 'APPLICATION_RUNTIME' ? 'POSSIBLE' : 'UNKNOWN'),
    rationale: override?.rationale ?? null,
    migration_target: override?.migration_target ?? null,
    registry_classified: Boolean(override),
  }
}

async function gitTrackedFiles(repositoryRoot) {
  const { stdout } = await execFileAsync('git', ['-C', repositoryRoot, 'ls-files', '-z'], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout.toString('utf8').split('\0').filter(Boolean)
}

async function gitDeletedFiles(repositoryRoot) {
  const { stdout } = await execFileAsync('git', ['-C', repositoryRoot, 'ls-files', '--deleted', '-z'], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout.toString('utf8').split('\0').filter(Boolean)
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
  const trackedFiles = (options.trackedFiles ?? await gitTrackedFiles(repositoryRoot)).filter((file) => !deletedSet.has(file))
  const surfaces = trackedFiles
    .map((file) => classifyTrackedSurface(file, registry))
    .filter(Boolean)
    .sort((left, right) => left.path.localeCompare(right.path))

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
