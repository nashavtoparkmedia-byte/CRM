#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import {
  analyzeJavaScriptSurfaceIsolated,
  isolatedExecutionOptions,
  javascriptDatabaseCommandSites,
  mixedDatabaseCommandSinks,
  mixedSqlFragments,
  standaloneSqlSites,
} from './analyze.mjs'
import { classifyTrackedSurface } from './tracked-surface-inventory.mjs'
import { analyzePrismaWriteSites } from './write-analyzer.mjs'

const shellSurface = { path: 'scripts/reconcile.sh' }
const shell = String.raw`#!/usr/bin/env bash
apt update
python -c "value.replace('old', 'new')"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO app;"
`
const shellSites = standaloneSqlSites(shellSurface, shell, true)
assert.deepEqual(shellSites.map((site) => site.operations[0].operation), [
  'DROP_SCHEMA', 'CREATE_SCHEMA', 'GRANT',
])
assert(shellSites.every((site) => site.ambiguous))

const continuedShell = String.raw`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO app;"`
assert.deepEqual(
  standaloneSqlSites(shellSurface, continuedShell, true).map((site) => site.operations[0].operation),
  ['DROP_SCHEMA', 'CREATE_SCHEMA', 'GRANT'],
)

const restore = String.raw`psql postgres <<SQL
DROP DATABASE IF EXISTS crm;
CREATE DATABASE crm;
SQL`
const restoreSites = standaloneSqlSites({ path: 'scripts/restore.sh' }, restore, true)
assert.deepEqual(restoreSites.map((site) => site.operations[0].operation), [
  'DROP_DATABASE', 'CREATE_DATABASE',
])

const exactRestoreSource = await readFile(new URL('../../../scripts/restore-pg.sh', import.meta.url), 'utf8')
const exactRestoreSites = standaloneSqlSites({ path: 'scripts/restore-pg.sh' }, exactRestoreSource, true)
assert.deepEqual(
  exactRestoreSites.flatMap((site) => site.operations.map((operation) => operation.operation)),
  ['DROP_DATABASE', 'CREATE_DATABASE'],
)
const restoreCommandSites = exactRestoreSites.filter((site) => site.method === 'mixed-script-command:pg_restore')
assert.equal(restoreCommandSites.length, 1)
assert.equal(exactRestoreSites.length, 3)
assert.equal(exactRestoreSites.some((site) => site.method === 'mixed-script-command:psql'), false)
assert.equal(restoreCommandSites[0].database_command_intent, 'WRITE')
assert(restoreCommandSites[0].ambiguity_reasons.includes('dynamic_database_command_requires_review'))
assert(restoreCommandSites[0].ambiguity_reasons.includes('dynamic_database_write_command_requires_review'))
assert.equal(restoreCommandSites[0].line, 87)
assert.deepEqual(
  standaloneSqlSites({ path: 'scripts/restore-pg.sh' }, exactRestoreSource, true),
  exactRestoreSites,
)
assert.equal(
  standaloneSqlSites({ path: 'scripts/dump.sh' }, 'pg_dump "$DATABASE_URL" > backup.dump', true).length,
  0,
)

const ordinary = [
  "content = content.replace('location /', 'location /api')",
  'apt update',
  'truncate the diagnostic output',
  'CALL support tomorrow',
  "logger.info('CALL support tomorrow')",
  'print("Please GRANT access to Alice tomorrow")',
  'Write-Host "REVOKE access after offboarding"',
  'echo "CREATE ROLE in the organization"',
  'print("DROP ROLE from the queue")',
].join('\n')
assert.deepEqual(mixedSqlFragments(ordinary), [])
assert.deepEqual(standaloneSqlSites({ path: 'fix.py' }, ordinary, true), [])

const dynamic = 'psql "$DATABASE_URL" -f "$RUNTIME_SQL_FILE"'
const dynamicSites = standaloneSqlSites({ path: 'dynamic.sh' }, dynamic, true)
assert.equal(dynamicSites.length, 1)
assert(dynamicSites[0].ambiguity_reasons.includes('dynamic_database_command_requires_review'))

const dynamicInline = 'psql "$DATABASE_URL" -c "$RUNTIME_SQL"'
const dynamicInlineSites = standaloneSqlSites({ path: 'dynamic-inline.sh' }, dynamicInline, true)
assert.equal(dynamicInlineSites.length, 1)
assert.equal(dynamicInlineSites[0].method, 'mixed-script-command:psql')
assert(dynamicInlineSites[0].ambiguity_reasons.includes('dynamic_database_command_requires_review'))

const dynamicHeredoc = String.raw`psql "$DATABASE_URL" <<SQL
$RUNTIME_SQL
SQL`
const dynamicHeredocSites = standaloneSqlSites({ path: 'dynamic-heredoc.sh' }, dynamicHeredoc, true)
assert.equal(dynamicHeredocSites.length, 1)
assert.equal(dynamicHeredocSites[0].method, 'mixed-script-command:psql')

const staticExecute = 'cursor.execute("UPDATE bots SET token = NULL")'
assert.equal(standaloneSqlSites({ path: 'static-execute.py' }, staticExecute, true).length, 1)
const staticReadWithReviewedFunction = `cursor.execute("SELECT current_setting('server_version_num'), system_identifier::text FROM pg_control_system()")`
const [staticReadWithReviewedFunctionSite] = standaloneSqlSites(
  { path: 'static-read.py' },
  staticReadWithReviewedFunction,
  true,
)
assert.deepEqual({
  method: staticReadWithReviewedFunctionSite.method,
  fragment_source: staticReadWithReviewedFunctionSite.fragment_source,
  read_tables: staticReadWithReviewedFunctionSite.read_tables,
  selected_columns: staticReadWithReviewedFunctionSite.selected_columns,
  sql_sha256: staticReadWithReviewedFunctionSite.sql_sha256,
}, {
  method: 'mixed-script-sql',
  fragment_source: 'embedded_database_string',
  read_tables: ['pg_control_system'],
  selected_columns: ['system_identifier', 'text'],
  sql_sha256: 'f91c4a6a6024d7a627e15e6c823a92e8ff13127b6a2574abfbb029ad71c12ad0',
})
const staticAndDynamicExecute = `${staticExecute}\ncursor.execute(runtime_sql)`
const staticAndDynamicExecuteSites = standaloneSqlSites(
  { path: 'static-dynamic-execute.py' },
  staticAndDynamicExecute,
  true,
)
assert.equal(staticAndDynamicExecuteSites.length, 2)
assert.equal(
  staticAndDynamicExecuteSites.filter((site) => site.method === 'mixed-script-command:execute').length,
  1,
)

const staticAndDynamicQuery = [
  'cursor.query("UPDATE bots SET token = NULL")',
  'cursor.query(runtime_sql)',
].join('\n')
const staticAndDynamicQuerySites = standaloneSqlSites(
  { path: 'static-dynamic-query.py' },
  staticAndDynamicQuery,
  true,
)
assert.equal(staticAndDynamicQuerySites.length, 2)
assert.equal(
  staticAndDynamicQuerySites.filter((site) => site.method === 'mixed-script-command:query').length,
  1,
)

const nestedCommands = [
  String.raw`docker exec crm-db sh -c 'pg_restore --dbname "$DATABASE_URL" "$BACKUP"'`,
  String.raw`bash -c "psql \"$DATABASE_URL\" -f \"$SQL_FILE\""`,
  String.raw`ssh deploy@db 'pg_dump "$DATABASE_URL" > backup.dump'`,
].join('\n')
assert.deepEqual(
  mixedDatabaseCommandSinks(nestedCommands).map(({ command, intent, line }) => ({ command, intent, line })),
  [
    { command: 'pg_restore', intent: 'WRITE', line: 1 },
    { command: 'psql', intent: 'UNKNOWN', line: 2 },
    { command: 'pg_dump', intent: 'READ', line: 3 },
  ],
)
assert.deepEqual(
  standaloneSqlSites({ path: 'nested-commands.sh' }, nestedCommands, true).map((site) => ({
    method: site.method,
    intent: site.database_command_intent,
  })),
  [
    { method: 'mixed-script-command:pg_restore', intent: 'WRITE' },
    { method: 'mixed-script-command:psql', intent: 'UNKNOWN' },
  ],
)
assert.deepEqual(mixedDatabaseCommandSinks('bash -c "echo pg_restore is unavailable"'), [])
assert.deepEqual(mixedDatabaseCommandSinks([
  String.raw`docker exec crm-db bash -lc 'pg_restore --dbname "$DATABASE_URL" "$BACKUP"'`,
  String.raw`dash -ec 'pg_dump "$DATABASE_URL" > backup.dump'`,
  String.raw`bash -o pipefail -c 'psql "$DATABASE_URL" -f "$SQL_FILE"'`,
  String.raw`bash -c $'pg_restore -d crm backup.dump'`,
  String.raw`bash -c $"pg_restore -d crm backup.dump"`,
].join('\n')).map(({ command, intent, line }) => ({ command, intent, line })), [
  { command: 'pg_restore', intent: 'WRITE', line: 1 },
  { command: 'pg_dump', intent: 'READ', line: 2 },
  { command: 'psql', intent: 'UNKNOWN', line: 3 },
  { command: 'pg_restore', intent: 'WRITE', line: 4 },
  { command: 'pg_restore', intent: 'WRITE', line: 5 },
])
assert.deepEqual(mixedDatabaseCommandSinks([
  String.raw`bash -c '# pg_restore --dbname crm backup.dump'`,
  String.raw`bash -lc 'true; # pg_dump crm > backup.dump'`,
  String.raw`bash -o pipefail -c 'echo ok # psql "$DATABASE_URL"'`,
].join('\n')), [])

const languageExecutionCommands = [
  "subprocess.run(['pg_restore', '-d', 'crm', 'backup.dump'])",
  "subprocess.run('pg_restore -d crm backup.dump', shell=True)",
  "os.system('pg_restore -d crm backup.dump')",
  "os.execvp('pg_restore', ['pg_restore', '-d', 'crm', 'backup.dump'])",
  'powershell -Command "pg_restore -d crm backup.dump"',
  "Start-Process 'pg_restore' -ArgumentList '-d crm backup.dump'",
  "& 'pg_restore' -d crm backup.dump",
  'cmd /c "pg_restore -d crm backup.dump"',
  `await asyncio.create_subprocess_exec(
    'pg_restore', '-d', 'crm', 'backup.dump'
  )`,
  `await asyncio.create_subprocess_shell(
    'pg_restore -d crm backup.dump'
  )`,
  `os.spawnvp(
    os.P_WAIT, 'pg_restore',
    ['pg_restore', '-d', 'crm', 'backup.dump']
  )`,
  "eval 'pg_restore -d crm backup.dump'",
  "Invoke-Expression 'pg_restore -d crm backup.dump'",
  "iex 'pg_restore -d crm backup.dump'",
]
for (const command of languageExecutionCommands) {
  assert.deepEqual(
    mixedDatabaseCommandSinks(command).map(({ command: name, intent }) => ({ name, intent })),
    [{ name: 'pg_restore', intent: 'WRITE' }],
    command,
  )
}
for (const source of [
  "exec('pg_restore -d crm backup.dump')",
  "spawn('pg_restore', ['-d', 'crm', 'backup.dump'])",
  "execFile('pg_restore', ['-d', 'crm', 'backup.dump'])",
  "import { exec } from 'node:child_process'; exec('pg_restore -d crm backup.dump')",
  "const { spawn } = require('child_process'); spawn('pg_restore', ['-d', 'crm', 'backup.dump'])",
  "const cp = require('node:child_process'); cp.execFile('pg_restore', ['-d', 'crm', 'backup.dump'])",
]) {
  assert.deepEqual(
    javascriptDatabaseCommandSites({ path: 'runner.js' }, source).map(({ method, database_command_intent }) => ({
      method,
      database_command_intent,
    })),
    [{ method: 'mixed-script-command:pg_restore', database_command_intent: 'WRITE' }],
    source,
  )
}
const detectorVocabularyBesideUnrelatedExec = [
  "import { execFile } from 'node:child_process'",
  'const databaseCommands = /(?:psql|mysql|sqlite3|sqlcmd|pg_restore)/u',
  "execFile('printf', ['ok'])",
].join('\n')
assert.deepEqual(
  javascriptDatabaseCommandSites({ path: 'detector.mjs' }, detectorVocabularyBesideUnrelatedExec),
  [],
  'regular-expression detector vocabulary is not an executable database command',
)
assert.deepEqual(
  javascriptDatabaseCommandSites({ path: 'bound-client.mjs' }, [
    "import { spawnSync } from 'node:child_process'",
    "const psql = process.env.PSQL_BIN || 'psql'",
    "const pgDump = process.env.PG_DUMP_BIN || 'pg_dump'",
    "function runClient(program, args) { return spawnSync(program === 'psql' ? psql : pgDump, args) }",
  ].join('\n')),
  [],
  'CLI fallback bindings and selector comparisons are not themselves executed database commands',
)
for (const source of [
  "import { execFile } from 'node:child_process'; const tool = /pg_restore/.source; execFile(tool, ['-d', 'crm', 'backup.dump'])",
  "import { execFile } from 'node:child_process'; const match = /pg_restore/.exec(process.env.DB_TOOL); execFile(match[0], ['-d', 'crm', 'backup.dump'])",
  "import { execFileSync } from 'node:child_process'; execFileSync(/pg_restore/.source, ['-d', 'crm', 'backup.dump'])",
]) {
  assert.deepEqual(
    javascriptDatabaseCommandSites({ path: 'regex-derived-runner.mjs' }, source).map((site) => site.method),
    ['mixed-script-command:pg_restore'],
    'regex-derived database command execution must remain visible',
  )
}
for (const source of [
  'pg_restore --help',
  'pg_restore --version',
  'pg_restore --list backup.dump',
  'pg_restore -l backup.dump',
  'psql --version',
]) assert.deepEqual(mixedDatabaseCommandSinks(source), [], source)
assert.deepEqual(mixedDatabaseCommandSinks([
  'PG_TOOL=pg_restore',
  'command -v pg_restore',
  'tools=(pg_restore pg_dump)',
].join('\n')), [])

const asyncpgStatic = "await connection.fetch('SELECT token FROM bots')"
assert.deepEqual(mixedSqlFragments(asyncpgStatic).map((fragment) => fragment.sql), [
  'SELECT token FROM bots',
])
assert.deepEqual(mixedDatabaseCommandSinks(asyncpgStatic, {
  staticFragments: mixedSqlFragments(asyncpgStatic),
}), [])
assert.deepEqual(
  mixedDatabaseCommandSinks('await connection.fetch(runtime_sql)').map(({ command, intent }) => ({ command, intent })),
  [{ command: 'fetch', intent: 'UNKNOWN' }],
)
const asyncpgCursor = "await connection.cursor('SELECT token FROM bots')"
assert.deepEqual(mixedSqlFragments(asyncpgCursor).map((fragment) => fragment.sql), [
  'SELECT token FROM bots',
])
assert.deepEqual(mixedDatabaseCommandSinks(asyncpgCursor, {
  staticFragments: mixedSqlFragments(asyncpgCursor),
}), [])
assert.deepEqual(
  mixedDatabaseCommandSinks('await connection.cursor(runtime_sql)').map(({ command, intent }) => ({ command, intent })),
  [{ command: 'cursor', intent: 'UNKNOWN' }],
)

assert.deepEqual(mixedDatabaseCommandSinks([
  'search.query(runtime)',
  'animation.execute(runtime)',
  'workflow.executeScript(runtime)',
  'browser.session.execute(runtime)',
  'page.session.query(runtime)',
].join('\n')), [])
assert.deepEqual(mixedSqlFragments([
  'search.query("SELECT token FROM bots")',
  'animation.execute("DELETE FROM ApiConnection")',
].join('\n')), [])
assert.equal(
  mixedDatabaseCommandSinks('RUN rm -rf /var/lib/apt/lists/*\nCMD ["sh", "-c", "npx prisma migrate deploy"]').some((sink) => (
    sink.command === 'prisma migrate deploy'
  )),
  true,
)
assert.equal(
  mixedDatabaseCommandSinks('RUN curl https://example.invalid/file && npx prisma migrate deploy').some((sink) => (
    sink.command === 'prisma migrate deploy'
  )),
  true,
)
assert.deepEqual(mixedDatabaseCommandSinks([
  'cursor.query(runtime_sql)',
  'connection.execute(runtime_sql)',
  'client.query(runtime_sql)',
  'db.execute(runtime_sql)',
  'pool.query(runtime_sql)',
  'engine.execute(runtime_sql)',
  'session.execute(runtime_sql)',
  'database.cursor().execute(runtime_sql)',
].join('\n')).map(({ command }) => command), [
  'query', 'execute', 'query', 'execute', 'query', 'execute', 'execute', 'execute',
])
assert.deepEqual(mixedDatabaseCommandSinks([
  'true;# pg_restore backup.dump',
  'x=1;# cursor.execute(runtime_sql)',
  'do_thing &&# pg_dump crm',
  'REM pg_restore backup.dump',
  ':: pg_restore backup.dump',
  '<# pg_restore backup.dump',
  'cursor.execute(runtime_sql)',
  '#>',
  ': <<\'COMMENT\'',
  'pg_restore backup.dump',
  'COMMENT',
].join('\n')), [])
assert.deepEqual(mixedSqlFragments([
  '# cursor.execute(',
  '"UPDATE ApiConnection SET apiKey = NULL"',
  ')',
  '// db.query("DELETE FROM bots")',
  '/* cursor.query("SELECT token FROM bots") */',
  ': <<\'COMMENT\'',
  'DELETE FROM ApiConnection',
  'COMMENT',
].join('\n')), [])
const secretMarker = 'YOKO_SECRET_MARKER_5b613e'
assert.equal(JSON.stringify(mixedDatabaseCommandSinks(
  `ssh deploy@db 'pg_dump "postgres://user:${secretMarker}@db/crm"'`,
)).includes(secretMarker), false)

assert.deepEqual(
  mixedSqlFragments([
    'cursor.query("COPY ApiConnection(apiKey) TO STDOUT")',
    'cursor.query("TABLE ApiConnection")',
  ].join('\n')).map((fragment) => fragment.sql),
  ['COPY ApiConnection(apiKey) TO STDOUT', 'TABLE ApiConnection'],
)

for (const command of [
  'npx prisma migrate deploy',
  'npx prisma migrate resolve --applied 20260101_init',
  'npx prisma db push',
]) {
  const sites = standaloneSqlSites({ path: 'migration.sh' }, command, true)
  assert.equal(sites.length, 1, command)
  assert(sites[0].ambiguity_reasons.includes('dynamic_database_command_requires_review'))
}

const declarativeRuntimeCommands = [
  'command: ["sh", "-c", "npx prisma db push --skip-generate && npm run start"]',
  'CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]',
  '{\n  "scripts": {\n    "deploy-db": "npx prisma migrate deploy"\n  }\n}',
]
assert.deepEqual(
  declarativeRuntimeCommands.flatMap((source, index) => standaloneSqlSites({
    path: index === 0 ? 'deploy/docker-compose.yml' : 'gravity-mvp/Dockerfile',
  }, source, true)).map((site) => site.method),
  ['mixed-script-command:prisma db push', 'mixed-script-command:prisma migrate deploy', 'mixed-script-command:prisma migrate deploy'],
)

const exactProductionCompose = await readFile(new URL('../../../deploy/docker-compose.production.yml', import.meta.url), 'utf8')
const exactLifecycleRegistry = JSON.parse(await readFile(new URL(
  '../../../architecture/recovery/whole-project-dod/v2/LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json',
  import.meta.url,
), 'utf8'))
const exactProductionComposeSites = standaloneSqlSites(
  { path: 'deploy/docker-compose.production.yml' },
  exactProductionCompose,
  true,
)
assert(exactProductionComposeSites.some((site) => (
  site.method === 'mixed-script-command:prisma db push' && site.line === 452
)))
const exactProductionComposeSurface = classifyTrackedSurface('deploy/docker-compose.production.yml', exactLifecycleRegistry)
assert.deepEqual({
  lifecycle: exactProductionComposeSurface.lifecycle,
  disposition: exactProductionComposeSurface.disposition,
  production_capability: exactProductionComposeSurface.production_capability,
  functional_owner: exactProductionComposeSurface.functional_owner,
  registered_source_sha256: exactProductionComposeSurface.registered_source_sha256,
  registry_classified: exactProductionComposeSurface.registry_classified,
}, {
  lifecycle: 'MIGRATION',
  disposition: 'MIGRATION_ONLY',
  production_capability: 'CONFIRMED_AUTOMATIC_DEPLOYMENT',
  functional_owner: 'fleet_operations',
  registered_source_sha256: createHash('sha256').update(exactProductionCompose).digest('hex'),
  registry_classified: true,
})
const exactGravityDockerfile = await readFile(new URL('../../../gravity-mvp/Dockerfile', import.meta.url), 'utf8')
const exactGravityDockerfileSites = standaloneSqlSites(
  { path: 'gravity-mvp/Dockerfile' },
  exactGravityDockerfile,
  true,
)
const exactGravityDockerfileMigrationLine = exactGravityDockerfile
  .slice(0, exactGravityDockerfile.lastIndexOf('npx prisma migrate deploy'))
  .split('\n').length
assert(exactGravityDockerfileSites.some((site) => (
  site.method === 'mixed-script-command:prisma migrate deploy'
  && site.line === exactGravityDockerfileMigrationLine
)))
const exactGravityDockerfileSurface = classifyTrackedSurface('gravity-mvp/Dockerfile', exactLifecycleRegistry)
assert.deepEqual({
  lifecycle: exactGravityDockerfileSurface.lifecycle,
  disposition: exactGravityDockerfileSurface.disposition,
  production_capability: exactGravityDockerfileSurface.production_capability,
  functional_owner: exactGravityDockerfileSurface.functional_owner,
  registered_source_sha256: exactGravityDockerfileSurface.registered_source_sha256,
  registry_classified: exactGravityDockerfileSurface.registry_classified,
}, {
  lifecycle: 'MIGRATION',
  disposition: 'MIGRATION_ONLY',
  production_capability: 'CONFIRMED_AUTOMATIC_DEPLOYMENT',
  functional_owner: 'production_migration_authority',
  registered_source_sha256: createHash('sha256').update(exactGravityDockerfile).digest('hex'),
  registry_classified: true,
})

const sameLineSql = 'SELECT 1; UPDATE ApiConnection SET apiKey = NULL;'
const [sameLineSite] = standaloneSqlSites({ path: 'same-line.sql' }, sameLineSql)
assert.equal(sameLineSite.line, 1)
assert.equal(sameLineSite.column, sameLineSql.indexOf('UPDATE') + 1)

const isolatedSource = [
  "import { PrismaClient } from '@prisma/client'",
  'const prisma = new PrismaClient()',
  'const delegate = (prisma.user as any)',
  'await delegate.create({ data: { profile: { create: {} } } })',
].join('\n')
const directIsolatedResult = analyzePrismaWriteSites(isolatedSource, {
  fileName: 'fixtures/isolated-cast.ts',
  knownModels: ['User'],
  relationFields: ['user.profile'],
})
const directIsolatedSites = [
  ...directIsolatedResult.sites,
  ...javascriptDatabaseCommandSites({ path: 'fixtures/isolated-cast.ts' }, isolatedSource),
]
const isolatedResult = await analyzeJavaScriptSurfaceIsolated(
  { path: 'fixtures/isolated-cast.ts', extension: '.ts' },
  isolatedSource,
  { knownModels: ['User'], relationFields: ['user.profile'], workerTimeoutMs: 5_000 },
)
assert.deepEqual(isolatedResult.sites, directIsolatedSites)
assert.deepEqual(isolatedResult.diagnostics, directIsolatedResult.diagnostics)
assert.equal(isolatedResult.source_sha256, directIsolatedResult.source_sha256)

const dynamicSqlCall = 'await prisma.$queryRaw`SELECT id FROM "User" ${fragment}`'
const safeUpstream = analyzePrismaWriteSites([
  "import { PrismaClient } from '@prisma/client'",
  'const prisma = new PrismaClient()',
  'const fragment = buildReviewedFilter()',
  dynamicSqlCall,
].join('\n'), { fileName: 'provenance.ts' }).sites[0]
const changedUpstream = analyzePrismaWriteSites([
  "import { PrismaClient } from '@prisma/client'",
  'const prisma = new PrismaClient()',
  'const fragment = attackerControlledSql()',
  dynamicSqlCall,
].join('\n'), { fileName: 'provenance.ts' }).sites[0]
assert.equal(safeUpstream.site_signature, changedUpstream.site_signature, 'fixture must retain the same call-site identity')
assert.notEqual(safeUpstream.source_sha256, changedUpstream.source_sha256, 'upstream SQL provenance mutation must change source identity')
assert.notEqual(safeUpstream.sql_provenance_sha256, changedUpstream.sql_provenance_sha256, 'upstream SQL provenance mutation must reopen proof')
assert.throws(() => isolatedExecutionOptions({ workers: 5 }), /1\.\.4/)
assert.throws(() => isolatedExecutionOptions({ workerTimeoutMs: 999 }), /1000\.\.600000/)

const analyzerImplementationSource = await readFile(new URL('./write-analyzer.mjs', import.meta.url), 'utf8')
assert.deepEqual(
  javascriptDatabaseCommandSites({ path: 'tools/architecture/v2/write-analyzer.mjs' }, analyzerImplementationSource),
  [],
)

process.stdout.write('repository analyzer mixed-language tests: PASS\n')
