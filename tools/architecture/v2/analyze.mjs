#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile, fork } from 'node:child_process'
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import ts from '../../../gravity-mvp/node_modules/typescript/lib/typescript.js'

import { analyzeSqlScript } from './sql-mutation-analyzer.mjs'
import { inventoryTrackedSurfaces } from './tracked-surface-inventory.mjs'
import { analyzePrismaWriteSites } from './write-analyzer.mjs'

const JS_FAMILY = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const MIXED_SCRIPT = new Set(['.sh', '.py', '.ps1', '.bat', '.yml', '.yaml', '.dockerfile', '.package-json'])
const execFileAsync = promisify(execFile)
const MAX_ISOLATED_WORKERS = 4
const DEFAULT_WORKER_TIMEOUT_MS = 120_000
const DEFAULT_PROGRESS_EVERY = 25
const jsWorkerPath = fileURLToPath(new URL('./analyze-js-worker.mjs', import.meta.url))

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`expected integer in ${minimum}..${maximum}, received ${value}`)
  }
  return parsed
}

export function isolatedExecutionOptions(options = {}) {
  const available = Math.max(1, availableParallelism())
  return {
    workers: boundedInteger(options.workers, Math.min(MAX_ISOLATED_WORKERS, available), 1, MAX_ISOLATED_WORKERS),
    workerTimeoutMs: boundedInteger(options.workerTimeoutMs, DEFAULT_WORKER_TIMEOUT_MS, 1_000, 600_000),
    progressEvery: boundedInteger(options.progressEvery, DEFAULT_PROGRESS_EVERY, 1, 10_000),
  }
}

function workerError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

export async function analyzeJavaScriptSurfaceIsolated(surface, sourceText, options = {}) {
  const workerTimeoutMs = boundedInteger(options.workerTimeoutMs, DEFAULT_WORKER_TIMEOUT_MS, 1_000, 600_000)
  return new Promise((resolve, reject) => {
    const startedAt = process.hrtime.bigint()
    const child = fork(jsWorkerPath, [], {
      silent: true,
      serialization: 'json',
      execArgv: process.execArgv.filter((argument) => !argument.startsWith('--input-type')),
    })
    const stderr = []
    child.stderr?.on('data', (chunk) => stderr.push(String(chunk)))
    let settled = false
    const elapsedMs = () => Number(process.hrtime.bigint() - startedAt) / 1_000_000
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback(value)
    }
    const timeout = setTimeout(() => {
      const durationMs = elapsedMs()
      child.kill('SIGKILL')
      finish(reject, workerError(
        'ANALYZER_WORKER_TIMEOUT',
        `isolated analyzer worker timed out after ${workerTimeoutMs}ms for ${surface.path}`,
        { file: surface.path, pid: child.pid, duration_ms: durationMs, timeout_ms: workerTimeoutMs },
      ))
    }, workerTimeoutMs)
    child.once('error', (error) => {
      finish(reject, workerError(
        'ANALYZER_WORKER_SPAWN_FAILURE',
        `isolated analyzer worker failed for ${surface.path}: ${error.message}`,
        { file: surface.path, pid: child.pid, duration_ms: elapsedMs() },
      ))
    })
    child.once('message', (message) => {
      if (!message?.ok) {
        finish(reject, workerError(
          'ANALYZER_WORKER_FAILURE',
          `isolated analyzer worker failed for ${surface.path}: ${message?.error ?? 'unknown error'}`,
          { file: surface.path, pid: child.pid, duration_ms: elapsedMs() },
        ))
        return
      }
      finish(resolve, {
        ...message,
        pid: child.pid,
        duration_ms: elapsedMs(),
      })
    })
    child.once('exit', (code, signal) => {
      if (!settled) finish(reject, workerError(
        'ANALYZER_WORKER_EXIT',
        `isolated analyzer worker exited before returning for ${surface.path} (code=${code}, signal=${signal}): ${stderr.join('').trim()}`,
        { file: surface.path, pid: child.pid, duration_ms: elapsedMs(), exit_code: code, signal },
      ))
    })
    options.onStarted?.(child.pid)
    child.send({
      task_id: options.taskId ?? null,
      file_name: surface.path,
      source_text: sourceText,
      known_models: options.knownModels ?? [],
      relation_fields: options.relationFields ?? [],
    })
  })
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}

async function loadJson(repositoryRoot, relative) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relative), 'utf8'))
}

async function loadOptionalJson(repositoryRoot, relative, fallback) {
  try { return await loadJson(repositoryRoot, relative) } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
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

function decodeSource(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: bytes.subarray(2).toString('utf16le'), encoding: 'utf16le-bom', ambiguous: false }
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.alloc(bytes.length - 2)
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1]
      swapped[index - 1] = bytes[index]
    }
    return { text: swapped.toString('utf16le'), encoding: 'utf16be-bom', ambiguous: false }
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
    return { text: bytes.toString('utf16le'), encoding: 'utf16le-inferred', ambiguous: true }
  }
  return { text: bytes.toString('utf8'), encoding: 'utf8', ambiguous: false }
}

export function compileArchitecture(
  moduleRules,
  manifests,
  ownershipRules,
  scopedOwnership = { rules: [] },
  options = {},
) {
  const effectiveManifests = manifests.map((manifest) => structuredClone(manifest))
  const manifestsByContext = new Map(effectiveManifests.map((manifest) => [manifest.context.id, manifest]))
  for (const bundle of options.manifestAmendments ?? []) {
    for (const amendment of bundle.amendments ?? []) {
      const manifest = manifestsByContext.get(amendment.context)
      if (!manifest) continue
      manifest.owned_infrastructure_state = [
        ...new Set([
          ...(manifest.owned_infrastructure_state ?? []),
          ...(amendment.add_owned_infrastructure_state ?? []),
        ]),
      ]
    }
  }
  const modules = moduleRules.modules.map((item) => ({ ...item, regex: new RegExp(item.match) }))
  const technicalToContext = new Map()
  for (const manifest of effectiveManifests) {
    for (const module of manifest.technical_modules ?? []) technicalToContext.set(module, manifest.context.id)
  }
  const modelOwners = new Map()
  for (const [model, technicalOwner] of Object.entries(ownershipRules.rules)) {
    modelOwners.set(model.toLowerCase(), {
      model,
      context: technicalToContext.get(technicalOwner) ?? technicalOwner,
      technical_owner: technicalOwner,
    })
  }
  for (const manifest of effectiveManifests) {
    for (const owned of manifest.owned_data ?? []) {
      // Context manifests are the reviewed ownership decision. Historical
      // technical ownership candidates seed the map above, but they must not
      // override a later explicit bounded-context assignment.
      modelOwners.set(owned.model.toLowerCase(), {
        model: owned.model,
        context: manifest.context.id,
        technical_owner: null,
      })
      if (owned.mapped_table) modelOwners.set(owned.mapped_table.toLowerCase(), modelOwners.get(owned.model.toLowerCase()))
    }
    for (const id of manifest.owned_infrastructure_state ?? []) {
      const model = id.split(':').at(-1)
      modelOwners.set(model.toLowerCase(), {
        model,
        context: manifest.context.id,
        technical_owner: null,
      })
    }
  }
  const scopedModelOwners = new Map()
  for (const rule of scopedOwnership.rules ?? []) {
    scopedModelOwners.set(`${rule.source}\0${rule.table.toLowerCase()}`, { model: rule.table, context: rule.owner_context, technical_owner: null, scoped_rule_id: rule.id, allowed_operations: new Set(rule.allowed_operations ?? []) })
  }
  const approvedInfrastructureWriters = new Set((options.approvedInfrastructureWriters ?? []).map((entry) => (
    `${entry.file}\0${entry.model.toLowerCase()}`
  )))
  return {
    contextIds: new Set(effectiveManifests.map((manifest) => manifest.context.id)),
    modelOwners,
    scopedModelOwners,
    approvedInfrastructureWriters,
    modules,
    technicalToContext,
  }
}

function sourceIdentity(surface, architecture) {
  if (surface.owner_context) return { context: surface.owner_context, technical_module: null, source: 'surface_registry' }
  const modulePath = /^gravity-mvp\/src\/modules\/([^/]+)\//u.exec(surface.path)
  if (modulePath) {
    const context = modulePath[1].replaceAll('-', '_')
    if (architecture.contextIds.has(context)) {
      return { context, technical_module: `${context}.module`, source: 'bounded_module_path' }
    }
  }
  const match = architecture.modules.find((item) => item.regex.test(surface.path))
  if (!match) return { context: null, technical_module: null, source: 'unclassified' }
  return {
    context: architecture.technicalToContext.get(match.id) ?? match.context ?? null,
    technical_module: match.id,
    source: 'module_rules',
  }
}

function targetIdentity(modelOrTable, architecture, sourcePath) {
  if (!modelOrTable) return null
  const normalized = modelOrTable.toLowerCase()
  const scoped = architecture.scopedModelOwners?.get(`${sourcePath}\0${normalized}`)
  if (scoped) return scoped
  const mapped = architecture.tableSymbols?.get(normalized) ?? normalized
  return architecture.modelOwners.get(mapped) ?? null
}

function lifecycleClassification(surface) {
  if (surface.lifecycle === 'TEST' || surface.lifecycle === 'FIXTURE') return 'TEST'
  if (surface.lifecycle === 'MIGRATION' || surface.disposition === 'MIGRATION_ONLY') return 'MIGRATION_ONLY'
  if (surface.lifecycle === 'DEAD_HISTORICAL' || surface.disposition === 'DEAD_HISTORICAL') return 'HISTORICAL_DEAD'
  return null
}

export function classifySite(site, surface, source, architecture) {
  const lifecycle = lifecycleClassification(surface)
  if (lifecycle) return { classification: lifecycle, owner_contexts: [], unresolved_targets: [] }
  const targets = site.kind === 'model' || site.kind === 'ambiguous_model' || site.kind === 'drizzle'
    ? [site.model, ...(site.candidate_models ?? [])].filter(Boolean)
    : (site.tables ?? [])
  const identities = targets.map((target) => (
    source.context && architecture.approvedInfrastructureWriters?.has(`${surface.path}\0${target.toLowerCase()}`)
      ? { model: target, context: source.context, technical_owner: null, approved_infrastructure_writer: true }
      : targetIdentity(target, architecture, surface.path)
  ))
  const unresolvedTargets = targets.filter((target, index) => !identities[index])
  const ownerContexts = [...new Set(identities.filter(Boolean).map((item) => item.context))].sort()
  const siteOperations = new Set((site.operations ?? []).map((item) => item.operation).filter(Boolean))
  const disallowedScopedOperation = identities.some((identity) => identity?.scoped_rule_id
    && identity.context === source.context
    && [...siteOperations].some((operation) => !identity.allowed_operations.has(operation)))
  if (
    site.ambiguous
    || disallowedScopedOperation
    || !source.context
    || targets.length === 0
    || unresolvedTargets.length > 0
    || ownerContexts.length !== 1
  ) return { classification: 'AMBIGUOUS', owner_contexts: ownerContexts, unresolved_targets: [...unresolvedTargets, ...(disallowedScopedOperation ? ['scoped_operation_not_allowed'] : [])] }
  return {
    classification: ownerContexts[0] === source.context ? 'OWNER' : 'FOREIGN',
    owner_contexts: ownerContexts,
    unresolved_targets: [],
  }
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

function prismaRelationFieldKeys(schemaSource) {
  const models = new Map()
  for (const match of schemaSource.matchAll(/^model\s+([A-Za-z_][\w]*)\s*\{([\s\S]*?)^\}/gmu)) {
    models.set(match[1], match[2])
  }
  const modelNames = new Set(models.keys())
  const keys = []
  for (const [model, body] of models) for (const line of body.split('\n')) {
    const field = /^\s*([A-Za-z_][\w]*)\s+([A-Za-z_][\w]*)(?:\[\]|\?)?/u.exec(line)
    if (!field || !modelNames.has(field[2])) continue
    keys.push(`${model.replace(/_/gu, '').toLowerCase()}.${field[1].replace(/_/gu, '').toLowerCase()}`)
  }
  return keys
}

// Mixed-language database calls need a receiver strong enough to distinguish
// an actual database API from unrelated APIs such as `search.query()` or
// `animation.execute()`. Keep the vocabulary bounded to conventional database
// handles while allowing common descriptive snake_case handle names.
const DATABASE_METHOD_RECEIVER = String.raw`(?:cursor|cur|connection|conn|client|db|database|pool|engine|session|sequelize|query_?runner|entity_?manager|pg|postgres|postgresql|mysql|sqlite|(?:sql|db|database|postgres|postgresql|mysql|sqlite)_[A-Za-z_]\w*|[A-Za-z_]\w*_(?:cursor|connection|conn|db|database|pool|engine|session))`
const DATABASE_CALL_RECEIVER = String.raw`${DATABASE_METHOD_RECEIVER}(?:\s*\(\s*\))?(?:\s*\.\s*cursor\s*\(\s*\))?`
const DATABASE_STRING_METHOD_SINK = new RegExp(
  String.raw`\b${DATABASE_CALL_RECEIVER}\s*\.\s*(?:cursor|execute|executemany|executescript|fetch|fetchrow|fetchval|query)\s*\(\s*$`,
  'iu',
)
const DATABASE_DYNAMIC_METHOD_SINK = new RegExp(
  String.raw`\b${DATABASE_CALL_RECEIVER}\s*\.\s*(cursor|query|execute(?:many|script)?|fetch(?:row|val)?)\s*\(`,
  'giu',
)

export function mixedSqlFragments(text) {
  const fragments = []
  const add = (sql, index, source) => {
    if (typeof sql !== 'string' || sql.trim().length === 0) return
    fragments.push({ sql, index, source })
  }
  const strongSql = /\b(?:SELECT\b[\s\S]*?\bFROM\b|TABLE\s+(?:ONLY\s+)?["`A-Za-z_][\w."`]*|INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE\s+(?:ONLY\s+)?["`A-Za-z_][\w."`]*\s+SET|DELETE\s+FROM|MERGE\s+INTO|CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW|TYPE|DATABASE|SCHEMA|FUNCTION|PROCEDURE|INDEX|ROLE)|ALTER\s+(?:TABLE|TYPE|DATABASE|SCHEMA|ROLE)|DROP\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW|TYPE|DATABASE|SCHEMA|FUNCTION|PROCEDURE|INDEX|ROLE)|TRUNCATE\s+(?:TABLE\s+)?["`A-Za-z_]|COPY\s+(?:\([\s\S]*?\)|(?:ONLY\s+)?["`A-Za-z_][\w."`]*(?:\s*\([^)]*\))?)\s+(?:FROM|TO)\b|GRANT\b|REVOKE\b|CALL\s+["`A-Za-z_])/iu
  const commentMasked = maskCommentText(text)
  const structuralMasked = maskQuotedAndCommentText(text)

  // Shell/PowerShell/Python string literals are considered only when their
  // contents have a strong SQL grammar prefix. Ordinary words such as
  // `apt update`, `replace`, or `truncate the file` are never SQL evidence.
  const stringPatterns = [
    /("""|''')([\s\S]*?)\1/gu,
    /@(["'])([\s\S]*?)\1@/gu,
    /(["'`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/gu,
  ]
  for (const pattern of stringPatterns) {
    for (const match of text.matchAll(pattern)) {
      const body = match[2]
      const opening = match.index ?? 0
      if (commentMasked[opening] === ' ' && !/\s/u.test(text[opening])) continue
      const prefix = structuralMasked.slice(Math.max(0, opening - 240), opening)
      const databaseSink = DATABASE_STRING_METHOD_SINK.test(prefix)
        || /(?:\b(?:psql|mysql|sqlite3|sqlcmd)\b[^\n]*\s-c\s*(?:\\\r?\n\s*)?|(?:^|\s)(?:SQL|QUERY|STATEMENT)\s*=\s*)$/iu.test(prefix)
      if (databaseSink && strongSql.test(body)) add(body, (match.index ?? 0) + match[0].indexOf(body), 'embedded_database_string')
    }
  }

  // Heredocs are not string tokens, but database restore/migration scripts
  // commonly feed them to psql. Require either a database command on the
  // introducing line or strong SQL in the body.
  const heredoc = /(^[^\n]*<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[^\n]*\n)([\s\S]*?)\n\2\s*$/gmu
  for (const match of text.matchAll(heredoc)) {
    const introduction = match[1]
    const body = match[3]
    const opening = match.index ?? 0
    if (commentMasked[opening] === ' ' && !/\s/u.test(text[opening])) continue
    const commentHeredoc = /^\s*:\s*<<-?/u.test(introduction)
    if (!commentHeredoc && (/(?:psql|mysql|sqlite3|sqlcmd)/iu.test(introduction) || strongSql.test(body))) {
      add(body, (match.index ?? 0) + introduction.length, 'database_heredoc')
    }
  }

  const seen = new Set()
  return fragments
    .filter((fragment) => {
      const key = `${fragment.index}:${fragment.sql}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => left.index - right.index || left.sql.localeCompare(right.sql))
}

function maskCommentText(text) {
  const masked = [...text]
  let quote = null
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\n') {
      quote = null
      escaped = false
      continue
    }
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === '\\' && quote !== "'") {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    const lineStart = text.lastIndexOf('\n', index - 1) + 1
    const beforeOnLine = text.slice(lineStart, index)
    if (/^\s*$/u.test(beforeOnLine) && (/^REM(?:\s|$)/iu.test(text.slice(index)) || text.startsWith('::', index))) {
      while (index < text.length && text[index] !== '\n') masked[index++] = ' '
      index -= 1
      continue
    }
    const cStyleBlockComment = text.startsWith('/*', index)
      && (index === 0 || /[\s;({[]/u.test(text[index - 1]))
    if (text.startsWith('<#', index) || cStyleBlockComment) {
      const close = text.startsWith('<#', index) ? '#>' : '*/'
      masked[index++] = ' '
      while (index < text.length) {
        masked[index] = text[index] === '\n' ? '\n' : ' '
        if (text.startsWith(close, index)) {
          if (index + 1 < text.length) masked[index + 1] = ' '
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    const cStyleLineComment = text.startsWith('//', index)
      && (index === 0 || /[\s;({[]/u.test(text[index - 1]))
    if (cStyleLineComment) {
      while (index < text.length && text[index] !== '\n') masked[index++] = ' '
      index -= 1
      continue
    }
    if (character === '#' && (index === 0 || /[\s;&|()]/u.test(text[index - 1]))) {
      while (index < text.length && text[index] !== '\n') masked[index++] = ' '
      index -= 1
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
    }
  }
  const intermediate = masked.join('')
  const commentHeredoc = /^\s*:\s*<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[^\n]*\n[\s\S]*?^\s*\1\s*$/gmu
  for (const match of intermediate.matchAll(commentHeredoc)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    for (let index = start; index < end; index += 1) masked[index] = text[index] === '\n' ? '\n' : ' '
  }
  return masked.join('')
}

function maskQuotedAndCommentText(text) {
  const commentsMasked = maskCommentText(text)
  const masked = [...commentsMasked]
  let quote = null
  let escaped = false
  for (let index = 0; index < commentsMasked.length; index += 1) {
    const character = commentsMasked[index]
    if (character === '\n') {
      escaped = false
      continue
    }
    if (quote) {
      masked[index] = ' '
      if (escaped) escaped = false
      else if (character === '\\' && quote !== "'") escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      masked[index] = ' '
    }
  }
  return masked.join('')
}

function shellCommandPayloadPrefix(segment) {
  const shell = /(?:^|\s)(?:[\w./-]*\/)?(?:ba|da|k|z)?sh\b/giu
  for (const match of segment.matchAll(shell)) {
    const tail = segment.slice((match.index ?? 0) + match[0].length).trim()
    if (!tail) continue
    const arguments_ = tail.split(/\s+/u)
    let commandOption = false
    let valid = true
    for (let index = 0; index < arguments_.length; index += 1) {
      const argument = arguments_[index]
      if (/^[+-][A-Za-z]+$/u.test(argument)) {
        if (argument.startsWith('-') && argument.slice(1).includes('c')) commandOption = true
        if (new Set(['-o', '+o', '-O']).has(argument)) {
          index += 1
          if (index >= arguments_.length) valid = false
        }
        continue
      }
      if (/^--[A-Za-z][\w-]*(?:=.*)?$/u.test(argument)) {
        if (!argument.includes('=') && new Set(['--init-file', '--rcfile']).has(argument)) {
          index += 1
          if (index >= arguments_.length) valid = false
        }
        continue
      }
      valid = false
      break
    }
    if (valid && commandOption) return true
  }
  return false
}

function revealShellPayload(searchable, text, bodyStart, bodyEnd) {
  let quote = null
  let escaped = false
  let comment = false
  for (let index = bodyStart; index < bodyEnd; index += 1) {
    const character = text[index]
    if (comment) {
      searchable[index] = character === '\n' ? '\n' : ' '
      if (character === '\n') comment = false
      continue
    }
    searchable[index] = character
    if (escaped) {
      escaped = false
      continue
    }
    if (quote) {
      if (character === '\\' && quote !== "'") escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      continue
    }
    if (
      character === '#'
      && (index === bodyStart || /[\s;&|()]/u.test(text[index - 1]))
    ) {
      searchable[index] = ' '
      comment = true
    }
  }
}

function executableQuotedCommandText(text, options = {}) {
  const masked = maskQuotedAndCommentText(text)
  const commentMasked = maskCommentText(text)
  const searchable = [...masked]
  const importsChildProcess = Boolean(options.assumeNodeChildProcess)
    || /(?:from\s*|require\s*\(\s*)['"](?:node:)?child_process['"]/u.test(text)
  // Parse exec-form Docker/YAML arrays independently. A generic quote walker
  // can be desynchronized by unrelated shell quoting earlier in the file,
  // while the array itself is a bounded one-line grammar.
  const execArrays = /(?:command\s*:|entrypoint\s*:|CMD|ENTRYPOINT)\s*\[\s*["'][^"']*(?:ba|da|k|z)?sh["']\s*,\s*["'][^"']*c[^"']*["']\s*,\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\s*\]/gimu
  for (const match of commentMasked.matchAll(execArrays)) {
    const body = match[1] ?? match[2]
    if (body === undefined) continue
    const bodyStart = (match.index ?? 0) + match[0].indexOf(body)
    revealShellPayload(searchable, text, bodyStart, bodyStart + body.length)
  }
  const strings = /(["'])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/gu
  for (const match of commentMasked.matchAll(strings)) {
    const opening = match.index ?? 0
    const lineStart = masked.lastIndexOf('\n', opening - 1) + 1
    const prefix = masked.slice(lineStart, opening).trimEnd()
    // Bash's ANSI-C and localized strings add a `$` immediately before the
    // quote. It belongs to the string form, not to the shell option prefix.
    const segment = prefix.split(/(?:&&|\|\||[;|])/u).at(-1).trim().replace(/\$$/u, '')
    const shellPayload = shellCommandPayloadPrefix(segment)
    const sshPayload = /(?:^|\s)(?:[\w./-]*\/)?ssh\b[^\n]*\S\s*$/iu.test(segment)
    const rawPrefix = text.slice(lineStart, opening)
    const execArrayShell = /(?:^|\b)(?:command\s*:|entrypoint\s*:|CMD|ENTRYPOINT)\s*\[\s*["'][^"']*(?:ba|da|k|z)?sh["']\s*,\s*["'][^"']*c[^"']*["']\s*,\s*$/iu.test(rawPrefix)
    const jsonScriptValue = /^\s*"[^"]+"\s*:\s*$/u.test(rawPrefix)
    const executionPrefix = text.slice(Math.max(0, opening - 512), opening)
    const pythonExecutionPayload = (
      /\b(?:subprocess\s*\.\s*(?:Popen|call|check_call|check_output|run)|asyncio\s*\.\s*create_subprocess_(?:exec|shell)|os\s*\.\s*(?:execlp?|execvp?|popen|system))\s*\(\s*(?:\[\s*)?$/iu.test(executionPrefix)
      || /\bos\s*\.\s*spawn(?:l|lp|v|vp)?\s*\(\s*[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*\s*,\s*$/iu.test(executionPrefix)
    )
    const interpreterPayload = /(?:^|\s)(?:powershell(?:\.exe)?\s+(?:-[A-Za-z]+\s+)*-(?:Command|EncodedCommand)|cmd(?:\.exe)?\s+\/(?:c|k))\s*$/iu.test(rawPrefix)
    const powershellProcessPayload = /(?:^|[;|]\s*|\s)(?:Start-Process(?:\s+-FilePath)?|&|Invoke-Expression|iex)\s*$/iu.test(rawPrefix)
    const shellEvalPayload = /(?:^|[;&|]\s*|\s)eval\s*$/iu.test(rawPrefix)
    const javascriptChildProcessPayload = importsChildProcess && (
      /(?:\b(?:exec|execFile|spawn)(?:Sync)?\s*\(|\b[A-Za-z_$][\w$]*\s*\.\s*(?:exec|execFile|spawn)(?:Sync)?\s*\()\s*$/u.test(executionPrefix)
    )
    if (
      !shellPayload
      && !sshPayload
      && !execArrayShell
      && !jsonScriptValue
      && !pythonExecutionPayload
      && !interpreterPayload
      && !powershellProcessPayload
      && !shellEvalPayload
      && !javascriptChildProcessPayload
    ) continue
    const bodyOffset = match[0].indexOf(match[2])
    const bodyStart = opening + bodyOffset
    const bodyEnd = bodyStart + match[2].length
    revealShellPayload(searchable, text, bodyStart, bodyEnd)
  }
  return searchable.join('')
}

/**
 * Find executable database-command sinks in a mixed-language script. Quoted
 * log messages and comments are masked, while offsets are preserved. A SQL
 * client whose inline `-c`/heredoc payload was extracted is not emitted again;
 * independent dump/restore/dynamic commands in the same file remain visible.
 */
export function mixedDatabaseCommandSinks(text, options = {}) {
  const staticFragments = options.staticFragments ?? mixedSqlFragments(text)
  const masked = executableQuotedCommandText(text, options)
  const commandPatterns = [
    /\b(pg_restore|pg_dump|mysqldump|psql|mysql|sqlite3|sqlcmd)\b|\bprisma\s+(migrate\s+(?:deploy|dev|reset|resolve)|db\s+(?:push|execute))\b/giu,
    DATABASE_DYNAMIC_METHOD_SINK,
  ]
  const sinks = []
  for (const pattern of commandPatterns) for (const match of masked.matchAll(pattern)) {
    const index = match.index ?? 0
    const lineStart = masked.lastIndexOf('\n', index - 1) + 1
    const lineEndCandidate = masked.indexOf('\n', index)
    const lineEnd = lineEndCandidate === -1 ? masked.length : lineEndCandidate
    const lineText = masked.slice(lineStart, lineEnd)
    const prefix = masked.slice(lineStart, index)
    if (
      /(?:browser|page|playwright|puppeteer)\s*\.\s*$/iu.test(prefix)
      && /^session\s*\.\s*(?:query|execute)/iu.test(match[0])
    ) continue
    const prefixAfterOperator = prefix.split(/(?:&&|\|\||[;|])/u).at(-1).trim()
    if (
      /^(?:echo|printf|log|logger|write-host|grep|sed|awk)\b/iu.test(prefixAfterOperator)
      || /\b(?:echo|printf|log|logger|write-host)\b[^;&|]*$/iu.test(prefixAfterOperator)
      || /^(?:export\s+)?\$?[A-Za-z_]\w*\s*=\s*(?:@?\(\s*)?$/u.test(prefixAfterOperator)
      || /^\s*(?:export\s+)?\$?[A-Za-z_]\w*\s*=\s*@?\([^)]*$/u.test(prefix)
      || /(?:^|\s)(?:command\s+-v|type\s+-[A-Za-z]*[aptP][A-Za-z]*|which|where(?:\.exe)?|Get-Command)\s*$/iu.test(prefixAfterOperator)
    ) continue

    let logicalStart = lineStart
    while (logicalStart > 0) {
      const previousEnd = logicalStart - 1
      const previousStart = masked.lastIndexOf('\n', previousEnd - 1) + 1
      if (!/\\\s*$/u.test(masked.slice(previousStart, previousEnd))) break
      logicalStart = previousStart
    }
    let logicalEnd = lineEnd
    while (/\\\s*$/u.test(masked.slice(masked.lastIndexOf('\n', logicalEnd - 1) + 1, logicalEnd))) {
      const nextEnd = masked.indexOf('\n', logicalEnd + 1)
      logicalEnd = nextEnd === -1 ? masked.length : nextEnd
      if (logicalEnd === masked.length) break
    }
    const logicalText = masked.slice(logicalStart, logicalEnd)
    const command = match[1]?.toLowerCase()
      ?? (match[2]
        ? `prisma ${match[2].toLowerCase().replace(/\s+/gu, ' ')}`
        : null)
      ?? match.at(-1).toLowerCase()
    const commandTail = masked.slice(index + match[0].length, logicalEnd).split(/(?:&&|\|\||[;|])/u)[0]
    const informationalCommand = (
      command === 'pg_restore'
      && (
        /(?:^|\s)(?:--help|--version|-\?|-[V])(?:\s|$)/u.test(commandTail)
        || /(?:^|\s)(?:--list|-l)(?:\s|$)/u.test(commandTail)
      )
    ) || (
      command === 'psql'
      && /(?:^|\s)(?:--help|--version|-\?|-V)(?:\s|$)/u.test(commandTail)
    )
    if (informationalCommand) continue
    const commandLineHasExtractedSql = (
      new Set(['psql', 'mysql', 'sqlite3', 'sqlcmd', 'cursor', 'query', 'execute', 'executemany', 'executescript', 'fetch', 'fetchrow', 'fetchval']).has(command)
      && staticFragments.some((fragment) => (
        (fragment.index >= logicalStart && fragment.index <= logicalEnd)
        || (fragment.source === 'database_heredoc' && fragment.index === lineEnd + 1)
      ))
    )
    if (commandLineHasExtractedSql) continue

    const intent = command === 'pg_dump' || command === 'mysqldump'
      ? 'READ'
      : command === 'pg_restore' || command.startsWith('prisma ')
        ? 'WRITE'
        : 'UNKNOWN'
    sinks.push({
      command,
      intent,
      index,
      line: lineForIndex(text, index),
      column: index - lineStart + 1,
    })
  }
  const unique = new Map()
  for (const sink of sinks) unique.set(`${sink.index}:${sink.command}:${sink.intent}`, sink)
  return [...unique.values()].sort((left, right) => (
    left.index - right.index || left.command.localeCompare(right.command) || left.intent.localeCompare(right.intent)
  ))
}

export function standaloneSqlSites(surface, text, mixedLanguage = false, options = {}) {
  const fragments = mixedLanguage
    ? mixedSqlFragments(text)
    : [{ sql: text, index: 0, source: 'standalone_sql' }]
  const analyses = fragments.map((fragment) => ({
    fragment,
    analysis: analyzeSqlScript(fragment.sql, { forceDynamic: mixedLanguage }),
  }))
  const commandSinks = mixedLanguage ? mixedDatabaseCommandSinks(text, {
    ...options,
    staticFragments: analyses
      .filter(({ analysis }) => analysis.operations.length > 0 || (analysis.read_tables ?? []).length > 0)
      .map(({ fragment }) => fragment),
  }) : []
  const operations = analyses.flatMap(({ fragment, analysis }) => analysis.operations.map((operation) => ({
    ...operation,
    index: fragment.index + operation.index,
    fragment_source: fragment.source,
    analysis,
  })))
  const uniqueOperations = []
  const seenOperations = new Set()
  for (const operation of operations) {
    const key = `${operation.index}:${operation.operation}:${operation.table ?? ''}:${operation.object ?? ''}`
    if (seenOperations.has(key)) continue
    seenOperations.add(key)
    uniqueOperations.push(operation)
  }
  const sqlSites = uniqueOperations.map((operation, ordinal) => {
    const { analysis: operationAnalysis, ...publicOperation } = operation
    const location = locationForIndex(text, operation.index)
    return {
    file: surface.path,
    line: location.line,
    column: location.column,
    scope: mixedLanguage ? '<mixed-operational-script>' : '<sql-script>',
    kind: 'raw',
    method: mixedLanguage ? 'mixed-script-sql' : 'sql-script',
    tables: operation.table ? [operation.table] : [],
    operations: [publicOperation],
    ambiguous: mixedLanguage || operationAnalysis.ambiguous || operation.dynamic_target,
    ambiguity_reasons: [...new Set([
      ...operationAnalysis.reasons,
      ...(mixedLanguage ? ['mixed_language_sql_requires_review'] : []),
      ...(operation.dynamic_target ? ['unresolved_mutation_target'] : []),
    ])].sort(),
    site_signature: sha256(`${surface.path}\n${operationAnalysis.sql_sha256}\n${ordinal}\n${operation.operation}\n${operation.table ?? ''}`),
  }
  })
  const unresolvedSqlSites = analyses
    .filter(({ analysis }) => analysis.is_mutation === null && analysis.operations.length === 0)
    .map(({ fragment, analysis }, ordinal) => {
      const location = locationForIndex(text, fragment.index)
      return {
        file: surface.path,
        line: location.line,
        column: location.column,
        scope: mixedLanguage ? '<mixed-operational-script>' : '<sql-script>',
        kind: 'raw',
        method: mixedLanguage ? 'mixed-script-sql' : 'sql-script',
        fragment_source: fragment.source,
        tables: [],
        operations: [],
        read_tables: analysis.read_tables ?? [],
        selected_columns: analysis.selected_columns ?? [],
        called_functions: analysis.called_functions ?? [],
        sql_sha256: analysis.sql_sha256,
        ambiguous: true,
        ambiguity_reasons: [...new Set(analysis.reasons ?? ['unresolved_sql_intent'])].sort(),
        site_signature: sha256(`${surface.path}\n${analysis.sql_sha256}\nunresolved:${ordinal}`),
      }
    })
  const commandSites = commandSinks
    .filter((sink) => sink.intent !== 'READ')
    .map((sink) => ({
      file: surface.path,
      line: sink.line,
      column: sink.column,
      scope: '<mixed-operational-script>',
      kind: 'raw',
      method: `mixed-script-command:${sink.command}`,
      database_command_intent: sink.intent,
      tables: [],
      operations: [],
      ambiguous: true,
      ambiguity_reasons: [...new Set([
        'dynamic_database_command_requires_review',
        ...(sink.intent === 'WRITE' ? ['dynamic_database_write_command_requires_review'] : []),
      ])].sort(),
      site_signature: sha256(`${surface.path}\n${sha256(text)}\n${sink.index}\n${sink.command}\n${sink.intent}`),
    }))
  return [...sqlSites, ...unresolvedSqlSites, ...commandSites].sort((left, right) => (
    left.line - right.line || left.column - right.column || left.site_signature.localeCompare(right.site_signature)
  ))
}

export function javascriptDatabaseCommandSites(surface, text) {
  // Most JS-family files cannot launch a database CLI and should not pay the
  // mixed-shell quote-walker cost. A CLI name inside a fixture, comment, SQL
  // parser or regular expression is not an executable child-process call.
  // Check for a real direct exec/spawn syntax outside quoted/comment text
  // before entering the mixed-language parser; the parser remains responsible
  // for conservative command detection once a sink is possible.
  if (!/\b(?:pg_restore|pg_dump|mysqldump|psql|mysql|sqlite3|sqlcmd)\b|\bprisma\s+(?:migrate|db)\b/iu.test(text)) {
    return []
  }
  const code = maskQuotedAndCommentText(text)
  if (!/\b(?:exec|execFile|spawn)(?:Sync)?\s*\(|\b[A-Za-z_$][\w$]*\s*\.\s*(?:exec|execFile|spawn)(?:Sync)?\s*\(/u.test(code)) {
    return []
  }
  // TypeScript's parser distinguishes regular-expression literals from
  // executable string arguments. Mask regex bytes before the mixed-language
  // command scan so detector vocabularies such as /(psql|mysql)/ cannot be
  // mistaken for a child-process invocation merely because the same module
  // also uses execFile for an unrelated command.
  const sourceFile = ts.createSourceFile(
    surface.path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.getScriptKindFromFileName(surface.path),
  )
  const childProcessCallNames = new Set(['exec', 'execFile', 'spawn', 'execSync', 'execFileSync', 'spawnSync'])
  const childProcessNamespaces = new Set()
  const variableInitializers = new Map()
  const collectBindings = (node) => {
    if (
      ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
      && /^(?:node:)?child_process$/u.test(node.moduleSpecifier.text)
    ) {
      const clause = node.importClause
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        childProcessNamespaces.add(clause.namedBindings.name.text)
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const element of clause.namedBindings.elements) {
        if (childProcessCallNames.has(element.propertyName?.text ?? element.name.text)) childProcessCallNames.add(element.name.text)
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      variableInitializers.set(node.name.text, node.initializer)
      if (
        ts.isCallExpression(node.initializer)
        && ts.isIdentifier(node.initializer.expression)
        && node.initializer.expression.text === 'require'
        && ts.isStringLiteral(node.initializer.arguments[0])
        && /^(?:node:)?child_process$/u.test(node.initializer.arguments[0].text)
      ) childProcessNamespaces.add(node.name.text)
    }
    ts.forEachChild(node, collectBindings)
  }
  collectBindings(sourceFile)

  // Regex detector vocabularies remain masked unless the exact literal reaches
  // the command argument of a child_process call. This keeps the analyzer from
  // scanning its own detector regexes while retaining real patterns such as
  // `execFile(/pg_restore/.source, ...)` and their local const aliases.
  const commandRegexLiterals = new Set()
  const markCommandProvenance = (node, seenNames = new Set()) => {
    if (!node) return
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      commandRegexLiterals.add(node)
      return
    }
    if (ts.isIdentifier(node)) {
      if (seenNames.has(node.text)) return
      const initializer = variableInitializers.get(node.text)
      if (initializer) markCommandProvenance(initializer, new Set(seenNames).add(node.text))
      return
    }
    ts.forEachChild(node, (child) => markCommandProvenance(child, new Set(seenNames)))
  }
  const collectCommandProvenance = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const direct = ts.isIdentifier(callee) && childProcessCallNames.has(callee.text)
      const namespaced = ts.isPropertyAccessExpression(callee)
        && ts.isIdentifier(callee.expression)
        && childProcessNamespaces.has(callee.expression.text)
        && childProcessCallNames.has(callee.name.text)
      if ((direct || namespaced) && node.arguments[0]) markCommandProvenance(node.arguments[0])
    }
    ts.forEachChild(node, collectCommandProvenance)
  }
  collectCommandProvenance(sourceFile)

  // The mixed-language scanner is intentionally conservative, but for a
  // JavaScript-family file we already have an AST and can distinguish a CLI
  // token that merely appears in a binding/comparison from one that can reach
  // the command argument of child_process. Mask all CLI identifier/string
  // occurrences first, then reveal only the exact first-argument provenance
  // of a child-process call. This prevents `const psql = env || 'psql'` and
  // `program === 'psql'` from becoming phantom command sites while retaining
  // real direct, aliased and regex-derived executions.
  const commandText = [...text]
  const databaseCliToken = /^(?:pg_restore|pg_dump|mysqldump|psql|mysql|sqlite3|sqlcmd)$/iu
  const maskDatabaseCliVocabulary = (node) => {
    const token = (
      (ts.isIdentifier(node) && databaseCliToken.test(node.text))
      || (ts.isStringLiteralLike(node) && databaseCliToken.test(node.text))
    )
    if (token) {
      for (let index = node.getStart(sourceFile); index < node.end; index += 1) {
        commandText[index] = text[index] === '\n' ? '\n' : ' '
      }
      return
    }
    ts.forEachChild(node, maskDatabaseCliVocabulary)
  }
  maskDatabaseCliVocabulary(sourceFile)
  const revealCommandProvenance = (node, seenNames = new Set()) => {
    if (!node) return
    if (ts.isIdentifier(node)) {
      if (seenNames.has(node.text)) return
      const initializer = variableInitializers.get(node.text)
      if (initializer) revealCommandProvenance(initializer, new Set(seenNames).add(node.text))
      return
    }
    if (
      (ts.isStringLiteralLike(node) && databaseCliToken.test(node.text))
      || node.kind === ts.SyntaxKind.RegularExpressionLiteral
    ) {
      for (let index = node.getStart(sourceFile); index < node.end; index += 1) commandText[index] = text[index]
      return
    }
    ts.forEachChild(node, (child) => revealCommandProvenance(child, new Set(seenNames)))
  }
  const revealExecutedCommands = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const direct = ts.isIdentifier(callee) && childProcessCallNames.has(callee.text)
      const namespaced = ts.isPropertyAccessExpression(callee)
        && ts.isIdentifier(callee.expression)
        && childProcessNamespaces.has(callee.expression.text)
        && childProcessCallNames.has(callee.name.text)
      if ((direct || namespaced) && node.arguments[0]) revealCommandProvenance(node.arguments[0])
    }
    ts.forEachChild(node, revealExecutedCommands)
  }
  revealExecutedCommands(sourceFile)
  const maskRegularExpressions = (node) => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral && !commandRegexLiterals.has(node)) {
      for (let index = node.getStart(sourceFile); index < node.end; index += 1) {
        commandText[index] = text[index] === '\n' ? '\n' : ' '
      }
      return
    }
    ts.forEachChild(node, maskRegularExpressions)
  }
  maskRegularExpressions(sourceFile)
  return standaloneSqlSites(surface, commandText.join(''), true, { assumeNodeChildProcess: true }).filter((site) => (
    site.method.startsWith('mixed-script-command:')
  ))
}

async function analyzeSurface(surface, taskId, repositoryRoot, architecture, execution, onWorkerStarted) {
  const startedAt = process.hrtime.bigint()
  try {
    const bytes = await readFile(path.join(repositoryRoot, surface.path))
    const sourceSha256 = sha256(bytes)
    const decoded = decodeSource(bytes)
    const source = sourceIdentity(surface, architecture)
    let discovered = []
    const parseFindings = []
    let workerPid = null
    if (JS_FAMILY.has(surface.extension)) {
      const analysis = await analyzeJavaScriptSurfaceIsolated(surface, decoded.text, {
        taskId,
        knownModels: [...architecture.prismaModels],
        relationFields: [...architecture.prismaRelationFields],
        workerTimeoutMs: execution.workerTimeoutMs,
        onStarted: (pid) => {
          workerPid = pid
          onWorkerStarted(pid)
        },
      })
      workerPid = analysis.pid
      discovered = analysis.sites
      for (const diagnostic of analysis.diagnostics) {
        parseFindings.push({
          file: surface.path,
          encoding: decoded.encoding,
          source_sha256: sourceSha256,
          ...diagnostic,
        })
      }
    } else if (surface.extension === '.sql') {
      discovered = standaloneSqlSites(surface, decoded.text)
    } else if (MIXED_SCRIPT.has(surface.extension)) {
      discovered = standaloneSqlSites(surface, decoded.text, true)
    }
    const sites = discovered.map((site) => {
      const result = classifySite(site, surface, source, architecture)
      return {
        ...site,
        source_sha256: sourceSha256,
        sql_provenance_sha256: site.kind === 'raw' && site.sql_sha256
          ? sha256(`${sourceSha256}\n${site.site_signature}\n${site.sql_sha256}`)
          : null,
        ...result,
        source_context: source.context,
        source_technical_module: source.technical_module,
        source_identity: source.source,
        surface: {
          lifecycle: surface.lifecycle,
          disposition: surface.disposition,
          production_capability: surface.production_capability,
          maintenance_lifecycle: surface.maintenance_lifecycle,
          migration_authority: surface.migration_authority,
          registry_classified: surface.registry_classified,
        },
      }
    })
    if (decoded.ambiguous) {
      parseFindings.push({
        file: surface.path,
        encoding: decoded.encoding,
        source_sha256: sourceSha256,
        code: 'ENCODING_INFERRED',
        line: 1,
        column: 1,
        message: 'source encoding was inferred and requires explicit review',
      })
    }
    return {
      task_id: taskId,
      surface,
      sites,
      parse_findings: parseFindings,
      worker_pid: workerPid,
      duration_ms: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      failure: null,
    }
  } catch (error) {
    return {
      task_id: taskId,
      surface,
      sites: [],
      parse_findings: [],
      worker_pid: error?.pid ?? null,
      duration_ms: error?.duration_ms ?? Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      failure: {
        code: error?.code ?? 'ANALYZER_SURFACE_FAILURE',
        message: error?.message ?? String(error),
        timeout_ms: error?.timeout_ms ?? null,
        exit_code: error?.exit_code ?? null,
        signal: error?.signal ?? null,
      },
    }
  }
}

async function analyzeSurfacesBounded(surfaces, repositoryRoot, architecture, options = {}) {
  const execution = isolatedExecutionOptions(options)
  const startedAt = process.hrtime.bigint()
  const active = new Map()
  const results = new Array(surfaces.length)
  let nextTask = 0
  let completed = 0
  let writesDiscovered = 0
  let ambiguousCandidates = 0
  let workerFailures = 0
  let workerTimeouts = 0
  const snapshot = (event, extra = {}) => {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
    return {
      schema: 'yoko.crm.write-analyzer-progress.v1',
      event,
      elapsed_ms: elapsedMs,
      files_discovered: surfaces.length,
      files_scheduled: nextTask,
      files_completed: completed,
      files_remaining: surfaces.length - completed,
      writes_discovered: writesDiscovered,
      ambiguous_candidates: ambiguousCandidates,
      worker_failures: workerFailures,
      worker_timeouts: workerTimeouts,
      throughput_files_per_second: elapsedMs > 0 ? completed / (elapsedMs / 1_000) : 0,
      active_workers: [...active.entries()].map(([slot, item]) => ({ slot, ...item })).sort((left, right) => left.slot - right.slot),
      ...extra,
    }
  }
  const emit = async (event, extra = {}) => {
    if (typeof options.onProgress === 'function') await options.onProgress(snapshot(event, extra))
  }
  await emit('run_started', { workers: execution.workers, worker_timeout_ms: execution.workerTimeoutMs })
  const runSlot = async (slot) => {
    while (true) {
      const taskId = nextTask
      nextTask += 1
      if (taskId >= surfaces.length) return
      const surface = surfaces[taskId]
      active.set(slot, { task_id: taskId, file: surface.path, pid: null })
      const result = await analyzeSurface(surface, taskId, repositoryRoot, architecture, execution, (pid) => {
        active.set(slot, { task_id: taskId, file: surface.path, pid })
      })
      results[taskId] = result
      active.delete(slot)
      completed += 1
      writesDiscovered += result.sites.length
      ambiguousCandidates += result.sites.filter((site) => site.classification === 'AMBIGUOUS').length
      if (result.failure) {
        workerFailures += 1
        if (result.failure.code === 'ANALYZER_WORKER_TIMEOUT') workerTimeouts += 1
      }
      if (result.failure || completed % execution.progressEvery === 0 || completed === surfaces.length) {
        await emit(result.failure ? 'surface_failed' : 'progress', {
          task_id: taskId,
          file: surface.path,
          worker_pid: result.worker_pid,
          surface_duration_ms: result.duration_ms,
          failure: result.failure,
        })
      }
    }
  }
  await Promise.all(Array.from({ length: execution.workers }, (_, slot) => runSlot(slot)))
  const complete = workerFailures === 0
  await emit('run_finished', { complete })
  return {
    results,
    execution: {
      mode: 'fresh_process_per_javascript_surface',
      worker_limit: execution.workers,
      worker_timeout_ms: execution.workerTimeoutMs,
      progress_every: execution.progressEvery,
      files_discovered: surfaces.length,
      files_completed: completed,
      writes_discovered: writesDiscovered,
      ambiguous_candidates: ambiguousCandidates,
      worker_failures: workerFailures,
      worker_timeouts: workerTimeouts,
      complete,
      elapsed_ms: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      failures: results.filter((result) => result.failure).map((result) => ({
        task_id: result.task_id,
        file: result.surface.path,
        worker_pid: result.worker_pid,
        duration_ms: result.duration_ms,
        ...result.failure,
      })),
    },
  }
}

function summarize(sites, parseFindings, inventory) {
  const count = (predicate) => sites.filter(predicate).length
  return {
    tracked_executable_surfaces: inventory.summary.tracked_executable_surfaces,
    discovered_write_sites: sites.length,
    owner_writes: count((site) => site.classification === 'OWNER'),
    foreign_writes: count((site) => site.classification === 'FOREIGN'),
    ambiguous_writes: count((site) => site.classification === 'AMBIGUOUS'),
    migration_only_writes: count((site) => site.classification === 'MIGRATION_ONLY'),
    historical_dead_writes: count((site) => site.classification === 'HISTORICAL_DEAD'),
    test_writes: count((site) => site.classification === 'TEST'),
    operational_script_writes: count((site) => site.surface.lifecycle === 'OPERATIONAL_SCRIPT'),
    raw_sql_writes: count((site) => site.kind === 'raw'),
    parse_findings: parseFindings.length,
    unreviewed_operational_surfaces: inventory.summary.unreviewed_operational_surfaces,
  }
}

export async function analyzeRepository(repositoryRoot, options = {}) {
  const registry = options.registry ?? null
  const [inventory, gitIdentity] = await Promise.all([
    inventoryTrackedSurfaces(repositoryRoot, { registry }),
    repositoryGitIdentity(repositoryRoot),
  ])
  const moduleRules = await loadJson(repositoryRoot, 'architecture/evidence/v1/module-rules.json')
  const ownershipRules = await loadJson(repositoryRoot, 'architecture/evidence/v1/ownership-rules.json')
  const contextIndex = await loadJson(repositoryRoot, 'architecture/contexts/v1/context-index.json')
  const architecturePolicy = await loadJson(repositoryRoot, 'architecture/enforcement/v1/policy.json')
  const manifests = await Promise.all(contextIndex.contexts.map((entry) => loadJson(repositoryRoot, entry.path)))
  const manifestAmendments = await Promise.all((architecturePolicy.manifest_amendments ?? []).map((entry) => (
    loadJson(repositoryRoot, entry)
  )))
  const scopedOwnership = await loadOptionalJson(repositoryRoot, 'architecture/contexts/v1/scoped-data-ownership.json', { rules: [] })
  const architecture = compileArchitecture(moduleRules, manifests, ownershipRules, scopedOwnership, {
    manifestAmendments,
    approvedInfrastructureWriters: architecturePolicy.approved_infrastructure_writers ?? [],
  })
  architecture.tableSymbols = new Map()
  architecture.prismaModels = new Set()
  architecture.prismaRelationFields = new Set()
  for (const surface of inventory.surfaces) {
    // Prisma schemas are conventionally stored under `prisma/` as well as
    // `schema/`. Parse every tracked `.prisma` file so relation/model facts
    // are available to JavaScript surfaces in auxiliary applications (for
    // example tg-bot), while keeping JS schema discovery scoped to schema
    // modules.
    if (surface.extension !== '.prisma' && (!JS_FAMILY.has(surface.extension) || !surface.path.includes('/schema/'))) continue
    const schemaSource = decodeSource(await readFile(path.join(repositoryRoot, surface.path))).text
    if (surface.extension === '.prisma') {
      for (const match of schemaSource.matchAll(/^model\s+([A-Za-z_][\w]*)\s*\{/gmu)) {
        architecture.prismaModels.add(match[1])
      }
      for (const key of prismaRelationFieldKeys(schemaSource)) architecture.prismaRelationFields.add(key)
    }
    if (!JS_FAMILY.has(surface.extension) || !surface.path.includes('/schema/')) continue
    for (const match of schemaSource.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:pgTable|sqliteTable|mysqlTable)\s*\(\s*['"]([^'"]+)['"]/gu)) {
      architecture.tableSymbols.set(match[1].toLowerCase(), match[2].toLowerCase())
    }
  }
  const bounded = await analyzeSurfacesBounded(inventory.surfaces, repositoryRoot, architecture, options)
  const sites = bounded.results.flatMap((result) => result.sites)
  const parseFindings = bounded.results.flatMap((result) => result.parse_findings)

  sites.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.site_signature.localeCompare(right.site_signature))
  parseFindings.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || String(left.code).localeCompare(String(right.code)))
  const result = {
    schema: 'yoko.crm.whole-repository-write-analysis.v2',
    source: {
      repository_root: '.',
      git_tracked_only: true,
      inventory_schema: inventory.schema,
      ...gitIdentity,
    },
    summary: summarize(sites, parseFindings, inventory),
    inventory,
    parse_findings: parseFindings,
    write_sites: sites,
  }
  result.analysis_sha256 = sha256(`${JSON.stringify(stable(result))}\n`)
  result.execution = bounded.execution
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
  let workers = null
  let workerTimeoutMs = null
  let progressEvery = null
  let progressJsonl = null
  let progress = true
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root') repositoryRoot = path.resolve(args[++index])
    else if (args[index] === '--surface-registry') registry = JSON.parse(await readFile(path.resolve(args[++index]), 'utf8'))
    else if (args[index] === '--output') output = path.resolve(args[++index])
    else if (args[index] === '--strict') strict = true
    else if (args[index] === '--workers') workers = Number(args[++index])
    else if (args[index] === '--worker-timeout-ms') workerTimeoutMs = Number(args[++index])
    else if (args[index] === '--progress-every') progressEvery = Number(args[++index])
    else if (args[index] === '--progress-jsonl') progressJsonl = path.resolve(args[++index])
    else if (args[index] === '--no-progress') progress = false
    else throw new Error(`unknown argument: ${args[index]}`)
  }
  if (progressJsonl) await writeFile(progressJsonl, '')
  const onProgress = async (event) => {
    const line = `${JSON.stringify(event)}\n`
    if (progress) process.stderr.write(`ANALYZER_PROGRESS ${line}`)
    if (progressJsonl) await appendFile(progressJsonl, line)
  }
  const result = await analyzeRepository(repositoryRoot, {
    registry,
    workers,
    workerTimeoutMs,
    progressEvery,
    onProgress,
  })
  const serialized = `${JSON.stringify(stable(result), null, 2)}\n`
  if (output) {
    if (result.execution.complete) {
      const temporaryOutput = `${output}.tmp-${process.pid}`
      await writeFile(temporaryOutput, serialized)
      await rename(temporaryOutput, output)
    }
  } else process.stdout.write(serialized)
  if (!result.execution.complete) {
    process.stderr.write(`ANALYZER_EXECUTION_INCOMPLETE ${JSON.stringify(result.execution.failures)}\n`)
    process.exitCode = 2
  }
  if (
    strict
    && (result.summary.parse_findings > 0 || result.summary.unreviewed_operational_surfaces > 0)
  ) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  })
}
