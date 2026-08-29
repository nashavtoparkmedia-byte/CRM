#!/usr/bin/env node

import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, value, detail) => value ? checks.push(name) : failures.push({ check: name, detail })

const contract = read('gravity-mvp/src/contracts/messaging/v1/history-import-job-commands.ts')
const handler = read('gravity-mvp/src/modules/messaging/public/v1/history-import-job-handler.ts')
const adapter = read('gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-history-import-job-adapter.ts')
const owner = read('gravity-mvp/src/modules/messaging/public/v1/channel-sync-operations.ts')
const compatibility = read('gravity-mvp/src/app/settings/ai/actions.ts')
const amendment = JSON.parse(read('architecture/isolation/messaging/configuration-import-jobs-v1/module-manifest-amendments.json'))

const createStart = owner.indexOf('export async function createImportJob')
const create = owner.slice(createStart, owner.indexOf('export async function cancelImportJob', createStart))
const cancelStart = owner.indexOf('export async function cancelImportJob')
const cancel = owner.slice(cancelStart, owner.indexOf('export async function deleteImportJob', cancelStart))
const deleteStart = owner.indexOf('export async function deleteImportJob')
const del = owner.slice(deleteStart, owner.indexOf('export async function getConnectionTotalsForUi', deleteStart))

check('contract neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(contract), 'contract leak')
check('handler neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(handler), 'handler leak')
check(
  'job writes isolated and static',
  (adapter.match(/prisma\.\$executeRawUnsafe\(/g) || []).length === 7
    && !/prisma\.\$executeRaw\s*`/.test(adapter)
    && adapter.includes('INSERT INTO "HistoryImportJob"')
    && adapter.includes('UPDATE "HistoryImportJob" SET status=')
    && adapter.includes('DELETE FROM "HistoryImportJob"')
    && !owner.includes('INSERT INTO "HistoryImportJob"')
    && !owner.includes('UPDATE "HistoryImportJob"')
    && !owner.includes('DELETE FROM "HistoryImportJob"'),
  'foreign or dynamic job write remains',
)
check(
  'create owner prelude retained',
  create.indexOf('requireIntegrationAdminAccess()') < create.indexOf('const id = `job_${Date.now()}`')
    && create.indexOf('const connId = data.connectionId ?? null') < create.indexOf('queueHistoryImportJobV1'),
  'create prelude drift',
)
check('queue mapping retained', create.includes('jobId: id, channels: data.channels, mode: data.mode, daysBack, connectionId: connId'), 'queue mapping drift')
check(
  'queue SQL and binds retained',
  adapter.includes('(id, channels, mode, "daysBack", "connectionId", status, "chatsScanned", "contactsFound", "messagesImported", "createdAt")')
    && adapter.includes('VALUES ($1,$2::text[],$3::"AiImportMode",$4,$5,')
    && adapter.includes("\\'queued\\'::\"AiImportStatus\",0,0,0,NOW())")
    && adapter.lastIndexOf('input.jobId') < adapter.lastIndexOf('input.channels')
    && adapter.lastIndexOf('input.channels') < adapter.lastIndexOf('input.mode')
    && adapter.lastIndexOf('input.mode') < adapter.lastIndexOf('input.daysBack')
    && adapter.lastIndexOf('input.daysBack') < adapter.lastIndexOf('input.connectionId'),
  'queue SQL or bind drift',
)
check('create tolerant catch retained', create.includes("console.error('[AI Import] createImportJob error:', e.message)"), 'create catch drift')
check(
  'returned job and revalidation retained',
  create.indexOf('const job = { id, ...data') < create.indexOf("revalidatePath('/settings/ai')")
    && create.indexOf("revalidatePath('/settings/ai')") < create.indexOf("data.channels.includes('max')"),
  'create continuation drift',
)
check(
  'provider launch order retained',
  create.indexOf("data.channels.includes('max')") < create.indexOf("data.channels.includes('telegram')")
    && create.indexOf("data.channels.includes('telegram')") < create.indexOf("data.channels.includes('whatsapp')")
    && create.indexOf("data.channels.includes('whatsapp')") < create.indexOf('return job'),
  'provider order drift',
)
check(
  'cancel mapping retained',
  adapter.includes("status=\\'failed\\'::\"AiImportStatus\"")
    && adapter.includes('"resultType"=')
    && adapter.includes("\\'failed\\',\"finishedAt\"=NOW() WHERE id=$1")
    && adapter.includes("status IN (\\'queued\\'::\"AiImportStatus\",\\'running\\'::\"AiImportStatus\")"),
  'cancel SQL drift',
)
check(
  'cancel order and catch retained',
  cancel.indexOf('requireIntegrationAdminAccess()') < cancel.indexOf('cancelHistoryImportJobV1')
    && cancel.indexOf('cancelHistoryImportJobV1') < cancel.indexOf("revalidatePath('/settings/ai')")
    && cancel.includes("console.error('[AI Import] cancelImportJob error:', e.message)"),
  'cancel drift',
)
check(
  'delete order and catch retained',
  del.indexOf('requireIntegrationAdminAccess()') < del.indexOf('deleteHistoryImportJobV1')
    && del.indexOf('deleteHistoryImportJobV1') < del.indexOf("revalidatePath('/settings/ai')")
    && del.includes("console.error('[AI Import] deleteImportJob error:', e.message)"),
  'delete drift',
)
check(
  'configuration compatibility delegates only',
  compatibility.includes('return createOwnedImportJob(data)')
    && compatibility.includes('return cancelOwnedImportJob(id)')
    && compatibility.includes('return deleteOwnedImportJob(id)')
    && !compatibility.includes('INSERT INTO "HistoryImportJob"'),
  'legacy settings action still owns import jobs',
)
check(
  'commands amendment exact',
  JSON.stringify(amendment.amendments[0]?.add_commands) === JSON.stringify(['QueueHistoryImportJobCommand.v1', 'CancelHistoryImportJobCommand.v1']),
  'commands amendment drift',
)
check(
  'dependency amendment exact',
  amendment.amendments[1]?.context === 'configuration'
    && JSON.stringify(amendment.amendments[1]?.add_allowed_dependencies) === JSON.stringify([{ context: 'messaging', surface: 'messaging.public' }]),
  'dependency amendment drift',
)

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
