#!/usr/bin/env node
import assert from 'node:assert/strict'

import { mixedSqlFragments, standaloneSqlSites } from './analyze.mjs'

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

for (const command of [
  'npx prisma migrate deploy',
  'npx prisma migrate resolve --applied 20260101_init',
  'npx prisma db push',
]) {
  const sites = standaloneSqlSites({ path: 'migration.sh' }, command, true)
  assert.equal(sites.length, 1, command)
  assert(sites[0].ambiguity_reasons.includes('dynamic_database_command_requires_review'))
}

process.stdout.write('repository analyzer mixed-language tests: PASS\n')
