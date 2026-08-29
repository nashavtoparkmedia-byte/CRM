#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const flagPath = 'gravity-mvp/src/lib/ai/knowledge/featureFlags.ts'
const readinessPath = 'gravity-mvp/src/lib/ai/knowledge/readiness.ts'
const publicPath = 'gravity-mvp/src/modules/ai-knowledge/public/v1/knowledge-operational-status.ts'
const consumers = [
    'gravity-mvp/src/app/settings/ai/actions.ts',
    'gravity-mvp/src/modules/messaging/internal/ai-reply-pipeline/ContextBuilder.ts',
]

assert.equal(sha256(read(flagPath)), '638ba5a51793ff6ecd7cd4e049b8fb83d006c6cf6b4e0c6f8b3b5c33ee204f82')
assert.equal(sha256(read(readinessPath)), '914da04db2e4c5a59a852ac9e9a8fa3c0dd841bccab6a6f1b8365124bb0d5ea4')

const publicSource = read(publicPath)
assert.match(publicSource, /import 'server-only'/)
for (const capability of [
    'isKnowledgeShadowModeEnabledV1',
    'isKnowledgeRuntimeEnabledV1',
    'getKnowledgeRuntimeModeV1',
    'getKnowledgeReadinessV1',
]) assert.match(publicSource, new RegExp(`export (?:async )?function ${capability}\\b`))
assert.doesNotMatch(publicSource, /export \*|process\.env|prisma|READINESS_THRESHOLDS|retrieve\(|runExtraction|writeAuditEntry/)

for (const consumer of consumers) {
    const source = read(consumer)
    assert.match(source, /@\/modules\/ai-knowledge\/public\/v1\/knowledge-operational-status/)
    assert.doesNotMatch(source, /@\/lib\/ai\/knowledge\/(?:featureFlags|readiness)/)
}

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/ai_knowledge.json'))
assert(manifest.public_surface.includes('KnowledgeQuery.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    consumers.includes(finding.file)
    && [flagPath, readinessPath, publicPath].includes(finding.details?.target)
)), [])

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const live = new Set(scan.findings.map((finding) => finding.fingerprint))
assert.equal(registry.exceptions.filter((entry) => !live.has(entry.fingerprint)).length, 0)

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    consumers: consumers.length,
    capabilities: 4,
    current_findings: scan.findings.length,
}, null, 2)}\n`)
