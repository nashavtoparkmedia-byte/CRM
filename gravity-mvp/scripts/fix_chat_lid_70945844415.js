/**
 * Manual fix: WA-чат с fake @lid номером `+70945844415` -> Driver "Исаков Алексей" (+79221127866)
 *
 * Reason: WhatsApp Business linked id (@lid) prefix скрывает реальный номер.
 * В БД уже есть Driver с реальным phone +79221127866 — связываем.
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    const chatId = 'cmph1e53500fovpm430zke5me'
    const driverId = 'cmmnxwb1m02klvptoprarjdx9'  // Исаков Алексей, +79221127866
    const realName = 'Исаков Алексей'
    const realPhone = '+79221127866'

    const chat = await prisma.chat.findUnique({
        where: { id: chatId },
        select: { id: true, name: true, contactId: true, driverId: true, externalChatId: true }
    })
    if (!chat) { console.error('Chat not found'); process.exit(1) }
    console.log('Current chat:', chat)

    await prisma.chat.update({
        where: { id: chatId },
        data: { driverId, name: realName }
    })
    console.log(`✓ Chat updated: name=${realName}, driverId=${driverId}`)

    if (chat.contactId) {
        await prisma.contact.update({
            where: { id: chat.contactId },
            data: { displayName: realName }
        })
        console.log(`✓ Contact ${chat.contactId} displayName -> ${realName}`)
    }

    await prisma.$disconnect()
    console.log('Done.')
}

main().catch(e => { console.error('fatal:', e); process.exit(1) })
