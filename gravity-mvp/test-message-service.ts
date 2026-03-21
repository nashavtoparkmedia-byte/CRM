
import { MessageService } from './src/lib/MessageService'
import { prisma } from './src/lib/prisma'

async function test() {
    console.log("--- Starting MessageService Debug Test ---")
    try {
        // 1. TEST WHATSAPP
        const waChat = await prisma.chat.findFirst({
            where: { channel: 'whatsapp' }
        })
        if (waChat) {
            console.log(`Testing WA: ${waChat.externalChatId}`)
            const res = await MessageService.send(waChat.id, "Debug WA from Script", 'whatsapp')
            console.log("WA Result:", res)
        } else {
            console.log("No WA chat found")
        }

        // 2. TEST MAX
        const maxChat = await prisma.chat.findFirst({
            where: { channel: 'max' }
        })
        if (maxChat) {
            console.log(`Testing MAX: ${maxChat.externalChatId}`)
            const res = await MessageService.send(maxChat.id, "Debug MAX from Script", 'max')
            console.log("MAX Result:", res)
        } else {
            console.log("No MAX chat found")
        }

    } catch (err) {
        console.error("DEBUG TEST FAILED:")
        console.error(err)
    } finally {
        await prisma.$disconnect()
    }
}

test()
