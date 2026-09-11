#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const scraperRoutePath = 'gravity-mvp/src/app/api/cron/sync-scraper/route.ts'
const syncRoutePath = 'gravity-mvp/src/app/api/cron/sync-trips/route.ts'
const operationsPath =
    'gravity-mvp/src/modules/operations-observability/public/v1/scheduled-fleet-cron-routes.ts'
const scraperCapabilityPath =
    'gravity-mvp/src/modules/fleet-operations/public/v1/scheduled-scraper-check-dispatch.ts'
const syncCapabilityPath =
    'gravity-mvp/src/modules/fleet-operations/public/v1/yandex-sync-runtime.ts'

const scraperRoute = read(scraperRoutePath)
const syncRoute = read(syncRoutePath)
const operations = read(operationsPath)
const scraperCapability = read(scraperCapabilityPath)
const syncCapability = read(syncCapabilityPath)

// Classify the CRON_SECRET bearer gate a cron route carries. The contract needs
// four outcomes, not a boolean, because each is a distinct way for the gate to be
// worthless:
//   'fail-closed' - an unset CRON_SECRET denies every caller (the required state)
//   'fail-open'   - an unset CRON_SECRET disables the check entirely
//   'after-call'  - the gate exists but the protected capability already ran
//   'absent'      - the route carries no bearer gate at all
// 'unknown' is reserved for a 401 that never compares the bearer token, so an
// unrecognised shape can never be mistaken for a passing one.
const classifyCronRouteGate = (source, capability) => {
    const guard = source.match(
        /if \(([\s\S]*?)\) \{\s*return NextResponse\.json\(\{ error: 'Unauthorized' \}, \{ status: 401 \}\)\s*\}/,
    )
    if (!guard || !/process\.env\.CRON_SECRET/.test(source)) return 'absent'
    const condition = guard[1]
    const alias = source.match(/const (\w+) = process\.env\.CRON_SECRET\b/)
    const secret = alias ? `(?:${alias[1]}|process\\.env\\.CRON_SECRET)` : 'process\\.env\\.CRON_SECRET'
    if (!new RegExp(`authHeader !== \`Bearer \\$\\{${secret}\\}\``).test(condition)) return 'unknown'
    const callIndex = source.indexOf(capability)
    if (callIndex !== -1 && callIndex < source.indexOf('status: 401')) return 'after-call'
    if (new RegExp(`^\\s*!\\s*${secret}\\s*\\|\\|`).test(condition)) return 'fail-closed'
    if (new RegExp(`^\\s*${secret}\\s*&&`).test(condition)) return 'fail-open'
    return 'unknown'
}

// Synthetic probes. The classifier is exercised against one source per outcome so a
// future regression cannot pass by collapsing every branch to a single verdict.
const PROBE_CAPABILITY = 'runProbeCapabilityV1()'
const gateProbe = (condition, { afterCall = false } = {}) => [
    "import { NextResponse } from 'next/server'",
    'export const dynamic = \'force-dynamic\'',
    'export async function GET(request: Request) {',
    ...(afterCall ? [`    const result = await ${PROBE_CAPABILITY}`] : []),
    '    const cronSecret = process.env.CRON_SECRET',
    "    const authHeader = request.headers.get('authorization')",
    `    if (${condition}) {`,
    "        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })",
    '    }',
    `    return ${afterCall ? 'result' : PROBE_CAPABILITY}`,
    '}',
].join('\n')

const FAIL_CLOSED_CONDITION = '!cronSecret || authHeader !== `Bearer ${cronSecret}`'
const FAIL_OPEN_CONDITION = 'process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`'
const probes = {
    'fail-closed': gateProbe(FAIL_CLOSED_CONDITION),
    'fail-open': gateProbe(FAIL_OPEN_CONDITION),
    'after-call': gateProbe(FAIL_CLOSED_CONDITION, { afterCall: true }),
    absent: `export async function GET() { return ${PROBE_CAPABILITY} }`,
    unknown: gateProbe('authHeader === null'),
}
const probeVerdicts = Object.fromEntries(
    Object.keys(probes).map((expected) => [expected, classifyCronRouteGate(probes[expected], PROBE_CAPABILITY)]),
)
// Each probe must land on its own outcome...
for (const [expected, actual] of Object.entries(probeVerdicts)) assert.equal(actual, expected)
// ...and the five verdicts must be five distinct values, which is what makes the
// negative probes non-vacuous: a classifier that answered the same thing for every
// input would satisfy neither this nor the per-probe equality above.
assert.equal(new Set(Object.values(probeVerdicts)).size, Object.keys(probes).length)
assert.deepEqual(
    Object.values(probeVerdicts).slice().sort(),
    ['absent', 'after-call', 'fail-closed', 'fail-open', 'unknown'],
)
// The two shipped shapes are also proved separable from each other, so 'fail-closed'
// cannot be reached by a route that merely mentions the variable.
assert.notEqual(probeVerdicts['fail-closed'], probeVerdicts['fail-open'])

const SCRAPER_CAPABILITY = 'runScheduledScraperDispatchCronV1()'
const SYNC_CAPABILITY = 'runScheduledYandexSyncCronV1()'
const scraperGate = classifyCronRouteGate(scraperRoute, SCRAPER_CAPABILITY)
const syncGate = classifyCronRouteGate(syncRoute, SYNC_CAPABILITY)

// Owner decision, 2026-09-11: every cron route that carries a CRON_SECRET gate must
// fail closed. An unauthenticated /api/cron/sync-trips call loads the clid and apiKey
// of all six ApiConnection rows and transmits them to fleet-api.taxi.yandex.net; the
// scraper route reaches the same credential table. An unset CRON_SECRET must therefore
// deny every caller rather than disable the check.
for (const [route, source, capability, gate] of [
    ['sync-scraper', scraperRoute, SCRAPER_CAPABILITY, scraperGate],
    ['sync-trips', syncRoute, SYNC_CAPABILITY, syncGate],
]) {
    assert.match(source, /export async function GET\(request: Request\)/, route)
    assert.match(source, /request\.headers\.get\('authorization'\)/, route)
    assert.match(source, /const cronSecret = process\.env\.CRON_SECRET/, route)
    assert.match(source, /!cronSecret \|\| authHeader !== `Bearer \$\{cronSecret\}`/, route)
    assert.match(source, /return NextResponse\.json\(\{ error: 'Unauthorized' \}, \{ status: 401 \}\)/, route)
    // Authorization must precede the protected capability; a gate that runs after it
    // has already leaked the work it was meant to guard.
    assert(source.indexOf('status: 401') < source.indexOf(capability), route)
    assert.equal(gate, 'fail-closed', route)
}

assert.match(scraperRoute, /runScheduledScraperDispatchCronV1\(\)/)
assert.doesNotMatch(scraperRoute, /@\/lib\/(?:cron-health|prisma)|\bfetch\s*\(/)
assert.match(syncRoute, /runScheduledYandexSyncCronV1\(\)/)
assert.doesNotMatch(syncRoute, /@\/lib\/(?:cron-health|yandexSync)|\bprisma\.|\bfetch\s*\(/)

// The seven remaining /api/cron routes are knowingly ungated and are tracked as a
// separate security finding, outside this slice. Pinning the count keeps that scope
// honest: a new cron route cannot be added here without revisiting the decision.
const cronRouteDirectory = 'gravity-mvp/src/app/api/cron'
const cronRoutes = readdirSync(path.join(root, cronRouteDirectory), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${cronRouteDirectory}/${entry.name}/route.ts`)
    .sort()
const gatedCronRoutes = cronRoutes.filter((route) => /process\.env\.CRON_SECRET/.test(read(route)))
assert.deepEqual(gatedCronRoutes, [scraperRoutePath, syncRoutePath].sort())
assert.equal(cronRoutes.length - gatedCronRoutes.length, 7)

assert.match(operations, /@\/modules\/fleet-operations\/public\/v1/)
assert.match(operations, /@\/lib\/cron-health/)
assert.equal((operations.match(/cronName: 'sync-scraper'/g) || []).length, 2)
assert.equal((operations.match(/cronName: 'sync-trips'/g) || []).length, 3)
assert.doesNotMatch(operations, /@\/lib\/(?:prisma|yandexSync)|\bprisma\.|\bfetch\s*\(/)

assert.match(scraperCapability, /prisma\.apiConnection\.findFirst/)
assert.match(scraperCapability, /fleet-api\.taxi\.yandex\.net/)
assert.match(scraperCapability, /SCRAPER_API_URL/)
const resultType = scraperCapability.slice(
    scraperCapability.indexOf('export type ScheduledScraperCheckDispatchResultV1'),
    scraperCapability.indexOf('type YandexDriverProfilePageV1'),
)
assert.doesNotMatch(resultType, /\b(?:apiKey|clid|parkId|headers|licenses)\b/)
assert.match(scraperCapability, /return \{\s*status: 'success',\s*dispatched: licenses\.length,\s*successCount,\s*errorCount,/s)
assert.match(syncCapability, /runYandexSync\(\{ bypassCooldown: true \}\)/)

const exactOperations = (source) => [...source.matchAll(/export async function (\w+)\(/g)]
    .map((match) => match[1]).sort()
assert.deepEqual(exactOperations(operations), [
    'runScheduledScraperDispatchCronV1',
    'runScheduledYandexSyncCronV1',
])
const unrelatedProbe = `${operations}\nexport async function runArbitraryCronV1() { return true }\n`
assert.notDeepEqual(exactOperations(unrelatedProbe), exactOperations(operations))

const rules = JSON.parse(read('architecture/evidence/v1/module-rules.json'))
const yandexRule = rules.modules.find((rule) => rule.id === 'yandex_fleet')
const operationsRule = rules.modules.find((rule) => rule.id === 'monitoring')
assert(yandexRule && !/cron\/sync-(?:scraper|trips)/.test(yandexRule.match))
assert(operationsRule && operationsRule.match.includes('api/cron'))

const fleet = JSON.parse(read('architecture/contexts/v1/manifests/fleet_operations.json'))
const observability = JSON.parse(read('architecture/contexts/v1/manifests/operations_observability.json'))
assert(fleet.public_surface.includes('ScheduledScraperCheckDispatch.v1'))
assert(observability.public_surface.includes('ScheduledFleetCronRoutes.v1'))
assert(observability.allowed_dependencies.some((dependency) => (
    dependency.context === 'fleet_operations' && dependency.surface === 'fleet_operations.public'
)))
assert(observability.credential_relationships.environment_names.includes('CRON_SECRET'))
assert(fleet.credential_relationships.environment_names.includes('CRON_SECRET'))

const scan = await scanArchitecture(root)
const relevant = new Set([scraperRoutePath, syncRoutePath, operationsPath, scraperCapabilityPath])
assert.deepEqual(scan.findings.filter((finding) => relevant.has(finding.file)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'direct_provider_transport_access'), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    routes: 2,
    scraper_cron_secret_gate: scraperGate,
    sync_cron_secret_gate: syncGate,
    gate_classification_probes: probeVerdicts,
    ungated_cron_routes_tracked_separately: cronRoutes.length - gatedCronRoutes.length,
    negative_gate_classification_probe: 'REJECTED',
    operations_capabilities: 2,
    fleet_capabilities: 2,
    negative_unrelated_cron_capability_probe: 'REJECTED',
    dependency_cycle: 'ABSENT',
    provider_accesses: 0,
    current_findings: scan.findings.length,
}, null, 2)}\n`)
