#!/usr/bin/env node

// M2A2-MAX1A boundary: the MAX provider-account foundation owns MAX account
// identity alone. The principal the live MAX runtime was authenticated as is the
// only identity authority, credentials never reach this module, only its writer
// touches the database, the projection is deterministic from durable state and
// carries no provider id, no historical MAX table is reused, the foundation
// stays inert, and it adds no cross-context public API.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const MODULE_DIR = 'gravity-mvp/src/modules/max-channel/internal/provider-account'
const IDENTITY = `${MODULE_DIR}/max-account-identity.ts`
const WRITER = `${MODULE_DIR}/max-account-writer.ts`
const INTAKE = `${MODULE_DIR}/max-account-intake.ts`
const SOURCES = [IDENTITY, WRITER, INTAKE]
const MODULE_FILES = [
  ...SOURCES,
  `${MODULE_DIR}/max-account-identity.test.ts`,
  `${MODULE_DIR}/max-account-intake.test.ts`,
  `${MODULE_DIR}/max-provider-account.postgres.test.ts`,
]

const MIGRATION = 'gravity-mvp/prisma/migrations/20260925120000_add_max_provider_account_foundation/migration.sql'
const SCHEMA = 'gravity-mvp/prisma/schema.prisma'
const MANIFEST = 'architecture/contexts/v1/manifests/max_channel.json'

const ALLOWED_MODULE_DEPENDENCIES = new Map([
  [IDENTITY, []],
  [WRITER, ['node:crypto', '@prisma/client', '@/lib/prisma', './max-account-identity']],
  [INTAKE, ['@/infrastructure/operations/operational-log', './max-account-identity', './max-account-writer']],
])

// A credential, a session or a token may never be named in this module.
const CREDENTIAL = /\bbotToken\b|\bBOT_TOKEN\b|\btoken\b|\bpassword\b|\bsecret\b|\bsessionString\b|\bstorageState\b/u
const SIDE_CHANNELS = /\bconsole\.|\bprocess\.env\b|\bappendFileSync\b|\bwriteFile(?:Sync)?\b|\bfetch\(/u
const DATABASE = /@prisma\/|@\/lib\/prisma|\$queryRaw|\$executeRaw|\$transaction/u
// Identity may never be inferred from a configuration row, a historical table or
// the scraper's own runtime state.
const FORBIDDEN_IDENTITY_SOURCE = /\bMaxConnection\b|\bMaxPersonalSession\b|\bMaxAccountSessionOwner\b|\bMaxRoute[A-Za-z]*\b|\bMaxRawTransport[A-Za-z]*\b|MAX_SCRAPER_URL|MAX_TRANSPORT_REF|\b_myUserId\b|\bphoneNumber\b|\bdisplayName\b/u
// MAX publishes no expiry, so no freshness vocabulary may appear anywhere.
const FRESHNESS = /\battestedUntil\b|\btrustState\b|\bstale_attestation\b|\bATTESTATION_WINDOW\b|\brefreshFloor\b/u

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
  if (specifier.includes('max-channel/internal/provider-account')) return true
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
  assert.doesNotMatch(code, FORBIDDEN_IDENTITY_SOURCE, `identity may only come from the live authenticated principal: ${relative}`)
  assert.doesNotMatch(code, FRESHNESS, `MAX publishes no expiry, so no freshness state may exist: ${relative}`)
  if (relative !== WRITER) {
    assert.doesNotMatch(code, DATABASE, `only the writer may reach the database: ${relative}`)
  }
}

/** The principal is accepted only in exact provider form and is never parsed. */
export function assertExactProviderForm(source) {
  const code = withoutComments(IDENTITY, source)
  assert.match(code, /const PROVIDER_USER_ID = \/\^\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,63\}\$\/u/u,
    'the provider principal must be accepted only in exact opaque provider form')
  assert.match(code, /PRINCIPAL_SENTINELS[\s\S]{0,120}'legacy'[\s\S]{0,40}'max-default'/u,
    'the sentinels the MAX runtime itself refuses must be refused here')
  assert.match(code, /export function isExactProviderUserIdV1/u, 'the exact-form guard is missing')
  // No normalisation of any kind may be applied to a principal.
  assert.doesNotMatch(code, /Number\(|parseInt\(|BigInt\(|padStart\(|toLowerCase\(/u,
    'a provider principal is never normalized, parsed as a number or shortened')
}

/** The transport locator names the transport, never the principal. */
export function assertTransportRefAuthority(source) {
  const code = withoutComments(IDENTITY, source)
  assert.match(code, /const TRANSPORT_REF = \/\^max-personal-\[0-9a-f\]\{24\}\$\/u/u,
    'the transport locator must be the YOKO locator shape')
  const start = code.indexOf('export function openTransportKeyV1')
  assert(start >= 0, 'the open-transport-key derivation is missing')
  const body = code.slice(start, code.indexOf('\n}', start))
  assert.doesNotMatch(body, /providerUserId/u, 'the open key may never be derived from the principal')
}

/** Identity state is derived from durable state only, and never invents freshness. */
export function assertIdentityStateIsDerived(source) {
  const code = withoutComments(IDENTITY, source)
  const start = code.indexOf('export function deriveIdentityStateV1')
  assert(start >= 0, 'the identity-state derivation is missing')
  const body = code.slice(start)
  assert.match(body, /hasOpenBinding/u, 'identity state must require an open binding')
  assert.match(body, /lifecycle !== 'active'/u, 'identity state must refuse a lifecycle that is not active')
  assert.doesNotMatch(body, /Date|now\(|clock|fetch|isReady|wsConnected/u,
    'identity state must not depend on a clock or on runtime health')
  assert.doesNotMatch(code, /identityState:\s*'/u, 'identity state must never be stored on a row')
}

/** The projection is the whole contract a consumer may see. */
export function assertProjectionShape(source) {
  const code = withoutComments(WRITER, source)
  const start = code.indexOf('export interface MaxProviderAccountProjectionV1')
  assert(start >= 0, 'the MAX provider account projection interface is missing')
  const body = code.slice(start, code.indexOf('}', start))
  const fields = [...body.matchAll(/^\s{4}([A-Za-z]+)[?]?:/gmu)].map((match) => match[1]).sort()
  assert.deepEqual(fields, ['capabilities', 'channel', 'identityState', 'lastAttestedAt', 'lifecycle', 'providerAccountId'],
    'the MAX provider account projection changed')
  assert.doesNotMatch(body, /providerUserId|token|instanceId|transportRef|isReady|health/u,
    'the projection must not carry a principal, a credential, a process identity, a routing internal or runtime health')
}

/** The projection is computed without any network call. */
export function assertProjectionIsOffline(source) {
  const code = withoutComments(WRITER, source)
  const start = code.indexOf('export async function readMaxProviderAccountProjectionV1')
  assert(start >= 0, 'the projection reader is missing')
  const body = code.slice(start)
  assert.doesNotMatch(body, /fetch\(|http|MAX_SCRAPER|\/status/u,
    'the projection must be deterministic from durable state with no runtime call')
}

/**
 * There is no durable trust state anywhere: a row exists only because it was
 * proven. Prose may explain that absence; only code may not reintroduce it.
 */
export function assertNoTrustState(sources) {
  for (const [relative, source] of sources) {
    const code = relative.endsWith('.sql')
      ? source.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n')
      : withoutComments(relative, source)
    assert.doesNotMatch(code, /trustState/u, `no durable trust state may exist: ${relative}`)
    assert.doesNotMatch(code, /mismatched/u, `no durable mismatched state may exist: ${relative}`)
  }
}

/** The foundation stays inert until a runtime hook is reviewed separately. */
export function assertInert(importers) {
  assert.deepEqual(importers, [], 'the MAX provider account foundation must stay inert: nothing may import it yet')
}

/** The database carries the invariants the writer depends on. */
export function assertMigrationContract(sql) {
  for (const [label, pattern] of [
    ['provider principal uniqueness', /CREATE UNIQUE INDEX "MaxAccount_providerUserId_key"/u],
    ['composite principal key', /CREATE UNIQUE INDEX "MaxAccount_accountId_providerUserId_key"/u],
    ['one open binding per transport', /CREATE UNIQUE INDEX "MaxTransportBinding_openTransportKey_key"/u],
    ['binding attests only its own account principal', /FOREIGN KEY \("accountId", "attestedProviderUserId"\) REFERENCES "MaxAccount"\("accountId", "providerUserId"\)/u],
    ['principal stored in exact opaque form', /"providerUserId" ~ '\^\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,63\}\$'/u],
    ['sentinel principals refused', /"providerUserId" NOT IN \('legacy', 'max-default'\)/u],
    ['transport locator shape', /"transportRef" ~ '\^max-personal-\[0-9a-f\]\{24\}\$'/u],
    ['single transport kind', /"transportKind" IN \('web_session'\)/u],
    ['auth event vocabulary', /"lastAuthEventKind" IN \('ws_auth_op19', 'ws_owner_op53'\)/u],
    ['single close reason', /"closeReason" IN \('principal_changed'\)/u],
    ['open key consistency', /"openTransportKey" = "transportKind" \|\| ':' \|\| "transportRef"/u],
    ['identity immutability', /MaxAccount identity is immutable/u],
    ['transport immutability', /identity, transport and generation are immutable/u],
    ['rows are permanent', /MaxAccount rows are permanent and cannot be removed/u],
    ['history is durable', /MaxTransportBinding rows are durable history and cannot be removed/u],
    ['truncate refused', /cannot be truncated/u],
    ['retire needs no open binding', /cannot retire while a transport binding is open/u],
    ['lifecycle version step', /lifecycle version must advance by exactly one/u],
  ]) {
    assert.match(sql, pattern, `the migration no longer carries: ${label}`)
  }
  assert.doesNotMatch(sql, /botToken|sessionString|storageState/u, 'the foundation must not store a credential')
  assert.doesNotMatch(sql, /trustState/u, 'the foundation must not carry a durable trust state')
  // No historical MAX table may be created, altered or referenced here.
  const touched = [...sql.matchAll(/(?:CREATE TABLE|ALTER TABLE|REFERENCES)\s+"([A-Za-z]+)"/gu)].map((match) => match[1])
  assert.deepEqual([...new Set(touched)].sort(), ['MaxAccount', 'MaxTransportBinding'],
    'the migration may touch only the two new foundation tables')
  assert.doesNotMatch(sql, /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\s/mu, 'the foundation migration carries no data statement')
}

/** The new models relate to nothing but each other. */
function modelBlock(schema, model) {
  const start = schema.indexOf(`model ${model} {`)
  assert(start >= 0, `the ${model} model is missing`)
  const end = schema.indexOf('\n}\n', start)
  assert(end > start, `the ${model} model is unterminated`)
  return schema.slice(start, end)
}

export function assertNoHistoricalReuse(schema) {
  const block = [modelBlock(schema, 'MaxAccount'), modelBlock(schema, 'MaxTransportBinding')].join('\n')
  const related = [...block.matchAll(/@relation\(/gu)]
  assert(related.length >= 3, 'the foundation relations are missing')
  assert.doesNotMatch(block, /MaxConnection|MaxPersonalSession|MaxAccountSessionOwner|MaxRoute|MaxRawTransport|Contact|Driver|Chat|Message/u,
    'the MAX foundation must not relate to a historical MAX table, a contact, a driver or a conversation')
}

// Prose may discuss the foundation; only code may not reach it.
const PUBLIC_EXPOSURE = /internal\/provider-account|MaxProviderAccountProjectionV1|recordMaxTransportAttestationV1|readMaxProviderAccountProjectionV1|observeMaxProviderPrincipalV1/u

export function assertNoPublicSurface(publicFiles, manifest) {
  for (const [relative, source] of publicFiles) {
    assert.doesNotMatch(withoutComments(relative, source), PUBLIC_EXPOSURE,
      `public API must not expose the provider account foundation: ${relative}`)
  }
  assert.deepEqual(manifest.public_surface, [
    'MaxDeliveryPort.v1',
    'MaxReachability.v1',
    'MaxSessionStatus.v1',
    'MaxDriverMessaging.v1',
  ], 'max_channel public surface changed')
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

const migration = read(MIGRATION)
const schema = read(SCHEMA)
assertExactProviderForm(read(IDENTITY))
assertTransportRefAuthority(read(IDENTITY))
assertIdentityStateIsDerived(read(IDENTITY))
assertProjectionShape(read(WRITER))
assertProjectionIsOffline(read(WRITER))
assertNoTrustState([...SOURCES.map((relative) => [relative, read(relative)]), [MIGRATION, migration]])
assertMigrationContract(migration)
assertNoHistoricalReuse(schema)

const publicFiles = files.filter(([relative]) => relative.startsWith('gravity-mvp/src/modules/max-channel/public/'))
assertNoPublicSurface(publicFiles, JSON.parse(read(MANIFEST)))

// The foundation writer is the only code that may persist these two models.
const persistenceCallers = files
  .filter(([relative]) => relative !== WRITER && !relative.endsWith('.test.ts'))
  .filter(([, source]) => /\b(?:prisma|tx)\.(?:maxAccount|maxTransportBinding)\b/u.test(source))
  .map(([relative]) => relative)
assert.deepEqual(persistenceCallers, [], 'only the MAX provider account writer may persist the foundation')

const rejected = {
  // A database reach is injected as usage, not as an import, so the probe proves
  // the database rule itself rather than the dependency allow-list.
  identity_reaches_database: () => assertModuleSource(IDENTITY, read(IDENTITY).replace(
    'export interface AttestedPrincipalV1 {', 'export const rows = (tx) => tx.$queryRaw`SELECT 1`\nexport interface AttestedPrincipalV1 {')),
  intake_reaches_database: () => assertModuleSource(INTAKE, read(INTAKE).replace(
    'export function createMaxAccountIntakeV1', 'export const rows = (tx) => tx.$executeRaw`SELECT 1`\nexport function createMaxAccountIntakeV1')),
  module_names_a_credential: () => assertModuleSource(WRITER, read(WRITER).replace('attestingInstanceId: string', 'attestingInstanceId: string\n    botToken: string')),
  module_infers_from_the_config_row: () => assertModuleSource(IDENTITY, read(IDENTITY).replace('export interface AttestedPrincipalV1 {', 'export interface MaxConnection {}\nexport interface AttestedPrincipalV1 {')),
  module_reintroduces_freshness: () => assertModuleSource(IDENTITY, read(IDENTITY).replace('export interface AttestedPrincipalV1 {', 'export const attestedUntil = 0\nexport interface AttestedPrincipalV1 {')),
  module_logs: () => assertModuleSource(WRITER, read(WRITER).replace('const CREATION_REASON', 'const unused = console.log\nconst CREATION_REASON')),
  module_gains_a_dependency: () => assertModuleSource(INTAKE, `import { readFileSync } from 'node:fs'\n${read(INTAKE)}`),
  principal_parsed_as_number: () => assertExactProviderForm(read(IDENTITY).replace('export function isExactProviderUserIdV1', 'export const asNumber = (v) => Number(v)\nexport function isExactProviderUserIdV1')),
  sentinels_accepted: () => assertExactProviderForm(read(IDENTITY).replace("new Set(['legacy', 'max-default'])", 'new Set([])')),
  open_key_uses_the_principal: () => assertTransportRefAuthority(read(IDENTITY).replace(
    'return `${transportKind}:${transportRef}`', 'return `${transportKind}:${transportRef}:${String(providerUserId)}`')),
  identity_state_reads_the_clock: () => assertIdentityStateIsDerived(read(IDENTITY).replace(
    "if (!input.hasOpenBinding) return 'no_open_transport'", "if (Date.now() < 0) return 'no_open_transport'\n    if (!input.hasOpenBinding) return 'no_open_transport'")),
  identity_state_ignores_lifecycle: () => assertIdentityStateIsDerived(read(IDENTITY).replace(
    "if (input.lifecycle !== 'active') return 'not_admitted'", "if (false) return 'not_admitted'")),
  projection_leaks_the_principal: () => assertProjectionShape(read(WRITER).replace('    lifecycle: string | null', '    lifecycle: string | null\n    providerUserId: string')),
  projection_calls_the_runtime: () => assertProjectionIsOffline(read(WRITER).replace(
    'return await prisma.$transaction(async (tx) => {\n        const open = await openBindingFor(tx, transportKind, transportRef)\n        if (!open) {',
    'await fetch(`${process.env.MAX_SCRAPER_URL}/status`)\n    return await prisma.$transaction(async (tx) => {\n        const open = await openBindingFor(tx, transportKind, transportRef)\n        if (!open) {')),
  trust_state_returns: () => assertNoTrustState([[WRITER, read(WRITER).replace('attestedProviderUserId: string | null', "trustState: 'verified'\n    attestedProviderUserId: string | null")]]),
  migration_drops_the_composite_key: () => assertMigrationContract(migration.replace(
    'FOREIGN KEY ("accountId", "attestedProviderUserId") REFERENCES "MaxAccount"("accountId", "providerUserId")',
    'FOREIGN KEY ("accountId") REFERENCES "MaxAccount"("accountId")')),
  migration_stores_a_credential: () => assertMigrationContract(`${migration}\nALTER TABLE "MaxAccount" ADD COLUMN "botToken" TEXT;`),
  migration_touches_history: () => assertMigrationContract(`${migration}\nALTER TABLE "MaxRouteConversation" ADD COLUMN "probe" TEXT;`),
  migration_carries_a_backfill: () => assertMigrationContract(`${migration}\nUPDATE "MaxAccount" SET "lifecycle" = 'active';`),
  migration_widens_the_transport_kind: () => assertMigrationContract(migration.replace(
    `"transportKind" IN ('web_session')`, `"transportKind" IN ('web_session', 'bot_api')`)),
  schema_binds_a_historical_table: () => assertNoHistoricalReuse(schema.replace(
    '  bindings              MaxTransportBinding[]',
    '  bindings              MaxTransportBinding[]\n  session               MaxPersonalSession @relation(fields: [accountId], references: [id])')),
  foundation_becomes_reachable: () => assertInert(['gravity-mvp/src/app/max-actions.ts']),
  public_surface_grows: () => assertNoPublicSurface([], { public_surface: ['MaxDeliveryPort.v1'] }),
  public_file_reexports_the_writer: () => assertNoPublicSurface(
    [['gravity-mvp/src/modules/max-channel/public/v1/index.ts', "export { recordMaxTransportAttestationV1 } from '../../internal/provider-account/max-account-writer'"]],
    JSON.parse(read(MANIFEST)),
  ),
}

const messages = {
  identity_reaches_database: /only the writer may reach the database/u,
  intake_reaches_database: /only the writer may reach the database/u,
  module_names_a_credential: /must never name a credential/u,
  module_infers_from_the_config_row: /identity may only come from the live authenticated principal/u,
  module_reintroduces_freshness: /no freshness state may exist/u,
  module_logs: /must not write outside the database/u,
  module_gains_a_dependency: /dependency is not allowed/u,
  principal_parsed_as_number: /never normalized, parsed as a number or shortened/u,
  sentinels_accepted: /sentinels the MAX runtime itself refuses/u,
  open_key_uses_the_principal: /open key may never be derived from the principal/u,
  identity_state_reads_the_clock: /must not depend on a clock or on runtime health/u,
  identity_state_ignores_lifecycle: /must refuse a lifecycle that is not active/u,
  projection_leaks_the_principal: /projection changed/u,
  projection_calls_the_runtime: /deterministic from durable state with no runtime call/u,
  trust_state_returns: /no durable trust state may exist/u,
  migration_drops_the_composite_key: /binding attests only its own account principal/u,
  migration_stores_a_credential: /must not store a credential/u,
  migration_touches_history: /may touch only the two new foundation tables/u,
  migration_carries_a_backfill: /carries no data statement/u,
  migration_widens_the_transport_kind: /single transport kind/u,
  schema_binds_a_historical_table: /must not relate to a historical MAX table/u,
  foundation_becomes_reachable: /must stay inert/u,
  public_surface_grows: /public surface changed/u,
  public_file_reexports_the_writer: /must not expose the provider account foundation/u,
}

for (const [name, probe] of Object.entries(rejected)) {
  assert.throws(probe, messages[name], `probe did not fail as expected: ${name}`)
}

console.log(JSON.stringify({
  status: 'PASS',
  control: 'max-provider-account-boundary',
  module_files: MODULE_FILES.length,
  importers: importers.length,
  database_sources: 1,
  inert: true,
  durable_trust_states: 0,
  public_surface_changes: 0,
  negative_probes: Object.keys(rejected).length,
}, null, 2))
