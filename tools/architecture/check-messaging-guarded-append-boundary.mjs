#!/usr/bin/env node

// R-21 Messaging guarded atomic append and its durable hold.
//   - The held store (HeldChannelMessage) has exactly one runtime reader and
//     writer: the Messaging guarded adapter. No conversation view, inbox, AI
//     context, workflow or other domain touches it.
//   - The adapter judges a binding only after it holds the conversation row
//     (FOR UPDATE, bounded by lock_timeout) and the event key, and it writes
//     only after the judgement; the workflow projection runs on the same
//     transaction client.
//   - The adapter resolves no person and writes no binding: it imports nothing
//     from Contacts and never updates "Chat" itself.
//   - The policy is pure; each handler parses before it persists; the contract
//     reserves the S2 delivery record and the guard audit for Messaging.
//   - The migration creates only the held table, with its reason and release
//     checks and a CASCADE to its conversation.
//   - The composition root binds each guarded handler to the adapter once.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const sourceRoot = 'gravity-mvp/src'
const contractPath = 'gravity-mvp/src/contracts/messaging/v1/guarded-channel-message-commands.ts'
const policyPath = 'gravity-mvp/src/modules/messaging/public/v1/guarded-append-policy.ts'
const handlerPath = 'gravity-mvp/src/modules/messaging/public/v1/guarded-channel-message-handler.ts'
const adapterPath = 'gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-guarded-channel-message-adapter.ts'
const compositionPath = 'gravity-mvp/src/modules/messaging/application/messaging-operations.ts'
const migrationPath = 'gravity-mvp/prisma/migrations/20261108120000_add_messaging_held_channel_message/migration.sql'
const scrubMigrationPath = 'gravity-mvp/prisma/migrations/20261108180000_add_messaging_held_channel_message_release_scrub/migration.sql'
const facadePath = 'gravity-mvp/src/modules/messaging/public/v1/index.ts'
const retentionJobPath = 'gravity-mvp/src/lib/RetentionCleanup.ts'
/**
 * A1: the guarded write capabilities take a person proof as INPUT and trust it,
 * so only server-side composition that derives that proof from Contacts may
 * call them. The first ingress consumer is added here by name, with its review;
 * no file under the app layer (routes, pages, server actions) and no file
 * carrying a 'use server' directive may reach them.
 */
const GUARDED_WRITE_CAPABILITIES = ['appendGuardedChannelMessageV1', 'releaseHeldChannelMessagesV1']
const APPROVED_GUARDED_WRITE_CALLERS = new Set([handlerPath, compositionPath, facadePath])
const GUARDED_RETENTION_CAPABILITY = 'runHeldChannelMessageRetentionV1'
const APPROVED_GUARDED_RETENTION_CALLERS = new Set([handlerPath, compositionPath, facadePath, retentionJobPath])
const GUARDED_READ_CAPABILITY = 'heldChannelMessagesV1'
const closedSet = [contractPath, policyPath, handlerPath, adapterPath]

const RUNTIME_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'])
const isTest = (file) => /\.(test|spec)\.[cm]?[jt]sx?$/u.test(file) || file.includes('/__tests__/')

function runtimeFiles() {
  const files = new Map()
  const walk = (directory) => {
    for (const entry of readdirSync(path.join(root, directory))) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      const relative = `${directory}/${entry}`
      const stats = statSync(path.join(root, relative))
      if (stats.isDirectory()) walk(relative)
      else if (RUNTIME_EXTENSIONS.has(path.extname(entry)) && !isTest(relative)) files.set(relative, read(relative))
    }
  }
  walk(sourceRoot)
  return files
}

function importSpecifiers(source) {
  const specifiers = []
  const pattern = /^\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/gmu
  for (const match of source.matchAll(pattern)) specifiers.push(match[1] ?? match[2] ?? match[3] ?? match[4])
  return specifiers
}

/** The body of `async <name>(input) { … }` inside the adapter object, by brace matching. */
function methodBody(source, name) {
  const start = source.indexOf(`async ${name}(input) {`)
  if (start < 0) throw new Error(`adapter method ${name} missing`)
  let depth = 0
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`adapter method ${name} unterminated`)
}

function functionBody(source, name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`, 'u'))
  if (start < 0) throw new Error(`function ${name} missing`)
  let depth = 0
  for (let index = source.indexOf('{', source.indexOf(')', start)); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`function ${name} unterminated`)
}

function inOrder(body, markers, label) {
  let previous = -1
  for (const marker of markers) {
    const at = body.indexOf(marker)
    if (at < 0) throw new Error(`${label}: ${marker} missing`)
    if (at <= previous) throw new Error(`${label}: ${marker} out of order`)
    previous = at
  }
}

// ── assertions ──────────────────────────────────────────────────────────

function assertHeldStoreOwner(files) {
  for (const [file, source] of files) {
    if (file === adapterPath) continue
    if (/\bheldChannelMessage\b|"HeldChannelMessage"|\bHeldChannelMessage\s*\(|FROM\s+"?HeldChannelMessage/u.test(source)) {
      throw new Error(`${file}: touches the held store outside the guarded adapter`)
    }
    if (importSpecifiers(source).some(specifier => specifier.endsWith('/legacy-prisma-guarded-channel-message-adapter')) && file !== compositionPath) {
      throw new Error(`${file}: imports the guarded adapter outside the composition root`)
    }
  }
}

const APP_LAYER = /^gravity-mvp\/src\/app\//u
const USE_SERVER = /^\s*['"]use server['"]\s*;?\s*$/mu
const mentions = (source, name) => new RegExp(`\\b${name}\\b`, 'u').test(source)

function assertServerSideCallersOnly(files) {
  for (const [file, source] of files) {
    const appLayer = APP_LAYER.test(file) || USE_SERVER.test(source)
    for (const name of [...GUARDED_WRITE_CAPABILITIES, GUARDED_RETENTION_CAPABILITY, GUARDED_READ_CAPABILITY]) {
      if (appLayer && mentions(source, name)) throw new Error(`${file}: the app layer or a server action reaches ${name}`)
    }
    for (const name of GUARDED_WRITE_CAPABILITIES) {
      if (mentions(source, name) && !APPROVED_GUARDED_WRITE_CALLERS.has(file)) throw new Error(`${file}: calls ${name} without an approved server-side composition review`)
    }
    if (mentions(source, GUARDED_RETENTION_CAPABILITY) && !APPROVED_GUARDED_RETENTION_CALLERS.has(file)) {
      throw new Error(`${file}: calls ${GUARDED_RETENTION_CAPABILITY} outside the retention job`)
    }
  }
}

function assertScrubMigration(sql) {
  const statements = sql.replace(/--[^\n]*\n/gu, '\n').split(';').map(part => part.trim()).filter(Boolean)
  if (statements.length !== 3 || statements[0] !== 'BEGIN' || statements[2] !== 'COMMIT') throw new Error('scrub migration is not one constraint in one explicit transaction')
  if (!/^ALTER TABLE "HeldChannelMessage" ADD CONSTRAINT "HeldChannelMessage_released_scrubbed_check"\s+CHECK \("releasedAt" IS NULL OR \("content" = '' AND "metadata" = '\{\}'::jsonb\)\)$/u.test(statements[1])) {
    throw new Error('scrub migration constraint drift')
  }
}

function assertAdapterLocksBeforeJudging(source) {
  const lock = functionBody(source, 'lockConversation')
  if (!/set_config\('lock_timeout', \$\{LOCK_TIMEOUT\}, true\)/u.test(lock)) throw new Error('conversation lock is not bounded by lock_timeout')
  if (!/FROM "Chat"\s+WHERE "id" = \$\{chatId\}\s+FOR UPDATE/u.test(lock)) throw new Error('conversation is not row-locked')
  if (!/pg_advisory_xact_lock\(hashtextextended/u.test(functionBody(source, 'lockEventKeys'))) throw new Error('event keys are not advisory-locked')
  if (!/\[\.\.\.new Set\(keys\)\]\.sort\(\)/u.test(functionBody(source, 'lockEventKeys'))) throw new Error('event keys are not locked in sorted order')
  if (!/isolationLevel: 'ReadCommitted' as Prisma\.TransactionIsolationLevel,/u.test(source)) throw new Error('isolation level drift')
  if (!/^import type \{ Prisma \} from '@prisma\/client'$/mu.test(source)) throw new Error('the adapter imports a Prisma value')

  const append = methodBody(source, 'append')
  inOrder(append, [
    'prisma.$transaction(',
    'await lockConversation(transaction,',
    'CONVERSATION_CHANNEL_MISMATCH',
    'await lockEventKeys(transaction,',
    'await recordedEvent(transaction,',
    'if (recorded) return recorded',
    'decideGuardedAppendV1(',
    'await writeVisible(transaction,',
    'await writeHeld(transaction,',
  ], 'append')
  if (!/if \(isUniqueViolation\(error\)\) \{\s+const winner = await recordedEvent\(prisma, event\)/u.test(append)) {
    throw new Error('append: a unique violation is not settled by the committed winner')
  }

  const release = methodBody(source, 'release')
  inOrder(release, [
    'prisma.$transaction(',
    'await lockConversation(transaction,',
    "if (input.conversationKind === 'private' && proof.status !== 'proven') {",
    'decideGuardedAppendV1(',
    'if (!decision.visible)',
    'transaction.heldChannelMessage.findMany(',
    'await lockEventKeys(transaction,',
    'await writeVisible(transaction,',
    'transaction.heldChannelMessage.update(',
    "data: { releasedAt, releasedMessageId: messageId, content: '', metadata: {} },",
  ], 'release')
  const purge = methodBody(source, 'purgeHeld')
  if (!/where: \{ id: \{ in: expired\.map\(row => row\.id\) \}, sentAt: \{ lt: input\.before \} \},/u.test(purge)) throw new Error('retention deletes a held row for anything but its own age')
  if (!/if \(input\.dryRun \|\| expired\.length === 0\) return expired\.length/u.test(purge)) throw new Error('retention dry run deletes')
  if (!release.includes("where: { ...unreleased, OR: [{ senderContactIdentityId: null }, ...(sender ? [{ senderContactIdentityId: sender }] : [])] },")) {
    throw new Error('release: an event held for another proven identity may be released')
  }
  if (!/senderContactIdentityId: attribution\.status === 'proven' \? attribution\.contactIdentityId : null,/u.test(functionBody(source, 'writeHeld'))) {
    throw new Error('a held event does not record its proven sender')
  }
  const outsidePurge = source.replace(methodBody(source, 'purgeHeld'), '')
  if (/\bheldChannelMessage\.(?:delete|deleteMany|upsert|updateMany)\b/u.test(outsidePurge)) throw new Error('held rows are deleted or bulk-rewritten outside retention')

  const visible = functionBody(source, 'writeVisible')
  for (const projection of ['onGroupInboundMessage', 'onOutboundMessage', 'onInboundMessage']) {
    if (!new RegExp(`ConversationWorkflowService\\.${projection}\\(event\\.chatId, event\\.sentAt, transaction\\)`, 'u').test(visible)) {
      throw new Error(`workflow ${projection} does not run on the transaction client`)
    }
  }
  if (!/transaction\.domainOutboxEvent\.createMany\(/u.test(visible)) throw new Error('notification intent is not written in the transaction')
  if (!/\?\s*\{ delivery: newDeliveryEvidenceRecordV1\('provider_echo', 'echo', now\) \}/u.test(visible)) throw new Error('outbound echo evidence drift')
  if (!/status: outbound \? 'sent' : 'delivered'/u.test(visible)) throw new Error('an outbound echo may be marked delivered')
}

function assertAdapterWritesNoBinding(source) {
  if (importSpecifiers(source).some(specifier => specifier.includes('/modules/contacts') || specifier.includes('/contracts/contacts'))) {
    throw new Error('the guarded adapter depends on Contacts')
  }
  if (/\b(?:db|prisma|transaction)\.chat\.(?:update|updateMany|upsert|create|delete|deleteMany)\b/u.test(source)) throw new Error('the guarded adapter writes a conversation binding')
  if (/UPDATE\s+"Chat"/iu.test(source)) throw new Error('the guarded adapter updates "Chat" directly')
  for (const file of [policyPath, handlerPath, contractPath]) {
    const closed = read(file)
    if (importSpecifiers(closed).some(specifier => specifier.includes('/modules/contacts') || specifier.includes('/contracts/contacts'))) {
      throw new Error(`${file}: depends on Contacts`)
    }
  }
}

function assertPurePolicy(source) {
  const specifiers = importSpecifiers(source)
  if (specifiers.length !== 1 || specifiers[0] !== '../../../../contracts/messaging/v1') throw new Error('policy imports drift')
  if (!/^import type \{/mu.test(source)) throw new Error('policy imports values')
  if (/\bawait\b|\bprisma\b|\bfetch\(|process\.env/u.test(source)) throw new Error('policy performs IO')
}

function assertHandlersParseFirst(source) {
  const handlers = [
    ['appendGuardedChannelMessageV1', 'parseAppendGuardedChannelMessageCommandV1(command)', 'await port.append('],
    ['releaseHeldChannelMessagesV1', 'parseReleaseHeldChannelMessagesCommandV1(command)', 'await port.release('],
    ['heldChannelMessagesV1', 'parseHeldChannelMessagesQueryV1(query)', 'await port.countHeld('],
  ]
  for (const [name, parse, persist] of handlers) {
    const start = source.indexOf(`async function ${name}(`)
    if (start < 0) throw new Error(`handler ${name} missing`)
    const body = source.slice(start)
    const parseAt = body.indexOf(parse)
    const persistAt = body.indexOf(persist)
    if (parseAt < 0 || persistAt < 0 || parseAt > persistAt) throw new Error(`handler ${name}: parse does not precede persistence`)
  }
  if (importSpecifiers(source).some(specifier => specifier.includes('prisma') || specifier.startsWith('@/lib'))) throw new Error('handler reaches persistence directly')
}

function assertContractReservations(source) {
  if (!/RESERVED_METADATA_KEYS = new Set<string>\(\['delivery', 'guardedAppend'\]\)/u.test(source)) throw new Error('reserved metadata drift')
  if (!/const UNPROVEN_REASON = \/\^\[A-Z\]\[A-Z0-9_\]\{0,63\}\(\?::\[A-Za-z0-9_\.-\]\{1,64\}\)\?\$\//u.test(source)) throw new Error('unproven reason is not a bounded code')
  if (!/if \(kind !== 'private'\) invalid\('a group conversation has no proven sender'\)/u.test(source)) throw new Error('a group may carry a proven sender')
  if (!/if \(kind !== 'group'\) invalid\('a private conversation needs a sender attribution'\)/u.test(source)) throw new Error('a private conversation may skip attribution')
  if (!/if \(sender\.status === 'unproven'\) invalid\('a release needs a proven sender'\)/u.test(source)) throw new Error('a release may run without a proven sender')
}

function assertMigration(sql) {
  const statements = sql.replace(/--[^\n]*\n/gu, '\n').split(';').map(part => part.trim()).filter(Boolean)
  const allowed = [
    /^BEGIN$/u,
    /^COMMIT$/u,
    /^CREATE TABLE "HeldChannelMessage" \(/u,
    /^CREATE (?:UNIQUE )?INDEX "HeldChannelMessage_[A-Za-z]+(?:_[A-Za-z]+)*_(?:key|idx)" ON "HeldChannelMessage"\("[A-Za-z]+"(?:, "[A-Za-z]+")*\)$/u,
    /^ALTER TABLE "HeldChannelMessage" ADD CONSTRAINT /u,
  ]
  for (const statement of statements) {
    if (!allowed.some(pattern => pattern.test(statement))) throw new Error(`migration statement outside the held table: ${statement.slice(0, 60)}`)
  }
  if (statements[0] !== 'BEGIN' || statements[statements.length - 1] !== 'COMMIT') throw new Error('migration is not one explicit transaction')
  const alter = statements.filter(statement => /^ALTER TABLE/iu.test(statement))
  if (alter.length !== 1 || !/^ALTER TABLE "HeldChannelMessage" ADD CONSTRAINT "HeldChannelMessage_chatId_fkey" FOREIGN KEY \("chatId"\) REFERENCES "Chat"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE$/u.test(alter[0])) {
    throw new Error('migration foreign key drift')
  }
  if (!/CHECK \("holdReason" IN \('binding_absent', 'binding_mismatch', 'attribution_unproven', 'group_person_bound'\)\)/u.test(sql)) throw new Error('hold reason check drift')
  if (!/CHECK \(\("releasedAt" IS NULL\) = \("releasedMessageId" IS NULL\)\)/u.test(sql)) throw new Error('release pair check drift')
  if (!/CHECK \("direction" IN \('inbound', 'outbound'\)\)/u.test(sql)) throw new Error('direction check drift')
  if (!/AND \("holdEvidence" #>> '\{attribution,status\}'\) IS NOT DISTINCT FROM 'proven'\s+AND "senderContactIdentityId" IS NOT DISTINCT FROM \("holdEvidence" #>> '\{attribution,contactIdentityId\}'\)\)/u.test(sql)) {
    throw new Error('sender evidence check drift (it must be NULL-safe: a NULL comparison passes a CHECK)')
  }
  if (!/CREATE UNIQUE INDEX "HeldChannelMessage_externalId_key"/u.test(sql)) throw new Error('held event key is not unique')
}

function assertComposition(source) {
  for (const factory of ['createAppendGuardedChannelMessageHandlerV1', 'createReleaseHeldChannelMessagesHandlerV1', 'createHeldChannelMessagesQueryHandlerV1']) {
    const calls = [...source.matchAll(new RegExp(`${factory}\\(([^)]*)\\)`, 'gu'))]
    if (calls.length !== 1 || calls[0][1] !== 'legacyPrismaGuardedChannelMessagePortV1') throw new Error(`${factory}: composition drift`)
  }
  if (importSpecifiers(source).filter(specifier => specifier === '../public/v1/legacy-prisma-guarded-channel-message-adapter').length !== 1) {
    throw new Error('adapter import drift')
  }
}

// ── run on the real tree ───────────────────────────────────────────────

const files = runtimeFiles()
for (const file of closedSet) assert.ok(files.has(file), `${file} missing`)
const adapterSource = files.get(adapterPath)
const policySource = files.get(policyPath)
const handlerSource = files.get(handlerPath)
const contractSource = files.get(contractPath)
const compositionSource = files.get(compositionPath)
const migrationSql = read(migrationPath)
const scrubSql = read(scrubMigrationPath)

assertHeldStoreOwner(files)
assertServerSideCallersOnly(files)
assertScrubMigration(scrubSql)
assertAdapterLocksBeforeJudging(adapterSource)
assertAdapterWritesNoBinding(adapterSource)
assertPurePolicy(policySource)
assertHandlersParseFirst(handlerSource)
assertContractReservations(contractSource)
assertMigration(migrationSql)
assertComposition(compositionSource)

// ── negative probes: each must be rejected ─────────────────────────────

let probes = 0
function rejectProbe(original, changed, check) {
  assert.notEqual(changed, original, 'probe did not change its source')
  assert.throws(() => check(changed), `probe accepted:\n${changed.slice(0, 200)}`)
  probes += 1
}

const withFile = (file, source) => new Map([...files, [file, source]])
rejectProbe('', "await prisma.heldChannelMessage.findMany({ where: { chatId } })\n", (changed) => assertHeldStoreOwner(withFile('gravity-mvp/src/lib/MessageService.ts', `${files.get('gravity-mvp/src/lib/MessageService.ts')}${changed}`)))
rejectProbe('', 'const rows = await prisma.$queryRaw`SELECT * FROM "HeldChannelMessage"`\n', (changed) => assertHeldStoreOwner(withFile('gravity-mvp/src/modules/messaging/internal/ai-reply-pipeline/ContextBuilder.ts', changed)))
rejectProbe('', "import { legacyPrismaGuardedChannelMessagePortV1 } from '@/modules/messaging/public/v1/legacy-prisma-guarded-channel-message-adapter'\n", (changed) => assertHeldStoreOwner(withFile('gravity-mvp/src/app/api/webhook/telegram/route.ts', changed)))
rejectProbe('', "import { appendGuardedChannelMessageV1 } from '@/modules/messaging/public/v1'\nexport async function POST() { return appendGuardedChannelMessageV1({} as never) }\n", (changed) => assertServerSideCallersOnly(withFile('gravity-mvp/src/app/api/messages/guarded/route.ts', changed)))
rejectProbe('', "'use server'\nimport { releaseHeldChannelMessagesV1 } from '@/modules/messaging/public/v1'\nexport async function releaseAction(input: unknown) { return releaseHeldChannelMessagesV1(input) }\n", (changed) => assertServerSideCallersOnly(withFile('gravity-mvp/src/modules/messaging/internal/actions.ts', changed)))
rejectProbe('', "'use server'\nimport { heldChannelMessagesV1 } from '@/modules/messaging/public/v1'\n", (changed) => assertServerSideCallersOnly(withFile('gravity-mvp/src/modules/messaging/internal/held-actions.ts', changed)))
rejectProbe('', "import { appendGuardedChannelMessageV1 } from '@/modules/messaging/public/v1'\n", (changed) => assertServerSideCallersOnly(withFile('gravity-mvp/src/infrastructure/telegram/ingress.ts', changed)))
rejectProbe('', "import { runHeldChannelMessageRetentionV1 } from '@/modules/messaging/public/v1'\n", (changed) => assertServerSideCallersOnly(withFile('gravity-mvp/src/lib/SomeService.ts', changed)))
rejectProbe(scrubSql, scrubSql.replace("\"content\" = '' AND ", ''), assertScrubMigration)
rejectProbe(scrubSql, scrubSql.replace('COMMIT;', 'UPDATE "HeldChannelMessage" SET "content" = \'\';\n\nCOMMIT;'), assertScrubMigration)
rejectProbe(adapterSource, adapterSource.replace("data: { releasedAt, releasedMessageId: messageId, content: '', metadata: {} },", 'data: { releasedAt, releasedMessageId: messageId },'), assertAdapterLocksBeforeJudging)
rejectProbe(adapterSource, adapterSource.replace('where: { id: { in: expired.map(row => row.id) }, sentAt: { lt: input.before } },', 'where: { id: { in: expired.map(row => row.id) } },'), assertAdapterLocksBeforeJudging)
rejectProbe(adapterSource, adapterSource.replace('if (input.dryRun || expired.length === 0) return expired.length', 'if (expired.length === 0) return 0'), assertAdapterLocksBeforeJudging)
rejectProbe(adapterSource, adapterSource.replace('    FOR UPDATE\n', '\n'), assertAdapterLocksBeforeJudging)
rejectProbe(adapterSource, adapterSource.replace("await transaction.$queryRaw`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true) AS \"configured\"`", 'void 0'), assertAdapterLocksBeforeJudging)
rejectProbe(adapterSource, adapterSource.replace('[...new Set(keys)].sort()', '[...new Set(keys)]'), assertAdapterLocksBeforeJudging)
rejectProbe(adapterSource, adapterSource.replace("'ReadCommitted' as Prisma.TransactionIsolationLevel", "'ReadUncommitted' as Prisma.TransactionIsolationLevel"), assertAdapterLocksBeforeJudging)
rejectProbe(adapterSource, adapterSource.replace("import type { Prisma } from '@prisma/client'", "import { Prisma } from '@prisma/client'"), assertAdapterLocksBeforeJudging)
rejectProbe(adapterSource, adapterSource.replace('        if (recorded) return recorded\n', '\n'), assertAdapterLocksBeforeJudging)
rejectProbe(adapterSource, adapterSource.replace(
  '        await lockEventKeys(transaction, [event.externalId])\n        const recorded = await recordedEvent(transaction, event)\n',
  '        const recorded = await recordedEvent(transaction, event)\n        await lockEventKeys(transaction, [event.externalId])\n',
), assertAdapterLocksBeforeJudging)
rejectProbe(adapterSource, adapterSource.replace('const winner = await recordedEvent(prisma, event)', 'const winner = null'), assertAdapterLocksBeforeJudging)
rejectProbe(adapterSource, adapterSource.replace('ConversationWorkflowService.onInboundMessage(event.chatId, event.sentAt, transaction)', 'ConversationWorkflowService.onInboundMessage(event.chatId, event.sentAt)'), assertAdapterLocksBeforeJudging)
rejectProbe(adapterSource, adapterSource.replace("status: outbound ? 'sent' : 'delivered'", "status: 'delivered'"), assertAdapterLocksBeforeJudging)
rejectProbe(adapterSource, `${adapterSource}\nawait prisma.heldChannelMessage.deleteMany({ where: {} })\n`, assertAdapterLocksBeforeJudging)
rejectProbe(adapterSource, `import { resolveChannelContactV1 } from '@/modules/contacts/public/v1'\n${adapterSource}`, assertAdapterWritesNoBinding)
rejectProbe(adapterSource, `${adapterSource}\nawait transaction.chat.update({ where: { id }, data: { contactId } })\n`, assertAdapterWritesNoBinding)
rejectProbe(adapterSource, `${adapterSource}\nawait transaction.$executeRawUnsafe('UPDATE "Chat" SET "driverId" = NULL')\n`, assertAdapterWritesNoBinding)
rejectProbe(policySource, `import { prisma } from '@/lib/prisma'\n${policySource}`, assertPurePolicy)
rejectProbe(policySource, `${policySource}\nexport async function probe() { return await Promise.resolve(process.env.X) }\n`, assertPurePolicy)
rejectProbe(handlerSource, handlerSource.replace(
  '    const { contract: _contract, ...input } = parseAppendGuardedChannelMessageCommandV1(command)\n    const settled = await port.append(input)\n',
  '    const settled = await port.append(command as never)\n    const { contract: _contract, ...input } = parseAppendGuardedChannelMessageCommandV1(command)\n',
), assertHandlersParseFirst)
rejectProbe(handlerSource, `import { prisma } from '@/lib/prisma'\n${handlerSource}`, assertHandlersParseFirst)
rejectProbe(contractSource, contractSource.replace("new Set<string>(['delivery', 'guardedAppend'])", "new Set<string>(['guardedAppend'])"), assertContractReservations)
rejectProbe(contractSource, contractSource.replace("if (kind !== 'private') invalid('a group conversation has no proven sender')", 'void kind'), assertContractReservations)
rejectProbe(contractSource, contractSource.replace('const UNPROVEN_REASON = /^[A-Z][A-Z0-9_]{0,63}(?::[A-Za-z0-9_.-]{1,64})?$/', 'const UNPROVEN_REASON = /^.+$/'), assertContractReservations)
rejectProbe(adapterSource, adapterSource.replace("if (input.conversationKind === 'private' && proof.status !== 'proven') {", 'if (false) {'), assertAdapterLocksBeforeJudging)
rejectProbe(adapterSource, adapterSource.replace("where: { ...unreleased, OR: [{ senderContactIdentityId: null }, ...(sender ? [{ senderContactIdentityId: sender }] : [])] },", 'where: unreleased,'), assertAdapterLocksBeforeJudging)
rejectProbe(adapterSource, adapterSource.replace("senderContactIdentityId: attribution.status === 'proven' ? attribution.contactIdentityId : null,", 'senderContactIdentityId: null,'), assertAdapterLocksBeforeJudging)
rejectProbe(contractSource, contractSource.replace("if (sender.status === 'unproven') invalid('a release needs a proven sender')", 'void sender'), assertContractReservations)
rejectProbe(migrationSql, migrationSql.replace('AND "senderContactIdentityId" IS NOT DISTINCT FROM ("holdEvidence" #>> \'{attribution,contactIdentityId}\'))', ')'), assertMigration)
rejectProbe(migrationSql, migrationSql.replace("AND (\"holdEvidence\" #>> '{attribution,status}') IS NOT DISTINCT FROM 'proven'", "AND (\"holdEvidence\" #>> '{attribution,status}') = 'proven'"), assertMigration)
rejectProbe(migrationSql, migrationSql.replace('ON DELETE CASCADE', 'ON DELETE SET NULL'), assertMigration)
rejectProbe(migrationSql, migrationSql.replace("'group_person_bound')", "'group_person_bound', 'guessed')"), assertMigration)
rejectProbe(migrationSql, migrationSql.replace('COMMIT;', 'UPDATE "Message" SET "status" = \'read\';\n\nCOMMIT;'), assertMigration)
rejectProbe(migrationSql, migrationSql.replace('COMMIT;', 'ALTER TABLE "Chat" ADD COLUMN "heldCount" INTEGER;\n\nCOMMIT;'), assertMigration)
rejectProbe(migrationSql, migrationSql.replace('CREATE UNIQUE INDEX "HeldChannelMessage_externalId_key"', 'CREATE INDEX "HeldChannelMessage_externalId_key"'), assertMigration)
rejectProbe(compositionSource, `${compositionSource}\nconst rogue = createAppendGuardedChannelMessageHandlerV1(fakePort)\n`, assertComposition)

process.stdout.write(`messaging guarded append boundary: PASS (one held-store owner, server-side callers only, lock-then-judge, no binding writes, pure policy, parse-first handlers, scrubbed release; ${probes} negative probes rejected)\n`)
