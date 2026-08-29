#!/usr/bin/env node
import assert from 'node:assert/strict'

import {
  analyzeCredentialAccess,
  analyzeCredentialSqlAccess,
  CREDENTIAL_ENTITY_POLICIES,
  parsePrismaRelations,
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
assert.equal(result.accesses.length, 10)

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
assert(result.accesses.some((entry) => (
  entry.policy_id === 'calling.ai-provider-setting.v1'
  && entry.access === 'READ'
  && entry.method === 'update'
)))
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

const relationMap = parsePrismaRelations([
  'model Check {',
  '  id String @id',
  '  account Account @relation(fields: [accountId], references: [id])',
  '  accountId String',
  '}',
  'model Account {',
  '  id String @id',
  '  storageStateEncrypted String?',
  '  checks Check[]',
  '}',
  'model User {',
  '  id String @id',
  '  bot Bot @relation(fields: [botId], references: [id])',
  '  botId String',
  '}',
  'model Bot {',
  '  id String @id',
  '  token String',
  '  users User[]',
  '}',
  'model ApiLog {',
  '  id String @id',
  '  connection ApiConnection @relation(fields: [connectionId], references: [id])',
  '  connectionId String',
  '}',
  'model ApiConnection {',
  '  id String @id',
  '  apiKey String',
  '  logs ApiLog[]',
  '}',
].join('\n'))
const related = analyzeCredentialAccess([
  'prisma.check.findUnique({ include: { account: true } })',
  'prisma.user.findMany({ select: { id: true, bot: { select: { token: true } } } })',
  'prisma.apiLog.findFirst({ include: { connection: { select: { id: true } } } })',
  'prisma.messagingConnection.findFirst({ select: { credentials: true } })',
  'prisma.unclassified.findFirst({ select: { secretToken: true } })',
].join('\n'), { fileName: 'relations.ts', relationMap })
assert.deepEqual(related.accesses.map((entry) => [entry.entity, entry.credential_exposure]), [
  ['Account', 'SECRET_READ'],
  ['Bot', 'SECRET_READ'],
  ['ApiConnection', 'METADATA_ONLY'],
  ['MessagingConnection', 'SECRET_READ'],
  ['unclassified', 'SECRET_READ'],
])

const countOnlyProjection = analyzeCredentialAccess(
  'prisma.user.findMany({ select: { id: true, _count: true } })',
  { fileName: 'count-only.ts', relationMap },
)
assert.deepEqual(countOnlyProjection.accesses, [])

const nestedCredentialWrites = analyzeCredentialAccess([
  'prisma.user.update({ data: { apiConnection: {',
  '  update: { apiKey: value },',
  '  create: { apiKey: value },',
  '  connectOrCreate: { where: { id }, create: { apiKey: value } },',
  '  delete: true,',
  '} } })',
].join('\n'), {
  fileName: 'nested-credentials.ts',
  relationMap: new Map([['user.apiconnection', 'ApiConnection']]),
})
assert.deepEqual(nestedCredentialWrites.accesses.map((entry) => [entry.policy_id, entry.access, entry.method]), [
  ['fleet.api-connection.v1', 'WRITE', 'update:nested-write:connectOrCreate'],
  ['fleet.api-connection.v1', 'WRITE', 'update:nested-write:create'],
  ['fleet.api-connection.v1', 'WRITE', 'update:nested-write:delete'],
  ['fleet.api-connection.v1', 'WRITE', 'update:nested-write:update'],
])
assert(nestedCredentialWrites.accesses.every((entry) => entry.ambiguous === false))

const opaqueNestedCredentialWrites = analyzeCredentialAccess([
  'const payload = getPayload()',
  'prisma.user.update({ data: { bot: payload } })',
  'prisma.user.update({ data: { bot: { ...payload } } })',
].join('\n'), {
  fileName: 'opaque-nested-credentials.ts',
  knownModels: ['User', 'Bot'],
  relationMap,
})
assert.equal(opaqueNestedCredentialWrites.accesses.filter((entry) => (
  entry.policy_id === 'telegram.bot-token.v1' && entry.access === 'WRITE'
)).length, 2)
assert(opaqueNestedCredentialWrites.accesses.every((entry) => entry.ambiguous))

const aliasedSql = analyzeCredentialAccess([
  'const query = pool.query',
  'const bound = pool.query.bind(pool)',
  'query("SELECT apiKey FROM ApiConnection")',
  'bound("SELECT token FROM bots")',
].join('\n'), { fileName: 'aliased-driver.ts' })
assert.deepEqual(aliasedSql.accesses.map((entry) => entry.policy_id), [
  'fleet.api-connection.v1',
  'telegram.bot-token.v1',
])

const mutableProjections = analyzeCredentialAccess([
  'const propertyMutation = { id: true }',
  'propertyMutation.apiKey = true',
  'prisma.apiConnection.findMany({ select: propertyMutation })',
  'let reassigned = { id: true }',
  'reassigned = { apiKey: true }',
  'prisma.apiConnection.findMany({ select: reassigned })',
  'const conditionalMutation = { id: true }',
  'if (enabled) conditionalMutation.apiKey = true',
  'prisma.apiConnection.findMany({ select: conditionalMutation })',
].join('\n'), { fileName: 'mutable-projections.ts' })
assert.equal(mutableProjections.accesses.length, 3)
assert(mutableProjections.accesses.every((entry) => entry.credential_exposure === 'SECRET_READ'))
assert(mutableProjections.accesses.every((entry) => entry.ambiguous === true))

const httpBoundaries = [
  analyzeCredentialAccess(
    "fastify.get('/admin/accounts', async () => prisma.account.findMany())",
    { fileName: 'yandex-fleet-scraper/src/api.ts' },
  ),
  analyzeCredentialAccess(
    "router.get('/bots', async (_req, res) => res.json(await prisma.bot.findMany()))",
    { fileName: 'tg-bot/src/routes/admin/bots.js' },
  ),
  analyzeCredentialAccess('export default async function Page() { return prisma.apiConnection.findMany() }', {
    fileName: 'app/settings/page.tsx',
  }),
  analyzeCredentialAccess('export default async function Route() { return prisma.apiConnection.findMany() }', {
    fileName: 'pages/api/connections.ts',
  }),
  analyzeCredentialAccess("router.get('/connections', () => prisma.apiConnection.findMany())", {
    fileName: 'routes/connections.ts',
  }),
  analyzeCredentialAccess('export default () => prisma.apiConnection.findMany()', {
    fileName: 'pages/surveys/[id].js',
  }),
]
assert(httpBoundaries.every((entry) => entry.boundary.route === true))
assert(httpBoundaries.every((entry) => entry.accesses[0].public_secret_risk === true))

for (const nonCredentialSession of ['CallSession', 'MaxPersonalSession']) {
  const session = analyzeCredentialAccess(`prisma.${nonCredentialSession}.delete({ where: { id } })`, {
    fileName: 'private-domain-service.ts',
  })
  assert.equal(session.accesses.length, 0)
}

const preparedCredentials = analyzeCredentialAccess([
  "db.prepare('SELECT token FROM bots').get()",
  "const cookieRead = db.prepare('SELECT encrypted_value FROM cookies')",
  'cookieRead.all()',
].join('\n'), { fileName: 'yandex-fleet-scraper/src/scripts/import-chrome-cookies.ts' })
assert.deepEqual(preparedCredentials.accesses.map((entry) => [entry.policy_id, entry.credential_exposure]), [
  ['telegram.bot-token.v1', 'SECRET_READ'],
  ['fleet.chrome-cookie-store.v1', 'SECRET_READ'],
])

const sqliteCallbackReads = analyzeCredentialAccess([
  "db.get('SELECT token FROM bots', [], callback)",
  "db.all('SELECT storageStateEncrypted FROM Account', [], callback)",
].join('\n'), { fileName: 'sqlite-callbacks.js' })
assert.deepEqual(sqliteCallbackReads.accesses.map((entry) => entry.policy_id), [
  'telegram.bot-token.v1',
  'fleet.yfs-account.v1',
])

const futureCredentialModel = analyzeCredentialAccess([
  "prisma.customIntegration.create({ data: { apiKey: 'never-emitted' } })",
  "prisma.customIntegration.update({ where: { id }, data: { sessionToken: 'never-emitted' } })",
  "prisma.customIntegration.upsert({ where: { id }, create: { apiKey: 'never-emitted' }, update: { sessionToken: 'never-emitted' } })",
].join('\n'), { fileName: 'future-model.ts' })
assert.equal(futureCredentialModel.accesses.length, 3)
assert(futureCredentialModel.accesses.every((entry) => entry.access === 'WRITE'))
assert.deepEqual(futureCredentialModel.accesses.map((entry) => entry.sensitive_field_names), [
  ['apiKey'],
  ['sessionToken'],
  ['apiKey', 'sessionToken'],
])
assert(!JSON.stringify(futureCredentialModel).includes('never-emitted'))

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
assert.notEqual(sql.accesses[0].site_signature, sql.accesses[1].site_signature)

const repeatedSqlAccesses = analyzeCredentialSqlAccess([
  'SELECT id FROM ApiConnection;',
  'SELECT apiKey FROM ApiConnection;',
  'SELECT id FROM ApiConnection;',
].join('\n'), { fileName: 'repeated.sql', line: 20 }).accesses
assert.equal(repeatedSqlAccesses.length, 3)
assert.deepEqual(repeatedSqlAccesses.map((entry) => entry.line), [20, 21, 22])
assert.deepEqual(repeatedSqlAccesses.map((entry) => entry.credential_exposure), [
  'METADATA_ONLY', 'SECRET_READ', 'METADATA_ONLY',
])
assert.equal(new Set(repeatedSqlAccesses.map((entry) => entry.site_signature)).size, 3)

const leadingTriviaLocations = [
  analyzeCredentialSqlAccess('\n\nSELECT token FROM bots;', { fileName: 'leading-lines.sql' }).accesses[0],
  analyzeCredentialSqlAccess('-- lead\nSELECT token FROM bots;', { fileName: 'leading-comment.sql' }).accesses[0],
]
assert.deepEqual(leadingTriviaLocations.map((entry) => [entry.line, entry.column]), [[3, 1], [2, 1]])

const mysqlLexicalSafety = analyzeCredentialSqlAccess(
  "SELECT 'harmless \\\'; DELETE FROM ApiConnection; still literal' AS note; SELECT token FROM bots;",
  { fileName: 'mysql-string.sql' },
)
assert.equal(mysqlLexicalSafety.accesses.some((entry) => (
  entry.access === 'WRITE' && entry.policy_id === 'fleet.api-connection.v1'
)), false)
assert(mysqlLexicalSafety.accesses.some((entry) => (
  entry.access === 'UNKNOWN'
  && entry.ambiguity_reasons.includes('dialect_dependent_string_escape')
)))

const mysqlHashComment = analyzeCredentialSqlAccess(
  '# DELETE FROM ApiConnection;\nSELECT token FROM bots;',
  { fileName: 'mysql-comment.sql' },
)
assert.deepEqual(mysqlHashComment.accesses.map((entry) => [entry.access, entry.policy_id, entry.line]), [
  ['READ', 'telegram.bot-token.v1', 2],
])

const operationCardinality = analyzeCredentialSqlAccess(
  'WITH x AS (DELETE FROM bots RETURNING *) DELETE FROM bots WHERE id IN (SELECT id FROM x);',
  { fileName: 'credential-cardinality.sql' },
).accesses.filter((entry) => entry.access === 'WRITE')
assert.equal(operationCardinality.length, 2)
assert.deepEqual(operationCardinality.map((entry) => [entry.policy_id, entry.line, entry.column]), [
  ['telegram.bot-token.v1', 1, 12],
  ['telegram.bot-token.v1', 1, 42],
])
assert.equal(new Set(operationCardinality.map((entry) => entry.site_signature)).size, 2)

const mysqlExecutableSurfaces = analyzeCredentialSqlAccess([
  '/*!50000 DELETE FROM ApiConnection */;',
  'DELIMITER $$',
  'CREATE PROCEDURE p() BEGIN',
  '  DELETE FROM bots;',
  'END$$',
  'DELIMITER ;',
].join('\n'), { fileName: 'mysql-executable.sql' })
assert(mysqlExecutableSurfaces.accesses.some((entry) => (
  entry.policy_id === 'fleet.api-connection.v1' && entry.access === 'WRITE'
)))
assert(mysqlExecutableSurfaces.accesses.some((entry) => (
  entry.policy_id === 'telegram.bot-token.v1' && entry.access === 'WRITE'
)))

const copyDataSafety = analyzeCredentialSqlAccess([
  'COPY notes(value) FROM STDIN;',
  'DELETE FROM ApiConnection; this is data',
  '\\.',
  'SELECT token FROM bots;',
].join('\n'), { fileName: 'copy-data.sql' })
assert.deepEqual(copyDataSafety.accesses.map((entry) => [entry.policy_id, entry.access, entry.line, entry.column]), [
  ['telegram.bot-token.v1', 'READ', 4, 1],
])

const malformedSql = analyzeCredentialSqlAccess(
  "SELECT 'x; DELETE FROM ApiConnection;",
  { fileName: 'malformed.sql' },
)
assert.equal(malformedSql.accesses.length, 1)
assert.equal(malformedSql.accesses[0].access, 'UNKNOWN')
assert(malformedSql.accesses[0].ambiguity_reasons.includes('invalid_sql_token'))

const slash = String.fromCharCode(92)
const mysqlDoubleQuotedSafety = analyzeCredentialSqlAccess(
  'SELECT "harmless ' + slash + '"; DELETE FROM ApiConnection; still literal" AS x; SELECT token FROM bots;',
  { fileName: 'mysql-double-quoted.sql' },
)
assert.equal(mysqlDoubleQuotedSafety.accesses.some((entry) => (
  entry.access === 'WRITE' && entry.policy_id === 'fleet.api-connection.v1'
)), false)
assert(mysqlDoubleQuotedSafety.accesses.some((entry) => (
  entry.access === 'UNKNOWN'
  && entry.ambiguity_reasons.includes('dialect_dependent_double_quote_string')
)))
assert.equal(JSON.stringify(mysqlDoubleQuotedSafety).includes('still literal'), false)

for (const numeric of ['10', '1.0', '1e2']) {
  const dashCommentSafety = analyzeCredentialSqlAccess(
    `SELECT ${numeric}-- DELETE FROM ApiConnection;\nSELECT token FROM bots;`,
    { fileName: 'dash-comment.sql' },
  )
  assert.equal(dashCommentSafety.accesses.some((entry) => (
    entry.access === 'WRITE' && entry.policy_id === 'fleet.api-connection.v1'
  )), false)
  assert(dashCommentSafety.accesses.some((entry) => (
    entry.access === 'READ'
    && entry.policy_id === 'telegram.bot-token.v1'
    && entry.line === 2
    && entry.column === 1
  )))
}

const dialectDashSafety = analyzeCredentialSqlAccess(
  'SELECT x--2; DELETE FROM ApiConnection;',
  { fileName: 'dialect-dash.sql' },
)
assert(dialectDashSafety.accesses.some((entry) => (
  entry.access === 'WRITE' && entry.policy_id === 'fleet.api-connection.v1'
)))
assert(dialectDashSafety.accesses.some((entry) => (
  entry.access === 'UNKNOWN'
  && entry.ambiguity_reasons.includes('dialect_dependent_dash_comment')
)))

for (const command of ['echo', 'qecho', 'warn']) {
  const psqlDisplaySafety = analyzeCredentialSqlAccess(
    `\\${command} DELETE FROM ApiConnection;\nSELECT token FROM bots;`,
    { fileName: 'psql-display.sql' },
  )
  assert.deepEqual(psqlDisplaySafety.accesses.map((entry) => [entry.access, entry.policy_id]), [
    ['READ', 'telegram.bot-token.v1'],
  ])
}

const jsonbDeletePathSafety = analyzeCredentialSqlAccess(
  "SELECT payload #- '{a}', token FROM bots;",
  { fileName: 'jsonb-delete-path.sql' },
)
assert.deepEqual(jsonbDeletePathSafety.accesses.map((entry) => [
  entry.access,
  entry.policy_id,
  entry.credential_exposure,
  entry.ambiguous,
]), [
  ['READ', 'telegram.bot-token.v1', 'SECRET_READ', false],
])

const routineAndExportSql = analyzeCredentialSqlAccess([
  'CREATE FUNCTION credential_read() RETURNS text AS $$ SELECT "apiKey" FROM "ApiConnection" $$ LANGUAGE SQL;',
  'COPY "Bot" (token) TO STDOUT;',
  'TABLE "Account";',
].join('\n'), { fileName: 'credential-routines.sql' })
assert.deepEqual(routineAndExportSql.accesses.map((entry) => [entry.policy_id, entry.access, entry.credential_exposure]), [
  ['fleet.api-connection.v1', 'READ', 'SECRET_READ'],
  ['telegram.bot-token.v1', 'READ', 'SECRET_READ'],
  ['fleet.yfs-account.v1', 'READ', 'SECRET_READ'],
])

const repeatedRoutineReads = analyzeCredentialSqlAccess([
  'CREATE FUNCTION repeated_reads() RETURNS void AS $body$',
  'SELECT apiKey FROM ApiConnection;',
  'SELECT apiKey FROM ApiConnection;',
  '$body$ LANGUAGE SQL;',
].join('\n'), { fileName: 'repeated-routine.sql', line: 10 })
assert.equal(repeatedRoutineReads.accesses.length, 2)
assert.deepEqual(repeatedRoutineReads.accesses.map((entry) => entry.line), [11, 12])
assert.equal(new Set(repeatedRoutineReads.accesses.map((entry) => entry.site_signature)).size, 2)

const exactRoutineLocations = [
  analyzeCredentialSqlAccess('DO $body$\nDELETE FROM bots;\n$body$;', { fileName: 'do-location.sql' }).accesses[0],
  analyzeCredentialSqlAccess([
    'CREATE FUNCTION f() RETURNS void AS $body$',
    'UPDATE ApiConnection SET apiKey=NULL;',
    '$body$ LANGUAGE SQL;',
  ].join('\n'), { fileName: 'function-location.sql' }).accesses[0],
]
assert.deepEqual(exactRoutineLocations.map((entry) => [entry.line, entry.column]), [[2, 1], [2, 1]])

const dynamicRoutine = analyzeCredentialSqlAccess([
  'CREATE FUNCTION dynamic_reader(tbl text) RETURNS void AS $$',
  "BEGIN EXECUTE 'SELECT apiKey FROM ' || quote_ident(tbl); END",
  '$$ LANGUAGE plpgsql;',
].join('\n'), { fileName: 'dynamic-routine.sql' })
assert.equal(dynamicRoutine.accesses.length, 1)
assert.equal(dynamicRoutine.accesses[0].access, 'UNKNOWN')
assert(dynamicRoutine.accesses[0].ambiguity_reasons.includes('dynamic_execute_effects_unresolved'))

const mutationJoins = analyzeCredentialSqlAccess([
  'DELETE FROM logs USING "ApiConnection" a WHERE logs.id = a.id RETURNING a."apiKey";',
  'MERGE INTO logs USING "Bot" b ON true WHEN MATCHED THEN UPDATE SET x = b.token;',
].join('\n'), { fileName: 'mutation-joins.sql' })
assert.deepEqual(mutationJoins.accesses.map((entry) => [entry.policy_id, entry.credential_exposure]), [
  ['fleet.api-connection.v1', 'SECRET_READ'],
  ['telegram.bot-token.v1', 'SECRET_READ'],
])

const futureRawCredentialBoundary = [
  'SELECT api_key FROM custom_integrations;',
  'SELECT credentials FROM legacy_connections;',
  'UPDATE custom_integrations SET api_key = NULL;',
  'INSERT INTO custom_integrations (api_key, name) VALUES (NULL, NULL);',
  'COPY custom_integrations(api_key) TO STDOUT;',
  'COPY custom_integrations(api_key) FROM STDIN;',
].flatMap((statement, ordinal) => analyzeCredentialSqlAccess(statement, {
  fileName: 'future-raw.sql', ordinal,
}).accesses)
assert.deepEqual(futureRawCredentialBoundary.map((entry) => [entry.access, entry.sensitive_field_names]), [
  ['READ', ['api_key']],
  ['READ', ['credentials']],
  ['WRITE', ['api_key']],
  ['WRITE', ['api_key']],
  ['READ', ['api_key']],
  ['WRITE', ['api_key']],
])

const futureRawDriver = analyzeCredentialAccess([
  "pool.query('SELECT api_key FROM custom_integrations')",
  "pool.query('UPDATE custom_integrations SET api_key = NULL')",
].join('\n'), { fileName: 'future-driver.ts' })
assert.deepEqual(futureRawDriver.accesses.map((entry) => entry.access), ['READ', 'WRITE'])

const qualifiedJoinProjection = analyzeCredentialSqlAccess([
  'SELECT h.apiKey FROM ApiConnection a JOIN harmless h ON true;',
  'SELECT c.apiKey FROM harmless h, ApiConnection c;',
].join('\n'), { fileName: 'qualified-joins.sql' })
assert.deepEqual(qualifiedJoinProjection.accesses.map((entry) => [entry.entity, entry.credential_exposure]), [
  ['harmless', 'SECRET_READ'],
  ['ApiConnection', 'METADATA_ONLY'],
  ['ApiConnection', 'SECRET_READ'],
])

const reusedSqlAliases = analyzeCredentialSqlAccess([
  'SELECT x.apiKey FROM ApiConnection x;',
  'SELECT x.id FROM harmless x;',
].join('\n'), { fileName: 'reused-alias.sql' })
assert.deepEqual(reusedSqlAliases.accesses.map((entry) => [entry.entity, entry.credential_exposure]), [
  ['ApiConnection', 'SECRET_READ'],
])

const defaultNamedAlias = analyzeCredentialAccess(
  'const p = prisma; p.apiConnection.findMany({ select: { apiKey: true } })',
)
assert.equal(defaultNamedAlias.accesses.length, 1)
assert.equal(defaultNamedAlias.accesses[0].credential_exposure, 'SECRET_READ')

const unrelatedAvitoAccounts = analyzeCredentialAccess([
  "import { accounts, type Database } from '@avito/db'",
  'declare const db: Database',
  'db.select().from(accounts)',
  'db.update(accounts).set({ enabled: true })',
].join('\n'), { fileName: 'avito-worker.ts' })
assert.equal(unrelatedAvitoAccounts.accesses.some((entry) => entry.policy_id === 'fleet.yfs-account.v1'), false)
assert.deepEqual(unrelatedAvitoAccounts.accesses.map((entry) => [entry.policy_id, entry.access]), [
  ['avito.account-browser-session.v1', 'READ'],
  ['avito.account-browser-session.v1', 'WRITE'],
])

const fieldlessCredentialEntities = analyzeCredentialAccess([
  'prisma.credentialStore.delete({ where: { id } })',
  'prisma.apiTokens.deleteMany({})',
].join('\n'), { fileName: 'fieldless-credential-models.ts' })
assert.equal(fieldlessCredentialEntities.accesses.length, 3)
assert.equal(fieldlessCredentialEntities.accesses.filter((entry) => entry.access === 'WRITE').length, 2)
assert(fieldlessCredentialEntities.accesses.some((entry) => (
  entry.access === 'UNKNOWN'
  && entry.ambiguity_reasons.includes('credential_like_model_read_without_registered_policy')
)))
assert.equal(fieldlessCredentialEntities.boundary.route, false)

const fieldlessRawEntities = [
  'DELETE FROM custom_credentials;',
  'TRUNCATE api_tokens;',
  'SELECT apiKey INTO credential_backup FROM ApiConnection;',
  'CREATE TABLE credential_archive AS SELECT apiKey FROM ApiConnection;',
].flatMap((statement, ordinal) => analyzeCredentialSqlAccess(statement, {
  fileName: 'fieldless-raw.sql', ordinal,
}).accesses)
assert(fieldlessRawEntities.some((entry) => entry.entity === 'custom_credentials' && entry.access === 'WRITE'))
assert(fieldlessRawEntities.some((entry) => entry.entity === 'api_tokens' && entry.access === 'WRITE'))
assert(fieldlessRawEntities.some((entry) => entry.entity === 'credential_backup' && entry.access === 'WRITE'))
assert(fieldlessRawEntities.some((entry) => entry.entity === 'credential_archive' && entry.access === 'WRITE'))

const advancedRawWrites = [
  'UPDATE custom_integrations SET (api_key, name) = (NULL, NULL);',
  "UPDATE custom_integrations SET api_key ||= 'x';",
  'INSERT INTO custom_integrations SET api_key = NULL;',
  'REPLACE INTO custom_integrations(api_key) VALUES (NULL);',
  'MERGE INTO custom_integrations c USING source s ON true WHEN MATCHED THEN UPDATE SET api_key = s.value;',
  'INSERT INTO custom_integrations DEFAULT VALUES ON CONFLICT (id) DO UPDATE SET api_key = NULL;',
].flatMap((statement, ordinal) => analyzeCredentialSqlAccess(statement, {
  fileName: 'advanced-writes.sql', ordinal,
}).accesses)
assert.equal(advancedRawWrites.filter((entry) => entry.access === 'WRITE').length, 6)

const mysqlDuplicateKey = analyzeCredentialSqlAccess(
  'INSERT INTO custom_integrations(id) VALUES(1) ON DUPLICATE KEY UPDATE api_key=NULL',
)
assert(mysqlDuplicateKey.accesses.some((entry) => entry.access === 'WRITE' && entry.entity === 'custom_integrations'))

const mysqlMultiDelete = analyzeCredentialSqlAccess(
  'DELETE a,b FROM ApiConnection a JOIN bots b ON true',
)
assert(mysqlMultiDelete.accesses.some((entry) => entry.access === 'WRITE' && entry.policy_id === 'fleet.api-connection.v1'))
assert(mysqlMultiDelete.accesses.some((entry) => entry.access === 'WRITE' && entry.policy_id === 'telegram.bot-token.v1'))

for (const statement of [
  'SELECT apiKey FROM `ApiConnection`',
  'SELECT [apiKey] FROM [ApiConnection]',
]) {
  const quoted = analyzeCredentialSqlAccess(statement)
  assert.deepEqual(quoted.accesses.map((entry) => [entry.policy_id, entry.credential_exposure]), [
    ['fleet.api-connection.v1', 'SECRET_READ'],
  ])
}

const returningCredentialRow = analyzeCredentialSqlAccess(
  'DELETE FROM custom_integrations RETURNING api_key',
)
assert.deepEqual(returningCredentialRow.accesses.map((entry) => [entry.access, entry.entity]), [
  ['READ', 'custom_integrations'],
  ['WRITE', 'custom_integrations'],
])

const ctePolicyShadow = analyzeCredentialSqlAccess(
  'WITH ApiConnection AS (SELECT id AS apiKey FROM safe) SELECT apiKey FROM ApiConnection',
)
assert.equal(ctePolicyShadow.accesses.some((entry) => entry.policy_id === 'fleet.api-connection.v1'), false)
assert.equal(ctePolicyShadow.accesses.length, 0)

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
