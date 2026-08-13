#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  analyzeCredentialAccess,
  analyzeCredentialSqlAccess,
  CREDENTIAL_ENTITY_POLICIES,
  parsePrismaModelNames,
  parsePrismaRelations,
} from './credential-analyzer.mjs'
import { mixedDatabaseCommandSinks, mixedSqlFragments } from './analyze.mjs'
import { inventoryTrackedSurfaces } from './tracked-surface-inventory.mjs'

const JS_FAMILY = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const MIXED_SCRIPT = new Set(['.sh', '.py', '.ps1', '.bat', '.yml', '.yaml', '.dockerfile', '.package-json'])
const execFileAsync = promisify(execFile)

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}

function decodeSource(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.alloc(bytes.length - 2)
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1]
      swapped[index - 1] = bytes[index]
    }
    return swapped.toString('utf16le')
  }
  const sampleLength = Math.min(bytes.length, 4096)
  let oddNulls = 0
  let evenNulls = 0
  for (let index = 0; index < sampleLength; index += 1) {
    if (bytes[index] === 0) {
      if (index % 2 === 0) evenNulls += 1
      else oddNulls += 1
    }
  }
  if (sampleLength > 8 && oddNulls > sampleLength / 5 && evenNulls < sampleLength / 20) {
    return bytes.toString('utf16le')
  }
  return bytes.toString('utf8')
}

async function loadJson(repositoryRoot, relative) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relative), 'utf8'))
}

async function repositoryGitIdentity(repositoryRoot) {
  const run = async (args) => {
    try {
      const { stdout } = await execFileAsync('git', ['-C', repositoryRoot, ...args], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      })
      return stdout.trim()
    } catch {
      return null
    }
  }
  const [commit, tree, status] = await Promise.all([
    run(['rev-parse', 'HEAD']),
    run(['rev-parse', 'HEAD^{tree}']),
    run(['status', '--porcelain=v1', '--untracked-files=no']),
  ])
  return {
    git_commit: commit,
    git_tree: tree,
    tracked_worktree_clean: status === '',
    tracked_worktree_status_sha256: status === null ? null : sha256(`${status}\n`),
  }
}

async function credentialSchemaMetadata(repositoryRoot) {
  const schemas = {
    gravity: 'gravity-mvp/prisma/schema.prisma',
    telegram: 'tg-bot/prisma/schema.prisma',
    yfs: 'yandex-fleet-scraper/prisma/schema.prisma',
  }
  const maps = new Map()
  const knownModels = new Set()
  for (const [key, relative] of Object.entries(schemas)) {
    try {
      const schema = await readFile(path.join(repositoryRoot, relative), 'utf8')
      maps.set(key, parsePrismaRelations(schema))
      for (const model of parsePrismaModelNames(schema)) knownModels.add(model)
    } catch {
      maps.set(key, new Map())
    }
  }
  return { knownModels: [...knownModels].sort(), maps }
}

function relationMapForSurface(surface, maps) {
  if (surface.path.startsWith('tg-bot/')) return maps.get('telegram')
  if (surface.path.startsWith('yandex-fleet-scraper/')) return maps.get('yfs')
  return maps.get('gravity')
}

async function sourceContextResolver(repositoryRoot) {
  const moduleRules = await loadJson(repositoryRoot, 'architecture/evidence/v1/module-rules.json')
  const contextIndex = await loadJson(repositoryRoot, 'architecture/contexts/v1/context-index.json')
  const manifests = await Promise.all(contextIndex.contexts.map((entry) => loadJson(repositoryRoot, entry.path)))
  const contextIds = new Set(manifests.map((manifest) => manifest.context.id))
  const technicalToContext = new Map()
  for (const manifest of manifests) {
    for (const technicalModule of manifest.technical_modules ?? []) {
      technicalToContext.set(technicalModule, manifest.context.id)
    }
  }
  const compiled = moduleRules.modules.map((rule) => ({ ...rule, regex: new RegExp(rule.match) }))
  return (surface) => {
    if (surface.owner_context) {
      return { context: surface.owner_context, technical_module: null, source: 'surface_registry' }
    }
    const modulePath = /^gravity-mvp\/src\/modules\/([^/]+)\//u.exec(surface.path)
    if (modulePath) {
      const context = modulePath[1].replaceAll('-', '_')
      if (contextIds.has(context)) {
        return { context, technical_module: `${context}.module`, source: 'bounded_module_path' }
      }
    }
    const rule = compiled.find((candidate) => candidate.regex.test(surface.path))
    if (!rule) return { context: null, technical_module: null, source: 'unclassified' }
    return {
      context: technicalToContext.get(rule.id) ?? rule.context ?? null,
      technical_module: rule.id,
      source: 'module_rules',
    }
  }
}

function classifyAccess(access, surface, source) {
  if (surface.lifecycle === 'TEST' || surface.lifecycle === 'FIXTURE') return 'TEST'
  if (surface.lifecycle === 'MIGRATION' || surface.disposition === 'MIGRATION_ONLY') return 'MIGRATION_ONLY'
  if (surface.lifecycle === 'DEAD_HISTORICAL' || surface.disposition === 'DEAD_HISTORICAL') return 'HISTORICAL_DEAD'
  if (!access.owner_context || !source.context) return 'UNCLASSIFIED'
  return access.owner_context === source.context ? 'OWNER_DIRECT_DB_ACCESS' : 'FOREIGN_DIRECT_DB_ACCESS'
}

function lineForIndex(text, index) {
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) if (text.charCodeAt(cursor) === 10) line += 1
  return line
}

function locationForIndex(text, index) {
  const lineStart = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1
  return { line: lineForIndex(text, index), column: index - lineStart + 1 }
}

export function mixedCredentialSqlFragments(text) {
  return mixedSqlFragments(text)
}

function summarize(accesses, inventory, parseFindings) {
  const count = (predicate) => accesses.filter(predicate).length
  return {
    tracked_executable_surfaces: inventory.summary.tracked_executable_surfaces,
    unreviewed_operational_surfaces: inventory.summary.unreviewed_operational_surfaces,
    credential_database_accesses: accesses.length,
    credential_reads: count((entry) => entry.access === 'READ'),
    credential_record_writes: count((entry) => entry.access === 'WRITE'),
    unresolved_database_accesses: count((entry) => entry.access === 'UNKNOWN'),
    owner_direct_accesses: count((entry) => entry.context_classification === 'OWNER_DIRECT_DB_ACCESS'),
    foreign_direct_accesses: count((entry) => entry.context_classification === 'FOREIGN_DIRECT_DB_ACCESS'),
    unclassified_accesses: count((entry) => entry.context_classification === 'UNCLASSIFIED'),
    migration_only_accesses: count((entry) => entry.context_classification === 'MIGRATION_ONLY'),
    historical_dead_accesses: count((entry) => entry.context_classification === 'HISTORICAL_DEAD'),
    test_accesses: count((entry) => entry.context_classification === 'TEST'),
    secret_reads: count((entry) => entry.credential_exposure === 'SECRET_READ'),
    metadata_only_reads: count((entry) => entry.credential_exposure === 'METADATA_ONLY'),
    ambiguous_credential_accesses: count((entry) => entry.credential_exposure === 'AMBIGUOUS'),
    possible_public_secret_risks: count((entry) => entry.public_secret_risk),
    parse_findings: parseFindings.length,
  }
}

export async function inventoryCredentialAccess(repositoryRoot, options = {}) {
  const registry = options.registry ?? null
  const [inventory, gitIdentity, schemaMetadata] = await Promise.all([
    inventoryTrackedSurfaces(repositoryRoot, { registry }),
    repositoryGitIdentity(repositoryRoot),
    credentialSchemaMetadata(repositoryRoot),
  ])
  const resolveSource = await sourceContextResolver(repositoryRoot)
  const accesses = []
  const parseFindings = []

  for (const surface of inventory.surfaces) {
    const sourceText = decodeSource(await readFile(path.join(repositoryRoot, surface.path)))
    const sourceSha256 = sha256(sourceText)
    const source = resolveSource(surface)
    let discovered = []
    let diagnostics = []
    if (JS_FAMILY.has(surface.extension)) {
      const document = analyzeCredentialAccess(sourceText, {
        fileName: surface.path,
        knownModels: schemaMetadata.knownModels,
        relationMap: relationMapForSurface(surface, schemaMetadata.maps),
      })
      discovered = document.accesses
      diagnostics = document.diagnostics
    } else if (surface.extension === '.sql') {
      discovered = analyzeCredentialSqlAccess(sourceText, { fileName: surface.path }).accesses
    } else if (MIXED_SCRIPT.has(surface.extension)) {
      const fragments = mixedCredentialSqlFragments(sourceText)
      discovered = fragments.flatMap((fragment, ordinal) => {
        const location = locationForIndex(sourceText, fragment.index)
        return analyzeCredentialSqlAccess(fragment.sql, {
          fileName: surface.path,
          line: location.line,
          column: location.column,
          scope: '<mixed-operational-script>',
          method: `mixed-script-sql:${fragment.source}`,
          forceDynamic: true,
          ordinal,
        }).accesses
      })
      const commandSinks = mixedDatabaseCommandSinks(sourceText, { staticFragments: fragments })
      const commandAccesses = commandSinks.flatMap((sink, ordinal) => analyzeCredentialSqlAccess(null, {
          fileName: surface.path,
          line: sink.line,
          column: sink.column,
          scope: '<mixed-operational-script>',
          method: `dynamic-mixed-database-${sink.intent.toLowerCase()}:${sink.command}`,
          forceDynamic: true,
          ordinal: fragments.length + ordinal,
        }).accesses.map((access) => ({
          ...access,
          database_command_intent: sink.intent,
        })))
      discovered.push(...commandAccesses)
    }
    for (const access of discovered) {
      accesses.push({
        ...access,
        source_sha256: sourceSha256,
        context_classification: classifyAccess(access, surface, source),
        source_context: source.context,
        source_technical_module: source.technical_module,
        source_identity: source.source,
        surface: {
          lifecycle: surface.lifecycle,
          disposition: surface.disposition,
          production_capability: surface.production_capability,
          functional_owner: surface.functional_owner,
          registered_source_sha256: surface.registered_source_sha256,
          registry_classified: surface.registry_classified,
        },
      })
    }
    for (const diagnostic of diagnostics) {
      parseFindings.push({ file: surface.path, ...diagnostic })
    }
  }

  accesses.sort((left, right) => (
    left.file.localeCompare(right.file)
    || left.line - right.line
    || left.column - right.column
    || String(left.policy_id).localeCompare(String(right.policy_id))
    || left.access.localeCompare(right.access)
  ))
  parseFindings.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
  const result = {
    schema: 'yoko.crm.whole-repository-credential-database-access.v2',
    source: {
      repository_root: '.',
      git_tracked_only: true,
      inventory_schema: inventory.schema,
      ...gitIdentity,
    },
    safety: 'structural access metadata and credential field names only; values and source excerpts are never emitted',
    policies: CREDENTIAL_ENTITY_POLICIES.map((policy) => ({
      id: policy.id,
      entity: policy.entity,
      owner_context: policy.owner_context,
      sensitive_field_names: [...policy.sensitive_fields].sort(),
    })),
    summary: null,
    inventory_controls: inventory.controls,
    parse_findings: parseFindings,
    accesses,
  }
  result.summary = summarize(accesses, inventory, parseFindings)
  result.analysis_sha256 = sha256(`${JSON.stringify(stable(result))}\n`)
  return result
}

async function main() {
  const modulePath = fileURLToPath(import.meta.url)
  const defaultRoot = path.resolve(path.dirname(modulePath), '../../..')
  const args = process.argv.slice(2)
  let repositoryRoot = defaultRoot
  let registry = null
  let output = null
  let strict = false
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root') repositoryRoot = path.resolve(args[++index])
    else if (args[index] === '--surface-registry') registry = JSON.parse(await readFile(path.resolve(args[++index]), 'utf8'))
    else if (args[index] === '--output') output = path.resolve(args[++index])
    else if (args[index] === '--strict') strict = true
    else throw new Error(`unknown argument: ${args[index]}`)
  }
  const result = await inventoryCredentialAccess(repositoryRoot, { registry })
  const serialized = `${JSON.stringify(stable(result), null, 2)}\n`
  if (output) await writeFile(output, serialized)
  else process.stdout.write(serialized)
  if (strict && (result.summary.parse_findings > 0 || result.summary.unresolved_database_accesses > 0)) {
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  })
}
