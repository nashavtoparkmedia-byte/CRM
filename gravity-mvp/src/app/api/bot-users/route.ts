import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { DELETE_DRIVER_TELEGRAM_LINK_COMMAND_V1, DISMISS_BOT_LINK_REQUEST_COMMAND_V1 } from '@/contracts/telegram-channel/v1'
import { deleteDriverTelegramLinkV1, dismissBotLinkRequestV1 } from '@/modules/telegram-channel/public/v1'

// GET /api/bot-users — linked drivers + pending link requests
export async function GET() {
  const [dtRows, requests] = await Promise.all([
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
  ])

  const driverIds = dtRows.map(r => r.driverId)
  const allTelegramIds = [
    ...dtRows.map(r => `telegram:${r.telegramId}`),
    ...requests.map(r => `telegram:${r.telegramId}`),
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
  // chatMap keyed by raw telegramId string (without prefix)
  const chatMap = Object.fromEntries(
    chats.map(c => [c.externalChatId.replace('telegram:', ''), c.id])
  )

  const linked = dtRows.map(row => {
    const driver = driverMap[row.driverId]
    const tgId = row.telegramId.toString()
    return {
      id: row.id,
      telegramId: tgId,
      username: row.username,
      driverId: row.driverId,
      driverName: driver?.fullName ?? null,
      driverPhone: driver?.phone ?? null,
      activeParkId: row.activeParkId,
      parkName: row.activeParkId ? (parkMap[row.activeParkId] ?? null) : null,
      chatId: chatMap[tgId] ?? null,
      createdAt: row.createdAt.toISOString(),
    }
  })

  // Parse "[Запрос привязки] Телефон: +79..., @username" text
  const parsedRequests = requests.map(r => {
    const telegramId = r.telegramId.toString()
    const phoneMatch = r.text.match(/Телефон:\s*([+\d]+)/)
    const usernameMatch = r.text.match(/@(\S+)/)
    return {
      id: r.id,
      telegramId,
      phone: phoneMatch?.[1] ?? null,
      username: usernameMatch?.[1] ?? null,
      chatId: chatMap[telegramId] ?? null,
      createdAt: r.createdAt.toISOString(),
    }
  })

  return NextResponse.json({ linked, requests: parsedRequests })
}

// DELETE /api/bot-users?telegramId=... — unlink driver from bot
// DELETE /api/bot-users?requestId=...  — dismiss pending link request
export async function DELETE(req: NextRequest) {
  const telegramId = req.nextUrl.searchParams.get('telegramId')
  const requestId = req.nextUrl.searchParams.get('requestId')

  if (telegramId) {
    await deleteDriverTelegramLinkV1({ contract: DELETE_DRIVER_TELEGRAM_LINK_COMMAND_V1, telegramId: BigInt(telegramId) })
    return NextResponse.json({ success: true })
  }

  if (requestId) {
    await dismissBotLinkRequestV1({ contract: DISMISS_BOT_LINK_REQUEST_COMMAND_V1, requestId })
    return NextResponse.json({ success: true })
  }

  return NextResponse.json({ error: 'telegramId or requestId required' }, { status: 400 })
}
