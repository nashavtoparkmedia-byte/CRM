#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPath = 'gravity-mvp/src/lib/DriverMatchService.ts'
const publicPath = 'gravity-mvp/src/modules/fleet-operations/public/v1/channel-driver-match.ts'
const consumers = [
    'gravity-mvp/src/app/api/webhook/telegram/route.ts',
    'gravity-mvp/src/app/api/webhooks/max/route.ts',
    'gravity-mvp/src/app/tg-actions.ts',
    'gravity-mvp/src/lib/whatsapp/WhatsAppService.ts',
]
const exactCapabilities = ['linkChatToDriver']

assert.equal(sha256(read(implementationPath)), 'd8cbc91772bf0b7639ca15e3c96c503bd7af081c61d0c753ef7d3d3b9e958274')

function capabilityKeys(source) {
    const body = source.match(/Object\.freeze\(\{([\s\S]*?)\}\)/)?.[1] ?? ''
    return [...body.matchAll(/^ {4}(\w+):/gm)].map((match) => match[1]).sort()
}

const publicSource = read(publicPath)
assert.deepEqual(capabilityKeys(publicSource), exactCapabilities)
assert.match(publicSource, /DriverMatchService\.linkChatToDriver\(chatId, identity, linkMatchedDriver\)/)
assert.doesNotMatch(publicSource, /matchDriver|findDriverId|normalizePhone|normalizeForSearch|\bprisma\b|export \*/)
const unrelatedMatchProbe = publicSource.replace(/\n\}\)\n$/, "\n    matchDriver: (identity) => DriverMatchService.matchDriver(identity),\n})\n")
assert.notDeepEqual(capabilityKeys(unrelatedMatchProbe), exactCapabilities)

for (const consumerPath of consumers) {
    const consumer = read(consumerPath)
    assert.match(consumer, /channelDriverMatchV1 as DriverMatchService/)
    assert.match(consumer, /@\/modules\/fleet-operations\/public\/v1\/channel-driver-match/)
    assert.doesNotMatch(consumer, /@\/lib\/DriverMatchService/)
}

const fleetManifest = JSON.parse(read('architecture/contexts/v1/manifests/fleet_operations.json'))
const whatsAppManifest = JSON.parse(read('architecture/contexts/v1/manifests/whatsapp_channel.json'))
assert(fleetManifest.public_surface.includes('DriverMatch.v1'))
assert(whatsAppManifest.allowed_dependencies.some((dependency) => dependency.context === 'fleet_operations' && dependency.surface === 'fleet_operations.public'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    consumers.includes(finding.file) && finding.details?.target === implementationPath
)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    runtime_consumers: consumers.length,
    match_capabilities: exactCapabilities.length,
    negative_unrelated_match_probe: 'REJECTED',
    dependency_cycle: 'ABSENT',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
