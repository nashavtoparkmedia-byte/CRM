#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPath = 'gravity-mvp/src/lib/ai/knowledge/queries.ts'
const publicPath = 'gravity-mvp/src/modules/ai-knowledge/public/v1/knowledge-admin-read-model.ts'
const sourceAccessPath = 'gravity-mvp/src/modules/ai-knowledge/public/v1/knowledge-source-access.ts'
const consumerPath = 'gravity-mvp/src/app/settings/ai/actions.ts'

assert.equal(sha256(read(implementationPath)), '2da95a6a5bb9bb4acee386a981d1541595ffcb58343b03d5866a1e99d860eb23')

const publicSource = read(publicPath)
assert.match(publicSource, /import 'server-only'/)
for (const capability of [
    'listKnowledgeSectionsV1',
    'listKnowledgeItemsBySectionV1',
    'getKnowledgeItemForControlCenterV1',
    'getKnowledgeStatsV1',
    'listKnowledgeExtractionJobsV1',
    'getKnowledgeItemSourceBadgesV1',
]) assert.match(publicSource, new RegExp(`export async function ${capability}\\b`))
assert.match(publicSource, /projectKnowledgeItemSourceAccessV1\(full, access\)/)
assert.doesNotMatch(publicSource, /export \*|prisma|writeAuditEntry|runExtraction|retrieve\(|provider|credential/)

const sourceAccess = read(sourceAccessPath)
assert.match(sourceAccess, /access\.includeSourceExcerpts === true/)
assert.match(sourceAccess, /: \{ item: full\.item, sources: \[\] \}/)
assert.doesNotMatch(sourceAccess, /prisma|fetch\(|provider|credential/)

const consumer = read(consumerPath)
assert.match(consumer, /@\/modules\/ai-knowledge\/public\/v1\/knowledge-admin-read-model/)
assert.doesNotMatch(consumer, /@\/lib\/ai\/knowledge\/queries/)
assert.match(consumer, /const allowed = await canViewKnowledgeSources\(\)/)
assert.match(consumer, /includeSourceExcerpts: allowed/)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/ai_knowledge.json'))
assert(manifest.public_surface.includes('KnowledgeQuery.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    finding.file === consumerPath
    && (finding.details?.target === implementationPath || finding.details?.target === publicPath)
)), [])

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const live = new Set(scan.findings.map((finding) => finding.fingerprint))
assert.equal(registry.exceptions.filter((entry) => !live.has(entry.fingerprint)).length, 0)

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    read_capabilities: 6,
    source_excerpts_default: 'REDACTED',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
