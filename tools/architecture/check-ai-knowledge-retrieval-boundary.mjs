#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPath = 'gravity-mvp/src/lib/ai/knowledge/Retriever.ts'
const publicPath = 'gravity-mvp/src/modules/ai-knowledge/public/v1/knowledge-retrieval.ts'
const consumers = [
    'gravity-mvp/src/app/settings/ai/actions.ts',
    'gravity-mvp/src/modules/messaging/internal/ai-reply-pipeline/ContextBuilder.ts',
    'gravity-mvp/src/modules/messaging/internal/ai-reply-pipeline/ResponseGenerator.ts',
]
const exactFunctions = [
    'formatKnowledgeFactsForPromptV1',
    'previewKnowledgeRetrievalV1',
    'retrieveKnowledgeForRuntimeV1',
].sort()

assert.equal(sha256(read(implementationPath)), '9e8a4bfd44c81e48991d22ed1bb84205e39ba00114b55b94590b0e146a23db58')

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
assert.match(publicSource, /mode: 'shadow' \| 'runtime'/)
assert.match(publicSource, /shadowMode: input\.mode === 'shadow'/)
assert.match(publicSource, /previewKnowledgeRetrievalV1[\s\S]*?shadowMode: false/)
assert.match(publicSource, /formatRetrievedFactsForPrompt\(items\)/)
assert.doesNotMatch(publicSource, /includeDrafts|skipRerank|topK|@\/lib\/prisma|\bprisma\.|\$queryRaw|\$executeRaw|provider|audit|extract/i)
assert.doesNotMatch(publicSource, /export \*|Retriever\.rerank|retrievalPrompt|loadCandidates|loadPolicy/)

const genericPolicyProbe = `${publicSource}\nexport async function retrieveKnowledgeWithPolicyV1() { return null }\n`
assert.equal(hasExactCapabilitySurface(genericPolicyProbe), false)

for (const consumer of consumers) {
    const source = read(consumer)
    assert.match(source, /@\/modules\/ai-knowledge\/public\/v1\/knowledge-retrieval/)
    assert.doesNotMatch(source, /@\/lib\/ai\/knowledge\/Retriever/)
}

const settings = read(consumers[0])
const previewStart = settings.indexOf('export async function previewDecisionRetry')
const previewBody = settings.slice(previewStart, settings.indexOf('// 3. Если policy', previewStart))
assert(previewBody.indexOf('await requireAdminUserId()') < previewBody.indexOf('previewKnowledgeRetrievalV1({'))
assert.match(previewBody, /previewKnowledgeRetrievalV1\(\{\s*query: row\.userContent,\s*\}\)/)

const context = read(consumers[1])
assert(context.indexOf("if (mode !== 'legacy')") < context.indexOf('retrieveKnowledgeForRuntimeV1({'))
assert.match(context, /retrieveKnowledgeForRuntimeV1\(\{\s*query,\s*recentMessages,\s*mode,\s*\}\)/)
assert(context.indexOf('try {', context.indexOf("if (mode !== 'legacy')")) < context.indexOf('retrieveKnowledgeForRuntimeV1({'))
assert(context.indexOf('retrieveKnowledgeForRuntimeV1({') < context.indexOf('knowledgeRetrieval = null', context.indexOf('retrieveKnowledgeForRuntimeV1({')))

const response = read(consumers[2])
assert.match(response, /formatKnowledgeFactsForPromptV1\(knowledgeRetrieval!\.items\)/)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/ai_knowledge.json'))
assert(manifest.public_surface.includes('KnowledgeQuery.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    consumers.includes(finding.file)
    && [implementationPath, publicPath].includes(finding.details?.target)
)), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    consumers: consumers.length,
    capabilities: exactFunctions.length,
    generic_policy_probe: 'REJECTED',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
