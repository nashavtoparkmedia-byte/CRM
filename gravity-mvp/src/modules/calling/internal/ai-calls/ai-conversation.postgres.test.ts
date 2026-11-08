import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
  AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1,
  START_AI_CONVERSATION_COMMAND_V1,
  type AiConversationSimulationVariantV1,
} from '@/contracts/calling/v1/ai-conversation'
import type { ContactCommunicationPermissionResultV1, ContactPersonCardResultV1 } from '@/contracts/contacts/v1'
import {
  aiConversationId,
  aiConversationOccupies,
  createAiConversationOperations,
  type AiConversationRecordV1,
} from '../../application/ai-conversation'
import { readAiCallLifecycleJournal } from '../../application/ai-call-lifecycle'
import { AiCallLifecycleConflictError } from '../../application/ai-call-lifecycle'
import { appendAiCallTranscriptMessage, changeAiCallLifecycle } from '../../application/ai-call-callback-runtime'
import { AI_CONVERSATION_METADATA_KEY, aiConversationPrismaStore } from './ai-conversation-prisma-adapter'
import { AI_CONVERSATION_SIMULATED_SCRIPT, aiConversationSimulatedProvider } from './ai-conversation-simulated-provider'

const postgresProof = process.env.YOKO_AI_CALL_POSTGRES_PROOF === '1' ? describe : describe.skip
const PREFIX = 'ai-conversation-proof-v1'
const PHONE = '+79160000101'
/** The proof's own clock: every driven step moves it past the simulator's next due time. */
let clock = Date.now()
const step = () => { clock += 5_000 }

let contactSeq = 0
async function contact(): Promise<string> {
  contactSeq += 1
  const id = `${PREFIX}-contact-${contactSeq}`
  await prisma.contact.create({ data: { id, displayName: `Proof person ${contactSeq}` } })
  return id
}

function personFor(contactId: string): ContactPersonCardResultV1 {
  return {
    contract: 'contacts.ContactPersonCardResult.v1',
    status: 'confirmed',
    card: {
      contactId, displayName: 'Proof', displayTitle: 'Proof', primaryPhone: PHONE, displayNameSource: 'manual', source: 'manual',
      personConfirmation: { state: 'confirmed', confirmedPersonName: 'Proof', confirmedClusterKeyCount: 1, representativeDriverId: null },
      mainDriverId: null, legacyYandexDriverId: null,
      phones: [{ phoneId: 'p', phone: PHONE, isPrimary: true, isActive: true, lifecycle: 'current', trust: 'manually_verified', freshness: 'fresh', resolutionState: 'unique', verifiedAt: null, lastSeenAt: null }],
      channels: [], lineage: { contactIds: [contactId], mergedFromCount: 0, mergeHistory: [] },
      conflicts: [], hasOpenConflict: false, hasPersonBlockingConflict: false, candidates: [],
      automation: { doNotMerge: false, canonicalPinned: false, mergeRecoveryState: null }, isArchived: false,
    },
  } as unknown as ContactPersonCardResultV1
}

const allow = (contactId: string): ContactCommunicationPermissionResultV1 => ({
  contract: 'contacts.ContactCommunicationPermissionResult.v1', decision: 'allow', retryable: false, reason: 'no_restriction',
  requestedContactId: contactId, communicationClass: 'voice', canonicalContactId: contactId, policyVersion: 0,
})

/** A fresh composition, as a freshly started process would build it: no timers, real store, real Core. */
function operations(options: { permission?: (contactId: string) => Promise<ContactCommunicationPermissionResultV1> } = {}) {
  return createAiConversationOperations({
    mode: async () => 'simulated',
    principal: async () => ({ kind: 'integration_admin_session' }),
    readPerson: async contactId => personFor(contactId),
    voicePermission: options.permission ?? (async contactId => allow(contactId)),
    store: aiConversationPrismaStore,
    provider: aiConversationSimulatedProvider,
    now: () => new Date(clock),
    wake: () => undefined,
  })
}

async function driveToEnd(ops: ReturnType<typeof operations>, id: string, maxSteps = 40) {
  for (let index = 0; index < maxSteps; index += 1) {
    step()
    const snapshot = await ops.advance(id)
    const row = await prisma.call.findUnique({ where: { id }, select: { endedAt: true, metadata: true } })
    const record = (row?.metadata as Record<string, unknown> | null)?.[AI_CONVERSATION_METADATA_KEY] as AiConversationRecordV1 | undefined
    if (row?.endedAt || record?.terminal) return snapshot
  }
  throw new Error('conversation did not end')
}

async function start(ops: ReturnType<typeof operations>, contactId: string, requestId: string, variant: AiConversationSimulationVariantV1 = 'success') {
  return ops.start({ contract: START_AI_CONVERSATION_COMMAND_V1, requestId, contactId, simulationVariant: variant })
}

async function cleanup() {
  await prisma.aiCallMessage.deleteMany({ where: { call: { contactId: { startsWith: PREFIX } } } })
  await prisma.aiCallEvent.deleteMany({ where: { call: { contactId: { startsWith: PREFIX } } } })
  await prisma.call.deleteMany({ where: { contactId: { startsWith: PREFIX } } })
  await prisma.contact.deleteMany({ where: { id: { startsWith: PREFIX } } })
}

postgresProof('AI conversation on PostgreSQL (C4)', () => {
  beforeAll(cleanup)
  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  it('serialises two managers on one person with a durable lock: exactly one Call', async () => {
    const id = await contact()
    const ops = operations()
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => start(ops, id, `${PREFIX}-race-${index}-000000`)))
    expect(results.filter(result => result.status === 'accepted')).toHaveLength(1)
    expect(results.filter(result => result.status === 'refused' && result.reason === 'busy')).toHaveLength(5)
    expect(await prisma.call.count({ where: { contactId: id } })).toBe(1)
  })

  it('replays one requestId racing itself as one conversation', async () => {
    const id = await contact()
    const ops = operations()
    const results = await Promise.all(Array.from({ length: 4 }, () => start(ops, id, `${PREFIX}-same-request-01`)))
    expect(results.every(result => result.status === 'accepted')).toBe(true)
    expect(results.filter(result => result.status === 'accepted' && !result.duplicate)).toHaveLength(1)
    expect(await prisma.call.count({ where: { contactId: id } })).toBe(1)
  })

  it('compare-and-sets the record: of two writers on one revision, one wins', async () => {
    const id = await contact()
    const ops = operations()
    const started = await start(ops, id, `${PREFIX}-cas-request-01`)
    if (started.status !== 'accepted') throw new Error('not accepted')
    const snapshot = (await aiConversationPrismaStore.find(started.conversation.conversationId))!
    const next = { ...snapshot.record, revision: snapshot.record.revision + 1, nextStepAt: new Date().toISOString() }
    const outcomes = await Promise.all([
      aiConversationPrismaStore.transition(snapshot.record.conversationId, snapshot.record.revision, next),
      aiConversationPrismaStore.transition(snapshot.record.conversationId, snapshot.record.revision, next),
    ])
    expect(outcomes.filter(Boolean)).toHaveLength(1)
  })

  it('never overwrites a concurrent Core journal write when it moves its own record', async () => {
    const id = await contact()
    const ops = operations()
    const started = await start(ops, id, `${PREFIX}-merge-request-01`)
    if (started.status !== 'accepted') throw new Error('not accepted')
    const conversationId = started.conversation.conversationId
    const snapshot = (await aiConversationPrismaStore.find(conversationId))!
    const next = { ...snapshot.record, revision: snapshot.record.revision + 1, nextStepAt: new Date(clock + 1_000).toISOString() }
    const [moved, appended] = await Promise.all([
      aiConversationPrismaStore.transition(conversationId, snapshot.record.revision, next),
      appendAiCallTranscriptMessage(conversationId, {
        messageId: `${conversationId}:race:1`, ordinal: 1, segmentRevision: 1, role: 'assistant',
        content: 'concurrent Core write', final: true, source: 'calling_mock',
      }),
    ])
    expect(moved).not.toBeNull()
    expect(appended.kind).toBe('applied')
    const after = (await aiConversationPrismaStore.find(conversationId))!
    expect(after.record.revision).toBe(snapshot.record.revision + 1)
    expect(after.facts.transcript.map(line => line.text)).toEqual(['concurrent Core write'])
  })

  it('plays a full simulated conversation through the Calling Core and keeps it after a restart', async () => {
    const id = await contact()
    const before = await prisma.contact.findUnique({ where: { id }, select: { updatedAt: true, customFields: true } })
    const first = operations()
    const started = await start(first, id, `${PREFIX}-full-request-01`)
    if (started.status !== 'accepted') throw new Error('not accepted')
    const conversationId = started.conversation.conversationId
    // The first process drives a few steps, then "dies".
    for (let index = 0; index < 4; index += 1) { step(); await first.advance(conversationId) }
    // A new process resumes from durable state through reads alone.
    const second = operations()
    for (let index = 0; index < 30; index += 1) {
      step()
      const answer = await second.listForContact({ contract: AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1, contactId: id })
      if (answer.status === 'ok' && answer.conversations[0]?.state === 'completed') break
      await second.advance(conversationId)
    }
    const answer = await second.listForContact({ contract: AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1, contactId: id })
    expect(answer).toMatchObject({ status: 'ok', conversations: [expect.objectContaining({ state: 'completed', failure: null })] })
    const view = answer.status === 'ok' ? answer.conversations[0] : null
    expect(view?.transcript.map(line => line.text)).toEqual(AI_CONVERSATION_SIMULATED_SCRIPT.map(line => line.text))
    expect(view?.outcome).toMatchObject({ qualification: 'qualified', score: 82, classification: 'qualified' })

    const call = await prisma.call.findUniqueOrThrow({ where: { id: conversationId } })
    expect(call).toMatchObject({ isAi: true, isSimulation: true, status: 'completed', aiSessionStatus: 'ended', aiOutcome: 'qualified', toNumber: PHONE, fromNumber: '+70000000000' })
    expect(readAiCallLifecycleJournal(call.metadata)?.state).toBe('ended')
    expect((call.metadata as Record<string, unknown>).providerNetworkUsed).toBe(false)
    expect(await prisma.aiCallMessage.count({ where: { callId: conversationId } })).toBe(AI_CONVERSATION_SIMULATED_SCRIPT.length)

    // A redelivered transcript line is a duplicate; a late lifecycle event cannot reopen the call.
    const replay = await appendAiCallTranscriptMessage(conversationId, {
      messageId: `${conversationId}:line:1`, ordinal: 1, segmentRevision: 1, role: 'assistant',
      content: AI_CONVERSATION_SIMULATED_SCRIPT[0].text, final: true, source: 'calling_mock',
    })
    expect(replay.kind).toBe('duplicate')
    await expect(changeAiCallLifecycle(conversationId, {
      eventId: `late:${conversationId}`, source: 'audio_bridge', sourceSequence: 9, kind: 'conversation_started', target: 'active',
    })).rejects.toBeInstanceOf(AiCallLifecycleConflictError)
    expect(await prisma.aiCallMessage.count({ where: { callId: conversationId } })).toBe(AI_CONVERSATION_SIMULATED_SCRIPT.length)

    // Calling wrote only its own records: the Contact is untouched and no Task was created.
    const after = await prisma.contact.findUnique({ where: { id }, select: { updatedAt: true, customFields: true } })
    expect(after).toEqual(before)
    expect(await prisma.task.count({ where: { contactId: id } })).toBe(0)
  })

  it('records an interrupted conversation as dropped mid-call with its partial transcript', async () => {
    const id = await contact()
    const ops = operations()
    const started = await start(ops, id, `${PREFIX}-interrupt-req-01`, 'interrupted')
    if (started.status !== 'accepted') throw new Error('not accepted')
    await driveToEnd(ops, started.conversation.conversationId)
    const answer = await ops.listForContact({ contract: AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1, contactId: id })
    expect(answer).toMatchObject({ status: 'ok', conversations: [expect.objectContaining({ state: 'interrupted', failure: 'interrupted' })] })
    expect(answer.status === 'ok' && answer.conversations[0].transcript).toHaveLength(3)
    const call = await prisma.call.findUniqueOrThrow({ where: { id: started.conversation.conversationId } })
    expect(call.aiOutcome).toBe('dropped_mid_call')
  })

  it('records a provider rejection as failed, and a lost reply as outcome_unknown that keeps the person occupied', async () => {
    const rejectedContact = await contact()
    const ops = operations()
    const rejected = await start(ops, rejectedContact, `${PREFIX}-reject-req-001`, 'provider_failure')
    if (rejected.status !== 'accepted') throw new Error('not accepted')
    await driveToEnd(ops, rejected.conversation.conversationId)
    const failedCall = await prisma.call.findUniqueOrThrow({ where: { id: rejected.conversation.conversationId } })
    expect(failedCall).toMatchObject({ status: 'failed', aiSessionStatus: 'failed', aiOutcome: 'error', aiOutcomeReason: 'provider_rejected' })
    expect(failedCall.endedAt).not.toBeNull()
    await expect(start(ops, rejectedContact, `${PREFIX}-reject-req-002`)).resolves.toMatchObject({ status: 'accepted' })

    const unknownContact = await contact()
    const unknown = await start(ops, unknownContact, `${PREFIX}-unknown-req-001`, 'unknown_outcome')
    if (unknown.status !== 'accepted') throw new Error('not accepted')
    await driveToEnd(ops, unknown.conversation.conversationId)
    const snapshot = (await aiConversationPrismaStore.find(unknown.conversation.conversationId))!
    expect(snapshot.record.effect.phase).toBe('outcome_unknown')
    expect(aiConversationOccupies(snapshot, new Date(clock + 3_600_000))).toBe(false)
    expect(aiConversationOccupies(snapshot, new Date(Date.parse(snapshot.record.effect.dispatchStartedAt!) + 1_000))).toBe(true)
  })

  it('never reaches the provider when denyVoice is set after the start', async () => {
    const id = await contact()
    let calls = 0
    const ops = operations({
      permission: async contactId => {
        calls += 1
        return calls === 1 ? allow(contactId) : { ...allow(contactId), decision: 'deny', reason: 'restricted_voice' }
      },
    })
    const started = await start(ops, id, `${PREFIX}-deny-request-01`)
    if (started.status !== 'accepted') throw new Error('not accepted')
    await driveToEnd(ops, started.conversation.conversationId)
    const call = await prisma.call.findUniqueOrThrow({ where: { id: started.conversation.conversationId } })
    const record = (call.metadata as Record<string, unknown>)[AI_CONVERSATION_METADATA_KEY] as AiConversationRecordV1
    expect(record.effect.phase).toBe('prepared')
    expect(record.terminal).toMatchObject({ state: 'refused', failure: 'voice_restricted' })
    expect(call).toMatchObject({ status: 'cancelled', answeredAt: null })
    expect(await prisma.aiCallMessage.count({ where: { callId: call.id } })).toBe(0)
  })

  it('derives the same conversation id for the same person and request', () => {
    expect(aiConversationId(`${PREFIX}-x`, 'request-0000000001')).toBe(aiConversationId(`${PREFIX}-x`, 'request-0000000001'))
  })
})
