import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

const DEFAULT_COLLISION_AUDIT_LIMIT = 20

export type ConversationIdentityCollisionEvidenceV1 = {
  channel: 'telegram' | 'whatsapp' | 'max'
  reason: string
  [key: string]: unknown
}

function metadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {}
}

function canonicalEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalEvidence)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'observedAt')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalEvidence(entry)]),
  )
}

function collisionEvidenceKey(value: unknown): string | null {
  const record = metadataRecord(value)
  if (typeof record.channel !== 'string' || typeof record.reason !== 'string') return null
  return JSON.stringify(canonicalEvidence(record))
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_COLLISION_AUDIT_LIMIT
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new TypeError('collision audit limit must be an integer between 1 and 100')
  }
  return value
}

function validateEvidence(evidence: ConversationIdentityCollisionEvidenceV1): void {
  if (!['telegram', 'whatsapp', 'max'].includes(evidence.channel)) {
    throw new TypeError('collision evidence channel is invalid')
  }
  if (typeof evidence.reason !== 'string' || evidence.reason.trim() === '') {
    throw new TypeError('collision evidence reason is required')
  }
}

/**
 * Atomically appends bounded, de-duplicated collision evidence to a Chat.
 * The row lock makes concurrent webhook collisions serialize before either
 * caller reads and rewrites the JSON audit array.
 */
export async function appendConversationIdentityCollisionV1(input: {
  chatId: string
  evidence: ConversationIdentityCollisionEvidenceV1
  limit?: number
}): Promise<void> {
  if (typeof input.chatId !== 'string' || input.chatId.trim() === '') {
    throw new TypeError('chatId is required')
  }
  validateEvidence(input.evidence)
  const limit = boundedLimit(input.limit)

  await prisma.$transaction(async transaction => {
    const rows = await transaction.$queryRaw<Array<{ id: string; metadata: Prisma.JsonValue | null }>>(Prisma.sql`
      SELECT id, metadata
      FROM "Chat"
      WHERE id = ${input.chatId}
      FOR UPDATE
    `)
    const row = rows[0]
    if (!row) throw new Error('CONVERSATION_IDENTITY_COLLISION_CHAT_NOT_FOUND')

    const metadata = metadataRecord(row.metadata)
    const audit = Array.isArray(metadata.channelIdentityCollisionAudit)
      ? metadata.channelIdentityCollisionAudit
      : []
    const evidenceKey = collisionEvidenceKey(input.evidence)
    const priorLimit = limit - 1
    const deduplicated = audit.filter(entry => collisionEvidenceKey(entry) !== evidenceKey)
    const retained = priorLimit === 0 ? [] : deduplicated.slice(-priorLimit)
    await transaction.chat.update({
      where: { id: input.chatId },
      data: {
        metadata: {
          ...metadata,
          channelIdentityCollisionAudit: [
            ...retained,
            { ...input.evidence, observedAt: new Date().toISOString() },
          ],
        } as Prisma.InputJsonObject,
      },
    })
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 2_000,
    timeout: 10_000,
  })
}
