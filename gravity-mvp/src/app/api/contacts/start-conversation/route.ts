import { NextRequest, NextResponse } from 'next/server'
import { normalizePhoneE164 } from '@/modules/contacts/public/v1/phone-identity'
import {
  startContactConversationByPhoneV1,
  type PlatformContactConversationChannelV1,
} from '@/modules/platform-shell/internal/contact-conversation-orchestrator'

/**
 * POST /api/contacts/start-conversation
 *
 * Создать новый чат по номеру телефона.
 * Если Contact с таким номером существует — использовать его.
 * Если нет — создать Contact + Phone + Identity + Chat.
 *
 * Spec: unified-contact-spec.md v1.1 §12.2
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { phone: rawPhone, channel, profileId } = body
    void profileId

    if (!rawPhone || !channel) {
      return NextResponse.json(
        { error: 'phone and channel are required' },
        { status: 400 }
      )
    }

    const validChannels: PlatformContactConversationChannelV1[] = ['telegram', 'whatsapp', 'max']
    if (!validChannels.includes(channel)) {
      return NextResponse.json({ error: 'Invalid channel' }, { status: 400 })
    }

    const normalized = normalizePhoneE164(rawPhone)
    if (!normalized) {
      return NextResponse.json(
        { error: 'INVALID_PHONE', message: 'Invalid phone number format' },
        { status: 400 }
      )
    }

    const result = await startContactConversationByPhoneV1({
      normalizedPhone: normalized,
      channel,
    })

    return NextResponse.json({
      contact: {
        id: result.contact.id,
        displayName: result.contact.displayName,
        isNew: result.isNewContact,
      },
      chat: {
        id: result.conversation.id,
        channel: result.conversation.channel,
        externalChatId: result.conversation.externalChatId,
        isNew: result.isNewConversation,
      },
    })
  } catch (err: any) {
    console.error('[contacts/start-conversation] POST Error:', err.message)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
