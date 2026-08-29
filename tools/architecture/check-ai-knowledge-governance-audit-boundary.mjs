#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPath = 'gravity-mvp/src/lib/ai/knowledge/auditLog.ts'
const publicPath = 'gravity-mvp/src/modules/ai-knowledge/public/v1/knowledge-governance-audit.ts'
const consumers = [
    'gravity-mvp/src/app/messages/proposed-reply-actions.ts',
    'gravity-mvp/src/app/settings/ai/actions.ts',
]
const exactFunctions = [
    'appendKnowledgeGovernanceAuditV1',
    'listKnowledgeGovernanceAuditV1',
    'snapshotKnowledgeGovernanceItemV1',
].sort()

assert.equal(sha256(read(implementationPath)), '1ebd521e7c9182902e9905eea63be04869cf328e999dbd9d34a288bc444363dd')

function exportedFunctions(source) {
    return [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((match) => match[1]).sort()
}

function hasExactCapabilitySurface(source) {
    return JSON.stringify(exportedFunctions(source)) === JSON.stringify(exactFunctions)
        && !/export\s+(?:class|const|let|var)\b/.test(source)
}

const publicSource = read(publicPath)
assert.equal(hasExactCapabilitySurface(publicSource), true)
assert.match(publicSource, /appendKnowledgeGovernanceAuditV1[\s\S]*?return writeAuditEntry\(input\)/)
assert.match(publicSource, /snapshotKnowledgeGovernanceItemV1[\s\S]*?return snapshotItem\(row\)/)
assert.match(publicSource, /limit = 50[\s\S]*?return getKnowledgeAuditLog\(itemId, limit\)/)
assert.doesNotMatch(publicSource, /export \*|@\/lib\/prisma|\bprisma\.|\$queryRaw|\$executeRaw|RawUnsafe|tableName|rawSql/)

// The approved append-only audit writer cannot acquire an unrelated write
// capability while continuing to pass this exact-surface enforcement.
const unrelatedWriteProbe = `${publicSource}\nexport async function archiveUnrelatedMessageV1() { return true }\n`
assert.equal(hasExactCapabilitySurface(unrelatedWriteProbe), false)

const messages = read(consumers[0])
const settings = read(consumers[1])
for (const source of [messages, settings]) {
    assert.match(source, /@\/modules\/ai-knowledge\/public\/v1\/knowledge-governance-audit/)
    assert.doesNotMatch(source, /@\/lib\/ai\/knowledge\/auditLog/)
}
assert.match(messages, /appendKnowledgeGovernanceAuditV1 as writeAuditEntry/)
assert.match(settings, /appendKnowledgeGovernanceAuditV1 as writeAuditEntry/)
assert.match(settings, /snapshotKnowledgeGovernanceItemV1 as snapshotItem/)
assert.match(settings, /listKnowledgeGovernanceAuditV1 as getAuditLogRaw/)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/ai_knowledge.json'))
assert(manifest.public_surface.includes('KnowledgeGovernanceAudit.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    consumers.includes(finding.file)
    && [implementationPath, publicPath].includes(finding.details?.target)
)), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    consumers: consumers.length,
    capabilities: exactFunctions.length,
    negative_unrelated_write_probe: 'REJECTED',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
