#!/usr/bin/env node

// M2A2-TG1/TG2A boundary: the Telegram provider-account foundation owns
// Telegram account identity alone. The provider-authenticated getMe() id is the
// only identity authority, credentials never reach this module, only its writer
// touches the database, the projection carries no secret and no provider id,
// and it adds no cross-context public API.
//
// TG2A replaced inertness with an exact importer allowlist: the runtime and its
// tests may reach the intake, nothing else may, the writer keeps exactly one
// caller, the runtime hand-off can never fail into Telegram, and the ceremony
// may never report a pending account it did not read back.
//
// TG2B added exactly one public capability, the authenticated ingress a bot
// runtime reports through. It is the only public file that may reach the
// intake, it may never re-export the writer or the projection, and it must
// prove a reported statement authentic, well formed, fresh and unseen before
// anything durable happens.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const MODULE_DIR = 'gravity-mvp/src/modules/telegram-channel/internal/provider-account'
const IDENTITY = `${MODULE_DIR}/telegram-account-identity.ts`
const WRITER = `${MODULE_DIR}/telegram-account-writer.ts`
const INTAKE = `${MODULE_DIR}/telegram-account-intake.ts`
const SOURCES = [IDENTITY, WRITER, INTAKE]
const MODULE_FILES = [
  ...SOURCES,
  `${MODULE_DIR}/telegram-account-identity.test.ts`,
  `${MODULE_DIR}/telegram-account-intake.test.ts`,
  `${MODULE_DIR}/telegram-account-intake.postgres.test.ts`,
  `${MODULE_DIR}/telegram-provider-account.postgres.test.ts`,
]

// The runtime that observes live provider authentications, and its proof.
const RUNTIME = 'gravity-mvp/src/app/tg-actions.ts'
const RUNTIME_TEST = 'gravity-mvp/src/app/tg-actions.provider-account.test.ts'
// The authenticated cross-process ingress. It lives in the application layer,
// because a public facade may not reach its own context's internals; the public
// surface re-exports it.
const INGRESS = 'gravity-mvp/src/modules/telegram-channel/application/telegram-provider-account-attestation.ts'
const INGRESS_TEST = 'gravity-mvp/src/modules/telegram-channel/application/telegram-provider-account-attestation.test.ts'
const APPROVED_IMPORTERS = [RUNTIME, RUNTIME_TEST, INGRESS]

const MIGRATION = 'gravity-mvp/prisma/migrations/20260922120000_add_telegram_provider_account_foundation/migration.sql'
const SCHEMA = 'gravity-mvp/prisma/schema.prisma'

const ALLOWED_MODULE_DEPENDENCIES = new Map([
  [IDENTITY, []],
  [WRITER, ['node:crypto', '@prisma/client', '@/lib/prisma', './telegram-account-identity']],
  [INTAKE, ['@/infrastructure/operations/operational-log', './telegram-account-identity', './telegram-account-writer']],
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

/** Only the reviewed runtime may reach the foundation. */
export function assertApprovedImporters(importers) {
  assert.deepEqual(importers, [...APPROVED_IMPORTERS].sort(),
    'only the reviewed Telegram runtime may use the provider account foundation')
  for (const importer of importers) {
    assert.doesNotMatch(importer, /\/modules\/(?:contacts|messaging|max-channel|whatsapp-channel)\//u,
      'another domain must not reach the provider account foundation')
    assert.doesNotMatch(importer, /\/public\//u, 'a public facade may not reach the foundation; the application layer owns that composition')
  }
}

/** The writer keeps exactly one production caller: the intake. */
export function assertWriterCallers(files) {
  const callers = files
    .filter(([relative]) => relative !== WRITER)
    .filter(([relative, source]) => moduleReferences(relative, source).some((specifier) => /telegram-account-writer/u.test(specifier)))
    .map(([relative]) => relative)
    .sort()
  assert.deepEqual(callers, [
    INTAKE,
    `${MODULE_DIR}/telegram-account-intake.postgres.test.ts`,
    `${MODULE_DIR}/telegram-provider-account.postgres.test.ts`,
  ].sort(), 'only the intake and the foundation proofs may call the writer')
}

const INTAKE_METHOD_HEADERS = ['async observe(', 'async attestTransport(', 'async admit(', 'async describe(']

/** One method of the intake factory, bounded by the next method or export. */
function methodBody(code, header) {
  const start = code.indexOf(header)
  assert(start >= 0, `missing intake method: ${header}`)
  const after = start + header.length
  const ends = [
    ...INTAKE_METHOD_HEADERS.map((candidate) => code.indexOf(candidate, after)),
    code.indexOf('\nexport ', after),
  ].filter((index) => index >= 0)
  return code.slice(start, ends.length > 0 ? Math.min(...ends) : code.length)
}

function declarationBody(code, header) {
  const start = code.indexOf(header)
  assert(start >= 0, `missing declaration: ${header}`)
  const next = code.indexOf('\nexport ', start + header.length)
  return code.slice(start, next < 0 ? code.length : next)
}

/** Three orchestration modes over one writer, each with its own contract. */
export function assertIntakeModes(source) {
  const code = withoutComments(INTAKE, source)

  const runtime = declarationBody(code, 'export function recordObservedAttestationV1')
  assert.match(runtime, /: void/u, 'the runtime hand-off must not return a promise')
  assert.match(runtime, /void intake\(\)\.observe\(input\)/u, 'the runtime hand-off must not be awaited')
  assert.match(runtime, /catch/u, 'the runtime hand-off must swallow every failure')

  const observe = methodBody(code, 'async observe(')
  assert.match(observe, /catch/u, 'the runtime mode must swallow every failure')

  const ceremony = methodBody(code, 'async admit(')
  const attested = ceremony.indexOf('await attest(input')
  const projected = ceremony.indexOf('deps.project(')
  const admitted = ceremony.indexOf('deps.admit(')
  assert(attested >= 0 && projected > attested && admitted > projected,
    'the ceremony must attest, read the projection back and only then admit')

  for (const claim of [...code.matchAll(/status: 'pending_approval'/gu)]) {
    const preceding = code.slice(Math.max(0, claim.index - 200), claim.index)
    assert.match(preceding, /durablyPending/u,
      'a pending account may only be reported after the projection proved one exists')
  }

  const ingress = methodBody(code, 'async attestTransport(')
  assert.match(ingress, /await attest\(input, 'ingress'\)/u, 'the ingress mode must attest in its own mode')
  assert.doesNotMatch(ingress, /deps\.admit\(|deps\.project\(/u, 'the ingress mode must never admit or read back')
  assert.doesNotMatch(ingress, /catch/u, 'the ingress mode must surface a failure to its caller')

  const display = methodBody(code, 'async describe(')
  assert.doesNotMatch(display, /deps\.admit\(|deps\.record\(/u, 'the display read may never write or admit')
}

/** The runtime call site, the ceremony order and the locator source. */
export function assertRuntimeHandOff(source) {
  const code = withoutComments(RUNTIME, source)

  const handOff = code.indexOf('recordObservedAttestationV1({')
  assert(handOff >= 0, 'the runtime must hand its live observation to the foundation')
  assert.doesNotMatch(code, /await recordObservedAttestationV1/u, 'the runtime hand-off must not be awaited')
  assert.match(code.slice(Math.max(0, handOff - 200), handOff), /try \{/u,
    'the runtime hand-off must be guarded at the call site')

  assert.doesNotMatch(code, /transportRef: (?:providerAccountId|providerUserId|me\.|String\(providerAccountId\))/u,
    'the transport locator may never be derived from the provider principal')

  const ceremony = declarationBody(code, 'async function runTelegramProviderAccountAdmissionV1')
  const live = ceremony.indexOf('readLiveProviderPrincipal(input.client)')
  const admits = ceremony.indexOf('await admitTelegramProviderAccountV1(')
  assert(live >= 0 && admits > live, 'the ceremony must observe a live principal before it admits')

  const login = declarationBody(code, 'export async function checkTelegramAuthStatus')
  assert.match(login, /let admission[\s\S]{0,240}try \{[\s\S]{0,320}await runTelegramProviderAccountAdmissionV1/u,
    'a persisted login must not be able to fail because of the admission ceremony')
  assert.doesNotMatch(login, /transportRef: String\(connectionRow\?\.id \?\? telegramId\)|transportRef: telegramId/u,
    'the login locator must come from the persisted record with no fallback to the principal')

  const action = declarationBody(code, 'export async function admitTelegramProviderAccount')
  assert.match(action, /await requireIntegrationAdminAccess\(\)/u, 'admission must require an authenticated operator')
  assert.match(action, /await getTelegramClient\(connection\)/u, 'admission must re-attest from a live client')
  const state = declarationBody(code, 'export async function getTelegramProviderAccountState')
  assert.match(state, /await requireIntegrationAdminAccess\(\)/u, 'the state read must require an authenticated operator')
  assert.doesNotMatch(state, /admitTelegramProviderAccountV1/u, 'a stored projection may never admit an account')
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
    'TelegramProviderAccountAttestation.v1',
  ], 'telegram_channel public surface changed')
}

/**
 * The ingress capability: one bounded reach into the foundation, and a fixed
 * security order in which nothing durable happens before the statement is
 * proven.
 */
export function assertIngressCapability(source) {
  const code = withoutComments(INGRESS, source)

  assert.doesNotMatch(INGRESS, /\/public\//u, 'the ingress must not be a public facade source')
  const foundationImports = moduleReferences(INGRESS, source).filter((specifier) => /provider-account/u.test(specifier))
  assert.deepEqual(foundationImports, ['../internal/provider-account/telegram-account-intake'],
    'the ingress may reach the foundation only through the intake')
  assert.doesNotMatch(code, /recordTelegramTransportAttestationV1|readProviderAccountProjectionV1|admitTelegramAccountV1|ProviderAccountProjectionV1/u,
    'the ingress must not name the writer, the projection reader or the admission')

  const entry = declarationBody(code, 'export async function attestTelegramProviderAccountFromBotV1')
  const order = [
    ['action', /input\.action !== TELEGRAM_PROVIDER_ATTESTATION_ACTION_V1/u],
    ['shape', /parseTelegramProviderAttestationPayloadV1\(input\.payload\)/u],
    ['signature', /signatureMatches\(expected, payload\.signature\)/u],
    ['principal', /PROVIDER_USER_ID\.test\(payload\.providerUserId\)/u],
    ['transport', /payload\.transportRef === payload\.providerUserId/u],
    ['instance', /UUID\.test\(payload\.attestingInstanceId\)/u],
    ['freshness', /age > MAX_OBSERVATION_AGE_MS/u],
    ['replay', /deps\.replay\.admit\(payload\.attestationId, now\)/u],
    ['record', /await deps\.record\(/u],
  ]
  let previous = -1
  for (const [label, pattern] of order) {
    const match = entry.search(pattern)
    assert(match >= 0, `the ingress no longer checks: ${label}`)
    assert(match > previous, `the ingress security order changed at: ${label}`)
    previous = match
  }

  assert.match(code, /timingSafeEqual/u, 'the signature comparison must be constant time')
  assert.match(code, /createHash\('sha256'\)\.update\(`\$\{TELEGRAM_PROVIDER_ATTESTATION_DOMAIN_V1\}\|\$\{secret\}`\)/u,
    'the signing key must be derived from the shared secret')
  assert.match(code, /digest\('base64url'\)/u, 'the signature encoding changed')

  const telemetry = code.match(/deps\.emit\(TELEGRAM_PROVIDER_ATTESTATION_EVENT_V1, \{[^}]*\}/u)
  assert(telemetry, 'the ingress must report a bounded outcome')
  assert.doesNotMatch(telemetry[0], /providerUserId|transportRef|signature|secret|attestationId|attestingInstanceId/u,
    'ingress telemetry must carry no principal, locator, statement or credential')
}

// Current repository state.
const files = [
  ...sourceFiles('gravity-mvp/src'),
  ...sourceFiles('gravity-mvp/scripts'),
].map((relative) => [relative, read(relative)])

const presentModuleFiles = files.map(([relative]) => relative).filter((relative) => relative.startsWith(`${MODULE_DIR}/`))
assert.deepEqual(presentModuleFiles, [...MODULE_FILES].sort(), 'provider account module files changed')

const importers = providerAccountImporters(files)
assertApprovedImporters(importers)
assertWriterCallers(files)
assertIntakeModes(read(INTAKE))
assertRuntimeHandOff(read(RUNTIME))
assertIngressCapability(read(INGRESS))
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
  foreign_importer: () => assertApprovedImporters([...APPROVED_IMPORTERS, 'gravity-mvp/src/modules/contacts/internal/linker.ts'].sort()),
  writer_gains_a_caller: () => assertWriterCallers([
    ...files,
    ['gravity-mvp/src/app/tg-bot-actions.ts', "import { recordTelegramTransportAttestationV1 } from '@/modules/telegram-channel/internal/provider-account/telegram-account-writer'"],
  ]),
  runtime_mode_returns_a_promise: () => assertIntakeModes(read(INTAKE).replace('ObservedAttestationV1): void {', 'ObservedAttestationV1): Promise<void> {')),
  runtime_mode_is_awaited: () => assertIntakeModes(read(INTAKE).replace('void intake().observe(input)', 'await intake().observe(input)')),
  pending_without_proof: () => assertIntakeModes(read(INTAKE).replace(
    "return finish({ status: 'unavailable', reason: 'projection_unavailable' })",
    "return finish({ status: 'pending_approval', reason: 'projection_unavailable' })")),
  display_read_writes: () => assertIntakeModes(read(INTAKE).replace(
    'await deps.project(transportKind, transportRef)', 'await deps.record({})')),
  hand_off_is_awaited: () => assertRuntimeHandOff(read(RUNTIME).replace('recordObservedAttestationV1({', 'await recordObservedAttestationV1({')),
  hand_off_is_unguarded: () => assertRuntimeHandOff(read(RUNTIME).replace(
    'const cached = tgProviderAccountIds.get(connectionId)',
    'recordObservedAttestationV1({})\n    const cached = tgProviderAccountIds.get(connectionId)')),
  locator_from_the_principal: () => assertRuntimeHandOff(read(RUNTIME).replace('transportRef: connectionId,', 'transportRef: providerAccountId,')),
  ceremony_skips_the_live_principal: () => assertRuntimeHandOff(read(RUNTIME).replace(
    'await readLiveProviderPrincipal(input.client)', 'input.observedProviderUserId ?? ""')),
  admission_without_an_operator: () => assertRuntimeHandOff(read(RUNTIME).replace(
    `export async function admitTelegramProviderAccount(connectionId: string): Promise<TelegramAdmissionResultV1> {
    const principal = await requireIntegrationAdminAccess()`,
    `export async function admitTelegramProviderAccount(connectionId: string): Promise<TelegramAdmissionResultV1> {
    const principal = { id: 'anonymous' }`)),
  login_fails_on_admission: () => assertRuntimeHandOff(read(RUNTIME).replace(
    'let admission: TelegramAdmissionResultV1 = ', 'const admission: TelegramAdmissionResultV1 = ')),
  login_locator_falls_back_to_the_principal: () => assertRuntimeHandOff(read(RUNTIME).replace(
    'transportRef: persistedTransportRef,', 'transportRef: telegramId,')),
  ingress_reaches_the_writer_directly: () => assertIngressCapability(read(INGRESS).replace(
    "import { attestTelegramTransportV1 } from '../internal/provider-account/telegram-account-intake'",
    "import { recordTelegramTransportAttestationV1 } from '../internal/provider-account/telegram-account-writer'")),
  ingress_records_before_proving_the_signature: () => assertIngressCapability(read(INGRESS).replace(
    '    const secret = deps.secret()',
    '    await deps.record({ transportKind: \'bot_runtime\', transportRef: payload.transportRef, accountKind: \'bot_api\', providerUserId: payload.providerUserId, attestingInstanceId: payload.attestingInstanceId })\n    const secret = deps.secret()')),
  ingress_records_before_the_replay_check: () => assertIngressCapability(read(INGRESS).replace(
    '    if (!deps.replay.admit(payload.attestationId, now)) return report(\'replayed\')',
    '    const early = await deps.record({ transportKind: \'bot_runtime\', transportRef: payload.transportRef, accountKind: \'bot_api\', providerUserId: payload.providerUserId, attestingInstanceId: payload.attestingInstanceId })\n    if (!deps.replay.admit(payload.attestationId, now)) return report(\'replayed\')')),
  ingress_compares_the_signature_loosely: () => assertIngressCapability(read(INGRESS).replaceAll('timingSafeEqual', 'Object.is')),
  ingress_signs_with_the_bearer_secret: () => assertIngressCapability(read(INGRESS).replace(
    'createHash(\'sha256\').update(`${TELEGRAM_PROVIDER_ATTESTATION_DOMAIN_V1}|${secret}`).digest()',
    'Buffer.from(secret)')),
  ingress_telemetry_leaks_the_principal: () => assertIngressCapability(read(INGRESS).replace(
    "{ channel: 'telegram', transportKind: 'bot_runtime', outcome }",
    "{ channel: 'telegram', transportKind: 'bot_runtime', outcome, providerUserId: 'x' }")),
  ingress_mode_admits: () => assertIntakeModes(read(INTAKE).replace(
    "            return await attest(input, 'ingress')",
    "            await deps.admit({ accountId: 'x', principalId: 'y' })\n            return await attest(input, 'ingress')")),
  ingress_mode_swallows_failures: () => assertIntakeModes(read(INTAKE).replace(
    "            return await attest(input, 'ingress')",
    "            try { return await attest(input, 'ingress') } catch { throw new Error('x') }")),
  public_importer_that_is_not_the_ingress: () => assertApprovedImporters(
    [...APPROVED_IMPORTERS, 'gravity-mvp/src/modules/telegram-channel/public/v1/bot-message-delivery.ts'].sort()),
  stored_projection_admits: () => assertRuntimeHandOff(read(RUNTIME).replace(
    "return await describeTelegramProviderAccountV1('mtproto_session', transportRef)",
    "return await admitTelegramProviderAccountV1({}, 'anonymous')")),
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
  foreign_importer: /only the reviewed Telegram runtime/u,
  writer_gains_a_caller: /only the intake and the foundation proofs/u,
  runtime_mode_returns_a_promise: /must not return a promise/u,
  runtime_mode_is_awaited: /must not be awaited/u,
  pending_without_proof: /may only be reported after the projection proved one exists/u,
  display_read_writes: /display read may never write or admit/u,
  hand_off_is_awaited: /hand-off must not be awaited/u,
  hand_off_is_unguarded: /must be guarded at the call site/u,
  locator_from_the_principal: /never be derived from the provider principal/u,
  ceremony_skips_the_live_principal: /must observe a live principal before it admits/u,
  admission_without_an_operator: /admission must require an authenticated operator/u,
  login_fails_on_admission: /must not be able to fail because of the admission ceremony/u,
  login_locator_falls_back_to_the_principal: /locator must come from the persisted record/u,
  ingress_reaches_the_writer_directly: /only through the intake/u,
  ingress_records_before_proving_the_signature: /ingress security order changed/u,
  ingress_records_before_the_replay_check: /ingress security order changed/u,
  ingress_compares_the_signature_loosely: /signature comparison must be constant time/u,
  ingress_signs_with_the_bearer_secret: /signing key must be derived/u,
  ingress_telemetry_leaks_the_principal: /telemetry must carry no principal/u,
  ingress_mode_admits: /ingress mode must never admit or read back/u,
  ingress_mode_swallows_failures: /ingress mode must surface a failure/u,
  public_importer_that_is_not_the_ingress: /only the reviewed Telegram runtime/u,
  stored_projection_admits: /stored projection may never admit an account/u,
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
  approved_importers: APPROVED_IMPORTERS.length,
  writer_callers: 3,
  database_sources: 1,
  orchestration_modes: 3,
  public_surface_entries: 7,
  negative_probes: Object.keys(rejected).length,
}, null, 2))
