import { prisma } from '@/lib/prisma'
import { Message, AiStatus } from '@prisma/client'
import { pipelineWorker } from '@/lib/pipeline/PipelineWorker'
import { broadcastChatMessage } from '@/lib/messageStreamBus'

/**
 * Единая точка входа для входящих сообщений из любого канала.
 * 1. Создаёт событие в MessageEventLog (eventType='MessageReceived', status='pending')
 * 2. Ставит aiStatus = 'pending' на Message
 * 3. Запускает PipelineWorker (fire-and-forget)
 * 4. Broadcasts to /api/messages/stream subscribers (Phase 4 SSE — UI gets
 *    new messages instantly without waiting for the next poll tick).
 */
export async function emitMessageReceived(message: Message): Promise<void> {
    // Broadcast to /api/messages/stream subscribers FIRST — for both
    // directions. Outbound also benefits: a second CRM tab open on the
    // same chat sees the manager's reply pop in instantly, and a message
    // sent from the operator's phone (WA fromMe=true via live handler)
    // shows up in CRM at the same time as on the phone.
    try { broadcastChatMessage(message.chatId, message) } catch { /* bus must never break ingest */ }

    // Pipeline (AI processing, event log) is INBOUND only — outbound
    // doesn't need an AI response.
    if (message.direction !== 'inbound') return

    // Создаём событие в очереди pipeline через raw SQL
    // (не требует regenerate Prisma client — status поле добавлено миграцией)
    const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    await prisma.$executeRaw`
        INSERT INTO "MessageEventLog" (id, "messageId", "eventType", status, "createdAt", "updatedAt")
        VALUES (${eventId}, ${message.id}, 'MessageReceived', 'pending', NOW(), NOW())
    `

    await setAiStatus(message.id, 'pending')

    // Запускаем pipeline (не блокируем основной поток)
    pipelineWorker.process(message).catch(e =>
        console.error('[Pipeline] Worker error:', e.message)
    )
}

/**
 * Обновляет AI-статус сообщения.
 */
export async function setAiStatus(messageId: string, status: AiStatus): Promise<void> {
    await (prisma.message as any).update({
        where: { id: messageId },
        data:  { aiStatus: status },
    })
}
