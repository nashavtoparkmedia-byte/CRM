#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const queryImplementationPath = 'gravity-mvp/src/app/dashboard/actions.ts'
const cardImplementationPath = 'gravity-mvp/src/app/dashboard/components/DashboardCard.tsx'
const kpiImplementationPath = 'gravity-mvp/src/app/dashboard/components/DashboardKPI.tsx'
const queryPublicPath = 'gravity-mvp/src/modules/analytics-reporting/public/v1/dashboard-query.ts'
const cardPublicPath = 'gravity-mvp/src/modules/analytics-reporting/public/v1/dashboard-card-view.ts'
const kpiPublicPath = 'gravity-mvp/src/modules/analytics-reporting/public/v1/dashboard-kpi-view.ts'
const consumerPath = 'gravity-mvp/src/app/page.tsx'

assert.equal(sha256(read(queryImplementationPath)), '6818e943313b3b5a30daf656a8c7e0c9227f283f757a409086b7aeb60c41baa9')
assert.equal(sha256(read(cardImplementationPath)), '4c6c14dfc039a1cfb0614ae8f8ca989eba6ef22adf228fba47523437ea81cf47')
assert.equal(sha256(read(kpiImplementationPath)), '2569d87b2792551ba637313a3d743b7896a062872c8216bdf2b7a8a7cb1d43c3')

function exportedPublicNames(source) {
    const aliases = [...source.matchAll(/export\s+(?:type\s+)?\{([\s\S]*?)\}\s+from/g)]
        .flatMap((match) => match[1].split(','))
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.match(/\bas\s+(\w+)$/)?.[1] ?? entry)
    const functions = [...source.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((match) => match[1])
    const types = [...source.matchAll(/export\s+type\s+(\w+)\s*=/g)].map((match) => match[1])
    return [...aliases, ...functions, ...types].sort()
}

const queryPublic = read(queryPublicPath)
const cardPublic = read(cardPublicPath)
const kpiPublic = read(kpiPublicPath)
assert.deepEqual(exportedPublicNames(queryPublic), ['DashboardStatsV1', 'getDashboardStatsV1'])
assert.deepEqual(exportedPublicNames(cardPublic), ['DashboardCardV1'])
assert.deepEqual(exportedPublicNames(kpiPublic), ['DashboardKpiV1'])
assert.match(queryPublic, /export\s+async\s+function\s+getDashboardStatsV1\s*\(/)
assert.doesNotMatch(queryPublic, /getDashboardCharts|getRiskDrivers|getPromotionPerformance|export \*/)
assert.doesNotMatch(`${cardPublic}\n${kpiPublic}`, /RiskDriversTable|TripsChart|SegmentChart|export \*/)
const unrelatedQueryProbe = `${queryPublic}\nexport { getDashboardCharts as getDashboardChartsV1 } from '@/app/dashboard/actions'\n`
assert.notDeepEqual(exportedPublicNames(unrelatedQueryProbe), ['DashboardStatsV1', 'getDashboardStatsV1'])
const unrelatedViewProbe = `${cardPublic}\nexport { RiskDriversTable as RiskDriversTableV1 } from '@/app/dashboard/components/RiskDriversTable'\n`
assert.notDeepEqual(exportedPublicNames(unrelatedViewProbe), ['DashboardCardV1'])

const consumer = read(consumerPath)
assert.match(consumer, /@\/modules\/analytics-reporting\/public\/v1\/dashboard-query/)
assert.match(consumer, /@\/modules\/analytics-reporting\/public\/v1\/dashboard-card-view/)
assert.match(consumer, /@\/modules\/analytics-reporting\/public\/v1\/dashboard-kpi-view/)
assert.doesNotMatch(consumer, /\.\/dashboard\/(?:actions|components\/Dashboard)/)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/analytics_reporting.json'))
assert(manifest.public_surface.includes('AnalyticsQuery.v1'))
assert(manifest.public_surface.includes('DashboardProjection.v1'))

const scan = await scanArchitecture(root)
const privateTargets = new Set([queryImplementationPath, cardImplementationPath, kpiImplementationPath])
assert.deepEqual(scan.findings.filter((finding) => (
    finding.file === consumerPath && privateTargets.has(finding.details?.target)
)), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    runtime_consumers: 1,
    query_capabilities: 2,
    projection_capabilities: 2,
    negative_unrelated_capability_probes: 'REJECTED',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
