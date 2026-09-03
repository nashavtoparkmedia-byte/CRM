"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { DELETE_CONVERSATIONS_BY_ID_COMMAND_V1, DELETE_LEGACY_EXTERNAL_CONVERSATIONS_COMMAND_V1, DELETE_QUEUED_MESSAGES_FOR_CONNECTION_COMMAND_V1, DELIVER_QUEUED_MESSAGES_FOR_CONNECTION_COMMAND_V1 } from '@/contracts/messaging/v1'
import { deleteConversationsByIdV1, deleteLegacyExternalConversationsV1, deleteQueuedMessagesForConnectionV1, deliverQueuedMessagesForConnectionV1 } from '@/modules/messaging/public/v1'
import { projectMaxConnectionMetadata } from '@/modules/max-channel/public/v1/max-connection-public-metadata'
import { requireIntegrationAdminAccess } from '@/modules/identity-access/public/v1'
import { cleanupDanglingContactIdentitiesV1 } from '@/modules/contacts/public/v1'

// Get all saved MAX bots
export async function getMaxConnections() {
    await requireIntegrationAdminAccess()
    try {
        const connections = await prisma.maxConnection.findMany({
            orderBy: [
                { isDefault: 'desc' },
                { createdAt: 'desc' },
            ],
            select: {
                id: true,
                name: true,
                isActive: true,
                isDefault: true,
                createdAt: true,
                updatedAt: true,
            },
        })
        return connections.map(connection => projectMaxConnectionMetadata({
            ...connection,
            // botToken is required by the persistence schema. Its value is
            // intentionally not selected for a browser-facing list.
            credentialConfigured: true,
        }))
    } catch (error) {
        console.error("Error fetching MAX connections:", error)
        return []
    }
}

// Add a new MAX bot token
export async function addMaxConnection(botToken: string, name: string) {
    await requireIntegrationAdminAccess()
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
            },
            select: {
                id: true,
                name: true,
                isActive: true,
                isDefault: true,
                createdAt: true,
                updatedAt: true,
            },
        })

        revalidatePath("/max")
        return {
            success: true,
            connection: projectMaxConnectionMetadata({
                ...newConnection,
                credentialConfigured: true,
            }),
        }
    } catch {
        // Prisma errors may embed invocation arguments. Never log or return an
        // error object from a mutation that carried a bot token.
        console.error("Failed to add MAX connection")
        throw new Error("Failed to add bot")
    }
}

// Disconnect/Remove a MAX bot
export async function disconnectMax(id: string) {
    await requireIntegrationAdminAccess()
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
    await requireIntegrationAdminAccess()
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
    await requireIntegrationAdminAccess()
    console.log(`[MAX-ACTIONS] resumeMaxConnection id=${id} catchUp=${catchUp}`)
    if (catchUp) {
        // Flush buffered MAX messages from unified table
        const buffered = await (prisma as any).message.findMany({
            where: { status: 'queued', channel: 'max', direction: 'inbound', metadata: { path: ['connectionId'], equals: id } },
            include: { chat: true }
        })
        if (buffered.length > 0) {
            const ids = buffered.map((m: any) => m.id)
            const chatIds = [...new Set(buffered.map((m: any) => m.chatId))] as string[]
            const conversations = chatIds.map(chatId => {
                const latest = buffered.filter((m: any) => m.chatId === chatId).sort((a: any, b: any) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())[0]
                return { id: chatId, lastMessageAt: latest.sentAt as Date }
            })
            await deliverQueuedMessagesForConnectionV1({ contract: DELIVER_QUEUED_MESSAGES_FOR_CONNECTION_COMMAND_V1, connectionId: id, messageIds: ids, conversations })
        }
    } else {
        await deleteQueuedMessagesForConnectionV1({ contract: DELETE_QUEUED_MESSAGES_FOR_CONNECTION_COMMAND_V1, connectionId: id }).catch(() => {})
    }
    await prisma.maxConnection.update({ where: { id }, data: { isActive: true } as any })
    revalidatePath('/settings/integrations/max')
}

export async function deleteMaxMessages(id: string) {
    await requireIntegrationAdminAccess()
    console.log(`[MAX-ACTIONS] deleteMaxMessages connectionId=${id}`)
    const chats = await (prisma.chat as any).findMany({
        where: { channel: 'max' },
        select: { id: true, contactId: true }
    })
    if (chats.length === 0) {
        console.log(`[MAX-ACTIONS] No MAX chats found, nothing to delete`)
        revalidatePath('/messages')
        return
    }

    const chatIds = chats.map((c: any) => c.id)
    const contactIds = [...new Set(chats.map((c: any) => c.contactId).filter(Boolean))] as string[]
    console.log(`[MAX-ACTIONS] Deleting ${chatIds.length} MAX chats with all messages...`)

    try {
        // Use raw SQL for reliable bulk deletion — CASCADE handles Messages → Attachments → EventLogs
        await deleteLegacyExternalConversationsV1({ contract: DELETE_LEGACY_EXTERNAL_CONVERSATIONS_COMMAND_V1 })
        console.log(`[MAX-ACTIONS] Successfully deleted ${chatIds.length} MAX chats and all related data`)
    } catch (e: any) {
        console.error(`[MAX-ACTIONS] DELETE failed:`, e.message)
        // Fallback: delete in order if raw SQL fails
        try {
            await deleteConversationsByIdV1({ contract: DELETE_CONVERSATIONS_BY_ID_COMMAND_V1, conversationIds: chatIds })
            console.log(`[MAX-ACTIONS] Fallback deletion succeeded`)
        } catch (e2: any) {
            console.error(`[MAX-ACTIONS] Fallback deletion also failed:`, e2.message)
            throw e2
        }
    }

    // Cleanup dangling identities (scoped to affected contacts)
    if (contactIds.length > 0) {
        try {
            await cleanupDanglingContactIdentitiesV1(contactIds)
        } catch (e: any) {
            console.error(`[MAX-ACTIONS] Identity cleanup failed:`, e.message)
        }
    }
    revalidatePath('/messages')
}

// Update settings (name, default status)
export async function updateMaxConnectionSettings(id: string, name: string, isDefault: boolean) {
    await requireIntegrationAdminAccess()
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
