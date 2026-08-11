/* eslint-disable @typescript-eslint/no-explicit-any -- legacy import-job rows are
   intentionally passed through to the existing settings clients. */
'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { requireIntegrationAdminAccess } from '@/modules/identity-access/public/v1'
import { importOperationalTelegramHistoryV1 } from '@/infrastructure/telegram/operational-capabilities'
import { importOperationalWhatsAppHistoryV1 } from '@/infrastructure/whatsapp/operational-capabilities'
import {
    CANCEL_HISTORY_IMPORT_JOB_COMMAND_V1,
    DELETE_HISTORY_IMPORT_JOB_COMMAND_V1,
    QUEUE_HISTORY_IMPORT_JOB_COMMAND_V1,
} from '@/contracts/messaging/v1'
import {
    cancelHistoryImportJobV1,
    deleteHistoryImportJobV1,
    queueHistoryImportJobV1,
} from './index'

export interface ConnectionTotalsForUi {
    messages: number
    chats: number
    contacts: number
    earliestSentAt: string | null
    latestSentAt: string | null
}

export async function getLastImportJob() {
    try {
        const rows = await prisma.$queryRaw<any[]>`SELECT * FROM "HistoryImportJob" ORDER BY "createdAt" DESC LIMIT 1`
        return rows[0] ?? null
    } catch {
        return null
    }
}

export async function getAllImportJobs(limit = 10) {
    try {
        return await prisma.$queryRaw<any[]>`SELECT * FROM "HistoryImportJob" ORDER BY "createdAt" DESC LIMIT ${limit}`
    } catch {
        return []
    }
}

export async function createImportJob(data: {
    channels: string[]
    mode: 'from_connection_time' | 'available_history' | 'last_n_days'
    daysBack?: number
    connectionId?: string
}) {
    await requireIntegrationAdminAccess()
    const id = `job_${Date.now()}`
    const daysBack = data.daysBack ?? null
    const connId = data.connectionId ?? null
    try {
        await queueHistoryImportJobV1({ contract: QUEUE_HISTORY_IMPORT_JOB_COMMAND_V1, jobId: id, channels: data.channels, mode: data.mode, daysBack, connectionId: connId })
    } catch (e: any) {
        console.error('[AI Import] createImportJob error:', e.message)
    }

    const job = { id, ...data, connectionId: connId, status: 'queued', chatsScanned: 0, contactsFound: 0, messagesImported: 0, createdAt: new Date().toISOString() }
    revalidatePath('/settings/ai')

    if (data.channels.includes('max')) {
        const scraperUrl = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'
        const crmUrl = process.env.NEXTAUTH_URL || 'http://localhost:3002'

        fetch(`${scraperUrl}/import-history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jobId: id,
                crmApiUrl: crmUrl,
                mode: data.mode,
                daysBack: data.daysBack,
            }),
        }).catch(e => console.error('[AI Import] scraper call error:', e.message))
    }

    if (data.channels.includes('telegram')) {
        importOperationalTelegramHistoryV1(id, data.mode, data.daysBack, data.connectionId)
            .catch(e => console.error('[AI Import] telegram import error:', e.message))
    }

    if (data.channels.includes('whatsapp')) {
        importOperationalWhatsAppHistoryV1(id, data.mode, data.daysBack, data.connectionId)
            .catch(e => console.error('[AI Import] whatsapp import error:', e.message))
    }

    return job
}

export async function cancelImportJob(id: string) {
    await requireIntegrationAdminAccess()
    try {
        await cancelHistoryImportJobV1({ contract: CANCEL_HISTORY_IMPORT_JOB_COMMAND_V1, jobId: id })
        revalidatePath('/settings/ai')
    } catch (e: any) {
        console.error('[AI Import] cancelImportJob error:', e.message)
    }
}

export async function deleteImportJob(id: string) {
    await requireIntegrationAdminAccess()
    try {
        await deleteHistoryImportJobV1({ contract: DELETE_HISTORY_IMPORT_JOB_COMMAND_V1, jobId: id })
        revalidatePath('/settings/ai')
    } catch (e: any) {
        console.error('[AI Import] deleteImportJob error:', e.message)
    }
}

export async function getConnectionTotalsForUi(connectionId: string): Promise<ConnectionTotalsForUi> {
    const empty: ConnectionTotalsForUi = {
        messages: 0,
        chats: 0,
        contacts: 0,
        earliestSentAt: null,
        latestSentAt: null,
    }
    if (!connectionId) return empty
    try {
        const rows = await prisma.$queryRaw<Array<{
            messages: number
            chats: number
            contacts: number
            earliestSentAt: Date | null
            latestSentAt: Date | null
        }>>`
            SELECT
                COUNT(*)::int                              AS messages,
                COUNT(DISTINCT m."chatId")::int            AS chats,
                COUNT(DISTINCT c."contactId")::int         AS contacts,
                MIN(m."sentAt")                            AS "earliestSentAt",
                MAX(m."sentAt")                            AS "latestSentAt"
            FROM "Message" m
            LEFT JOIN "Chat" c          ON c.id = m."chatId"
            LEFT JOIN "WhatsAppChat" wc ON wc.id = c."externalChatId"
            WHERE m.channel::text IN ('whatsapp', 'telegram', 'max')
              AND COALESCE(wc."connectionId", c.metadata->>'connectionId') = ${connectionId}
        `
        const row = rows[0]
        if (!row) return empty
        return {
            messages: Number(row.messages ?? 0),
            chats: Number(row.chats ?? 0),
            contacts: Number(row.contacts ?? 0),
            earliestSentAt: row.earliestSentAt ? new Date(row.earliestSentAt).toISOString() : null,
            latestSentAt: row.latestSentAt ? new Date(row.latestSentAt).toISOString() : null,
        }
    } catch (e: any) {
        if (process.env.NODE_ENV !== 'production') {
            console.error('[getConnectionTotalsForUi] failed:', e?.message)
        }
        return empty
    }
}
