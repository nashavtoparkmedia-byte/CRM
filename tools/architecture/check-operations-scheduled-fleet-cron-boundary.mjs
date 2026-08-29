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

assert.match(scraperRoute, /process\.env\.CRON_SECRET/)
assert.match(scraperRoute, /authHeader !== `Bearer \$\{process\.env\.CRON_SECRET\}`/)
assert.match(scraperRoute, /runScheduledScraperDispatchCronV1\(\)/)
assert.doesNotMatch(scraperRoute, /@\/lib\/(?:cron-health|prisma)|\bfetch\s*\(/)
assert.match(syncRoute, /runScheduledYandexSyncCronV1\(\)/)
assert.doesNotMatch(syncRoute, /@\/lib\/(?:cron-health|yandexSync)|\bprisma\.|\bfetch\s*\(/)

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
    operations_capabilities: 2,
    fleet_capabilities: 2,
    negative_unrelated_cron_capability_probe: 'REJECTED',
    dependency_cycle: 'ABSENT',
    provider_accesses: 0,
    current_findings: scan.findings.length,
}, null, 2)}\n`)
