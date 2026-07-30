import { PrismaClient } from '@prisma/client'
import { PrismaDispatchLedger } from '../dispatch/PrismaDispatchLedger.ts'
import { PrismaRouteRegistry } from '../route/PrismaRouteRegistry.ts'

const INCIDENT_FROM = new Date('2026-07-30T09:07:00.000Z')
const INCIDENT_TO = new Date('2026-07-30T09:13:00.000Z')
const PROVIDER_ID = /^d301[0-9a-f]{14}$/iu
const EXPECTED_TEXT_BY_SEQUENCE = new Map<number, string>([
  [3, 'Тест Personal MAX 1'],
  [4, 'Одинаковое сообщение'],
  [5, 'Одинаковое сообщение'],
  [6, 'Одинаковое сообщение'],
  [7, 'Одинаковое сообщение'],
  [8, 'Сообщение 1'],
  [9, 'Сообщение 2'],
  [10, 'Сообщение 3'],
])

function requireExactEnvironment(name: string, pattern: RegExp): string {
  const value = process.env[name] ?? ''
  if (!pattern.test(value)) throw new Error(`INVALID_${name}`)
  return value
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function commandText(command: any): string {
  return typeof command?.commandPayload?.text === 'string' ? command.commandPayload.text : ''
}

async function main(): Promise<void> {
  if (process.env.PERSONAL_MAX_UAT_REPAIR_MODE !== 'uat-failure-20260730-exact') {
    throw new Error('REPAIR_MODE_DENIED')
  }
  const databaseUrl = requireExactEnvironment('MAX_PERSONAL_GATEWAY_DATABASE_URL', /^postgresql:\/\/[^\s]+$/u)
  const expectedDatabase = requireExactEnvironment('PERSONAL_MAX_UAT_REPAIR_DATABASE_NAME', /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u)
  const accountId = requireExactEnvironment('MAX_PERSONAL_ACCOUNT_ID', /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)
  const sequence5ProviderId = requireExactEnvironment('PERSONAL_MAX_UAT_REPAIR_SEQUENCE5_PROVIDER_ID', PROVIDER_ID).toLowerCase()
  const replayProviderId = requireExactEnvironment('PERSONAL_MAX_UAT_REPAIR_REPLAY_PROVIDER_ID', PROVIDER_ID).toLowerCase()
  if (sequence5ProviderId === replayProviderId) throw new Error('PROVIDER_EVIDENCE_COLLISION')

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  await prisma.$connect()
  try {
    const database = await prisma.$queryRawUnsafe<Array<{ database_name: string }>>(
      'SELECT current_database() AS database_name',
    )
    if (database[0]?.database_name !== expectedDatabase) throw new Error('DATABASE_BINDING_MISMATCH')

    const commands = await prisma.maxOutboundCommand.findMany({
      where: {
        accountId,
        createdAt: { gte: INCIDENT_FROM, lt: INCIDENT_TO },
        commandKind: 'text',
      },
      orderBy: { commandSequence: 'asc' },
    })
    const incidentCommands = commands.filter(command =>
      Array.from(EXPECTED_TEXT_BY_SEQUENCE.values()).includes(commandText(command)),
    )
    if (incidentCommands.length !== EXPECTED_TEXT_BY_SEQUENCE.size) throw new Error('COMMAND_COUNT_MISMATCH')
    const conversationKeys = new Set(incidentCommands.map(command => command.conversationKey))
    if (conversationKeys.size !== 1) throw new Error('CONVERSATION_SCOPE_MISMATCH')
    const conversationKey = incidentCommands[0]!.conversationKey
    const commandBySequence = new Map(incidentCommands.map(command => [command.commandSequence, command]))
    for (const [sequence, text] of EXPECTED_TEXT_BY_SEQUENCE) {
      const command = commandBySequence.get(sequence)
      if (command === undefined || commandText(command) !== text || command.clientMessageId === null) {
        throw new Error('COMMAND_SHAPE_MISMATCH')
      }
    }

    const dispatches = await prisma.maxOutboundDispatch.findMany({
      where: { accountId, conversationKey, commandSequence: { in: Array.from(EXPECTED_TEXT_BY_SEQUENCE.keys()) } },
      orderBy: { commandSequence: 'asc' },
    })
    if (dispatches.length !== EXPECTED_TEXT_BY_SEQUENCE.size) throw new Error('DISPATCH_COUNT_MISMATCH')
    const dispatchBySequence = new Map(dispatches.map(dispatch => [dispatch.commandSequence, dispatch]))
    for (const [sequence, command] of commandBySequence) {
      if (dispatchBySequence.get(sequence)?.commandId !== command.commandId) throw new Error('DISPATCH_COMMAND_MISMATCH')
    }

    const baselineConfirmed = [3, 4].map(sequence => dispatchBySequence.get(sequence)!)
    if (baselineConfirmed.some(dispatch => dispatch.state !== 'provider_confirmed' || !PROVIDER_ID.test(dispatch.providerMessageId ?? ''))) {
      throw new Error('BASELINE_CONFIRMATION_MISMATCH')
    }
    const sequence5 = dispatchBySequence.get(5)!
    if (!['awaiting_confirmation', 'provider_confirmed'].includes(sequence5.state)) {
      throw new Error('SEQUENCE5_STATE_MISMATCH')
    }
    for (const sequence of [6, 7, 8, 9, 10]) {
      const dispatch = dispatchBySequence.get(sequence)!
      if (!['queued', 'hard_failed'].includes(dispatch.state)) throw new Error('UNSENT_SEQUENCE_STATE_MISMATCH')
      if (dispatch.attemptCount !== 0 || dispatch.currentAttemptId !== null || dispatch.providerMessageId !== null) {
        throw new Error('UNSENT_SEQUENCE_ACTION_EVIDENCE_MISMATCH')
      }
    }

    const routeRegistry = new PrismaRouteRegistry(prisma as any)
    const ledger = new PrismaDispatchLedger(prisma as any, routeRegistry)
    let currentSequence5 = await prisma.maxOutboundDispatch.findUniqueOrThrow({ where: { dispatchId: sequence5.dispatchId } })
    if (currentSequence5.state === 'awaiting_confirmation') {
      if (currentSequence5.currentAttemptId === null) throw new Error('SEQUENCE5_ATTEMPT_MISSING')
      const attempt = await prisma.maxOutboundDispatchAttempt.findUniqueOrThrow({
        where: { attemptId: currentSequence5.currentAttemptId },
      })
      if (attempt.attemptState !== 'awaiting_confirmation') throw new Error('SEQUENCE5_ATTEMPT_STATE_MISMATCH')
      await ledger.recordExactProviderConfirmation({
        accountId,
        conversationKey,
        dispatchId: currentSequence5.dispatchId,
        attemptId: attempt.attemptId,
        expectedStateVersion: currentSequence5.stateVersion,
        expectedAttemptVersion: attempt.attemptVersion,
        transitionIdempotencyKey: 'uat-20260730:sequence5:exact-confirmation',
        evidenceReference: 'uat-20260730-provider-store-exact',
        providerMessageId: sequence5ProviderId,
      })
      currentSequence5 = await prisma.maxOutboundDispatch.findUniqueOrThrow({ where: { dispatchId: sequence5.dispatchId } })
    }
    if (currentSequence5.state !== 'provider_confirmed'
      || currentSequence5.providerMessageId?.toLowerCase() !== sequence5ProviderId) {
      throw new Error('SEQUENCE5_CONFIRMATION_FAILED')
    }

    for (const sequence of [6, 7, 8, 9, 10]) {
      let dispatch = await prisma.maxOutboundDispatch.findUniqueOrThrow({
        where: { dispatchId: dispatchBySequence.get(sequence)!.dispatchId },
      })
      if (dispatch.state === 'queued') {
        const failed = await ledger.markHardFailed({
          accountId,
          conversationKey,
          dispatchId: dispatch.dispatchId,
          expectedStateVersion: dispatch.stateVersion,
          transitionIdempotencyKey: `uat-20260730:sequence${sequence}:cancel-before-provider`,
          evidenceReference: 'uat-20260730-no-provider-action',
          safeErrorCode: 'UAT_ABORTED_BEFORE_PROVIDER_ACTION',
        })
        dispatch = await prisma.maxOutboundDispatch.findUniqueOrThrow({ where: { dispatchId: failed.dispatch.dispatchId } })
      }
      if (dispatch.state !== 'hard_failed') throw new Error('TERMINAL_CLASSIFICATION_FAILED')
      const lane = await prisma.maxOutboundDispatchLane.findUniqueOrThrow({
        where: { accountId_conversationKey: { accountId, conversationKey } },
      })
      if (lane.nextPhysicalSequence === sequence) {
        await ledger.resolveTerminalFailureAndAdvance({
          accountId,
          conversationKey,
          dispatchId: dispatch.dispatchId,
          expectedStateVersion: dispatch.stateVersion,
          transitionIdempotencyKey: `uat-20260730:sequence${sequence}:audited-advance`,
          evidenceReference: 'uat-20260730-terminal-skip-audit',
        })
      } else if (lane.nextPhysicalSequence < sequence) {
        throw new Error('FIFO_ADVANCE_GAP')
      }
    }

    const finalDispatches = await prisma.maxOutboundDispatch.findMany({
      where: { accountId, conversationKey, commandSequence: { in: Array.from(EXPECTED_TEXT_BY_SEQUENCE.keys()) } },
      orderBy: { commandSequence: 'asc' },
    })
    const finalBySequence = new Map(finalDispatches.map(dispatch => [dispatch.commandSequence, dispatch]))
    if ([3, 4, 5].some(sequence => finalBySequence.get(sequence)?.state !== 'provider_confirmed')
      || [6, 7, 8, 9, 10].some(sequence => finalBySequence.get(sequence)?.state !== 'hard_failed')) {
      throw new Error('FINAL_DISPATCH_STATE_MISMATCH')
    }
    const providerIds = [3, 4, 5].map(sequence => finalBySequence.get(sequence)?.providerMessageId?.toLowerCase())
    if (providerIds.some(value => !PROVIDER_ID.test(value ?? '')) || new Set(providerIds).size !== 3) {
      throw new Error('FINAL_PROVIDER_IDENTITY_MISMATCH')
    }
    const lane = await prisma.maxOutboundDispatchLane.findUniqueOrThrow({
      where: { accountId_conversationKey: { accountId, conversationKey } },
    })
    if (lane.nextPhysicalSequence !== 11) throw new Error('FINAL_FIFO_STATE_MISMATCH')
    const openReconciliation = await prisma.maxOutboundReconciliationTask.count({
      where: { accountId, conversationKey, state: 'open' },
    })
    if (openReconciliation !== 0) throw new Error('OPEN_RECONCILIATION_REMAINS')

    for (const sequence of [3, 4, 5]) {
      const command = commandBySequence.get(sequence)!
      const dispatch = finalBySequence.get(sequence)!
      const message = await prisma.message.findUniqueOrThrow({ where: { clientMessageId: command.clientMessageId! } })
      const metadata = object(message.metadata)
      await prisma.message.update({
        where: { id: message.id },
        data: {
          status: 'delivered',
          externalId: dispatch.providerMessageId,
          metadata: {
            ...metadata,
            retryable: false,
            maxDelivery: {
              operation: 'send', status: 'provider_confirmed', deliveryConfirmed: true,
              maxMessageId: dispatch.providerMessageId, externalId: dispatch.providerMessageId,
            },
            personalMaxIncidentDisposition: {
              incident: 'uat-failure-20260730', sequence, evidencePreserved: true,
            },
          },
        },
      })
    }
    for (const sequence of [6, 7, 8, 9, 10]) {
      const command = commandBySequence.get(sequence)!
      const message = await prisma.message.findUniqueOrThrow({ where: { clientMessageId: command.clientMessageId! } })
      const metadata = object(message.metadata)
      await prisma.message.update({
        where: { id: message.id },
        data: {
          status: 'failed',
          metadata: {
            ...metadata,
            retryable: false,
            error: 'Not sent: UAT stopped before provider action',
            errorCode: 'UAT_ABORTED_BEFORE_PROVIDER_ACTION',
            maxDelivery: { operation: 'send', status: 'hard_failed', deliveryConfirmed: false },
            personalMaxIncidentDisposition: {
              incident: 'uat-failure-20260730', sequence,
              kind: 'cancelled_before_provider_action', evidencePreserved: true,
            },
          },
        },
      })
    }

    const replayRows = await prisma.message.findMany({
      where: {
        createdAt: { gte: INCIDENT_FROM, lt: INCIDENT_TO },
        channel: 'max', direction: 'inbound', content: '3', externalId: replayProviderId,
      },
    })
    if (replayRows.length !== 1) throw new Error('HISTORY_REPLAY_ROW_MISMATCH')
    const replay = replayRows[0]!
    await prisma.message.update({
      where: { id: replay.id },
      data: {
        metadata: {
          ...object(replay.metadata),
          personalMaxIngressDisposition: {
            incident: 'uat-failure-20260730', kind: 'history_replay',
            visibility: 'quarantined', evidencePreserved: true,
          },
        },
      },
    })

    console.log(JSON.stringify({
      schemaVersion: 1,
      repair: 'PERSONAL_MAX_UAT_FAILURE_20260730',
      providerConfirmedSequences: [3, 4, 5],
      cancelledBeforeProviderSequences: [6, 7, 8, 9, 10],
      nextPhysicalSequence: lane.nextPhysicalSequence,
      openReconciliation,
      historyReplayQuarantined: 1,
      providerActionsPerformedByRepair: 0,
      evidenceRowsDeleted: 0,
    }))
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(() => {
  console.error('PERSONAL_MAX_UAT_REPAIR_FAILED')
  process.exitCode = 1
})
