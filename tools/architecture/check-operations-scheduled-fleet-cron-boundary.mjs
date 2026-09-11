#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

// Classify the CRON_SECRET bearer gate a cron route carries, so the contract can
// distinguish the three cases instead of only proving the variable is mentioned:
//   'fail-closed' - an unset CRON_SECRET denies every caller
//   'fail-open'   - an unset CRON_SECRET disables the check entirely
//   'absent'      - the route has no bearer gate at all
const classifyCronSecretGate = (source) => {
    const guard = source.match(
        /if \(([\s\S]*?)\) \{\s*return NextResponse\.json\(\{ error: 'Unauthorized' \}, \{ status: 401 \}\)\s*\}/,
    )
    if (!guard || !/process\.env\.CRON_SECRET/.test(source)) return 'absent'
    const condition = guard[1]
    const alias = source.match(/const (\w+) = process\.env\.CRON_SECRET\b/)
    const secret = alias ? `(?:${alias[1]}|process\\.env\\.CRON_SECRET)` : 'process\\.env\\.CRON_SECRET'
    if (!new RegExp(`authHeader !== \`Bearer \\$\\{${secret}\\}\``).test(condition)) return 'unknown'
    if (new RegExp(`^\\s*!\\s*${secret}\\s*\\|\\|`).test(condition)) return 'fail-closed'
    if (new RegExp(`^\\s*${secret}\\s*&&`).test(condition)) return 'fail-open'
    return 'unknown'
}

// The classifier is itself probed, so a future regression cannot pass by making
// every branch return the same verdict.
const gateProbe = (condition) => [
    "import { NextResponse } from 'next/server'",
    'export async function GET(request: Request) {',
    '    const cronSecret = process.env.CRON_SECRET',
    "    const authHeader = request.headers.get('authorization')",
    `    if (${condition}) {`,
    "        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })",
    '    }',
    '    return runScheduledYandexSyncCronV1()',
    '}',
].join('\n')
assert.equal(classifyCronSecretGate(gateProbe('!cronSecret || authHeader !== `Bearer ${cronSecret}`')), 'fail-closed')
assert.equal(
    classifyCronSecretGate(gateProbe('process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`')),
    'fail-open',
)
assert.equal(classifyCronSecretGate('export async function GET() { return runScheduledYandexSyncCronV1() }'), 'absent')
// A 401 that never compares the bearer token is not a CRON_SECRET gate.
assert.equal(classifyCronSecretGate(gateProbe('authHeader === null')), 'unknown')

const scraperGate = classifyCronSecretGate(scraperRoute)
const syncGate = classifyCronSecretGate(syncRoute)

assert.match(scraperRoute, /process\.env\.CRON_SECRET/)
assert.match(scraperRoute, /authHeader !== `Bearer \$\{process\.env\.CRON_SECRET\}`/)
assert.match(scraperRoute, /runScheduledScraperDispatchCronV1\(\)/)
assert.doesNotMatch(scraperRoute, /@\/lib\/(?:cron-health|prisma)|\bfetch\s*\(/)
// The scraper gate is deliberately left in its historical fail-open shape; pinning
// the classification here means hardening or removing it becomes a visible decision.
assert.equal(scraperGate, 'fail-open')

// Owner decision 2026-09-11: /api/cron/sync-trips must require the shared secret and
// must fail closed, because an unauthenticated call loads every ApiConnection clid and
// apiKey and transmits them to fleet-api.taxi.yandex.net.
assert.match(syncRoute, /export async function GET\(request: Request\)/)
assert.match(syncRoute, /request\.headers\.get\('authorization'\)/)
assert.equal(syncGate, 'fail-closed')
assert.match(syncRoute, /runScheduledYandexSyncCronV1\(\)/)
assert.doesNotMatch(syncRoute, /@\/lib\/(?:cron-health|yandexSync)|\bprisma\.|\bfetch\s*\(/)

// The gate is worthless if it runs after the capability, so pin the order on both routes.
for (const [source, capability] of [
    [scraperRoute, 'runScheduledScraperDispatchCronV1()'],
    [syncRoute, 'runScheduledYandexSyncCronV1()'],
]) {
    assert(source.indexOf('status: 401') < source.indexOf(capability))
}

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
    negative_gate_classification_probe: 'REJECTED',
    operations_capabilities: 2,
    fleet_capabilities: 2,
    negative_unrelated_cron_capability_probe: 'REJECTED',
    dependency_cycle: 'ABSENT',
    provider_accesses: 0,
    current_findings: scan.findings.length,
}, null, 2)}\n`)
