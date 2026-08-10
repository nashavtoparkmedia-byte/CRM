#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { analyzeSqlScript } from './sql-mutation-analyzer.mjs'
import { inventoryTrackedSurfaces } from './tracked-surface-inventory.mjs'
import { analyzePrismaWriteSites } from './write-analyzer.mjs'

const JS_FAMILY = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const MIXED_SCRIPT = new Set(['.sh', '.py', '.ps1', '.bat'])
const execFileAsync = promisify(execFile)

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
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

function compileArchitecture(moduleRules, manifests, ownershipRules) {
  const modules = moduleRules.modules.map((item) => ({ ...item, regex: new RegExp(item.match) }))
  const technicalToContext = new Map()
  for (const manifest of manifests) {
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
  for (const manifest of manifests) {
    for (const owned of manifest.owned_data ?? []) {
      if (!modelOwners.has(owned.model.toLowerCase())) {
        modelOwners.set(owned.model.toLowerCase(), {
          model: owned.model,
          context: manifest.context.id,
          technical_owner: null,
        })
      }
      if (owned.mapped_table) modelOwners.set(owned.mapped_table.toLowerCase(), modelOwners.get(owned.model.toLowerCase()))
    }
  }
  return { contextIds: new Set(manifests.map((manifest) => manifest.context.id)), modelOwners, modules, technicalToContext }
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

function targetIdentity(modelOrTable, architecture) {
  if (!modelOrTable) return null
  const normalized = modelOrTable.toLowerCase()
  const mapped = architecture.tableSymbols?.get(normalized) ?? normalized
  return architecture.modelOwners.get(mapped) ?? null
}

function lifecycleClassification(surface) {
  if (surface.lifecycle === 'TEST' || surface.lifecycle === 'FIXTURE') return 'TEST'
  if (surface.lifecycle === 'MIGRATION' || surface.disposition === 'MIGRATION_ONLY') return 'MIGRATION_ONLY'
  if (surface.lifecycle === 'DEAD_HISTORICAL' || surface.disposition === 'DEAD_HISTORICAL') return 'HISTORICAL_DEAD'
  return null
}

function classifySite(site, surface, source, architecture) {
  const lifecycle = lifecycleClassification(surface)
  if (lifecycle) return { classification: lifecycle, owner_contexts: [], unresolved_targets: [] }
  const targets = site.kind === 'model' || site.kind === 'ambiguous_model' || site.kind === 'drizzle'
    ? [site.model, ...(site.candidate_models ?? [])].filter(Boolean)
    : (site.tables ?? [])
  const identities = targets.map((target) => targetIdentity(target, architecture))
  const unresolvedTargets = targets.filter((target, index) => !identities[index])
  const ownerContexts = [...new Set(identities.filter(Boolean).map((item) => item.context))].sort()
  if (
    site.ambiguous
    || !source.context
    || targets.length === 0
    || unresolvedTargets.length > 0
    || ownerContexts.length !== 1
  ) return { classification: 'AMBIGUOUS', owner_contexts: ownerContexts, unresolved_targets: unresolvedTargets }
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

// Mixed-language database calls need a receiver strong enough to distinguish
// an actual database API from unrelated APIs such as `search.query()` or
// `animation.execute()`. Keep the vocabulary bounded to conventional database
// handles while allowing common descriptive snake_case handle names.
const DATABASE_METHOD_RECEIVER = String.raw`(?:cursor|cur|connection|conn|client|db|database|pool|engine|session|sequelize|query_?runner|entity_?manager|pg|postgres|postgresql|mysql|sqlite|(?:sql|db|database|postgres|postgresql|mysql|sqlite)_[A-Za-z_]\w*|[A-Za-z_]\w*_(?:cursor|connection|conn|db|database|pool|engine|session))`
const DATABASE_STRING_METHOD_SINK = new RegExp(
  String.raw`\b${DATABASE_METHOD_RECEIVER}(?:\s*\(\s*\))?\s*\.\s*(?:execute|executemany|executescript|query)\s*\(\s*$`,
  'iu',
)
const DATABASE_DYNAMIC_METHOD_SINK = new RegExp(
  String.raw`\b${DATABASE_METHOD_RECEIVER}(?:\s*\(\s*\))?\s*\.\s*(query|execute(?:many|script)?)\s*\(`,
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
    if (text.startsWith('<#', index) || text.startsWith('/*', index)) {
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
    if (text.startsWith('//', index)) {
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

function executableQuotedCommandText(text) {
  const masked = maskQuotedAndCommentText(text)
  const searchable = [...masked]
  const strings = /(["'])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/gu
  for (const match of text.matchAll(strings)) {
    const opening = match.index ?? 0
    const lineStart = masked.lastIndexOf('\n', opening - 1) + 1
    const prefix = masked.slice(lineStart, opening).trimEnd()
    const segment = prefix.split(/(?:&&|\|\||[;|])/u).at(-1).trim()
    const shellPayload = shellCommandPayloadPrefix(segment)
    const sshPayload = /(?:^|\s)(?:[\w./-]*\/)?ssh\b[^\n]*\S\s*$/iu.test(segment)
    if (!shellPayload && !sshPayload) continue
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
  const masked = executableQuotedCommandText(text)
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
    const prefixAfterOperator = prefix.split(/(?:&&|\|\||[;|])/u).at(-1).trim()
    if (
      /^(?:echo|printf|log|logger|write-host|grep|sed|awk)\b/iu.test(prefixAfterOperator)
      || /\b(?:echo|printf|log|logger|write-host)\b[^;&|]*$/iu.test(prefixAfterOperator)
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
    const commandLineHasExtractedSql = (
      new Set(['psql', 'mysql', 'sqlite3', 'sqlcmd', 'query', 'execute', 'executemany', 'executescript']).has(command)
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

export function standaloneSqlSites(surface, text, mixedLanguage = false) {
  const fragments = mixedLanguage
    ? mixedSqlFragments(text)
    : [{ sql: text, index: 0, source: 'standalone_sql' }]
  const analyses = fragments.map((fragment) => ({
    fragment,
    analysis: analyzeSqlScript(fragment.sql, { forceDynamic: mixedLanguage }),
  }))
  const commandSinks = mixedLanguage ? mixedDatabaseCommandSinks(text, {
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
  return [...sqlSites, ...commandSites].sort((left, right) => (
    left.line - right.line || left.column - right.column || left.site_signature.localeCompare(right.site_signature)
  ))
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
  const manifests = await Promise.all(contextIndex.contexts.map((entry) => loadJson(repositoryRoot, entry.path)))
  const architecture = compileArchitecture(moduleRules, manifests, ownershipRules)
  architecture.tableSymbols = new Map()
  architecture.prismaModels = new Set()
  for (const surface of inventory.surfaces) {
    if (surface.extension !== '.prisma' && (!JS_FAMILY.has(surface.extension) || !surface.path.includes('/schema/'))) continue
    const schemaSource = decodeSource(await readFile(path.join(repositoryRoot, surface.path))).text
    if (surface.extension === '.prisma') {
      for (const match of schemaSource.matchAll(/^model\s+([A-Za-z_][\w]*)\s*\{/gmu)) {
        architecture.prismaModels.add(match[1])
      }
    }
    if (!JS_FAMILY.has(surface.extension) || !surface.path.includes('/schema/')) continue
    for (const match of schemaSource.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:pgTable|sqliteTable|mysqlTable)\s*\(\s*['"]([^'"]+)['"]/gu)) {
      architecture.tableSymbols.set(match[1].toLowerCase(), match[2].toLowerCase())
    }
  }
  const sites = []
  const parseFindings = []

  for (const surface of inventory.surfaces) {
    const bytes = await readFile(path.join(repositoryRoot, surface.path))
    const decoded = decodeSource(bytes)
    const source = sourceIdentity(surface, architecture)
    let discovered = []
    if (JS_FAMILY.has(surface.extension)) {
      const analysis = analyzePrismaWriteSites(decoded.text, {
        fileName: surface.path,
        knownModels: [...architecture.prismaModels],
      })
      discovered = analysis.sites
      for (const diagnostic of analysis.diagnostics) {
        parseFindings.push({
          file: surface.path,
          encoding: decoded.encoding,
          source_sha256: sha256(bytes),
          ...diagnostic,
        })
      }
    } else if (surface.extension === '.sql') {
      discovered = standaloneSqlSites(surface, decoded.text)
    } else if (MIXED_SCRIPT.has(surface.extension)) {
      discovered = standaloneSqlSites(surface, decoded.text, true)
    }
    for (const site of discovered) {
      const result = classifySite(site, surface, source, architecture)
      sites.push({
        ...site,
        ...result,
        source_context: source.context,
        source_technical_module: source.technical_module,
        source_identity: source.source,
        surface: {
          lifecycle: surface.lifecycle,
          disposition: surface.disposition,
          production_capability: surface.production_capability,
          registry_classified: surface.registry_classified,
        },
      })
    }
    if (decoded.ambiguous) {
      parseFindings.push({
        file: surface.path,
        encoding: decoded.encoding,
        source_sha256: sha256(bytes),
        code: 'ENCODING_INFERRED',
        line: 1,
        column: 1,
        message: 'source encoding was inferred and requires explicit review',
      })
    }
  }

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
  const result = await analyzeRepository(repositoryRoot, { registry })
  const serialized = `${JSON.stringify(stable(result), null, 2)}\n`
  if (output) await writeFile(output, serialized)
  else process.stdout.write(serialized)
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
