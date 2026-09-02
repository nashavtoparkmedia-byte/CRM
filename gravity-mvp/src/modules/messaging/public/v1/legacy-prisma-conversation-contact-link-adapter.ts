import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  CONTACT_OWNERSHIP_ADVISORY_CLASS_ID_V1,
  CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID_V1,
} from '@/modules/contacts/public/v1/contact-ownership-lock-contract'
import type { ConversationContactLinkPersistencePortV1 } from './conversation-contact-link-handler'

export const legacyPrismaConversationContactLinkPortV1: ConversationContactLinkPersistencePortV1 = {
  async ensure(input) {
    await prisma.$transaction(async transaction => {
      // This is deliberately the first statement. It shares Contacts' CNT1
      // admission, so a merge either precedes revalidation or follows the Chat
      // write and moves it; it cannot interleave between the two.
      await transaction.$queryRaw(Prisma.sql`
        WITH "contact_link_lock_policy" AS MATERIALIZED (
          SELECT set_config('lock_timeout', '2000ms', true) AS configured
        )
        SELECT (
          pg_advisory_xact_lock(
            CAST(${CONTACT_OWNERSHIP_ADVISORY_CLASS_ID_V1} AS integer)
              + octet_length(configured) * 0,
            CAST(${CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID_V1} AS integer)
          ) IS NULL
        ) AS admitted
        FROM "contact_link_lock_policy"
      `)

      const identity = await transaction.contactIdentity.findUnique({
        where: { id: input.contactIdentityId },
        select: { id: true, contactId: true, isActive: true },
      })
      if (!identity?.isActive) throw new Error('CONTACT_IDENTITY_LINK_STALE')
      const canonical = await transaction.contact.findUnique({
        where: { id: identity.contactId },
        select: { id: true, isArchived: true, yandexDriverId: true },
      })
      if (!canonical || canonical.isArchived) throw new Error('CONTACT_IDENTITY_LINK_STALE')

      let requestedId = input.contactId
      for (let depth = 0; requestedId !== canonical.id && depth < 16; depth += 1) {
        const requested = await transaction.contact.findUnique({
          where: { id: requestedId },
          select: { isArchived: true, customFields: true },
        })
        const fields = requested?.customFields
          && typeof requested.customFields === 'object'
          && !Array.isArray(requested.customFields)
          ? requested.customFields as Record<string, unknown>
          : {}
        const next = requested?.isArchived && typeof fields.mergedIntoContactId === 'string'
          ? fields.mergedIntoContactId
          : null
        if (!next || next === requestedId) throw new Error('CONTACT_IDENTITY_LINK_MISMATCH')
        requestedId = next
      }
      if (requestedId !== canonical.id) throw new Error('CONTACT_IDENTITY_LINK_MISMATCH')

      const updateData: {
        contactId: string
        contactIdentityId: string
        driverId?: string
      } = {
        contactId: canonical.id,
        contactIdentityId: identity.id,
      }
      const chat = await transaction.chat.findUnique({
        where: { id: input.chatId },
        select: { driverId: true },
      })
      if (chat && !chat.driverId && canonical.yandexDriverId) {
        const driver = await transaction.driver.findUnique({
          where: { yandexDriverId: canonical.yandexDriverId },
          select: { id: true },
        })
        if (driver) updateData.driverId = driver.id
      }
      await transaction.chat.update({ where: { id: input.chatId }, data: updateData })
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 2_000,
      timeout: 10_000,
    })
  },
}
