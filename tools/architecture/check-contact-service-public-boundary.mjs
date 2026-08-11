#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const consumers = [
  'gravity-mvp/src/app/api/messages/start-chat/route.ts',
  'gravity-mvp/src/app/api/webhook/max/route.ts',
  'gravity-mvp/src/app/api/webhook/telegram/route.ts',
  'gravity-mvp/src/app/api/webhooks/max/route.ts',
  'gravity-mvp/src/app/max-actions.ts',
  'gravity-mvp/src/app/messages/link-chat-actions.ts',
  'gravity-mvp/src/app/settings/integrations/whatsapp/whatsapp-actions.ts',
  'gravity-mvp/src/app/tg-actions.ts',
  'gravity-mvp/src/lib/freeswitch/EslClient.ts',
  'gravity-mvp/src/lib/leads/intake.ts',
  'gravity-mvp/src/lib/whatsapp/WhatsAppService.ts',
]

for (const consumer of consumers) {
  assert.doesNotMatch(read(consumer), /(?:from\s+['\"]@\/lib\/ContactService|import\(['\"]@\/lib\/ContactService)/)
}

const publicIndex = read('gravity-mvp/src/modules/contacts/public/v1/index.ts')
for (const capability of [
  'resolveChannelContactOperationV1',
  'resolveContactByPhoneV1',
  'addPhoneToContactV1',
  'cleanupDanglingContactIdentitiesV1',
]) {
  assert.match(publicIndex, new RegExp(`\\b${capability}\\b`))
}

const owner = read('gravity-mvp/src/modules/contacts/public/v1/contact-identity-maintenance.ts')
assert.doesNotMatch(owner, /@\/lib\/prisma|\$queryRaw|\$executeRaw|export \*|Record<string,\s*unknown>/)
assert.doesNotMatch(owner, /export (?:async )?function (?:execute|query|mutate|write|updateModel|deleteModel)\b/)

const scan = await scanArchitecture(root)
const oldTarget = 'gravity-mvp/src/lib/ContactService.ts'
assert.deepEqual(scan.findings.filter((finding) =>
  consumers.includes(finding.file) && finding.details?.target === oldTarget), [])

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
