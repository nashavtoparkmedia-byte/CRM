import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

const dispatchRoot = new URL('../src/dispatch/', import.meta.url)
const repositoryRoot = new URL('../../', import.meta.url)
const source = readdirSync(dispatchRoot)
  .filter(name => name.endsWith('.ts'))
  .map(name => readFileSync(new URL(name, dispatchRoot), 'utf8'))
  .join('\n')
const types = readFileSync(new URL('../src/dispatch/types.ts', import.meta.url), 'utf8')
const outboundTypes = readFileSync(new URL('../src/outbound/types.ts', import.meta.url), 'utf8')
const outboundAdapter = readFileSync(new URL('../src/outbound/PrismaPerConversationOutboundActor.ts', import.meta.url), 'utf8')
const migration = readFileSync(new URL('gravity-mvp/prisma/migrations/20260726225737_add_max_dispatch_ledger/migration.sql', repositoryRoot), 'utf8')
const schema = readFileSync(new URL('gravity-mvp/prisma/schema.prisma', repositoryRoot), 'utf8')

test('DispatchLedger interface is explicit, typed and complete', () => {
  for (const operation of [
    'createDispatchFromReservation', 'getDispatch', 'listDispatchesAfter', 'beginAttempt',
    'markPhysicalActionStarted', 'recordClientActionAccepted', 'markAwaitingConfirmation',
    'recordUnknownOutcome', 'recordPreActionFailure', 'recordExactProviderConfirmation',
    'recordProviderAbsenceProven', 'queueRetry', 'markHardFailed', 'deadLetter',
    'resolveTerminalFailureAndAdvance', 'recoverStaleDispatches', 'listOpenReconciliationTasks',
  ]) assert.match(types, new RegExp('\\b' + operation + '\\b'))
  assert.match(types, /physicalSendAuthorized: false/)
  assert.doesNotMatch(outboundTypes.split('export interface PerConversationOutboundActor')[1]!, /markReservationHandedOff/)
  assert.match(outboundAdapter, /DISPATCH_LEDGER_REQUIRED/)
})

test('Dispatch source has no Redis, Chromium, sender, provider action, global queue or runtime dependency', () => {
  assert.doesNotMatch(source, /from\s+['"][^'"]*(?:redis|ioredis|chromium|playwright|puppeteer|SerializedOutboundQueue|MessageService|gravity)/i)
  assert.doesNotMatch(source, /globalQueue|promiseTail|activeDialog|querySelector|WebSocket|fetch\s*\(|axios|sendMessage|sendFrame|providerAction/i)
  const protectedRuntime = [
    'max-web-scraper/index.js',
    'max-web-scraper/transport/TransportInterceptor.js',
    'max-web-scraper/sync/MessageSync.js',
  ].map(path => readFileSync(new URL(path, repositoryRoot), 'utf8')).join('\n')
  assert.doesNotMatch(protectedRuntime, /MAX_DISPATCH_LEDGER_ENABLED|PrismaDispatchLedger|MaxOutboundDispatch/)
})

test('schema and migration contain all five durable concepts and exact isolation constraints', () => {
  for (const model of [
    'MaxOutboundDispatch', 'MaxOutboundDispatchLane', 'MaxOutboundDispatchAttempt',
    'MaxOutboundDispatchTransition', 'MaxOutboundReconciliationTask',
  ]) {
    assert.match(schema, new RegExp('model ' + model + ' \\{'))
    assert.match(migration, new RegExp('CREATE TABLE "' + model + '"'))
  }
  assert.match(migration, /MaxOutboundDispatch_account_provider_message_key[\s\S]+WHERE "providerMessageId" IS NOT NULL/)
  assert.match(migration, /MaxOutboundDispatchAttempt_active_dispatch_key[\s\S]+WHERE "completedAt" IS NULL/)
  assert.match(migration, /MaxOutboundReconciliationTask_open_dispatch_key[\s\S]+WHERE "state" = 'open'/)
  assert.match(migration, /MaxOutboundCommandReservation_dispatch_fkey/)
  assert.match(migration, /"handoffReference" = "dispatchId"/)
})

test('transition/Dispatch/Attempt immutability has unconditional trigger protection and no GUC bypass', () => {
  assert.match(migration, /MaxOutboundDispatch_immutable/)
  assert.match(migration, /MaxOutboundDispatchAttempt_immutable/)
  assert.match(migration, /BEFORE UPDATE OR DELETE ON "MaxOutboundDispatchTransition"/)
  assert.doesNotMatch(migration, /current_setting|set_config|retention_bypass|SET LOCAL/i)
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN|INDEX)|TRUNCATE|DELETE\s+FROM/i)
})

test('honest state contract has no recipient-delivery state and no weak confirmation matcher', () => {
  const stateDeclaration = types.split('export type DispatchState =')[1]!.split('export type DispatchAttemptState')[0]!
  assert.doesNotMatch(stateDeclaration, /delivered|read/)
  assert.doesNotMatch(source, /textMatcher|timestampMatcher|DOM-position|previous-message|querySelector/i)
  assert.match(source, /exact_provider_confirmation/)
  assert.match(source, /UNSAFE_RETRY/)
})
