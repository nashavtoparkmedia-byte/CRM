#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const consumers = [
  'gravity-mvp/src/app/api/channels/check-reachability/route.ts',
  'gravity-mvp/src/app/api/debug-db/force-sync/route.ts',
  'gravity-mvp/src/app/api/debug-db/init-connection/route.ts',
  'gravity-mvp/src/app/api/debug-db/wa-diag/route.ts',
  'gravity-mvp/src/app/api/debug-db/wa-store/route.ts',
  'gravity-mvp/src/app/settings/ai/actions.ts',
  'gravity-mvp/src/instrumentation.ts',
]
for (const consumer of consumers) {
  const source = read(consumer)
  assert.doesNotMatch(source, /@\/lib\/whatsapp\/(?:WhatsAppService|WhatsAppCleanup)/)
}
assert.doesNotMatch(read('gravity-mvp/src/instrumentation.ts'), /@\/lib\/yandexSync/)

const composition = read('gravity-mvp/src/infrastructure/whatsapp/operational-capabilities.ts')
assert.match(composition, /@\/modules\/whatsapp-channel\/public\/v1\/runtime-operations/)
assert.doesNotMatch(composition, /@\/lib\/whatsapp|export \*|\bgetClient\b|\bpupPage\b|window\.Store/)

const owner = read('gravity-mvp/src/modules/whatsapp-channel/public/v1/runtime-operations.ts')
assert.match(owner, /inspectWhatsAppStoreV1/)
assert.match(owner, /readWhatsAppRuntimeConnectionV1/)
assert.doesNotMatch(owner, /export (?:async )?function (?:getClient|getPuppeteerPage|getStore)/)
assert.doesNotMatch(owner, /export \*|export .*\bClient\b|export .*\bPage\b/)

const fleet = read('gravity-mvp/src/modules/fleet-operations/public/v1/yandex-sync-runtime.ts')
assert.match(fleet, /runYandexSync\(\{ bypassCooldown: true \}\)/)
assert.doesNotMatch(fleet, /export \*|options|Record<|\bany\b/)

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const oldTargets = [
  'gravity-mvp/src/lib/whatsapp/WhatsAppCleanup.ts',
  'gravity-mvp/src/lib/whatsapp/WhatsAppService.ts',
  'gravity-mvp/src/lib/yandexSync.ts',
]
assert.equal(registry.exceptions.filter((entry) =>
  consumers.includes(entry.file) && oldTargets.includes(entry.details?.target)).length, 0)

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) =>
  consumers.includes(finding.file) && oldTargets.includes(finding.details?.target)), [])
assert.equal(scan.findings.filter((finding) => finding.rule === 'direct_provider_transport_access').length, 0)

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  consumers: consumers.length,
  provider_accesses: 0,
  current_findings: scan.findings.length,
  registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
