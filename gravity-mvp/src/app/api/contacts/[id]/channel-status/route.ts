import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/contacts/:id/channel-status
 *
 * Returns the last outbound message status per channel for a contact.
 * Used by ProfileDrawer to show delivery errors.
 *
 * Response: { [channel]: { status, error, sentAt } | null }
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const chats = await prisma.chat.findMany({
      where: { contactId: id },
      select: { id: true, channel: true },
    })

    const result: Record<string, { status: string; error: string | null; sentAt: string } | null> = {}

    for (const chat of chats) {
      const lastOutbound = await prisma.message.findFirst({
        where: { chatId: chat.id, direction: 'outbound' },
        orderBy: { sentAt: 'desc' },
        select: { status: true, metadata: true, sentAt: true },
      })

      if (lastOutbound) {
        const meta = lastOutbound.metadata as Record<string, any> | null
        result[chat.channel] = {
          status: lastOutbound.status,
          error: meta?.error || null,
          sentAt: lastOutbound.sentAt.toISOString(),
        }
      } else {
        result[chat.channel] = null
      }
    }

    return NextResponse.json(result)
  } catch (err: any) {
    console.error('[contacts/:id/channel-status] Error:', err.message)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
