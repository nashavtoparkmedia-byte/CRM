/**
 * One-shot backfill: walk every Chat with contactId IS NULL and try to
 * attach it to an existing ContactIdentity by externalId pattern.
 *
 * Match rules per channel (mirror what the ChatHeader logic uses):
 *   - whatsapp:  strip "@c.us" / "@lid" suffix, compare digits
 *   - telegram:  strip "telegram:" prefix, compare digits
 *   - max:       full externalChatId == identity.externalId
 *   - others:    skipped (would need per-channel rules)
 *
 * On match: UPDATE Chat SET contactId = ci.contactId, contactIdentityId = ci.id.
 * If the identity's Contact is linked to a Driver and chat.driverId is null,
 * also propagate driverId (ensureChatLinked-style behaviour).
 *
 * Usage: npx tsx scripts/migrate-relink-orphan-chats.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('[relink] Connecting...')
  await prisma.$queryRaw`SELECT 1`
  console.log('[relink] Connected.')

  // Pull orphan chats together with their would-be identity match.
  // We do the join in SQL — Prisma can't express "strip-and-match" easily.
  const matches = await prisma.$queryRaw<Array<{
    chat_id: string
    chat_channel: string
    chat_external_id: string
    chat_driver_id: string | null
    identity_id: string
    contact_id: string
    contact_yandex_driver_id: string | null
  }>>`
    SELECT
      c.id AS chat_id,
      c.channel::text AS chat_channel,
      c."externalChatId" AS chat_external_id,
      c."driverId" AS chat_driver_id,
      ci.id AS identity_id,
      ci."contactId" AS contact_id,
      ct."yandexDriverId" AS contact_yandex_driver_id
    FROM "Chat" c
    JOIN "ContactIdentity" ci ON ci.channel = c.channel
      AND (
        (c.channel = 'whatsapp' AND split_part(c."externalChatId", '@', 1) = ci."externalId")
        OR (c.channel = 'telegram' AND substring(c."externalChatId" FROM position(':' IN c."externalChatId")+1) = ci."externalId")
        OR (c."externalChatId" = ci."externalId")
      )
    JOIN "Contact" ct ON ct.id = ci."contactId"
    WHERE c."contactId" IS NULL
      AND ct."isArchived" = false
    ORDER BY c."lastMessageAt" DESC NULLS LAST
  `

  console.log(`[relink] Match candidates: ${matches.length}`)

  // Deduplicate by chat_id — first match wins. Shouldn't happen often given
  // the unique constraint on (channel, externalId), but be defensive.
  const seen = new Set<string>()
  const unique = matches.filter(m => {
    if (seen.has(m.chat_id)) return false
    seen.add(m.chat_id)
    return true
  })
  console.log(`[relink] Unique chats to relink: ${unique.length}`)

  if (unique.length === 0) {
    console.log('[relink] Nothing to do.')
    return
  }

  // Resolve driver ids in bulk (mapping yandexDriverId → Driver.id)
  const yandexIds = Array.from(new Set(unique.map(m => m.contact_yandex_driver_id).filter((v): v is string => !!v)))
  const drivers = yandexIds.length > 0
    ? await prisma.driver.findMany({
        where: { yandexDriverId: { in: yandexIds } },
        select: { id: true, yandexDriverId: true },
      })
    : []
  const yandexToDriverId = new Map(drivers.map(d => [d.yandexDriverId, d.id]))

  console.log('[relink] Starting transaction...')
  const counters = { updated: 0, errors: 0 }
  await prisma.$transaction(async (tx) => {
    for (const m of unique) {
      const updateData: any = {
        contactId: m.contact_id,
        contactIdentityId: m.identity_id,
      }
      if (!m.chat_driver_id && m.contact_yandex_driver_id) {
        const driverId = yandexToDriverId.get(m.contact_yandex_driver_id)
        if (driverId) updateData.driverId = driverId
      }
      try {
        await tx.chat.update({ where: { id: m.chat_id }, data: updateData })
        counters.updated++
      } catch (e: any) {
        counters.errors++
        console.warn(`[relink] failed chat=${m.chat_id}: ${e.message}`)
      }
    }
  }, { timeout: 60000 })

  console.log('[relink] Transaction committed:')
  console.log(`[relink]   Chats updated: ${counters.updated}`)
  console.log(`[relink]   Errors:        ${counters.errors}`)

  // Verify
  const remaining = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count
    FROM "Chat" c
    JOIN "ContactIdentity" ci ON ci.channel = c.channel
      AND (
        (c.channel = 'whatsapp' AND split_part(c."externalChatId", '@', 1) = ci."externalId")
        OR (c.channel = 'telegram' AND substring(c."externalChatId" FROM position(':' IN c."externalChatId")+1) = ci."externalId")
        OR (c."externalChatId" = ci."externalId")
      )
    WHERE c."contactId" IS NULL
  `
  console.log(`[relink] Still-linkable orphan chats remaining: ${remaining[0].count}`)
}

main()
  .catch((e) => {
    console.error('[relink] FAILED:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
