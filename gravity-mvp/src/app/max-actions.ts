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
export async function sendMaxPersonalMessage(phone: string, message: string, name?: string) {
    if (!phone || !message) {
        throw new Error("Phone and message are required")
    }

    // Normalize phone to clean digits
    const cleanPhone = phone.replace(/\D/g, '')
    if (!cleanPhone) throw new Error("Invalid phone number")

    try {
        console.log(`[CRM] Sending MAX message: chatId=${cleanPhone}, name=${name || 'N/A'}`)
        const response = await fetch("http://localhost:3005/send-message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chatId: cleanPhone, message })
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
