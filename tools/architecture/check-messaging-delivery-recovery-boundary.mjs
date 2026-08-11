#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPath = 'gravity-mvp/src/lib/MessageService.ts'
const publicPath = 'gravity-mvp/src/modules/messaging/public/v1/delivery-recovery-operations.ts'
const consumerPath = 'gravity-mvp/src/instrumentation.ts'
const exactFunctions = [
    'recoverStuckMessagingDeliveriesV1',
    'retryEligibleMessagingDeliveriesV1',
]

assert.equal(sha256(read(implementationPath)), '3f44cad615f3a41e9d363ba6c3564aaf2a60af365aff63b8941677df11418e12')

function exportedFunctions(source) {
    return [...source.matchAll(/export\s+async\s+function\s+(\w+)/g)]
        .map((match) => match[1])
        .sort()
}

function hasExactCapabilitySurface(source) {
    return JSON.stringify(exportedFunctions(source)) === JSON.stringify([...exactFunctions].sort())
        && !/export\s+(?:class|const|let|var)\b/.test(source)
}

const publicSource = read(publicPath)
assert.equal(hasExactCapabilitySurface(publicSource), true)
assert.match(publicSource, /const STUCK_MESSAGE_AGE_MINUTES_V1 = 5/)
assert.match(publicSource, /MessageService\.recoverStuckMessages\(STUCK_MESSAGE_AGE_MINUTES_V1\)/)
for (const policy of [
    "status = 'failed'",
    "direction = 'outbound'",
    "metadata->>'retryable'",
    "metadata->>'retryAttempt'",
    "metadata->>'maxRetries'",
    "INTERVAL '24 hours'",
    'ORDER BY "sentAt" ASC',
    'LIMIT 10',
]) assert.match(publicSource, new RegExp(policy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
assert.match(publicSource, /result\.error !== 'Backoff not elapsed'/)
assert.doesNotMatch(publicSource, /\$executeRaw|\$queryRawUnsafe|\b(?:INSERT|UPDATE|DELETE|UPSERT|TRUNCATE)\b|tableName|whereClause|rawSql/)
assert.doesNotMatch(publicSource, /export \*|export \{[^}]*MessageService|messageId\s*:/)

// Negative enforcement property: an unrelated exported operation makes this
// otherwise-approved writer surface invalid.
const unrelatedWriteProbe = `${publicSource}\nexport async function deleteUnrelatedContactV1() { return true }\n`
assert.equal(hasExactCapabilitySurface(unrelatedWriteProbe), false)

const consumerSource = read(consumerPath)
assert.equal((consumerSource.match(/@\/modules\/messaging\/public\/v1\/delivery-recovery-operations/g) || []).length, 3)
assert.doesNotMatch(consumerSource, /@\/lib\/MessageService/)
assert.doesNotMatch(consumerSource, /SELECT id FROM "Message"|MessageService\.(?:recoverStuckMessages|retrySend)/)
assert.match(consumerSource, /recoverStuckMessagingDeliveriesV1\(\)/)
assert.match(consumerSource, /retryEligibleMessagingDeliveriesV1\(\)/)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/messaging.json'))
assert(manifest.public_surface.includes('DeliveryRecoveryOperations.v1'))

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
