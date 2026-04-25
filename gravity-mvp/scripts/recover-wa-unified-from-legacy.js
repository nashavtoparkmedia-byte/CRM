/**
 * Recover WA unified Message rows from legacy WhatsAppMessage rows
 * when they got out of sync — i.e. legacy has it but the unified
 * table is missing the row.
 *
 * Scenario that triggered this: a live inbound message landed in
 * WhatsAppMessage fine, but the corresponding Message.create silently
 * failed or was filtered out by an earlier version of the pipeline,
 * so the UI chat view reads 0 messages while the left-panel preview
 * (driven by Chat.lastMessageAt / legacy) still shows the snippet.
 *
 * For every WhatsAppMessage where there is NO Message with the same
 * externalId and content is non-empty, creates the missing unified
 * Message. Skips empty-body rows (those are correctly already filtered).
 *
 * Idempotent — safe to re-run.
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const TYPE_MAP = {
    chat: 'text',
    image: 'image',
    video: 'video',
    audio: 'audio',
    voice: 'voice',
    ptt: 'voice',
    sticker: 'sticker',
    document: 'document',
}

const PLACEHOLDER_BY_TYPE = {
    image: '[Фото]', video: '[Видео]', voice: '[Голосовое]',
    audio: '[Аудио]', document: '[Документ]', sticker: '[Стикер]',
    ptt: '[Голосовое]',
}

async function main() {
    const legacyMsgs = await prisma.whatsAppMessage.findMany({
        orderBy: { timestamp: 'asc' },
    })
    console.log(`[RECOVER] Scanning ${legacyMsgs.length} legacy WhatsAppMessage rows...`)

    let recovered = 0
    let skippedEmpty = 0
    let skippedNoChat = 0
    let skippedAlreadyPresent = 0

    for (const lm of legacyMsgs) {
        const body = (lm.body || '').trim()
        const unifiedType = TYPE_MAP[lm.type] || 'text'
        // Skip rows we already decided to drop as junk (empty text)
        if (unifiedType === 'text' && !body) { skippedEmpty++; continue }

        // Find the corresponding unified Chat. Legacy chatId is the raw
        // JID (e.g. '79025095972@c.us'), but after the chat-dedup merge
        // the unified externalChatId is the normalized form
        // ('whatsapp:79025095972'). Try both, plus a suffix match in
        // case neither variant is exact.
        const digits = (lm.chatId || '').split('@')[0].replace(/\D/g, '')
        const normalized = digits.length >= 10 ? `whatsapp:7${digits.slice(-10)}` : null
        const chat = await prisma.chat.findFirst({
            where: {
                channel: 'whatsapp',
                OR: [
                    { externalChatId: lm.chatId },
                    ...(normalized ? [{ externalChatId: normalized }] : []),
                    ...(digits.length >= 10 ? [{ externalChatId: { endsWith: digits.slice(-10) } }] : []),
                ],
            },
            select: { id: true },
        })
        if (!chat) { skippedNoChat++; continue }

        // Skip if unified already has this externalId
        const existing = await prisma.message.findFirst({
            where: { externalId: lm.id },
            select: { id: true },
        })
        if (existing) { skippedAlreadyPresent++; continue }

        const content = body || PLACEHOLDER_BY_TYPE[lm.type] || ''

        await prisma.message.create({
            data: {
                chatId: chat.id,
                direction: lm.fromMe ? 'outbound' : 'inbound',
                type: unifiedType,
                content,
                externalId: lm.id,
                channel: 'whatsapp',
                sentAt: lm.timestamp,
                status: lm.fromMe ? 'delivered' : undefined,
            },
        })
        recovered++
    }

    console.log(`[RECOVER] Recovered: ${recovered}`)
    console.log(`[RECOVER] Skipped (already in unified): ${skippedAlreadyPresent}`)
    console.log(`[RECOVER] Skipped (empty text): ${skippedEmpty}`)
    console.log(`[RECOVER] Skipped (no unified chat): ${skippedNoChat}`)
}

main().catch(console.error).finally(() => prisma.$disconnect())
