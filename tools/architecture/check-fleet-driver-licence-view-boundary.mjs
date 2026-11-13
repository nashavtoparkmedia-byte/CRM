#!/usr/bin/env node
// Fleet Operations driving-licence (ВУ) view boundary (Owner D2, OD-03).
//
// Fleet's licence-carrying public reads, DriverProfilesForContactsQuery.v2 and
// DriverProfilesByExactLicenceQuery.v1, show a stored licence only as the
// caller's licence view allows. This control pins that:
// 1. both queries require a view of exactly 'full' | 'last4', and no refusal of
//    the exact-licence query quotes the typed licence;
// 2. maskDriverLicenceV1 is the only place that turns a view into a shown
//    licence: only an exact 'full' shows the stored text, everything else shows
//    at most the last four characters;
// 3. the handlers parse before they read, set `licence` only through the mask
//    with the parsed view, and the v2 handler reuses v1's read unchanged;
// 4. the one reader of the stored licence is read-only, parameterized and
//    touches Fleet-owned Driver and Park rows only;
// 5. the bindings, the public surface and the declarations are in place.
// Each rule is checked against known mutants, which must all be caught, and
// then the proofs run.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const VIEW = 'gravity-mvp/src/contracts/fleet-operations/v1/driver-licence-view.ts'
const EXACT_CONTRACT = 'gravity-mvp/src/contracts/fleet-operations/v1/driver-profiles-by-exact-licence-query.ts'
const V1_INDEX = 'gravity-mvp/src/contracts/fleet-operations/v1/index.ts'
const V2_CONTRACT = 'gravity-mvp/src/contracts/fleet-operations/v2/driver-profiles-for-contacts-query.ts'
const V2_INDEX = 'gravity-mvp/src/contracts/fleet-operations/v2/index.ts'
const MASK = 'gravity-mvp/src/modules/fleet-operations/public/v1/driver-licence-mask.ts'
const PORT = 'gravity-mvp/src/modules/fleet-operations/public/v1/driver-licence-read-port.ts'
const ADAPTER = 'gravity-mvp/src/modules/fleet-operations/public/v1/legacy-prisma-driver-licence-adapter.ts'
const V2_HANDLER = 'gravity-mvp/src/modules/fleet-operations/public/v1/driver-profiles-for-contacts-v2-handler.ts'
const EXACT_HANDLER = 'gravity-mvp/src/modules/fleet-operations/public/v1/driver-profiles-by-exact-licence-handler.ts'
const APPLICATION = 'gravity-mvp/src/modules/fleet-operations/application/fleet-operations.ts'
const PUBLIC_INDEX = 'gravity-mvp/src/modules/fleet-operations/public/v1/index.ts'
const MANIFEST = 'architecture/contexts/v1/manifests/fleet_operations.json'
const REGISTRY = 'architecture/contracts/v1/registry.json'
const CAPABILITIES = ['DriverProfilesForContactsQuery.v2', 'DriverProfilesByExactLicenceQuery.v1']
const CONTROL = 'node tools/architecture/check-fleet-driver-licence-view-boundary.mjs'
const LICENCE_FILES = [VIEW, EXACT_CONTRACT, V2_CONTRACT, MASK, PORT, ADAPTER, V2_HANDLER, EXACT_HANDLER]

const WRITE_VOCABULARY = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\$executeRaw|Unsafe\b|\$transaction/u
const FOREIGN_TABLES = /\bprisma\.(contact|contactIdentity|contactPhone|contactMerge|chat|message|telegram\w*|whatsApp\w*|max\w*|user|crmUser)\b|"(Contact|ContactIdentity|ContactPhone|Chat|Message|User)"/u
const LIVE_VOCABULARY = /\b(fetch|reconcileYandexFleet|fetchParkProfiles|searchYandexParks|scraper|axios)\b/u

export function passingProofCount(stdout) {
  const plain = stripVTControlCharacters(String(stdout ?? ''))
  const matched = /Tests\s+(\d+)\s+passed/u.exec(plain)
  return matched === null ? null : Number(matched[1])
}

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1')
}

function interfaceBody(source, header) {
  const start = source.indexOf(header)
  assert(start >= 0, `${header} is not declared`)
  return source.slice(start, source.indexOf('\n}', start))
}

function fieldNames(body) {
  return [...body.matchAll(/^\s{2}(\w+)\??:/gmu)].map((match) => match[1]).sort()
}

function count(source, needle) {
  return source.split(needle).length - 1
}

/** 1. Both queries require an exact view; the exact-licence query never echoes the typed licence. */
function assertContracts(read) {
  const view = withoutComments(read(VIEW))
  assert(view.includes("export const DRIVER_LICENCE_VIEWS_V1 = ['full', 'last4'] as const"), 'the licence views changed')
  assert(view.includes('(DRIVER_LICENCE_VIEWS_V1 as readonly string[]).includes(value)'), 'the view check is not an exact membership test')

  const exact = withoutComments(read(EXACT_CONTRACT))
  assert(exact.includes("DRIVER_PROFILES_BY_EXACT_LICENCE_QUERY_V1 = 'fleet_operations.DriverProfilesByExactLicenceQuery.v1' as const"), 'the exact-licence query id changed')
  assert.deepEqual(fieldNames(interfaceBody(exact, 'export interface DriverProfilesByExactLicenceQueryV1 {')), ['contract', 'licence', 'licenceView'], 'the exact-licence query shape changed')
  assert.deepEqual(fieldNames(interfaceBody(exact, 'export interface DriverProfileByExactLicenceV1 {')),
    ['dismissedAt', 'driverId', 'externalDriverProfileId', 'externalParkId', 'fullName', 'licence', 'linkedContactId', 'parkName'],
    'the exact-licence profile shape changed')
  assert.deepEqual(fieldNames(interfaceBody(exact, 'export interface DriverProfilesByExactLicenceResultV1 {')), ['contract', 'profiles', 'truncated'], 'the exact-licence answer carries more than profiles')
  assert(exact.includes("key !== 'contract' && key !== 'licence' && key !== 'licenceView'"), 'the exact-licence parser accepts other fields')
  assert(exact.includes("if (!isDriverLicenceViewV1(input.licenceView)) invalid('licenceView must be full or last4')"), 'the exact-licence query no longer requires a view')
  assert(exact.includes('DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_PROFILES_V1 = 20'), 'the exact-licence bound changed')
  assert(exact.includes('input.licence.length > DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_INPUT_V1'), 'the typed value is no longer bounded')
  for (const message of exact.matchAll(/(?:invalid|ValidationError)\(([^\n]*)\)/gu)) {
    assert(!/\$\{[^}]*\b(input|licence)\b/u.test(message[1]) && !/\binput\.licence\b/u.test(message[1].replace(/^'[^']*'/u, '')),
      'a refusal of the exact-licence query quotes the typed value')
  }
  assert(!/\$\{\s*input\.(licence|contract)\s*\}/u.test(exact), 'the exact-licence parser interpolates the input')
  assert(read(V1_INDEX).includes("export * from './driver-licence-view'") && read(V1_INDEX).includes("export * from './driver-profiles-by-exact-licence-query'"), 'the v1 licence contracts are not exported')

  const v2 = withoutComments(read(V2_CONTRACT))
  assert(v2.includes("DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2 = 'fleet_operations.DriverProfilesForContactsQuery.v2' as const"), 'the v2 query id changed')
  assert.deepEqual(fieldNames(interfaceBody(v2, 'export interface DriverProfilesForContactsQueryV2 {')), ['contract', 'licenceView', 'subjects'], 'the v2 query shape changed')
  assert.deepEqual(fieldNames(interfaceBody(v2, 'export interface DriverProfileForContactV2 extends DriverProfileForContactV1 {')), ['licence'], 'v2 adds more than the licence to the v1 profile')
  assert.deepEqual(fieldNames(interfaceBody(v2, 'export interface DriverProfilesForContactsResultV2 {')), ['contract', 'entries', 'licenceView'], 'the v2 answer shape changed')
  assert.deepEqual(fieldNames(interfaceBody(v2, 'export interface DriverProfilesForContactEntryV2 {')), ['contactId', 'profiles'], 'the v2 entry shape changed')
  assert(v2.includes("key !== 'contract' && key !== 'licenceView' && key !== 'subjects'"), 'the v2 parser accepts other fields')
  assert(v2.includes("if (!isDriverLicenceViewV1(input.licenceView)) invalid('licenceView must be full or last4')"), 'the v2 query no longer requires a view')
  assert(v2.includes('parseDriverProfilesForContactsQueryV1({ contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1, subjects: input.subjects })'), 'v2 subjects are no longer checked by the v1 parser')
  assert(read(V2_INDEX).includes("export * from './driver-profiles-for-contacts-query'"), 'the v2 contract is not exported')
}

/** 2. The mask is the only place that turns a view into a shown licence. */
function assertMask(read) {
  const mask = withoutComments(read(MASK))
  assert.equal(count(mask, "'full'"), 1, 'the mask compares the view more than once')
  assert(mask.includes("if (licenceView === 'full') return text"), 'the mask no longer shows the stored text only for the exact full view')
  assert(mask.includes('if (key === null || key.length < DRIVER_LICENCE_MIN_MASKABLE_LENGTH_V1) return DRIVER_LICENCE_MASK_V1'), 'a short licence is no longer fully masked')
  assert(mask.includes('return `${DRIVER_LICENCE_MASK_V1} ${key.slice(-4)}`'), 'the masked view shows more than the last four characters')
  assert(mask.includes('DRIVER_LICENCE_MIN_MASKABLE_LENGTH_V1 = 8'), 'the maskable length changed')
  assert(mask.includes("value.toUpperCase().replace(/[^0-9A-ZА-ЯЁ]/gu, '')"), 'the licence key changed')
  assert(!/'last4'/u.test(mask), 'the mask branches on last4 instead of failing closed')
  for (const file of [V2_HANDLER, EXACT_HANDLER, ADAPTER, PORT]) {
    const source = withoutComments(read(file))
    assert(!/'full'|'last4'/u.test(source), `${path.basename(file)} names a licence view; only the mask may`)
  }
}

/** 3. The handlers parse first, mask with the parsed view, and v2 reuses v1. */
function assertHandlers(read) {
  const v2 = withoutComments(read(V2_HANDLER))
  const parseAt = v2.indexOf('const parsed = parseDriverProfilesForContactsQueryV2(query)')
  const v1At = v2.indexOf('await readV1({ contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1, subjects: parsed.subjects })')
  const licencesAt = v2.indexOf('await licences.findLicencesOfDrivers(driverIds)')
  assert(parseAt >= 0 && v1At > parseAt && licencesAt > v1At, 'the v2 handler reads before it parses, or not through v1')
  assert.equal(count(v2, 'licence:'), 1, 'the v2 handler sets the licence more than once')
  assert(v2.includes('licence: maskDriverLicenceV1(stored.get(profile.driverId) ?? null, parsed.licenceView),'), 'the v2 licence is not masked with the parsed view')
  assert(v2.includes('licenceView: parsed.licenceView,'), 'the v2 answer does not state the view it applied')
  assert(!/licenseNumber|prisma|\$queryRaw/u.test(v2), 'the v2 handler reads the stored licence itself')

  const exact = withoutComments(read(EXACT_HANDLER))
  const exactParseAt = exact.indexOf('const parsed = parseDriverProfilesByExactLicenceQueryV1(query)')
  const guardAt = exact.indexOf('if (key === null || key.length < DRIVER_LICENCE_MIN_SEARCH_LENGTH_V1) {')
  const readAt = exact.indexOf('await port.findProfilesByLicenceKey(key, DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_PROFILES_V1 + 1)')
  assert(exactParseAt >= 0 && guardAt > exactParseAt && readAt > guardAt, 'the exact-licence handler reads before it parses or checks the key')
  assert(exact.includes('DRIVER_LICENCE_MIN_SEARCH_LENGTH_V1 = 6'), 'the shortest searched licence changed')
  assert.equal(count(exact, 'licence:'), 1, 'the exact-licence handler sets the licence more than once')
  assert(exact.includes('licence: maskDriverLicenceV1(row.licenseNumber, parsed.licenceView),'), 'the exact-licence answer is not masked with the parsed view')
  assert.equal(count(exact, 'licenseNumber'), 1, 'the exact-licence handler uses the stored licence beyond the mask')
  assert(!/parsed\.licence\b(?!View)/u.test(exact.replace('driverLicenceKeyV1(parsed.licence)', '')), 'the typed licence reaches more than the key')
  assert(!/prisma|\$queryRaw/u.test(exact), 'the exact-licence handler reads the database itself')
  for (const source of [v2, exact]) {
    assert(!LIVE_VOCABULARY.test(source), 'a licence handler reaches a park, a scraper or the reconciler')
    assert(!WRITE_VOCABULARY.test(source), 'a licence handler writes')
  }
}

/** 4. The one reader of the stored licence. */
function assertReader(read) {
  const adapter = withoutComments(read(ADAPTER))
  assert.equal(count(adapter, 'prisma.'), 2, 'the licence reader makes more than its two reads')
  assert(adapter.includes("where: { id: { in: [...driverIds] } },\n      select: { id: true, licenseNumber: true },\n      take: 500,"), 'the licences-of-drivers read changed')
  assert(adapter.includes('prisma.$queryRaw<DriverLicenceProfileRowV1[]>`'), 'the exact-licence read is not a parameterized tagged query')
  assert(adapter.includes("= ${licenceKey}::text"), 'the licence key is not a bind value')
  assert(adapter.includes('LIMIT ${limit}`'), 'the exact-licence read is unbounded')
  assert(adapter.includes('LEFT JOIN "Park" p ON p."id" = d."parkId"'), 'the park name is not read from the Fleet-owned Park')
  assert.equal(count(adapter, '${'), 2, 'the exact-licence read interpolates more than the key and the bound')
  assert(!FOREIGN_TABLES.test(adapter), 'the licence reader touches a table Fleet does not own')
  assert(!WRITE_VOCABULARY.test(adapter), 'the licence reader writes or runs unsafe SQL')
  assert(!/externalPersonKey|"phone"|phone:/u.test(adapter), 'the licence reader selects a person key or a phone')
}

/** 5. Bindings, surface, declarations. */
function assertDeclarations(read) {
  const application = read(APPLICATION)
  assert(application.includes('createDriverProfilesForContactsHandlerV2(readDriverProfilesForContacts, legacyPrismaDriverLicencePortV1)'), 'v2 is not bound to the v1 read and the licence reader')
  assert(application.includes('createDriverProfilesByExactLicenceHandlerV1(legacyPrismaDriverLicencePortV1)'), 'the exact-licence search is not bound to the licence reader')
  const publicIndex = read(PUBLIC_INDEX)
  for (const name of ['readDriverProfilesForContactsV2,', 'findDriverProfilesByExactLicenceV1,', 'maskDriverLicenceV1 }']) {
    assert(publicIndex.includes(name), `${name} is not on the Fleet public surface`)
  }
  assert(!/legacy-prisma-driver-licence-adapter|driverLicenceKeyV1/u.test(publicIndex), 'the stored-licence reader or the key leaks onto the public surface')
  const manifest = JSON.parse(read(MANIFEST))
  const registry = JSON.parse(read(REGISTRY))
  const surface = registry.context_surfaces.find((candidate) => candidate.id === 'fleet_operations.public.v1')
  for (const capability of [...CAPABILITIES, 'DriverProfilesForContactsQuery.v1']) {
    assert(manifest.public_surface.includes(capability), `the manifest does not list ${capability}`)
    assert(surface?.capabilities.includes(capability), `the registry does not list ${capability}`)
  }
  assert(manifest.verification.module_tests.includes(CONTROL), 'the control is not a declared module test')
}

function assertAll(read) {
  assertContracts(read)
  assertMask(read)
  assertHandlers(read)
  assertReader(read)
  assertDeclarations(read)
}

/** Known escapes; each must be caught. */
const MUTANTS = [
  [VIEW, "['full', 'last4']", "['full', 'last4', 'admin']"],
  [EXACT_CONTRACT, "if (!isDriverLicenceViewV1(input.licenceView)) invalid('licenceView must be full or last4')", ''],
  [EXACT_CONTRACT, "invalid('licence is too long')", 'invalid(`licence is too long: ${input.licence}`)'],
  [EXACT_CONTRACT, "'unsupported contract version')", '`unsupported contract version: ${input.contract}`)'],
  [EXACT_CONTRACT, '  licence: string | null\n  dismissedAt', '  licence: string | null\n  typedLicence: string\n  dismissedAt'],
  [EXACT_CONTRACT, '  truncated: boolean\n}', '  truncated: boolean\n  licence: string\n}'],
  [V2_CONTRACT, "if (!isDriverLicenceViewV1(input.licenceView)) invalid('licenceView must be full or last4')", ''],
  [V2_CONTRACT, '  licence: string | null\n}', '  licence: string | null\n  licenseNumber: string | null\n}'],
  [MASK, "if (licenceView === 'full') return text", "if (licenceView !== 'last4') return text"],
  [MASK, "if (licenceView === 'full') return text", "if (String(licenceView).toLowerCase() === 'full') return text"],
  [MASK, 'key.slice(-4)', 'key.slice(-6)'],
  [MASK, 'DRIVER_LICENCE_MIN_MASKABLE_LENGTH_V1 = 8', 'DRIVER_LICENCE_MIN_MASKABLE_LENGTH_V1 = 4'],
  [V2_HANDLER, 'maskDriverLicenceV1(stored.get(profile.driverId) ?? null, parsed.licenceView)', "maskDriverLicenceV1(stored.get(profile.driverId) ?? null, 'full')"],
  [V2_HANDLER, 'maskDriverLicenceV1(stored.get(profile.driverId) ?? null, parsed.licenceView)', 'stored.get(profile.driverId) ?? null'],
  [V2_HANDLER, '          ...profile,\n', '          ...profile,\n          licence: stored.get(profile.driverId) ?? null,\n'],
  [EXACT_HANDLER, 'maskDriverLicenceV1(row.licenseNumber, parsed.licenceView)', 'row.licenseNumber'],
  [EXACT_HANDLER, 'maskDriverLicenceV1(row.licenseNumber, parsed.licenceView)', 'maskDriverLicenceV1(row.licenseNumber, query.licenceView)'],
  [EXACT_HANDLER, '      truncated,\n', '      truncated,\n      typed: parsed.licence,\n'],
  [EXACT_HANDLER, 'if (key === null || key.length < DRIVER_LICENCE_MIN_SEARCH_LENGTH_V1) {', 'if (key === null) {'],
  [ADAPTER, '= ${licenceKey}::text', "= '${licenceKey}'::text"],
  [ADAPTER, 'prisma.$queryRaw<DriverLicenceProfileRowV1[]>`', 'prisma.$queryRawUnsafe<DriverLicenceProfileRowV1[]>(`'],
  [ADAPTER, 'LIMIT ${limit}`', '`'],
  [ADAPTER, 'd."licenseNumber", d."dismissedAt"', 'd."licenseNumber", d."dismissedAt", d."phone"'],
  [APPLICATION, 'createDriverProfilesByExactLicenceHandlerV1(legacyPrismaDriverLicencePortV1)', 'createDriverProfilesByExactLicenceHandlerV1({ findProfilesByLicenceKey: async () => [] })'],
  [PUBLIC_INDEX, "export { DRIVER_LICENCE_MASK_V1, maskDriverLicenceV1 } from './driver-licence-mask'", "export { DRIVER_LICENCE_MASK_V1, driverLicenceKeyV1, maskDriverLicenceV1 } from './driver-licence-mask'"],
]

function checkMutants(read) {
  let caught = 0
  for (const [file, from, to] of MUTANTS) {
    const original = read(file)
    assert(original.includes(from), `mutant anchor missing in ${file}: ${from}`)
    const mutated = (relative) => (relative === file ? original.replace(from, to) : read(relative))
    let escaped = false
    try {
      assertAll(mutated)
      escaped = true
    } catch {
      caught += 1
    }
    assert(!escaped, `mutant escaped in ${path.basename(file)}: ${from} -> ${to}`)
  }
  return caught
}

function runProofs() {
  const vitest = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'src/contracts/fleet-operations/v1/driver-profiles-by-exact-licence-query.test.ts',
    'src/contracts/fleet-operations/v2/driver-profiles-for-contacts-query.test.ts',
    'src/modules/fleet-operations/public/v1/driver-licence-mask.test.ts',
    'src/modules/fleet-operations/public/v1/driver-profiles-for-contacts-v2-handler.test.ts',
    'src/modules/fleet-operations/public/v1/driver-profiles-by-exact-licence-handler.test.ts',
  ], { cwd: path.join(root, 'gravity-mvp'), encoding: 'utf8', env: { ...process.env, CI: '1' } })
  assert.equal(vitest.status, 0, `the Fleet licence view proofs failed:\n${vitest.stdout}\n${vitest.stderr}`)
  const passed = passingProofCount(vitest.stdout)
  assert(passed !== null && passed > 0, `the proofs reported no passing tests:\n${vitest.stdout}`)
  return passed
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
  for (const file of LICENCE_FILES) read(file)
  assertAll(read)
  const mutants = checkMutants(read)
  const proofs = process.argv.includes('--static') ? 0 : runProofs()
  process.stdout.write(`${JSON.stringify({ control: 'fleet-driver-licence-view-boundary', status: 'PASS', mutants, proofs })}\n`)
}
