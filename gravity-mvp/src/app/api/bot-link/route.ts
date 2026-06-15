import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

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
    const { telegramId, driverId } = body
    if (!telegramId || !driverId) {
      return NextResponse.json({ error: 'telegramId and driverId required' }, { status: 400 })
    }

    const driver = await prisma.driver.findUnique({
      where: { id: driverId },
      select: { id: true, fullName: true },
    })
    if (!driver) return NextResponse.json({ error: 'Driver not found' }, { status: 404 })

    await prisma.$transaction(async (tx) => {
      await tx.driverTelegram.deleteMany({ where: { driverId } })
      await tx.driverTelegram.deleteMany({ where: { telegramId: BigInt(telegramId) } })
      await tx.driverTelegram.create({ data: { telegramId: BigInt(telegramId), driverId } })
    })

    return NextResponse.json({ success: true, driverName: driver.fullName })
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
}
