#!/usr/bin/env node
import assert from 'node:assert/strict'

import {
  analyzeCredentialAccess,
  analyzeCredentialSqlAccess,
  CREDENTIAL_ENTITY_POLICIES,
} from './credential-analyzer.mjs'

const source = [
  "'use server'",
  'await prisma.apiConnection.findMany()',
  'await prisma.telegramConnection.findFirst({ select: { id: true, apiHash: true } })',
  'await prisma.whatsAppConnection.findUnique({ omit: { sessionData: true } })',
  'const projection = getProjection()',
  'await prisma.maxConnection.findFirst({ select: projection })',
  'await prisma.aiAgentConfig.count()',
  'await prisma.aiProviderSetting.update({ where: { id }, data })',
  'await prisma.$queryRaw`SELECT "token" FROM "bots"`',
  'await prisma.$queryRaw`SELECT id, name FROM "Account"`',
  'await prisma.$queryRawUnsafe(runtimeSql)',
].join('\n')

const result = analyzeCredentialAccess(source, { fileName: 'gravity-mvp/src/app/settings/actions.ts' })
assert.equal(result.schema, 'yoko.crm.credential-database-access.v2')
assert.equal(result.boundary.server_action, true)
assert.equal(result.accesses.length, 9)

const byPolicy = new Map(result.accesses.filter((entry) => entry.policy_id).map((entry) => [entry.policy_id, entry]))
assert.deepEqual(byPolicy.get('fleet.api-connection.v1').exposed_sensitive_field_names, ['apiKey'])
assert.equal(byPolicy.get('fleet.api-connection.v1').public_secret_risk, true)
assert.deepEqual(byPolicy.get('telegram.connection.v1').exposed_sensitive_field_names, ['apiHash'])
assert.deepEqual(byPolicy.get('whatsapp.connection.v1').exposed_sensitive_field_names, [])
assert.equal(byPolicy.get('whatsapp.connection.v1').credential_exposure, 'METADATA_ONLY')
assert.equal(byPolicy.get('max.connection.v1').credential_exposure, 'SECRET_READ')
assert.equal(byPolicy.get('max.connection.v1').ambiguous, true)
assert.equal(byPolicy.get('calling.ai-agent-config.v1').credential_exposure, 'METADATA_ONLY')
assert.equal(byPolicy.get('calling.ai-provider-setting.v1').credential_exposure, 'CREDENTIAL_RECORD_WRITE')
assert.deepEqual(byPolicy.get('telegram.bot-token.v1').exposed_sensitive_field_names, ['token'])
assert.equal(byPolicy.get('fleet.yfs-account.v1').credential_exposure, 'METADATA_ONLY')

const unresolved = result.accesses.find((entry) => entry.policy_id === null)
assert(unresolved)
assert.equal(unresolved.credential_exposure, 'AMBIGUOUS')
assert(unresolved.ambiguity_reasons.includes('unresolved_raw_sql_may_access_credential_entity'))

const drizzle = analyzeCredentialAccess([
  "import { authUsers, authSessions, appSettings, type Database } from '@avito/db'",
  'async function inspect(db: Database) {',
  '  await db.select({ password: authUsers.passwordHash }).from(authUsers)',
  '  await db.select().from(authSessions)',
  '  await db.query.appSettings.findMany({ columns: { key: true } })',
  '}',
].join('\n'), { fileName: 'avito/src/inspect.ts' })
assert.deepEqual(drizzle.accesses.map((entry) => [entry.policy_id, entry.credential_exposure]), [
  ['avito.password-hash.v1', 'SECRET_READ'],
  ['avito.session-token.v1', 'SECRET_READ'],
  ['avito.application-settings.v1', 'METADATA_ONLY'],
])

const unresolvedModel = analyzeCredentialAccess('await prisma[modelName].findMany()', {
  fileName: 'runtime.ts',
})
assert.equal(unresolvedModel.accesses.length, 1)
assert(unresolvedModel.accesses[0].ambiguity_reasons.includes('unresolved_model_read_may_access_credential_entity'))

const safe = JSON.stringify(result)
assert(!safe.includes('runtimeSql'))
assert(!safe.includes("'use server'"))
assert(!Object.values(CREDENTIAL_ENTITY_POLICIES).some((policy) => Object.hasOwn(policy, 'value')))

const sql = analyzeCredentialSqlAccess('SELECT apiKey FROM ApiConnection; UPDATE bots SET token = NULL', {
  fileName: 'migration.sql',
})
assert.deepEqual(sql.accesses.map((entry) => [entry.policy_id, entry.access, entry.credential_exposure]), [
  ['fleet.api-connection.v1', 'READ', 'SECRET_READ'],
  ['telegram.bot-token.v1', 'WRITE', 'CREDENTIAL_RECORD_WRITE'],
])
assert(!JSON.stringify(sql).includes('SELECT apiKey'))

const derivedRows = [
  'SELECT row_to_json(connection) FROM ApiConnection connection;',
  'SELECT COUNT(*) FROM TelegramConnection;',
  'SELECT connection FROM WhatsAppConnection AS connection;',
].flatMap((statement, ordinal) => analyzeCredentialSqlAccess(statement, {
  fileName: 'reads.sql', ordinal,
}).accesses)
assert.deepEqual(derivedRows.map((entry) => [entry.policy_id, entry.credential_exposure]), [
  ['fleet.api-connection.v1', 'SECRET_READ'],
  ['telegram.connection.v1', 'METADATA_ONLY'],
  ['whatsapp.connection.v1', 'SECRET_READ'],
])

process.stdout.write('credential database access analyzer tests: PASS\n')
