#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const runtimePath = 'gravity-mvp/src/lib/messageEvents.ts'
const publicPath = 'gravity-mvp/src/modules/messaging/public/v1/persisted-message-ingress.ts'
const consumers = [
    'gravity-mvp/src/app/api/webhooks/max/route.ts',
    'gravity-mvp/src/app/tg-actions.ts',
    'gravity-mvp/src/lib/whatsapp/WhatsAppService.ts',
]
const exactFunctions = ['publishPersistedMessageV1']

function exportedFunctions(source) {
    return [...source.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((match) => match[1]).sort()
}

const publicSource = read(publicPath)
const runtime = read(runtimePath)

assert.deepEqual(exportedFunctions(publicSource), exactFunctions)
assert.match(publicSource, /message: ExternalMessageRecordV1/)
assert.match(publicSource, /return emitMessageReceived\(message\)/)
assert.doesNotMatch(publicSource, /@prisma\/client|\bprisma\.|\$queryRaw|\$executeRaw|pipelineWorker|setAiStatus|broadcastChatMessage|export \*/)
const unrelatedCapabilityProbe = `${publicSource}\nexport async function setPersistedMessageAiStatusV1() {}\n`
assert.notDeepEqual(exportedFunctions(unrelatedCapabilityProbe), exactFunctions)

for (const consumerPath of consumers) {
    const consumer = read(consumerPath)
    assert.match(consumer, /publishPersistedMessageV1 as emitMessageReceived/)
    assert.match(consumer, /@\/modules\/messaging\/public\/v1\/persisted-message-ingress/)
    assert.doesNotMatch(consumer, /@\/lib\/messageEvents/)
}

assert(runtime.indexOf('broadcastChatMessage(message.chatId, message)') < runtime.indexOf("if (message.direction !== 'inbound') return"))
assert(runtime.indexOf("if (message.direction !== 'inbound') return") < runtime.indexOf('INSERT INTO "MessageEventLog"'))
assert(runtime.indexOf('INSERT INTO "MessageEventLog"') < runtime.indexOf("setAiStatus(message.id, 'pending')"))
assert(runtime.indexOf("setAiStatus(message.id, 'pending')") < runtime.indexOf('pipelineWorker.process(message).catch'))
assert.match(runtime, /pipelineWorker\.process\(message\)\.catch\(e =>[\s\S]*?console\.error\('\[Pipeline\] Worker error:', e\.message\)/)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/messaging.json'))
assert(manifest.public_surface.includes('PersistedMessageIngress.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    consumers.includes(finding.file) && finding.details?.target === runtimePath
)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    provider_consumers: consumers.length,
    public_capabilities: exactFunctions.length,
    negative_unrelated_capability_probe: 'REJECTED',
    dependency_cycle: 'ABSENT',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
