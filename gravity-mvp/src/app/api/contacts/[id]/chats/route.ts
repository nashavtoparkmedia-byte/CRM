import { NextRequest, NextResponse } from 'next/server'
import {
  openContactConversationForContactV1,
  type PlatformContactConversationChannelV1,
} from '@/modules/platform-shell/internal/contact-conversation-orchestrator'
import {
  getIntegrationAdminPrincipal,
  isExactSameOriginMutationRequest,
} from '@/modules/identity-access/public/v1'

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
  if (!isExactSameOriginMutationRequest(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (!await getIntegrationAdminPrincipal()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id } = await params
    const body = await req.json()
    const { channel, identityId, phoneId, profileId } = body
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
      phoneId: phoneId ? phoneId : null,
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
      if (result.status === 'identity_ambiguous') {
        return NextResponse.json(
          { error: 'IDENTITY_AMBIGUOUS', message: 'Select an exact channel identity before writing' },
          { status: 409 },
        )
      }
      if (result.status === 'identity_conflicted') {
        return NextResponse.json(
          { error: 'IDENTITY_CONFLICTED', message: 'Resolve the channel identity conflict before writing' },
          { status: 409 },
        )
      }
      if (result.status === 'phone_not_found') {
        return NextResponse.json(
          { error: 'Phone not found or does not belong to contact' },
          { status: 404 },
        )
      }
      if (result.status === 'identity_unreachable') {
        return NextResponse.json(
          { error: 'IDENTITY_UNREACHABLE', message: 'Channel identity is unavailable' },
          { status: 409 },
        )
      }
      if (result.status === 'identity_reachability_unknown') {
        return NextResponse.json(
          { error: 'IDENTITY_REACHABILITY_UNKNOWN', message: 'Channel reachability must be confirmed before writing' },
          { status: 409 },
        )
      }
      if (result.status === 'transport_unbound') {
        return NextResponse.json(
          { error: 'TRANSPORT_UNBOUND', message: 'No proven transport is bound to this conversation' },
          { status: 409 },
        )
      }
      if (result.status === 'provider_account_unproven') {
        return NextResponse.json(
          { error: 'PROVIDER_ACCOUNT_UNPROVEN', message: 'No exact provider-account scope is proven' },
          { status: 409 },
        )
      }
      if (result.status === 'conversation_target_unproven') {
        return NextResponse.json(
          { error: 'CONVERSATION_TARGET_UNPROVEN', message: 'No channel-proven conversation target exists' },
          { status: 409 },
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
  } catch (err: unknown) {
    console.error(
      '[contacts/:id/chats] POST Error:',
      err instanceof Error ? err.message : String(err),
    )
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
