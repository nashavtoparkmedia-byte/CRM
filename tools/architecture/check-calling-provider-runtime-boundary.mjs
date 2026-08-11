#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const consumers = [
  'gravity-mvp/src/app/api/admin/reprocess-recordings/route.ts',
  'gravity-mvp/src/app/api/settings/telephony-status/route.ts',
  'gravity-mvp/src/instrumentation.ts',
]
for (const consumer of consumers) {
  const source = read(consumer)
  assert.doesNotMatch(source, /@\/lib\/freeswitch\/(?:EslClient|recordingProcessor)|@\/lib\/queue(?:\/queues)?['"]/)
}
assert.match(read(consumers[0]), /@\/modules\/calling\/public\/v1\/recording-recovery/)
assert.match(read(consumers[1]), /@\/modules\/calling\/public\/v1\/telephony-provider-health/)
assert.match(read(consumers[2]), /@\/modules\/calling\/public\/v1\/runtime-startup/)

const health = read('gravity-mvp/src/modules/calling/public/v1/telephony-provider-health.ts')
assert.match(health, /sofia status gateway megafon/)
assert.doesNotMatch(health, /export[^\n]*(?:getEslConnection|connection|command)/i)
const runtime = read('gravity-mvp/src/modules/calling/public/v1/runtime-startup.ts')
assert.doesNotMatch(runtime, /export \*|getEslConnection|originate|cancel/)

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
assert.equal(registry.exceptions.filter((entry) =>
  consumers.includes(entry.file) && entry.target_context === 'calling' &&
  !entry.subject.includes('init-proxy')).length, 0)

const scan = await scanArchitecture(root)
const boundaryFindings = scan.findings.filter((finding) =>
  consumers.includes(finding.file) && finding.target_context === 'calling' &&
  !finding.subject.includes('init-proxy'))
assert.deepEqual(boundaryFindings, [])
process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  consumers: consumers.length,
  closed_findings: 15,
  current_findings: scan.findings.length,
  registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
