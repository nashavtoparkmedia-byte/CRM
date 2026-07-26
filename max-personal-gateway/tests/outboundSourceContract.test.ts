import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

const outboundRoot = new URL('../src/outbound/', import.meta.url)
const repositoryRoot = new URL('../../', import.meta.url)
const outboundSource = readdirSync(outboundRoot)
  .filter(name => name.endsWith('.ts'))
  .map(name => readFileSync(new URL(name, outboundRoot), 'utf8'))
  .join('\n')
const migration = readFileSync(new URL('gravity-mvp/prisma/migrations/20260726215715_add_max_per_chat_outbound_actor/migration.sql', repositoryRoot), 'utf8')
const schema = readFileSync(new URL('gravity-mvp/prisma/schema.prisma', repositoryRoot), 'utf8')

test('outbound actor interface is explicit, framework-independent, and complete', () => {
  const contract = readFileSync(new URL('../src/outbound/types.ts', import.meta.url), 'utf8')
  for (const operation of [
    'enqueueCommand', 'getCommand', 'listCommandsAfter', 'acquireActorLease', 'renewActorLease',
    'releaseActorLease', 'reserveNextCommand', 'prepareReservedCommand', 'releaseReservation',
    'expireReservation', 'getActorState',
  ]) assert.match(contract, new RegExp(`\\b${operation}\\b`))
  assert.match(contract, /physicalSendAuthorized: false/)
  assert.doesNotMatch(contract, /protocolChatId.*Enqueue|providerUserId.*Enqueue|phone|displayName/i)
})

test('Stage 4 has no Redis, Chromium, sender, global queue, DOM, provider, Gravity runtime, or network dependency', () => {
  assert.doesNotMatch(outboundSource, /from\s+['"][^'"]*(?:redis|ioredis|chromium|playwright|puppeteer|sender|MessageService|gravity)/i)
  assert.doesNotMatch(outboundSource, /SerializedOutboundQueue|globalQueue|promiseTail|activeDialog|querySelector|WebSocket|fetch\s*\(|axios|sendMessage|sendFrame|providerAction/i)
  const protectedRuntime = [
    'max-web-scraper/index.js',
    'max-web-scraper/transport/TransportInterceptor.js',
    'max-web-scraper/sync/MessageSync.js',
  ].map(path => readFileSync(new URL(path, repositoryRoot), 'utf8')).join('\n')
  assert.doesNotMatch(protectedRuntime, /MAX_PER_CHAT_OUTBOUND_ACTOR_ENABLED|PerConversationOutboundActor|MaxOutboundCommand/)
})

test('migration is additive, account-scoped, partial-unique, append-only, and has no GUC bypass', () => {
  for (const table of ['MaxOutboundCommand', 'MaxOutboundConversationActor', 'MaxOutboundCommandReservation']) {
    assert.match(migration, new RegExp(`CREATE TABLE "${table}"`))
    assert.match(schema, new RegExp(`model ${table} \\{`))
  }
  assert.match(migration, /MaxOutboundCommand_account_conversation_sequence_key/)
  assert.match(migration, /MaxOutboundCommand_account_client_message_key[\s\S]+WHERE "clientMessageId" IS NOT NULL/)
  assert.match(migration, /MaxOutboundCommandReservation_active_command_key[\s\S]+WHERE "reservationState" = 'reserved'/)
  assert.match(migration, /MaxOutboundCommandReservation_active_conversation_key[\s\S]+WHERE "reservationState" = 'reserved'/)
  assert.match(migration, /FOREIGN KEY \("accountId", "conversationKey"\)/)
  assert.match(migration, /FOREIGN KEY \("accountId", "conversationKey", "commandId", "commandSequence"\)/)
  assert.match(migration, /BEFORE UPDATE OR DELETE ON "MaxOutboundCommand"/)
  assert.doesNotMatch(migration, /current_setting|set_config|retention_bypass|SET LOCAL/i)
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN|INDEX)|TRUNCATE|DELETE\s+FROM/i)
})

test('text and payload hashes have no uniqueness or correlation-based command dedup', () => {
  assert.doesNotMatch(migration, /UNIQUE INDEX[^;]+(?:commandPayload|payloadSha256|text|createdAt)/is)
  assert.doesNotMatch(schema.split('model MaxOutboundCommand {')[1]!.split('model MaxOutboundConversationActor {')[0]!, /payloadSha256\s+String\s+@unique/)
  assert.match(outboundSource, /accountId.*conversationKey/s)
  assert.doesNotMatch(outboundSource, /where:\s*\{[^}]*\b(?:text|payloadSha256)\b/)
})

test('Stage 4 migration contains no generated artifacts or dispatch/provider state', () => {
  const files = readdirSync(outboundRoot)
  assert.equal(files.some(name => /\.js$|\.map$|coverage|node_modules|\.env/i.test(name)), false)
  assert.doesNotMatch(migration, /providerMessageId|deliveryState|dispatchAttempt/)
})
