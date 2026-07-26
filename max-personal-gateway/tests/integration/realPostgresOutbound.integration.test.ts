import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { PrismaPerConversationOutboundActor } from '../../src/outbound/PrismaPerConversationOutboundActor.ts'
import { OUTBOUND_COMMAND_ENVELOPE_VERSION } from '../../src/outbound/constants.ts'
import { OutboundActorError } from '../../src/outbound/errors.ts'
import type { EnqueueOutboundCommandInput, OutboundCommand } from '../../src/outbound/types.ts'
import { PrismaRouteRegistry } from '../../src/route/PrismaRouteRegistry.ts'
import {
  createRealPrismaClient,
  readRealPostgresConfig,
  runId,
  type RealPrismaClient,
} from '../support/realPostgres.ts'

const config = readRealPostgresConfig()

async function createConversation(
  client: RealPrismaClient,
  accountId: string,
  conversationKey: string,
  state: 'active' | 'unresolved' | 'conflicted' | 'retired' = 'active',
  routeVersion = 1,
): Promise<void> {
  await client.maxRouteConversation.create({
    data: {
      id: runId('route'), accountId, conversationKey, routeVersion, optimisticVersion: 0, state,
      ...(state === 'retired' ? { retiredAt: new Date(), retiredBy: 'stage4-test', retirementReason: 'synthetic retired route' } : {}),
    },
  })
  if (state === 'active') {
    for (const [identityKind, identityValue] of [
      ['protocol_chat_id', `${conversationKey}-protocol`],
      ['provider_user_id', `${conversationKey}-provider`],
      ['web_route_id', `${conversationKey}-web`],
    ]) {
      await client.maxRouteIdentityBinding.create({
        data: {
          id: runId('binding'), accountId, identityKind, identityValue, conversationKey, status: 'active',
          firstSeenAt: new Date(), lastSeenAt: new Date(), evidenceRef: runId('evidence'), version: routeVersion,
        },
      })
    }
  }
}

function command(
  accountId: string,
  conversationKey: string,
  commandId: string,
  clientMessageId: string,
  text = '  exact real PostgreSQL text Привет\n',
): EnqueueOutboundCommandInput {
  return { commandId, accountId, conversationKey, clientMessageId, commandKind: 'text', text, source: 'synthetic_test' }
}

async function rejectsCode(operation: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, error => error instanceof OutboundActorError && error.code === code)
}

async function listAll(
  actor: PrismaPerConversationOutboundActor,
  accountId: string,
  conversationKey: string,
): Promise<OutboundCommand[]> {
  const commands: OutboundCommand[] = []
  let sequence = 0
  for (;;) {
    const page = await actor.listCommandsAfter(accountId, conversationKey, sequence, 100)
    commands.push(...page.commands)
    if (page.commands.length < 100) return commands
    sequence = page.nextSequence
  }
}

if (config === null) {
  test('real PostgreSQL outbound gate requires PERSONAL_MAX_REAL_POSTGRES_URL', { skip: true }, () => {})
} else {
  describe('Stage 4 real PostgreSQL outbound actor semantics', { concurrency: false }, () => {
    let client: RealPrismaClient
    let actor: PrismaPerConversationOutboundActor

    before(async () => {
      client = await createRealPrismaClient(config)
      actor = new PrismaPerConversationOutboundActor(client as any, new PrismaRouteRegistry(client as any))
    })

    after(async () => {
      await client.$disconnect()
    })

    test('S4-DB-01..15 enqueue is FIFO, physical, idempotent, exact, isolated, and rollback-safe', async () => {
      const account = runId('s4_enqueue')
      const conversation = runId('conversation')
      await createConversation(client, account, conversation)
      const firstInput = command(account, conversation, runId('command'), runId('client'))
      const first = await actor.enqueueCommand(firstInput)
      const second = await actor.enqueueCommand(command(account, conversation, runId('command'), runId('client'), firstInput.text))
      const byCommand = await actor.enqueueCommand(firstInput)
      const byClient = await actor.enqueueCommand({ ...firstInput, commandId: runId('alternate') })
      assert.deepEqual([first.command.commandSequence, second.command.commandSequence], [1, 2])
      assert.equal((first.command.commandPayload as { text: string }).text, firstInput.text)
      assert.equal(first.command.envelopeVersion, OUTBOUND_COMMAND_ENVELOPE_VERSION)
      assert.equal(byCommand.idempotencyKey, 'command_id')
      assert.equal(byClient.idempotencyKey, 'client_message_id')
      assert.equal(first.command.payloadSha256, second.command.payloadSha256)
      await rejectsCode(actor.enqueueCommand({ ...firstInput, text: 'conflicting text' }), 'COMMAND_IDEMPOTENCY_CONFLICT')
      await rejectsCode(actor.enqueueCommand({ ...firstInput, commandId: runId('conflict'), text: 'conflicting text' }), 'CLIENT_MESSAGE_ID_CONFLICT')

      const rollbackAccount = runId('s4_rollback')
      const rollbackConversation = runId('conversation')
      const rejectedCommand = runId('reject_command')
      await createConversation(client, rollbackAccount, rollbackConversation)
      await client.$executeRawUnsafe(`CREATE FUNCTION stage4_test_reject_command() RETURNS trigger AS $$
        BEGIN IF NEW."commandId" = '${rejectedCommand}' THEN RAISE EXCEPTION 'synthetic reject'; END IF; RETURN NEW; END;
        $$ LANGUAGE plpgsql`)
      await client.$executeRawUnsafe(`CREATE TRIGGER stage4_test_reject_command_trigger BEFORE INSERT ON "MaxOutboundCommand"
        FOR EACH ROW EXECUTE FUNCTION stage4_test_reject_command()`)
      try {
        await rejectsCode(actor.enqueueCommand(command(rollbackAccount, rollbackConversation, rejectedCommand, runId('client'))), 'DATABASE_FAILURE')
      } finally {
        await client.$executeRawUnsafe('DROP TRIGGER stage4_test_reject_command_trigger ON "MaxOutboundCommand"')
        await client.$executeRawUnsafe('DROP FUNCTION stage4_test_reject_command()')
      }
      assert.equal(await client.maxOutboundCommand.count({ where: { accountId: rollbackAccount } }), 0)
      assert.equal(await client.maxOutboundConversationActor.count({ where: { accountId: rollbackAccount } }), 0)
      const afterRollback = await actor.enqueueCommand(command(rollbackAccount, rollbackConversation, runId('command'), runId('client')))
      assert.equal(afterRollback.command.commandSequence, 1)
    })

    test('S4-DB-16..25 account/conversation FKs and client/command identities remain isolated', async () => {
      const accountA = runId('s4_scope_a')
      const accountB = runId('s4_scope_b')
      const conversationA = runId('conversation_a')
      const conversationB = runId('conversation_b')
      const sharedClient = runId('shared_client')
      await createConversation(client, accountA, conversationA)
      await createConversation(client, accountA, conversationB)
      await createConversation(client, accountB, conversationA)
      const a = await actor.enqueueCommand(command(accountA, conversationA, runId('command_a'), sharedClient, 'same'))
      const b = await actor.enqueueCommand(command(accountB, conversationA, runId('command_b'), sharedClient, 'same'))
      const otherConversation = await actor.enqueueCommand(command(accountA, conversationB, runId('command_c'), runId('client'), 'same'))
      assert.deepEqual([a.command.commandSequence, b.command.commandSequence, otherConversation.command.commandSequence], [1, 1, 1])
      assert.equal(await actor.getCommand(accountB, a.command.commandId), null)
      assert.equal((await actor.listCommandsAfter(accountA, conversationA, 0, 10)).commands.length, 1)
      await rejectsCode(actor.enqueueCommand(command(accountB, conversationB, runId('cross_account'), runId('client'))), 'NOT_FOUND')
      await assert.rejects(client.maxOutboundCommand.create({
        data: {
          commandId: runId('fk_mismatch'), accountId: accountB, conversationKey: conversationB,
          clientMessageId: null, commandSequence: 1, commandKind: 'text', envelopeVersion: OUTBOUND_COMMAND_ENVELOPE_VERSION,
          commandPayload: { kind: 'text', text: 'synthetic' }, payloadSha256: 'a'.repeat(64), source: 'synthetic_test',
        },
      }))
    })

    test('S4-DB-26..40 command immutability, partial uniqueness, checks, and GUC bypass are enforced', async () => {
      const account = runId('s4_constraints')
      const conversation = runId('conversation')
      await createConversation(client, account, conversation)
      const stored = await actor.enqueueCommand(command(account, conversation, runId('immutable'), runId('client'), 'immutable synthetic'))
      await assert.rejects(client.maxOutboundCommand.update({ where: { commandId: stored.command.commandId }, data: { source: 'api' } }))
      await assert.rejects(client.maxOutboundCommand.delete({ where: { commandId: stored.command.commandId } }))
      await client.$executeRawUnsafe(`SELECT set_config('max.allow_outbound_command_retention', 'on', false)`)
      await assert.rejects(client.maxOutboundCommand.update({ where: { commandId: stored.command.commandId }, data: { source: 'api' } }))
      await assert.rejects(client.maxOutboundCommand.create({
        data: {
          commandId: runId('duplicate_sequence'), accountId: account, conversationKey: conversation,
          clientMessageId: null, commandSequence: 1, commandKind: 'text', envelopeVersion: OUTBOUND_COMMAND_ENVELOPE_VERSION,
          commandPayload: { kind: 'text', text: 'duplicate' }, payloadSha256: 'b'.repeat(64), source: 'synthetic_test',
        },
      }))
      await assert.rejects(client.maxOutboundConversationActor.update({
        where: { accountId_conversationKey: { accountId: account, conversationKey: conversation } },
        data: { leaseOwnerId: null, leaseUntil: new Date() },
      }))
      await assert.rejects(client.maxOutboundCommand.create({
        data: {
          commandId: runId('duplicate_client'), accountId: account, conversationKey: conversation,
          clientMessageId: stored.command.clientMessageId, commandSequence: 2, commandKind: 'text',
          envelopeVersion: OUTBOUND_COMMAND_ENVELOPE_VERSION, commandPayload: { kind: 'text', text: 'same client' },
          payloadSha256: 'c'.repeat(64), source: 'synthetic_test',
        },
      }))
      const reservedAt = new Date()
      const validReservation = {
        reservationId: runId('direct_reservation'), accountId: account, conversationKey: conversation,
        commandId: stored.command.commandId, commandSequence: stored.command.commandSequence,
        leaseOwnerId: 'direct-owner', leaseEpoch: 1, reservationState: 'reserved', reservationVersion: 0,
        reservedAt, leaseUntil: new Date(reservedAt.valueOf() + 10_000),
      }
      await client.maxOutboundCommandReservation.create({ data: validReservation })
      await assert.rejects(client.maxOutboundCommandReservation.create({
        data: { ...validReservation, reservationId: runId('duplicate_active') },
      }))
      await assert.rejects(client.maxOutboundCommandReservation.create({
        data: { ...validReservation, reservationId: runId('invalid_state'), reservationState: 'invalid' },
      }))
      await assert.rejects(client.maxOutboundCommandReservation.create({
        data: {
          ...validReservation, reservationId: runId('invalid_handoff'), reservationState: 'handed_off',
          handoffReference: null, handedOffAt: new Date(),
        },
      }))
      await assert.rejects(client.maxOutboundCommandReservation.create({
        data: {
          ...validReservation, reservationId: runId('negative_epoch'), reservationState: 'released',
          leaseEpoch: -1, releasedAt: new Date(),
        },
      }))
      assert.equal(await client.maxOutboundCommand.count({ where: { accountId: account } }), 1)
    })

    test('S4-DB-41..65 lease, FIFO reservation, route preparation, release, expiry, and handoff guard pass', async () => {
      const account = runId('s4_actor')
      const active = runId('active')
      const unresolved = runId('unresolved')
      const conflicted = runId('conflicted')
      const retired = runId('retired')
      await createConversation(client, account, active, 'active', 3)
      await createConversation(client, account, unresolved, 'unresolved')
      await createConversation(client, account, conflicted, 'conflicted')
      await createConversation(client, account, retired, 'retired')
      await actor.enqueueCommand(command(account, active, runId('head_1'), runId('client')))
      await actor.enqueueCommand(command(account, active, runId('head_2'), runId('client')))
      const lease = await actor.acquireActorLease({ accountId: account, conversationKey: active, ownerId: 'owner-a', leaseMilliseconds: 30_000 })
      await rejectsCode(actor.acquireActorLease({ accountId: account, conversationKey: active, ownerId: 'owner-b' }), 'LEASE_HELD')
      const reservation = await actor.reserveNextCommand({
        accountId: account, conversationKey: active, ownerId: 'owner-a', leaseEpoch: lease.leaseEpoch,
        expectedActorVersion: lease.optimisticVersion,
      })
      assert.equal(reservation.status, 'reserved')
      if (reservation.status !== 'reserved') return
      assert.equal(reservation.command.commandSequence, 1)
      await client.maxRouteConversation.update({
        where: { accountId_conversationKey: { accountId: account, conversationKey: active } },
        data: { routeVersion: { increment: 1 }, optimisticVersion: { increment: 1 } },
      })
      const prepared = await actor.prepareReservedCommand({
        accountId: account, conversationKey: active, reservationId: reservation.reservation.reservationId,
        ownerId: 'owner-a', leaseEpoch: lease.leaseEpoch, expectedActorVersion: lease.optimisticVersion,
        expectedReservationVersion: 0,
      })
      assert.equal(prepared.routeVersion, 4)
      assert.equal(prepared.activeProtocolChatId, `${active}-protocol`)
      assert.equal(prepared.physicalSendAuthorized, false)

      await rejectsCode(actor.markReservationHandedOff({
        accountId: account, conversationKey: active, reservationId: reservation.reservation.reservationId,
        ownerId: 'owner-a', leaseEpoch: lease.leaseEpoch, expectedActorVersion: lease.optimisticVersion,
        expectedReservationVersion: 0, handoffReference: runId('future_boundary'),
      }), 'DISPATCH_LEDGER_REQUIRED')
      assert.equal((await client.maxOutboundCommandReservation.findUnique({ where: { reservationId: reservation.reservation.reservationId } })).reservationState, 'reserved')
      assert.equal((await actor.getActorState(account, active))?.nextHandoffSequence, 1)

      for (const route of [unresolved, conflicted, retired]) {
        await actor.enqueueCommand(command(account, route, runId('route_command'), runId('client')))
        const routeLease = await actor.acquireActorLease({ accountId: account, conversationKey: route, ownerId: `owner-${route}` })
        const routeReservation = await actor.reserveNextCommand({
          accountId: account, conversationKey: route, ownerId: `owner-${route}`, leaseEpoch: routeLease.leaseEpoch,
          expectedActorVersion: routeLease.optimisticVersion,
        })
        if (routeReservation.status !== 'reserved') throw new Error('expected route reservation')
        await rejectsCode(actor.prepareReservedCommand({
          accountId: account, conversationKey: route, reservationId: routeReservation.reservation.reservationId,
          ownerId: `owner-${route}`, leaseEpoch: routeLease.leaseEpoch, expectedActorVersion: routeLease.optimisticVersion,
          expectedReservationVersion: 0,
        }), 'ROUTE_NOT_SENDABLE')
      }
    })

    test('S4-DB-66..78 restart recovery preserves command order and lease epoch', async () => {
      const account = runId('s4_restart')
      const conversation = runId('conversation')
      await createConversation(client, account, conversation)
      for (let index = 1; index <= 20; index += 1) {
        await actor.enqueueCommand(command(account, conversation, runId('restart_command'), runId('client'), `restart-${index}`))
      }
      const lease = await actor.acquireActorLease({ accountId: account, conversationKey: conversation, ownerId: 'restart-owner' })
      const restartedClient = await createRealPrismaClient(config)
      try {
        const restarted = new PrismaPerConversationOutboundActor(restartedClient as any, new PrismaRouteRegistry(restartedClient as any))
        assert.deepEqual((await listAll(restarted, account, conversation)).map(item => item.commandSequence), Array.from({ length: 20 }, (_, i) => i + 1))
        assert.equal((await restarted.getActorState(account, conversation))?.leaseEpoch, lease.leaseEpoch)
      } finally {
        await restartedClient.$disconnect()
      }
    })

    test('S4-DB-79..90 catalog exposes required tables, partial indexes, FKs, checks, and append-only trigger', async () => {
      const tables = await client.$queryRawUnsafe<Array<{ table_name: string }>>(`SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN
          ('MaxOutboundCommand', 'MaxOutboundCommandReservation', 'MaxOutboundConversationActor')
        ORDER BY table_name`)
      assert.deepEqual(tables.map(row => row.table_name), [
        'MaxOutboundCommand', 'MaxOutboundCommandReservation', 'MaxOutboundConversationActor',
      ])
      const indexes = await client.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(`SELECT indexname, indexdef
        FROM pg_indexes WHERE schemaname = 'public' AND tablename IN
          ('MaxOutboundCommand', 'MaxOutboundCommandReservation', 'MaxOutboundConversationActor')`)
      for (const name of [
        'MaxOutboundCommand_account_client_message_key',
        'MaxOutboundCommandReservation_active_command_key',
        'MaxOutboundCommandReservation_active_conversation_key',
      ]) assert.match(indexes.find(index => index.indexname === name)?.indexdef ?? '', /WHERE/)
      assert.equal(indexes.some(index => /UNIQUE.*(?:commandPayload|payloadSha256)/i.test(index.indexdef)), false)
      const triggers = await client.$queryRawUnsafe<Array<{ tgname: string }>>(`SELECT tgname FROM pg_trigger
        WHERE NOT tgisinternal AND tgrelid = '"MaxOutboundCommand"'::regclass`)
      assert.deepEqual(triggers.map(row => row.tgname), ['MaxOutboundCommand_append_only'])
      const forbiddenTables = await client.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*)::bigint AS count FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE '%ProviderConfirmation%'`)
      assert.equal(Number(forbiddenTables[0]?.count), 0)
    })

    test('S4-LOAD 1000 FIFO, 1000 interleaved A/B, 100 identical, and new-client restart have zero loss', async () => {
      const account = runId('s4_load')
      const single = runId('single')
      const a = runId('a')
      const b = runId('b')
      const identical = runId('identical')
      for (const conversation of [single, a, b, identical]) await createConversation(client, account, conversation)
      for (let index = 1; index <= 1000; index += 1) {
        await actor.enqueueCommand(command(account, single, runId('load_single'), runId('client'), `single-${index}`))
      }
      for (let index = 1; index <= 1000; index += 1) {
        const conversation = index % 2 === 0 ? a : b
        await actor.enqueueCommand(command(account, conversation, runId('load_interleaved'), runId('client'), `interleaved-${index}`))
      }
      for (let index = 1; index <= 100; index += 1) {
        await actor.enqueueCommand(command(account, identical, runId('load_identical'), runId('client'), 'identical-message'))
      }
      const restartedClient = await createRealPrismaClient(config)
      try {
        const restarted = new PrismaPerConversationOutboundActor(restartedClient as any, new PrismaRouteRegistry(restartedClient as any))
        const singleRows = await listAll(restarted, account, single)
        const aRows = await listAll(restarted, account, a)
        const bRows = await listAll(restarted, account, b)
        const identicalRows = await listAll(restarted, account, identical)
        assert.deepEqual(singleRows.map(row => row.commandSequence), Array.from({ length: 1000 }, (_, i) => i + 1))
        assert.deepEqual(aRows.map(row => row.commandSequence), Array.from({ length: 500 }, (_, i) => i + 1))
        assert.deepEqual(bRows.map(row => row.commandSequence), Array.from({ length: 500 }, (_, i) => i + 1))
        assert.equal(identicalRows.length, 100)
        assert.equal(new Set(identicalRows.map(row => row.payloadSha256)).size, 1)
        assert.equal(new Set([...singleRows, ...aRows, ...bRows, ...identicalRows].map(row => row.commandId)).size, 2100)
        console.log('STAGE4_LOAD', JSON.stringify({ single: 1000, interleavedA: 500, interleavedB: 500, identical: 100, loss: 0, unexpectedDuplicates: 0, wrongConversation: 0, fifoPercent: 100, restart: 'PASS' }))
      } finally {
        await restartedClient.$disconnect()
      }
    })
  })
}
