import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { REPLACE_DRIVER_TELEGRAM_LINK_COMMAND_V1, UPSERT_DRIVER_TELEGRAM_LINK_COMMAND_V1 } from '@/contracts/telegram-channel/v1'
import { searchYandexParksByDriverQueryV1, upsertParkMatchedDriverV1 } from '@/modules/fleet-operations/public/v1'
import { replaceDriverTelegramLinkV1, upsertDriverTelegramLinkV1 } from '@/modules/telegram-channel/public/v1'

type DriverSearchRow = {
  id: string
  yandexDriverId: string | null
  fullName: string
  phone: string | null
  parkId: string | null
  parkName: string | null
  workStatus: string | null
  currentStatus: string | null
  source: 'crm' | 'yandex'
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
// { action: 'link', telegramId: string, driverId: string } → { success }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))

  if (body.action === 'search') {
    const query: string = (body.query ?? '').trim()
    if (query.length < 3) return NextResponse.json({ drivers: [] })

    const digits = query.replace(/\D/g, '')
    const localDrivers = await prisma.driver.findMany({
      where: {
        OR: [
          ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
          { fullName: { contains: query, mode: 'insensitive' as const } },
        ],
      },
      select: { id: true, yandexDriverId: true, fullName: true, phone: true },
      take: 10,
    })

    const yandex = await searchYandexParksByDriverQueryV1(query)
    const localByYandexId = new Map(
      localDrivers.filter(driver => driver.yandexDriverId).map(driver => [driver.yandexDriverId!, driver]),
    )
    const yandexProfileIds = new Set<string>()
    const yandexProfilesByName = new Map<string, Set<string>>()
    const drivers: DriverSearchRow[] = yandex.results.flatMap(park => park.profiles.map(profile => {
      yandexProfileIds.add(profile.id)
      const normalizedName = profile.fullName.toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ').trim()
      const phones = yandexProfilesByName.get(normalizedName) || new Set<string>()
      profile.phones.forEach(phone => phones.add(phone.replace(/\D/g, '')))
      yandexProfilesByName.set(normalizedName, phones)
      const local = localByYandexId.get(profile.id)
      return {
        id: local?.id || `yandex:${park.parkId}:${profile.id}`,
        yandexDriverId: profile.id,
        fullName: profile.fullName,
        phone: profile.phones[0] || local?.phone || null,
        parkId: park.parkId,
        parkName: park.parkName,
        workStatus: profile.workStatus,
        currentStatus: profile.currentStatus,
        source: 'yandex' as const,
      }
    }))

    for (const driver of localDrivers) {
      if (driver.yandexDriverId && yandexProfileIds.has(driver.yandexDriverId)) continue
      const normalizedName = driver.fullName.toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ').trim()
      const matchingYandexPhones = yandexProfilesByName.get(normalizedName)
      const localPhone = driver.phone?.replace(/\D/g, '') || ''
      if (matchingYandexPhones && (!localPhone || matchingYandexPhones.has(localPhone))) continue
      drivers.push({
        id: driver.id,
        yandexDriverId: driver.yandexDriverId,
        fullName: driver.fullName,
        phone: driver.phone,
        parkId: null,
        parkName: null,
        workStatus: null,
        currentStatus: null,
        source: 'crm' as const,
      })
    }

    return NextResponse.json({ drivers: drivers.slice(0, 30), checkedParks: yandex.checkedParks, errors: yandex.errors })
  }

  if (body.action === 'link') {
    const { telegramId, driverId } = body
    if (!telegramId || !driverId) {
      return NextResponse.json({ error: 'telegramId and driverId required' }, { status: 400 })
    }

    const yandexDriverId = typeof body.yandexDriverId === 'string' ? body.yandexDriverId.trim() : ''
    const parkId = typeof body.parkId === 'string' ? body.parkId.trim() : ''
    const driverName = typeof body.driverName === 'string' ? body.driverName.trim() : ''
    const username = typeof body.username === 'string' && body.username.trim() ? body.username.trim() : null

    if (yandexDriverId && parkId && driverName) {
      const verified = await searchYandexParksByDriverQueryV1(driverName)
      const park = verified.results.find(result => result.parkId === parkId)
      const profile = park?.profiles.find(candidate => candidate.id === yandexDriverId)
      if (!profile) {
        return NextResponse.json({ error: 'Yandex driver could not be verified in the selected park' }, { status: 404 })
      }

      const driver = await upsertParkMatchedDriverV1({
        yandexDriverId: profile.id,
        fullName: profile.fullName,
        phone: profile.phones[0] || null,
      })
      await upsertDriverTelegramLinkV1({
        contract: UPSERT_DRIVER_TELEGRAM_LINK_COMMAND_V1,
        driverId: driver.id,
        telegramId: BigInt(telegramId),
        username,
        activeParkId: parkId,
      })
      return NextResponse.json({ success: true, driverName: driver.fullName, parkName: park?.parkName || parkId })
    }

    const driver = await prisma.driver.findUnique({
      where: { id: driverId },
      select: { id: true, fullName: true },
    })
    if (!driver) return NextResponse.json({ error: 'Driver not found' }, { status: 404 })

    await replaceDriverTelegramLinkV1({ contract: REPLACE_DRIVER_TELEGRAM_LINK_COMMAND_V1, driverId, telegramId: BigInt(telegramId) })

    return NextResponse.json({ success: true, driverName: driver.fullName })
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
}
