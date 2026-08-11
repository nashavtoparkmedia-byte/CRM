#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const consumers = [
  'gravity-mvp/src/app/api/ai-calls/dev-simulate/route.ts',
  'gravity-mvp/src/app/api/ai-calls/mock/route.ts',
  'gravity-mvp/src/app/api/ai-calls/sessions/[id]/finalize/route.ts',
  'gravity-mvp/src/app/api/ai-calls/sessions/[id]/state/route.ts',
  'gravity-mvp/src/app/api/ai-calls/start/route.ts',
  'gravity-mvp/src/app/api/calls/cancel/route.ts',
  'gravity-mvp/src/app/api/calls/originate/route.ts',
  'gravity-mvp/src/lib/freeswitch/EslClient.ts',
  'gravity-mvp/src/lib/freeswitch/recordingProcessor.ts',
  'gravity-mvp/src/lib/queue/analyzeWorker.ts',
  'gravity-mvp/src/lib/queue/connection.ts',
  'gravity-mvp/src/lib/queue/index.ts',
  'gravity-mvp/src/lib/queue/transcribeWorker.ts',
]
const exactImport = "from '@/infrastructure/operations/operational-log'"
for (const consumer of consumers) {
  const source = read(consumer)
  assert.match(source, new RegExp(exactImport.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(source, /from ['"]@\/lib\/opsLog['"]/)
}

const capability = read('gravity-mvp/src/infrastructure/operations/operational-log.ts')
assert.match(capability, /export function operationalLogV1\(/)
assert.doesNotMatch(capability, /^import\s/m)
assert.doesNotMatch(capability, /export\s+(?:async\s+)?(?:function|const|class)\s+(?:register|inject|setSink|\w*Transport)|fetch\(|axios|prisma/i)

assert.doesNotMatch(
  read('gravity-mvp/src/modules/operations-observability/public/v1/index.ts'),
  /operationalLog|operational-log/,
)

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
assert.equal(registry.exceptions.filter((entry) =>
  entry.owner_context === 'calling' && entry.target_context === 'operations_observability').length, 0)

const scan = await scanArchitecture(root)
const boundaryFindings = scan.findings.filter((finding) =>
  consumers.includes(finding.file) && finding.target_context === 'operations_observability')
assert.deepEqual(boundaryFindings, [])

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  consumers: consumers.length,
  closed_findings: 26,
  current_findings: scan.findings.length,
  registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
