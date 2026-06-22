import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET /api/chats/find-max?externalChatId=<maxUserId>&name=Имя&phone=79...
// Finds (or creates as last resort) the MAX chat for a given user.
//
// In MAX, chatId != userId for many conversations. The userId from
// forwardedFrom.id may not match the externalChatId of the existing chat.
// Resolution order:
//   1. externalChatId = maxUserId  (direct 1:1 chat where chatId = userId)
//   2. Any MAX message with metadata.senderId = maxUserId (existing chat found by history)
//   3. Fallback: create new chat with externalChatId = maxUserId
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const maxUserId   = searchParams.get('externalChatId')
  const contactName = searchParams.get('name') || null
  if (!maxUserId) return NextResponse.json({ chatId: null })

  // 1. Direct match: chatId = userId (common for some MAX direct chats)
  let chat = await prisma.chat.findUnique({
    where:  { externalChatId: maxUserId },
    select: { id: true },
  })

  // 2. Search existing chats by senderId in message metadata
  if (!chat) {
    const msg = await prisma.message.findFirst({
      where: {
        channel: 'max',
        metadata: { path: ['senderId'], equals: maxUserId },
      },
      select: { chatId: true },
      orderBy: { sentAt: 'desc' },
    })
    if (msg) chat = { id: msg.chatId }
  }

  // 3. Fallback: create a new placeholder chat
  if (!chat) {
    chat = await prisma.chat.upsert({
      where:  { externalChatId: maxUserId },
      update: {},
      create: {
        channel:       'max',
        externalChatId: maxUserId,
        name:          contactName || `MAX:${maxUserId}`,
        status:        'new',
        lastMessageAt: new Date(),
        metadata:      { connectionId: 'max_scraper' },
      },
      select: { id: true },
    })
  }

  return NextResponse.json({ chatId: chat.id })
}
