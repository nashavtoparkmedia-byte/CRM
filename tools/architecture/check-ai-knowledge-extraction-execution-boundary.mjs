#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const extractorPath = 'gravity-mvp/src/lib/ai/knowledge/Extractor.ts'
const pairBuilderPath = 'gravity-mvp/src/lib/ai/knowledge/pairBuilder.ts'
const publicPath = 'gravity-mvp/src/modules/ai-knowledge/public/v1/knowledge-extraction-execution.ts'
const consumerPath = 'gravity-mvp/src/app/settings/ai/actions.ts'
const exactFunctions = ['runQueuedKnowledgeExtractionV1']

assert.equal(sha256(read(extractorPath)), '89fd664341dec81b93d45f7311925bc688159b01c12670ce0878b66b852ddd8e')
assert.equal(sha256(read(pairBuilderPath)), '1d7ed3a0c526ca4967bac7cc4d46d7804fc2ccda95919d27dcace2dc0b1f3816')

function exportedFunctions(source) {
    return [...source.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((match) => match[1]).sort()
}

function hasExactCapabilitySurface(source) {
    return JSON.stringify(exportedFunctions(source)) === JSON.stringify(exactFunctions)
        && !/export\s+(?:class|const|let|var)\b/.test(source)
}

const publicSource = read(publicPath)
assert.equal(hasExactCapabilitySurface(publicSource), true)
assert.match(publicSource, /runQueuedKnowledgeExtractionV1\(jobId: string\)[\s\S]*?return runExtraction\(jobId\)/)
assert.match(publicSource, /ExtractionScope as KnowledgeExtractionScopeV1/)
assert.doesNotMatch(publicSource, /export \*|@\/lib\/prisma|\bprisma\.|\$queryRaw|\$executeRaw|loadCandidateMessages|buildPairsForChat|processBatch|finalizeJob/)

const unrelatedWriteProbe = `${publicSource}\nexport async function deleteKnowledgeExtractionJobV1() { return true }\n`
assert.equal(hasExactCapabilitySurface(unrelatedWriteProbe), false)

const consumerSource = read(consumerPath)
assert.match(consumerSource, /@\/modules\/ai-knowledge\/public\/v1\/knowledge-extraction-execution/)
assert.doesNotMatch(consumerSource, /@\/lib\/ai\/knowledge\/(?:Extractor|pairBuilder)/)
assert.match(consumerSource, /runQueuedKnowledgeExtractionV1 as runExtraction/)
assert.match(consumerSource, /KnowledgeExtractionScopeV1 as ExtractionScope/)

const actionStart = consumerSource.indexOf('export async function startKnowledgeExtraction')
const actionEnd = consumerSource.indexOf('/** Polling-эндпоинт', actionStart)
const action = consumerSource.slice(actionStart, actionEnd)
assert(action.indexOf('await assertCanEditAi()') < action.indexOf('queueKnowledgeExtractionV1('))
assert(action.indexOf('queueKnowledgeExtractionV1(') < action.indexOf('runExtraction(id).catch('))
assert(action.indexOf('runExtraction(id).catch(') < action.indexOf("status: 'queued'"))

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/ai_knowledge.json'))
assert(manifest.public_surface.includes('KnowledgeExtractionExecution.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    finding.file === consumerPath
    && [extractorPath, pairBuilderPath, publicPath].includes(finding.details?.target)
)), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    consumers: 1,
    capabilities: exactFunctions.length,
    negative_unrelated_write_probe: 'REJECTED',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
