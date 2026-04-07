'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { importTelegramHistory } from '@/app/tg-actions'
import { importWhatsAppHistory } from '@/lib/whatsapp/WhatsAppService'

// ─── AiAgentConfig ────────────────────────────────────────────────

export async function getAiConfig() {
    try {
        const rows = await prisma.$queryRaw<any[]>`SELECT * FROM "AiAgentConfig" WHERE id = 'singleton' LIMIT 1`
        return rows[0] ?? null
    } catch { return null }
}

export async function saveAiConfig(data: Record<string, any>) {
    const fields = Object.keys(data)
    if (fields.length === 0) return null
    try {
        // Upsert вручную через raw SQL
        const existing = await prisma.$queryRaw<any[]>`SELECT id FROM "AiAgentConfig" WHERE id = 'singleton' LIMIT 1`
        if (existing.length === 0) {
            const allData = { id: 'singleton', ...data }
            const cols  = Object.keys(allData).map(k => `"${k}"`).join(', ')
            const vals  = Object.values(allData)
            const marks = vals.map((_, i) => `$${i + 1}`).join(', ')
            await prisma.$executeRawUnsafe(`INSERT INTO "AiAgentConfig" (${cols}) VALUES (${marks})`, ...vals)
        } else {
            const sets  = fields.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
            const vals  = Object.values(data)
            await prisma.$executeRawUnsafe(
                `UPDATE "AiAgentConfig" SET ${sets}, "updatedAt" = NOW() WHERE id = 'singleton'`,
                ...vals
            )
        }
        revalidatePath('/settings/ai')
        return { id: 'singleton', ...data }
    } catch (e: any) {
        console.error('[AI Config] saveAiConfig error:', e.message)
        return null
    }
}

export async function testAiConnection(provider: string, apiKey: string, model: string) {
    // Минимальный тест — попытка обратиться к API
    try {
        if (provider === 'anthropic') {
            const res = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key':         apiKey,
                    'anthropic-version': '2023-06-01',
                    'content-type':      'application/json',
                },
                body: JSON.stringify({
                    model,
                    max_tokens: 10,
                    messages: [{ role: 'user', content: 'ping' }],
                }),
            })
            if (res.status === 401) return { ok: false, error: 'Неверный API ключ' }
            if (res.status === 404) return { ok: false, error: `Модель "${model}" не найдена` }
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                return { ok: false, error: body?.error?.message || `HTTP ${res.status}` }
            }
            // Обновляем статус в БД
            await saveAiConfig({ connectionStatus: 'ok', lastConnectionCheckAt: new Date() })
            return { ok: true }
        }
        return { ok: false, error: 'Провайдер не поддерживается' }
    } catch (e: any) {
        return { ok: false, error: e.message }
    }
}

// ─── KnowledgeBaseEntry ───────────────────────────────────────────

export async function getKnowledgeBase() {
    try {
        return await prisma.$queryRaw<any[]>`SELECT * FROM "KnowledgeBaseEntry" ORDER BY "priority" DESC, "createdAt" ASC`
    } catch { return [] }
}

export async function createKnowledgeEntry(data: {
    title: string
    category: string
    sampleQuestions: string[]
    answer: string
    tags: string[]
    channels: string[]
    priority: number
}) {
    const id = `kb_${Date.now()}`
    await prisma.$executeRaw`
        INSERT INTO "KnowledgeBaseEntry" (id, title, category, "sampleQuestions", answer, tags, channels, active, priority, "createdAt", "updatedAt")
        VALUES (
            ${id}, ${data.title}, ${data.category},
            ${JSON.stringify(data.sampleQuestions)}::jsonb,
            ${data.answer},
            ${data.tags}::text[],
            ${data.channels}::text[],
            true, ${data.priority}, NOW(), NOW()
        )
    `
    revalidatePath('/settings/ai')
    return { id, ...data, active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
}

export async function updateKnowledgeEntry(id: string, data: Partial<{
    title: string; category: string; sampleQuestions: string[]
    answer: string; tags: string[]; channels: string[]
    active: boolean; priority: number
}>) {
    const fields = Object.keys(data)
    if (fields.length === 0) return
    const sets = fields.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
    const vals = Object.values(data)
    await prisma.$executeRawUnsafe(
        `UPDATE "KnowledgeBaseEntry" SET ${sets}, "lastReviewedAt" = NOW(), "updatedAt" = NOW() WHERE id = $${vals.length + 1}`,
        ...vals, id
    )
    revalidatePath('/settings/ai')
}

export async function deleteKnowledgeEntry(id: string) {
    await prisma.$executeRaw`DELETE FROM "KnowledgeBaseEntry" WHERE id = ${id}`
    revalidatePath('/settings/ai')
}

// ─── AiDecisionLog ────────────────────────────────────────────────

export async function getDecisionLogs(filters?: {
    channel?: string
    intent?: string
    decision?: string
    limit?: number
}) {
    try {
        const limit = filters?.limit ?? 50
        return await prisma.$queryRaw<any[]>`
            SELECT * FROM "AiDecisionLog"
            ORDER BY "createdAt" DESC
            LIMIT ${limit}
        `
    } catch { return [] }
}

export async function setOperatorVerdict(logId: string, verdict: 'good' | 'bad' | 'fixed') {
    try {
        await prisma.$executeRaw`
            UPDATE "AiDecisionLog"
            SET "reviewedByOperator" = true, "operatorVerdict" = ${verdict}
            WHERE id = ${logId}
        `
        revalidatePath('/settings/ai')
    } catch { /* ignore */ }
}

// ─── HistoryImportJob ─────────────────────────────────────────────

export async function getLastImportJob() {
    try {
        const rows = await prisma.$queryRaw<any[]>`SELECT * FROM "HistoryImportJob" ORDER BY "createdAt" DESC LIMIT 1`
        return rows[0] ?? null
    } catch { return null }
}

export async function getAllImportJobs(limit = 10) {
    try {
        return await prisma.$queryRaw<any[]>`SELECT * FROM "HistoryImportJob" ORDER BY "createdAt" DESC LIMIT ${limit}`
    } catch { return [] }
}

export async function createImportJob(data: {
    channels: string[]
    mode: 'from_connection_time' | 'available_history' | 'last_n_days'
    daysBack?: number
    connectionId?: string
}) {
    const id = `job_${Date.now()}`
    const daysBack = data.daysBack ?? null
    const connId = data.connectionId ?? null
    try {
        await prisma.$executeRaw`
            INSERT INTO "HistoryImportJob" (id, channels, mode, "daysBack", "connectionId", status, "chatsScanned", "contactsFound", "messagesImported", "createdAt")
            VALUES (
                ${id},
                ${data.channels}::text[],
                ${data.mode}::"AiImportMode",
                ${daysBack},
                ${connId},
                'queued'::"AiImportStatus",
                0, 0, 0,
                NOW()
            )
        `
    } catch (e: any) {
        console.error('[AI Import] createImportJob error:', e.message)
    }

    const job = { id, ...data, connectionId: connId, status: 'queued', chatsScanned: 0, contactsFound: 0, messagesImported: 0, createdAt: new Date().toISOString() }
    revalidatePath('/settings/ai')

    if (data.channels.includes('max')) {
        const scraperUrl = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'
        const crmUrl     = process.env.NEXTAUTH_URL    || 'http://localhost:3002'

        fetch(`${scraperUrl}/import-history`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                jobId:    id,
                crmApiUrl: crmUrl,
                mode:     data.mode,
                daysBack: data.daysBack,
            }),
        }).catch(e => console.error('[AI Import] scraper call error:', e.message))
    }

    if (data.channels.includes('telegram')) {
        importTelegramHistory(id, data.mode, data.daysBack, data.connectionId)
            .catch(e => console.error('[AI Import] telegram import error:', e.message))
    }

    if (data.channels.includes('whatsapp')) {
        importWhatsAppHistory(id, data.mode, data.daysBack, data.connectionId)
            .catch(e => console.error('[AI Import] whatsapp import error:', e.message))
    }

    return job
}

export async function cancelImportJob(id: string) {
    try {
        await prisma.$executeRaw`
            UPDATE "HistoryImportJob"
            SET status = 'failed'::"AiImportStatus", "resultType" = 'failed', "finishedAt" = NOW()
            WHERE id = ${id} AND status IN ('queued'::"AiImportStatus", 'running'::"AiImportStatus")
        `
        revalidatePath('/settings/ai')
    } catch (e: any) {
        console.error('[AI Import] cancelImportJob error:', e.message)
    }
}

export async function deleteImportJob(id: string) {
    try {
        await prisma.$executeRaw`DELETE FROM "HistoryImportJob" WHERE id = ${id}`
        revalidatePath('/settings/ai')
    } catch (e: any) {
        console.error('[AI Import] deleteImportJob error:', e.message)
    }
}

// ─── Preflight: проверка доступности скрапера ────────────────────

export async function checkScraperHealth(channels: string[]): Promise<
    Record<string, { ok: boolean; status?: string; error?: string }>
> {
    const results: Record<string, { ok: boolean; status?: string; error?: string }> = {}

    if (channels.includes('max')) {
        try {
            const scraperUrl = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'
            const res = await fetch(`${scraperUrl}/health`, {
                signal: AbortSignal.timeout(3000),
                cache:  'no-store',
            })
            if (res.ok) {
                const data = await res.json()
                results.max = { ok: !!data.isReady, status: data.status }
            } else {
                results.max = { ok: false, error: `HTTP ${res.status}` }
            }
        } catch {
            results.max = { ok: false, error: 'Недоступен' }
        }
    }

    // TG и WA: здесь можно добавить проверки их транспортов
    if (channels.includes('telegram')) results.telegram = { ok: true }
    if (channels.includes('whatsapp')) results.whatsapp = { ok: true }

    return results
}

// ─── Runtime stats (за 24ч из AiDecisionLog) ─────────────────────

export async function getAiRuntimeStats() {
    try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
        const logs = await prisma.$queryRaw<any[]>`
            SELECT decision, escalated, error FROM "AiDecisionLog"
            WHERE "createdAt" >= ${since}
        `
        return {
            total:       logs.length,
            autoReplied: logs.filter((l: any) => l.decision === 'auto_reply' && !l.error).length,
            escalated:   logs.filter((l: any) => l.escalated).length,
            errors:      logs.filter((l: any) => !!l.error).length,
        }
    } catch {
        return { total: 0, autoReplied: 0, escalated: 0, errors: 0 }
    }
}
