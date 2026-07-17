import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

function parseTelegramId(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null
  try {
    return BigInt(value.trim())
  } catch {
    return null
  }
}

// GET /api/bot-link?telegramId=316425068
export async function GET(req: NextRequest) {
  const telegramId = req.nextUrl.searchParams.get('telegramId')?.trim()
  if (!telegramId) return NextResponse.json({ error: 'telegramId required' }, { status: 400 })

  try {
    const link = await prisma.driverTelegram.findFirst({
      where: { telegramId: BigInt(telegramId) },
    })

    if (!link) return NextResponse.json({ linked: false })

    const driver = await prisma.driver.findUnique({
      where: { id: link.driverId },
      select: { id: true, fullName: true, phone: true },
    })

    return NextResponse.json({
      linked: true,
      driverId: driver?.id ?? null,
      driverName: driver?.fullName ?? null,
      driverPhone: driver?.phone ?? null,
    })
  } catch {
    return NextResponse.json({ error: 'Invalid telegramId' }, { status: 400 })
  }
}

// POST /api/bot-link
// { action: 'search', query: string } → { drivers }
// { action: 'link', telegramId: string, driverId: string, contactId?: string } → { success }
// { action: 'unlink', telegramId: string, contactId: string } → { success }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))

  if (body.action === 'search') {
    const query: string = (body.query ?? '').trim()
    if (query.length < 3) return NextResponse.json({ drivers: [] })

    const digits = query.replace(/\D/g, '')
    const drivers = await prisma.driver.findMany({
      where: {
        OR: [
          ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
          { fullName: { contains: query, mode: 'insensitive' as const } },
        ],
      },
      select: { id: true, fullName: true, phone: true },
      take: 10,
    })

    return NextResponse.json({ drivers })
  }

  if (body.action === 'link') {
    const { telegramId, driverId, contactId } = body
    const telegramIdValue = parseTelegramId(telegramId)
    if (!telegramIdValue || !driverId) {
      return NextResponse.json({ error: 'telegramId and driverId required' }, { status: 400 })
    }

    const driver = await prisma.driver.findUnique({
      where: { id: driverId },
      select: {
        id: true,
        fullName: true,
        contactId: true,
        yandexDriverId: true,
        parkId: true,
      },
    })
    if (!driver) return NextResponse.json({ error: 'Driver not found' }, { status: 404 })

    if (contactId) {
      const contact = await prisma.contact.findUnique({
        where: { id: contactId },
        select: {
          id: true,
          isArchived: true,
          mainDriverId: true,
          yandexDriverId: true,
        },
      })
      const belongsToContact = Boolean(
        contact
        && !contact.isArchived
        && (
          driver.contactId === contact.id
          || driver.id === contact.mainDriverId
          || (contact.yandexDriverId && driver.yandexDriverId === contact.yandexDriverId)
        )
      )
      if (!belongsToContact) {
        return NextResponse.json({
          error: 'PROFILE_NOT_ATTACHED',
          message: 'Сначала привяжите профиль водителя к текущему контакту',
        }, { status: 409 })
      }
      if (!driver.parkId) {
        return NextResponse.json({
          error: 'PROFILE_PARK_REQUIRED',
          message: 'У выбранного профиля водителя не определён парк',
        }, { status: 409 })
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.driverTelegram.deleteMany({ where: { driverId } })
      await tx.driverTelegram.deleteMany({ where: { telegramId: telegramIdValue } })
      await tx.driverTelegram.create({
        data: {
          telegramId: telegramIdValue,
          driverId,
          activeParkId: driver.parkId,
        },
      })
    })

    return NextResponse.json({ success: true, driverName: driver.fullName })
  }

  if (body.action === 'unlink') {
    const telegramId = typeof body.telegramId === 'string' ? body.telegramId.trim() : ''
    const contactId = typeof body.contactId === 'string' ? body.contactId.trim() : ''
    const telegramIdValue = parseTelegramId(telegramId)
    if (!telegramIdValue || !contactId) {
      return NextResponse.json({ error: 'telegramId and contactId required' }, { status: 400 })
    }

    const link = await prisma.driverTelegram.findUnique({
      where: { telegramId: telegramIdValue },
    })
    if (!link) return NextResponse.json({ success: true, deleted: false })

    const driver = await prisma.driver.findUnique({
      where: { id: link.driverId },
      select: { id: true, contactId: true, yandexDriverId: true },
    })
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      select: {
        id: true,
        isArchived: true,
        mainDriverId: true,
        yandexDriverId: true,
      },
    })
    const belongsToContact = Boolean(
      driver
      && contact
      && !contact.isArchived
      && (
        driver.contactId === contact.id
        || driver.id === contact.mainDriverId
        || (contact.yandexDriverId && driver.yandexDriverId === contact.yandexDriverId)
      )
    )
    if (!belongsToContact) {
      return NextResponse.json({
        error: 'BINDING_CONTACT_MISMATCH',
        message: 'Эта привязка Telegram-бота относится к другому контакту',
      }, { status: 409 })
    }

    await prisma.driverTelegram.delete({ where: { id: link.id } })
    return NextResponse.json({ success: true, deleted: true })
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
}
