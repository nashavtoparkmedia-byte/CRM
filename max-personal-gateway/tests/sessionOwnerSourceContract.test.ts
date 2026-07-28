import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { SESSION_OWNER_DESIGN_DECISION } from '../src/session/constants.ts'

const repository = readFileSync(new URL('../src/session/PrismaSessionOwnerRepository.ts', import.meta.url), 'utf8')
const service = readFileSync(new URL('../src/session/AccountSessionOwner.ts', import.meta.url), 'utf8')
const featureFlag = readFileSync(new URL('../src/session/featureFlag.ts', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../../gravity-mvp/prisma/migrations/20260728213000_add_max_account_session_owner/migration.sql', import.meta.url), 'utf8')
const schema = readFileSync(new URL('../../gravity-mvp/prisma/schema.prisma', import.meta.url), 'utf8')
const actorSchema = schema.split('model MaxOutboundConversationActor {')[1]!.split('model MaxOutboundCommandReservation {')[0]!

test('design decision adds one account SessionOwner without promoting the per-conversation lease', () => {
  assert.equal(SESSION_OWNER_DESIGN_DECISION, 'ADD_ACCOUNT_SESSION_OWNER')
  assert.match(schema, /model MaxAccountSessionOwner \{[\s\S]+accountId\s+String\s+@id/)
  assert.match(schema, /Its lease epoch is not the SessionOwner fencing epoch/)
  assert.doesNotMatch(actorSchema, /fencingToken|physicalSend/)
})

test('acquire is a PostgreSQL transaction with conditional insert, row lock, DB now, and bounded lock timeout', () => {
  assert.match(repository, /\$transaction/)
  assert.match(repository, /ON CONFLICT \("accountId"\) DO NOTHING/)
  assert.match(repository, /FOR UPDATE/)
  assert.match(repository, /now\(\)/)
  assert.match(repository, /set_config\('lock_timeout', '5s', true\)/)
  assert.doesNotMatch(repository, /Date\.now|new Date\(\)/)
  assert.doesNotMatch(repository, /\$queryRawUnsafe|\$executeRawUnsafe/)
})

test('sender verification is account-owner-token exact and checks unexpired active state at DB time', () => {
  assert.match(repository, /verifyCurrent[\s\S]+"accountId" = \$\{input\.accountId\}[\s\S]+"ownerInstanceId" = \$\{input\.ownerInstanceId\}[\s\S]+"fencingToken" = \$\{input\.fencingToken\}/)
  assert.match(repository, /"state" = 'active' AND "leaseUntil" > now\(\)/)
  assert.match(service, /verifyImmediatelyBeforeSender/)
  assert.doesNotMatch(service + repository, /conversationKey|Redis|ioredis|hostname|process\.pid|local mutex/i)
})

test('next-release migration is additive, explicit, durable, and outside the accepted exact-eight list', () => {
  for (const field of ['accountId', 'ownerInstanceId', 'fencingToken', 'acquiredAt', 'heartbeatAt', 'leaseUntil', 'lastReleasedAt', 'state', 'version']) {
    assert.match(migration, new RegExp(`"${field}"`))
  }
  assert.match(migration, /fencing token must be monotonic and contiguous/)
  assert.match(migration, /released fencing token cannot be revived/)
  assert.match(migration, /BEFORE UPDATE OR DELETE/)
  assert.match(migration, /not part of the exact[\s\S]+eight Stage 8B2A migration list/)
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN|INDEX)|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN/i)
})

test('all five feature gates are independent, account allowlisted, and wildcard cannot enable them', () => {
  for (const gate of ['PERSISTENCE', 'ACQUISITION', 'HEARTBEAT', 'SENDER_FENCING', 'PHYSICAL_SENDER']) {
    assert.match(featureFlag, new RegExp(`SESSION_OWNER_${gate}_ACCOUNTS`))
  }
  assert.match(featureFlag, /token === '\*'/)
  assert.match(featureFlag, /return false/)
})
