#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPath = 'gravity-mvp/src/lib/ConversationWorkflowService.ts'
const publicPath = 'gravity-mvp/src/modules/messaging/public/v1/channel-conversation-workflow.ts'
// The singular legacy MAX ingress is retired. It could synthesize conversation
// identity from phone digits or a mutable title, so it is now a static tombstone
// and all scraper traffic is owned by the exact account-bound /api/webhooks/max
// route, which still drives the workflow. It stays under the architecture scan
// below so a future direct import there is still caught.
const retiredIngress = 'gravity-mvp/src/app/api/webhook/max/route.ts'
const consumers = [
    'gravity-mvp/src/app/api/webhook/telegram/route.ts',
    'gravity-mvp/src/app/api/webhooks/max/route.ts',
    'gravity-mvp/src/app/tg-actions.ts',
    'gravity-mvp/src/lib/whatsapp/WhatsAppService.ts',
]
const exactCapabilities = ['onGroupInboundMessage', 'onInboundMessage', 'onOutboundMessage']

assert.equal(sha256(read(implementationPath)), 'a74499ccd9aea7a932de65b1f42a505135b305a7bf61213a1b40a9aa4f266baa')

function capabilityKeys(source) {
    const body = source.match(/Object\.freeze\(\{([\s\S]*?)\}\)/)?.[1] ?? ''
    return [...body.matchAll(/^\s*(\w+):/gm)].map((match) => match[1]).sort()
}

const publicSource = read(publicPath)
assert.deepEqual(capabilityKeys(publicSource), exactCapabilities)
assert.match(publicSource, /ConversationWorkflowService\.onInboundMessage\(chatId, sentAt\)/)
assert.match(publicSource, /ConversationWorkflowService\.onGroupInboundMessage\(chatId, sentAt\)/)
assert.match(publicSource, /ConversationWorkflowService\.onOutboundMessage\(chatId, sentAt\)/)
assert.doesNotMatch(publicSource, /assignChat|unassignChat|resolveChat|reopenChat|markRead|\bprisma\b|\$executeRaw|export \*/)
const unrelatedWriteProbe = publicSource.replace(/\n\}\)\n$/, "\n    assignChat: (chatId, userId) => ConversationWorkflowService.assignChat(chatId, userId),\n})\n")
assert.notDeepEqual(capabilityKeys(unrelatedWriteProbe), exactCapabilities)

for (const consumerPath of consumers) {
    const consumer = read(consumerPath)
    assert.match(consumer, /channelConversationWorkflowV1 as ConversationWorkflowService/)
    assert.match(consumer, /@\/modules\/messaging\/public\/v1\/channel-conversation-workflow/)
    assert.doesNotMatch(consumer, /@\/lib\/ConversationWorkflowService/)
}

// The retired ingress must stay a static tombstone: no request parsing, no
// workflow capability, and the exact replacement pointer.
const assertRetiredIngress = (source) => {
    assert.match(source, /MAX_LEGACY_WEBHOOK_RETIRED/u)
    assert.match(source, /replacement: '\/api\/webhooks\/max'/u)
    assert.match(source, /status: 410/u)
    assert.match(source, /export async function POST\(\)/u)
    assert.doesNotMatch(source, /ConversationWorkflowService|channel-conversation-workflow|@\/lib\/ConversationWorkflowService/u)
    assert.doesNotMatch(source, /await\s+(?:req|request)\.json/u)
}
const retiredSource = read(retiredIngress)
assertRetiredIngress(retiredSource)
assert.throws(() => assertRetiredIngress(retiredSource.replace('status: 410', 'status: 200')))
assert.throws(() => assertRetiredIngress(retiredSource.replace(
    'export async function POST() {',
    "export async function POST() {\n    await ConversationWorkflowService.onInboundMessage('x', new Date())",
)))

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/messaging.json'))
assert(manifest.public_surface.includes('ChannelConversationWorkflow.v1'))

const scan = await scanArchitecture(root)
const workflowIngress = [...consumers, retiredIngress]
assert.deepEqual(scan.findings.filter((finding) => (
    workflowIngress.includes(finding.file) && finding.details?.target === implementationPath
)), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    runtime_consumers: consumers.length,
    retired_ingress: 1,
    write_capabilities: exactCapabilities.length,
    negative_unrelated_write_probe: 'REJECTED',
    negative_retired_ingress_probe: 'REJECTED',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
