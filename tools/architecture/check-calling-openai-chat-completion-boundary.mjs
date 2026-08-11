#!/usr/bin/env node

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const publicPath = 'gravity-mvp/src/modules/calling/public/v1/openai-chat-completion.ts'
const runtimeConsumers = [
    'gravity-mvp/src/lib/ai-call/devSimulator.ts',
    'gravity-mvp/src/lib/queue/analyzeWorker.ts',
]
const operationalConsumer = 'gravity-mvp/scripts/test-audio-via-chat.ts'
const exactFunctions = ['createCallingOpenAiChatCompletionV1']

function exportedFunctions(source) {
    return [...source.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((match) => match[1]).sort()
}

function hasExactCapabilitySurface(source) {
    return JSON.stringify(exportedFunctions(source)) === JSON.stringify(exactFunctions)
        && !/export\s+(?:class|const|let|var)\b/.test(source)
}

const publicSource = read(publicPath)
assert.equal(hasExactCapabilitySurface(publicSource), true)
assert.match(publicSource, /createCallingOpenAiChatCompletionV1\([\s\S]*?return openai\.chat\.completions\.create\(request\)/)
assert.match(publicSource, /process\.env\.OPENAI_API_KEY[\s\S]*?getOpenAiRuntimeProviderCredentialV1\(\)/)
assert.doesNotMatch(publicSource, /export \*|export[^\n]*getCallingOpenAiClient|audio\.transcriptions|responses\.create|@\/lib\/openaiClient/)

const unrelatedCapabilityProbe = `${publicSource}\nexport async function getCallingOpenAiClientV1() { return null }\n`
assert.equal(hasExactCapabilitySurface(unrelatedCapabilityProbe), false)

for (const consumerPath of [...runtimeConsumers, operationalConsumer]) {
    const consumer = read(consumerPath)
    assert.match(consumer, /createCallingOpenAiChatCompletionV1/)
    assert.doesNotMatch(consumer, /getOpenAI|@\/lib\/openaiClient|src\/lib\/openaiClient/)
}
assert.equal(existsSync(path.join(root, 'gravity-mvp/src/lib/openaiClient.ts')), false)

const simulator = read(runtimeConsumers[0])
assert.match(simulator, /await createCallingOpenAiChatCompletionV1\(\{[\s\S]*?tools: TOOLS,[\s\S]*?temperature: 0\.4/)
const analyzer = read(runtimeConsumers[1])
assert.match(analyzer, /await createCallingOpenAiChatCompletionV1\(\{[\s\S]*?response_format: \{ type: 'json_object' \},[\s\S]*?max_tokens: MAX_OUTPUT_TOKENS/)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/calling.json'))
assert(manifest.public_surface.includes('CallingOpenAiChatCompletion.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    runtimeConsumers.includes(finding.file)
    && (finding.details?.target === publicPath || finding.details?.target?.endsWith('/lib/openaiClient.ts'))
)), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    runtime_consumers: runtimeConsumers.length,
    operational_consumers: 1,
    capabilities: exactFunctions.length,
    negative_unrelated_capability_probe: 'REJECTED',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
