import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { normalizeDriverPhone } from '@/lib/botLinking'

const TG_BOT_API_URL = (process.env.TG_BOT_API_URL || 'http://tg-bot:3001').replace(/\/$/, '')
const IDENTIFICATION_AUDIT_PREFIX = '[Запрос идентификации]'
const IDENTIFICATION_COOLDOWN_MS = 10 * 60 * 1000

type RegistryRow = Awaited<ReturnType<typeof prisma.botUserRegistry.findMany>>[number]

function optionalProfileValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function refreshMissingTelegramProfiles(rows: RegistryRow[]) {
  const candidates = rows
    .filter(row => !row.profileCheckedAt && !row.username && !row.firstName && !row.lastName)
    .slice(0, 20)

  await Promise.all(candidates.map(async row => {
    try {
      const response = await fetch(`${TG_BOT_API_URL}/api/bot/profile/${row.telegramId}`, {
        headers: { 'x-bot-signature': process.env.BOT_CRM_SECRET || '' },
        cache: 'no-store',
        signal: AbortSignal.timeout(8_000),
      })

      if (!response.ok) {
        if (response.status === 404) {
          row.profileCheckedAt = new Date()
          await prisma.botUserRegistry.update({
            where: { telegramId: row.telegramId },
            data: { profileCheckedAt: row.profileCheckedAt },
          })
        }
        return
      }

      const profile = await response.json()
      const updated = await prisma.botUserRegistry.update({
        where: { telegramId: row.telegramId },
        data: {
          username: optionalProfileValue(profile.username),
          firstName: optionalProfileValue(profile.firstName),
          lastName: optionalProfileValue(profile.lastName),
          profileCheckedAt: new Date(),
        },
      })
      Object.assign(row, updated)
    } catch (error) {
      console.warn(`[bot-users] Telegram profile lookup failed for ${row.telegramId}:`, error)
    }
  }))
}

// GET /api/bot-users — linked drivers + pending link requests
export async function GET() {
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

  await refreshMissingTelegramProfiles(registryRows)

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
          select: { id: true, fullName: true, phone: true, yandexDriverId: true },
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

  const validLinkedTelegramIds = new Set(
    dtRows
      .filter(row => Boolean(driverMap[row.driverId]?.yandexDriverId))
      .map(row => row.telegramId.toString()),
  )
  const linked = dtRows.filter(row => validLinkedTelegramIds.has(row.telegramId.toString())).map(row => {
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
      submittedPhone: row.submittedPhone,
      submittedPhoneAt: row.submittedPhoneAt?.toISOString() ?? null,
      phoneMatches: row.submittedPhone && driver?.phone
        ? normalizeDriverPhone(row.submittedPhone) === normalizeDriverPhone(driver.phone)
        : null,
      activeParkId: row.activeParkId,
      parkName: row.activeParkId ? (parkMap[row.activeParkId] ?? null) : null,
      chatId: chatMap[tgId] ?? null,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: registry?.lastSeenAt.toISOString() || null,
      status: 'LINKED' as const,
    }
  })

  // Legacy requests are kept for compatibility, while BotUserRegistry is the
  // complete roster of everybody who has opened the bot.
  const legacyByTelegramId = new Map(legacyRequests.map(r => [r.telegramId.toString(), r]))
  const pendingByTelegramId = new Map<string, {
    id: string
    requestId: string | null
    source: 'registry' | 'legacy' | 'broken_mapping'
    telegramId: string
    phone: string | null
    username: string | null
    firstName: string | null
    lastName: string | null
    chatId: string | null
    createdAt: string
    lastSeenAt: string | null
    status: 'PENDING_MANAGER_LINK'
  }>()

  for (const row of registryRows) {
    const telegramId = row.telegramId.toString()
    if (validLinkedTelegramIds.has(telegramId)) continue
    const legacy = legacyByTelegramId.get(telegramId)
    const phoneMatch = legacy?.text.match(/Телефон:\s*([+\d]+)/)
    const usernameMatch = legacy?.text.match(/@(\S+)/)
    pendingByTelegramId.set(telegramId, {
      id: row.id,
      requestId: legacy?.id || null,
      source: 'registry',
      telegramId,
      phone: row.phone || phoneMatch?.[1] || null,
      username: row.username || usernameMatch?.[1] || null,
      firstName: row.firstName || null,
      lastName: row.lastName || null,
      chatId: chatMap[telegramId] ?? null,
      createdAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      status: 'PENDING_MANAGER_LINK',
    })
  }

  for (const r of legacyRequests) {
    const telegramId = r.telegramId.toString()
    if (validLinkedTelegramIds.has(telegramId) || pendingByTelegramId.has(telegramId)) continue
    const phoneMatch = r.text.match(/Телефон:\s*([+\d]+)/)
    const usernameMatch = r.text.match(/@(\S+)/)
    pendingByTelegramId.set(telegramId, {
      id: r.id,
      requestId: r.id,
      source: 'legacy',
      telegramId,
      phone: phoneMatch?.[1] ?? null,
      username: usernameMatch?.[1] ?? null,
      firstName: null,
      lastName: null,
      chatId: chatMap[telegramId] ?? null,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: null,
      status: 'PENDING_MANAGER_LINK',
    })
  }

  for (const row of dtRows) {
    const telegramId = row.telegramId.toString()
    if (validLinkedTelegramIds.has(telegramId) || pendingByTelegramId.has(telegramId)) continue
    pendingByTelegramId.set(telegramId, {
      id: row.id,
      requestId: null,
      source: 'broken_mapping',
      telegramId,
      phone: null,
      username: row.username,
      firstName: null,
      lastName: null,
      chatId: chatMap[telegramId] ?? null,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: null,
      status: 'PENDING_MANAGER_LINK',
    })
  }

  const requests = [...pendingByTelegramId.values()].sort((left, right) =>
    Date.parse(right.lastSeenAt || right.createdAt) - Date.parse(left.lastSeenAt || left.createdAt),
  )

  return NextResponse.json({ linked, requests })
}

// POST /api/bot-users — ask an unlinked Telegram user to contact the manager.
// The text is fixed inside the bot service, so this endpoint cannot be used to
// send arbitrary messages.
export async function POST(req: NextRequest) {
  let body: { telegramId?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 })
  }

  const telegramId = typeof body.telegramId === 'string' ? body.telegramId.trim() : ''
  if (!/^\d+$/.test(telegramId)) {
    return NextResponse.json({ error: 'Некорректный TG ID' }, { status: 400 })
  }

  const tgId = BigInt(telegramId)
  const [registry, mapping, legacyRequest] = await Promise.all([
    prisma.botUserRegistry.findUnique({ where: { telegramId: tgId } }),
    prisma.driverTelegram.findUnique({ where: { telegramId: tgId } }),
    prisma.botChatMessage.findFirst({
      where: {
        telegramId: tgId,
        driverId: null,
        direction: 'INCOMING',
        text: { startsWith: '[Запрос привязки]' },
      },
    }),
  ])

  if (!registry && !legacyRequest) {
    return NextResponse.json({ error: 'Пользователь не найден в запросах привязки' }, { status: 404 })
  }

  if (mapping) {
    const linkedDriver = await prisma.driver.findUnique({
      where: { id: mapping.driverId },
      select: { yandexDriverId: true },
    })
    if (linkedDriver?.yandexDriverId) {
      return NextResponse.json({ error: 'Пользователь уже привязан к водителю' }, { status: 409 })
    }
  }

  const recentRequest = await prisma.botChatMessage.findFirst({
    where: {
      telegramId: tgId,
      direction: 'OUTGOING',
      text: { startsWith: IDENTIFICATION_AUDIT_PREFIX },
      createdAt: { gte: new Date(Date.now() - IDENTIFICATION_COOLDOWN_MS) },
    },
    select: { id: true },
  })
  if (recentRequest) {
    return NextResponse.json({ success: true, alreadySent: true })
  }

  let botResponse: Response
  try {
    botResponse = await fetch(`${TG_BOT_API_URL}/api/bot/manager-identification-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bot-signature': process.env.BOT_CRM_SECRET || '',
      },
      body: JSON.stringify({ chatId: telegramId }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    console.error(`[bot-users] Identification message failed for ${telegramId}:`, error)
    return NextResponse.json({ error: 'Бот сейчас недоступен. Попробуйте ещё раз.' }, { status: 502 })
  }

  if (!botResponse.ok) {
    console.error(`[bot-users] Identification message rejected for ${telegramId}: ${botResponse.status}`)
    return NextResponse.json({ error: 'Не удалось доставить сообщение пользователю' }, { status: 502 })
  }

  const now = new Date()
  const displayName = registry?.username
    ? `@${registry.username}`
    : [registry?.firstName, registry?.lastName].filter(Boolean).join(' ').trim() || `TG ${telegramId}`
  const auditText = `${IDENTIFICATION_AUDIT_PREFIX} Пользователю предложено написать менеджеру +79221853150. TG ID: ${telegramId}`
  const externalChatId = `telegram:${telegramId}`

  try {
    await prisma.$transaction(async tx => {
      await tx.botChatMessage.create({
        data: {
          telegramId: tgId,
          direction: 'OUTGOING',
          text: auditText,
        },
      })

      const chat = await tx.chat.upsert({
        where: { externalChatId },
        update: { lastMessageAt: now },
        create: {
          externalChatId,
          channel: 'telegram',
          chatType: 'private',
          name: displayName,
          lastMessageAt: now,
        },
      })

      await tx.message.create({
        data: {
          chatId: chat.id,
          direction: 'outbound',
          channel: 'telegram',
          type: 'text',
          content: auditText,
          status: 'delivered',
          sentAt: now,
        },
      })
    })
  } catch (error) {
    // Delivery already succeeded; a CRM audit failure must not invite a
    // duplicate message on the manager's next click.
    console.error(`[bot-users] Identification audit failed for ${telegramId}:`, error)
  }

  return NextResponse.json({ success: true })
}

// DELETE /api/bot-users?telegramId=... — unlink driver from bot
// DELETE /api/bot-users?requestId=...  — dismiss pending link request
export async function DELETE(req: NextRequest) {
  const telegramId = req.nextUrl.searchParams.get('telegramId')
  const requestId = req.nextUrl.searchParams.get('requestId')

  if (telegramId) {
    await prisma.driverTelegram.deleteMany({ where: { telegramId: BigInt(telegramId) } })
    return NextResponse.json({ success: true })
  }

  if (requestId) {
    await prisma.botChatMessage.deleteMany({ where: { id: requestId } })
    return NextResponse.json({ success: true })
  }

  return NextResponse.json({ error: 'telegramId or requestId required' }, { status: 400 })
}
