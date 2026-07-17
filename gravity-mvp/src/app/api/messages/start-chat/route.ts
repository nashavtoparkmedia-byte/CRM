import { Chat, ChatChannel } from '@prisma/client'
import { NextResponse } from 'next/server'

import { ContactService } from '@/lib/ContactService'
import { attachDriverProfilesToContactManually } from '@/lib/driver-profiles/multi-park'
import { normalizePhoneE164 } from '@/lib/phoneUtils'
import { prisma } from '@/lib/prisma'

type DriverTelegramRow = { telegramId: bigint | number | string | null }

function supportedChannel(value: unknown): value is ChatChannel {
  return value === 'telegram' || value === 'whatsapp' || value === 'max'
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const driverId = text(body.driverId)
    const channel = body.channel
    const suppliedExternalChatId = text(body.externalChatId)
    if (!driverId || !supportedChannel(channel)) {
      return NextResponse.json({ error: 'DriverId and a supported channel are required' }, { status: 400 })
    }

    const isUnsaved = driverId.startsWith('unsaved_')
    const driver = isUnsaved
      ? null
      : await prisma.driver.findUnique({
        where: { id: driverId },
        select: { id: true, contactId: true, fullName: true, phone: true },
      })
    if (!isUnsaved && !driver) return NextResponse.json({ error: 'Driver not found' }, { status: 404 })

    let externalId = suppliedExternalChatId
    if (!externalId) {
      if (isUnsaved) {
        externalId = driverId.slice('unsaved_'.length)
      } else if (channel === 'telegram') {
        const telegramRows = await prisma.$queryRaw<DriverTelegramRow[]>`
          SELECT "telegramId" FROM "DriverTelegram" WHERE "driverId" = ${driverId} LIMIT 1
        `
        externalId = telegramRows[0]?.telegramId?.toString() || driver?.phone?.replace(/\D/g, '') || null
      } else {
        externalId = driver?.phone?.replace(/\D/g, '') || null
      }
    }
    if (!externalId) {
      return NextResponse.json({ error: 'Could not determine external chat ID for this channel' }, { status: 400 })
    }

    const phone = isUnsaved
      ? normalizePhoneE164(externalId)
      : normalizePhoneE164(driver?.phone)
    const displayName = isUnsaved ? `+${externalId}` : driver?.fullName || null

    const contactResult = driver?.contactId
      ? await ContactService.ensureIdentityForContact(driver.contactId, channel, externalId, displayName)
      : await ContactService.resolveContact(channel, externalId, phone, displayName)

    if (driver && !driver.contactId) {
      const attachment = await attachDriverProfilesToContactManually(contactResult.contact.id, [driver.id], 'operator')
      if (!attachment.ok) {
        return NextResponse.json({ error: attachment.error, driverIds: 'driverIds' in attachment ? attachment.driverIds : [] }, { status: 409 })
      }
    }

    const externalChatId = `${channel}:${externalId}`
    const existing = await prisma.chat.findUnique({ where: { externalChatId } })
    if (existing?.contactId && existing.contactId !== contactResult.contact.id) {
      return NextResponse.json({ error: 'CHAT_CONTACT_CONFLICT' }, { status: 409 })
    }
    if (existing?.driverId && !isUnsaved && existing.driverId !== driverId) {
      return NextResponse.json({ error: 'CHAT_DRIVER_CONFLICT' }, { status: 409 })
    }

    let chat: Chat
    if (existing) {
      chat = await prisma.chat.update({
        where: { id: existing.id },
        data: {
          contactId: contactResult.contact.id,
          contactIdentityId: contactResult.identity.id,
          ...(isUnsaved ? {} : { driverId }),
          ...(displayName ? { name: displayName } : {}),
        },
      })
    } else {
      chat = await prisma.chat.create({
        data: {
          channel,
          externalChatId,
          name: displayName,
          status: 'new',
          contactId: contactResult.contact.id,
          contactIdentityId: contactResult.identity.id,
          ...(isUnsaved ? {} : { driverId }),
        },
      })
    }

    return NextResponse.json(chat)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[API-START-CHAT] POST Error:', message)
    const status = ['CONTACT_NOT_FOUND', 'CONTACT_ARCHIVED', 'CONTACT_IDENTITY_CONFLICT'].includes(message) ? 409 : 500
    return NextResponse.json({ error: status === 409 ? message : 'Internal Server Error' }, { status })
  }
}
