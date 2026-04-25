import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { normalizePhoneE164 } from '@/lib/phoneUtils'
import { ContactService } from '@/lib/ContactService'
import { ChatChannel } from '@prisma/client'

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

    if (!rawPhone || !channel) {
      return NextResponse.json(
        { error: 'phone and channel are required' },
        { status: 400 }
      )
    }

    if (channel === 'yandex_pro') {
      return NextResponse.json(
        { error: 'CHANNEL_READONLY', message: 'Yandex Pro channel is read-only' },
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

    // Resolve or create Contact via ContactService
    const { contact, identity, isNew: isNewContact } = await ContactService.resolveContact(
      channel,
      externalId,
      normalized,
      null,
    )

    // Find or create Chat
    const externalChatId = `${channel}:${externalId}`
    // Find or create Chat. Lookup order matters: legacy chats often
    // have a channel-level externalChatId (e.g. telegram:<TG user id>,
    // not telegram:<phone>) and may be linked only via driver, not
    // contact. Without these fallbacks "+ search by phone" created a
    // brand-new empty chat next to the existing history-rich one,
    // and operators ended up writing into a separate row from the
    // actual conversation log.
    let chat: any = null
    let isNewChat = false

    // 1. By contactId (the canonical link).
    chat = await prisma.chat.findFirst({
      where: { contactId: contact.id, channel },
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
    })

    // 2. By driverId — legacy Telegram listener / WA importer wrote
    //    driverId before contactId was wired in.
    if (!chat) {
      const driver = await prisma.driver.findFirst({ where: { phone: normalized } })
      if (driver) {
        chat = await prisma.chat.findFirst({
          where: { driverId: driver.id, channel },
          orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
        })
      }
    }

    // 3. By phone-as-externalChatId (the original lookup, last resort).
    if (!chat) {
      chat = await prisma.chat.findUnique({ where: { externalChatId } })
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
  } catch (err: any) {
    console.error('[contacts/start-conversation] POST Error:', err.message)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
