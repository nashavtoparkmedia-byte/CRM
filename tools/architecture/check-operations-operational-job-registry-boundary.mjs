#!/usr/bin/env node

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const publicPath = 'gravity-mvp/src/modules/operations-observability/public/v1/operational-job-registry.ts'
const consumers = [
  'gravity-mvp/src/instrumentation.ts',
  'gravity-mvp/src/app/api/health/route.ts',
  'gravity-mvp/src/app/monitoring/system-health/actions.ts',
]
const operationalConsumers = [
  'gravity-mvp/scripts/verify-deployment.ts',
  'gravity-mvp/scripts/verify-e2e-production.ts',
  'gravity-mvp/scripts/verify-lifecycle.ts',
  'gravity-mvp/scripts/verify-ops-iter2.ts',
  'gravity-mvp/scripts/verify-ops.ts',
]
const exactFunctions = [
  'clearOperationalIntervalsV1',
  'getOperationalJobStateV1',
  'listOperationalJobStatesV1',
  'registerOperationalIntervalV1',
  'runOperationalJobV1',
].sort()

function exportedFunctions(source) {
  return [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)]
    .map((match) => match[1])
    .sort()
}

function hasExactCapabilitySurface(source) {
  return JSON.stringify(exportedFunctions(source)) === JSON.stringify(exactFunctions)
    && !/export\s+(?:class|const|let|var)\b/.test(source)
}

const publicSource = read(publicPath)
assert.equal(hasExactCapabilitySurface(publicSource), true)
assert.match(publicSource, /if \(state\.isRunning\)[\s\S]*?status: 'skipped'[\s\S]*?return null/)
assert.match(publicSource, /state\.lastResult = result[\s\S]*?status: 'ok'/)
assert.match(publicSource, /state\.lastError = err\.message \|\| String\(err\)[\s\S]*?status: 'error'/)
assert.match(publicSource, /finally \{[\s\S]*?state\.isRunning = false/)
assert.doesNotMatch(publicSource, /export \*|@\/lib\/OperationalJobs|\bprisma\.|\$queryRaw|\$executeRaw/)

const unrelatedCapabilityProbe = `${publicSource}\nexport function resetOperationalJobHistoryV1() {}\n`
assert.equal(hasExactCapabilitySurface(unrelatedCapabilityProbe), false)

for (const consumerPath of consumers) {
  const consumer = read(consumerPath)
  assert.match(consumer, /@\/modules\/operations-observability\/public\/v1\/operational-job-registry/)
  assert.doesNotMatch(consumer, /@\/lib\/OperationalJobs|\bOperationalJobs\./)
}
for (const consumerPath of operationalConsumers) {
  const consumer = read(consumerPath)
  assert.match(consumer, /modules\/operations-observability\/public\/v1\/operational-job-registry/)
  assert.doesNotMatch(consumer, /src\/lib\/OperationalJobs|\bOperationalJobs\./)
}
assert.equal(existsSync(path.join(root, 'gravity-mvp/src/lib/OperationalJobs.ts')), false)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/operations_observability.json'))
assert(manifest.public_surface.includes('OperationalJobRegistry.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
  consumers.includes(finding.file)
  && (finding.details?.target === publicPath || finding.details?.target?.endsWith('/lib/OperationalJobs.ts'))
)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.file === publicPath), [])

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  consumers: consumers.length,
  operational_consumers: operationalConsumers.length,
  capabilities: exactFunctions.length,
  negative_unrelated_capability_probe: 'REJECTED',
  current_findings: scan.findings.length,
}, null, 2)}\n`)
