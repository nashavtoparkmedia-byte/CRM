#!/usr/bin/env node
import { mkdtemp, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateProductionMigrationAuthority } from './production-migration-authority.mjs'

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
  const migrations = predecessorRecovery
    ? inventory.migrations.filter((row) => row.name !== inventory.current_target.name)
    : inventory.migrations
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
    if (!predecessorRecovery) {
      freshOutbox = assertOutboxSane(databaseUrl, schema)
      assertPrismaDatamodelParity(workspace, databaseUrl)
    }
    let recovery = null
    if (predecessorRecovery) {
      const target = inventory.migrations.find((row) => row.name === inventory.current_target.name)
      const destination = path.join(workspace, 'migrations', target.name, 'migration.sql')
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(canonicalSource(root, target), destination)
      runPrisma(workspace, databaseUrl, ['migrate', 'deploy', '--schema', 'schema.prisma'])
      const recoveredFinished = finishedMigrationCount(databaseUrl, schema)
      assert(recoveredFinished === inventory.migrations.length, `predecessor recovery finished ${recoveredFinished}/${inventory.migrations.length} canonical migrations`)
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
        for (const row of inventory.migrations) {
          const referenceDestination = path.join(referenceWorkspace, 'migrations', row.name, 'migration.sql')
          await mkdir(path.dirname(referenceDestination), { recursive: true })
          await copyFile(canonicalSource(root, row), referenceDestination)
        }
        runPrisma(referenceWorkspace, referenceUrl.toString(), ['migrate', 'deploy', '--schema', 'schema.prisma'])
        runPrisma(referenceWorkspace, referenceUrl.toString(), ['migrate', 'status', '--schema', 'schema.prisma'])
        assert(finishedMigrationCount(referenceUrl.toString(), `${schema}_fresh`) === inventory.migrations.length, 'fresh reference did not finish all canonical migrations')
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
      current_schema_prisma_parity: true,
      fresh_outbox: freshOutbox,
      ...authority,
    }, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify({ status: 'PASS', schema, predecessor_recovery: predecessorRecovery, rerun_safe: true, fresh_finished_migrations: finished, recovery, fresh_outbox: freshOutbox, exact_source_checksum_parity: true, current_schema_prisma_parity: true, ...authority })}\n`)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
