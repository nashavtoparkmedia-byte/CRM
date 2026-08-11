#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const consumers = [
  'gravity-mvp/src/app/api/monitoring/attention/route.ts',
  'gravity-mvp/src/app/api/monitoring/drivers/[id]/event/route.ts',
  'gravity-mvp/src/app/api/monitoring/drivers/[id]/events/route.ts',
  'gravity-mvp/src/app/api/monitoring/drivers/[id]/fleet-check/route.ts',
  'gravity-mvp/src/app/api/monitoring/drivers/route.ts',
  'gravity-mvp/src/app/drivers/archive/ArchiveClient.tsx',
  'gravity-mvp/src/app/monitoring/components/AllDriversSection.tsx',
  'gravity-mvp/src/app/monitoring/components/AttentionSection.tsx',
  'gravity-mvp/src/app/monitoring/components/DriverHoverCard.tsx',
  'gravity-mvp/src/app/monitoring/components/HistoryIcons.tsx',
]
for (const consumer of consumers) {
  const source = read(consumer)
  assert.doesNotMatch(source, /@\/app\/monitoring\/lib\/constants/)
  assert.match(source, /@\/modules\/fleet-operations\/public\/v1\/monitoring-policy/)
}

const shim = read('gravity-mvp/src/app/monitoring/lib/constants.ts')
assert.match(shim, /@\/modules\/fleet-operations\/public\/v1\/monitoring-policy/)
assert.doesNotMatch(shim, /export \*/)

const policy = read('gravity-mvp/src/modules/fleet-operations/public/v1/monitoring-policy.ts')
assert.doesNotMatch(policy, /@\/lib\/prisma|export \*|\$queryRaw|\$executeRaw/)

const scan = await scanArchitecture(root)
const oldTarget = 'gravity-mvp/src/app/monitoring/lib/constants.ts'
assert.deepEqual(scan.findings.filter((finding) => finding.details?.target === oldTarget), [])
assert.deepEqual(scan.findings.filter((finding) =>
  consumers.includes(finding.file) && finding.details?.target?.endsWith('/monitoring-policy.ts')), [])

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const live = new Set(scan.findings.map((finding) => finding.fingerprint))
assert.equal(registry.exceptions.filter((entry) =>
  consumers.includes(entry.file) && !live.has(entry.fingerprint)).length, 0)

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  consumers: consumers.length,
  current_findings: scan.findings.length,
  registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
