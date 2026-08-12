#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const textImplementationPath = 'gravity-mvp/src/lib/ai/knowledge/textUtils.ts'
const versionImplementationPath = 'gravity-mvp/src/lib/ai/knowledge/retrievalPrompt.ts'
const similarityPublicPath = 'gravity-mvp/src/modules/ai-knowledge/public/v1/knowledge-text-similarity.ts'
const versionPublicPath = 'gravity-mvp/src/modules/ai-knowledge/public/v1/knowledge-retrieval-version.ts'
const messageConsumerPath = 'gravity-mvp/src/app/messages/learn-from-outbound-actions.ts'
const pipelineConsumerPath = 'gravity-mvp/src/modules/messaging/internal/ai-reply-pipeline/PipelineWorker.ts'

assert.equal(sha256(read(textImplementationPath)), '4fe66e585b9bdc1b05b15a99bec0fbb46e9d1a825bf3a33dce0746356379a7ed')
assert.equal(sha256(read(versionImplementationPath)), '999bd03279b367d6ae9e324f9f51a97465a6d66795453f4dd88d021f5c7200b5')

const similarityPublic = read(similarityPublicPath)
assert.deepEqual(
  [...similarityPublic.matchAll(/export\s+function\s+(\w+)/g)].map((match) => match[1]),
  ['compareKnowledgeTextSimilarityV1'],
)
assert.match(similarityPublic, /return similarity\(left, right\)/)
assert.doesNotMatch(similarityPublic, /export \*|normalize|trigrams|jaccard|maskPII|extractNumericValues|isVerbatimEvidence|makeExcerptHash/)
const unrelatedTextProbe = `${similarityPublic}\nexport function maskKnowledgePiiV1(value) { return value }\n`
assert.notDeepEqual(
  [...unrelatedTextProbe.matchAll(/export\s+function\s+(\w+)/g)].map((match) => match[1]),
  ['compareKnowledgeTextSimilarityV1'],
)

const versionPublic = read(versionPublicPath)
assert.deepEqual(
  [...versionPublic.matchAll(/export\s+const\s+(\w+)/g)].map((match) => match[1]),
  ['KNOWLEDGE_RETRIEVAL_PROMPT_VERSION_V1'],
)
assert.match(versionPublic, /= RETRIEVAL_PROMPT_VERSION/)
assert.doesNotMatch(versionPublic, /export \*|RERANK_SYSTEM_PROMPT|buildRerankUserPrompt|parseRerankResponse/)

const messageConsumer = read(messageConsumerPath)
assert.match(messageConsumer, /compareKnowledgeTextSimilarityV1 as similarity/)
assert.doesNotMatch(messageConsumer, /@\/lib\/ai\/knowledge\/textUtils/)
const pipelineConsumer = read(pipelineConsumerPath)
assert.match(pipelineConsumer, /KNOWLEDGE_RETRIEVAL_PROMPT_VERSION_V1 as RETRIEVAL_PROMPT_VERSION/)
assert.doesNotMatch(pipelineConsumer, /@\/lib\/ai\/knowledge\/retrievalPrompt/)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/ai_knowledge.json'))
assert(manifest.public_surface.includes('KnowledgeTextSimilarity.v1'))
assert(manifest.public_surface.includes('KnowledgeRetrievalVersion.v1'))

const scan = await scanArchitecture(root)
const consumers = [messageConsumerPath, pipelineConsumerPath]
const targets = [textImplementationPath, versionImplementationPath, similarityPublicPath, versionPublicPath]
assert.deepEqual(scan.findings.filter((finding) => (
  consumers.includes(finding.file) && targets.includes(finding.details?.target)
)), [])

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  consumers: consumers.length,
  capabilities: 2,
  negative_unrelated_capability_probe: 'REJECTED',
  current_findings: scan.findings.length,
}, null, 2)}\n`)
