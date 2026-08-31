import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { REPLACE_DRIVER_TELEGRAM_LINK_COMMAND_V1, UPSERT_DRIVER_TELEGRAM_LINK_COMMAND_V1 } from '@/contracts/telegram-channel/v1'
import { hasIntegrationAdminAccess } from '@/modules/identity-access/public/v1'
import {
  canonicalDriverNameKeyV1,
  normalizeDriverPhoneDigitsV1,
  normalizeDriverSearchQueryV1,
  searchLocalDriversV1,
  searchYandexParksByDriverQueryV1,
  upsertParkMatchedDriverV1,
} from '@/modules/fleet-operations/public/v1'
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

const DRIVER_ID_MAX_LENGTH = 200
const TELEGRAM_ID_PATTERN = /^[1-9]\d{0,19}$/
const TELEGRAM_ID_MAX = 9_223_372_036_854_775_807n
const TELEGRAM_USERNAME_PATTERN = /^[A-Za-z0-9_]{5,32}$/

function firstForwardedValue(value: string | null): string | null {
  return value?.split(',')[0]?.trim() || null
}

export function isSameOriginMutationRequest(req: NextRequest): boolean {
  const origin = req.headers.get('origin')
  const host = req.headers.get('host')?.trim() || null
  const forwardedHost = firstForwardedValue(req.headers.get('x-forwarded-host'))
  const forwardedProtocol = firstForwardedValue(req.headers.get('x-forwarded-proto'))?.toLowerCase()
  const protocol = forwardedProtocol || req.nextUrl.protocol.slice(0, -1).toLowerCase()
  if (!origin || !host) return false
  if (forwardedHost && forwardedHost.toLowerCase() !== host.toLowerCase()) return false
  if (protocol !== 'http' && protocol !== 'https') return false
  try {
    const parsedOrigin = new URL(origin)
    return parsedOrigin.protocol === `${protocol}:`
      && parsedOrigin.host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= DRIVER_ID_MAX_LENGTH
}

function normalizedTelegramId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return TELEGRAM_ID_PATTERN.test(normalized) && BigInt(normalized) <= TELEGRAM_ID_MAX
    ? normalized
    : null
}

// GET /api/bot-link?telegramId=316425068
export async function GET(req: NextRequest) {
  if (!(await hasIntegrationAdminAccess())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const telegramId = normalizedTelegramId(req.nextUrl.searchParams.get('telegramId'))
  if (!telegramId) return NextResponse.json({ error: 'valid telegramId required' }, { status: 400 })

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
  if (!isSameOriginMutationRequest(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (!(await hasIntegrationAdminAccess())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    return NextResponse.json({ error: 'Unsupported Media Type' }, { status: 415 })
  }

  const parsedBody: unknown = await req.json().catch(() => null)
  if (typeof parsedBody !== 'object' || parsedBody === null || Array.isArray(parsedBody)) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const body = parsedBody as Record<string, unknown>

  if (body.action === 'search') {
    const localSearch = await searchLocalDriversV1(body.query)
    if (localSearch.status === 'invalid') return NextResponse.json({ drivers: [] })
    const { query, drivers: localDrivers } = localSearch

    const yandex = await searchYandexParksByDriverQueryV1(query)
    const localByYandexId = new Map(
      localDrivers.filter(driver => driver.yandexDriverId).map(driver => [driver.yandexDriverId!, driver]),
    )
    const yandexProfileIds = new Set<string>()
    const yandexProfilesByName = new Map<string, Set<string>>()
    const seenYandexProfileIds = new Set<string>()
    const seenYandexNamePhoneKeys = new Set<string>()
    const drivers: DriverSearchRow[] = []
    for (const park of yandex.results) {
      for (const profile of park.profiles) {
        yandexProfileIds.add(profile.id)
        const normalizedName = canonicalDriverNameKeyV1(profile.fullName)
        const normalizedPhones = profile.phones.map(normalizeDriverPhoneDigitsV1).filter(Boolean)
        const phones = yandexProfilesByName.get(normalizedName) || new Set<string>()
        normalizedPhones.forEach(phone => phones.add(phone))
        yandexProfilesByName.set(normalizedName, phones)

        const namePhoneKeys = normalizedPhones.map(phone => `${normalizedName}\u0000${phone}`)
        const isDuplicate = seenYandexProfileIds.has(profile.id)
          || namePhoneKeys.some(key => seenYandexNamePhoneKeys.has(key))
        if (isDuplicate) continue

        seenYandexProfileIds.add(profile.id)
        namePhoneKeys.forEach(key => seenYandexNamePhoneKeys.add(key))
        const local = localByYandexId.get(profile.id)
        drivers.push({
          id: local?.id || `yandex:${park.parkId}:${profile.id}`,
          yandexDriverId: profile.id,
          fullName: profile.fullName,
          phone: profile.phones[0] || local?.phone || null,
          parkId: park.parkId,
          parkName: park.parkName,
          workStatus: profile.workStatus,
          currentStatus: profile.currentStatus,
          source: 'yandex' as const,
        })
      }
    }

    for (const driver of localDrivers) {
      if (driver.yandexDriverId && yandexProfileIds.has(driver.yandexDriverId)) continue
      const normalizedName = canonicalDriverNameKeyV1(driver.fullName)
      const matchingYandexPhones = yandexProfilesByName.get(normalizedName)
      const localPhone = normalizeDriverPhoneDigitsV1(driver.phone)
      if (matchingYandexPhones && localPhone && matchingYandexPhones.has(localPhone)) continue
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
    const telegramId = normalizedTelegramId(body.telegramId)
    const driverId = isBoundedIdentifier(body.driverId) ? body.driverId.trim() : ''
    if (!telegramId || !driverId) {
      return NextResponse.json({ error: 'valid telegramId and driverId required' }, { status: 400 })
    }

    const yandexDriverId = typeof body.yandexDriverId === 'string' ? body.yandexDriverId.trim() : ''
    const parkId = typeof body.parkId === 'string' ? body.parkId.trim() : ''
    const driverName = typeof body.driverName === 'string' ? body.driverName.trim() : ''
    const usernameValue = typeof body.username === 'string' ? body.username.trim() : ''
    const username = usernameValue || null
    if (
      yandexDriverId.length > DRIVER_ID_MAX_LENGTH
      || parkId.length > DRIVER_ID_MAX_LENGTH
      || (body.username !== undefined && body.username !== null && typeof body.username !== 'string')
      || (username !== null && !TELEGRAM_USERNAME_PATTERN.test(username))
      || ((!yandexDriverId || !parkId || !driverName) && driverId.startsWith('yandex:'))
    ) return NextResponse.json({ error: 'Invalid driver identity' }, { status: 400 })

    if (yandexDriverId && parkId && driverName) {
      const validatedQuery = normalizeDriverSearchQueryV1(driverName)
      if (validatedQuery.status === 'invalid') {
        return NextResponse.json({ error: 'Invalid driver search query' }, { status: 400 })
      }
      const verified = await searchYandexParksByDriverQueryV1(validatedQuery.query)
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
      return NextResponse.json({ success: true, driverName: profile.fullName, parkName: park?.parkName || parkId })
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
