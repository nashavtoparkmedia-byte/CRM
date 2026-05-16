/**
 * One-shot migration: hard-delete phantom ContactPhone rows that were
 * fabricated from WhatsApp LIDs (Linked IDs) by the buggy normalizePhoneE164
 * branch (`'7' + digits.slice(-10)` for any string longer than 11 digits).
 *
 * Detection criteria:
 *   ContactPhone.id is referenced by a ContactIdentity where:
 *     - channel = 'whatsapp'
 *     - externalId matches `^[0-9]+$` (numeric only)
 *     - length(externalId) > 12   (LIDs are 13-15 digits; real WA c.us
 *                                   chat ids are 10-12)
 *
 * Steps (single transaction):
 *   1. NULL out Contact.primaryPhoneId pointing at phantoms
 *   2. NULL out ContactIdentity.phoneId pointing at phantoms
 *      (identity itself survives — it's still a valid channel record,
 *      just orphaned from the fake phone)
 *   3. DELETE the phantom ContactPhone rows
 *
 * Usage:  node --import tsx scripts/migrate-purge-phantom-lid-phones.ts
 *     or  npx tsx scripts/migrate-purge-phantom-lid-phones.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('[migrate] Connecting to DB...')
  await prisma.$queryRaw`SELECT 1`
  console.log('[migrate] Connected.')

  console.log('[migrate] Counting phantoms before...')
  const before = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count
    FROM "ContactPhone" cp
    JOIN "ContactIdentity" ci ON ci."phoneId" = cp.id
    WHERE ci.channel = 'whatsapp'
      AND ci."externalId" ~ '^[0-9]+$'
      AND length(ci."externalId") > 12
  `
  console.log(`[migrate] Phantoms found: ${before[0].count}`)

  if (before[0].count === 0n) {
    console.log('[migrate] Nothing to do — exiting cleanly.')
    return
  }

  console.log('[migrate] Starting transaction...')
  const result = await prisma.$transaction(async (tx) => {
    // Pull phantom phone ids once
    const phantomRows = await tx.$queryRaw<Array<{ phone_id: string }>>`
      SELECT DISTINCT cp.id AS phone_id
      FROM "ContactPhone" cp
      JOIN "ContactIdentity" ci ON ci."phoneId" = cp.id
      WHERE ci.channel = 'whatsapp'
        AND ci."externalId" ~ '^[0-9]+$'
        AND length(ci."externalId") > 12
    `
    const phantomIds = phantomRows.map(r => r.phone_id)
    console.log(`[migrate]   collected ${phantomIds.length} phantom phone ids`)

    if (phantomIds.length === 0) return { primaryNulled: 0, identityNulled: 0, deleted: 0 }

    // Step 1: detach Contact.primaryPhoneId
    const primaryNulled = await tx.contact.updateMany({
      where: { primaryPhoneId: { in: phantomIds } },
      data: { primaryPhoneId: null },
    })
    console.log(`[migrate]   step1: Contact.primaryPhoneId nulled = ${primaryNulled.count}`)

    // Step 2: detach ContactIdentity.phoneId
    const identityNulled = await tx.contactIdentity.updateMany({
      where: { phoneId: { in: phantomIds } },
      data: { phoneId: null },
    })
    console.log(`[migrate]   step2: ContactIdentity.phoneId nulled = ${identityNulled.count}`)

    // Step 3: hard delete the phantom ContactPhones
    const deleted = await tx.contactPhone.deleteMany({
      where: { id: { in: phantomIds } },
    })
    console.log(`[migrate]   step3: ContactPhone deleted = ${deleted.count}`)

    return { primaryNulled: primaryNulled.count, identityNulled: identityNulled.count, deleted: deleted.count }
  })

  console.log('[migrate] Transaction committed:')
  console.log(`[migrate]   - Contact.primaryPhoneId nulled: ${result.primaryNulled}`)
  console.log(`[migrate]   - ContactIdentity.phoneId nulled: ${result.identityNulled}`)
  console.log(`[migrate]   - ContactPhone rows deleted:     ${result.deleted}`)

  const after = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count
    FROM "ContactPhone" cp
    JOIN "ContactIdentity" ci ON ci."phoneId" = cp.id
    WHERE ci.channel = 'whatsapp'
      AND ci."externalId" ~ '^[0-9]+$'
      AND length(ci."externalId") > 12
  `
  console.log(`[migrate] Phantoms remaining: ${after[0].count}`)
}

main()
  .catch((e) => {
    console.error('[migrate] FAILED:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
