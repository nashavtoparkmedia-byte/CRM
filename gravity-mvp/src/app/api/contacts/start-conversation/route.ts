import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { normalizePhoneE164 } from '@/lib/phoneUtils'
import { ContactService } from '@/lib/ContactService'
import { Chat, ChatChannel } from '@prisma/client'
import { resolveStrictPhoneOwnership } from '@/lib/contacts/strict-phone-ownership'

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
    const { phone: rawPhone, channel } = body

    if (!rawPhone || !channel) {
      return NextResponse.json(
        { error: 'phone and channel are required' },
        { status: 400 }
      )
    }

    const validChannels: ChatChannel[] = ['telegram', 'whatsapp', 'max']
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

    const externalId = normalized.replace('+', '')

    const ownership = await resolveStrictPhoneOwnership(prisma, normalized)
    if (ownership.kind === 'ambiguous') {
      return NextResponse.json({
        error: 'PHONE_OWNERSHIP_AMBIGUOUS',
        candidateContactIds: ownership.contactIds,
      }, { status: 409 })
    }

    // Resolve or create Contact via ContactService
    const { contact, identity, isNew: isNewContact } = await ContactService.resolveContact(
      channel,
      externalId,
      normalized,
      null,
      {
        phoneEvidence: { source: 'manual_verified', trustedForAutomaticResolution: true },
        ambiguousPhone: 'reject',
      },
    )
    const contactProfile = await prisma.contact.findUnique({
      where: { id: contact.id },
      select: { mainDriverId: true },
    })

    // Find or create Chat
    const externalChatId = `${channel}:${externalId}`
    // Find or create Chat. Lookup order matters: legacy chats often
    // have a channel-level externalChatId (e.g. telegram:<TG user id>,
    // not telegram:<phone>) and may be linked only via driver, not
    // contact. Without these fallbacks "+ search by phone" created a
    // brand-new empty chat next to the existing history-rich one,
    // and operators ended up writing into a separate row from the
    // actual conversation log.
    let chat: Chat | null = null
    let isNewChat = false

    // 1. By contactId (the canonical link).
    chat = await prisma.chat.findFirst({
      where: { contactId: contact.id, channel },
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
    })

    // 2. By the Contact's already selected main profile. A phone alone can
    // match several DriverProfiles across parks, so it must never select the
    // first Driver row as a chat-routing fallback.
    if (!chat && contactProfile?.mainDriverId) {
      chat = await prisma.chat.findFirst({
        where: {
          driverId: contactProfile.mainDriverId,
          channel,
          OR: [{ contactId: null }, { contactId: contact.id }],
        },
        orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      })
    }

    // 3. By phone-as-externalChatId (the original lookup, last resort).
    if (!chat) {
      const identityChat = await prisma.chat.findUnique({ where: { externalChatId } })
      if (identityChat?.contactId && identityChat.contactId !== contact.id) {
        return NextResponse.json(
          { error: 'CHAT_CONTACT_CONFLICT', message: 'Канал уже связан с другим Contact' },
          { status: 409 },
        )
      }
      chat = identityChat
    }

    if (!chat) {
      chat = await prisma.chat.create({
        data: {
          channel,
          externalChatId,
          name: contact.displayName,
          status: 'new',
          contactId: contact.id,
          contactIdentityId: identity.id,
        },
      })
      isNewChat = true
    } else {
      // Backfill the contact link so future "+search" calls hit
      // branch 1 directly and stay consistent.
      const updates: Record<string, string> = {}
      if (!chat.contactId) updates.contactId = contact.id
      if (!chat.contactIdentityId) updates.contactIdentityId = identity.id
      if (Object.keys(updates).length > 0) {
        await prisma.chat.update({ where: { id: chat.id }, data: updates })
      }
    }

    return NextResponse.json({
      contact: {
        id: contact.id,
        displayName: contact.displayName,
        isNew: isNewContact,
      },
      chat: {
        id: chat.id,
        channel: chat.channel,
        externalChatId: chat.externalChatId,
        isNew: isNewChat,
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[contacts/start-conversation] POST Error:', message)
    if (message === 'PHONE_OWNERSHIP_AMBIGUOUS' || message === 'PHONE_IDENTITY_CONFLICT') {
      return NextResponse.json({ error: message }, { status: 409 })
    }
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
