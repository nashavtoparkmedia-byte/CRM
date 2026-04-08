"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"

// Get all saved MAX bots
export async function getMaxConnections() {
    try {
        const connections = await prisma.maxConnection.findMany({
            orderBy: [
                { isDefault: 'desc' },
                { createdAt: 'desc' },
            ],
        })
        return connections
    } catch (error) {
        console.error("Error fetching MAX connections:", error)
        return []
    }
}

// Add a new MAX bot token
export async function addMaxConnection(botToken: string, name: string) {
    if (!botToken || !botToken.trim()) {
        throw new Error("Token is required")
    }

    try {
        // Here we could potentially call the MAX API to verify the token and get the bot ID.
        // For MVP, we will assume the token is valid and use a portion of it or generate a CUID as ID.
        // If the MAX API has a `getMe` equivalent, it should be called here.
        
        // Let's check how many connections exist to determine if this should be default
        const existingCount = await prisma.maxConnection.count()
        const isDefault = existingCount === 0

        // As a placeholder ID, since we don't know the exact format of MAX tokens,
        // we'll just create a new record. If they have bot IDs, extract it from token or API.
        const newConnection = await prisma.maxConnection.create({
            data: {
                id: `max_bot_${Date.now()}`, // Temporary ID logic
                botToken: botToken.trim(),
                name: name.trim() || "MAX Bot",
                isDefault,
            }
        })

        revalidatePath("/max")
        return { success: true, connection: newConnection }
    } catch (error: any) {
        console.error("Failed to add MAX connection:", error)
        throw new Error(error.message || "Failed to add bot")
    }
}

// Disconnect/Remove a MAX bot
export async function disconnectMax(id: string) {
    try {
        const connection = await prisma.maxConnection.findUnique({ where: { id } })
        if (!connection) return { success: false, error: "Not found" }

        await prisma.maxConnection.delete({ where: { id } })

        // If we deleted the default, make another one default
        if (connection.isDefault) {
            const nextConnection = await prisma.maxConnection.findFirst({
                orderBy: { createdAt: 'desc' }
            })
            if (nextConnection) {
                await prisma.maxConnection.update({
                    where: { id: nextConnection.id },
                    data: { isDefault: true }
                })
            }
        }

        revalidatePath("/max")
        return { success: true }
    } catch (error: any) {
        console.error("Error disconnecting MAX:", error)
        throw new Error("Failed to remove connection")
    }
}

export async function pauseMaxConnection(id: string, deleteMessages: boolean) {
    console.log(`[MAX-ACTIONS] pauseMaxConnection id=${id} deleteMessages=${deleteMessages}`)
    await prisma.maxConnection.update({
        where: { id },
        data: { isActive: false } as any
    })
    if (deleteMessages) {
        await deleteMaxMessages(id)
    }
    revalidatePath('/settings/integrations/max')
}

export async function resumeMaxConnection(id: string, catchUp: boolean) {
    console.log(`[MAX-ACTIONS] resumeMaxConnection id=${id} catchUp=${catchUp}`)
    if (catchUp) {
        // Flush buffered MAX messages from unified table
        const buffered = await (prisma as any).message.findMany({
            where: { status: 'queued', channel: 'max', direction: 'inbound', metadata: { path: ['connectionId'], equals: id } },
            include: { chat: true }
        })
        if (buffered.length > 0) {
            const ids = buffered.map((m: any) => m.id)
            await (prisma as any).message.updateMany({ where: { id: { in: ids } }, data: { status: 'delivered', metadata: { connectionId: id, buffered: false } } })
            const chatIds = [...new Set(buffered.map((m: any) => m.chatId))] as string[]
            for (const chatId of chatIds) {
                const latest = buffered.filter((m: any) => m.chatId === chatId).sort((a: any, b: any) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())[0]
                await (prisma.chat as any).update({ where: { id: chatId }, data: { lastMessageAt: latest.sentAt } })
            }
        }
    } else {
        await (prisma as any).message.deleteMany({ where: { status: 'queued', channel: 'max', metadata: { path: ['connectionId'], equals: id } } }).catch(() => {})
    }
    await prisma.maxConnection.update({ where: { id }, data: { isActive: true } as any })
    revalidatePath('/settings/integrations/max')
}

export async function deleteMaxMessages(id: string) {
    console.log(`[MAX-ACTIONS] deleteMaxMessages connectionId=${id}`)
    const chats = await (prisma.chat as any).findMany({
        where: { channel: 'max' },
        select: { id: true, contactId: true }
    })
    if (chats.length > 0) {
        const chatIds = chats.map((c: any) => c.id)
        const contactIds = [...new Set(chats.map((c: any) => c.contactId).filter(Boolean))] as string[]

        await (prisma.message as any).deleteMany({ where: { chatId: { in: chatIds } } }).catch(() => {})
        await (prisma.chat as any).deleteMany({ where: { id: { in: chatIds } } }).catch(() => {})

        // Cleanup dangling identities (scoped to affected contacts)
        if (contactIds.length > 0) {
            const { ContactService } = await import('@/lib/ContactService')
            await ContactService.cleanupDanglingIdentities(contactIds)
        }
    }
    revalidatePath('/messages')
}

// Update settings (name, default status)
export async function updateMaxConnectionSettings(id: string, name: string, isDefault: boolean) {
    try {
        if (isDefault) {
            // Unset current default
            await prisma.maxConnection.updateMany({
                where: { isDefault: true },
                data: { isDefault: false }
            })
        }

        await prisma.maxConnection.update({
            where: { id },
            data: {
                name,
                ...(isDefault && { isDefault })
            }
        })

        revalidatePath("/max")
        return { success: true }
    } catch (error: any) {
        console.error("Error updating MAX connection:", error)
        throw new Error("Failed to update settings")
    }
}

// Send a message via MAX Personal Account (Web Scraper)
// target can be a MAX internal chatId (e.g. "201482140") or a phone number (e.g. "79222155750")
export async function sendMaxPersonalMessage(target: string, message: string, name?: string) {
    if (!target || !message) {
        throw new Error("Target (chatId or phone) and message are required")
    }

    const cleanTarget = target.replace(/\D/g, '')
    if (!cleanTarget) throw new Error("Invalid target")

    try {
        console.log(`[CRM] Sending MAX message: target=${cleanTarget}, name=${name || 'N/A'}`)
        const maxScraperUrl = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'
        const response = await fetch(`${maxScraperUrl}/send-message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chatId: cleanTarget, message })
        })

        if (!response.ok) {
            const data = await response.json().catch(() => ({ error: "Unknown error" }))
            throw new Error(data.error || "Failed to send message via Scraper")
        }

        return { success: true }
    } catch (error: any) {
        console.error("MAX Personal Send Error:", error)
        throw new Error(error.message || "Failed to call scraper API")
    }
}

// Send a message via MAX (Bot or Personal)
export async function sendMaxMessage(phone: string, message: string, options?: { name?: string, connectionId?: string, isPersonal?: boolean }) {
    if (!phone || !message) {
        throw new Error("Phone and message are required")
    }

    if (options?.isPersonal) {
        return await sendMaxPersonalMessage(phone, message, options.name)
    }

    try {
        // Find the connection to use
        let connection;
        if (options?.connectionId) {
            connection = await prisma.maxConnection.findUnique({ where: { id: options.connectionId } })
        } else {
            connection = await prisma.maxConnection.findFirst({ where: { isDefault: true } })
            if (!connection) {
                connection = await prisma.maxConnection.findFirst() // fallback
            }
        }

        if (!connection) {
            throw new Error("No active MAX bot connected")
        }

        // SIMULATED SUCCESS FOR BOT API UNTIL PROPER API IS INTEGRATED
        console.log(`[MAX BOT SIMULATION] Sending message to ${phone} from bot ${connection.name}:\n${message}`)
        await new Promise(resolve => setTimeout(resolve, 500))

        return { success: true }
    } catch (error: any) {
        console.error("MAX Bot Send Error:", error)
        throw new Error(error.message || "Failed to send MAX bot message")
    }
}
