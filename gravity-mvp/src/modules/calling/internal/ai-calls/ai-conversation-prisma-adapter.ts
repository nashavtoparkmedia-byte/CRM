/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma client can lag AI-call model generation */
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
  AI_CONVERSATION_METADATA_KEY,
  AI_CONVERSATION_QUEUE_HORIZON_MS,
  AI_CONVERSATION_UNKNOWN_OCCUPANCY_MS,
  type AiConversationCallFactsV1,
  type AiConversationRecordV1,
  type AiConversationSnapshotV1,
  type AiConversationStorePort,
} from '../../application/ai-conversation'

/** The simulated caller id: never a real number, never dialled. */
export const AI_CONVERSATION_SIMULATED_CALLER = '+70000000000'

const CALL_SELECT = {
  id: true, status: true, aiSessionStatus: true, startedAt: true, answeredAt: true, endedAt: true, updatedAt: true,
  aiOutcome: true, aiSummary: true, qualificationScore: true, aiAnalysis: true, metadata: true,
} as const

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

async function transcriptLines(db: any, calls: Array<{ id: string; metadata: unknown }>): Promise<Map<string, AiConversationCallFactsV1['transcript']>> {
  const ids = calls.map(call => call.id)
  const rows: Array<{ id: string; content: string }> = ids.length === 0 ? [] : await db.aiCallMessage.findMany({
    where: { callId: { in: ids } },
    select: { id: true, content: true },
  })
  const content = new Map(rows.map(row => [row.id, row.content]))
  const result = new Map<string, AiConversationCallFactsV1['transcript']>()
  for (const call of calls) {
    const journal = readAiCallTranscriptJournal(call.metadata)
    const lines = (journal?.messages ?? [])
      .filter(message => message.final && content.has(message.rowId))
      .sort((left, right) => left.ordinal - right.ordinal)
      .map(message => ({
        ordinal: message.ordinal,
        speaker: message.role === 'user' ? 'person' as const : 'assistant' as const,
        text: content.get(message.rowId) ?? '',
      }))
    result.set(call.id, lines)
  }
  return result
}

function snapshotOf(call: any, transcript: AiConversationCallFactsV1['transcript']): AiConversationSnapshotV1 | null {
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
      transcript,
    },
  }
}

async function readSnapshots(db: any, calls: any[]): Promise<AiConversationSnapshotV1[]> {
  const lines = await transcriptLines(db, calls)
  return calls.map(call => snapshotOf(call, lines.get(call.id) ?? [])).filter((value): value is AiConversationSnapshotV1 => value !== null)
}

async function findIn(db: any, conversationId: string): Promise<AiConversationSnapshotV1 | null> {
  const call = await db.call.findUnique({ where: { id: conversationId }, select: CALL_SELECT })
  if (!call) return null
  return (await readSnapshots(db, [call]))[0] ?? null
}

/** Call columns that mirror a pre-answer terminal Calling decided itself (no Core finalization happened). */
function terminalColumns(record: AiConversationRecordV1): Record<string, unknown> {
  const terminal = record.terminal
  if (!terminal) return {}
  if (terminal.state === 'outcome_unknown') return { aiOutcomeReason: 'outcome_unknown' }
  return {
    status: terminal.state === 'refused' ? 'cancelled' : 'failed',
    aiSessionStatus: 'failed',
    endedAt: new Date(terminal.at),
    aiOutcome: 'error',
    aiOutcomeReason: terminal.failure ?? terminal.state,
  }
}

export const aiConversationPrismaStore: AiConversationStorePort = {
  async find(conversationId) {
    return findIn(prisma as any, conversationId)
  },

  async claim(record, occupies) {
    return (prisma as any).$transaction(async (tx: any) => {
      // One durable writer per person: concurrent starts for the same Contact serialise here,
      // and the loser sees the winner's committed Call below.
      const lockKey = `calling.ai-conversation.contact:${record.contactId}`
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
      const existing = await findIn(tx, record.conversationId)
      if (existing) return { kind: 'existing' as const, snapshot: existing }
      const now = new Date(record.createdAt)
      const horizon = new Date(now.getTime() - AI_CONVERSATION_QUEUE_HORIZON_MS - AI_CONVERSATION_UNKNOWN_OCCUPANCY_MS)
      const recent = await tx.call.findMany({
        where: {
          contactId: record.contactId,
          isAi: true,
          startedAt: { gte: horizon },
          metadata: { path: [AI_CONVERSATION_METADATA_KEY, 'version'], equals: 1 },
        },
        select: CALL_SELECT,
        orderBy: { startedAt: 'desc' },
        take: 50,
      })
      for (const snapshot of await readSnapshots(tx, recent)) {
        if (occupies(snapshot, now)) return { kind: 'busy' as const, activeConversationId: snapshot.record.conversationId }
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
          metadata: {
            simulated: true,
            providerNetworkUsed: false,
            providerBillingIngested: false,
            [AI_CONVERSATION_METADATA_KEY]: record,
            [AI_CALL_LIFECYCLE_METADATA_KEY]: createAiCallLifecycleJournal(record.conversationId, 'starting', false),
            [AI_CALL_TRANSCRIPT_METADATA_KEY]: createAiCallTranscriptJournal(record.conversationId),
          },
        },
      })
      const created = await findIn(tx, record.conversationId)
      if (!created) throw new Error('AI_CONVERSATION_CREATE_NOT_VISIBLE')
      return { kind: 'created' as const, snapshot: created }
    })
  },

  async transition(conversationId, expectedRevision, next) {
    return (prisma as any).$transaction(async (tx: any) => {
      await tx.$queryRaw`SELECT "id" FROM "Call" WHERE "id" = ${conversationId} FOR UPDATE`
      const call = await tx.call.findUnique({ where: { id: conversationId }, select: { id: true, metadata: true, endedAt: true } })
      const current = call ? readAiConversationRecord(call.metadata) : null
      if (!current || current.revision !== expectedRevision || next.revision !== expectedRevision + 1) return null
      const metadata = { ...(isRecord(call.metadata) ? call.metadata : {}), [AI_CONVERSATION_METADATA_KEY]: next }
      const columns = call.endedAt === null ? terminalColumns(next) : {}
      await tx.call.update({ where: { id: conversationId }, data: { metadata, ...columns } })
      return findIn(tx, conversationId)
    })
  },

  async listForContact(contactId, limit) {
    const calls = await (prisma as any).call.findMany({
      where: { contactId, isAi: true, metadata: { path: [AI_CONVERSATION_METADATA_KEY, 'version'], equals: 1 } },
      select: CALL_SELECT,
      orderBy: { startedAt: 'desc' },
      take: limit,
    })
    return readSnapshots(prisma as any, calls)
  },
}

/** The simulated provider's answer signal: the callee picked up. Only the Call's own columns move. */
export async function markAiConversationAnswered(conversationId: string, at: Date): Promise<void> {
  await (prisma as any).call.updateMany({
    where: { id: conversationId, answeredAt: null, endedAt: null, isSimulation: true },
    data: { answeredAt: at, status: 'active' },
  })
}
