#!/usr/bin/env node
// Fleet Operations DriverProfilesForContactsQuery.v1 boundary.
//
// The persisted park profiles Fleet holds for a person are read by exactly one
// Fleet-owned reader, through one bounded contract, for a composition that
// already knows which Contact ids and legacy Yandex link belong to the person.
// This control pins that the contract accepts only exact subjects and answers
// one entry per subject with a bounded profile shape that carries no driving
// licence, person key or phone; that the handler parses before it reads and
// never calls a park or reconciles; that the only database reader touches
// Fleet-owned Driver rows and their Park name by the stored links, never a
// Contact, Chat, Message or provider table, and never writes; and that the
// capability and this control are declared where the machinery reads them. It
// then runs the proofs that make these invariants behavioural.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const CONTRACT = 'gravity-mvp/src/contracts/fleet-operations/v1/driver-profiles-for-contacts-query.ts'
const CONTRACT_INDEX = 'gravity-mvp/src/contracts/fleet-operations/v1/index.ts'
const HANDLER = 'gravity-mvp/src/modules/fleet-operations/public/v1/driver-profiles-for-contacts-handler.ts'
const ADAPTER = 'gravity-mvp/src/modules/fleet-operations/public/v1/legacy-prisma-driver-profiles-for-contacts-adapter.ts'
const APPLICATION = 'gravity-mvp/src/modules/fleet-operations/application/fleet-operations.ts'
const PUBLIC_INDEX = 'gravity-mvp/src/modules/fleet-operations/public/v1/index.ts'
const MANIFEST = 'architecture/contexts/v1/manifests/fleet_operations.json'
const REGISTRY = 'architecture/contracts/v1/registry.json'
const CAPABILITY = 'DriverProfilesForContactsQuery.v1'
const CONTROL = 'node tools/architecture/check-fleet-driver-profiles-for-contacts-boundary.mjs'
const PROFILE_FIELDS = [
  'currentStatus', 'dismissedAt', 'driverId', 'externalDriverProfileId', 'externalParkId', 'fullName',
  'lastObservedAt', 'legalRole', 'linkBasis', 'parkName', 'personKeyType', 'personResolutionStatus',
  'segment', 'sourceFreshness', 'sourceState', 'workStatus',
]
const PERSONAL_VOCABULARY = /\b(licenseNumber|externalPersonKey|normalizedVu|rawVu|phone|phones|sourcePhones|yandexDriverId)\b/u
const WRITE_VOCABULARY = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\$executeRaw|\$queryRaw|\$executeRawUnsafe|\$queryRawUnsafe|\$transaction/u
const FOREIGN_TABLES = /\bprisma\.(contact|contactIdentity|contactPhone|contactMerge|chat|message|telegram\w*|whatsApp\w*|max\w*|user|crmUser)\b/u
const LIVE_VOCABULARY = /\b(fetch|reconcileYandexFleet|fetchParkProfiles|searchYandexParks|scraper|axios)\b/u

export function passingProofCount(stdout) {
  const plain = stripVTControlCharacters(String(stdout ?? ''))
  const matched = /Tests\s+(\d+)\s+passed/u.exec(plain)
  return matched === null ? null : Number(matched[1])
}

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

function interfaceBody(source, name) {
  const start = source.indexOf(`export interface ${name} {`)
  assert(start >= 0, `${name} is not declared as an interface`)
  const end = source.indexOf('\n}', start)
  return source.slice(start, end)
}

function fieldNames(body) {
  return [...body.matchAll(/^\s{2}(\w+)\??:/gmu)].map((match) => match[1]).sort()
}

/** 1. The contract: exact subjects in, one bounded entry per subject out, nothing personal beyond the park facts. */
function assertContractShape() {
  const contract = withoutComments(read(CONTRACT))
  assert(contract.includes("export const DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1 = 'fleet_operations.DriverProfilesForContactsQuery.v1' as const"), 'the query contract id changed')
  assert.deepEqual(fieldNames(interfaceBody(contract, 'DriverProfilesForContactsQueryV1')), ['contract', 'subjects'], 'the query accepts more than subjects')
  assert.deepEqual(fieldNames(interfaceBody(contract, 'DriverProfilesForContactsSubjectV1')), ['contactId', 'legacyYandexDriverId'], 'the subject shape changed')
  assert.deepEqual(fieldNames(interfaceBody(contract, 'DriverProfileForContactV1')), PROFILE_FIELDS, 'the profile field set changed')
  assert.deepEqual(fieldNames(interfaceBody(contract, 'DriverProfilesForContactEntryV1')), ['contactId', 'profiles'], 'the entry shape changed')
  const profileBody = interfaceBody(contract, 'DriverProfileForContactV1')
  assert(!PERSONAL_VOCABULARY.test(profileBody), 'a licence, person key or phone reached the profile shape')
  assert(contract.includes("key !== 'contract' && key !== 'subjects'"), 'the parser accepts fields beside the subjects')
  assert(contract.includes("key !== 'contactId' && key !== 'legacyYandexDriverId'"), 'the parser accepts fields beside the subject link keys')
  assert(contract.includes('subject contact ids must be distinct'), 'the parser no longer rejects duplicate subjects')
  assert(contract.includes('DRIVER_PROFILES_FOR_CONTACTS_MAX_CONTACTS_V1 = 25'), 'the subject bound changed')
  assert(read(CONTRACT_INDEX).includes("export * from './driver-profiles-for-contacts-query'"), 'the contract is not exported')
}

/** 2. The handler parses before it reads and only projects; it reaches no park or reconciliation. */
function assertHandlerProtocol() {
  const handler = withoutComments(read(HANDLER))
  const parseAt = handler.indexOf('parseDriverProfilesForContactsQueryV1(query)')
  const readAt = handler.indexOf('port.findDriverProfiles(')
  assert(parseAt >= 0 && readAt > parseAt, 'the handler reads before it parses the query')
  assert(!LIVE_VOCABULARY.test(handler), 'the handler reaches a park, a scraper or the reconciler')
  assert(!WRITE_VOCABULARY.test(handler), 'the handler writes')
  assert(!/\bprisma\b/u.test(handler), 'the handler imports the database client')
  assert(handler.includes("from './driver-fleet-evidence'"), 'profile evidence no longer comes from the Fleet evidence accessor')
}

/** 3. The only reader: Fleet-owned Driver rows and their Park name, by the stored links, read-only. */
function assertReader() {
  const adapter = withoutComments(read(ADAPTER))
  assert(adapter.includes('prisma.driver.findMany('), 'the reader no longer reads Driver rows')
  assert(adapter.includes('contactId: { in: [...contactIds] }'), 'the reader no longer matches by the stored Contact link')
  assert(adapter.includes('yandexDriverId: { in: [...yandexDriverIds] }'), 'the reader no longer matches by the legacy Yandex link')
  assert(adapter.includes('park: { select: { parkName: true } }'), 'the park name is not read from the Fleet-owned Park')
  assert(!FOREIGN_TABLES.test(adapter), 'the reader touches a table Fleet does not own')
  assert(!WRITE_VOCABULARY.test(adapter), 'the reader writes or runs raw SQL')
  assert(!/licenseNumber|externalPersonKey|phone:/u.test(adapter), 'the reader selects a licence, a person key or a phone')
  assert(adapter.includes('take: 500'), 'the read is unbounded')
  const application = read(APPLICATION)
  assert(application.includes('createDriverProfilesForContactsHandlerV1(legacyPrismaDriverProfilesForContactsPortV1)'), 'the handler is not bound to the Prisma reader')
  assert(read(PUBLIC_INDEX).includes('readDriverProfilesForContactsV1,'), 'the read is not published on the Fleet public surface')
}

/** 4. Declared where the machinery reads it. */
function assertDeclarations() {
  const manifest = JSON.parse(read(MANIFEST))
  assert(manifest.public_surface.includes(CAPABILITY), 'the manifest does not list the capability')
  assert(manifest.verification.module_tests.includes(CONTROL), 'the control is not a declared module test')
  const registry = JSON.parse(read(REGISTRY))
  const surface = registry.context_surfaces.find((candidate) => candidate.id === 'fleet_operations.public.v1')
  assert(surface?.capabilities.includes(CAPABILITY), 'the registry does not list the read capability')
}

/** 5. The proofs. */
function runProofs() {
  const vitest = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'src/contracts/fleet-operations/v1/driver-profiles-for-contacts-query.test.ts',
    'src/modules/fleet-operations/public/v1/driver-profiles-for-contacts-handler.test.ts',
  ], { cwd: path.join(root, 'gravity-mvp'), encoding: 'utf8', env: { ...process.env, CI: '1' } })
  assert.equal(vitest.status, 0, `the Fleet driver profiles read proofs failed:\n${vitest.stdout}\n${vitest.stderr}`)
  const passed = passingProofCount(vitest.stdout)
  assert(passed !== null && passed > 0, `the proofs reported no passing tests:\n${vitest.stdout}`)
  return passed
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertContractShape()
  assertHandlerProtocol()
  assertReader()
  assertDeclarations()
  const proofs = runProofs()
  process.stdout.write(`${JSON.stringify({ control: 'fleet-driver-profiles-for-contacts-boundary', status: 'PASS', proofs })}\n`)
}
