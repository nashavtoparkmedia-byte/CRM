/**
 * One-shot cleanup: remove the leftovers of the start-chat-as-phone bug
 * for Telegram. These rows look like:
 *   ContactIdentity.channel = 'telegram'
 *   externalId             = numeric, 10-12 digits
 *   phoneId                = NOT NULL
 *   ContactPhone.phone     = '+7' || externalId    (or '+' || externalId)
 *
 * Such identities were created when an operator pressed "Написать в TG"
 * for an unsaved-driver chat. The route normalized the phone-as-externalId
 * and called ContactService.resolveContact(channel='telegram', externalId=phone),
 * producing a TG identity whose externalId is in fact the phone — a fake
 * TG userId, useless for routing.
 *
 * Action:
 *   - Always: delete the ContactIdentity
 *   - If Contact had no other identity AND no driver AND its displayName
 *     is just the phone (= a pure-fabricated orphan): also delete the
 *     ContactPhone and the Contact. ContactPhone associated with a real
 *     Yandex-driver Contact is left intact.
 *
 * Usage: npx tsx scripts/migrate-purge-fake-tg-identities.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('[purge] Connecting...')
  await prisma.$queryRaw`SELECT 1`
  console.log('[purge] Connected.')

  // Match criteria — phone literally equals "+" + externalId or "+7" + externalId
  const fakes = await prisma.$queryRaw<Array<{
    identity_id: string
    contact_id: string
    external_id: string
    phone_id: string
    phone: string
    contact_display_name: string
    yandex_driver_id: string | null
    other_identities: number
    other_phones: number
  }>>`
    SELECT
      ci.id                AS identity_id,
      ci."contactId"       AS contact_id,
      ci."externalId"      AS external_id,
      ci."phoneId"         AS phone_id,
      cp.phone,
      c."displayName"      AS contact_display_name,
      c."yandexDriverId"   AS yandex_driver_id,
      (SELECT COUNT(*) FROM "ContactIdentity" WHERE "contactId" = c.id AND id <> ci.id)::int AS other_identities,
      (SELECT COUNT(*) FROM "ContactPhone"    WHERE "contactId" = c.id AND id <> cp.id)::int AS other_phones
    FROM "ContactIdentity" ci
    JOIN "ContactPhone" cp ON cp.id = ci."phoneId"
    JOIN "Contact"      c  ON c.id  = ci."contactId"
    WHERE ci.channel = 'telegram'
      AND ci."externalId" ~ '^[0-9]+$'
      AND length(ci."externalId") BETWEEN 10 AND 12
      AND (cp.phone = '+7' || ci."externalId" OR cp.phone = '+' || ci."externalId")
  `

  console.log(`[purge] Fake TG identities found: ${fakes.length}`)
  for (const f of fakes) {
    console.log(`[purge]   identity=${f.identity_id} externalId=${f.external_id} contact="${f.contact_display_name}" driver=${f.yandex_driver_id ? 'YES' : 'no'} other_identities=${f.other_identities} other_phones=${f.other_phones}`)
  }
  if (fakes.length === 0) {
    console.log('[purge] Nothing to do.')
    return
  }

  // Block any with a Chat still pointing at the identity (safety check)
  const blocking = await prisma.chat.findMany({
    where: { contactIdentityId: { in: fakes.map(f => f.identity_id) } },
    select: { id: true, contactIdentityId: true },
  })
  if (blocking.length > 0) {
    console.error(`[purge] ABORT — ${blocking.length} chats still reference one of the fake identities. Resolve manually first.`)
    blocking.forEach(b => console.error(`  chat ${b.id} → identity ${b.contactIdentityId}`))
    return
  }

  console.log('[purge] Starting transaction...')
  const counters = { identitiesDeleted: 0, phonesDeleted: 0, contactsDeleted: 0, errors: 0 }
  await prisma.$transaction(async (tx) => {
    for (const f of fakes) {
      const isPureOrphan =
        !f.yandex_driver_id &&
        f.other_identities === 0 &&
        f.other_phones === 0 &&
        f.contact_display_name === f.phone

      try {
        // 1. Always delete the fake identity
        await tx.contactIdentity.delete({ where: { id: f.identity_id } })
        counters.identitiesDeleted++

        if (isPureOrphan) {
          // 2. Null out Contact.primaryPhoneId so the phone delete doesn't FK-fail
          await tx.contact.update({
            where: { id: f.contact_id },
            data: { primaryPhoneId: null },
          })
          // 3. Delete the fake ContactPhone
          await tx.contactPhone.delete({ where: { id: f.phone_id } })
          counters.phonesDeleted++
          // 4. Delete the Contact itself (nothing else hangs on it)
          await tx.contact.delete({ where: { id: f.contact_id } })
          counters.contactsDeleted++
          console.log(`[purge]   ORPHAN swept: contact=${f.contact_id} phone=${f.phone}`)
        } else {
          console.log(`[purge]   identity-only delete: contact=${f.contact_id} ("${f.contact_display_name}") kept (driver=${f.yandex_driver_id || 'no'})`)
        }
      } catch (e: any) {
        counters.errors++
        console.warn(`[purge]   FAILED identity=${f.identity_id}: ${e.message}`)
      }
    }
  }, { timeout: 30000 })

  console.log('[purge] Done:')
  console.log(`[purge]   identities deleted: ${counters.identitiesDeleted}`)
  console.log(`[purge]   phones deleted:     ${counters.phonesDeleted}`)
  console.log(`[purge]   contacts deleted:   ${counters.contactsDeleted}`)
  console.log(`[purge]   errors:             ${counters.errors}`)
}

main()
  .catch((e) => {
    console.error('[purge] FAILED:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
