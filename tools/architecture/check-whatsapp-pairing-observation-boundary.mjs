#!/usr/bin/env node

// M2A1-S2 boundary: the WhatsApp pairing observation stays measurement only.
// It is reachable only from the WhatsApp runtime lifecycle hooks, has no
// database or foundation-model dependency, logs only allowlisted classes and
// counts, and adds no cross-context public API.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const MODULE_DIR = 'gravity-mvp/src/modules/whatsapp-channel/internal/pairing-observation'
const OBSERVATION = `${MODULE_DIR}/whatsapp-pairing-observation.ts`
const TELEMETRY = `${MODULE_DIR}/whatsapp-pairing-telemetry.ts`
const OBSERVER = `${MODULE_DIR}/whatsapp-pairing-observer.ts`
const MODULE_TEST = `${MODULE_DIR}/whatsapp-pairing-observation.test.ts`
const MODULE_FILES = [OBSERVATION, TELEMETRY, OBSERVER, MODULE_TEST]
const SERVICE = 'gravity-mvp/src/lib/whatsapp/WhatsAppService.ts'
const SERVICE_TEST = 'gravity-mvp/src/lib/whatsapp/WhatsAppService.pairing-observation.test.ts'
const OBSERVER_SPECIFIER = '@/modules/whatsapp-channel/internal/pairing-observation/whatsapp-pairing-observer'
const APPROVED_IMPORTERS = [SERVICE, SERVICE_TEST]
const LIFECYCLE_EVENTS = ['qr', 'ready', 'disconnected']

const ALLOWED_MODULE_DEPENDENCIES = new Map([
  [OBSERVATION, []],
  [TELEMETRY, ['./whatsapp-pairing-observation']],
  [OBSERVER, ['node:crypto', '@/infrastructure/operations/operational-log', './whatsapp-pairing-observation', './whatsapp-pairing-telemetry']],
])

const TELEMETRY_FIELDS = [
  'connectionId',
  'instanceOrdinal',
  'lifecycleEvent',
  'reasonClass',
  'outcome',
  'readyCount',
  'coalescedReadyCount',
  'qrCount',
  'qrSeen',
  'socketStateClass',
  'hasSynced',
  'pnPresent',
  'pnShapeValid',
  'lidPresent',
  'lidShapeValid',
  'pnDiffersFromLid',
  'infoWidMatchesPn',
  'unchangedSincePreviousObservation',
  'waWebVersion',
  'durationMs',
]
// A telemetry field may describe an identifier (present, valid, equal) but never be one.
const IDENTIFIER_FIELD = /^(?:pn|lid|jid|wid|phone|number|user|serialized|value|key|token|digest|hash|fingerprint|identifier|pair)$|(?:User|Jid|Wid|Phone|PhoneNumber|Number|Serialized|Value|Key|Token|Digest|Hash|Fingerprint|Identifier|Pair)$/u
const DATABASE_OR_FOUNDATION = /@prisma\/|@\/lib\/prisma|\bprisma\b|\$queryRaw|\$executeRaw|\bWhatsAppAccount(?:Key)?\b|\bWhatsAppTransportBinding\b|\bWhatsAppCapabilityLease\b|\bwhatsApp(?:Account|AccountKey|TransportBinding|CapabilityLease)\b/u
const SIDE_CHANNELS = /\bconsole\.|\bprocess\.env\b|\bappendFileSync\b|\bwriteFile(?:Sync)?\b|\bcreateHash\b|\bfetch\(/u

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
      // A bare require is a Node dependency; scope.require inside the page function is
      // WhatsApp Web's own module loader and is not a dependency of this repository.
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

function referencesPairingObservation(relative, specifier) {
  if (specifier.includes('whatsapp-channel/internal/pairing-observation')) return true
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

export function pairingObservationImporters(files) {
  return files
    .filter(([relative]) => !relative.startsWith(`${MODULE_DIR}/`))
    .filter(([relative, source]) => moduleReferences(relative, source).some((specifier) => referencesPairingObservation(relative, specifier)))
    .map(([relative]) => relative)
    .sort()
}

export function assertModuleSource(relative, source) {
  const allowed = ALLOWED_MODULE_DEPENDENCIES.get(relative)
  assert(allowed, `unexpected pairing observation source: ${relative}`)
  const dependencies = moduleReferences(relative, source)
  for (const dependency of dependencies) {
    assert(allowed.includes(dependency), `pairing observation dependency is not allowed: ${relative} -> ${dependency}`)
  }
  const code = withoutComments(relative, source)
  assert.doesNotMatch(code, DATABASE_OR_FOUNDATION, `pairing observation must not touch the database or foundation models: ${relative}`)
  assert.doesNotMatch(code, SIDE_CHANNELS, `pairing observation must not write outside the telemetry contract: ${relative}`)
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
  const fields = stringArrayConstant(TELEMETRY, source, 'WHATSAPP_PAIRING_TELEMETRY_FIELDS_V1')
  assert.deepEqual(fields, TELEMETRY_FIELDS, 'telemetry allowlist changed')
  for (const field of fields) assert.doesNotMatch(field, IDENTIFIER_FIELD, `telemetry field names an identifier: ${field}`)
  assert.deepEqual(frozenPayloadKeys(TELEMETRY, source), TELEMETRY_FIELDS, 'telemetry payload does not match the allowlist')
}

export function assertObserverEmission(source) {
  const code = withoutComments(OBSERVER, source)
  const emits = [...code.matchAll(/deps\.emit\(([^)]*\([^)]*\)|[^)]*)\)/gu)].map((match) => match[1].replace(/\s+/gu, ' ').trim())
  assert.deepEqual(emits.sort(), [
    'WHATSAPP_PAIRING_TELEMETRY_EVENT_V1, buildWhatsAppPairingTelemetryV1(input)',
    'WHATSAPP_PAIRING_TELEMETRY_REJECTED_EVENT_V1, {}',
  ], 'observer may log only the built telemetry payload or an empty rejection')
  assert.equal([...code.matchAll(/\boperationalLogV1\(/gu)].length, 1, 'observer must have exactly one log sink')
}

function handlerSlice(source, event) {
  const start = source.indexOf(`client.on('${event}'`)
  assert(start >= 0, `WhatsAppService ${event} handler is missing`)
  const next = source.indexOf('client.on(', start + 1)
  return source.slice(start, next < 0 ? source.length : next)
}

export function assertServiceHooks(source) {
  const imports = moduleReferences(SERVICE, source).filter((specifier) => referencesPairingObservation(SERVICE, specifier))
  assert.deepEqual(imports, [OBSERVER_SPECIFIER], 'WhatsAppService may import only the pairing observer')
  assert.match(source, /import \{ observeWhatsAppPairingV1 \} from '@\/modules\/whatsapp-channel\/internal\/pairing-observation\/whatsapp-pairing-observer'/u)
  const calls = [...source.matchAll(/observeWhatsAppPairingV1\(\{ \.\.\.pairingObservationSource, event: '(\w+)'/gu)].map((match) => match[1])
  assert.deepEqual(calls, LIFECYCLE_EVENTS, 'pairing observation is called once from each approved lifecycle handler only')
  assert.equal([...source.matchAll(/observeWhatsAppPairingV1\(/gu)].length, LIFECYCLE_EVENTS.length)
  assert.doesNotMatch(source, /(?:await|return|=|\.then)\s*observeWhatsAppPairingV1\(/u, 'the observer result must never be awaited or used')
  assert.match(source, /isCurrentInstance: \(\) => instanceIds\.get\(connectionId\) === instanceId && clients\.get\(connectionId\) === client,/u)

  const anchors = {
    qr: "await safeUpdateConnection(connectionId, { status: 'qr', sessionData: null })",
    ready: "opsLog('info', 'wa_sync_skipped_already_done', { connectionId, instanceId })",
    disconnected: 'registry.scheduleReconnect(connectionId, instanceId, () => initializeClient(connectionId))',
  }
  for (const event of LIFECYCLE_EVENTS) {
    const slice = handlerSlice(source, event)
    const call = slice.indexOf(`observeWhatsAppPairingV1({ ...pairingObservationSource, event: '${event}'`)
    const anchor = slice.indexOf(anchors[event])
    assert(anchor >= 0 && call > anchor, `${event} observation must run after the existing ${event} handling`)
    assert(call < slice.indexOf('} catch'), `${event} observation must stay inside the handler try block`)
  }
}

export function assertNoPublicSurface(publicFiles, manifest, registry) {
  for (const [relative, source] of publicFiles) {
    assert.doesNotMatch(source, /pairing-observation|PairingObservation|observeWhatsAppPairing/u, `public API must not expose pairing observation: ${relative}`)
  }
  const expectedSurface = [
    'WhatsAppDeliveryPort.v1',
    'WhatsAppReachability.v1',
    'WhatsAppRuntimeOperations.v1',
    'WhatsAppStoreInspection.v1',
    'WhatsAppSessionStatus.v1',
  ]
  assert.deepEqual(manifest.public_surface, expectedSurface, 'whatsapp_channel public surface changed')
  const surface = registry.context_surfaces.find((entry) => entry.id === 'whatsapp_channel.public.v1')
  assert(surface, 'whatsapp_channel public contract surface is missing')
  assert.deepEqual([...surface.capabilities].sort(), [...expectedSurface].sort(), 'whatsapp_channel registered capabilities changed')
  assert.deepEqual(surface.commands, ['SendWhatsAppMessageCommand.v1', 'SynchronizeWhatsAppHistoryCommand.v1'])
  assert.deepEqual(surface.events, ['WhatsAppMessageObserved.v1', 'WhatsAppSessionChanged.v1'])
}

// Current repository state.
const files = [
  ...sourceFiles('gravity-mvp/src'),
  ...sourceFiles('gravity-mvp/scripts'),
].map((relative) => [relative, read(relative)])
const presentModuleFiles = files.map(([relative]) => relative).filter((relative) => relative.startsWith(`${MODULE_DIR}/`))
assert.deepEqual(presentModuleFiles, [...MODULE_FILES].sort(), 'pairing observation module files changed')

const importers = pairingObservationImporters(files)
assert.deepEqual(importers, [...APPROVED_IMPORTERS].sort(), 'only the WhatsApp runtime may use pairing observation')
for (const importer of importers) {
  assert.doesNotMatch(importer, /\/modules\/(?:contacts|messaging)\//u)
  assert.doesNotMatch(importer, /\/public\//u)
}

for (const relative of [OBSERVATION, TELEMETRY, OBSERVER]) assertModuleSource(relative, read(relative))
assert.match(withoutComments(OBSERVER, read(OBSERVER)), /createHmac\('sha256', deps\.comparisonKey\)/u)
assert.match(read(OBSERVER), /comparisonKey: randomBytes\(32\)/u)
assertTelemetryContract(read(TELEMETRY))
assertObserverEmission(read(OBSERVER))
assertServiceHooks(read(SERVICE))

const publicFiles = files.filter(([relative]) => relative.startsWith('gravity-mvp/src/modules/whatsapp-channel/public/'))
assertNoPublicSurface(
  publicFiles,
  JSON.parse(read('architecture/contexts/v1/manifests/whatsapp_channel.json')),
  JSON.parse(read('architecture/contracts/v1/registry.json')),
)

// Negative probes: each rule must refuse a realistic violation.
const probes = {
  messaging_importer: () => pairingObservationImporters([
    ...files,
    ['gravity-mvp/src/modules/messaging/internal/probe.ts', `import { observeWhatsAppPairingV1 } from '${OBSERVER_SPECIFIER}'\n`],
  ]).includes('gravity-mvp/src/modules/messaging/internal/probe.ts'),
  public_relative_importer: () => pairingObservationImporters([
    ['gravity-mvp/src/modules/whatsapp-channel/public/v1/probe.ts', "export { classifyWhatsAppPairingObservationV1 } from '../../internal/pairing-observation/whatsapp-pairing-observation'\n"],
  ]).length === 1,
}
for (const [name, probe] of Object.entries(probes)) assert.equal(probe(), true, `negative probe did not detect: ${name}`)

const rejected = {
  prisma_dependency: () => assertModuleSource(OBSERVER, `${read(OBSERVER)}\nimport { prisma } from '@/lib/prisma'\n`),
  foundation_model: () => assertModuleSource(OBSERVATION, `${read(OBSERVATION)}\nexport const probe = 'WhatsAppTransportBinding'.length\nconst model = prisma.whatsAppTransportBinding\n`),
  console_side_channel: () => assertModuleSource(OBSERVER, `${read(OBSERVER)}\nconsole.log('probe')\n`),
  identifier_field: () => assertTelemetryContract(read(TELEMETRY).replace("'durationMs',\n] as const", "'durationMs',\n    'pnUser',\n] as const")),
  unlisted_payload_field: () => assertTelemetryContract(read(TELEMETRY).replace('durationMs: count(', 'lidUser: input.waWebVersion,\n        durationMs: count(')),
  raw_emit: () => assertObserverEmission(`${read(OBSERVER)}\nfunction probe(deps) { deps.emit('wa_pairing_observation', { pn: 'x' }) }\n`),
  awaited_hook: () => assertServiceHooks(read(SERVICE).replace("observeWhatsAppPairingV1({ ...pairingObservationSource, event: 'ready' })", "await observeWhatsAppPairingV1({ ...pairingObservationSource, event: 'ready' })")),
  hook_before_existing_work: () => {
    const source = read(SERVICE)
      .replace("            observeWhatsAppPairingV1({ ...pairingObservationSource, event: 'ready' })\n", '')
      .replace('            registry.setReady(connectionId, instanceId)\n', "            registry.setReady(connectionId, instanceId)\n            observeWhatsAppPairingV1({ ...pairingObservationSource, event: 'ready' })\n")
    assertServiceHooks(source)
  },
  extra_lifecycle_hook: () => assertServiceHooks(read(SERVICE).replace("clearPendingWhatsAppQr(connectionId, instanceId)\n            opsLog('error', 'wa_auth_failure'", "clearPendingWhatsAppQr(connectionId, instanceId)\n            observeWhatsAppPairingV1({ ...pairingObservationSource, event: 'auth_failure' })\n            opsLog('error', 'wa_auth_failure'")),
  public_surface: () => assertNoPublicSurface(
    [['gravity-mvp/src/modules/whatsapp-channel/public/v1/probe.ts', "export type { WhatsAppPairingObservationFlagsV1 } from '../../internal/pairing-observation/whatsapp-pairing-observation'\n"]],
    JSON.parse(read('architecture/contexts/v1/manifests/whatsapp_channel.json')),
    JSON.parse(read('architecture/contracts/v1/registry.json')),
  ),
}
for (const [name, probe] of Object.entries(rejected)) {
  assert.throws(probe, `negative probe was not rejected: ${name}`)
}

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  module_files: presentModuleFiles.length,
  approved_importers: importers,
  telemetry_fields: TELEMETRY_FIELDS.length,
  lifecycle_hooks: LIFECYCLE_EVENTS,
  database_dependencies: 0,
  public_surface_changes: 0,
  negative_probes: Object.keys(probes).length + Object.keys(rejected).length,
}, null, 2)}\n`)
