import { prisma } from '@/lib/prisma'
import type { MessageEventLogPersistencePortV1 } from './message-event-log-handler'

export const legacyPrismaMessageEventLogPortV1: MessageEventLogPersistencePortV1 = {
  async claim(messageId) {
    const result = await prisma.$executeRawUnsafe(
      'UPDATE "MessageEventLog" SET status = \'processing\', "updatedAt" = NOW() WHERE "messageId" = $1 AND "eventType" = \'MessageReceived\' AND status = \'pending\'',
      messageId,
    )
    return { claimed: result !== 0 }
  },

  async complete(messageId) {
    await prisma.$executeRawUnsafe(
      'UPDATE "MessageEventLog" SET status = \'processed\', "updatedAt" = NOW() WHERE "messageId" = $1 AND "eventType" = \'MessageReceived\' AND status = \'processing\'',
      messageId,
    )
  },

  async fail(messageId) {
    await prisma.$executeRawUnsafe(
      'UPDATE "MessageEventLog" SET status = \'failed\', "updatedAt" = NOW() WHERE "messageId" = $1 AND "eventType" = \'MessageReceived\' AND status = \'processing\'',
      messageId,
    )
  },
}
