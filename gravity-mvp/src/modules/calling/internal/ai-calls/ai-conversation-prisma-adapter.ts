import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  AI_CALL_LIFECYCLE_METADATA_KEY,
  createAiCallLifecycleJournal,
  readAiCallLifecycleJournal,
} from '../../application/ai-call-lifecycle'
import {
  AI_CALL_TRANSCRIPT_METADATA_KEY,
  createAiCallTranscriptJournal,
  readAiCallTranscriptJournal,
} from '../../application/ai-call-transcript'
import {
  aiConversationTimingPolicyV1,
  type AiConversationCallFactsV1,
  type AiConversationClaimResult,
  type AiConversationRecordV1,
  type AiConversationSnapshotV1,
  type AiConversationStorePort,
} from '../../application/ai-conversation'

/** Where Calling keeps its conversation record inside Call.metadata, beside the Core's journals. */
export const AI_CONVERSATION_METADATA_KEY = 'aiConversationV1' as const

/** The simulated caller id: never a real number, never dialled. */
export const AI_CONVERSATION_SIMULATED_CALLER = '+70000000000'

/**
 * Every query names its receiver (`prisma` or the transaction's `tx`), its model and literal
 * select/data shapes at the call site, so the credential and write analyzers resolve exactly
 * which Calling-owned models and fields are touched (Call, AiCallMessage). Helpers below only
 * shape rows that were already read; none of them receives a database handle.
 */
/** The row shape every conversation read selects; each query spells it out literally (see above). */
const CALL_SELECT = {
  id: true, status: true, aiSessionStatus: true, startedAt: true, answeredAt: true, endedAt: true, updatedAt: true,
  aiOutcome: true, aiSummary: true, qualificationScore: true, aiAnalysis: true, metadata: true,
} as const

type ConversationCallRow = Prisma.CallGetPayload<{ select: typeof CALL_SELECT }>
type MessageRow = { id: string; content: string }

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readAiConversationRecord(metadata: unknown): AiConversationRecordV1 | null {
  if (!isRecord(metadata)) return null
  const value = metadata[AI_CONVERSATION_METADATA_KEY]
  if (!isRecord(value) || value.version !== 1 || typeof value.conversationId !== 'string' || typeof value.revision !== 'number') return null
  return value as unknown as AiConversationRecordV1
}

export function aiConversationFsUuid(conversationId: string): string {
  return `aiconv-${conversationId.slice('aiconv_'.length)}`
}

function iso(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null
}

function transcriptOf(call: ConversationCallRow, content: Map<string, string>): AiConversationCallFactsV1['transcript'] {
  const journal = readAiCallTranscriptJournal(call.metadata)
  return (journal?.messages ?? [])
    .filter(message => message.final && content.has(message.rowId))
    .sort((left, right) => left.ordinal - right.ordinal)
    .map(message => ({
      ordinal: message.ordinal,
      speaker: message.role === 'user' ? 'person' as const : 'assistant' as const,
      text: content.get(message.rowId) ?? '',
    }))
}

function snapshotOf(call: ConversationCallRow, content: Map<string, string>): AiConversationSnapshotV1 | null {
  const record = readAiConversationRecord(call.metadata)
  if (!record) return null
  const analysis = isRecord(call.aiAnalysis) ? call.aiAnalysis : null
  const qualification = analysis && ['qualified', 'not_qualified', 'unclear'].includes(analysis.qualification_status as string)
    ? analysis.qualification_status as 'qualified' | 'not_qualified' | 'unclear'
    : null
  return {
    record,
    facts: {
      callStatus: call.status,
      aiSessionStatus: call.aiSessionStatus ?? null,
      lifecycleState: readAiCallLifecycleJournal(call.metadata)?.state ?? null,
      startedAt: iso(call.startedAt) ?? record.createdAt,
      answeredAt: iso(call.answeredAt),
      endedAt: iso(call.endedAt),
      updatedAt: iso(call.updatedAt) ?? record.createdAt,
      aiOutcome: call.aiOutcome ?? null,
      aiSummary: call.aiSummary ?? null,
      qualificationScore: typeof call.qualificationScore === 'number' ? call.qualificationScore : null,
      qualification,
      transcript: transcriptOf(call, content),
    },
  }
}

function snapshotsOf(calls: ConversationCallRow[], messages: MessageRow[]): AiConversationSnapshotV1[] {
  const content = new Map(messages.map(row => [row.id, row.content]))
  return calls.map(call => snapshotOf(call, content)).filter((value): value is AiConversationSnapshotV1 => value !== null)
}

async function findWithPrisma(conversationId: string): Promise<AiConversationSnapshotV1 | null> {
  const call = await prisma.call.findUnique({ where: { id: conversationId }, select: {
          id: true, status: true, aiSessionStatus: true, startedAt: true, answeredAt: true, endedAt: true, updatedAt: true,
          aiOutcome: true, aiSummary: true, qualificationScore: true, aiAnalysis: true, metadata: true,
        } })
  if (!call) return null
  const messages = await prisma.aiCallMessage.findMany({ where: { callId: conversationId }, select: { id: true, content: true } })
  return snapshotsOf([call], messages)[0] ?? null
}

async function findWithTransaction(tx: Prisma.TransactionClient, conversationId: string): Promise<AiConversationSnapshotV1 | null> {
  const call = await tx.call.findUnique({ where: { id: conversationId }, select: {
          id: true, status: true, aiSessionStatus: true, startedAt: true, answeredAt: true, endedAt: true, updatedAt: true,
          aiOutcome: true, aiSummary: true, qualificationScore: true, aiAnalysis: true, metadata: true,
        } })
  if (!call) return null
  const messages = await tx.aiCallMessage.findMany({ where: { callId: conversationId }, select: { id: true, content: true } })
  return snapshotsOf([call], messages)[0] ?? null
}

const TRANSITION_ATTEMPTS = 4

/** Prisma's P2034: the transaction lost a write conflict or a deadlock and may be retried. */
function isSerializationFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2034'
}

export const aiConversationPrismaStore: AiConversationStorePort = {
  async find(conversationId) {
    return findWithPrisma(conversationId)
  },

  async claim(record, occupies) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<AiConversationClaimResult> => {
      // One durable writer per person: concurrent starts for the same Contact serialise here,
      // and the loser sees the winner's committed Call below.
      const lockKey = `calling.ai-conversation.contact:${record.contactId}`
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
      const existing = await findWithTransaction(tx, record.conversationId)
      if (existing) return { kind: 'existing', snapshot: existing }
      const now = new Date(record.createdAt)
      const timing = aiConversationTimingPolicyV1()
      const horizon = new Date(now.getTime() - timing.queueHorizonMs - timing.unknownOccupancyMs)
      const recent = await tx.call.findMany({
        where: {
          contactId: record.contactId,
          isAi: true,
          startedAt: { gte: horizon },
          metadata: { path: [AI_CONVERSATION_METADATA_KEY, 'version'], equals: 1 },
        },
        select: {
          id: true, status: true, aiSessionStatus: true, startedAt: true, answeredAt: true, endedAt: true, updatedAt: true,
          aiOutcome: true, aiSummary: true, qualificationScore: true, aiAnalysis: true, metadata: true,
        },
        orderBy: { startedAt: 'desc' },
        take: 50,
      })
      const recentMessages = await tx.aiCallMessage.findMany({
        where: { callId: { in: recent.map(call => call.id) } },
        select: { id: true, content: true },
      })
      for (const snapshot of snapshotsOf(recent, recentMessages)) {
        if (occupies(snapshot, now)) return { kind: 'busy', activeConversationId: snapshot.record.conversationId }
      }
      await tx.call.create({
        data: {
          id: record.conversationId,
          direction: 'outbound',
          status: 'ringing',
          fromNumber: AI_CONVERSATION_SIMULATED_CALLER,
          toNumber: record.destination,
          contactId: record.contactId,
          managerId: null,
          fsUuid: aiConversationFsUuid(record.conversationId),
          startedAt: now,
          isAi: true,
          isSimulation: true,
          aiSessionStatus: 'starting',
          metadata: json({
            simulated: true,
            providerNetworkUsed: false,
            providerBillingIngested: false,
            [AI_CONVERSATION_METADATA_KEY]: record,
            [AI_CALL_LIFECYCLE_METADATA_KEY]: createAiCallLifecycleJournal(record.conversationId, 'starting', false),
            [AI_CALL_TRANSCRIPT_METADATA_KEY]: createAiCallTranscriptJournal(record.conversationId),
          }),
        },
      })
      const created = await findWithTransaction(tx, record.conversationId)
      if (!created) throw new Error('AI_CONVERSATION_CREATE_NOT_VISIBLE')
      return { kind: 'created', snapshot: created }
    })
  },

  async transition(conversationId, expectedRevision, next) {
    // Compare-and-set on the record revision, merging only Calling's own metadata key. The
    // Core's journals live in the same JSON column and are written by other transactions, so
    // this runs in REPEATABLE READ: a concurrent committed write to the row makes this update
    // fail with a serialization error instead of overwriting it, and the step re-reads.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const call = await tx.call.findUnique({ where: { id: conversationId }, select: { id: true, metadata: true, endedAt: true } })
          if (!call) return null
          const current = readAiConversationRecord(call.metadata)
          if (!current || current.revision !== expectedRevision || next.revision !== expectedRevision + 1) return null
          const metadata = json({ ...(isRecord(call.metadata) ? call.metadata : {}), [AI_CONVERSATION_METADATA_KEY]: next })
          const terminal = call.endedAt === null ? next.terminal : null
          if (terminal === null) {
            await tx.call.update({ where: { id: conversationId }, data: { metadata } })
          } else if (terminal.state === 'outcome_unknown') {
            // The effect may still be live: the Call is not ended, only its reason is recorded.
            await tx.call.update({ where: { id: conversationId }, data: { metadata, aiOutcomeReason: 'outcome_unknown' } })
          } else {
            // A pre-answer terminal Calling decided itself; no Core finalization happened.
            await tx.call.update({
              where: { id: conversationId },
              data: {
                metadata,
                status: terminal.state === 'refused' ? 'cancelled' : 'failed',
                aiSessionStatus: 'failed',
                endedAt: new Date(terminal.at),
                aiOutcome: 'error',
                aiOutcomeReason: terminal.failure ?? terminal.state,
              },
            })
          }
          return findWithTransaction(tx, conversationId)
        }, { isolationLevel: 'RepeatableRead' })
      } catch (error) {
        if (!isSerializationFailure(error) || attempt >= TRANSITION_ATTEMPTS) throw error
      }
    }
  },

  async listForContact(contactId, limit) {
    const calls = await prisma.call.findMany({
      where: { contactId, isAi: true, metadata: { path: [AI_CONVERSATION_METADATA_KEY, 'version'], equals: 1 } },
      select: {
          id: true, status: true, aiSessionStatus: true, startedAt: true, answeredAt: true, endedAt: true, updatedAt: true,
          aiOutcome: true, aiSummary: true, qualificationScore: true, aiAnalysis: true, metadata: true,
        },
      orderBy: { startedAt: 'desc' },
      take: limit,
    })
    const messages = await prisma.aiCallMessage.findMany({
      where: { callId: { in: calls.map(call => call.id) } },
      select: { id: true, content: true },
    })
    return snapshotsOf(calls, messages)
  },
}

/** The simulated provider's answer signal: the callee picked up. Only the Call's own columns move. */
export async function markAiConversationAnswered(conversationId: string, at: Date): Promise<void> {
  await prisma.call.updateMany({
    where: { id: conversationId, answeredAt: null, endedAt: null, isSimulation: true },
    data: { answeredAt: at, status: 'active' },
  })
}
