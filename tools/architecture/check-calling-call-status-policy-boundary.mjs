#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPath = 'gravity-mvp/src/lib/calls/status.ts'
const publicPath = 'gravity-mvp/src/modules/calling/public/v1/call-status-policy.ts'
const consumers = [
    'gravity-mvp/src/app/messages/components/CallDetailDrawer.tsx',
    'gravity-mvp/src/app/messages/components/MessageFeed.tsx',
]

assert.equal(sha256(read(implementationPath)), 'e8d016cd54cd9988fe0aca7b84fe94cc5fec14b38c6dc801d4c13eb7f568ec3d')

const publicSource = read(publicPath)
for (const symbol of [
    'callStatusColor',
    'callStatusIcon',
    'callStatusLabel',
    'CallDirection',
    'CallStatusColor',
    'CallStatusIcon',
    'CallStatusValue',
]) assert.match(publicSource, new RegExp(`\\b${symbol}\\b`))
assert.doesNotMatch(publicSource, /export \*|mapHangupCauseToStatus/)

for (const consumer of consumers) {
    const source = read(consumer)
    assert.match(source, /@\/modules\/calling\/public\/v1\/call-status-policy/)
    assert.doesNotMatch(source, /@\/lib\/calls\/status/)
}

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/calling.json'))
assert(manifest.public_surface.includes('CallStatusPolicy.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    consumers.includes(finding.file)
    && (finding.details?.target === implementationPath || finding.details?.target === publicPath)
)), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    consumers: consumers.length,
    implementation_sha256: sha256(read(implementationPath)),
    current_findings: scan.findings.length,
}, null, 2)}\n`)
