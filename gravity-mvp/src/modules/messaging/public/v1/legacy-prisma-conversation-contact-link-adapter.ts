import { prisma } from '@/lib/prisma'
import type { ConversationContactLinkPersistencePortV1 } from './conversation-contact-link-handler'

export const legacyPrismaConversationContactLinkPortV1: ConversationContactLinkPersistencePortV1 = {
  async ensure(input) {
    const updateData: {
      contactId: string
      contactIdentityId: string
      driverId?: string
    } = {
      contactId: input.contactId,
      contactIdentityId: input.contactIdentityId,
    }

    const chat = await prisma.chat.findUnique({
      where: { id: input.chatId },
      select: { driverId: true },
    })

    if (chat && !chat.driverId) {
      const contact = await prisma.contact.findUnique({
        where: { id: input.contactId },
        select: { yandexDriverId: true },
      })

      if (contact?.yandexDriverId) {
        const driver = await prisma.driver.findUnique({
          where: { yandexDriverId: contact.yandexDriverId },
          select: { id: true },
        })
        if (driver) updateData.driverId = driver.id
      }
    }

    await prisma.chat.update({
      where: { id: input.chatId },
      data: updateData,
    })
  },
}
