/* eslint-disable @typescript-eslint/no-explicit-any -- file uses Prisma
   $queryRaw which returns any[]; pragmatic over strict here. */
'use server'

import { cookies } from 'next/headers'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { importTelegramHistory } from '@/app/tg-actions'
import { importWhatsAppHistory } from '@/lib/whatsapp/WhatsAppService'
import { getUsers } from '@/lib/users/user-service'

// ─── Role guard ───────────────────────────────────────────────────
//
// UI уже скрывает кнопки настройки от менеджеров — но server actions
// можно вызвать вручную через DevTools / fetch. Этот guard ставит
// тот же чек на серверной стороне.
//
// ВАЖНО: НЕ используем общий getCurrentUser() — он fallback'ится на
// `u3` (Руководитель) когда cookie crm_user_id отсутствует. Менеджер
// мог бы удалить cookie через DevTools и обойти проверку. Здесь —
// строгая логика: нет cookie → нет прав; пользователь не найден → нет
// прав; роль не Администратор/Руководитель → нет прав.
//
// Helper не exported: в файле с 'use server' все exported функции
// становятся server actions, а нам нужна внутренняя проверка.
//
// Open actions, доступные ВСЕМ ролям (включая менеджера):
//   - все get* (read-only)
//   - setOperatorVerdict (👍/👎 — единственное легитимное
//     mutation-действие для менеджера в этом разделе)
//   - checkScraperHealth (read-only ping транспорта)
//
// Protected actions (только Администратор / Руководитель):
//   - saveAiConfig
//   - testAiConnection (отправляет API-ключ в Anthropic/OpenAI)
//   - create/update/deleteKnowledgeEntry
//   - createImportJob / cancelImportJob / deleteImportJob
async function assertCanEditAi() {
    const cookieStore = await cookies()
    const id = cookieStore.get('crm_user_id')?.value
    if (!id) throw new Error('Недостаточно прав')
    const users = await getUsers()
    const user = users.find(u => u.id === id)
    if (!user) throw new Error('Недостаточно прав')
    if (user.role !== 'Администратор' && user.role !== 'Руководитель') {
        throw new Error('Недостаточно прав')
    }
}

// ─── AiAgentConfig ────────────────────────────────────────────────

export async function getAiConfig() {
    try {
        const rows = await prisma.$queryRaw<any[]>`SELECT * FROM "AiAgentConfig" WHERE id = 'singleton' LIMIT 1`
        return rows[0] ?? null
    } catch { return null }
}

export async function saveAiConfig(data: Record<string, any>) {
    await assertCanEditAi()
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
    await assertCanEditAi()
    // Минимальный тест — попытка обратиться к API провайдера. Outbound
    // fetch уже идёт через undici globalDispatcher (см.
    // src/lib/ai-call/init-proxy.ts, импортируется из instrumentation.ts),
    // поэтому если HTTPS_PROXY задан — запросы идут через VPN. Никаких
    // специальных опций в fetch() добавлять не нужно.
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
            if (res.status === 403) return { ok: false, error: 'Anthropic вернул 403 (гео-блок). Задай HTTPS_PROXY в .env и перезапусти dev.' }
            if (res.status === 404) return { ok: false, error: `Модель "${model}" не найдена` }
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                return { ok: false, error: body?.error?.message || `HTTP ${res.status}` }
            }
            await saveAiConfig({ connectionStatus: 'ok', lastConnectionCheckAt: new Date() })
            return { ok: true }
        }
        if (provider === 'openai') {
            // Лёгкая проверка через GET /v1/models — не тратит токены,
            // достаточно убедиться что ключ принят OpenAI. Сам model в
            // тесте не дёргаем — лишний расход.
            const res = await fetch('https://api.openai.com/v1/models', {
                method: 'GET',
                headers: { Authorization: `Bearer ${apiKey}` },
            })
            if (res.status === 401) return { ok: false, error: 'Неверный API ключ' }
            if (res.status === 403) return { ok: false, error: 'OpenAI вернул 403 (гео-блок). Задай HTTPS_PROXY в .env и перезапусти dev.' }
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                return { ok: false, error: body?.error?.message || `HTTP ${res.status}` }
            }
            // Опционально проверяем, что выбранная модель доступна в этом
            // аккаунте. Не валим тест если не нашли — просто предупреждаем.
            try {
                const data = await res.json()
                const ids: string[] = Array.isArray(data?.data) ? data.data.map((m: any) => m.id) : []
                if (model && ids.length > 0 && !ids.includes(model)) {
                    return { ok: false, error: `Модель "${model}" не доступна в этом OpenAI аккаунте` }
                }
            } catch { /* models list parsing — best-effort, не валим */ }
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
    await assertCanEditAi()
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
    await assertCanEditAi()
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
    await assertCanEditAi()
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
    await assertCanEditAi()
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
    await assertCanEditAi()
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
    await assertCanEditAi()
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

// ─── AiAgentProfile (стили общения) ──────────────────────────────
//
// Один профиль = один стиль (Роль / Тон / Разрешено / Запрещено).
// Активный профиль выбирается через AiAgentConfig.activeProfileId.
// При null активного — runtime fallback на legacy-поля в config'е
// (см. ContextBuilder).

export interface AiProfileData {
    id: string
    name: string
    description: string | null
    promptRole: string | null
    promptTone: string | null
    promptAllowed: string | null
    promptForbidden: string | null
    isDefault: boolean
    sortOrder: number
}

export async function listAiProfiles(): Promise<AiProfileData[]> {
    try {
        return await prisma.$queryRaw<AiProfileData[]>`
            SELECT id, name, description,
                   "promptRole", "promptTone", "promptAllowed", "promptForbidden",
                   "isDefault", "sortOrder"
            FROM "AiAgentProfile"
            ORDER BY "sortOrder" ASC, "createdAt" ASC
        `
    } catch { return [] }
}

export async function getActiveProfileId(): Promise<string | null> {
    try {
        const rows = await prisma.$queryRaw<any[]>`
            SELECT "activeProfileId" FROM "AiAgentConfig" WHERE id = 'singleton' LIMIT 1
        `
        return rows[0]?.activeProfileId ?? null
    } catch { return null }
}

export async function createAiProfile(data: {
    name: string
    description?: string
    promptRole?: string
    promptTone?: string
    promptAllowed?: string
    promptForbidden?: string
}) {
    await assertCanEditAi()
    if (!data.name?.trim()) throw new Error('Имя профиля обязательно')
    // sortOrder = max+1 — новые профили идут в конец
    const maxRow = await prisma.$queryRaw<any[]>`
        SELECT COALESCE(MAX("sortOrder"), -1) AS max FROM "AiAgentProfile"
    `
    const sortOrder = Number(maxRow[0]?.max ?? -1) + 1
    const row = await prisma.aiAgentProfile.create({
        data: {
            name: data.name.trim(),
            description: data.description?.trim() || null,
            promptRole: data.promptRole?.trim() || null,
            promptTone: data.promptTone?.trim() || null,
            promptAllowed: data.promptAllowed?.trim() || null,
            promptForbidden: data.promptForbidden?.trim() || null,
            isDefault: false,
            sortOrder,
        },
    })
    revalidatePath('/settings/ai')
    return row
}

export async function updateAiProfile(id: string, data: Partial<{
    name: string
    description: string | null
    promptRole: string | null
    promptTone: string | null
    promptAllowed: string | null
    promptForbidden: string | null
}>) {
    await assertCanEditAi()
    if (data.name !== undefined && !data.name.trim()) {
        throw new Error('Имя профиля обязательно')
    }
    const patch: Record<string, any> = {}
    if (data.name !== undefined)            patch.name = data.name.trim()
    if (data.description !== undefined)     patch.description = data.description?.trim() || null
    if (data.promptRole !== undefined)      patch.promptRole = data.promptRole?.trim() || null
    if (data.promptTone !== undefined)      patch.promptTone = data.promptTone?.trim() || null
    if (data.promptAllowed !== undefined)   patch.promptAllowed = data.promptAllowed?.trim() || null
    if (data.promptForbidden !== undefined) patch.promptForbidden = data.promptForbidden?.trim() || null
    const row = await prisma.aiAgentProfile.update({ where: { id }, data: patch })
    revalidatePath('/settings/ai')
    return row
}

export async function deleteAiProfile(id: string) {
    await assertCanEditAi()
    // Защита: дефолтные профили (seed) удалять нельзя — иначе админ
    // может случайно остаться без активного при пустой таблице.
    const profile = await prisma.aiAgentProfile.findUnique({ where: { id } })
    if (!profile) throw new Error('Профиль не найден')
    if (profile.isDefault) {
        throw new Error('Системный профиль удалить нельзя. Создайте свой или измените существующий.')
    }
    // ON DELETE SET NULL в schema снимет activeProfileId, runtime
    // вернётся на legacy-поля config'а.
    await prisma.aiAgentProfile.delete({ where: { id } })
    revalidatePath('/settings/ai')
}

export async function setActiveAiProfile(id: string | null) {
    await assertCanEditAi()
    if (id) {
        const exists = await prisma.aiAgentProfile.findUnique({ where: { id }, select: { id: true } })
        if (!exists) throw new Error('Профиль не найден')
    }
    // Используем upsert чтобы не упасть, если AiAgentConfig.singleton
    // ещё не создан (свежий деплой без seed'а).
    await prisma.aiAgentConfig.upsert({
        where: { id: 'singleton' },
        update: { activeProfileId: id },
        create: { id: 'singleton', activeProfileId: id, activeChannels: [] },
    })
    revalidatePath('/settings/ai')
}

// ─── AI Knowledge Core (PR1: read-only) ──────────────────────────
//
// Server actions поверх lib/ai/knowledge/queries.ts. В PR1 — только
// чтения. write/edit/extraction появятся в PR2+.
//
// 'use server' file directive требует все экспорты как async-функции,
// поэтому используем inline wrappers, а не re-export.

import * as knowledgeQueries from '@/lib/ai/knowledge/queries'
export type {
    KnowledgeSection,
    KnowledgeItem,
    KnowledgeSource,
    KnowledgeStats,
} from '@/lib/ai/knowledge/queries'

export async function listKnowledgeSections() {
    return knowledgeQueries.listKnowledgeSections()
}

export async function listItemsBySection(sectionId: string, opts?: { includeArchived?: boolean }) {
    return knowledgeQueries.listItemsBySection(sectionId, opts ?? {})
}

export async function getItemWithSources(itemId: string) {
    return knowledgeQueries.getItemWithSources(itemId)
}

export async function getKnowledgeStats() {
    return knowledgeQueries.getKnowledgeStats()
}

export async function listExtractionJobs(limit?: number) {
    return knowledgeQueries.listExtractionJobs(limit ?? 10)
}
