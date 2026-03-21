import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
    console.log('--- Cleaning Up Duplicate WhatsApp Chats ---')
    const primaryChatId = 'cmms4a8py0001vpnsde1ex208'
    
    // 1. Update primary chat external ID
    await prisma.chat.update({
        where: { id: primaryChatId },
        data: { externalChatId: 'whatsapp:79222155750' }
    })
    console.log(`Updated primary chat ${primaryChatId} to use standard whatsapp:PHONE external ID.`)

    const duplicateChats = [
        'cmmtq7mot00ylvpoklll5ei4s', // whatsapp:1651...
        'cmmwkg0jw01ipvph4db2non1l'  // 1651...lid
    ]

    for (const dChatId of duplicateChats) {
        const chat = await prisma.chat.findUnique({ where: { id: dChatId } })
        if (!chat) continue;

        // Move all messages to primary chat
        const updateRes = await prisma.message.updateMany({
            where: { chatId: dChatId },
            data: { chatId: primaryChatId }
        })
        console.log(`Moved ${updateRes.count} messages from duplicate chat ${dChatId} to primary`)
        
        // Delete the duplicate chat
        await prisma.chat.delete({ where: { id: dChatId } })
        console.log(`Deleted duplicate chat ${dChatId}`)
    }

    // Refresh lastMessageAt for primary
    const lastMsg = await prisma.message.findFirst({
        where: { chatId: primaryChatId },
        orderBy: { sentAt: 'desc' }
    })
    
    if (lastMsg) {
        await prisma.chat.update({
            where: { id: primaryChatId },
            data: { lastMessageAt: lastMsg.sentAt }
        })
    }
    console.log('Cleanup complete. The UI should now show 2342 and 2343 correctly.')
}

main().catch(console.error).finally(() => prisma.$disconnect())
