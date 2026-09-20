#!/usr/bin/env node

// M2A1-S3 boundary: the WhatsApp company-account writer owns the provider
// account foundation alone. Only its writer reaches the database, identity is
// decided from durable state rather than a runtime signal, the confirmation is
// authenticated and carries opaque identifiers only, no provider value reaches
// the log or the browser, and the module adds no cross-context public API.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const MODULE_DIR = 'gravity-mvp/src/modules/whatsapp-channel/internal/company-account'
const ATTESTATION = `${MODULE_DIR}/whatsapp-account-attestation.ts`
const TELEMETRY = `${MODULE_DIR}/whatsapp-account-telemetry.ts`
const WRITER = `${MODULE_DIR}/whatsapp-account-writer.ts`
const INTAKE = `${MODULE_DIR}/whatsapp-account-intake.ts`
const SOURCES = [ATTESTATION, TELEMETRY, WRITER, INTAKE]
const MODULE_FILES = [
  ...SOURCES,
  `${MODULE_DIR}/whatsapp-account-attestation.test.ts`,
  `${MODULE_DIR}/whatsapp-account-confirmation.postgres.test.ts`,
  `${MODULE_DIR}/whatsapp-account-foundation.postgres.test.ts`,
  `${MODULE_DIR}/whatsapp-account-intake.test.ts`,
  `${MODULE_DIR}/whatsapp-account-writer.test.ts`,
]

const SERVICE = 'gravity-mvp/src/lib/whatsapp/WhatsAppService.ts'
const ACTIONS = 'gravity-mvp/src/app/settings/integrations/whatsapp/whatsapp-actions.ts'
const DASHBOARD = 'gravity-mvp/src/app/settings/integrations/whatsapp/WhatsAppDashboard.tsx'
const SERVICE_TEST = 'gravity-mvp/src/lib/whatsapp/WhatsAppService.pairing-observation.test.ts'
const APPROVED_IMPORTERS = [SERVICE, SERVICE_TEST, ACTIONS]

const ALLOWED_MODULE_DEPENDENCIES = new Map([
  [ATTESTATION, []],
  [TELEMETRY, ['./whatsapp-account-attestation']],
  [WRITER, ['node:crypto', '@prisma/client', '@/lib/prisma', './whatsapp-account-attestation', './whatsapp-account-telemetry']],
  [INTAKE, ['@/infrastructure/operations/operational-log', './whatsapp-account-telemetry', './whatsapp-account-writer']],
])

const TELEMETRY_FIELDS = [
  'connectionId',
  'action',
  'outcome',
  'trustStateBefore',
  'trustStateAfter',
  'accountLifecycle',
  'generation',
  'operatorConfirmed',
  'unchangedSignal',
  'signalAgreedWithDatabase',
  'durationMs',
]

// A telemetry field may describe an identifier (present, valid, equal) but never be one.
const IDENTIFIER_FIELD = /^(?:pn|lid|jid|wid|phone|number|user|serialized|value|key|token|digest|hash|fingerprint|identifier|pair)$|(?:User|Jid|Wid|Phone|PhoneNumber|Number|Serialized|Value|Key|Token|Digest|Hash|Fingerprint|Identifier|Pair)$/u
const DATABASE = /@prisma\/|@\/lib\/prisma|\$queryRaw|\$executeRaw|\$transaction/u
const SIDE_CHANNELS = /\bconsole\.|\bprocess\.env\b|\bappendFileSync\b|\bwriteFile(?:Sync)?\b|\bfetch\(/u
// The S2 measurement module must stay the only place that names pairing observation.
const PAIRING_OBSERVATION_NAME = /pairing-observation|WhatsAppPairing|WHATSAPP_PAIRING_|observeWhatsAppPairing/u

function parse(relative, source) {
  const kind = relative.endsWith('.tsx') ? ts.ScriptKind.TSX : relative.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
  return ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, kind)
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

function referencesCompanyAccount(relative, specifier) {
  if (specifier.includes('whatsapp-channel/internal/company-account')) return true
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

export function companyAccountImporters(files) {
  return files
    .filter(([relative]) => !relative.startsWith(`${MODULE_DIR}/`))
    .filter(([relative, source]) => moduleReferences(relative, source).some((specifier) => referencesCompanyAccount(relative, specifier)))
    .map(([relative]) => relative)
    .sort()
}

export function assertModuleSource(relative, source) {
  const allowed = ALLOWED_MODULE_DEPENDENCIES.get(relative)
  assert(allowed, `unexpected company account source: ${relative}`)
  for (const dependency of moduleReferences(relative, source)) {
    assert(allowed.includes(dependency), `company account dependency is not allowed: ${relative} -> ${dependency}`)
  }
  const code = withoutComments(relative, source)
  assert.doesNotMatch(code, SIDE_CHANNELS, `company account must not write outside the telemetry contract: ${relative}`)
  assert.doesNotMatch(code, PAIRING_OBSERVATION_NAME, `company account must not name the pairing observation: ${relative}`)
  if (relative !== WRITER) {
    assert.doesNotMatch(code, DATABASE, `only the writer may reach the database: ${relative}`)
  }
}

/** Identity is decided from durable state: the runtime signal may only refuse. */
export function assertSignalNeverDecidesIdentity(source) {
  const code = withoutComments(ATTESTATION, source)
  const start = code.indexOf('export function decideWhatsAppAccountAttestationV1')
  assert(start >= 0, 'the durable decision function is missing')
  const body = code.slice(start)
  const identityActions = ['open_first_generation', 'reattest_open_generation', 'supersede_expired_generation', 'replace_mismatched_generation']
  for (const [, condition, action] of body.matchAll(/unchanged === (?:true|false)\)?\s*\{\s*return \{ action: '([a-z_]+)'/gu)) {
    void condition
    assert(!identityActions.includes(action), `the runtime signal must not select an identity action: ${action}`)
  }
  for (const match of body.matchAll(/if \(unchanged === (?:true|false)\) \{\s*return \{ action: '([a-z_]+)'/gu)) {
    assert.equal(match[1], 'refuse', `a branch on the runtime signal may only refuse, not ${match[1]}`)
  }
  assert.match(body, /unchanged === true/u, 'the contradiction where the signal claims no change is not checked')
  assert.match(body, /unchanged === false/u, 'the contradiction where the signal claims a change is not checked')
}

function stringArrayConstant(relative, source, name) {
  let values = null
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      let initializer = node.initializer
      if (ts.isAsExpression(initializer)) initializer = initializer.expression
      assert(ts.isArrayLiteralExpression(initializer), `${name} must be an array literal`)
      values = initializer.elements.map((element) => {
        assert(ts.isStringLiteral(element), `${name} must list string literals only`)
        return element.text
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(relative, source))
  assert(values, `${name} is missing`)
  return values
}

function frozenPayloadKeys(relative, source) {
  const keys = []
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.getText() === 'Object.freeze' && ts.isObjectLiteralExpression(node.arguments[0])) {
      for (const property of node.arguments[0].properties) {
        assert(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property), 'telemetry payload must list each field explicitly')
        keys.push(property.name.getText())
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(relative, source))
  return keys
}

export function assertTelemetryContract(source) {
  const fields = stringArrayConstant(TELEMETRY, source, 'WHATSAPP_ACCOUNT_TELEMETRY_FIELDS_V1')
  for (const field of fields) assert.doesNotMatch(field, IDENTIFIER_FIELD, `telemetry field names an identifier: ${field}`)
  assert.deepEqual(fields, TELEMETRY_FIELDS, 'telemetry allowlist changed')
  assert.deepEqual(frozenPayloadKeys(TELEMETRY, source), TELEMETRY_FIELDS, 'telemetry payload does not match the allowlist')
}

export function assertIntakeEmission(source) {
  const code = withoutComments(INTAKE, source)
  const emits = [...code.matchAll(/deps\.emit\(\s*([A-Z_0-9]+)\s*,/gu)].map((match) => match[1])
  assert.deepEqual([...new Set(emits)].sort(), [
    'WHATSAPP_ACCOUNT_TELEMETRY_EVENT_V1',
    'WHATSAPP_ACCOUNT_TELEMETRY_REJECTED_EVENT_V1',
  ], 'the intake may log only the built telemetry payload or an empty rejection')
  assert.equal([...code.matchAll(/\boperationalLogV1\(/gu)].length, 1, 'the intake must have exactly one log sink')
  assert.match(code, /export function recordObservedAttestationV1\(input: ObservedAttestationV1\): void/u, 'the runtime hand-off must return nothing')
}

/** The client supplies opaque identifiers only; the server re-reads the pair. */
export function assertConfirmationAction(source) {
  const confirm = /export async function confirmWhatsAppAccountBinding\(([^)]*)\)/u.exec(source)
  assert(confirm, 'the confirmation server action is missing')
  const parameters = confirm[1]
  assert.match(parameters, /^connectionId: string, bindingId: string$/u, 'the confirmation action may accept only opaque identifiers')
  assert.doesNotMatch(parameters, /pn|lid|phone|wid|jid/iu, 'the confirmation action must not accept a provider value')

  const projection = /export async function getWhatsAppAccountConfirmation\(([^)]*)\)/u.exec(source)
  assert(projection, 'the confirmation projection action is missing')
  assert.match(projection[1], /^connectionId: string$/u, 'the projection action may accept only the slot id')

  for (const name of ['confirmWhatsAppAccountBinding', 'getWhatsAppAccountConfirmation']) {
    const slice = source.slice(source.indexOf(`export async function ${name}(`))
    const body = slice.slice(0, slice.indexOf('\n}'))
    assert.match(body, /await requireIntegrationAdminAccess\(\)/u, `${name} must be authenticated`)
  }
  const confirmSlice = source.slice(source.indexOf('export async function confirmWhatsAppAccountBinding('))
  assert.match(confirmSlice, /principalId: principal\.id/u, 'the confirmation must record the authenticated principal')
  assert.doesNotMatch(confirmSlice.slice(0, confirmSlice.indexOf('\n}')), /crm_user_id/u, 'actor identity must never come from the unsigned selector')
}

/** The LID never reaches the browser. */
export function assertNoLidInClient(source) {
  const code = withoutComments(DASHBOARD, source)
  assert.doesNotMatch(code, /\blid\b|lidUser|LidValue/iu, 'the WhatsApp dashboard must never reference a LID')
  assert.match(code, /pnDisplay/u, 'the confirmation panel must render the display PN projection')
}

export function assertProjectionShape(source) {
  // Comments are stripped first: a docstring may describe the LID exclusion,
  // only a declared member may not exist.
  const code = withoutComments(WRITER, source)
  const start = code.indexOf('export interface SlotConfirmationProjectionV1')
  assert(start >= 0, 'the confirmation projection interface is missing')
  const body = code.slice(start, code.indexOf('}', start))
  assert.doesNotMatch(body, /lid/iu, 'the confirmation projection must not carry a LID')
  assert.doesNotMatch(body, /pnUser|pnValue/u, 'the confirmation projection must not carry a raw PN')
  assert.match(body, /pnDisplay: string \| null/u, 'the confirmation projection must expose the display PN only')
}

export function assertNoPublicSurface(publicFiles, manifest) {
  for (const [relative, source] of publicFiles) {
    assert.doesNotMatch(source, /company-account|CompanyAccount|recordWhatsAppAccountAttestation|confirmWhatsAppAccountBinding/u,
      `public API must not expose the company account writer: ${relative}`)
  }
  assert.deepEqual(manifest.public_surface, [
    'WhatsAppDeliveryPort.v1',
    'WhatsAppReachability.v1',
    'WhatsAppRuntimeOperations.v1',
    'WhatsAppStoreInspection.v1',
    'WhatsAppSessionStatus.v1',
  ], 'whatsapp_channel public surface changed')
}

// Current repository state.
const files = [
  ...sourceFiles('gravity-mvp/src'),
  ...sourceFiles('gravity-mvp/scripts'),
].map((relative) => [relative, read(relative)])

const presentModuleFiles = files.map(([relative]) => relative).filter((relative) => relative.startsWith(`${MODULE_DIR}/`))
assert.deepEqual(presentModuleFiles, [...MODULE_FILES].sort(), 'company account module files changed')

const importers = companyAccountImporters(files)
assert.deepEqual(importers, [...APPROVED_IMPORTERS].sort(), 'only the WhatsApp runtime and its settings actions may use the company account writer')
for (const importer of importers) {
  assert.doesNotMatch(importer, /\/modules\/(?:contacts|messaging|max-channel)\//u, 'another domain must not reach the company account writer')
  assert.doesNotMatch(importer, /\/public\//u, 'the company account writer must not be re-exported publicly')
}

for (const relative of SOURCES) assertModuleSource(relative, read(relative))
assertSignalNeverDecidesIdentity(read(ATTESTATION))
assertTelemetryContract(read(TELEMETRY))
assertIntakeEmission(read(INTAKE))
assertProjectionShape(read(WRITER))
assertConfirmationAction(read(ACTIONS))
assertNoLidInClient(read(DASHBOARD))
assertNoPublicSurface(
  files.filter(([relative]) => relative.startsWith('gravity-mvp/src/modules/whatsapp-channel/public/')),
  JSON.parse(read('architecture/contexts/v1/manifests/whatsapp_channel.json')),
)

// Negative probes: each rule must refuse a realistic violation.
const probes = {
  foreign_importer: () => companyAccountImporters([
    ...files,
    ['gravity-mvp/src/modules/contacts/internal/linker.ts', "import { recordWhatsAppAccountAttestationV1 } from '@/modules/whatsapp-channel/internal/company-account/whatsapp-account-writer'"],
  ]),
}
assert.deepEqual(probes.foreign_importer(), [...APPROVED_IMPORTERS, 'gravity-mvp/src/modules/contacts/internal/linker.ts'].sort(),
  'a foreign importer must be detected')

const rejected = {
  attestation_reaches_database: () => assertModuleSource(ATTESTATION, read(ATTESTATION) + '\nconst rows = await prisma.$queryRawUnsafe("SELECT 1")\n'),
  attestation_imports_prisma: () => assertModuleSource(ATTESTATION, `${read(ATTESTATION)}\nimport { prisma } from '@/lib/prisma'\n`),
  telemetry_reaches_database: () => assertModuleSource(TELEMETRY, `${read(TELEMETRY)}\nconst rows = await prisma.$queryRaw\`SELECT 1\`\n`),
  intake_logs_directly: () => assertModuleSource(INTAKE, read(INTAKE).replace('deps.emit(WHATSAPP_ACCOUNT_TELEMETRY_REJECTED_EVENT_V1, {})', 'console.log(input.pnUser)')),
  module_gains_a_dependency: () => assertModuleSource(ATTESTATION, `import { contactsPort } from '@/modules/contacts/public/v1'\n${read(ATTESTATION)}`),
  module_names_pairing_observation: () => assertModuleSource(ATTESTATION, `${read(ATTESTATION)}\nconst x = observeWhatsAppPairingV1\n`),
  signal_opens_a_generation: () => assertSignalNeverDecidesIdentity(
    read(ATTESTATION).replace(
      "if (unchanged === true) {\n            return { action: 'refuse', outcome: 'contradiction_unchanged_true_pair_differs', closeReason: null }",
      "if (unchanged === true) {\n            return { action: 'open_first_generation', outcome: 'contradiction_unchanged_true_pair_differs', closeReason: null }",
    ),
  ),
  telemetry_field_is_an_identifier: () => assertTelemetryContract(read(TELEMETRY).replace("'connectionId',", "'connectionId',\n    'pnUser',")),
  telemetry_payload_drifts: () => assertTelemetryContract(read(TELEMETRY).replace('generation: count(input.generation', 'generationValue: count(input.generation')),
  intake_emits_something_else: () => assertIntakeEmission(read(INTAKE).replace('deps.emit(WHATSAPP_ACCOUNT_TELEMETRY_REJECTED_EVENT_V1, {})', 'deps.emit(SOMETHING_ELSE_V1, { pnUser: input.pnUser })')),
  projection_carries_a_lid: () => assertProjectionShape(read(WRITER).replace('pnDisplay: string | null', 'pnDisplay: string | null\n    lidUser: string')),
  action_accepts_a_provider_value: () => assertConfirmationAction(read(ACTIONS).replace(
    'export async function confirmWhatsAppAccountBinding(connectionId: string, bindingId: string)',
    'export async function confirmWhatsAppAccountBinding(connectionId: string, bindingId: string, pnUser: string)',
  )),
  action_drops_authentication: () => assertConfirmationAction(read(ACTIONS).replace(
    "export async function confirmWhatsAppAccountBinding(connectionId: string, bindingId: string) {\n    const principal = await requireIntegrationAdminAccess()",
    'export async function confirmWhatsAppAccountBinding(connectionId: string, bindingId: string) {\n    const principal = { id: \'anonymous\' }',
  )),
  client_renders_a_lid: () => assertNoLidInClient(read(DASHBOARD).replace('pnDisplay', 'lidUser')),
  public_surface_grows: () => assertNoPublicSurface([], { public_surface: ['WhatsAppDeliveryPort.v1'] }),
  public_file_reexports_the_writer: () => assertNoPublicSurface(
    [['gravity-mvp/src/modules/whatsapp-channel/public/v1/index.ts', "export { confirmWhatsAppAccountBindingV1 } from '../../internal/company-account/whatsapp-account-writer'"]],
    JSON.parse(read('architecture/contexts/v1/manifests/whatsapp_channel.json')),
  ),
}

const messages = {
  attestation_reaches_database: /only the writer may reach the database/u,
  attestation_imports_prisma: /dependency is not allowed/u,
  telemetry_reaches_database: /only the writer may reach the database/u,
  intake_logs_directly: /must not write outside the telemetry contract/u,
  module_gains_a_dependency: /dependency is not allowed/u,
  module_names_pairing_observation: /must not name the pairing observation/u,
  signal_opens_a_generation: /may only refuse/u,
  telemetry_field_is_an_identifier: /telemetry field names an identifier/u,
  telemetry_payload_drifts: /telemetry payload does not match the allowlist/u,
  intake_emits_something_else: /may log only the built telemetry payload/u,
  projection_carries_a_lid: /must not carry a LID/u,
  action_accepts_a_provider_value: /may accept only opaque identifiers/u,
  action_drops_authentication: /must be authenticated/u,
  client_renders_a_lid: /must never reference a LID/u,
  public_surface_grows: /public surface changed/u,
  public_file_reexports_the_writer: /must not expose the company account writer/u,
}

for (const [name, probe] of Object.entries(rejected)) {
  assert.throws(probe, messages[name], `probe did not fail as expected: ${name}`)
}

console.log(JSON.stringify({
  status: 'PASS',
  control: 'whatsapp-company-account-boundary',
  module_files: MODULE_FILES.length,
  approved_importers: importers,
  telemetry_fields: TELEMETRY_FIELDS.length,
  database_sources: 1,
  public_surface_changes: 0,
  negative_probes: Object.keys(rejected).length + Object.keys(probes).length,
}, null, 2))
