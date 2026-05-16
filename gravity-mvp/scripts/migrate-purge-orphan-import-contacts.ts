/**
 * One-shot migration: hard-delete orphan Contacts from a historical
 * batch import (~2026-04-03) that left rows with a single ContactPhone
 * (source 'telegram' or 'max'), no identities, no chats, no tasks, and
 * no driver link.
 *
 * Detection criteria (all must hold):
 *   - Contact.isArchived = false
 *   - Contact.yandexDriverId IS NULL
 *   - Contact has >= 1 ContactPhone (source telegram or max, isActive)
 *   - Contact has 0 ContactIdentity rows
 *   - Contact has 0 Chat rows
 *   - Contact has 0 tasks
 *
 * Steps (single transaction):
 *   1. DELETE ContactPhone WHERE contactId IN (orphan_ids)
 *   2. DELETE Contact WHERE id IN (orphan_ids)
 *
 * No FK cascade collisions because identities=0, chats=0, tasks=0.
 *
 * Usage:  npx tsx scripts/migrate-purge-orphan-import-contacts.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('[migrate] Connecting...')
  await prisma.$queryRaw`SELECT 1`
  console.log('[migrate] Connected.')

  const orphans = await prisma.$queryRaw<Array<{ id: string; display_name: string; phone: string; source: string }>>`
    SELECT c.id, c."displayName" AS display_name, cp.phone, cp.source
    FROM "Contact" c
    JOIN "ContactPhone" cp ON cp."contactId" = c.id
    WHERE cp.source IN ('telegram', 'max')
      AND cp."isActive" = true
      AND c."isArchived" = false
      AND c."yandexDriverId" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "ContactIdentity" WHERE "contactId" = c.id)
      AND NOT EXISTS (SELECT 1 FROM "Chat" WHERE "contactId" = c.id)
      AND NOT EXISTS (SELECT 1 FROM "tasks" WHERE "contactId" = c.id)
    ORDER BY c."createdAt"
  `

  console.log(`[migrate] Orphan contacts found: ${orphans.length}`)
  for (const o of orphans) {
    console.log(`[migrate]   ${o.id} | "${o.display_name}" | ${o.phone} | source=${o.source}`)
  }

  if (orphans.length === 0) {
    console.log('[migrate] Nothing to delete — exiting.')
    return
  }

  const orphanIds = orphans.map(o => o.id)

  console.log('[migrate] Starting transaction...')
  const result = await prisma.$transaction(async (tx) => {
    // Step 1: hard-delete phones (FK contactId would block contact delete otherwise)
    const phonesDeleted = await tx.contactPhone.deleteMany({
      where: { contactId: { in: orphanIds } },
    })
    console.log(`[migrate]   step1: ContactPhone deleted = ${phonesDeleted.count}`)

    // Step 2: hard-delete contacts
    const contactsDeleted = await tx.contact.deleteMany({
      where: { id: { in: orphanIds } },
    })
    console.log(`[migrate]   step2: Contact deleted = ${contactsDeleted.count}`)

    return { phonesDeleted: phonesDeleted.count, contactsDeleted: contactsDeleted.count }
  })

  console.log('[migrate] Transaction committed:')
  console.log(`[migrate]   ContactPhone deleted: ${result.phonesDeleted}`)
  console.log(`[migrate]   Contact deleted:      ${result.contactsDeleted}`)

  // Verify
  const remaining = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count
    FROM "Contact" c
    JOIN "ContactPhone" cp ON cp."contactId" = c.id
    WHERE cp.source IN ('telegram', 'max')
      AND cp."isActive" = true
      AND c."isArchived" = false
      AND c."yandexDriverId" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "ContactIdentity" WHERE "contactId" = c.id)
      AND NOT EXISTS (SELECT 1 FROM "Chat" WHERE "contactId" = c.id)
      AND NOT EXISTS (SELECT 1 FROM "tasks" WHERE "contactId" = c.id)
  `
  console.log(`[migrate] Orphans remaining: ${remaining[0].count}`)
}

main()
  .catch((e) => {
    console.error('[migrate] FAILED:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
