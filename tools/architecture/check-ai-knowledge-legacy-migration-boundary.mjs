#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPath = 'gravity-mvp/src/lib/ai/knowledge/legacyMigration.ts'
const publicPath = 'gravity-mvp/src/modules/ai-knowledge/public/v1/knowledge-legacy-migration.ts'
const consumerPath = 'gravity-mvp/src/app/settings/ai/actions.ts'
const exactFunctions = [
    'executeKnowledgeLegacyMigrationV1',
    'previewKnowledgeLegacyMigrationV1',
].sort()

assert.equal(sha256(read(implementationPath)), '3871ca5a8a2abaa4571e098195e2f128dab770c9084e8aa23e8c7c0d63388d80')

function exportedFunctions(source) {
    return [...source.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((match) => match[1]).sort()
}

function hasExactCapabilitySurface(source) {
    return JSON.stringify(exportedFunctions(source)) === JSON.stringify(exactFunctions)
        && !/export\s+(?:class|const|let|var)\b/.test(source)
}

const publicSource = read(publicPath)
assert.equal(hasExactCapabilitySurface(publicSource), true)
assert.match(publicSource, /previewKnowledgeLegacyMigrationV1\(\)[\s\S]*?return getLegacyMigrationPreviewCore\(\)/)
assert.match(publicSource, /executeKnowledgeLegacyMigrationV1\(\s*actorId: string,[\s\S]*?return migrateLegacyKnowledgeBaseCore\(actorId\)/)
assert.doesNotMatch(publicSource, /LEGACY_CATEGORY_MAP|export \*|@\/lib\/prisma|\bprisma\.|\$queryRaw|\$executeRaw|writeAuditEntry|snapshotItem|tableName|rawSql/)

const unrelatedWriteProbe = `${publicSource}\nexport async function deleteLegacyKnowledgeV1() { return true }\n`
assert.equal(hasExactCapabilitySurface(unrelatedWriteProbe), false)

const consumerSource = read(consumerPath)
assert.match(consumerSource, /@\/modules\/ai-knowledge\/public\/v1\/knowledge-legacy-migration/)
assert.doesNotMatch(consumerSource, /@\/lib\/ai\/knowledge\/legacyMigration/)
assert.match(consumerSource, /previewKnowledgeLegacyMigrationV1 as getLegacyMigrationPreviewCore/)
assert.match(consumerSource, /executeKnowledgeLegacyMigrationV1 as migrateLegacyKnowledgeBaseCore/)

const previewStart = consumerSource.indexOf('export async function getLegacyMigrationPreview')
const previewEnd = consumerSource.indexOf('// ─── AI Knowledge Core bulk governance', previewStart)
const preview = consumerSource.slice(previewStart, previewEnd)
assert(preview.indexOf('await assertCanEditAi()') < preview.indexOf('getLegacyMigrationPreviewCore()'))

const executeStart = consumerSource.indexOf('export async function migrateLegacyKnowledgeBase')
const executeEnd = consumerSource.indexOf('// ─── AI Knowledge Core channel connections', executeStart)
const execute = consumerSource.slice(executeStart, executeEnd)
assert(execute.indexOf('await requireAdminUserId()') < execute.indexOf('migrateLegacyKnowledgeBaseCore(actor)'))
assert(execute.indexOf('migrateLegacyKnowledgeBaseCore(actor)') < execute.indexOf("if (result.migrated > 0) revalidatePath('/settings/ai')"))

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/ai_knowledge.json'))
assert(manifest.public_surface.includes('KnowledgeLegacyMigration.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    finding.file === consumerPath
    && [implementationPath, publicPath].includes(finding.details?.target)
)), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    consumers: 1,
    capabilities: exactFunctions.length,
    negative_unrelated_write_probe: 'REJECTED',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
