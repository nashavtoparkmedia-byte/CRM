#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPath = 'gravity-mvp/src/lib/messageStreamBus.ts'
const publicPath = 'gravity-mvp/src/modules/messaging/public/v1/message-stream.ts'
const consumers = [
    'gravity-mvp/src/app/api/webhook/max/reaction/route.ts',
    'gravity-mvp/src/app/api/webhooks/max/route.ts',
    'gravity-mvp/src/app/tg-actions.ts',
    'gravity-mvp/src/lib/whatsapp/WhatsAppService.ts',
]
const exactFunctions = ['broadcastChatMessageV1']

assert.equal(sha256(read(implementationPath)), '5c28b470102f64cfe64f722ed125ee8f96bb25a989e6b896bfc7bfb3f36b39e4')

function exportedFunctions(source) {
    return [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((match) => match[1]).sort()
}

const publicSource = read(publicPath)
assert.deepEqual(exportedFunctions(publicSource), exactFunctions)
assert.match(publicSource, /broadcastChatMessage\(chatId, message\)/)
assert.doesNotMatch(publicSource, /subscribeChat|getActiveSubscriberCount|export \*/)
const unrelatedCapabilityProbe = `${publicSource}\nexport function subscribeChatV1() { return () => {} }\n`
assert.notDeepEqual(exportedFunctions(unrelatedCapabilityProbe), exactFunctions)

for (const consumerPath of consumers) {
    const consumer = read(consumerPath)
    assert.match(consumer, /@\/modules\/messaging\/public\/v1\/message-stream/)
    assert.doesNotMatch(consumer, /@\/lib\/messageStreamBus/)
}

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/messaging.json'))
assert(manifest.public_surface.includes('MessageStream.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    consumers.includes(finding.file) && finding.details?.target === implementationPath
)), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    runtime_consumers: consumers.length,
    public_capabilities: exactFunctions.length,
    negative_unrelated_capability_probe: 'REJECTED',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
