import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  CONTACT_OWNERSHIP_ADVISORY_CLASS_ID_V1,
  CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID_V1,
} from '@/modules/contacts/public/v1/contact-ownership-lock-contract'
import type { ConversationContactLinkPersistencePortV1 } from './conversation-contact-link-handler'

function hasConfirmedRepresentativeDriver(customFields: unknown, driverId: string): boolean {
  if (!customFields || typeof customFields !== 'object' || Array.isArray(customFields)) return false
  const confirmations = (customFields as Record<string, unknown>).driverConfirmations
  if (!Array.isArray(confirmations)) return false
  return confirmations.some(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const confirmation = item as Record<string, unknown>
    return confirmation.status === 'confirmed'
      && confirmation.representativeDriverId === driverId
  })
}

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
        select: {
          id: true,
          isArchived: true,
          mainDriverId: true,
          customFields: true,
        },
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
        select: { contactId: true, contactIdentityId: true, driverId: true },
      })
      if (!chat) throw new Error('CONTACT_CONVERSATION_LINK_STALE')
      if (
        (chat.contactId !== null && chat.contactId !== canonical.id)
        || (chat.contactIdentityId !== null && chat.contactIdentityId !== identity.id)
      ) {
        throw new Error('CONTACT_CONVERSATION_OWNERSHIP_MISMATCH')
      }
      const confirmedMainDriverId = canonical.mainDriverId
        && hasConfirmedRepresentativeDriver(canonical.customFields, canonical.mainDriverId)
        ? canonical.mainDriverId
        : null
      if (chat.driverId !== null) {
        if (!confirmedMainDriverId || chat.driverId !== confirmedMainDriverId) {
          throw new Error('CONTACT_CONVERSATION_DRIVER_MISMATCH')
        }
      } else if (confirmedMainDriverId) {
        updateData.driverId = confirmedMainDriverId
      }
      await transaction.chat.update({ where: { id: input.chatId }, data: updateData })
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 2_000,
      timeout: 10_000,
    })
  },
}
