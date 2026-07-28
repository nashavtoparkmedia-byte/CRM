import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const planner = readFileSync(new URL('../src/shadow/OutboundShadowPlanner.ts', import.meta.url), 'utf8')
const repository = readFileSync(new URL('../src/shadow/PrismaShadowPlanRepository.ts', import.meta.url), 'utf8')
const types = readFileSync(new URL('../src/shadow/types.ts', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../../gravity-mvp/prisma/migrations/20260728214000_add_max_outbound_shadow_plan/migration.sql', import.meta.url), 'utf8')

test('all refusal reasons are explicit and persisted fail closed', () => {
  for (const reason of ['ROUTE_NOT_FOUND', 'ROUTE_CONFLICT', 'ACCOUNT_MISMATCH', 'CONVERSATION_NOT_SENDABLE', 'OWNER_NOT_ACQUIRED',
    'OWNER_LEASE_EXPIRED', 'FENCING_TOKEN_MISSING', 'FENCING_TOKEN_STALE', 'PAYLOAD_UNSUPPORTED', 'COMMAND_ALREADY_TERMINAL', 'IDEMPOTENCY_CONFLICT']) {
    assert.match(types, new RegExp(`'${reason}'`)); assert.match(migration, new RegExp(`'${reason}'`))
  }
})

test('planner uses command, reservation, route, and SessionOwner without a competing queue or physical adapter', () => {
  assert.match(repository, /maxOutboundCommand/)
  assert.match(repository, /maxOutboundCommandReservation/)
  assert.match(planner, /getRouteSnapshot/)
  assert.match(planner, /sessionOwner\.get/)
  assert.doesNotMatch(planner + repository, /fetch\s*\(|axios|playwright|puppeteer|chromium|sendMessage|sendText|providerAction|SerializedOutboundQueue|globalQueue/i)
})

test('shadow result cannot authorize physical send or mutate delivery state', () => {
  assert.match(types, /physicalSendAuthorized: false/)
  assert.match(types, /deliveryStateMutated: false/)
  assert.match(planner, /physicalSendAuthorized: false/)
  assert.doesNotMatch(migration, /deliveryStatus|messageStatus|providerMessageId|physicalActionStarted|dispatchTransition/i)
})

test('append-only artifact stores payload metadata but never duplicates raw command text', () => {
  assert.match(migration, /BEFORE UPDATE OR DELETE ON "MaxOutboundShadowPlan"/)
  assert.match(migration, /"payloadSizeBytes"/)
  assert.match(migration, /"payloadSha256"/)
  assert.doesNotMatch(migration, /"text"|"commandPayload"|"rawPayload"/)
  assert.doesNotMatch(repository, /commandPayload:\s*draft|text:\s*draft/)
})

test('migration is additive, next-release scoped, and preserves exact-eight package', () => {
  assert.match(migration, /not part of[\s\S]+exact-eight Stage 8B2A list/)
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN|INDEX)|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN/i)
})
