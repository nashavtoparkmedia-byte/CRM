'use server'

import { RESOLVE_CONVERSATION_CONTACT_QUERY_V1 } from '@/contracts/messaging/v1'
import { resolveConversationContactV1 } from '@/modules/messaging/public/v1'

/**
 * Which person page the «Открыть в CRM» entry of the conversation drawer may lead
 * to. The answer is Messaging's own RCQ1 for the exact persisted Chat.id — never
 * the client-side contactId of a grouped row — so an unresolved, ambiguous or
 * grouped («Все», several chats) conversation gets no link at all (BD-F2 1a/2a).
 * It names only a Contact id; the page it leads to applies its own authority.
 */
export type ContactPersonCardLinkResultV1 =
  | { status: 'resolved'; contactId: string }
  | { status: 'unavailable' }

export async function resolveContactPersonCardLinkAction(chatId: unknown): Promise<ContactPersonCardLinkResultV1> {
  if (typeof chatId !== 'string' || chatId === '' || chatId.trim() !== chatId || chatId.includes(',')) {
    return { status: 'unavailable' }
  }
  try {
    const resolution = await resolveConversationContactV1({ contract: RESOLVE_CONVERSATION_CONTACT_QUERY_V1, chatId })
    return resolution.status === 'resolved'
      ? { status: 'resolved', contactId: resolution.contactId }
      : { status: 'unavailable' }
  } catch {
    return { status: 'unavailable' }
  }
}
