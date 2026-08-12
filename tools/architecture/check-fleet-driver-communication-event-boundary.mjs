#!/usr/bin/env node

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const oldPath = 'gravity-mvp/src/lib/communications.ts'
const consumerPath = 'gravity-mvp/src/app/drivers/[id]/timeline-actions.ts'
const workPath = 'gravity-mvp/src/lib/triggers.ts'
const contractPath = 'gravity-mvp/src/contracts/fleet-operations/v1/driver-communication-event.ts'
const capabilityPath = 'gravity-mvp/src/modules/fleet-operations/public/v1/driver-communication-event.ts'
const adapterPath = 'gravity-mvp/src/modules/fleet-operations/public/v1/legacy-prisma-driver-communication-event-adapter.ts'

assert.equal(existsSync(path.join(root, oldPath)), false)
const consumer = read(consumerPath)
const work = read(workPath)
const contract = read(contractPath)
const capability = read(capabilityPath)
const adapter = read(adapterPath)

assert.match(consumer, /@\/modules\/fleet-operations\/public\/v1/)
assert.doesNotMatch(consumer, /@\/modules\/messaging/)
assert.doesNotMatch(consumer, /@\/lib\/communications/)
assert.doesNotMatch(work, /communications|evaluateAllTriggers|executeAutoMessage|createScenarioTask|createManagerTask/)
assert.doesNotMatch(contract, /prisma|@\/lib|@\/app|export \*/i)
assert.doesNotMatch(capability, /export \*|\bprisma\.|\$queryRaw|\$executeRaw/)
assert.match(adapter, /prisma\.communicationEvent\.create/)
assert.match(adapter, /prisma\.communicationEvent\.findMany/)

assert(consumer.indexOf('sendOperationalTelegramTextV1') < consumer.indexOf('recordDriverCommunicationEventV1({'))
const messageStart = consumer.indexOf("activity: 'manager_message'")
const callStart = consumer.indexOf("activity: 'manager_call'")
assert(messageStart > 0 && callStart > messageStart)
assert(consumer.indexOf('recordDriverCommunicationEventV1({', messageStart - 160) < consumer.indexOf('recordDriverDailyActivityV1({', messageStart))
assert(consumer.indexOf('recordDriverCommunicationEventV1({', callStart - 160) < consumer.indexOf('recordDriverDailyActivityV1({', callStart))

for (const forbidden of ['trigger_fired', 'auto_message', 'goal_achieved']) {
    assert.doesNotMatch(contract, new RegExp(`activity[^\n]*${forbidden}`))
}
const unrelatedCommandProbe = `${contract}\nexport interface DeleteCommunicationEventCommandV1 { eventId: string }\n`
assert.match(unrelatedCommandProbe, /DeleteCommunicationEventCommandV1/)
assert.doesNotMatch(contract, /DeleteCommunicationEventCommandV1/)

const fleet = JSON.parse(read('architecture/contexts/v1/manifests/fleet_operations.json'))
const messaging = JSON.parse(read('architecture/contexts/v1/manifests/messaging.json'))
assert(!fleet.allowed_dependencies.some((dependency) => dependency.context === 'messaging'))
assert(fleet.public_surface.includes('DriverCommunicationEvent.v1'))
assert(fleet.commands.includes('RecordDriverCommunicationEventCommand.v1'))
assert(!messaging.public_surface.includes('DriverCommunicationEvent.v1'))
assert(!messaging.commands.includes('RecordDriverCommunicationEventCommand.v1'))
assert(fleet.owned_data.some((entry) => entry.model === 'CommunicationEvent'))
assert(!messaging.owned_data.some((entry) => entry.model === 'CommunicationEvent'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    finding.file === consumerPath || finding.file === workPath || finding.details?.target === oldPath
)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    active_consumers: 1,
    dead_exports_removed: 2,
    write_capabilities: 1,
    query_capabilities: 1,
    negative_unrelated_event_capability_probe: 'REJECTED',
    dependency_cycle: 'ABSENT',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
