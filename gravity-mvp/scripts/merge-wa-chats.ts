import { PrismaClient } from '@prisma/client'
import fs from 'fs'
import path from 'path'

// Manually load .env
const envPath = path.join(process.cwd(), '.env')
if (fs.existsSync(envPath)) {
  const envFile = fs.readFileSync(envPath, 'utf8')
  const lines = envFile.split('\n')
  for (const line of lines) {
    const [key, value] = line.split('=')
    if (key && value) {
      process.env[key.trim()] = value.trim().replace(/^"|"$/g, '')
    }
  }
}

const prisma = new PrismaClient()

async function main() {
    console.log('--- Dynamic WhatsApp Chat Merger ---')

    // 1. Fetch all WhatsApp chats
    const allWaChats = await (prisma.chat as any).findMany({
        where: { channel: 'whatsapp' },
        include: { driver: true }
    })

    console.log(`Found ${allWaChats.length} total WhatsApp chats.`)

    // 2. Group by phone number
    const groups = new Map<string, any[]>()

    for (const chat of allWaChats) {
        // Extract digits from externalChatId or name or driver phone
        const rawId = chat.externalChatId || ''
        const digits = rawId.replace(/\D/g, '')
        
        // We only care about the last 10 digits to normalize (ignoring 7/+7/8)
        const phoneKey = digits.length >= 10 ? digits.slice(-10) : digits
        
        if (!phoneKey) {
            console.log(`Skipping chat ${chat.id} (no phone found: ${rawId})`)
            continue
        }

        if (!groups.has(phoneKey)) groups.set(phoneKey, [])
        groups.get(phoneKey)!.push(chat)
    }

    // 3. Process groups with duplicates
    for (const [phone, chats] of groups) {
        if (chats.length <= 1) continue

        console.log(`\nProcessing phone: ${phone} (${chats.length} chats)`)

        // Identify primary chat: 
        // Priority 1: Has driverId
        // Priority 2: StandardId format (whatsapp:digits)
        // Priority 3: Oldest
        chats.sort((a, b) => {
            if (a.driverId && !b.driverId) return -1
            if (!a.driverId && b.driverId) return 1
            
            const aIsStd = a.externalChatId.startsWith('whatsapp:')
            const bIsStd = b.externalChatId.startsWith('whatsapp:')
            if (aIsStd && !bIsStd) return -1
            if (!aIsStd && bIsStd) return 1

            return a.createdAt.getTime() - b.createdAt.getTime()
        })

        const primary = chats[0]
        const duplicates = chats.slice(1)

        console.log(`  Primary: ${primary.id} (External: ${primary.externalChatId}, Driver: ${primary.driver?.fullName || 'NONE'})`)

        // Standardize primary externalChatId if needed
        const stdExternalId = `whatsapp:${phone.length === 10 ? '7' + phone : phone}`
        if (primary.externalChatId !== stdExternalId) {
            await (prisma.chat as any).update({
                where: { id: primary.id },
                data: { externalChatId: stdExternalId }
            })
            console.log(`  Updated primary externalChatId to: ${stdExternalId}`)
        }

        for (const duplicate of duplicates) {
            console.log(`  Merging duplicate: ${duplicate.id} (External: ${duplicate.externalChatId})`)
            
            // Move messages
            const moveRes = await (prisma.message as any).updateMany({
                where: { chatId: duplicate.id },
                data: { chatId: primary.id }
            })
            console.log(`    Moved ${moveRes.count} messages.`)

            // Delete duplicate
            await (prisma.chat as any).delete({ where: { id: duplicate.id } })
            console.log(`    Deleted duplicate chat.`)
        }
    }

    console.log('\n--- Merge Complete ---')
}

main()
    .catch(console.error)
    .finally(async () => await prisma.$disconnect())
