/**
 * For every WA message of type image/video/audio etc. show what content
 * is stored, whether there's an attached MessageAttachment, and the
 * content/body text that went in. This tells us if caption is being
 * saved or lost.
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    const mediaMsgs = await prisma.message.findMany({
        where: { channel: 'whatsapp', type: { in: ['image', 'video', 'audio', 'voice', 'sticker', 'document'] } },
        select: {
            id: true,
            type: true,
            content: true,
            externalId: true,
            direction: true,
            chat: { select: { externalChatId: true, name: true } },
            attachments: { select: { type: true, mimeType: true, fileSize: true } },
        },
        orderBy: { sentAt: 'desc' },
    })

    console.log(`=== WA media messages (${mediaMsgs.length}) ===`)
    for (const m of mediaMsgs) {
        const contentPreview = (m.content || '').length > 60 ? (m.content || '').slice(0, 60) + '…' : m.content
        console.log(`\n chat="${m.chat?.name}" (${m.chat?.externalChatId})`)
        console.log(`   [${m.type}] dir=${m.direction} ext=${m.externalId}`)
        console.log(`   content="${contentPreview}"`)
        console.log(`   attachments: ${m.attachments.length}`)
        for (const a of m.attachments) console.log(`      ${a.type}  ${a.mimeType}  ${a.fileSize}B`)
    }

    // Same for legacy
    const legacy = await prisma.whatsAppMessage.findMany({
        where: { type: { in: ['image', 'video', 'audio', 'voice', 'sticker', 'document'] } },
        select: { id: true, chatId: true, body: true, type: true },
        orderBy: { timestamp: 'desc' },
    })
    console.log(`\n\n=== Legacy WhatsAppMessage media rows (${legacy.length}) ===`)
    for (const m of legacy) {
        const bodyPreview = (m.body || '').length > 60 ? (m.body || '').slice(0, 60) + '…' : m.body
        console.log(`   [${m.type}] chat=${m.chatId}  body="${bodyPreview}"`)
    }
}

main().catch(console.error).finally(() => prisma.$disconnect())
