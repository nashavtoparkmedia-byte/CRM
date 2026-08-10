'use server'

import { prisma } from '@/lib/prisma'
import { initializeClient, destroyClient, sendMessage as waSendMessage, resetSyncGuard } from '@/lib/whatsapp/WhatsAppService'
import { revalidatePath } from 'next/cache'
import { DELETE_CONVERSATIONS_BY_CHANNEL_COMMAND_V1, DELETE_CONVERSATIONS_BY_ID_COMMAND_V1, DELETE_HISTORY_IMPORT_JOBS_FOR_CONNECTION_COMMAND_V1 } from '@/contracts/messaging/v1'
import { deleteConversationsByChannelV1, deleteConversationsByIdV1, deleteHistoryImportJobsForConnectionV1 } from '@/modules/messaging/public/v1'
import { projectWhatsAppConnectionMetadata } from '@/modules/whatsapp-channel/public/v1/whatsapp-connection-public-metadata'
import { readPendingWhatsAppQr } from '@/lib/whatsapp/whatsapp-qr-ceremony'
import { requireIntegrationAdminAccess } from '@/modules/identity-access/public/v1'

const publicWhatsAppConnectionSelect = {
    id: true,
    name: true,
    status: true,
    phoneNumber: true,
    createdAt: true,
    updatedAt: true,
} as const

function toPublicWhatsAppConnection(connection: {
    id: string
    name: string | null
    status: string
    phoneNumber: string | null
    createdAt: Date
    updatedAt: Date
}) {
    return projectWhatsAppConnectionMetadata({
        id: connection.id,
        name: connection.name,
        status: connection.status,
        phoneNumber: connection.phoneNumber,
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
        // QR-pending is not an established session. Do not select the raw
        // persistence payload merely to derive browser metadata.
        sessionConfigured: connection.status === 'ready',
    })
}

export async function createWhatsAppConnection(name?: string) {
    await requireIntegrationAdminAccess()
    console.log(`[WA-ACTIONS] createWhatsAppConnection called with name: ${name}`)

    // Guard: prevent creating a new connection if one is already pending QR scan
    const pending = await prisma.whatsAppConnection.findFirst({
        where: { status: { in: ['idle', 'qr', 'qr_expired', 'authenticated'] } },
        select: publicWhatsAppConnectionSelect,
    })
    if (pending) {
        console.log(`[WA-ACTIONS] Blocked: already have pending connection ${pending.id} (status=${pending.status})`)
        return toPublicWhatsAppConnection(pending)
    }

    // PR7.14: дефолтное имя теперь NULL вместо "WhatsApp Account".
    // UI сам подберёт fallback — телефон, дата или «Новое подключение».
    // Без литеральных дефолтов исключаем ситуацию «два WhatsApp Account».
    const trimmed = name?.trim() || null
    const connection = await prisma.whatsAppConnection.create({
        data: { name: trimmed, status: 'idle' },
        select: publicWhatsAppConnectionSelect,
    })

    console.log(`[WA-ACTIONS] Created connection: ${connection.id} name=${trimmed ?? '<null>'}`)
    initializeWhatsAppConnection(connection.id).catch(console.error)
    revalidatePath('/whatsapp')
    revalidatePath('/settings/integrations/whatsapp')
    return toPublicWhatsAppConnection(connection)
}

/** PR7.14: переименование подключения. Допустимо переименовывать в
 *  любой момент — не влияет на сессию Baileys / phoneNumber. Пустая
 *  строка → NULL (UI снова покажет fallback по телефону). */
export async function renameWhatsAppConnection(id: string, name: string) {
    await requireIntegrationAdminAccess()
    const trimmed = name?.trim() ?? ''
    const next = trimmed.length === 0 ? null : trimmed.slice(0, 80)
    console.log(`[WA-ACTIONS] renameWhatsAppConnection id=${id} → ${next ?? '<null>'}`)
    await prisma.whatsAppConnection.update({
        where: { id },
        data: { name: next },
    })
    revalidatePath('/settings/integrations/whatsapp')
    revalidatePath('/whatsapp')
    revalidatePath('/settings/ai')
    return { id, name: next }
}

export async function initializeWhatsAppConnection(connectionId: string) {
    await requireIntegrationAdminAccess()
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
    await requireIntegrationAdminAccess()
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
    await requireIntegrationAdminAccess()
    console.log(`[WA-ACTIONS] getWhatsAppConnections called`)
    const connections = await prisma.whatsAppConnection.findMany({
        orderBy: { createdAt: 'asc' },
        select: publicWhatsAppConnectionSelect,
    })
    return connections.map(toPublicWhatsAppConnection)
}

export async function getWhatsAppStatus(connectionId: string) {
    await requireIntegrationAdminAccess()
    const { getActualStatus, isPaused } = await import('@/lib/whatsapp/WhatsAppService')
    const conn = await prisma.whatsAppConnection.findUnique({
        where: { id: connectionId },
        select: publicWhatsAppConnectionSelect,
    })
    if (!conn) return null
    const actual = await getActualStatus(connectionId)
    return {
        ...toPublicWhatsAppConnection(conn),
        // Derived fields — UI MUST use these, not raw conn.status.
        actualState: actual.state,
        actualLabel: actual.humanReadable,
        canRetry: actual.canRetry,
        canForceQR: actual.canForceQR,
        canForceReset: actual.canForceReset,
        lastReadyAt: actual.lastReadyAt,
        lastError: actual.lastError,
        isPaused: isPaused(connectionId), // runtime pause flag (in-memory)
    }
}

/**
 * Explicit authentication-ceremony output. QR material comes only from the
 * short-lived in-memory ceremony store; WhatsAppConnection.sessionData is
 * never read or returned through a browser-callable action.
 */
export async function getWhatsAppQrCode(connectionId: string) {
    await requireIntegrationAdminAccess()
    const connection = await prisma.whatsAppConnection.findUnique({
        where: { id: connectionId },
        select: { status: true },
    })
    if (!connection || !['qr', 'qr_required'].includes(connection.status)) {
        return { qrCodeDataUrl: null }
    }
    return { qrCodeDataUrl: readPendingWhatsAppQr(connectionId) }
}

export async function disconnectWhatsApp(connectionId: string, wipeAuth: boolean = false) {
    await requireIntegrationAdminAccess()
    console.log(`[WA-ACTIONS] disconnectWhatsApp called for: ${connectionId} wipeAuth=${wipeAuth}`)
    await destroyClient(connectionId)
    // destroyClient does not update DB status — without this, UI would keep showing 'ready'
    await prisma.whatsAppConnection.update({
        where: { id: connectionId },
        data: { status: 'idle', sessionData: null },
    }).catch(() => {})

    // If user asked to wipe auth too (e.g. "Отключить и удалить сообщения"),
    // clear the Baileys credentials folder so next connect actually requires QR scan.
    if (wipeAuth) {
        try {
            const path = await import('path')
            const fs = await import('fs')
            const { WWEBJS_AUTH_DIR } = await import('@/lib/whatsapp/WhatsAppCleanup')
            const sessionDir = path.join(WWEBJS_AUTH_DIR, `session-${connectionId}`)
            await fs.promises.rm(sessionDir, { recursive: true, force: true })
            console.log(`[WA-ACTIONS] Wiped auth folder: ${sessionDir}`)
        } catch (err: any) {
            console.error(`[WA-ACTIONS] Wipe auth failed:`, err.message)
        }
    }

    revalidatePath('/settings/integrations/whatsapp')
    revalidatePath('/whatsapp')
}

export async function forceResetWhatsAppSession(connectionId: string) {
    await requireIntegrationAdminAccess()
    console.log(`[WA-ACTIONS] forceResetWhatsAppSession called for: ${connectionId}`)
    const { forceResetSession } = await import('@/lib/whatsapp/WhatsAppService')
    await forceResetSession(connectionId)
    revalidatePath('/settings/integrations/whatsapp')
    return { success: true }
}

export async function deleteWhatsAppConnection(connectionId: string) {
    await requireIntegrationAdminAccess()
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
    await requireIntegrationAdminAccess()
    console.log(`[WA-ACTIONS] pauseWhatsAppConnection id=${connectionId} deleteMessages=${deleteMessages}`)
    // Keep Baileys socket alive — just flag this connection as paused so incoming
    // messages are buffered in memory instead of being saved to DB.
    const { setPaused } = await import('@/lib/whatsapp/WhatsAppService')
    setPaused(connectionId, true)
    if (deleteMessages) {
        await deleteWhatsAppMessages(connectionId)
    }
    revalidatePath('/settings/integrations/whatsapp')
    return { success: true, paused: true }
}

export async function resumeWhatsAppConnection(connectionId: string, catchUp: boolean) {
    await requireIntegrationAdminAccess()
    console.log(`[WA-ACTIONS] resumeWhatsAppConnection id=${connectionId} catchUp=${catchUp}`)
    const { setPaused, flushPausedBuffer, dropPausedBuffer } = await import('@/lib/whatsapp/WhatsAppService')

    // First release pause flag so no new messages are buffered during flush.
    setPaused(connectionId, false)

    let processed = 0
    let dropped = 0
    if (catchUp) {
        // "Пробросить в CRM" — save buffered messages to DB via normal handler
        processed = await flushPausedBuffer(connectionId)
    } else {
        // "Начать с этого места" — discard buffer
        dropped = dropPausedBuffer(connectionId)
    }

    revalidatePath('/settings/integrations/whatsapp')
    revalidatePath('/messages')
    return { success: true, paused: false, processed, dropped }
}

export async function deleteWhatsAppMessages(connectionId: string) {
    await requireIntegrationAdminAccess()
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
        await deleteConversationsByIdV1({ contract: DELETE_CONVERSATIONS_BY_ID_COMMAND_V1, conversationIds: connectionChatIds })
        console.log(`[WA-DELETE] Deleted messages and chats for connection ${connectionId}`)

        const contactIds = [...new Set(connectionChats.map((c: any) => c.contactId).filter(Boolean))] as string[]

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
        await deleteHistoryImportJobsForConnectionV1({ contract: DELETE_HISTORY_IMPORT_JOBS_FOR_CONNECTION_COMMAND_V1, channel: 'whatsapp', connectionId })
        console.log(`[WA-DELETE] Cleaned up import jobs for connection ${connectionId}`)
    } catch (e: any) { console.error(`[WA-DELETE] ImportJob cleanup error: ${e.message}`) }

    // Wipe all whatsapp chats + their messages that were missed by the
    // metadata.connectionId filter above. Legacy chats from wa-web.js era
    // have metadata={} — those were never touched. Now: if this is the
    // ONLY active WA connection, all remaining whatsapp chats are orphans
    // of this connection or dead history — safe to wipe wholesale.
    try {
        const activeWaCount = await prisma.whatsAppConnection.count({
            where: { status: { in: ['ready', 'authenticated', 'qr', 'idle'] } },
        })
        if (activeWaCount <= 1) {
            await deleteConversationsByChannelV1({ contract: DELETE_CONVERSATIONS_BY_CHANNEL_COMMAND_V1, channel: 'whatsapp' })
            console.log(`[WA-DELETE] Wholesale wipe (single WA connection): removed all remaining WhatsApp conversations`)
        } else {
            // Multiple WA connections — be conservative, only remove truly orphan (zero messages)
            const orphanChats = await (prisma.chat as any).findMany({
                where: { channel: 'whatsapp' },
                select: { id: true, _count: { select: { messages: true } } },
            })
            const orphanIds = orphanChats
                .filter((c: any) => (c._count?.messages ?? 0) === 0)
                .map((c: any) => c.id)
            if (orphanIds.length > 0) {
                await deleteConversationsByIdV1({ contract: DELETE_CONVERSATIONS_BY_ID_COMMAND_V1, conversationIds: orphanIds })
                console.log(`[WA-DELETE] Removed ${orphanIds.length} orphan whatsapp chats (no messages)`)
            }
        }
    } catch (e: any) { console.error(`[WA-DELETE] Wholesale cleanup error: ${e.message}`) }

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

export async function sendWhatsAppMessage(connectionId: string, chatId: string, text: string, quotedMsgId?: string) {
    console.log(`[WA-ACTIONS] sendWhatsAppMessage called for: ${connectionId}, chat: ${chatId}`)
    const result = await waSendMessage(connectionId, chatId, text, quotedMsgId)
    revalidatePath(`/whatsapp/chat/${chatId}`)
    return result
}
