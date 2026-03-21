import { PrismaClient } from '@prisma/client'
import { DriverMatchService } from '../src/lib/DriverMatchService' // Relative import from scripts

const prisma = new PrismaClient()

async function main() {
    console.log('Finding unlinked chats with recent messages...')
    
    // Find chats with no driverId that got new messages recently
    const recentChats = await prisma.chat.findMany({
        where: {
            driverId: null,
            messages: {
                some: { direction: 'inbound', sentAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }
            }
        }
    })

    console.log(`Found ${recentChats.length} unlinked chats. Attempting to match...`)

    let linkedCount = 0
    for (const chat of recentChats) {
        let matched = false
        if (chat.channel === 'whatsapp' && chat.externalChatId.startsWith('whatsapp:')) {
            const phone = chat.externalChatId.split(':')[1]
            matched = await DriverMatchService.linkChatToDriver(chat.id, { phone })
            if (!matched && chat.name?.includes('+')) {
                 matched = await DriverMatchService.linkChatToDriver(chat.id, { phone: chat.name })
            }
        } else if (chat.channel === 'telegram') {
            const tgId = chat.externalChatId.split(':')[1]
            if (tgId) {
                matched = await DriverMatchService.linkChatToDriver(chat.id, { telegramId: tgId })
            }
        }
        
        if (matched) {
            console.log(`✅ Linked chat ${chat.id} (${chat.channel}) to driver!`)
            linkedCount++
        }
    }

    console.log(`Done. Linked ${linkedCount} chats.`)
}

main().catch(console.error).finally(() => prisma.$disconnect())
