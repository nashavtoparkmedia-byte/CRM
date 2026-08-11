#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const uiRoot = 'gravity-mvp/src/modules/fleet-operations/public/v1/monitoring-ui'
const exactViews = [
    'ActionButtons.tsx',
    'DriverHoverCard.tsx',
    'FleetCheckModal.tsx',
    'HistoryIcons.tsx',
]
const exactExports = new Map([
    ['ActionButtons.tsx', ['ActionButtons']],
    ['DriverHoverCard.tsx', ['DriverHoverCard']],
    ['FleetCheckModal.tsx', ['FleetCheckModal']],
    ['HistoryIcons.tsx', ['HistoryIcons']],
])
const consumers = [
    'gravity-mvp/src/app/drivers/archive/ArchiveClient.tsx',
    'gravity-mvp/src/app/monitoring/MonitoringClient.tsx',
    'gravity-mvp/src/app/monitoring/components/AllDriversSection.tsx',
    'gravity-mvp/src/app/monitoring/components/AttentionSection.tsx',
]

assert.deepEqual(readdirSync(path.join(root, uiRoot)).sort(), exactViews)

function exportedFunctions(source) {
    return [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((match) => match[1]).sort()
}

for (const [file, expected] of exactExports) {
    const source = read(`${uiRoot}/${file}`)
    assert.deepEqual(exportedFunctions(source), expected)
    assert.doesNotMatch(source, /@\/app\/monitoring/)
    const unrelatedViewProbe = `${source}\nexport function UnrelatedMonitoringView() { return null }\n`
    assert.notDeepEqual(exportedFunctions(unrelatedViewProbe), expected)
}

assert.equal(sha256(read(`${uiRoot}/ActionButtons.tsx`)), '0969b8a6f46ea73e58fa78f721da9f915a4f45779b344a825497a094d2afadab')
assert.equal(sha256(read(`${uiRoot}/FleetCheckModal.tsx`)), '3bad2cb9ed07ec24d069e6b7a90e61f57ef95c90475e7f3002d6bb6cee4f15b2')
assert.equal(sha256(read(`${uiRoot}/HistoryIcons.tsx`)), 'd09dcc5fb624f685125c308f2d1d9da9c353aa3b213e65da9c0d981644b01b30')
assert.equal(sha256(read('gravity-mvp/src/infrastructure/ui/Toast.tsx')), 'e7187e1da9865af9814b190028630b3b2f88045eda37bc04fc215791f5de0c8b')

const hover = read(`${uiRoot}/DriverHoverCard.tsx`)
assert.match(hover, /fetch\(`\/api\/monitoring\/drivers\/\$\{driverId\}\/events\?limit=5`\)/)
assert.match(hover, /EVENT_ICONS\[e\.eventType\]/)
assert.doesNotMatch(hover, /@\/app\/monitoring\/lib\/types/)

for (const legacyName of [...exactViews, 'Toast.tsx']) {
    assert.equal(existsSync(path.join(root, 'gravity-mvp/src/app/monitoring/components', legacyName)), false)
}

const archive = read(consumers[0])
for (const file of exactViews) assert.match(archive, new RegExp(`@/modules/fleet-operations/public/v1/monitoring-ui/${file.replace('.tsx', '')}`))
assert.match(archive, /@\/infrastructure\/ui\/Toast/)
assert.doesNotMatch(archive, /@\/app\/monitoring\/components/)

const monitoringClient = read(consumers[1])
assert.match(monitoringClient, /@\/modules\/fleet-operations\/public\/v1\/monitoring-ui\/FleetCheckModal/)
assert.match(monitoringClient, /@\/infrastructure\/ui\/Toast/)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/fleet_operations.json'))
assert(manifest.public_surface.includes('FleetMonitoringViews.v1'))
assert(!manifest.allowed_dependencies.some((dependency) => dependency.context === 'operations_observability'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => finding.file === consumers[0]), [])
assert.deepEqual(scan.findings.filter((finding) => (
    finding.file === consumers[0]
    && finding.source_context === 'fleet_operations'
    && finding.target_context === 'operations_observability'
)), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    fleet_views: exactViews.length,
    shared_ui_primitives: 1,
    runtime_consumers: consumers.length,
    negative_unrelated_view_probes: 'REJECTED',
    fleet_to_operations_dependency: 'ABSENT',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
