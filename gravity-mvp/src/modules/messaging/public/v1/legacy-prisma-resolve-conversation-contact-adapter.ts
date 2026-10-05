import { prisma } from '@/lib/prisma'
import { resolveContactLineageV1 } from '@/modules/contacts/public/v1'
import type { ResolveConversationContactPortV1 } from './resolve-conversation-contact-handler'

// The status the conversation's contact resolution recorded, as the
// conversation view already reads it (`metadata.contactResolution.status`).
function recordedContactResolutionStatus(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const resolution = (metadata as Record<string, unknown>).contactResolution
  if (!resolution || typeof resolution !== 'object' || Array.isArray(resolution)) return null
  const status = (resolution as Record<string, unknown>).status
  return typeof status === 'string' ? status : null
}

export const legacyPrismaResolveConversationContactPortV1: ResolveConversationContactPortV1 = {
  async findConversationContact(chatId) {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: { contactId: true, metadata: true },
    })
    return chat
      ? { contactId: chat.contactId, contactResolutionStatus: recordedContactResolutionStatus(chat.metadata) }
      : null
  },
  async canonicalContactId(contactId) {
    const lineage = await resolveContactLineageV1(contactId)
    return lineage ? lineage.canonicalContactId : null
  },
}
