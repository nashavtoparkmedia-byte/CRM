import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { ChatChannel } from '@prisma/client'

/**
 * POST /api/contacts/:id/chats
 *
 * Открыть существующий или создать новый Chat для контакта в указанном канале.
 * Привязывает Chat к Contact и ContactIdentity.
 *
 * Spec: unified-contact-spec.md v1.1 §6.4, §12.2
 *
 * Errors:
 *   CHANNEL_READONLY — yandex_pro
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

    if (!channel) {
      return NextResponse.json({ error: 'channel is required' }, { status: 400 })
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

    // Validate contact exists
    const contact = await prisma.contact.findUnique({ where: { id } })
    if (!contact || contact.isArchived) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    // Find or resolve identity
    let identity

    if (identityId) {
      identity = await prisma.contactIdentity.findFirst({
        where: { id: identityId, contactId: id, channel, isActive: true },
      })
      if (!identity) {
        return NextResponse.json(
          { error: 'Identity not found or does not match contact/channel' },
          { status: 404 }
        )
      }
    } else {
      // Find existing identity for this channel
      identity = await prisma.contactIdentity.findFirst({
        where: { contactId: id, channel, isActive: true },
        orderBy: { createdAt: 'asc' },
      })
    }

    // If no identity, try to create one from phone
    if (!identity) {
      const phone = await prisma.contactPhone.findFirst({
        where: { contactId: id, isActive: true },
        orderBy: { isPrimary: 'desc' },
      })

      if (!phone) {
        return NextResponse.json(
          { error: 'NO_IDENTITY', message: `Contact has no identity in ${channel} and no phone number to create one` },
          { status: 400 }
        )
      }

      // Create identity from phone
      const externalId = phone.phone.replace('+', '')
      identity = await prisma.contactIdentity.create({
        data: {
          contactId: id,
          channel,
          externalId,
          phoneId: phone.id,
          source: 'manual',
          confidence: 1.0,
        },
      })
    }

    // Find existing chat for this identity
    const externalChatId = `${channel}:${identity.externalId}`
    let chat = await prisma.chat.findUnique({
      where: { externalChatId },
    })

    let isNew = false

    if (!chat) {
      chat = await prisma.chat.create({
        data: {
          channel,
          externalChatId,
          name: contact.displayName,
          status: 'active',
          contactId: id,
          contactIdentityId: identity.id,
        },
      })
      isNew = true
    } else {
      // Ensure contactId/contactIdentityId are set (never overwrite existing)
      const updates: Record<string, string> = {}
      if (!chat.contactId) updates.contactId = id
      if (!chat.contactIdentityId) updates.contactIdentityId = identity.id
      if (Object.keys(updates).length > 0) {
        await prisma.chat.update({ where: { id: chat.id }, data: updates })
      }
    }

    return NextResponse.json({
      chat: {
        id: chat.id,
        channel: chat.channel,
        contactId: id,
        contactIdentityId: identity.id,
        externalChatId: chat.externalChatId,
        status: chat.status,
        isNew,
      },
    })
  } catch (err: any) {
    console.error('[contacts/:id/chats] POST Error:', err.message)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
