#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const consumers = [
  'gravity-mvp/src/app/api/channels/check-reachability/route.ts',
  'gravity-mvp/src/app/api/cron/init-telegram/route.ts',
  'gravity-mvp/src/app/api/debug-db/tg-import/route.ts',
  'gravity-mvp/src/app/api/messages/conversations/route.ts',
  'gravity-mvp/src/app/drivers/DriversClient.tsx',
  'gravity-mvp/src/app/drivers/[id]/page.tsx',
  'gravity-mvp/src/app/drivers/[id]/timeline-actions.ts',
  'gravity-mvp/src/app/drivers/cards/CardsClient.tsx',
  'gravity-mvp/src/app/drivers/page.tsx',
  'gravity-mvp/src/app/settings/ai/actions.ts',
  'gravity-mvp/src/instrumentation.ts',
  'gravity-mvp/src/lib/triggers.ts',
]

for (const consumer of consumers) {
  assert.doesNotMatch(read(consumer), /@\/app\/tg-actions/)
}

const composition = read('gravity-mvp/src/infrastructure/telegram/operational-capabilities.ts')
assert.match(composition, /@\/modules\/telegram-channel\/public\/v1\/runtime-operations/)
assert.doesNotMatch(composition, /@\/app\/tg-actions|export \*|\bTelegramClient\b|\bgetClient\b|\binvoke\b/)

const owner = read('gravity-mvp/src/modules/telegram-channel/public/v1/runtime-operations.ts')
for (const capability of [
  'initializeTelegramRuntimeV1',
  'stopTelegramRuntimeV1',
  'sendTelegramTextV1',
  'importTelegramHistoryV1',
  'checkTelegramReachabilityV1',
  'listTelegramConnectionsV1',
]) {
  assert.match(owner, new RegExp(`export async function ${capability}\\b`))
}
assert.doesNotMatch(owner, /export \*|export .*\b(?:TelegramClient|Api|StringSession|CustomFile)\b/)
assert.doesNotMatch(owner, /export async function (?:getClient|invoke|execute|sendMedia|sendReaction)/)

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const oldTarget = 'gravity-mvp/src/app/tg-actions.ts'
assert.equal(registry.exceptions.filter((entry) =>
  consumers.includes(entry.file) && entry.details?.target === oldTarget).length, 0)

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) =>
  consumers.includes(finding.file) && finding.details?.target === oldTarget), [])

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  consumers: consumers.length,
  provider_accesses: scan.findings.filter((finding) => finding.rule === 'direct_provider_transport_access').length,
  current_findings: scan.findings.length,
  registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
