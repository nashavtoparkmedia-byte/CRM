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
  'gravity-mvp/src/modules/fleet-operations/public/v1/client-ui/ApiListClient.tsx',
  'gravity-mvp/src/app/api/webhook/telegram/route.ts',
  'gravity-mvp/src/app/drivers/[id]/page.tsx',
  'gravity-mvp/src/app/logs/page.tsx',
  'gravity-mvp/src/app/settings/api/page.tsx',
  'gravity-mvp/src/app/settings/integrations/telegram/TelegramManualLinkClient.tsx',
]

const apiSettingsPage = read('gravity-mvp/src/app/settings/api/page.tsx')
assert.match(apiSettingsPage, /@\/modules\/fleet-operations\/public\/v1\/client-ui\/ApiListClient/)
assert.doesNotMatch(apiSettingsPage, /\.\.\/\.\.\/ApiListClient/)
const apiClient = read(consumers[0])
assert.equal(sha256(apiClient), '160bd1468acf4712d90f9b9f6f4bbef3ef3de0b670f0b1c668858874cf90309c')
assert.deepEqual([...apiClient.matchAll(/export\s+default\s+function\s+(\w+)/g)].map((match) => match[1]), ['ApiListClient'])
assert.doesNotMatch(apiClient, /conn\.apiKey\b|from ["']@prisma\/client["']|export \*/)
const unrelatedClientProbe = `${apiClient}\nexport function RawApiCredentialEditor() { return null }\n`
assert.notEqual([...unrelatedClientProbe.matchAll(/export\s+(?:default\s+)?function\s+(\w+)/g)].map((match) => match[1]).join(','), 'ApiListClient')

for (const consumer of consumers) {
  const source = read(consumer)
  assert.doesNotMatch(source, /@\/app\/actions/)
  assert.match(source, /@\/modules\/fleet-operations\/public\/v1\/yandex-fleet-operations/)
}

const shim = read('gravity-mvp/src/app/actions.ts')
assert.match(shim, /@\/modules\/fleet-operations\/public\/v1\/yandex-fleet-operations/)
assert.doesNotMatch(shim, /export \*|@\/lib\/prisma|getYandexConnectionCredentialsV1|fetch\(/)

const capability = read('gravity-mvp/src/modules/fleet-operations/public/v1/yandex-fleet-operations.ts')
assert.match(capability, /^'use server'/)
assert.match(capability, /requireIntegrationAdminAccess/)
assert.match(capability, /getYandexConnectionCredentialsV1/)
assert.doesNotMatch(capability, /prisma\.apiConnection\.(?:create|update|delete)|prisma\.apiLog\.(?:create|deleteMany)/)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/fleet_operations.json'))
assert(manifest.public_surface.includes('YandexFleetOperations.v1'))
assert(manifest.public_surface.includes('ApiConnectionClientUi.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) =>
  consumers.includes(finding.file)
  && (finding.details?.target === 'gravity-mvp/src/app/actions.ts'
    || finding.details?.target?.endsWith('/modules/fleet-operations/public/v1/yandex-fleet-operations.ts'))), [])

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
