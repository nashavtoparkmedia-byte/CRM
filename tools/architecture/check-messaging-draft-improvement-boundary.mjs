#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const llmImplementationPath = 'gravity-mvp/src/lib/pipeline/llmClient.ts'
const providerPath = 'gravity-mvp/src/infrastructure/providers/multi-provider-llm.ts'
const publicPath = 'gravity-mvp/src/modules/messaging/public/v1/draft-improvement.ts'
const actionPath = 'gravity-mvp/src/app/messages/improve-draft-actions.ts'
const componentPath = 'gravity-mvp/src/app/messages/components/ImproveDraftPopover.tsx'
const coachPath = 'gravity-mvp/src/lib/ai/knowledge/coach.ts'
const exactProviderFunctions = ['callProviderJsonV1', 'callProviderTextV1'].sort()
const exactMessagingFunctions = ['improveMessageDraftV1']

assert.equal(sha256(read(llmImplementationPath)), 'f277bb169caef3adea16d90c471d4f0e126a8516a7047b26936a6cae16865280')

function exportedFunctions(source) {
    return [...source.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((match) => match[1]).sort()
}

const provider = read(providerPath)
assert.deepEqual(exportedFunctions(provider), exactProviderFunctions)
assert.match(provider, /return callForText\(options\)/)
assert.match(provider, /return callForJson\(options\)/)
assert.doesNotMatch(provider, /export \*|\bfetch\(|api\.openai\.com|api\.anthropic\.com|createOpenAIClient|getProviderClient|embeddings/)
const providerProbe = `${provider}\nexport async function callProviderEmbeddingV1() { return [] }\n`
assert.notDeepEqual(exportedFunctions(providerProbe), exactProviderFunctions)

const messaging = read(publicPath)
assert.deepEqual(exportedFunctions(messaging), exactMessagingFunctions)
assert.match(messaging, /PRESET_INSTRUCTIONS\[options\.preset\]/)
assert.match(messaging, /\.slice\(-6\)/)
assert.match(messaging, /message\.content\.slice\(0, 200\)/)
assert.match(messaging, /maxTokens: 600[\s\S]*?temperature: 0\.4/)
assert.match(messaging, /return text\.trim\(\)\.replace\(\/\^\["«\]\|\["»\]\$\/g, ''\)\.trim\(\)/)
assert.doesNotMatch(messaging, /export \*|export\s+(?:const|let|var)\s+(?:SYSTEM_BASE|PRESET_INSTRUCTIONS)|callProviderJsonV1|\bprisma\.|\$queryRaw|\$executeRaw/)
const messagingProbe = `${messaging}\nexport async function sendImprovedMessageV1() { return true }\n`
assert.notDeepEqual(exportedFunctions(messagingProbe), exactMessagingFunctions)

const action = read(actionPath)
assert.match(action, /improveMessageDraftV1 as improveDraft/)
assert.match(action, /MessageDraftImprovePresetV1 as ImprovePreset/)
assert.doesNotMatch(action, /@\/lib\/ai\/improveDraft/)
assert(action.indexOf('getAiAgentProviderConfigV1()') < action.indexOf('prisma.message.findMany'))
assert(action.indexOf('prisma.message.findMany') < action.indexOf('FROM "AiKnowledgeItem"'))
assert(action.indexOf('FROM "AiKnowledgeItem"') < action.indexOf('await improveDraft({'))

const component = read(componentPath)
assert.match(component, /@\/modules\/messaging\/public\/v1\/draft-improvement/)
assert.doesNotMatch(component, /@\/lib\/ai\/improveDraft/)
assert.match(read(coachPath), /@\/infrastructure\/providers\/multi-provider-llm/)
assert.doesNotMatch(read(coachPath), /@\/lib\/pipeline\/llmClient/)
assert.equal(existsSync(path.join(root, 'gravity-mvp/src/lib/ai/improveDraft.ts')), false)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/messaging.json'))
assert(manifest.public_surface.includes('DraftImprovement.v1'))

const scan = await scanArchitecture(root)
const consumers = [actionPath, componentPath, coachPath]
const targets = [
    'gravity-mvp/src/lib/ai/improveDraft.ts',
    llmImplementationPath,
    providerPath,
    publicPath,
]
assert.deepEqual(scan.findings.filter((finding) => (
    consumers.includes(finding.file) && targets.includes(finding.details?.target)
)), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    runtime_consumers: consumers.length,
    provider_capabilities: exactProviderFunctions.length,
    messaging_capabilities: exactMessagingFunctions.length,
    negative_unrelated_capability_probes: 'REJECTED',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
