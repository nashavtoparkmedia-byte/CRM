import { describe, expect, test } from 'vitest'

import { resolveCanonicalContactId } from '@/lib/contacts/canonical-contact'

type Db = NonNullable<Parameters<typeof resolveCanonicalContactId>[1]>

function repository(
  contacts: Record<string, { isArchived: boolean }>,
  merges: Record<string, string[]> = {},
): Db {
  return {
    contact: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const contact = contacts[where.id]
        return contact ? { id: where.id, isArchived: contact.isArchived } : null
      },
    },
    contactMerge: {
      findMany: async ({ where }: { where: { mergedId: string } }) =>
        (merges[where.mergedId] || []).map(survivorId => ({ survivorId })),
    },
  } as unknown as Db
}

describe('canonical Contact redirect', () => {
  test('keeps an active canonical Contact unchanged', async () => {
    await expect(resolveCanonicalContactId('A', repository({ A: { isArchived: false } })))
      .resolves.toMatchObject({
        kind: 'resolved',
        originalContactId: 'A',
        canonicalContactId: 'A',
        merged: false,
      })
  })

  test('follows a multi-step merge chain', async () => {
    await expect(resolveCanonicalContactId('A', repository({
      A: { isArchived: true },
      B: { isArchived: true },
      C: { isArchived: false },
    }, {
      A: ['B'],
      B: ['C'],
    }))).resolves.toMatchObject({
      kind: 'resolved',
      originalContactId: 'A',
      canonicalContactId: 'C',
      merged: true,
      contactIds: ['A', 'B', 'C'],
    })
  })

  test('rejects ambiguous and cyclic histories', async () => {
    await expect(resolveCanonicalContactId('A', repository({
      A: { isArchived: true },
      B: { isArchived: false },
      C: { isArchived: false },
    }, { A: ['B', 'C'] }))).resolves.toMatchObject({ kind: 'ambiguous' })

    await expect(resolveCanonicalContactId('A', repository({
      A: { isArchived: true },
      B: { isArchived: true },
    }, { A: ['B'], B: ['A'] }))).resolves.toMatchObject({ kind: 'cycle' })
  })

  test('distinguishes an archive without redirect from a missing Contact', async () => {
    await expect(resolveCanonicalContactId('A', repository({ A: { isArchived: true } })))
      .resolves.toEqual({ kind: 'archived_without_merge', contactId: 'A' })
    await expect(resolveCanonicalContactId('missing', repository({})))
      .resolves.toEqual({ kind: 'not_found', contactId: 'missing' })
  })
})
