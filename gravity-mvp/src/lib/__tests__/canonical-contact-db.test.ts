import { afterAll, beforeEach, describe, expect, test } from 'vitest'

import { resolveCanonicalContactId } from '@/lib/contacts/canonical-contact'
import { prisma } from '@/lib/prisma'

const dbDescribe = process.env.CANONICAL_CONTACT_DB_TEST === '1' ? describe : describe.skip

dbDescribe('canonical Contact redirect against isolated PostgreSQL', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "ContactMerge", "Contact" CASCADE')
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  test('follows the persisted merge chain to one active Contact', async () => {
    const [first, second, canonical] = await Promise.all([
      prisma.contact.create({ data: { displayName: 'Первый', isArchived: true } }),
      prisma.contact.create({ data: { displayName: 'Второй', isArchived: true } }),
      prisma.contact.create({ data: { displayName: 'Canonical' } }),
    ])
    await prisma.contactMerge.create({
      data: {
        survivorId: second.id,
        mergedId: first.id,
        action: 'merge',
        mergedBy: 'db-test',
        reason: 'manual',
        snapshotBefore: {},
      },
    })
    await prisma.contactMerge.create({
      data: {
        survivorId: canonical.id,
        mergedId: second.id,
        action: 'merge',
        mergedBy: 'db-test',
        reason: 'manual',
        snapshotBefore: {},
      },
    })

    await expect(resolveCanonicalContactId(first.id)).resolves.toMatchObject({
      kind: 'resolved',
      originalContactId: first.id,
      canonicalContactId: canonical.id,
      merged: true,
      contactIds: [first.id, second.id, canonical.id],
    })
  })

  test('returns ambiguous instead of selecting the first survivor', async () => {
    const [source, first, second] = await Promise.all([
      prisma.contact.create({ data: { displayName: 'Источник', isArchived: true } }),
      prisma.contact.create({ data: { displayName: 'Первый' } }),
      prisma.contact.create({ data: { displayName: 'Второй' } }),
    ])
    for (const survivorId of [first.id, second.id]) {
      await prisma.contactMerge.create({
        data: {
          survivorId,
          mergedId: source.id,
          action: 'merge',
          mergedBy: 'db-test',
          reason: 'manual',
          snapshotBefore: {},
        },
      })
    }

    await expect(resolveCanonicalContactId(source.id)).resolves.toMatchObject({
      kind: 'ambiguous',
      contactIds: expect.arrayContaining([source.id, first.id, second.id]),
    })
  })
})
