'use server'

import { prisma } from '@/lib/prisma'
import { initializeClient, destroyClient, sendMessage as waSendMessage } from '@/lib/whatsapp/WhatsAppService'
import { revalidatePath } from 'next/cache'

export async function createWhatsAppConnection(name?: string) {
    console.log(`[WA-ACTIONS] createWhatsAppConnection called with name: ${name}`)
    const connection = await prisma.whatsAppConnection.create({
        data: { name: name || 'WhatsApp Account', status: 'idle' }
    })

    console.log(`[WA-ACTIONS] Created connection: ${connection.id}`)
    initializeWhatsAppConnection(connection.id).catch(console.error)
    revalidatePath('/whatsapp')
    return connection
}

export async function initializeWhatsAppConnection(connectionId: string) {
    console.log(`[WA-ACTIONS] initializeWhatsAppConnection called for: ${connectionId}`)
    try {
        await initializeClient(connectionId)
    } catch (err: any) {
        console.error(`[WA-ACTIONS] Init error for ${connectionId}:`, err)
        await prisma.whatsAppConnection.update({
            where: { id: connectionId },
            data: { status: 'error' }
        })
    }
}

export async function refreshWhatsAppQR(connectionId: string) {
    console.log(`[WA-ACTIONS] refreshWhatsAppQR called for: ${connectionId}`)
    try {
        await destroyClient(connectionId)
    } catch (_) { }
    await prisma.whatsAppConnection.update({
        where: { id: connectionId },
        data: { status: 'idle', sessionData: null }
    })
    initializeWhatsAppConnection(connectionId).catch(console.error)
}

export async function getWhatsAppConnections() {
    console.log(`[WA-ACTIONS] getWhatsAppConnections called`)
    return prisma.whatsAppConnection.findMany({
        orderBy: { createdAt: 'asc' }
    })
}

export async function getWhatsAppStatus(connectionId: string) {
    console.log(`[WA-ACTIONS] getWhatsAppStatus called for: ${connectionId}`)
    const conn = await prisma.whatsAppConnection.findUnique({
        where: { id: connectionId }
    })
    return conn
}

export async function disconnectWhatsApp(connectionId: string) {
    console.log(`[WA-ACTIONS] disconnectWhatsApp called for: ${connectionId}`)
    await destroyClient(connectionId)
    revalidatePath('/whatsapp')
}

export async function deleteWhatsAppConnection(connectionId: string) {
    console.log(`[WA-ACTIONS] deleteWhatsAppConnection START for: ${connectionId}`)
    try {
        console.log(`[WA-ACTIONS] Attempting to destroy client ${connectionId}`)
        await destroyClient(connectionId).catch((e) => console.error('[WA-ACTIONS] Destroy error (ignored):', e))

        console.log(`[WA-ACTIONS] Attempting to delete from DB: ${connectionId}`)
        // Delete dependents first to avoid constraint issues, though Cascade is set
        await prisma.whatsAppMessage.deleteMany({ where: { chat: { connectionId } } }).catch(() => { })
        await prisma.whatsAppChat.deleteMany({ where: { connectionId } }).catch(() => { })
        const deleted = await prisma.whatsAppConnection.delete({ where: { id: connectionId } })

        console.log(`[WA-ACTIONS] Successfully deleted from DB: ${connectionId}`)
        revalidatePath('/whatsapp')
        return { success: true, id: connectionId }
    } catch (e: any) {
        console.error(`[WA-ACTIONS] EXCEPTION during deletion of ${connectionId}:`, e)
        // Try one more time only connection itself
        try {
            await prisma.whatsAppConnection.delete({ where: { id: connectionId } })
            revalidatePath('/whatsapp')
            return { success: true, id: connectionId, note: 'deleted on second attempt' }
        } catch (e2) {
            console.error(`[WA-ACTIONS] Final delete failure for ${connectionId}:`, e2)
            return { success: false, error: String(e) }
        }
    }
}

export async function pauseWhatsAppConnection(connectionId: string, deleteMessages: boolean) {
    console.log(`[WA-ACTIONS] pauseWhatsAppConnection id=${connectionId} deleteMessages=${deleteMessages}`)
    await prisma.whatsAppConnection.update({
        where: { id: connectionId },
        data: { isActive: false } as any
    })
    if (deleteMessages) {
        await deleteWhatsAppMessages(connectionId)
    }
    revalidatePath('/settings/integrations/whatsapp')
}

export async function resumeWhatsAppConnection(connectionId: string, catchUp: boolean) {
    console.log(`[WA-ACTIONS] resumeWhatsAppConnection id=${connectionId} catchUp=${catchUp}`)
    if (!catchUp) {
        // Delete buffered WA messages (stored in WhatsAppMessage with a buffered flag isn't implemented,
        // so for WA we just unpause — buffering at WA level is handled in WhatsAppService)
    }
    await prisma.whatsAppConnection.update({
        where: { id: connectionId },
        data: { isActive: true } as any
    })
    revalidatePath('/settings/integrations/whatsapp')
}

export async function deleteWhatsAppMessages(connectionId: string) {
    console.log(`[WA-ACTIONS] deleteWhatsAppMessages id=${connectionId}`)
    // Delete from WA-specific tables
    await prisma.whatsAppMessage.deleteMany({ where: { chat: { connectionId } } }).catch(() => {})
    await prisma.whatsAppChat.deleteMany({ where: { connectionId } }).catch(() => {})
    // Delete from unified Chat/Message table where channel='whatsapp'
    const unifiedChats = await (prisma.chat as any).findMany({
        where: { channel: 'whatsapp' },
        select: { id: true, externalChatId: true }
    })
    if (unifiedChats.length > 0) {
        const chatIds = unifiedChats.map((c: any) => c.id)
        await (prisma.message as any).deleteMany({ where: { chatId: { in: chatIds } } }).catch(() => {})
        await (prisma.chat as any).deleteMany({ where: { id: { in: chatIds } } }).catch(() => {})
    }
    revalidatePath('/messages')
}

export async function getWhatsAppChats(connectionId: string) {
    console.log(`[WA-ACTIONS] getWhatsAppChats called for: ${connectionId}`)
    return prisma.whatsAppChat.findMany({
        where: { connectionId },
        orderBy: { lastMessageAt: 'desc' },
        include: {
            messages: {
                orderBy: { timestamp: 'desc' },
                take: 1
            }
        }
    })
}

export async function getWhatsAppMessages(chatId: string) {
    console.log(`[WA-ACTIONS] getWhatsAppMessages called for: ${chatId}`)
    return prisma.whatsAppMessage.findMany({
        where: { chatId },
        orderBy: { timestamp: 'asc' },
        take: 100
    })
}

export async function sendWhatsAppMessage(connectionId: string, chatId: string, text: string) {
    console.log(`[WA-ACTIONS] sendWhatsAppMessage called for: ${connectionId}, chat: ${chatId}`)
    const result = await waSendMessage(connectionId, chatId, text)
    revalidatePath(`/whatsapp/chat/${chatId}`)
    return result
}
