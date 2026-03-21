import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(req: NextRequest) {
    try {
        console.log('[CLEANUP-API] Starting Global Multi-Channel Merger')
        const results: string[] = []

        const allChats = await (prisma.chat as any).findMany({
            include: { driver: true }
        })

        // Graph build helpers
        function extractNodes(chat: any): Set<string> {
            const nodes = new Set<string>()
            const extract = (str: string | null) => {
                if (!str) return
                // Normalize phone
                const digits = str.replace(/\D/g, '')
                if (digits.length >= 10) nodes.add(`p:${digits.slice(-10)}`)
                
                // Telegram ID
                const tgMatch = str.match(/telegram:(\d+)/)
                if (tgMatch) nodes.add(`tg:${tgMatch[1]}`)
                
                // Usernames
                if (str.startsWith('@')) nodes.add(`u:${str.toLowerCase()}`)
            }
            extract(chat.externalChatId)
            extract(chat.name)
            if (chat.driver?.phone) extract(chat.driver.phone)
            return nodes
        }

        const nodeToChats = new Map<string, string[]>()
        const chatIdToNodes = new Map<string, string[]>()

        for (const chat of allChats) {
            const nodes = extractNodes(chat)
            chatIdToNodes.set(chat.id, Array.from(nodes))
            for (const node of nodes) {
                if (!nodeToChats.has(node)) nodeToChats.set(node, [])
                nodeToChats.get(node)!.push(chat.id)
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
                const nodes = chatIdToNodes.get(cid) || []
                for (const node of nodes) {
                    const related = nodeToChats.get(node) || []
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

        // Process Groups
        for (const componentIds of groups) {
            const componentChats = allChats.filter((c: any) => componentIds.includes(c.id))
            componentChats.sort((a: any, b: any) => {
                if (a.driverId && !b.driverId) return -1
                if (!a.driverId && b.driverId) return 1
                return (a.createdAt || 0) - (b.createdAt || 0)
            })

            const primary = componentChats[0]
            const duplicates = componentChats.slice(1)
            
            for (const dup of duplicates) {
                const moveRes = await (prisma.message as any).updateMany({
                    where: { chatId: dup.id },
                    data: { chatId: primary.id }
                })
                await (prisma.chat as any).delete({ where: { id: dup.id } })
                results.push(`Merged ${dup.id} (${dup.name}) into ${primary.id} (moved ${moveRes.count} msgs)`)
            }
        }

        return NextResponse.json({ success: true, actions: results })
    } catch (err: any) {
        console.error('[CLEANUP-API] Fatal Error:', err)
        return NextResponse.json({ success: false, error: err.message }, { status: 500 })
    }
}
