import { PrismaClient } from '@prisma/client'
import fs from 'fs'
import path from 'path'

// Load .env
const envPath = path.join(process.cwd(), '.env')
if (fs.existsSync(envPath)) {
    const env = fs.readFileSync(envPath, 'utf8')
    env.split('\n').forEach(line => {
        const [key, value] = line.split('=')
        if (key && value) process.env[key.trim()] = value.trim()
    })
}

const prisma = new PrismaClient()

async function mergeTelegramChats() {
    console.log('[CLEANUP-TG] Starting Telegram Graph-Based Merger...')

    const allChats = await (prisma.chat as any).findMany({
        where: { channel: 'telegram' },
        include: { driver: true }
    })

    console.log(`[CLEANUP-TG] Found ${allChats.length} telegram chats.`)

    function extractIdentifiers(chat: any): Set<string> {
        const ids = new Set<string>()
        const extract = (str: string | null) => {
            if (!str) return
            // If it looks like a phone, normalize to last 10 digits
            const digits = str.replace(/\D/g, '')
            if (digits.length >= 10) {
                ids.add(`phone:${digits.slice(-10)}`)
            }
            // If it's a numeric ID (telegram:12345)
            const tgMatch = str.match(/telegram:(\d+)/)
            if (tgMatch) ids.add(`tgid:${tgMatch[1]}`)
            
            // If it's a username (@user)
            if (str.startsWith('@')) ids.add(`user:${str.toLowerCase()}`)
        }
        
        extract(chat.externalChatId)
        extract(chat.name)
        if (chat.driver?.phone) extract(`phone:${chat.driver.phone}`)
        
        return ids
    }

    // Build adjacency
    const idToChats = new Map<string, string[]>()
    const chatIdToIds = new Map<string, string[]>()

    for (const chat of allChats) {
        const ids = extractIdentifiers(chat)
        chatIdToIds.set(chat.id, Array.from(ids))
        for (const id of ids) {
            if (!idToChats.has(id)) idToChats.set(id, [])
            idToChats.get(id)!.push(chat.id)
        }
    }

    const visited = new Set<string>()
    const groups: string[][] = []

    for (const chat of allChats) {
        if (visited.has(chat.id)) continue

        const component: string[] = []
        const queue = [chat.id]
        visited.add(chat.id)

        while (queue.length > 0) {
            const cid = queue.shift()!
            component.push(cid)

            const ids = chatIdToIds.get(cid) || []
            for (const id of ids) {
                const related = idToChats.get(id) || []
                for (const rcid of related) {
                    if (!visited.has(rcid)) {
                        visited.add(rcid)
                        queue.push(rcid)
                    }
                }
            }
        }
        if (component.length > 1) groups.push(component)
    }

    console.log(`[CLEANUP-TG] Found ${groups.length} groups to merge.`)

    for (const groupIds of groups) {
        const groupChats = allChats.filter((c: any) => groupIds.includes(c.id))
        
        // Sort: prefer driver link, then earlier creation
        groupChats.sort((a: any, b: any) => {
            if (a.driverId && !b.driverId) return -1
            if (!a.driverId && b.driverId) return 1
            return (a.createdAt || 0) - (b.createdAt || 0)
        })

        const primary = groupChats[0]
        const duplicates = groupChats.slice(1)

        console.log(`[CLEANUP-TG] Merging into primary: ${primary.id} (${primary.name})`)

        for (const dup of duplicates) {
            const moveRes = await (prisma.message as any).updateMany({
                where: { chatId: dup.id },
                data: { chatId: primary.id }
            })
            await (prisma.chat as any).delete({ where: { id: dup.id } })
            console.log(`[CLEANUP-TG]   Merged ${dup.id} (${dup.name}), moved ${moveRes.count} msgs.`)
        }
    }

    console.log('[CLEANUP-TG] COMPLETE.')
}

mergeTelegramChats()
    .catch(console.error)
    .finally(() => prisma.$disconnect())
