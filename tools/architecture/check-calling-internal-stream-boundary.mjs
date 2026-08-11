#!/usr/bin/env node

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const consumers = [
  'gravity-mvp/src/app/api/calls/stream/route.ts',
  'gravity-mvp/src/lib/freeswitch/EslClient.ts',
  'gravity-mvp/src/lib/freeswitch/recordingProcessor.ts',
  'gravity-mvp/src/lib/queue/analyzeWorker.ts',
  'gravity-mvp/src/lib/queue/transcribeWorker.ts',
]

assert.equal(existsSync(path.join(root, 'gravity-mvp/src/lib/callStreamBus.ts')), false)
for (const consumer of consumers) {
  const source = read(consumer)
  assert.doesNotMatch(source, /@\/lib\/callStreamBus/)
  assert.match(source, /@\/modules\/calling\/internal\/call-stream/)
}

const implementation = read('gravity-mvp/src/modules/calling/internal/call-stream.ts')
assert.doesNotMatch(implementation, /@\/lib\/prisma|\$queryRaw|\$executeRaw|export \*/)
assert.match(implementation, /subscribeAllCalls/)
assert.match(implementation, /subscribeCall/)
assert.match(implementation, /broadcastCall/)

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) =>
  consumers.includes(finding.file)
  && (finding.details?.target === 'gravity-mvp/src/lib/callStreamBus.ts'
    || finding.details?.target?.endsWith('/modules/calling/internal/call-stream.ts'))), [])

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
