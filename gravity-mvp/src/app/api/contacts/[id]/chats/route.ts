import { NextRequest, NextResponse } from 'next/server'
import {
  openContactConversationForContactV1,
  type PlatformContactConversationChannelV1,
} from '@/modules/platform-shell/internal/contact-conversation-orchestrator'

/**
 * POST /api/contacts/:id/chats
 *
 * Открыть существующий или создать новый Chat для контакта в указанном канале.
 * Привязывает Chat к Contact и ContactIdentity.
 *
 * Spec: unified-contact-spec.md v1.1 §6.4, §12.2
 *
 * Errors:
 *   NO_IDENTITY — нет identity и нет phone для создания
 *   NO_ACCOUNT — нет подключённого аккаунта (future)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await req.json()
    const { channel, identityId, profileId } = body
    void profileId

    if (!channel) {
      return NextResponse.json({ error: 'channel is required' }, { status: 400 })
    }

    const validChannels: PlatformContactConversationChannelV1[] = ['telegram', 'whatsapp', 'max']
    if (!validChannels.includes(channel)) {
      return NextResponse.json({ error: 'Invalid channel' }, { status: 400 })
    }

    const result = await openContactConversationForContactV1({
      contactId: id,
      channel,
      identityId: identityId ? identityId : null,
    })
    if (result.status !== 'ready') {
      if (result.status === 'contact_not_found') {
        return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
      }
      if (result.status === 'identity_not_found') {
        return NextResponse.json(
          { error: 'Identity not found or does not match contact/channel' },
          { status: 404 }
        )
      }
      return NextResponse.json(
        { error: 'NO_IDENTITY', message: `Contact has no identity in ${channel} and no phone number to create one` },
        { status: 400 }
      )
    }

    return NextResponse.json({
      chat: {
        id: result.conversation.id,
        channel: result.conversation.channel,
        contactId: id,
        contactIdentityId: result.identity.id,
        externalChatId: result.conversation.externalChatId,
        status: result.conversation.status,
        isNew: result.isNewConversation,
      },
    })
  } catch (err: any) {
    console.error('[contacts/:id/chats] POST Error:', err.message)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
