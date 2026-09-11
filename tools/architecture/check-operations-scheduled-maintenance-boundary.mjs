#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPaths = [
    'gravity-mvp/src/lib/IntegrityChecker.ts',
    'gravity-mvp/src/lib/stability-check.ts',
]
const implementationHashes = [
    'e7f9c78b0ea4f374da601c443545025e832df901ef58cb4a34da9ac0173d79cb',
    '8335fce2da09d9c6666ec6c7618849e2813170547cd27dfb47eec940e127e344',
]
const retentionPath = 'gravity-mvp/src/lib/RetentionCleanup.ts'
const publicPath = 'gravity-mvp/src/modules/operations-observability/public/v1/scheduled-maintenance-operations.ts'
const consumerPath = 'gravity-mvp/src/instrumentation.ts'
const exactFunctions = [
    'runDailyOperationalStabilityCheckV1',
    'runOperationalIntegrityCheckV1',
    'runScheduledRetentionCleanupV1',
]

implementationPaths.forEach((file, index) => assert.equal(sha256(read(file)), implementationHashes[index]))

// The retention sweep is the dangerous half of this surface: it runs unattended
// on a schedule and deletes production data. A whole-file digest only proved the
// bytes had not moved, which says nothing about why the file is dangerous and
// goes stale on any unrelated edit. These assertions pin the invariants that
// actually protect the data instead.
const assertRetentionSafety = (source) => {
    // Every destructive phase returns before deleting when asked for a dry run,
    // and the archived-contact sweep stays bounded by an explicit batch limit.
    assert.equal((source.match(/if \(dryRun \|\| rows\.length === 0\) return rows\.length/gu) || []).length, 3)
    assert.match(source, /if \(!dryRun\) \{/u)
    assert.match(source, /_cleanupArchivedContacts\(365, 50, dryRun\)/u)
    // Deletion is owner-capability work. Raw persistence here stays read-only:
    // no raw execute, no bulk delete, no direct model delete.
    assert.doesNotMatch(source, /\$executeRaw|deleteMany|prisma\.[A-Za-z]+\.delete\b/u)
    assert.equal((source.match(/prisma\.\$queryRaw/gu) || []).length, 5)
    for (const capability of [
        'deleteContactForRetentionV1',
        'deleteRetainedMessagesV1',
        'purgeMessageRetryMetadataV1',
        'detachContactConversationsV1',
    ]) {
        assert.equal(source.includes(capability), true, `retention capability missing: ${capability}`)
    }
}
const retentionSource = read(retentionPath)
assertRetentionSafety(retentionSource)
// A real violation of each invariant must be rejected.
assert.throws(() => assertRetentionSafety(
    retentionSource.replace('if (dryRun || rows.length === 0) return rows.length', 'if (rows.length === 0) return rows.length'),
))
assert.throws(() => assertRetentionSafety(retentionSource.replace('prisma.$queryRaw', 'prisma.$executeRaw')))
assert.throws(() => assertRetentionSafety(retentionSource.replace('deleteContactForRetentionV1', 'prisma.contact.deleteMany')))
assert.throws(() => assertRetentionSafety(retentionSource.replace('_cleanupArchivedContacts(365, 50, dryRun)', '_cleanupArchivedContacts(365, 5000, dryRun)')))

function exportedFunctions(source) {
    return [...source.matchAll(/export\s+async\s+function\s+(\w+)\s*\(([^)]*)\)/g)]
        .map((match) => ({ name: match[1], parameters: match[2].trim() }))
        .sort((left, right) => left.name.localeCompare(right.name))
}

function hasExactCapabilitySurface(source) {
    const functions = exportedFunctions(source)
    return JSON.stringify(functions.map(({ name }) => name)) === JSON.stringify([...exactFunctions].sort())
        && functions.every(({ parameters }) => parameters === '')
        && !/export\s+(?:class|const|let|var)\b/.test(source)
}

const publicSource = read(publicPath)
assert.equal(hasExactCapabilitySurface(publicSource), true)
assert.match(publicSource, /IntegrityChecker\.runAll\(\)/)
assert.match(publicSource, /RetentionCleanup\.runAll\(process\.env\.RETENTION_DRY_RUN === 'true'\)/)
assert.match(publicSource, /runStabilityCheck\('daily'\)/)
assert.equal((publicSource.match(/process\.env\./g) || []).length, 1)
assert.doesNotMatch(publicSource, /export \*|\$queryRaw|\$executeRaw|prisma|scope\s*:|dryRun\s*:|tableName|rawSql/)

// Negative property for the approved retention writer: widening this exact
// no-input surface with any unrelated write operation fails enforcement.
const unrelatedWriteProbe = `${publicSource}\nexport async function purgeUnrelatedBusinessDataV1() { return true }\n`
assert.equal(hasExactCapabilitySurface(unrelatedWriteProbe), false)

const consumerSource = read(consumerPath)
assert.equal((consumerSource.match(/@\/modules\/operations-observability\/public\/v1\/scheduled-maintenance-operations/g) || []).length, 5)
assert.doesNotMatch(consumerSource, /@\/lib\/(?:IntegrityChecker|RetentionCleanup|stability-check)/)
assert.doesNotMatch(consumerSource, /(?:IntegrityChecker|RetentionCleanup)\.runAll|runStabilityCheck\(|RETENTION_DRY_RUN/)
for (const capability of exactFunctions) assert.match(consumerSource, new RegExp(`${capability}\\(\\)`))

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/operations_observability.json'))
assert(manifest.public_surface.includes('ScheduledMaintenanceOperations.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    finding.file === consumerPath
    && [...implementationPaths, publicPath].includes(finding.details?.target)
)), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    consumers: 1,
    capabilities: exactFunctions.length,
    negative_unrelated_write_probe: 'REJECTED',
    retention_safety_probes: 4,
    negative_retention_safety_probes: 'REJECTED',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
