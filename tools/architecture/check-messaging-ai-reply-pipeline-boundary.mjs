#!/usr/bin/env node

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const oldDirectory = 'gravity-mvp/src/lib/pipeline'
const pipelineDirectory = 'gravity-mvp/src/modules/messaging/internal/ai-reply-pipeline'
const transportPath = 'gravity-mvp/src/infrastructure/providers/multi-provider-llm-transport.ts'
const facadePath = 'gravity-mvp/src/infrastructure/providers/multi-provider-llm.ts'
const messageEventsPath = 'gravity-mvp/src/lib/messageEvents.ts'
const proposedReplyPath = 'gravity-mvp/src/app/messages/proposed-reply-actions.ts'
const exactPipelineFiles = [
    'ChannelAdapterRegistry.ts',
    'ContextBuilder.ts',
    'DecisionEngine.ts',
    'IntentClassifier.ts',
    'PipelineWorker.ts',
    'ResponseGenerator.ts',
    'shadowReply.ts',
]

assert.deepEqual(
    existsSync(path.join(root, oldDirectory)) ? readdirSync(path.join(root, oldDirectory)) : [],
    [],
)
assert.deepEqual(readdirSync(path.join(root, pipelineDirectory)).sort(), exactPipelineFiles)
assert.equal(existsSync(path.join(root, transportPath)), true)

const worker = read(`${pipelineDirectory}/PipelineWorker.ts`)
const shadowReply = read(`${pipelineDirectory}/shadowReply.ts`)
const responseGenerator = read(`${pipelineDirectory}/ResponseGenerator.ts`)
const intentClassifier = read(`${pipelineDirectory}/IntentClassifier.ts`)
const channelRegistry = read(`${pipelineDirectory}/ChannelAdapterRegistry.ts`)
const messageEvents = read(messageEventsPath)
const proposedReply = read(proposedReplyPath)
const transport = read(transportPath)
const facade = read(facadePath)

assert.match(messageEvents, /@\/modules\/messaging\/internal\/ai-reply-pipeline\/PipelineWorker/)
assert.match(messageEvents, /pipelineWorker\.process\(message\)\.catch/)
assert.match(proposedReply, /@\/modules\/messaging\/internal\/ai-reply-pipeline\/shadowReply/)
for (const source of [messageEvents, proposedReply, worker, shadowReply, responseGenerator, intentClassifier]) {
    assert.doesNotMatch(source, /@\/lib\/pipeline/)
}

const processBody = worker.slice(worker.indexOf('async process('), worker.indexOf('private async _runSteps'))
assert(processBody.indexOf("message.direction !== 'inbound'") < processBody.indexOf('claimMessageEventV1'))
assert(processBody.indexOf('claimMessageEventV1') < processBody.indexOf("setAiStatus(message.id, 'processing')"))
assert(processBody.indexOf("setAiStatus(message.id, 'processing')") < processBody.indexOf('this._runSteps(message)'))
assert(processBody.indexOf('this._runSteps(message)') < processBody.indexOf('completeMessageEventV1'))
assert(processBody.indexOf('completeMessageEventV1') < processBody.indexOf("setAiStatus(message.id, 'done')"))
assert.match(processBody, /failMessageEventV1\([\s\S]*?\)\.catch\(\(\) => \{\}\)/)
assert(processBody.indexOf('failMessageEventV1') < processBody.indexOf("setAiStatus(message.id, 'failed').catch"))

assert(shadowReply.indexOf("ctx.config.mode = 'suggest_only'") < shadowReply.indexOf('responseGenerator.generate('))
assert.match(responseGenerator, /decision\.decision === 'auto_reply' && config\.mode === 'auto_reply'/)
assert.match(channelRegistry, /getMaxChannelDeliveryV1\(\)\.sendText/)
assert.match(channelRegistry, /getTelegramChannelDeliveryV1\(\)\.sendText/)
assert.match(channelRegistry, /getWhatsAppChannelDeliveryV1\(\)\.sendText/)
assert.deepEqual(
    [...channelRegistry.matchAll(/\['(max|telegram|whatsapp)'/g)].map((match) => match[1]),
    ['max', 'telegram', 'whatsapp'],
)

for (const source of [intentClassifier, responseGenerator]) {
    assert.match(source, /@\/infrastructure\/providers\/multi-provider-llm/)
    assert.doesNotMatch(source, /\bfetch\(|api\.openai\.com|api\.anthropic\.com/)
}
assert.doesNotMatch(transport, /@\/modules|@\/contracts|@\/lib\/prisma|\bprisma\.|@prisma\/client/)
assert.match(transport, /https:\/\/api\.openai\.com\/v1\/chat\/completions/)
assert.match(transport, /https:\/\/api\.anthropic\.com\/v1\/messages/)
assert.deepEqual(
    [...facade.matchAll(/export async function (\w+)/g)].map((match) => match[1]).sort(),
    ['callProviderJsonV1', 'callProviderTextV1'],
)
assert.doesNotMatch(facade, /\bfetch\(|api\.openai\.com|api\.anthropic\.com|export \*/)
const unrelatedFacadeProbe = `${facade}\nexport async function listProviderCredentialsV1() { return [] }\n`
assert.notDeepEqual(
    [...unrelatedFacadeProbe.matchAll(/export async function (\w+)/g)].map((match) => match[1]).sort(),
    ['callProviderJsonV1', 'callProviderTextV1'],
)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/messaging.json'))
assert(manifest.internal_surface.includes(pipelineDirectory))
assert.match(manifest.responsibility, /inbound AI reply\/draft orchestration/)
assert.equal(manifest.public_surface.some((surface) => /pipeline/i.test(surface)), false)

const scan = await scanArchitecture(root)
const movedPaths = new Set(exactPipelineFiles.map((file) => `${pipelineDirectory}/${file}`))
assert.deepEqual(scan.findings.filter((finding) => (
    movedPaths.has(finding.file)
    || movedPaths.has(finding.details?.target)
    || finding.file.startsWith(`${oldDirectory}/`)
    || finding.details?.target?.startsWith(`${oldDirectory}/`)
)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    messaging_pipeline_files: exactPipelineFiles.length,
    shared_transport_files: 2,
    protected_provider_adapters: 3,
    negative_unrelated_transport_capability_probe: 'REJECTED',
    dependency_cycle: 'ABSENT',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
