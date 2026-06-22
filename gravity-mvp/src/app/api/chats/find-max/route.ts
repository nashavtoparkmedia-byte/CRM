import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET /api/chats/find-max?externalChatId=228621088&name=Павел+Уткин
// Finds or creates a MAX chat by externalChatId, returns CRM chat.id.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const externalChatId = searchParams.get('externalChatId')
  const contactName    = searchParams.get('name') || null
  if (!externalChatId) return NextResponse.json({ chatId: null })

  const chat = await prisma.chat.upsert({
    where:  { externalChatId },
    update: {},
    create: {
      channel:       'max',
      externalChatId,
      name:          contactName || `MAX:${externalChatId}`,
      status:        'new',
      lastMessageAt: new Date(),
      metadata:      { connectionId: 'max_scraper' },
    },
    select: { id: true },
  })

  return NextResponse.json({ chatId: chat.id })
}
