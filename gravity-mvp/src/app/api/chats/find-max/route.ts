import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET /api/chats/find-max?externalChatId=228621088
// Returns CRM chat.id for a MAX chat by externalChatId, or null if not found.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const externalChatId = searchParams.get('externalChatId')
  if (!externalChatId) return NextResponse.json({ chatId: null })

  const chat = await prisma.chat.findUnique({
    where: { externalChatId },
    select: { id: true, name: true, channel: true },
  })

  return NextResponse.json({ chatId: chat?.id ?? null, name: chat?.name ?? null })
}
