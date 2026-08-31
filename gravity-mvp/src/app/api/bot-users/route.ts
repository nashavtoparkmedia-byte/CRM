import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { DELETE_DRIVER_TELEGRAM_LINK_COMMAND_V1, DISMISS_BOT_LINK_REQUEST_COMMAND_V1 } from '@/contracts/telegram-channel/v1'
import { hasIntegrationAdminAccess } from '@/modules/identity-access/public/v1'
import { PendingBotLinkRequestNotFoundError, buildPendingBotLinkRequests, deleteDriverTelegramLinkV1, dismissBotLinkRequestV1 } from '@/modules/telegram-channel/public/v1'

const TELEGRAM_ID_PATTERN = /^[1-9]\d{0,19}$/
const TELEGRAM_ID_MAX = 9_223_372_036_854_775_807n
const REQUEST_ID_MAX_LENGTH = 200

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

function isValidTelegramId(value: string): boolean {
  return TELEGRAM_ID_PATTERN.test(value) && BigInt(value) <= TELEGRAM_ID_MAX
}

// GET /api/bot-users — linked drivers + pending link requests
export async function GET() {
  if (!(await hasIntegrationAdminAccess())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const [dtRows, legacyRequests, registryRows] = await Promise.all([
    prisma.driverTelegram.findMany({
      orderBy: { createdAt: 'desc' },
    }),
    prisma.botChatMessage.findMany({
      where: {
        driverId: null,
        direction: 'INCOMING',
        text: { startsWith: '[Запрос привязки]' },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.botUserRegistry.findMany({
      orderBy: { lastSeenAt: 'desc' },
    }),
  ])

  const driverIds = dtRows.map(r => r.driverId)
  const allTelegramIds = [
    ...dtRows.map(r => `telegram:${r.telegramId}`),
    ...legacyRequests.map(r => `telegram:${r.telegramId}`),
    ...registryRows.map(r => `telegram:${r.telegramId}`),
  ]

  const [drivers, parks, chats] = await Promise.all([
    driverIds.length
      ? prisma.driver.findMany({
          where: { id: { in: driverIds } },
          select: { id: true, fullName: true, phone: true },
        })
      : [],
    dtRows.some(r => r.activeParkId)
      ? prisma.apiConnection.findMany({
          where: { parkId: { in: dtRows.map(r => r.activeParkId).filter(Boolean) as string[] } },
          select: { parkId: true, name: true },
        })
      : [],
    allTelegramIds.length
      ? prisma.chat.findMany({
          where: { channel: 'telegram', externalChatId: { in: allTelegramIds } },
          select: { id: true, externalChatId: true },
        })
      : [],
  ])

  const driverMap = Object.fromEntries(drivers.map(d => [d.id, d]))
  const parkMap = Object.fromEntries(parks.map(p => [p.parkId, p.name || p.parkId]))
  const registryMap = Object.fromEntries(registryRows.map(row => [row.telegramId.toString(), row]))
  // chatMap keyed by raw telegramId string (without prefix)
  const chatMap = Object.fromEntries(
    chats.map(c => [c.externalChatId.replace('telegram:', ''), c.id])
  )

  const linked = dtRows.map(row => {
    const driver = driverMap[row.driverId]
    const tgId = row.telegramId.toString()
    const registry = registryMap[tgId]
    return {
      id: row.id,
      telegramId: tgId,
      username: row.username || registry?.username || null,
      firstName: registry?.firstName || null,
      lastName: registry?.lastName || null,
      driverId: row.driverId,
      driverName: driver?.fullName ?? null,
      driverPhone: driver?.phone ?? null,
      activeParkId: row.activeParkId,
      parkName: row.activeParkId ? (parkMap[row.activeParkId] ?? null) : null,
      chatId: chatMap[tgId] ?? null,
      createdAt: row.createdAt.toISOString(),
    }
  })

  const linkedTelegramIds = new Set(dtRows.map(row => row.telegramId.toString()))
  const requests = buildPendingBotLinkRequests({ registryRows, legacyRequests, linkedTelegramIds, chatMap })

  return NextResponse.json({ linked, requests })
}

// DELETE /api/bot-users
// { action: 'unlink', telegramId: string } — unlink driver from bot
// { action: 'dismiss', requestId: string } — dismiss pending link request
export async function DELETE(req: NextRequest) {
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

  if (body.action === 'unlink') {
    const telegramId = typeof body.telegramId === 'string' ? body.telegramId : ''
    if (!isValidTelegramId(telegramId)) {
      return NextResponse.json({ error: 'valid telegramId required' }, { status: 400 })
    }
    await deleteDriverTelegramLinkV1({ contract: DELETE_DRIVER_TELEGRAM_LINK_COMMAND_V1, telegramId: BigInt(telegramId) })
    return NextResponse.json({ success: true })
  }

  if (body.action === 'dismiss') {
    const requestId = typeof body.requestId === 'string' ? body.requestId : ''
    if (!requestId || requestId.length > REQUEST_ID_MAX_LENGTH) {
      return NextResponse.json({ error: 'valid requestId required' }, { status: 400 })
    }
    try {
      await dismissBotLinkRequestV1({ contract: DISMISS_BOT_LINK_REQUEST_COMMAND_V1, requestId })
    } catch (error) {
      if (error instanceof PendingBotLinkRequestNotFoundError) {
        return NextResponse.json({ error: error.message }, { status: 404 })
      }
      throw error
    }
    return NextResponse.json({ success: true })
  }

  return NextResponse.json({ error: 'valid action required' }, { status: 400 })
}
