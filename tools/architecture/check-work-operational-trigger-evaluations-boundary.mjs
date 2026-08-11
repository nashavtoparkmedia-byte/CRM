#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPath = 'gravity-mvp/src/lib/triggers.ts'
const publicPath = 'gravity-mvp/src/modules/work-management/public/v1/operational-trigger-evaluations.ts'
const consumers = [
    'gravity-mvp/src/app/api/cron/auto-close-tasks/route.ts',
    'gravity-mvp/src/app/api/cron/enforce-followup/route.ts',
    'gravity-mvp/src/app/api/cron/escalations/route.ts',
    'gravity-mvp/src/app/api/cron/pattern-alerts/route.ts',
    'gravity-mvp/src/app/api/cron/sla-escalation/route.ts',
]
const mappings = {
    calculateOperationalRootCauseTrendsV1: 'calculateRootCauseTrends',
    detectOperationalRootCausePatternsV1: 'detectRootCausePatterns',
    enforceOperationalMandatoryFollowupV1: 'enforceMandatoryFollowup',
    evaluateOperationalAutoCloseV1: 'evaluateAutoClose',
    evaluateOperationalFollowupEscalationsV1: 'evaluateEscalations',
    evaluateOperationalSlaEscalationV1: 'evaluateSLAEscalation',
}
const exactFunctions = Object.keys(mappings).sort()

assert.equal(sha256(read(implementationPath)), '9e6b8a8fe41415ea411343daeee2f0f7fd56cb8d62ddc75e2aa8760c3fb676f8')

function exportedFunctions(source) {
    return [...source.matchAll(/export\s+async\s+function\s+(\w+)\s*\(([^)]*)\)/g)]
        .map((match) => ({ name: match[1], parameters: match[2].trim() }))
        .sort((left, right) => left.name.localeCompare(right.name))
}

function hasExactCapabilitySurface(source) {
    const functions = exportedFunctions(source)
    return JSON.stringify(functions.map(({ name }) => name)) === JSON.stringify(exactFunctions)
        && functions.every(({ parameters }) => parameters === '')
        && !/export\s+(?:class|const|let|var)\b/.test(source)
}

const publicSource = read(publicPath)
assert.equal(hasExactCapabilitySurface(publicSource), true)
for (const [capability, implementation] of Object.entries(mappings)) {
    assert.match(publicSource, new RegExp(`function ${capability}\\(\\)[\\s\\S]*?return ${implementation}\\(\\)`))
}
assert.doesNotMatch(publicSource, /export \*|@\/lib\/prisma|\bprisma\.|\$queryRaw|\$executeRaw|tableName|rawSql/)

const unrelatedWriteProbe = `${publicSource}\nexport async function deleteUnrelatedDriverV1() { return true }\n`
assert.equal(hasExactCapabilitySurface(unrelatedWriteProbe), false)

for (const consumer of consumers) {
    const source = read(consumer)
    assert.match(source, /@\/modules\/work-management\/public\/v1\/operational-trigger-evaluations/)
    assert.doesNotMatch(source, /@\/lib\/triggers/)
}
const patternRoute = read(consumers[3])
assert(patternRoute.indexOf('detectOperationalRootCausePatternsV1()') < patternRoute.indexOf('calculateOperationalRootCauseTrendsV1()'))

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/work_management.json'))
assert(manifest.public_surface.includes('OperationalTriggerEvaluations.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    consumers.includes(finding.file)
    && [implementationPath, publicPath].includes(finding.details?.target)
)), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    consumers: consumers.length,
    capabilities: exactFunctions.length,
    negative_unrelated_write_probe: 'REJECTED',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
