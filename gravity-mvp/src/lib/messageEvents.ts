import { prisma } from '@/lib/prisma'
import { Message, AiStatus } from '@prisma/client'
import { pipelineWorker } from '@/lib/pipeline/PipelineWorker'
/**
 * Единая точка входа для входящих сообщений из любого канала.
 * 1. Создаёт событие в MessageEventLog (eventType='MessageReceived', status='pending')
 * 2. Ставит aiStatus = 'pending' на Message
 * 3. Запускает PipelineWorker (fire-and-forget)
 */
export async function emitMessageReceived(message: Message): Promise<void> {
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
