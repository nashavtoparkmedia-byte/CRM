import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'

import {
  CLEANUP_GROUP_CONTACT_IDENTITIES_RESULT_V1,
  parseCleanupGroupContactIdentitiesCommandV1,
  type CleanupGroupContactIdentitiesResultV1,
} from '@/contracts/contacts/v1'
import {
  assertContactOwnershipPostconditions,
  lockContactOwnershipRows,
  runContactOwnershipTransaction,
} from '../../internal/contact-ownership-coordinator'

type CandidateBatch = { candidateIds: string[]; orphanIds: string[]; hasMore: boolean }
const digest = (ids: string[]) => createHash('sha256').update(`${JSON.stringify(ids)}\n`).digest('hex')

export async function cleanupGroupContactIdentitiesV1(command: unknown): Promise<CleanupGroupContactIdentitiesResultV1> {
  const parsed = parseCleanupGroupContactIdentitiesCommandV1(command)
  const prospectiveIds = [...parsed.prospectiveIdentityIds].sort()
  const detachedIds = [...parsed.detachedConversationIds].sort()
  return runContactOwnershipTransaction(async (transaction: Prisma.TransactionClient) => {
    const loadCandidates = async (): Promise<CandidateBatch> => {
      const detachableGroupChat: Prisma.ChatWhereInput = {
        AND: [
          { id: { in: detachedIds } },
          { OR: [
            { channel: 'telegram', externalChatId: { startsWith: 'telegram:-' } },
            { channel: 'whatsapp', externalChatId: { endsWith: '@g.us' } },
          ] },
        ],
      }
      const prospective = prospectiveIds.length === 0 ? [] : await transaction.contactIdentity.findMany({
        where: {
          id: { in: prospectiveIds },
          channel: 'telegram',
          externalId: { startsWith: '-' },
          chats: detachedIds.length === 0 ? { none: {} } : { none: { NOT: detachableGroupChat } },
          contact: { chats: detachedIds.length === 0
            ? { none: { chatType: 'private' } }
            : { none: { chatType: 'private', NOT: detachableGroupChat } } },
        },
        orderBy: { id: 'asc' },
        select: { id: true },
      })
      const remaining = parsed.limit - prospective.length
      const orphanRows = await transaction.contactIdentity.findMany({
        where: {
          id: { gt: parsed.afterId ?? '', notIn: prospectiveIds },
          channel: 'telegram',
          externalId: { startsWith: '-' },
          chats: { none: {} },
          contact: { chats: { none: { chatType: 'private' } } },
        },
        orderBy: { id: 'asc' },
        take: remaining + 1,
        select: { id: true },
      })
      const orphanIds = orphanRows.slice(0, remaining).map(row => row.id)
      return { candidateIds: [...prospective.map(row => row.id), ...orphanIds].sort(), orphanIds, hasMore: orphanRows.length > remaining }
    }

    const preliminary = await loadCandidates()
    const scope = await lockContactOwnershipRows(transaction, { identityIds: preliminary.candidateIds })
    const authoritative = await loadCandidates()
    if (JSON.stringify(authoritative) !== JSON.stringify(preliminary)) throw new Error('GROUP_IDENTITY_CLEANUP_STALE')
    const candidateDigest = digest(authoritative.candidateIds)
    if (parsed.intent === 'apply' && candidateDigest !== parsed.expectedCandidateDigest) throw new Error('GROUP_IDENTITY_CLEANUP_PREVIEW_STALE')
    if (parsed.intent === 'apply' && authoritative.candidateIds.length > 0) {
      const deleted = await transaction.contactIdentity.deleteMany({ where: { id: { in: authoritative.candidateIds } } })
      if (deleted.count !== authoritative.candidateIds.length) throw new Error('GROUP_IDENTITY_CLEANUP_STALE')
      await assertContactOwnershipPostconditions(transaction, scope)
    }
    return {
      contract: CLEANUP_GROUP_CONTACT_IDENTITIES_RESULT_V1,
      operationId: parsed.operationId,
      intent: parsed.intent,
      candidateDigest,
      candidateIds: authoritative.candidateIds,
      deletedIds: parsed.intent === 'apply' ? authoritative.candidateIds : [],
      nextAfterId: authoritative.orphanIds.at(-1) ?? null,
      hasMore: authoritative.hasMore,
    }
  })
}
