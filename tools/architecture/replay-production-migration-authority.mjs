#!/usr/bin/env node
import { mkdtemp, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PENDING_SOURCE_PATH,
  readReconstructionSourceMigrations,
  validateProductionMigrationAuthority,
} from './production-migration-authority.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const prisma = path.join(root, 'gravity-mvp/node_modules/.bin/prisma')
const psql = process.env.PSQL_BIN || 'psql'
const pgDump = process.env.PG_DUMP_BIN || 'pg_dump'
const postgresClientContainer = process.env.YOKO_POSTGRES_CLIENT_CONTAINER || null

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function isolatedSchema(databaseUrl, predecessorRecovery) {
  const parsed = new URL(databaseUrl)
  const base = parsed.searchParams.get('schema')
  const schema = predecessorRecovery ? `${base}_predecessor` : base
  assert(schema && /^yoko_migration_authority_replay_[a-z0-9_]+$/.test(schema), 'DATABASE_URL must select an isolated yoko_migration_authority_replay_* schema')
  const longestSchema = predecessorRecovery ? `${schema}_fresh` : schema
  assert(Buffer.byteLength(longestSchema) <= 63, `isolated replay schema name exceeds PostgreSQL's 63-byte identifier limit: ${longestSchema}`)
  parsed.searchParams.set('schema', schema)
  return { databaseUrl: parsed.toString(), schema }
}

function runPrisma(workspace, databaseUrl, args) {
  const result = spawnSync(prisma, args, {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  })
  if (result.status !== 0) throw new Error(`Prisma ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
}

function assertPrismaDatamodelParity(workspace, databaseUrl) {
  const result = spawnSync(prisma, [
    'migrate', 'diff',
    '--from-url', databaseUrl,
    '--to-schema-datamodel', 'schema.prisma',
    '--exit-code',
  ], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  })
  assert(result.status === 0, `canonical migration catalog differs from current schema.prisma (exit ${result.status}):\n${result.stdout}\n${result.stderr}`)
  return true
}

function canonicalSource(rootDirectory, row) {
  if (row.path) return path.join(rootDirectory, row.path)
  const base = row.storage === 'archive'
    ? 'architecture/migrations/v1/archive/pre-outbox'
    : 'gravity-mvp/prisma/migrations'
  return path.join(rootDirectory, base, row.name, 'migration.sql')
}

function finishedMigrationCount(databaseUrl, schema) {
  const connection = new URL(databaseUrl)
  connection.search = ''
  const result = runPostgresClient('psql', [connection.toString(), '-v', 'ON_ERROR_STOP=1', '-At', '-c', `SELECT count(*) FROM ${schema}._prisma_migrations WHERE finished_at IS NOT NULL`], {
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`PostgreSQL migration ledger count failed:\n${result.stdout}\n${result.stderr}`)
  const count = Number.parseInt(result.stdout.trim(), 10)
  assert(Number.isInteger(count), 'PostgreSQL migration ledger count was not an integer')
  return count
}

function query(databaseUrl, sql) {
  const connection = new URL(databaseUrl)
  connection.search = ''
  const result = runPostgresClient('psql', [connection.toString(), '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`PostgreSQL query failed:\n${result.stdout}\n${result.stderr}`)
  return result.stdout.trim()
}

function assertSchemaAbsent(databaseUrl, schema) {
  const exists = query(databaseUrl, `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = '${schema}')`)
  assert(exists === 'f', `isolated replay schema already exists and is not fresh: ${schema}`)
}

function schemaCatalogDigest(databaseUrl, schema) {
  const connection = new URL(databaseUrl)
  connection.search = ''
  const result = runPostgresClient('pg_dump', [connection.toString(), '--schema-only', '--no-owner', '--no-privileges', `--schema=${schema}`], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`PostgreSQL schema catalog dump failed:\n${result.stdout}\n${result.stderr}`)
  const normalized = result.stdout
    .replaceAll(schema, '<schema>')
    .split('\n')
    .filter((line) => !line.startsWith('\\restrict ') && !line.startsWith('\\unrestrict '))
    .join('\n')
  return createHash('sha256').update(normalized).digest('hex')
}

// A semantic catalog digest, used to compare a fresh install against the canonical
// governed replay. A raw pg_dump digest is the wrong instrument here: PostgreSQL reprints
// an equivalent CHECK expression with different parenthesisation depending on how it was
// parsed, and physical column position reflects the order in which historical migrations
// happened to add columns. Neither is a semantic property. Everything that does carry
// meaning is compared exactly: every column with its type, nullability and default, every
// index, constraint, trigger, function and enum label.
const SEMANTIC_CATALOG_QUERY = (schema) => `
WITH columns AS (
  SELECT 'column|'||c.relname||'|'||a.attname||'|'
         ||replace(format_type(a.atttypid, a.atttypmod), '${schema}.', '')||'|'
         ||(CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END)||'|'
         ||replace(coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), '${schema}.', '') AS row
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname='${schema}' AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped
    AND c.relname <> '_prisma_migrations'
), indexes AS (
  SELECT 'index|'||indexname||'|'||replace(indexdef, '${schema}.', '') AS row
  FROM pg_indexes WHERE schemaname='${schema}' AND tablename <> '_prisma_migrations'
), constraints AS (
  SELECT 'constraint|'||(c.contype::text)||'|'||c.conname||'|'||replace(pg_get_constraintdef(c.oid), '${schema}.', '') AS row
  FROM pg_constraint c
  JOIN pg_class r ON r.oid=c.conrelid
  JOIN pg_namespace n ON n.oid=r.relnamespace
  WHERE n.nspname='${schema}' AND r.relname <> '_prisma_migrations'
), triggers AS (
  SELECT 'trigger|'||t.tgname||'|'||replace(pg_get_triggerdef(t.oid), '${schema}.', '') AS row
  FROM pg_trigger t
  JOIN pg_class c ON c.oid=t.tgrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='${schema}' AND NOT t.tgisinternal
), functions AS (
  SELECT 'function|'||p.proname||'|'||md5(replace(pg_get_functiondef(p.oid), '${schema}.', '')) AS row
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='${schema}'
), enums AS (
  SELECT 'enum|'||t.typname||'|'||e.enumlabel||'|'||e.enumsortorder AS row
  FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
  JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='${schema}'
)
SELECT row FROM (
  SELECT row FROM columns UNION ALL SELECT row FROM indexes UNION ALL SELECT row FROM constraints
  UNION ALL SELECT row FROM triggers UNION ALL SELECT row FROM functions UNION ALL SELECT row FROM enums
) catalog ORDER BY row`

// PostgreSQL's deparser is not idempotent for boolean expressions: a CHECK written as
// `((a) AND (b)) AND (c)` is reprinted as `((a) AND (b) AND (c))` once it has made a round
// trip through pg_get_constraintdef. That is pure re-association and carries no meaning,
// but deleting every parenthesis to paper over it would also erase real grouping, which is
// the one thing worth checking on 83 reconstructed CHECK constraints. So parse the
// expression instead and flatten only same-operator nesting, leaving AND/OR mixing,
// operand order and string literals intact.
export function normalizeBooleanExpression(expression) {
  const literals = []
  const masked = expression.replace(/'(?:[^']|'')*'/gu, (literal) => {
    literals.push(literal)
    return ` ${literals.length - 1} `
  })
  const tokens = masked.match(/\(|\)|\bAND\b|\bOR\b|[^()]+?(?=\(|\)|\bAND\b|\bOR\b|$)/gu) ?? []
  let position = 0
  const parseSequence = () => {
    const parts = []
    while (position < tokens.length) {
      const token = tokens[position]
      if (token === ')') break
      position += 1
      if (token === '(') {
        const inner = parseSequence()
        assert(tokens[position] === ')', `unbalanced parentheses in expression: ${expression}`)
        position += 1
        parts.push(inner)
      } else if (token === 'AND' || token === 'OR') {
        parts.push({ operator: token })
      } else {
        const atom = token.replace(/\s+/gu, ' ').trim()
        if (atom) parts.push({ atom })
      }
    }
    return { sequence: parts }
  }
  const render = (node) => {
    if (node.atom !== undefined) return node.atom
    if (node.operator !== undefined) return node.operator
    // A group whose only content is one group collapses; a group joined by the same
    // operator as its parent is flattened by the parent when it renders.
    const rendered = node.sequence.map(render).filter((part) => part !== '')
    const operators = new Set(node.sequence.filter((part) => part.operator).map((part) => part.operator))
    const body = rendered.join(' ')
    if (node.sequence.length === 1) return body
    return operators.size === 1 ? `[${[...operators][0]} ${body}]` : `(${body})`
  }
  const flatten = (text) => {
    let previous
    let current = text
    do {
      previous = current
      // `[AND x [AND y z]]` and `[AND [AND x y] z]` collapse to `[AND x y z]`.
      current = current
        .replace(/\[AND ([^\][]*)\[AND ([^\][]*)\]/gu, '[AND $1$2')
        .replace(/\[OR ([^\][]*)\[OR ([^\][]*)\]/gu, '[OR $1$2')
    } while (current !== previous)
    return current
  }
  const normalized = flatten(render(parseSequence()))
    .replace(/\s+/gu, ' ')
    .replace(/\s*\bAND\b\s*/gu, ' AND ')
    .replace(/\s*\bOR\b\s*/gu, ' OR ')
    .trim()
  return normalized.replace(/ (\d+) /gu, (_, index) => literals[Number(index)])
}

function semanticCatalogRows(databaseUrl, schema) {
  assert(/^[a-z0-9_]+$/u.test(schema), `unsafe schema name for the semantic catalog digest: ${schema}`)
  const output = query(databaseUrl, SEMANTIC_CATALOG_QUERY(schema))
  const rows = output.split('\n').filter((row) => row.length > 0).map((row) => {
    if (!row.startsWith('constraint|c|')) return row
    const [kind, contype, name, ...rest] = row.split('|')
    return [kind, contype, name, normalizeBooleanExpression(rest.join('|'))].join('|')
  })
  assert(rows.length > 0, `semantic catalog is empty for ${schema}`)
  return rows.sort()
}

function semanticCatalogDigest(databaseUrl, schema) {
  const rows = semanticCatalogRows(databaseUrl, schema)
  return `${createHash('sha256').update(rows.join('\n')).digest('hex')}|${rows.length}`
}

function runPostgresClient(program, args, options) {
  if (postgresClientContainer) return spawnSync('docker', ['exec', postgresClientContainer, program, ...args], options)
  return spawnSync(program === 'psql' ? psql : pgDump, args, options)
}

function assertOutboxSane(databaseUrl, schema) {
  const qualified = `"${schema}"."domain_outbox_events"`
  const result = query(databaseUrl, `SELECT json_build_object('total', count(*), 'invalid_statuses', count(*) FILTER (WHERE status NOT IN ('pending','processing','retry_wait','published','dead_letter')), 'negative_attempts', count(*) FILTER (WHERE attempts < 0))::text FROM ${qualified}`)
  const outbox = JSON.parse(result)
  assert(outbox.total === 0 && outbox.invalid_statuses === 0 && outbox.negative_attempts === 0, `outbox sanity mismatch: ${result}`)
  return outbox
}

function runPrismaAllowingFailure(workspace, databaseUrl, args) {
  return spawnSync(prisma, args, {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  })
}

async function activeMigrationWorkspace(exclude = new Set()) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'yoko-reconstruction-'))
  await mkdir(path.join(workspace, 'migrations'), { recursive: true })
  await copyFile(path.join(root, 'gravity-mvp/prisma/schema.prisma'), path.join(workspace, 'schema.prisma'))
  const source = path.join(root, 'gravity-mvp/prisma/migrations')
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === 'migration_lock.toml') {
      await copyFile(path.join(source, entry.name), path.join(workspace, 'migrations', entry.name))
      continue
    }
    if (!entry.isDirectory() || exclude.has(entry.name)) continue
    const destination = path.join(workspace, 'migrations', entry.name, 'migration.sql')
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(path.join(source, entry.name, 'migration.sql'), destination)
  }
  return workspace
}

async function productionBaseline(databaseUrl, schema, appliedMigrations) {
  assertSchemaAbsent(databaseUrl, schema)
  query(databaseUrl, `CREATE SCHEMA "${schema}"`)
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'yoko-reconstruction-baseline-'))
  await mkdir(path.join(workspace, 'migrations'), { recursive: true })
  await copyFile(path.join(root, 'gravity-mvp/prisma/schema.prisma'), path.join(workspace, 'schema.prisma'))
  await copyFile(
    path.join(root, 'gravity-mvp/prisma/migrations/migration_lock.toml'),
    path.join(workspace, 'migrations/migration_lock.toml'),
  )
  for (const row of appliedMigrations) {
    const destination = path.join(workspace, 'migrations', row.name, 'migration.sql')
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(canonicalSource(root, row), destination)
  }
  const url = new URL(databaseUrl)
  url.searchParams.set('schema', schema)
  runPrisma(workspace, url.toString(), ['migrate', 'deploy', '--schema', 'schema.prisma'])
  await rm(workspace, { recursive: true, force: true })
  return url.toString()
}

// Proves the reconstruction contract end to end against real PostgreSQL:
//
//   empty database    -> the active migration directory alone reaches datamodel parity
//                        AND catalog parity with the canonical governed replay
//   production        -> resolve --applied then deploy mutates nothing
//   production        -> a direct deploy without resolve is REFUSED, catalog untouched
async function assertFreshInstallReconstruction(databaseUrl, schema, appliedMigrations, reconstructionMigrations) {
  const canonicalDigest = semanticCatalogDigest(databaseUrl, schema)
  assert(reconstructionMigrations.length > 0, 'reconstruction proof requires at least one reconstruction source migration')
  const names = reconstructionMigrations.map((row) => row.name)
  assert(names.every((name) => /^[0-9a-z_]+$/u.test(name)), 'reconstruction source migration name is unsafe')
  const freshSchema = `${schema}_rc_fresh`
  const productionSchema = `${schema}_rc_prod`
  const withoutSchema = `${schema}_rc_main`
  const refusedSchema = `${schema}_rc_refused`
  for (const candidate of [freshSchema, productionSchema, withoutSchema, refusedSchema]) {
    assert(Buffer.byteLength(candidate) <= 63, `reconstruction proof schema name exceeds PostgreSQL's identifier limit: ${candidate}`)
  }
  const workspaces = []
  try {
    // 1. Fresh install from the active migration directory alone.
    assertSchemaAbsent(databaseUrl, freshSchema)
    query(databaseUrl, `CREATE SCHEMA "${freshSchema}"`)
    const freshWorkspace = await activeMigrationWorkspace()
    workspaces.push(freshWorkspace)
    const freshUrl = new URL(databaseUrl)
    freshUrl.searchParams.set('schema', freshSchema)
    runPrisma(freshWorkspace, freshUrl.toString(), ['migrate', 'deploy', '--schema', 'schema.prisma'])
    assertPrismaDatamodelParity(freshWorkspace, freshUrl.toString())
    const freshDigest = semanticCatalogDigest(databaseUrl, freshSchema)
    assert(freshDigest === canonicalDigest,
      `fresh install from the active migration directory differs from the canonical governed replay catalog (${freshDigest} vs ${canonicalDigest})`)

    // 2. Production baseline, canonical resolve-only reconciliation.
    const productionUrl = await productionBaseline(databaseUrl, productionSchema, appliedMigrations)
    const productionBefore = semanticCatalogDigest(databaseUrl, productionSchema)
    const productionWorkspace = await activeMigrationWorkspace()
    workspaces.push(productionWorkspace)
    for (const name of names) {
      runPrisma(productionWorkspace, productionUrl, ['migrate', 'resolve', '--applied', name, '--schema', 'schema.prisma'])
    }
    runPrisma(productionWorkspace, productionUrl, ['migrate', 'deploy', '--schema', 'schema.prisma'])
    const productionAfter = semanticCatalogDigest(databaseUrl, productionSchema)

    // The same baseline advanced by main without any reconstruction migration.
    const withoutUrl = await productionBaseline(databaseUrl, withoutSchema, appliedMigrations)
    const withoutWorkspace = await activeMigrationWorkspace(new Set(names))
    workspaces.push(withoutWorkspace)
    runPrisma(withoutWorkspace, withoutUrl, ['migrate', 'deploy', '--schema', 'schema.prisma'])
    const withoutDigest = semanticCatalogDigest(databaseUrl, withoutSchema)
    assert(productionAfter === withoutDigest,
      'resolve-only reconciliation mutated the production catalog beyond what the same baseline reaches without the reconstruction migration')

    // 3. A direct deploy without resolve must be refused, leaving the catalog untouched.
    const refusedUrl = await productionBaseline(databaseUrl, refusedSchema, appliedMigrations)
    // The refusal only means something if this baseline really is a production-shaped
    // catalog that already carries the reconstructed objects, so pin it to the identically
    // built baseline used by the resolve-only arm.
    const refusedBefore = semanticCatalogDigest(databaseUrl, refusedSchema)
    assert(refusedBefore === productionBefore,
      'the refusal fixture is not the same production-shaped baseline as the resolve-only arm')
    const refusedWorkspace = await activeMigrationWorkspace()
    workspaces.push(refusedWorkspace)
    const refused = runPrismaAllowingFailure(refusedWorkspace, refusedUrl, ['migrate', 'deploy', '--schema', 'schema.prisma'])
    assert(refused.status !== 0, 'a direct deploy of the reconstruction migration against a production catalog was not refused')
    // A non-zero exit alone proves nothing: without the precondition the first ALTER TABLE
    // would fail anyway. Bind to what the migration itself raises - its own message and the
    // SQLSTATE it declares - rather than to whether Prisma chooses to surface a PostgreSQL
    // HINT, which is not a Prisma contract.
    const refusedOutput = `${refused.stdout}\n${refused.stderr}`
    for (const name of names) {
      assert(refusedOutput.includes(`Reconstruction migration ${name} refused`),
        `the refusal does not come from the reconstruction precondition: ${name}`)
    }
    assert(/\b42P07\b/u.test(refusedOutput),
      'the refusal does not carry the duplicate_table SQLSTATE the precondition declares')
    assert(refusedOutput.includes('migrate resolve --applied'),
      'the refusal does not name the authorized reconciliation procedure')
    // Migrations that legitimately precede the reconstruction migration still apply, so
    // the guarantee is narrower and exact: the reconstruction migration's own DDL never
    // ran. The refused catalog must equal what the same baseline reaches with the
    // reconstruction migration absent entirely, and its ledger row must not be finished.
    const refusedAfter = semanticCatalogDigest(databaseUrl, refusedSchema)
    assert(refusedAfter === withoutDigest,
      'the refused deploy mutated the catalog beyond what the same baseline reaches without the reconstruction migration')
    for (const name of names) {
      const finished = query(refusedUrl, `SELECT count(*) FROM "${refusedSchema}"."_prisma_migrations" WHERE migration_name = '${name}' AND finished_at IS NOT NULL`)
      assert(finished === '0', `the refused reconstruction migration was recorded as finished: ${name}`)
    }

    return {
      fresh_install_catalog_matches_canonical_replay: true,
      production_baseline_advanced_by_pending_source: productionBefore !== withoutDigest,
      production_resolve_only_catalog_unchanged: productionAfter === withoutDigest,
      direct_production_execution_refused: true,
      refusal_names_resolve_procedure: true,
      refused_catalog_matches_reconstruction_absent: refusedAfter === withoutDigest,
      refusal_fixture_matches_production_baseline: refusedBefore === productionBefore,
      refused_migration_not_finished: true,
      reconstruction_migrations: names.length,
    }
  } finally {
    for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true })
    for (const candidate of [freshSchema, productionSchema, withoutSchema, refusedSchema]) {
      query(databaseUrl, `DROP SCHEMA IF EXISTS "${candidate}" CASCADE`)
    }
  }
}

async function assertPendingMigrationAtomicRollback(databaseUrl, schema, appliedMigrations, pendingMigrations) {
  assert(pendingMigrations.length === 1, 'atomic rollback proof requires the exact single pending source migration')
  const pending = pendingMigrations[0]
  assert(/^[0-9a-z_]+$/u.test(pending.name), 'pending source migration name is unsafe')
  const rollbackSchema = `${schema}_rollback`
  assert(/^[a-z0-9_]+$/u.test(rollbackSchema) && Buffer.byteLength(rollbackSchema) <= 63, 'atomic rollback proof schema is invalid')
  assertSchemaAbsent(databaseUrl, rollbackSchema)
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'yoko-pending-migration-rollback-'))
  try {
    query(databaseUrl, `CREATE SCHEMA "${rollbackSchema}"`)
    await mkdir(path.join(workspace, 'migrations', pending.name), { recursive: true })
    await copyFile(path.join(root, 'gravity-mvp/prisma/schema.prisma'), path.join(workspace, 'schema.prisma'))
    await copyFile(
      path.join(root, 'gravity-mvp/prisma/migrations/migration_lock.toml'),
      path.join(workspace, 'migrations/migration_lock.toml'),
    )
    for (const row of appliedMigrations) {
      const destination = path.join(workspace, 'migrations', row.name, 'migration.sql')
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(canonicalSource(root, row), destination)
    }
    const source = await readFile(canonicalSource(root, pending), 'utf8')
    assert(/(?:^|\n)BEGIN;\n/u.test(source), 'pending source migration lacks an explicit transaction start')
    const commitOffset = source.lastIndexOf('\nCOMMIT;')
    assert(commitOffset >= 0 && source.slice(commitOffset).trim() === 'COMMIT;', 'pending source migration lacks one terminal transaction commit')
    // Keep the explicit BEGIN but omit the canonical terminal COMMIT from the
    // temporary failing copy so Prisma surfaces the intended late error rather
    // than PostgreSQL's secondary "transaction is aborted" error at COMMIT.
    const injected = `${source.slice(0, commitOffset)}\nSELECT 1 / 0; -- deterministic late failure proof\n`
    const migrationPath = path.join(workspace, 'migrations', pending.name, 'migration.sql')
    await writeFile(migrationPath, injected)
    const rollbackUrl = new URL(databaseUrl)
    rollbackUrl.searchParams.set('schema', rollbackSchema)
    const failed = spawnSync(prisma, ['migrate', 'deploy', '--schema', 'schema.prisma'], {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: rollbackUrl.toString() },
    })
    assert(
      failed.status !== 0
        && /(?:division by zero|current transaction is aborted)/u.test(`${failed.stdout}\n${failed.stderr}`),
      `late Prisma migration failure was not injected (exit ${failed.status}):\n${failed.stdout}\n${failed.stderr}`,
    )
    const failedLedger = JSON.parse(query(databaseUrl, `
      SELECT json_build_object(
        'total', count(*),
        'unfinished', count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL),
        'rolled_back', count(*) FILTER (WHERE rolled_back_at IS NOT NULL)
      )::text
      FROM "${rollbackSchema}"._prisma_migrations
      WHERE migration_name='${pending.name}'
    `))
    assert(failedLedger.total === 1 && failedLedger.unfinished === 1 && failedLedger.rolled_back === 0,
      `failed Prisma migration ledger transition mismatch: ${JSON.stringify(failedLedger)}`)
    const campaignTableNames = "'AiCallCampaign','AiCallCampaignMember','AiCallCampaignAttempt','AiCallAdmissionControl','AiCallAdmissionLease','AiCallCampaignAuditEvent'"
    const remainingCampaignTables = query(databaseUrl, `SELECT count(*) FROM information_schema.tables WHERE table_schema='${rollbackSchema}' AND table_name IN (${campaignTableNames})`)
    assert(remainingCampaignTables === '0', `failed pending migration left ${remainingCampaignTables} partial AI Call tables`)
    const remainingCallColumn = query(databaseUrl, `SELECT count(*) FROM information_schema.columns WHERE table_schema='${rollbackSchema}' AND table_name='Call' AND column_name='isSimulation'`)
    assert(remainingCallColumn === '0', 'failed pending migration left Call.isSimulation behind')
    const remainingIndexes = query(databaseUrl, `SELECT count(*) FROM pg_indexes WHERE schemaname='${rollbackSchema}' AND (tablename IN (${campaignTableNames}) OR indexname='Call_isSimulation_startedAt_idx')`)
    assert(remainingIndexes === '0', `failed pending migration left ${remainingIndexes} campaign/simulation indexes behind`)

    runPrisma(workspace, rollbackUrl.toString(), [
      'migrate', 'resolve', '--rolled-back', pending.name, '--schema', 'schema.prisma',
    ])
    const resolvedLedger = JSON.parse(query(databaseUrl, `
      SELECT json_build_object(
        'unfinished', count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL),
        'rolled_back', count(*) FILTER (WHERE rolled_back_at IS NOT NULL)
      )::text
      FROM "${rollbackSchema}"._prisma_migrations
      WHERE migration_name='${pending.name}'
    `))
    assert(resolvedLedger.unfinished === 0 && resolvedLedger.rolled_back === 1,
      `Prisma migrate resolve ledger transition mismatch: ${JSON.stringify(resolvedLedger)}`)

    await writeFile(migrationPath, source)
    runPrisma(workspace, rollbackUrl.toString(), ['migrate', 'deploy', '--schema', 'schema.prisma'])
    runPrisma(workspace, rollbackUrl.toString(), ['migrate', 'status', '--schema', 'schema.prisma'])
    assert(finishedMigrationCount(rollbackUrl.toString(), rollbackSchema) === appliedMigrations.length + 1,
      'resolved pending migration retry did not produce the exact finished migration denominator')
    const appliedCampaignTables = query(databaseUrl, `SELECT count(*) FROM information_schema.tables WHERE table_schema='${rollbackSchema}' AND table_name IN (${campaignTableNames})`)
    assert(appliedCampaignTables === '6', `resolved pending migration retry created ${appliedCampaignTables}/6 AI Call tables`)
    const appliedCallColumn = query(databaseUrl, `SELECT count(*) FROM information_schema.columns WHERE table_schema='${rollbackSchema}' AND table_name='Call' AND column_name='isSimulation'`)
    assert(appliedCallColumn === '1', 'resolved pending migration retry did not create Call.isSimulation')
    const forbiddenCallIndex = query(databaseUrl, `SELECT count(*) FROM pg_indexes WHERE schemaname='${rollbackSchema}' AND indexname='Call_isSimulation_startedAt_idx'`)
    assert(forbiddenCallIndex === '0', 'pending migration unexpectedly created the blocking Call simulation index')
    assertPrismaDatamodelParity(workspace, rollbackUrl.toString())
    runPrisma(workspace, rollbackUrl.toString(), ['migrate', 'deploy', '--schema', 'schema.prisma'])
    assert(finishedMigrationCount(rollbackUrl.toString(), rollbackSchema) === appliedMigrations.length + 1,
      'resolved pending migration retry is not rerun-safe')
    return {
      injected_late_failure: true,
      prisma_failed_ledger_rows: 1,
      prisma_resolved_rolled_back_rows: 1,
      partial_campaign_tables: 0,
      partial_call_columns: 0,
      partial_indexes: 0,
      retry_finished_migrations: appliedMigrations.length + 1,
      retry_campaign_tables: 6,
      retry_call_simulation_column: true,
      retry_schema_prisma_parity: true,
      retry_rerun_safe: true,
      transaction_rolled_back: true,
    }
  } finally {
    query(databaseUrl, `DROP SCHEMA IF EXISTS "${rollbackSchema}" CASCADE`)
    await rm(workspace, { recursive: true, force: true })
  }
}

async function main() {
  const requestedDatabaseUrl = process.env.DATABASE_URL
  const predecessorRecovery = process.argv.includes('--predecessor-recovery')
  assert(process.argv.includes('--allow-isolated-replay'), 'pass --allow-isolated-replay to execute against an isolated empty schema')
  assert(requestedDatabaseUrl, 'DATABASE_URL is required for isolated replay')
  const { databaseUrl, schema } = isolatedSchema(requestedDatabaseUrl, predecessorRecovery)
  assertSchemaAbsent(databaseUrl, schema)
  if (predecessorRecovery) assertSchemaAbsent(databaseUrl, `${schema}_fresh`)
  const authority = await validateProductionMigrationAuthority(root)
  const inventory = JSON.parse(await readFile(path.join(root, 'architecture/migrations/v1/production-migration-authority.json'), 'utf8'))
  const pending = JSON.parse(await readFile(path.join(root, PENDING_SOURCE_PATH), 'utf8'))
  // Reconstruction migrations are deliberately absent from the canonical replay: they
  // reproduce history the archive already replays, so including them here would collide.
  // They are proved separately by assertFreshInstallReconstruction.
  const reconstruction = await readReconstructionSourceMigrations(root)
  const completeSourceInventory = [...inventory.migrations, ...pending.migrations]
  const migrations = predecessorRecovery
    ? inventory.migrations.filter((row) => row.name !== inventory.current_target.name)
    : completeSourceInventory
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'yoko-production-migration-replay-'))
  try {
    await mkdir(path.join(workspace, 'migrations'), { recursive: true })
    await copyFile(path.join(root, 'gravity-mvp/prisma/schema.prisma'), path.join(workspace, 'schema.prisma'))
    await copyFile(path.join(root, 'gravity-mvp/prisma/migrations/migration_lock.toml'), path.join(workspace, 'migrations/migration_lock.toml'))
    for (const row of migrations) {
      const destination = path.join(workspace, 'migrations', row.name, 'migration.sql')
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(canonicalSource(root, row), destination)
    }
    runPrisma(workspace, databaseUrl, ['migrate', 'deploy', '--schema', 'schema.prisma'])
    runPrisma(workspace, databaseUrl, ['migrate', 'status', '--schema', 'schema.prisma'])
    const finished = finishedMigrationCount(databaseUrl, schema)
    assert(finished === migrations.length, `fresh replay finished ${finished}/${migrations.length} canonical migrations`)
    let freshOutbox = null
    let pendingAtomicRollback = null
    let freshInstallReconstruction = null
    if (!predecessorRecovery) {
      freshOutbox = assertOutboxSane(databaseUrl, schema)
      assertPrismaDatamodelParity(workspace, databaseUrl)
      pendingAtomicRollback = await assertPendingMigrationAtomicRollback(
        databaseUrl,
        schema,
        inventory.migrations,
        pending.migrations,
      )
      freshInstallReconstruction = await assertFreshInstallReconstruction(
        databaseUrl,
        schema,
        inventory.migrations,
        reconstruction.migrations,
      )
    }
    let recovery = null
    if (predecessorRecovery) {
      const target = inventory.migrations.find((row) => row.name === inventory.current_target.name)
      const destination = path.join(workspace, 'migrations', target.name, 'migration.sql')
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(canonicalSource(root, target), destination)
      for (const row of pending.migrations) {
        const pendingDestination = path.join(workspace, 'migrations', row.name, 'migration.sql')
        await mkdir(path.dirname(pendingDestination), { recursive: true })
        await copyFile(canonicalSource(root, row), pendingDestination)
      }
      runPrisma(workspace, databaseUrl, ['migrate', 'deploy', '--schema', 'schema.prisma'])
      const recoveredFinished = finishedMigrationCount(databaseUrl, schema)
      assert(recoveredFinished === completeSourceInventory.length, `predecessor recovery finished ${recoveredFinished}/${completeSourceInventory.length} applied plus pending-source migrations`)
      const outbox = assertOutboxSane(databaseUrl, schema)
      const recoveredCatalogDigest = schemaCatalogDigest(databaseUrl, schema)
      assertPrismaDatamodelParity(workspace, databaseUrl)

      const referenceUrl = new URL(databaseUrl)
      referenceUrl.searchParams.set('schema', `${schema}_fresh`)
      const referenceWorkspace = await mkdtemp(path.join(os.tmpdir(), 'yoko-production-migration-reference-'))
      try {
        await mkdir(path.join(referenceWorkspace, 'migrations'), { recursive: true })
        await copyFile(path.join(root, 'gravity-mvp/prisma/schema.prisma'), path.join(referenceWorkspace, 'schema.prisma'))
        await copyFile(path.join(root, 'gravity-mvp/prisma/migrations/migration_lock.toml'), path.join(referenceWorkspace, 'migrations/migration_lock.toml'))
        for (const row of completeSourceInventory) {
          const referenceDestination = path.join(referenceWorkspace, 'migrations', row.name, 'migration.sql')
          await mkdir(path.dirname(referenceDestination), { recursive: true })
          await copyFile(canonicalSource(root, row), referenceDestination)
        }
        runPrisma(referenceWorkspace, referenceUrl.toString(), ['migrate', 'deploy', '--schema', 'schema.prisma'])
        runPrisma(referenceWorkspace, referenceUrl.toString(), ['migrate', 'status', '--schema', 'schema.prisma'])
        assert(finishedMigrationCount(referenceUrl.toString(), `${schema}_fresh`) === completeSourceInventory.length, 'fresh reference did not finish all applied plus pending-source migrations')
        assertOutboxSane(referenceUrl.toString(), `${schema}_fresh`)
        const referenceCatalogDigest = schemaCatalogDigest(referenceUrl.toString(), `${schema}_fresh`)
        assertPrismaDatamodelParity(referenceWorkspace, referenceUrl.toString())
        assert(recoveredCatalogDigest === referenceCatalogDigest, 'predecessor recovery schema catalog differs from fresh canonical replay')
        recovery = { predecessor_finished_migrations: finished, recovered_finished_migrations: recoveredFinished, outbox, schema_catalog_digest: recoveredCatalogDigest, fresh_catalog_digest: referenceCatalogDigest, current_schema_prisma_parity: true }
      } finally {
        await rm(referenceWorkspace, { recursive: true, force: true })
      }
    }
    runPrisma(workspace, databaseUrl, ['migrate', 'deploy', '--schema', 'schema.prisma'])
    await writeFile(path.join(workspace, 'replay-proof.json'), `${JSON.stringify({
      schema,
      status: 'PASS',
      predecessor_recovery: predecessorRecovery,
      rerun_safe: true,
      fresh_finished_migrations: finished,
      recovery,
      exact_source_checksum_parity: true,
      pending_source_migrations: pending.migrations.length,
      current_schema_prisma_parity: true,
      fresh_outbox: freshOutbox,
      pending_atomic_rollback: pendingAtomicRollback,
      fresh_install_reconstruction: freshInstallReconstruction,
      ...authority,
    }, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify({ status: 'PASS', schema, predecessor_recovery: predecessorRecovery, rerun_safe: true, fresh_finished_migrations: finished, recovery, fresh_outbox: freshOutbox, pending_atomic_rollback: pendingAtomicRollback, fresh_install_reconstruction: freshInstallReconstruction, exact_source_checksum_parity: true, pending_source_migrations: pending.migrations.length, reconstruction_source_migrations: reconstruction.migrations.length, current_schema_prisma_parity: true, ...authority })}\n`)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
