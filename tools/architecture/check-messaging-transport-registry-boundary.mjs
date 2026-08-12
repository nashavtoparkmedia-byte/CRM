#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPath = 'gravity-mvp/src/lib/TransportRegistry.ts'
const healthPath = 'gravity-mvp/src/modules/messaging/public/v1/transport-registry-health.ts'
const lifecyclePath = 'gravity-mvp/src/modules/messaging/public/v1/transport-registry-lifecycle.ts'
const projectionPath = 'gravity-mvp/src/modules/messaging/internal/transport-registry-projection.ts'
const healthConsumers = [
    'gravity-mvp/src/app/api/health/route.ts',
    'gravity-mvp/src/app/api/transport/health/route.ts',
]
const lifecycleConsumers = [
    'gravity-mvp/src/app/tg-actions.ts',
    'gravity-mvp/src/lib/whatsapp/WhatsAppService.ts',
]
const healthCapabilities = ['getAllEntries', 'getDegradedDuration']
const lifecycleCapabilities = [
    'beginNewInstance',
    'ensureEntry',
    'getAllEntries',
    'getDegradedDuration',
    'getEntry',
    'getInstanceId',
    'isCurrentInstance',
    'scheduleReconnect',
    'setFailed',
    'setReady',
    'setReconnecting',
    'setStopped',
    'touch',
    'touchLastSeen',
]

assert.equal(sha256(read(implementationPath)), '7b3333eea11b397ea577061d77a7f98569c692f4bf13ace6ceb6db1bcefe8937')

function capabilityKeys(source) {
    const body = source.match(/Object\.freeze\(\{([\s\S]*?)\n\}\)/)?.[1] ?? ''
    return [...body.matchAll(/^ {4}(\w+):/gm)].map((match) => match[1]).sort()
}

const healthSource = read(healthPath)
const lifecycleSource = read(lifecyclePath)
const projectionSource = read(projectionPath)
assert.deepEqual(capabilityKeys(healthSource), healthCapabilities)
assert.deepEqual(capabilityKeys(lifecycleSource), lifecycleCapabilities)
assert.doesNotMatch(healthSource, /setReady|setFailed|scheduleReconnect|beginNewInstance|export \*/)
assert.doesNotMatch(lifecycleSource, /cancelReconnect|guardInstance|reconnectTimers|entries|export \*/)
assert.match(projectionSource, /return Object\.freeze\(\{/)
assert.doesNotMatch(projectionSource, /\.\.\.entry/)
for (const field of [
    'connectionId', 'channel', 'instanceId', 'state', 'lastError', 'retryAttempt', 'reconnectInFlight',
]) assert.match(projectionSource, new RegExp(`${field}: entry\\.${field}`))
assert.match(projectionSource, /lastSeen: entry\.lastSeen \? new Date\(entry\.lastSeen\) : null/)
assert.match(projectionSource, /startedAt: new Date\(entry\.startedAt\)/)
assert.match(projectionSource, /readyAt: entry\.readyAt \? new Date\(entry\.readyAt\) : null/)
assert.match(projectionSource, /degradedAt: entry\.degradedAt \? new Date\(entry\.degradedAt\) : null/)

const unrelatedHealthProbe = healthSource.replace(
    /\n\}\)\n$/,
    "\n    setStopped: (connectionId) => setStopped(connectionId),\n})\n",
)
const unrelatedLifecycleProbe = lifecycleSource.replace(
    /\n\}\)\n$/,
    "\n    deleteEntry: (connectionId) => deleteEntry(connectionId),\n})\n",
)
assert.notDeepEqual(capabilityKeys(unrelatedHealthProbe), healthCapabilities)
assert.notDeepEqual(capabilityKeys(unrelatedLifecycleProbe), lifecycleCapabilities)

for (const consumerPath of healthConsumers) {
    const source = read(consumerPath)
    assert.match(source, /@\/modules\/messaging\/public\/v1\/transport-registry-health/)
    assert.doesNotMatch(source, /@\/lib\/TransportRegistry|transport-registry-lifecycle/)
}
for (const consumerPath of lifecycleConsumers) {
    const source = read(consumerPath)
    assert.match(source, /transportRegistryLifecycleV1 as registry/)
    assert.match(source, /@\/modules\/messaging\/public\/v1\/transport-registry-lifecycle/)
    assert.doesNotMatch(source, /@\/lib\/TransportRegistry/)
}

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/messaging.json'))
assert(manifest.public_surface.includes('TransportRegistryHealth.v1'))
assert(manifest.public_surface.includes('TransportRegistryLifecycle.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    [...healthConsumers, ...lifecycleConsumers].includes(finding.file)
    && finding.details?.target === implementationPath
)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    health_consumers: healthConsumers.length,
    lifecycle_consumers: lifecycleConsumers.length,
    health_capabilities: healthCapabilities.length,
    lifecycle_capabilities: lifecycleCapabilities.length,
    negative_unrelated_capability_probes: 'REJECTED',
    mutable_entry_exposure: 'ABSENT',
    dependency_cycle: 'ABSENT',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
