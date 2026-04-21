'use server'

import { prisma } from '@/lib/prisma'
import { initializeClient, destroyClient, sendMessage as waSendMessage, resetSyncGuard } from '@/lib/whatsapp/WhatsAppService'
import { revalidatePath } from 'next/cache'

export async function createWhatsAppConnection(name?: string) {
    console.log(`[WA-ACTIONS] createWhatsAppConnection called with name: ${name}`)

    // Guard: prevent creating a new connection if one is already pending QR scan
    const pending = await prisma.whatsAppConnection.findFirst({
        where: { status: { in: ['idle', 'qr', 'qr_expired', 'authenticated'] } }
    })
    if (pending) {
        console.log(`[WA-ACTIONS] Blocked: already have pending connection ${pending.id} (status=${pending.status})`)
        return pending
    }

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
    const { getActualStatus } = await import('@/lib/whatsapp/WhatsAppService')
    const conn = await prisma.whatsAppConnection.findUnique({
        where: { id: connectionId }
    })
    if (!conn) return null
    const actual = await getActualStatus(connectionId)
    return {
        ...conn,
        // Derived fields — UI MUST use these, not raw conn.status.
        // `actualState === 'ready'` is the ONLY condition for "подключён и готов к работе".
        actualState: actual.state,
        actualLabel: actual.humanReadable,
        canRetry: actual.canRetry,
        canForceQR: actual.canForceQR,
        canForceReset: actual.canForceReset,
        lastReadyAt: actual.lastReadyAt,
        lastError: actual.lastError,
    }
}

export async function disconnectWhatsApp(connectionId: string) {
    console.log(`[WA-ACTIONS] disconnectWhatsApp called for: ${connectionId}`)
    await destroyClient(connectionId)
    // destroyClient does not update DB status — without this, UI would keep showing 'ready'
    await prisma.whatsAppConnection.update({
        where: { id: connectionId },
        data: { status: 'idle', sessionData: null },
    }).catch(() => {})
    revalidatePath('/settings/integrations/whatsapp')
    revalidatePath('/whatsapp')
}

export async function forceResetWhatsAppSession(connectionId: string) {
    console.log(`[WA-ACTIONS] forceResetWhatsAppSession called for: ${connectionId}`)
    const { forceResetSession } = await import('@/lib/whatsapp/WhatsAppService')
    await forceResetSession(connectionId)
    revalidatePath('/settings/integrations/whatsapp')
    return { success: true }
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
    // Note: WhatsAppConnection schema has no isPaused/isActive field.
    // Pause is handled at the client level in WhatsAppService.
    if (deleteMessages) {
        await deleteWhatsAppMessages(connectionId)
    }
    revalidatePath('/settings/integrations/whatsapp')
}

export async function resumeWhatsAppConnection(connectionId: string, catchUp: boolean) {
    console.log(`[WA-ACTIONS] resumeWhatsAppConnection id=${connectionId} catchUp=${catchUp}`)
    // Note: WhatsAppConnection schema has no isPaused/isActive field.
    // Resume is handled at the client level in WhatsAppService.
    revalidatePath('/settings/integrations/whatsapp')
}

export async function deleteWhatsAppMessages(connectionId: string) {
    console.log(`[WA-ACTIONS] deleteWhatsAppMessages id=${connectionId}`)
    // Do NOT reset sync guard here — auto-sync must stay blocked after deletion.
    // Guard is only reset when user explicitly clicks "Загрузить историю".
    // Delete from WA-specific tables
    try {
        await prisma.whatsAppMessage.deleteMany({ where: { chat: { connectionId } } })
    } catch (e: any) { console.error(`[WA-DELETE] WhatsAppMessage delete error: ${e.message}`) }

    try {
        await prisma.whatsAppChat.deleteMany({ where: { connectionId } })
    } catch (e: any) { console.error(`[WA-DELETE] WhatsAppChat delete error: ${e.message}`) }

    // Find unified chats that belong to THIS connection (by metadata.connectionId)
    const unifiedChats = await (prisma.chat as any).findMany({
        where: { channel: 'whatsapp' },
        select: { id: true, contactId: true, metadata: true },
    })
    // Filter to only chats belonging to this connection
    const connectionChats = unifiedChats.filter((c: any) => {
        const connId = c.metadata?.connectionId
        // Match by connectionId, or include legacy chats without connectionId
        // only if there's a single WA connection (backward compat)
        return connId === connectionId
    })
    const connectionChatIds = connectionChats.map((c: any) => c.id)

    if (connectionChatIds.length > 0) {
        // Delete messages only from this connection's chats
        const msgDel = await (prisma.message as any).deleteMany({
            where: { chatId: { in: connectionChatIds } }
        })
        console.log(`[WA-DELETE] Deleted ${msgDel.count} messages for connection ${connectionId}`)

        const contactIds = [...new Set(connectionChats.map((c: any) => c.contactId).filter(Boolean))] as string[]

        const chatDel = await (prisma.chat as any).deleteMany({ where: { id: { in: connectionChatIds } } })
        console.log(`[WA-DELETE] Deleted ${chatDel.count} chats for connection ${connectionId}`)

        // Cleanup dangling identities
        if (contactIds.length > 0) {
            const { ContactService } = await import('@/lib/ContactService')
            await ContactService.cleanupDanglingIdentities(contactIds)
        }
    } else {
        console.log(`[WA-DELETE] No unified chats found for connection ${connectionId}`)
    }
    // Clean up HistoryImportJob records only for THIS connection so ChannelSyncBlock resets
    try {
        await prisma.$executeRaw`DELETE FROM "HistoryImportJob" WHERE 'whatsapp' = ANY(channels) AND "connectionId" = ${connectionId}`
        console.log(`[WA-DELETE] Cleaned up import jobs for connection ${connectionId}`)
    } catch (e: any) { console.error(`[WA-DELETE] ImportJob cleanup error: ${e.message}`) }

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
