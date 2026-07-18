import { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'

const DEFAULT_MAX_MERGE_DEPTH = 16

export type CanonicalContactLookup =
  | {
      kind: 'resolved'
      originalContactId: string
      canonicalContactId: string
      merged: boolean
      contactIds: string[]
    }
  | { kind: 'not_found'; contactId: string }
  | { kind: 'archived_without_merge'; contactId: string }
  | { kind: 'ambiguous'; contactIds: string[] }
  | { kind: 'cycle'; contactIds: string[] }
  | { kind: 'depth_exceeded'; contactIds: string[] }

type CanonicalContactDb = Pick<Prisma.TransactionClient, 'contact' | 'contactMerge'>

export async function resolveCanonicalContactId(
  contactId: string,
  db: CanonicalContactDb = prisma,
  maxDepth = DEFAULT_MAX_MERGE_DEPTH,
): Promise<CanonicalContactLookup> {
  const originalContactId = contactId
  let currentId = contactId
  const visited: string[] = []

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (visited.includes(currentId)) {
      return { kind: 'cycle', contactIds: [...new Set([...visited, currentId])].sort() }
    }
    visited.push(currentId)

    const contact = await db.contact.findUnique({
      where: { id: currentId },
      select: { id: true, isArchived: true },
    })
    if (!contact) return { kind: 'not_found', contactId: currentId }

    const edges = await db.contactMerge.findMany({
      where: { mergedId: currentId, action: 'merge' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { survivorId: true },
    })
    const survivorIds = [...new Set(edges.map(edge => edge.survivorId))].sort()
    if (survivorIds.length > 1) {
      return { kind: 'ambiguous', contactIds: [...new Set([...visited, ...survivorIds])].sort() }
    }
    if (survivorIds.length === 0) {
      if (contact.isArchived) return { kind: 'archived_without_merge', contactId: currentId }
      return {
        kind: 'resolved',
        originalContactId,
        canonicalContactId: currentId,
        merged: currentId !== originalContactId,
        contactIds: visited,
      }
    }
    currentId = survivorIds[0]
  }

  return { kind: 'depth_exceeded', contactIds: [...new Set(visited)].sort() }
}
