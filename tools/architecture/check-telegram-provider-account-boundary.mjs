#!/usr/bin/env node

// M2A2-TG1 boundary: the Telegram provider-account foundation owns Telegram
// account identity alone. The provider-authenticated getMe() id is the only
// identity authority, credentials never reach this module, only its writer
// touches the database, the projection carries no secret and no provider id,
// the foundation stays inert, and it adds no cross-context public API.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const MODULE_DIR = 'gravity-mvp/src/modules/telegram-channel/internal/provider-account'
const IDENTITY = `${MODULE_DIR}/telegram-account-identity.ts`
const WRITER = `${MODULE_DIR}/telegram-account-writer.ts`
const SOURCES = [IDENTITY, WRITER]
const MODULE_FILES = [
  ...SOURCES,
  `${MODULE_DIR}/telegram-account-identity.test.ts`,
  `${MODULE_DIR}/telegram-provider-account.postgres.test.ts`,
]

const MIGRATION = 'gravity-mvp/prisma/migrations/20260922120000_add_telegram_provider_account_foundation/migration.sql'
const SCHEMA = 'gravity-mvp/prisma/schema.prisma'

const ALLOWED_MODULE_DEPENDENCIES = new Map([
  [IDENTITY, []],
  [WRITER, ['node:crypto', '@prisma/client', '@/lib/prisma', './telegram-account-identity']],
])

// A credential, a session or a token may never be named in this module.
const CREDENTIAL = /\bapiHash\b|\bapiId\b|\bsessionString\b|\bbotToken\b|\bBOT_TOKEN\b|\btoken\b|\bpassword\b|\bsecret\b/u
const SIDE_CHANNELS = /\bconsole\.|\bprocess\.env\b|\bappendFileSync\b|\bwriteFile(?:Sync)?\b|\bfetch\(/u
const DATABASE = /@prisma\/|@\/lib\/prisma|\$queryRaw|\$executeRaw|\$transaction/u
// Identity may never be inferred from these.
const FORBIDDEN_IDENTITY_SOURCE = /\bphoneNumber\b|\bdisplayName\b|\bisDefault\b|CRM_TELEGRAM_CONNECTION_ID/u

function parse(relative, source) {
  return ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

function withoutComments(relative, source) {
  return ts.createPrinter({ removeComments: true }).printFile(parse(relative, source))
}

function moduleReferences(relative, source) {
  const references = []
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      references.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression
      const isModuleCall = callee.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(callee) && callee.text === 'require')
        || (ts.isPropertyAccessExpression(callee) && ['mock', 'doMock', 'importActual'].includes(callee.name.text))
      if (isModuleCall) references.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(relative, source))
  return references
}

function referencesProviderAccount(relative, specifier) {
  if (specifier.includes('telegram-channel/internal/provider-account')) return true
  if (!specifier.startsWith('.')) return false
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier))
  return resolved === MODULE_DIR || resolved.startsWith(`${MODULE_DIR}/`)
}

function sourceFiles(directory) {
  const files = []
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(entry.name)) files.push(child)
    }
  }
  walk(directory)
  return files.sort()
}

export function providerAccountImporters(files) {
  return files
    .filter(([relative]) => !relative.startsWith(`${MODULE_DIR}/`))
    .filter(([relative, source]) => moduleReferences(relative, source).some((specifier) => referencesProviderAccount(relative, specifier)))
    .map(([relative]) => relative)
    .sort()
}

export function assertModuleSource(relative, source) {
  const allowed = ALLOWED_MODULE_DEPENDENCIES.get(relative)
  assert(allowed, `unexpected provider account source: ${relative}`)
  for (const dependency of moduleReferences(relative, source)) {
    assert(allowed.includes(dependency), `provider account dependency is not allowed: ${relative} -> ${dependency}`)
  }
  const code = withoutComments(relative, source)
  assert.doesNotMatch(code, CREDENTIAL, `provider account must never name a credential: ${relative}`)
  assert.doesNotMatch(code, SIDE_CHANNELS, `provider account must not write outside the database: ${relative}`)
  assert.doesNotMatch(code, FORBIDDEN_IDENTITY_SOURCE, `identity may only come from the authenticated getMe id: ${relative}`)
  if (relative !== WRITER) {
    assert.doesNotMatch(code, DATABASE, `only the writer may reach the database: ${relative}`)
  }
}

/** The provider id is accepted only in exact provider form. */
export function assertExactProviderForm(source) {
  const code = withoutComments(IDENTITY, source)
  assert.match(code, /const PROVIDER_USER_ID = \/\^\[0-9\]\{1,64\}\$\/u/u, 'the provider id must be a bare decimal string in provider form')
  assert.match(code, /export function isExactProviderUserIdV1/u, 'the exact-form guard is missing')
  // No normalisation of any kind may be applied to a provider id.
  assert.doesNotMatch(code, /replace\(|slice\(|padStart\(|normalize\(|toLowerCase\(/u, 'a provider id is never normalized, parsed or shortened')
}

/** Readiness is derived, never stored, and lifecycle alone never implies it. */
export function assertReadinessIsDerived(source) {
  const code = withoutComments(IDENTITY, source)
  const start = code.indexOf('export function deriveReadinessV1')
  assert(start >= 0, 'the readiness derivation is missing')
  const body = code.slice(start)
  assert.match(body, /lifecycle !== 'active'/u, 'readiness must refuse a lifecycle that is not active')
  assert.match(body, /attestedUntilMs <= input\.dbNowMs/u, 'readiness must be decided against the database clock')
  assert.doesNotMatch(code, /readiness:\s*'/u, 'readiness must never be stored on a row')
}

/** The projection is the whole contract a consumer may see. */
export function assertProjectionShape(source) {
  const code = withoutComments(WRITER, source)
  const start = code.indexOf('export interface ProviderAccountProjectionV1')
  assert(start >= 0, 'the provider account projection interface is missing')
  const body = code.slice(start, code.indexOf('}', start))
  const fields = [...body.matchAll(/^\s{4}([A-Za-z]+)[?]?:/gmu)].map((match) => match[1]).sort()
  assert.deepEqual(fields, ['accountKind', 'capabilities', 'channel', 'lifecycle', 'providerAccountId', 'readiness'],
    'the provider account projection changed')
  assert.doesNotMatch(body, /providerUserId|apiHash|sessionString|token|instanceId|transportRef/u,
    'the projection must not carry a provider id, a credential, a process identity or a routing internal')
}

/** The foundation stays inert until a runtime hook is reviewed separately. */
export function assertInert(importers) {
  assert.deepEqual(importers, [], 'the Telegram provider account foundation must stay inert: nothing may import it yet')
}

/** The database carries the invariants the writer depends on. */
export function assertMigrationContract(sql) {
  for (const [label, pattern] of [
    ['provider id uniqueness', /CREATE UNIQUE INDEX "TelegramAccount_providerUserId_key"/u],
    ['composite principal key', /CREATE UNIQUE INDEX "TelegramAccount_accountId_providerUserId_key"/u],
    ['one open binding per transport', /CREATE UNIQUE INDEX "TelegramTransportBinding_openTransportKey_key"/u],
    ['binding attests only its own account principal', /FOREIGN KEY \("accountId", "attestedProviderUserId"\) REFERENCES "TelegramAccount"\("accountId", "providerUserId"\)/u],
    ['provider id stored in exact form', /"providerUserId" ~ '\^\[0-9\]\{1,64\}\$'/u],
    ['attestation window ceiling', /"attestedUntil" <= "lastAttestedAt" \+ interval '1 hour'/u],
    ['open key consistency', /"openTransportKey" = "transportKind" \|\| ':' \|\| "transportRef"/u],
    ['identity immutability', /TelegramAccount identity is immutable/u],
    ['transport immutability', /identity, transport and generation are immutable/u],
    ['rows are permanent', /TelegramAccount rows are permanent and cannot be removed/u],
    ['history is durable', /TelegramTransportBinding rows are durable history and cannot be removed/u],
    ['truncate refused', /cannot be truncated/u],
  ]) {
    assert.match(sql, pattern, `the migration no longer carries: ${label}`)
  }
  assert.doesNotMatch(sql, /apiHash|sessionString|botToken/u, 'the foundation must not store a credential')
}

// Prose may discuss the foundation; only code may not reach it.
const PUBLIC_EXPOSURE = /internal\/provider-account|ProviderAccountProjectionV1|recordTelegramTransportAttestationV1|readProviderAccountProjectionV1|admitTelegramAccountV1/u

export function assertNoPublicSurface(publicFiles, manifest) {
  for (const [relative, source] of publicFiles) {
    assert.doesNotMatch(withoutComments(relative, source), PUBLIC_EXPOSURE,
      `public API must not expose the provider account foundation: ${relative}`)
  }
  assert.deepEqual(manifest.public_surface, [
    'TelegramDeliveryPort.v1',
    'TelegramReachability.v1',
    'TelegramRuntimeOperations.v1',
    'TelegramConnectionMetadataQuery.v1',
    'BotSurveyApi.v1',
    'BotUserProfileCommands.v1',
  ], 'telegram_channel public surface changed')
}

// Current repository state.
const files = [
  ...sourceFiles('gravity-mvp/src'),
  ...sourceFiles('gravity-mvp/scripts'),
].map((relative) => [relative, read(relative)])

const presentModuleFiles = files.map(([relative]) => relative).filter((relative) => relative.startsWith(`${MODULE_DIR}/`))
assert.deepEqual(presentModuleFiles, [...MODULE_FILES].sort(), 'provider account module files changed')

const importers = providerAccountImporters(files)
assertInert(importers)
for (const relative of SOURCES) assertModuleSource(relative, read(relative))
assertExactProviderForm(read(IDENTITY))
assertReadinessIsDerived(read(IDENTITY))
assertProjectionShape(read(WRITER))
assertMigrationContract(read(MIGRATION))
assertNoPublicSurface(
  files.filter(([relative]) => relative.startsWith('gravity-mvp/src/modules/telegram-channel/public/')),
  JSON.parse(read('architecture/contexts/v1/manifests/telegram_channel.json')),
)
// The foundation adds no foreign key to the session row or to a person, so no
// shortcut can form and become the account authority by convenience.
export function schemaModelBlock(schema, name) {
  const start = schema.indexOf(`model ${name} {`)
  assert(start >= 0, `model ${name} is missing from the schema`)
  const end = schema.indexOf('\n}', start)
  assert(end > start, `model ${name} is not terminated`)
  return schema.slice(start, end)
}

export function assertNoShortcut(schema) {
  for (const model of ['TelegramAccount', 'TelegramTransportBinding']) {
    const block = schemaModelBlock(schema, model)
    assert.doesNotMatch(block, /TelegramConnection|ContactIdentity|Contact\b|Chat\b/u,
      `${model} must not relate to a transport row, a contact or a conversation`)
  }
}

assertNoShortcut(read(SCHEMA))

// Negative probes: each rule must refuse a realistic violation.
const rejected = {
  identity_reaches_database: () => assertModuleSource(IDENTITY, `${read(IDENTITY)}\nconst rows = await prisma.$queryRawUnsafe("SELECT 1")\n`),
  module_names_a_credential: () => assertModuleSource(WRITER, `${read(WRITER)}\nconst t = input.sessionString\n`),
  module_infers_from_phone: () => assertModuleSource(WRITER, `${read(WRITER)}\nconst p = connection.phoneNumber\n`),
  module_logs: () => assertModuleSource(WRITER, `${read(WRITER)}\nconsole.log('x')\n`),
  module_gains_a_dependency: () => assertModuleSource(IDENTITY, `import { contacts } from '@/modules/contacts/public/v1'\n${read(IDENTITY)}`),
  provider_id_normalized: () => assertExactProviderForm(read(IDENTITY).replace('const PROVIDER_USER_ID = /^[0-9]{1,64}$/u', 'const PROVIDER_USER_ID = /^[0-9]{1,64}$/u\nconst norm = (v) => v.replace("+", "")')),
  readiness_ignores_lifecycle: () => assertReadinessIsDerived(read(IDENTITY).replace("if (input.lifecycle !== 'active') return 'not_admitted'", "if (false) return 'not_admitted'")),
  projection_leaks_provider_id: () => assertProjectionShape(read(WRITER).replace('    accountKind: TelegramAccountKindV1 | null', '    accountKind: TelegramAccountKindV1 | null\n    providerUserId: string')),
  migration_drops_the_composite_key: () => assertMigrationContract(read(MIGRATION).replace('FOREIGN KEY ("accountId", "attestedProviderUserId") REFERENCES "TelegramAccount"("accountId", "providerUserId")', 'FOREIGN KEY ("accountId") REFERENCES "TelegramAccount"("accountId")')),
  migration_stores_a_credential: () => assertMigrationContract(`${read(MIGRATION)}\nALTER TABLE "TelegramAccount" ADD COLUMN "sessionString" TEXT;`),
  foundation_becomes_reachable: () => assertInert(['gravity-mvp/src/app/tg-actions.ts']),
  public_surface_grows: () => assertNoPublicSurface([], { public_surface: ['TelegramDeliveryPort.v1'] }),
  foundation_binds_the_session_row: () => assertNoShortcut(read(SCHEMA).replace('  bindings           TelegramTransportBinding[]', '  connection         TelegramConnection @relation(fields: [accountId], references: [id])')),
  public_file_reexports_the_writer: () => assertNoPublicSurface(
    [['gravity-mvp/src/modules/telegram-channel/public/v1/index.ts', "export { recordTelegramTransportAttestationV1 } from '../../internal/provider-account/telegram-account-writer'"]],
    JSON.parse(read('architecture/contexts/v1/manifests/telegram_channel.json')),
  ),
}

const messages = {
  identity_reaches_database: /only the writer may reach the database/u,
  module_names_a_credential: /must never name a credential/u,
  module_infers_from_phone: /identity may only come from the authenticated getMe id/u,
  module_logs: /must not write outside the database/u,
  module_gains_a_dependency: /dependency is not allowed/u,
  provider_id_normalized: /never normalized, parsed or shortened/u,
  readiness_ignores_lifecycle: /readiness must refuse a lifecycle that is not active/u,
  projection_leaks_provider_id: /projection changed/u,
  migration_drops_the_composite_key: /binding attests only its own account principal/u,
  migration_stores_a_credential: /must not store a credential/u,
  foundation_becomes_reachable: /must stay inert/u,
  public_surface_grows: /public surface changed/u,
  foundation_binds_the_session_row: /must not relate to a transport row, a contact or a conversation/u,
  public_file_reexports_the_writer: /must not expose the provider account foundation/u,
}

for (const [name, probe] of Object.entries(rejected)) {
  assert.throws(probe, messages[name], `probe did not fail as expected: ${name}`)
}

console.log(JSON.stringify({
  status: 'PASS',
  control: 'telegram-provider-account-boundary',
  module_files: MODULE_FILES.length,
  importers: importers.length,
  database_sources: 1,
  inert: true,
  public_surface_changes: 0,
  negative_probes: Object.keys(rejected).length,
}, null, 2))
