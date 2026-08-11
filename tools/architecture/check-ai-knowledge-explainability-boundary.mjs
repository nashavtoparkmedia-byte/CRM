#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPath = 'gravity-mvp/src/lib/ai/knowledge/explainability.ts'
const publicPath = 'gravity-mvp/src/modules/ai-knowledge/public/v1/knowledge-explainability-read-model.ts'
const consumerPath = 'gravity-mvp/src/app/settings/ai/actions.ts'

assert.equal(sha256(read(implementationPath)), '43055e025a20615b1b969efee276cb4f0d4961863bd32793b4ffb6810fd43e61')

function exportedFunctions(source) {
    return [...source.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((match) => match[1]).sort()
}

function hasExactCapabilitySurface(source) {
    return JSON.stringify(exportedFunctions(source)) === JSON.stringify(['getKnowledgeDecisionExplainabilityV1'])
        && !/export\s+(?:class|const|let|var)\b/.test(source)
}

const publicSource = read(publicPath)
assert.equal(hasExactCapabilitySurface(publicSource), true)
assert.match(publicSource, /access: KnowledgeItemSourceAccessV1/)
assert.match(publicSource, /access\.includeSourceExcerpts === true\s*\? bundle\s*:\s*\{ \.\.\.bundle, sources: \[\] \}/)
assert.doesNotMatch(publicSource, /export \*|@\/lib\/prisma|\bprisma\.|\$queryRaw|\$executeRaw|writeAuditEntry|runExtraction|provider/i)

const rawReadProbe = `${publicSource}\nexport async function getRawKnowledgeExplainabilityV1() { return null }\n`
assert.equal(hasExactCapabilitySurface(rawReadProbe), false)

const consumerSource = read(consumerPath)
assert.match(consumerSource, /@\/modules\/ai-knowledge\/public\/v1\/knowledge-explainability-read-model/)
assert.doesNotMatch(consumerSource, /@\/lib\/ai\/knowledge\/explainability/)
const actionStart = consumerSource.indexOf('export async function getDecisionExplainabilityForUi')
const actionEnd = consumerSource.indexOf('export interface RetryPreviewResult', actionStart)
const action = consumerSource.slice(actionStart, actionEnd)
assert(action.indexOf('await canViewKnowledgeSources()') < action.indexOf('getKnowledgeDecisionExplainabilityV1('))
assert.match(action, /includeSourceExcerpts: allowed/)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/ai_knowledge.json'))
assert(manifest.public_surface.includes('KnowledgeQuery.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    finding.file === consumerPath
    && [implementationPath, publicPath].includes(finding.details?.target)
)), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    consumers: 1,
    capabilities: 1,
    raw_read_probe: 'REJECTED',
    source_excerpt_default: 'REDACTED',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
