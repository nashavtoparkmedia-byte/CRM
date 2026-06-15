import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

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
  const drivers = driverIds.length
    ? await prisma.driver.findMany({
        where: { id: { in: driverIds } },
        select: { id: true, fullName: true, phone: true },
      })
    : []
  const parkIds = dtRows.map(r => r.activeParkId).filter(Boolean) as string[]
  const parks = parkIds.length
    ? await prisma.apiConnection.findMany({
        where: { parkId: { in: parkIds } },
        select: { parkId: true, name: true },
      })
    : []

  const driverMap = Object.fromEntries(drivers.map(d => [d.id, d]))
  const parkMap = Object.fromEntries(parks.map(p => [p.parkId, p.name || p.parkId]))

  const linked = dtRows.map(row => {
    const driver = driverMap[row.driverId]
    return {
      id: row.id,
      telegramId: row.telegramId.toString(),
      username: row.username,
      driverId: row.driverId,
      driverName: driver?.fullName ?? null,
      driverPhone: driver?.phone ?? null,
      activeParkId: row.activeParkId,
      parkName: row.activeParkId ? (parkMap[row.activeParkId] ?? null) : null,
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
    await prisma.driverTelegram.deleteMany({ where: { telegramId: BigInt(telegramId) } })
    return NextResponse.json({ success: true })
  }

  if (requestId) {
    await prisma.botChatMessage.deleteMany({ where: { id: requestId } })
    return NextResponse.json({ success: true })
  }

  return NextResponse.json({ error: 'telegramId or requestId required' }, { status: 400 })
}
