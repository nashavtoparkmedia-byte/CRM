#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const consumers = [
  'gravity-mvp/src/app/api/monitoring/guardrails/route.ts',
  'gravity-mvp/src/app/monitoring/system-health/actions.ts',
  'gravity-mvp/src/instrumentation.ts',
]

for (const consumer of consumers) {
  const source = read(consumer)
  assert.doesNotMatch(source, /@\/lib\/config-validator/)
  assert.match(source, /@\/modules\/configuration\/public\/v1\/operational-configuration-health/)
}

const capability = read('gravity-mvp/src/modules/configuration/public/v1/operational-configuration-health.ts')
assert.match(capability, /from '@\/lib\/config-validator'/)
assert.doesNotMatch(capability, /registerConfigRule|registerAllConfigs|logConfigChange|KNOWN_CRON_SCHEDULES/)
assert.doesNotMatch(capability, /@\/lib\/prisma|\$queryRaw|\$executeRaw|export \*/)

const configurationManifest = JSON.parse(read('architecture/contexts/v1/manifests/configuration.json'))
const operationsManifest = JSON.parse(read('architecture/contexts/v1/manifests/operations_observability.json'))
assert(configurationManifest.public_surface.includes('OperationalConfigurationHealth.v1'))
assert(operationsManifest.allowed_dependencies.some((dependency) =>
  dependency.context === 'configuration' && dependency.surface === 'configuration.public'))

const scan = await scanArchitecture(root)
const oldTarget = 'gravity-mvp/src/lib/config-validator.ts'
assert.deepEqual(scan.findings.filter((finding) =>
  consumers.includes(finding.file) && finding.details?.target === oldTarget), [])
assert.deepEqual(scan.findings.filter((finding) =>
  consumers.includes(finding.file) && finding.details?.target?.endsWith('/operational-configuration-health.ts')), [])

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
