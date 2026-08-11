#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const consumers = [
  'gravity-mvp/src/app/settings/integrations/max/MaxLoginClient.tsx',
  'gravity-mvp/src/app/settings/integrations/telegram/TelegramLoginClient.tsx',
  'gravity-mvp/src/app/settings/integrations/whatsapp/WhatsAppDashboard.tsx',
]

for (const consumer of consumers) {
  const source = read(consumer)
  assert.match(source, /@\/modules\/messaging\/public\/v1\/client-ui\/channel-sync-block/)
  assert.doesNotMatch(source, /@\/components\/ChannelSyncBlock/)
}

const shim = read('gravity-mvp/src/components/ChannelSyncBlock.tsx')
assert.match(shim, /@\/modules\/messaging\/public\/v1\/client-ui\/channel-sync-block/)
assert.doesNotMatch(shim, /export \*/)

const client = read('gravity-mvp/src/modules/messaging/public/v1/client-ui/channel-sync-block.tsx')
assert.equal(sha256(client), '0467276623621db19662b3b8071c5a978d3b6331415aeb4b8ceb917674dfdadb')
assert.match(client, /@\/modules\/messaging\/public\/v1\/channel-sync-operations/)
assert.doesNotMatch(client, /@\/app\/settings\/ai\/actions/)
for (const behavior of [
  'getAllImportJobs(20)',
  'getConnectionTotalsForUi(effectiveDbConnId)',
  'getAllImportJobs(5)',
  'createImportJob({ channels: [channel], mode, daysBack:',
  'cancelImportJob(lastJob.id)',
  "setInterval(async () =>",
]) assert(client.includes(behavior), `missing client behavior: ${behavior}`)

const operations = read('gravity-mvp/src/modules/messaging/public/v1/channel-sync-operations.ts')
assert.equal(sha256(operations), 'e99f9b0b26df5f1201154805d698ce0e0d7fb4f702633e5c30cd89bf624b635b')
assert.doesNotMatch(operations, /prisma\.[a-zA-Z]+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/)
assert.doesNotMatch(operations, /\$executeRaw|\$transaction/)
assert.match(operations, /queueHistoryImportJobV1\(\{ contract: QUEUE_HISTORY_IMPORT_JOB_COMMAND_V1/)
assert.match(operations, /cancelHistoryImportJobV1\(\{ contract: CANCEL_HISTORY_IMPORT_JOB_COMMAND_V1/)
assert.match(operations, /deleteHistoryImportJobV1\(\{ contract: DELETE_HISTORY_IMPORT_JOB_COMMAND_V1/)
assert.equal((operations.match(/requireIntegrationAdminAccess\(\)/g) || []).length, 3)
assert.doesNotMatch(operations, /apiKey|Encrypted|password|secret/i)

const compatibility = read('gravity-mvp/src/app/settings/ai/actions.ts')
for (const delegation of [
  'return getOwnedLastImportJob()',
  'return getOwnedImportJobs(limit)',
  'return createOwnedImportJob(data)',
  'return cancelOwnedImportJob(id)',
  'return deleteOwnedImportJob(id)',
  'return getOwnedConnectionTotalsForUi(connectionId)',
]) assert(compatibility.includes(delegation), `missing compatibility delegation: ${delegation}`)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/messaging.json'))
assert(manifest.public_surface.includes('ChannelSyncClient.v1'))
assert(manifest.public_surface.includes('ChannelSyncOperations.v1'))
assert(manifest.credential_relationships.environment_names.includes('NEXTAUTH_URL'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) =>
  finding.details?.target === 'gravity-mvp/src/components/ChannelSyncBlock.tsx'
  || finding.details?.target === 'gravity-mvp/src/app/settings/ai/actions.ts'
    && finding.file === 'gravity-mvp/src/components/ChannelSyncBlock.tsx'), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const live = new Set(scan.findings.map((finding) => finding.fingerprint))
assert.equal(registry.exceptions.filter((entry) => !live.has(entry.fingerprint)).length, 0)

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  consumers: consumers.length,
  client_sha256: sha256(client),
  operations_sha256: sha256(operations),
  current_findings: scan.findings.length,
  registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
