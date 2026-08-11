#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const consumers = [
  'gravity-mvp/src/app/drivers/DriversClient.tsx',
  'gravity-mvp/src/app/drivers/[id]/page.tsx',
  'gravity-mvp/src/app/drivers/cards/CardsClient.tsx',
]
for (const consumer of consumers) {
  const source = read(consumer)
  assert.match(source, /@\/infrastructure\/fleet\/driver-max-messaging/)
  assert.doesNotMatch(source, /(?:\.\.\/)*max-actions|@\/app\/max-actions/)
}
const composition = read('gravity-mvp/src/infrastructure/fleet/driver-max-messaging.ts')
assert.match(composition, /^"use server"/)
assert.match(composition, /export async function listMaxDriverDeliveryConnectionsV1/)
assert.match(composition, /export async function sendMaxDriverMessageV1/)
assert.doesNotMatch(composition, /export \*|Record<|\bany\b|execute|invoke/)
assert.match(composition, /@\/modules\/max-channel\/public\/v1\/driver-messaging-capability/)
assert.doesNotMatch(composition, /@\/app\/max-actions/)
const ownerCapability = read('gravity-mvp/src/modules/max-channel/public/v1/driver-messaging-capability.ts')
assert.doesNotMatch(ownerCapability, /export \*|Record<|\bany\b|execute|invoke/)

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
assert.equal(registry.exceptions.filter((entry) =>
  consumers.includes(entry.file) && entry.target_context === 'max_channel').length, 0)
const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) =>
  consumers.includes(finding.file) && finding.target_context === 'max_channel'), [])
process.stdout.write(`${JSON.stringify({
  status: 'PASS', consumers: consumers.length, closed_findings: 12,
  current_findings: scan.findings.length, registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
