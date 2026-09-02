/* eslint-disable @typescript-eslint/no-explicit-any -- file uses Prisma
   $queryRaw which returns any[]; pragmatic over strict here. */
'use server'

import { cookies } from 'next/headers'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getAiAgentProviderConfigV1 } from '@/modules/calling/public/v1/ai-agent-provider-capability'
import { listUserIdentitiesV1 as getUsers } from '@/modules/identity-access/public/v1/user-directory'
import {
    ARCHIVE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
    ARCHIVE_KNOWLEDGE_CONFLICT_MEMBER_COMMAND_V1,
    ARCHIVE_KNOWLEDGE_ITEM_AFTER_SOURCE_DISABLE_COMMAND_V1,
    ARCHIVE_KNOWLEDGE_ITEM_FOR_CORE_RESET_COMMAND_V1,
    ATTACH_MANUAL_KNOWLEDGE_SOURCE_COMMAND_V1,
    CLEAR_KNOWLEDGE_CONFLICT_GROUP_COMMAND_V1,
    CLEAR_KNOWLEDGE_CONFLICT_WINNER_COMMAND_V1,
    CREATE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1,
    CREATE_MANUAL_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
    DELETE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1,
    DISABLE_KNOWLEDGE_SOURCES_COMMAND_V1,
    EDIT_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
    MARK_KNOWLEDGE_ITEM_SOURCES_DISABLED_COMMAND_V1,
    QUEUE_KNOWLEDGE_EXTRACTION_COMMAND_V1,
    RESTORE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
    REVIEW_AI_DECISION_COMMAND_V1,
    SUPERSEDE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
    UNVERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
    UPDATE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1,
    UPDATE_RETRIEVAL_POLICY_COMMAND_V1,
    VERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
    type KnowledgeGovernanceEditPatchV1,
} from '@/contracts/ai-knowledge/v1'
import {
    archiveGovernanceKnowledgeItemV1,
    archiveKnowledgeConflictMemberV1,
    archiveKnowledgeItemAfterSourceDisableV1,
    archiveKnowledgeItemForCoreResetV1,
    attachManualKnowledgeSourceV1,
    clearKnowledgeConflictGroupV1,
    clearKnowledgeConflictWinnerV1,
    createLegacyKnowledgeEntryV1,
    createManualGovernanceKnowledgeItemV1,
    deleteLegacyKnowledgeEntryV1,
    disableKnowledgeSourcesV1,
    editGovernanceKnowledgeItemV1,
    markKnowledgeItemSourcesDisabledV1,
    queueKnowledgeExtractionV1,
    restoreGovernanceKnowledgeItemV1,
    reviewAiDecisionV1,
    supersedeGovernanceKnowledgeItemV1,
    unverifyGovernanceKnowledgeItemV1,
    updateLegacyKnowledgeEntryV1,
    updateRetrievalPolicyV1,
    verifyGovernanceKnowledgeItemV1,
} from '@/modules/ai-knowledge/public/v1'
import {
    CREATE_AI_AGENT_PROFILE_COMMAND_V1,
    DELETE_AI_AGENT_PROFILE_COMMAND_V1,
    RECORD_SAVED_AI_CONNECTION_SUCCESS_COMMAND_V1,
    SAVE_AI_AGENT_CONFIG_COMMAND_V1,
    SAVE_EXTRACTION_QUALITY_TIER_COMMAND_V1,
    SET_ACTIVE_AI_PROFILE_COMMAND_V1,
    UPDATE_AI_AGENT_PROFILE_COMMAND_V1,
} from '@/contracts/calling/v1'
import {
    captureAiAgentProviderCredentialV1,
    createAiAgentProfileV1,
    deleteAiAgentProfileV1,
    recordSavedAiConnectionSuccessV1,
    saveAiAgentConfigV1,
    saveExtractionQualityTierV1,
    setActiveAiProfileV1,
    updateAiAgentProfileV1,
} from '@/modules/calling/public/v1'
import { projectAiAgentConfigMetadata } from '@/modules/calling/public/v1/ai-agent-config-public-metadata'
import { requireIntegrationAdminAccess } from '@/modules/identity-access/public/v1'
import {
    cancelImportJob as cancelOwnedImportJob,
    createImportJob as createOwnedImportJob,
    deleteImportJob as deleteOwnedImportJob,
    getAllImportJobs as getOwnedImportJobs,
    getConnectionTotalsForUi as getOwnedConnectionTotalsForUi,
    getLastImportJob as getOwnedLastImportJob,
    type ConnectionTotalsForUi,
} from '@/modules/messaging/public/v1'
export type { ConnectionTotalsForUi } from '@/modules/messaging/public/v1'

// ─── Role guard ───────────────────────────────────────────────────
//
// UI hides configuration controls from managers, but server actions remain
// directly callable. crm_user_id is an unsigned identity selector, so the
// mutation boundary uses the independently authenticated integration-admin
// session backed by the provisioned ADMIN_USER / ADMIN_PASS capability.
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
    // crm_user_id is an unsigned UI identity selector and cannot authorize
    // credential/configuration changes. Require possession of the project
    // administrator credential through the signed HttpOnly session instead.
    await requireIntegrationAdminAccess()
}

// ─── AiAgentConfig ────────────────────────────────────────────────

export async function getAiConfig() {
    await requireIntegrationAdminAccess()
    try {
        const cfg = await getAiAgentProviderConfigV1()
        // activeChannels — String[] без DB-default. Частичный первый INSERT в
        // saveAiConfig мог оставить колонку NULL, и клиент падал на
        // config.activeChannels.map(...) → "Cannot read properties of null
        // (reading 'map')" (вся страница /settings/ai = client-side exception).
        // Коалесцируем к [] здесь — защищает всех consumer'ов разом.
        if (!cfg) return null
        return projectAiAgentConfigMetadata({
            ...cfg,
            activeChannels: cfg.activeChannels ?? [],
            lastConnectionCheckAt: cfg.lastConnectionCheckAt?.toISOString() ?? null,
            createdAt: cfg.createdAt.toISOString(),
            updatedAt: cfg.updatedAt.toISOString(),
        })
    } catch { return null }
}

export async function saveAiConfig(data: Record<string, any>) {
    await assertCanEditAi()
    const fields = Object.keys(data)
    if (fields.length === 0) return null
    const includesProviderCredential = fields.includes('providerCredential')
    try {
        const entries: Array<{ field: string; value: unknown }> = []
        const safeResult: Record<string, any> = {}
        for (const field of fields) {
            if (field === 'providerCredential') {
                entries.push({
                    field: 'providerCredential',
                    value: data[field] === null
                        ? null
                        : captureAiAgentProviderCredentialV1(data[field]),
                })
            } else if (field === 'apiKeyEncrypted') {
                // Persistence field names are not part of the browser-facing API.
                entries.push({ field: '__unsupported_provider_credential__', value: null })
            } else {
                entries.push({ field, value: data[field] })
                safeResult[field] = data[field]
            }
        }
        await saveAiAgentConfigV1({ contract: SAVE_AI_AGENT_CONFIG_COMMAND_V1, entries })
        revalidatePath('/settings/ai')
        return { id: 'singleton', ...safeResult }
    } catch (e: any) {
        // Credential-bearing persistence failures are deliberately generic:
        // provider values never enter logs, action results or propagated errors.
        const detail = includesProviderCredential
            ? 'ошибка сохранения учётных данных'
            : e?.message ?? 'unknown error'
        console.error('[AI Config] saveAiConfig error:', detail)
        throw new Error(`Не удалось сохранить настройки AI: ${detail}`)
    }
}

/** PR9.19: проверить сохранённый ключ из БД без необходимости вводить
 *  его в input. Используется на mount ProviderTab чтобы карточка
 *  сразу подсветилась реальным статусом. Не возвращает сам key —
 *  только ok/error. Persistуется connectionStatus в БД. */
export async function testSavedConnection() {
    await assertCanEditAi()
    try {
        const cfg = await getAiAgentProviderConfigV1()
        if (!cfg?.apiKeyEncrypted) {
            return { ok: false, error: 'Ключ не сохранён в БД' }
        }
        const result = await testAiConnection(
            cfg.provider,
            cfg.apiKeyEncrypted,
            cfg.classificationModel ?? 'claude-haiku-4-5',
        )
        // PR9.20: persist в БД только при УСПЕХЕ. Если auto-test
        // упал (network glitch, прокси отвалился, rate limit) —
        // не перетираем сохранённый ok-статус. Иначе один временный
        // сбой убивает «ключ работает» из БД, и user после reload
        // снова видит «нужна проверка».
        if (result.ok) {
            try {
                await recordSavedAiConnectionSuccessV1({
                    contract: RECORD_SAVED_AI_CONNECTION_SUCCESS_COMMAND_V1,
                })
            } catch { /* silent */ }
        }
        return result
    } catch (e: any) {
        return { ok: false, error: e?.message ?? 'unknown' }
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
    await createLegacyKnowledgeEntryV1({ contract: CREATE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1, entryId: id, data })
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
    await updateLegacyKnowledgeEntryV1({ contract: UPDATE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1, entryId: id, patch: data })
    revalidatePath('/settings/ai')
}

export async function deleteKnowledgeEntry(id: string) {
    await assertCanEditAi()
    await deleteLegacyKnowledgeEntryV1({ contract: DELETE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1, entryId: id })
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
        await reviewAiDecisionV1({ contract: REVIEW_AI_DECISION_COMMAND_V1, logId, verdict })
        revalidatePath('/settings/ai')
    } catch { /* ignore */ }
}

// ─── HistoryImportJob ─────────────────────────────────────────────

export async function getLastImportJob() {
    return getOwnedLastImportJob()
}

export async function getAllImportJobs(limit = 10) {
    return getOwnedImportJobs(limit)
}

export async function createImportJob(data: {
    channels: string[]
    mode: 'from_connection_time' | 'available_history' | 'last_n_days'
    daysBack?: number
    connectionId?: string
}) {
    return createOwnedImportJob(data)
}

export async function cancelImportJob(id: string) {
    return cancelOwnedImportJob(id)
}

export async function deleteImportJob(id: string) {
    return deleteOwnedImportJob(id)
}

// ─── Preflight: проверка доступности скрапера ────────────────────

export async function checkScraperHealth(channels: string[]): Promise<
    Record<string, { ok: boolean; status?: string; error?: string }>
> {
    const results: Record<string, { ok: boolean; status?: string; error?: string }> = {}

    if (channels.includes('max')) {
        // PR9.4: сначала HTTP health, потом DB-fallback. Раньше любой
        // network timeout/ECONNREFUSED блокировал импорт жёстко, даже
        // если MAX scraper фактически работает (просто /health дёрнули
        // в момент когда puppeteer был занят). Теперь — fallback на БД:
        // если за последний час пришло хотя бы 1 MAX-сообщение, scraper
        // живой.
        let httpOk = false
        let httpStatus: string | undefined
        let httpError: string | undefined
        try {
            const scraperUrl = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'
            const res = await fetch(`${scraperUrl}/health`, {
                signal: AbortSignal.timeout(3000),
                cache:  'no-store',
            })
            if (res.ok) {
                const data = await res.json()
                httpOk = !!data.isReady
                httpStatus = data.status
                if (!httpOk) httpError = `статус ${data.status}`
            } else {
                httpError = `HTTP ${res.status}`
            }
        } catch {
            httpError = 'health endpoint не отвечает'
        }
        if (httpOk) {
            results.max = { ok: true, status: httpStatus }
        } else {
            // DB-fallback: есть ли MAX-сообщения за последний час?
            try {
                const fresh = await prisma.$queryRaw<Array<{ n: number }>>`
                    SELECT COUNT(*)::int AS n
                    FROM "Message"
                    WHERE channel::text = 'max'
                      AND "sentAt" >= NOW() - INTERVAL '1 hour'
                `
                const liveCount = Number(fresh[0]?.n ?? 0)
                if (liveCount > 0) {
                    results.max = {
                        ok: true,
                        status: 'db_active',
                        error: `health endpoint молчит, но за час пришло ${liveCount} сообщ. — пропускаем`,
                    }
                } else {
                    // Ни health, ни свежих сообщений — настоящая проблема.
                    results.max = { ok: false, error: httpError || 'Недоступен' }
                }
            } catch {
                results.max = { ok: false, error: httpError || 'Недоступен' }
            }
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
    const result = await createAiAgentProfileV1({
        contract: CREATE_AI_AGENT_PROFILE_COMMAND_V1,
        profile: {
            name: data.name.trim(),
            description: data.description?.trim() || null,
            promptRole: data.promptRole?.trim() || null,
            promptTone: data.promptTone?.trim() || null,
            promptAllowed: data.promptAllowed?.trim() || null,
            promptForbidden: data.promptForbidden?.trim() || null,
        },
    })
    revalidatePath('/settings/ai')
    return result.profile
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
    const result = await updateAiAgentProfileV1({ contract: UPDATE_AI_AGENT_PROFILE_COMMAND_V1, profileId: id, patch })
    revalidatePath('/settings/ai')
    return result.profile
}

export async function deleteAiProfile(id: string) {
    await assertCanEditAi()
    // Защита: дефолтные профили (seed) удалять нельзя — иначе админ
    // может случайно остаться без активного при пустой таблице.
    // ON DELETE SET NULL в schema снимет activeProfileId, runtime
    // вернётся на legacy-поля config'а.
    await deleteAiAgentProfileV1({ contract: DELETE_AI_AGENT_PROFILE_COMMAND_V1, profileId: id })
    revalidatePath('/settings/ai')
}

export async function setActiveAiProfile(id: string | null) {
    await assertCanEditAi()
    await setActiveAiProfileV1({ contract: SET_ACTIVE_AI_PROFILE_COMMAND_V1, profileId: id })
    revalidatePath('/settings/ai')
}

// ─── AI Knowledge Core (PR1: read-only) ──────────────────────────
//
// Server actions поверх lib/ai/knowledge/queries.ts. В PR1 — только
// чтения. write/edit/extraction появятся в PR2+.
//
// 'use server' file directive требует все экспорты как async-функции,
// поэтому используем inline wrappers, а не re-export.

import {
    getKnowledgeItemForControlCenterV1,
    getKnowledgeItemSourceBadgesV1,
    getKnowledgeStatsV1,
    listKnowledgeExtractionJobsV1,
    listKnowledgeItemsBySectionV1,
    listKnowledgeSectionsV1,
    type KnowledgeItemSourceBadgesV1,
} from '@/modules/ai-knowledge/public/v1/knowledge-admin-read-model'
export type {
    KnowledgeSectionV1 as KnowledgeSection,
    KnowledgeItemV1 as KnowledgeItem,
    KnowledgeSourceV1 as KnowledgeSource,
    KnowledgeStatsV1 as KnowledgeStats,
    KnowledgeItemSourceBadgesV1 as ItemSourceBadges,
    KnowledgeItemSourceBadgeRowV1 as ItemSourceBadgeRow,
} from '@/modules/ai-knowledge/public/v1/knowledge-admin-read-model'

export async function listKnowledgeSections() {
    return listKnowledgeSectionsV1()
}

export async function listItemsBySection(sectionId: string, opts?: { includeArchived?: boolean }) {
    return listKnowledgeItemsBySectionV1(sectionId, opts ?? {})
}

/** PR7.12: batch source badges для compact preview на карточке item.
 *  «Откуда взято» одной строкой. Read-only, без permission-фильтра —
 *  возвращает только агрегаты count'ов и connectionId, без PII excerpt. */
export async function getItemSourceBadges(itemIds: string[]) {
    if (itemIds.length === 0) {
        return {} as Record<string, KnowledgeItemSourceBadgesV1>
    }
    const map = await getKnowledgeItemSourceBadgesV1(itemIds)
    // Server actions сериализуют только plain объекты, не Map.
    const out: Record<string, KnowledgeItemSourceBadgesV1> = {}
    for (const [k, v] of map.entries()) out[k] = v
    return out
}

// getItemWithSources объявлен ниже (PR2.5) с permission-фильтром sources.

export async function getKnowledgeStats() {
    return getKnowledgeStatsV1()
}

export async function listExtractionJobs(limit?: number) {
    return listKnowledgeExtractionJobsV1(limit ?? 10)
}

// ─── AI Knowledge Core — PR2 extraction actions ──────────────────
//
// Permission split:
//   - listKnowledgeSections / listItemsBySection / getKnowledgeStats /
//     listExtractionJobs / getExtractionJob — все роли (read-only)
//   - getItemWithSources — sources только для Admin/Lead (PII risk)
//   - startKnowledgeExtraction / saveExtractionQualityTier —
//     только Admin/Lead (тратит LLM-токены)

import {
    runQueuedKnowledgeExtractionV1 as runExtraction,
    type KnowledgeExtractionScopeV1 as ExtractionScope,
} from '@/modules/ai-knowledge/public/v1/knowledge-extraction-execution'
export type {
    KnowledgeExtractionScopeV1 as ExtractionScope,
} from '@/modules/ai-knowledge/public/v1/knowledge-extraction-execution'

/** Может ли текущий пользователь видеть source excerpts (PII risk).
 *  Совпадает с assertCanEditAi, но возвращает boolean без throw —
 *  для тихой фильтрации sources, не для отказа в action. */
async function canViewKnowledgeSources(): Promise<boolean> {
    const cookieStore = await cookies()
    const id = cookieStore.get('crm_user_id')?.value
    if (!id) return false
    const users = await getUsers()
    const user = users.find(u => u.id === id)
    if (!user) return false
    return user.role === 'Администратор' || user.role === 'Руководитель'
}

/** Полная карточка item с источниками. Sources возвращаются ТОЛЬКО
 *  Админу/Руководителю (PII risk). Manager получает sources=[]. */
export async function getItemWithSources(itemId: string) {
    const allowed = await canViewKnowledgeSources()
    return getKnowledgeItemForControlCenterV1(itemId, {
        includeSourceExcerpts: allowed,
    })
}

/** Создаёт AiExtractionJob + fire-and-forget runExtraction.
 *  Возвращает свежесозданный job для немедленного показа в UI до
 *  первого polling-цикла. */
export async function startKnowledgeExtraction(
    scope: ExtractionScope,
    qualityTier: 'economy' | 'balanced' | 'quality' = 'balanced',
): Promise<{ id: string; status: string; createdAt: string }> {
    await assertCanEditAi()
    const id = 'kbj_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
    const scopeJson = JSON.stringify(scope ?? { mode: 'last_90d' })

    await queueKnowledgeExtractionV1({ contract: QUEUE_KNOWLEDGE_EXTRACTION_COMMAND_V1, jobId: id, scopeJson, qualityTier })
    revalidatePath('/settings/ai')

    // Fire-and-forget. Errors логируются внутри runExtraction.
    runExtraction(id).catch(e => {
        console.error('[ai-knowledge] runExtraction crashed:', e?.message)
    })

    return {
        id,
        status: 'queued',
        createdAt: new Date().toISOString(),
    }
}

/** Polling-эндпоинт для прогресса. */
export async function getExtractionJob(id: string) {
    try {
        const rows = await prisma.$queryRaw<any[]>`
            SELECT
                id, status::text AS status,
                "sourceType"::text AS "sourceType",
                scope, progress,
                "extractionProvider", "extractionModel",
                "extractionPromptVersion", "extractionQualityTier",
                "startedAt", "finishedAt", "errorMessage", "createdAt"
            FROM "AiExtractionJob"
            WHERE id = ${id} LIMIT 1
        `
        return rows[0] ?? null
    } catch {
        return null
    }
}

/** Сохраняет выбранный пресет качества (singleton config). */
export async function saveExtractionQualityTier(
    tier: 'economy' | 'balanced' | 'quality',
): Promise<void> {
    await assertCanEditAi()
    if (!['economy', 'balanced', 'quality'].includes(tier)) {
        throw new Error('Недопустимый tier')
    }
    await saveExtractionQualityTierV1({
        contract: SAVE_EXTRACTION_QUALITY_TIER_COMMAND_V1,
        tier,
    })
    revalidatePath('/settings/ai')
}

/** Текущий tier (для предзаполнения UI-селектора). */
export async function getExtractionQualityTier(): Promise<'economy' | 'balanced' | 'quality'> {
    try {
        const rows = await prisma.$queryRaw<any[]>`
            SELECT "extractionQualityTier"
            FROM "AiAgentConfig"
            WHERE id = 'singleton'
            LIMIT 1
        `
        const t = rows[0]?.extractionQualityTier
        if (t === 'economy' || t === 'balanced' || t === 'quality') return t
        return 'balanced'
    } catch {
        return 'balanced'
    }
}

// ─── AI Knowledge Core governance (PR2.5) ────────────────────────
//
// Edit/archive/restore/verify/supersede/resolve-conflict/manual-create
// + audit trail. Все mutation-actions требуют Admin/Lead роли
// (assertCanEditAi), читают userId для audit.actor и пишут before/after
// JSON snapshots в AiKnowledgeAuditLog. Soft-delete only.

import {
    appendKnowledgeGovernanceAuditV1 as writeAuditEntry,
    snapshotKnowledgeGovernanceItemV1 as snapshotItem,
    listKnowledgeGovernanceAuditV1 as getAuditLogRaw,
} from '@/modules/ai-knowledge/public/v1/knowledge-governance-audit'

/**
 * Возвращает userId текущего пользователя если он Admin/Lead, иначе
 * throws. Используется в governance-actions: assertCanEditAi проверяет
 * роль, но не возвращает id; здесь нужен id для audit.actor.
 */
async function requireAdminUserId(): Promise<string> {
    const cookieStore = await cookies()
    const id = cookieStore.get('crm_user_id')?.value
    if (!id) throw new Error('Недостаточно прав')
    const users = await getUsers()
    const user = users.find(u => u.id === id)
    if (!user) throw new Error('Недостаточно прав')
    if (user.role !== 'Администратор' && user.role !== 'Руководитель') {
        throw new Error('Недостаточно прав')
    }
    return user.id
}

async function loadItemForEdit(id: string): Promise<any | null> {
    const rows = await prisma.$queryRaw<any[]>`
        SELECT
            id, "sectionId", title, "canonicalStatement", tags,
            confidence, "sourceCount", "uniqueManagerCount",
            status::text AS status, "isActive",
            "safetyLevel"::text AS "safetyLevel",
            "supersededByItemId", "conflictGroupId",
            "isVerified", "verifiedBy", "verifiedAt"
        FROM "AiKnowledgeItem"
        WHERE id = ${id}
        LIMIT 1
    `
    return rows[0] ?? null
}

interface EditItemPatch {
    title?:              string
    canonicalStatement?: string
    tags?:               string[]
    safetyLevel?:        'normal' | 'sensitive' | 'requires_human'
}

/**
 * Редактирует поля item'а. Частичный patch: меняется только то, что
 * явно передано. Audit с before/after + metadata.changedFields.
 */
export async function editKnowledgeItem(id: string, patch: EditItemPatch): Promise<void> {
    const actor = await requireAdminUserId()
    const before = await loadItemForEdit(id)
    if (!before) throw new Error('Знание не найдено')

    const normalizedPatch: KnowledgeGovernanceEditPatchV1 = {}
    if (patch.title !== undefined) {
        if (!patch.title.trim()) throw new Error('Заголовок не может быть пустым')
        normalizedPatch.title = patch.title.trim()
    }
    if (patch.canonicalStatement !== undefined) {
        if (!patch.canonicalStatement.trim()) throw new Error('Формулировка не может быть пустой')
        normalizedPatch.canonicalStatement = patch.canonicalStatement.trim()
    }
    if (patch.tags !== undefined) {
        normalizedPatch.tags = patch.tags
    }
    if (patch.safetyLevel !== undefined) {
        if (!['normal', 'sensitive', 'requires_human'].includes(patch.safetyLevel)) {
            throw new Error('Недопустимый safetyLevel')
        }
        normalizedPatch.safetyLevel = patch.safetyLevel
    }
    if (Object.keys(normalizedPatch).length === 0) return

    await editGovernanceKnowledgeItemV1({
        contract: EDIT_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
        itemId: id,
        patch: normalizedPatch,
    })

    const after = await loadItemForEdit(id)
    const changedFields = Object.keys(patch).filter(k => (patch as any)[k] !== undefined)
    await writeAuditEntry({
        itemId: id, actor, action: 'edited',
        before: snapshotItem(before), after: snapshotItem(after),
        metadata: { changedFields },
    })
    revalidatePath('/settings/ai')
}

/** Soft delete: status='archived' + isActive=false. Sources сохраняются. */
export async function archiveKnowledgeItem(id: string): Promise<void> {
    const actor = await requireAdminUserId()
    const before = await loadItemForEdit(id)
    if (!before) throw new Error('Знание не найдено')
    if (before.status === 'archived') return

    await archiveGovernanceKnowledgeItemV1({
        contract: ARCHIVE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
        itemId: id,
    })
    const after = await loadItemForEdit(id)
    await writeAuditEntry({
        itemId: id, actor, action: 'archived',
        before: snapshotItem(before), after: snapshotItem(after),
    })
    revalidatePath('/settings/ai')
}

/** Восстановление из архива. Запрещено для superseded. */
export async function restoreKnowledgeItem(id: string): Promise<void> {
    const actor = await requireAdminUserId()
    const before = await loadItemForEdit(id)
    if (!before) throw new Error('Знание не найдено')
    if (before.status === 'active' && before.isActive) return
    if (before.status === 'superseded') {
        throw new Error('Знание заменено новым. Сначала уберите ссылку supersededByItemId.')
    }

    await restoreGovernanceKnowledgeItemV1({
        contract: RESTORE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
        itemId: id,
    })
    const after = await loadItemForEdit(id)
    await writeAuditEntry({
        itemId: id, actor, action: 'restored',
        before: snapshotItem(before), after: snapshotItem(after),
    })
    revalidatePath('/settings/ai')
}

/** Verify / un-verify. */
export async function verifyKnowledgeItem(id: string, verified: boolean): Promise<void> {
    const actor = await requireAdminUserId()
    const before = await loadItemForEdit(id)
    if (!before) throw new Error('Знание не найдено')
    if (before.isVerified === verified) return

    if (verified) {
        await verifyGovernanceKnowledgeItemV1({
            contract: VERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
            itemId: id,
            actorId: actor,
        })
    } else {
        await unverifyGovernanceKnowledgeItemV1({
            contract: UNVERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
            itemId: id,
        })
    }

    const after = await loadItemForEdit(id)
    await writeAuditEntry({
        itemId: id, actor, action: verified ? 'verified' : 'unverified',
        before: snapshotItem(before), after: snapshotItem(after),
    })
    revalidatePath('/settings/ai')
}

/** Audit history по item для UI. */
export async function getKnowledgeAuditLog(itemId: string, limit?: number) {
    return getAuditLogRaw(itemId, limit ?? 50)
}

/**
 * Помечает oldItem как заменённый newItem'ом (temporal replacement,
 * не конфликт). Валидация: same section, no cycles, no self.
 */
export async function supersedeKnowledgeItem(
    oldItemId: string,
    newItemId: string,
): Promise<void> {
    const actor = await requireAdminUserId()
    if (oldItemId === newItemId) throw new Error('Нельзя заменить знание самим собой')

    const oldBefore = await loadItemForEdit(oldItemId)
    const newBefore = await loadItemForEdit(newItemId)
    if (!oldBefore) throw new Error('Старое знание не найдено')
    if (!newBefore) throw new Error('Новое знание не найдено')
    if (oldBefore.sectionId !== newBefore.sectionId) {
        throw new Error('Замена работает только внутри одной секции')
    }
    if (newBefore.status === 'superseded') {
        throw new Error('Новое знание само заменено более новым')
    }
    if (newBefore.supersededByItemId === oldItemId) {
        throw new Error('Цикл замены: эти знания уже ссылаются друг на друга')
    }

    await supersedeGovernanceKnowledgeItemV1({
        contract: SUPERSEDE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
        oldItemId,
        newItemId,
    })

    const oldAfter = await loadItemForEdit(oldItemId)
    await writeAuditEntry({
        itemId: oldItemId, actor, action: 'superseded',
        before: snapshotItem(oldBefore), after: snapshotItem(oldAfter),
        metadata: { supersededBy: newItemId },
    })
    await writeAuditEntry({
        itemId: newItemId, actor, action: 'superseded',
        before: null, after: null,
        metadata: { supersedes: oldItemId, role: 'replacement' },
    })
    revalidatePath('/settings/ai')
}

export type ConflictResolveAction = 'keep_this_archive_others' | 'unmark_all'

/** Разрешение конфликта. Auto-resolve запрещён. */
export async function resolveConflict(
    itemId: string,
    action: ConflictResolveAction,
): Promise<void> {
    const actor = await requireAdminUserId()
    const before = await loadItemForEdit(itemId)
    if (!before) throw new Error('Знание не найдено')
    const groupId = before.conflictGroupId
    if (!groupId) throw new Error('У этого знания нет конфликта')

    const members = await prisma.$queryRaw<any[]>`
        SELECT
            id, "sectionId", title, "canonicalStatement", tags,
            confidence, "sourceCount", "uniqueManagerCount",
            status::text AS status, "isActive",
            "safetyLevel"::text AS "safetyLevel",
            "supersededByItemId", "conflictGroupId",
            "isVerified", "verifiedBy", "verifiedAt"
        FROM "AiKnowledgeItem"
        WHERE "conflictGroupId" = ${groupId}
    `

    if (action === 'keep_this_archive_others') {
        for (const m of members) {
            if (m.id === itemId) continue
            if (m.status === 'archived') continue
            const memberBefore = m
            await archiveKnowledgeConflictMemberV1({
                contract: ARCHIVE_KNOWLEDGE_CONFLICT_MEMBER_COMMAND_V1,
                itemId: m.id,
            })
            const memberAfter = await loadItemForEdit(m.id)
            await writeAuditEntry({
                itemId: m.id, actor, action: 'archived',
                before: snapshotItem(memberBefore), after: snapshotItem(memberAfter),
                metadata: { reason: 'conflict_resolved_keep_other', winnerItemId: itemId },
            })
        }
        await clearKnowledgeConflictWinnerV1({
            contract: CLEAR_KNOWLEDGE_CONFLICT_WINNER_COMMAND_V1,
            itemId,
        })
        const winnerAfter = await loadItemForEdit(itemId)
        await writeAuditEntry({
            itemId, actor, action: 'conflict_resolved',
            before: snapshotItem(before), after: snapshotItem(winnerAfter),
            metadata: { resolution: 'kept_this', archivedCount: members.length - 1 },
        })
    } else {
        // unmark_all
        await clearKnowledgeConflictGroupV1({
            contract: CLEAR_KNOWLEDGE_CONFLICT_GROUP_COMMAND_V1,
            conflictGroupId: groupId,
        })
        for (const m of members) {
            const after = await loadItemForEdit(m.id)
            await writeAuditEntry({
                itemId: m.id, actor, action: 'conflict_resolved',
                before: snapshotItem(m), after: snapshotItem(after),
                metadata: { resolution: 'unmark_all', formerGroupId: groupId },
            })
        }
    }
    revalidatePath('/settings/ai')
}

/**
 * Создание item админом вручную. Auto-verified, manual_entry source.
 */
export async function createManualKnowledgeItem(input: {
    sectionId:          string
    title:              string
    canonicalStatement: string
    tags?:              string[]
    safetyLevel?:       'normal' | 'sensitive' | 'requires_human'
}): Promise<{ itemId: string }> {
    const actor = await requireAdminUserId()
    if (!input.sectionId) throw new Error('Раздел обязателен')
    if (!input.title?.trim()) throw new Error('Заголовок обязателен')
    if (!input.canonicalStatement?.trim()) throw new Error('Формулировка обязательна')

    const sec = await prisma.$queryRaw<any[]>`
        SELECT id FROM "AiKnowledgeSection" WHERE id = ${input.sectionId} AND "isActive" = true LIMIT 1
    `
    if (!sec[0]) throw new Error('Раздел не найден или отключён')

    const safety = input.safetyLevel ?? 'normal'
    if (!['normal', 'sensitive', 'requires_human'].includes(safety)) {
        throw new Error('Недопустимый safetyLevel')
    }

    const itemId = 'kbi_m_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
    const tagSet = new Set<string>(input.tags ?? [])
    tagSet.add('type:manual')
    const tags = [...tagSet].filter(t => t.trim())

    await createManualGovernanceKnowledgeItemV1({
        contract: CREATE_MANUAL_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
        itemId,
        sectionId: input.sectionId,
        title: input.title.trim(),
        canonicalStatement: input.canonicalStatement.trim(),
        tags,
        safetyLevel: safety,
        actorId: actor,
    })
    const sourceId = 'kbs_m_' + Math.random().toString(36).slice(2, 12)
    await attachManualKnowledgeSourceV1({ contract: ATTACH_MANUAL_KNOWLEDGE_SOURCE_COMMAND_V1, sourceId, itemId, actorId: actor })

    const after = await loadItemForEdit(itemId)
    await writeAuditEntry({
        itemId, actor, action: 'manual_created',
        before: null, after: snapshotItem(after),
        metadata: { sectionId: input.sectionId },
    })
    revalidatePath('/settings/ai')
    return { itemId }
}

// ─── AI Knowledge Core retrieval policy (PR3.4) ──────────────────
//
// Singleton config из AiRetrievalPolicy + env-mirrored flags.
// Source-of-truth для shadow/runtime — env (см. featureFlags.ts).

import {
    getKnowledgeRuntimeModeV1 as getKnowledgeRuntimeMode,
    isKnowledgeRuntimeEnabledV1 as isRuntimeEnabled,
    isKnowledgeShadowModeEnabledV1 as isShadowModeEnabled,
} from '@/modules/ai-knowledge/public/v1/knowledge-operational-status'

export interface RetrievalPolicy {
    minConfidenceForReply:     number
    sensitiveConfidenceMargin: number
    minSourceCountForReply:    number
    verifiedScoreBoost:        number
    excludeArchived:           boolean
    excludeSuperseded:         boolean
    excludeDraft:              boolean
    conflictEscalates:         boolean
    maxStaleDays:              number | null
    rerankEnabled:             boolean
    rerankTopN:                number
    prefilterTopN:             number
    shadowMode:                boolean
    runtimeEnabled:            boolean
    policyVersion:             string
    updatedAt:                 string
    updatedBy:                 string | null
}

export async function getRetrievalPolicy(): Promise<RetrievalPolicy> {
    const fallback: RetrievalPolicy = {
        minConfidenceForReply:     0.7,
        sensitiveConfidenceMargin: 0.85,
        minSourceCountForReply:    1,
        verifiedScoreBoost:        0.2,
        excludeArchived:           true,
        excludeSuperseded:         true,
        excludeDraft:              true,
        conflictEscalates:         true,
        maxStaleDays:              null,
        rerankEnabled:             true,
        rerankTopN:                5,
        prefilterTopN:             20,
        shadowMode:                isShadowModeEnabled(),
        runtimeEnabled:            isRuntimeEnabled(),
        policyVersion:             'v1',
        updatedAt:                 new Date().toISOString(),
        updatedBy:                 null,
    }
    try {
        const rows = await prisma.$queryRaw<any[]>`
            SELECT
                "minConfidenceForReply", "sensitiveConfidenceMargin",
                "minSourceCountForReply", "verifiedScoreBoost",
                "excludeArchived", "excludeSuperseded", "excludeDraft",
                "conflictEscalates", "maxStaleDays",
                "rerankEnabled", "rerankTopN", "prefilterTopN",
                "policyVersion", "updatedAt", "updatedBy"
            FROM "AiRetrievalPolicy" WHERE id = 'singleton' LIMIT 1
        `
        if (!rows[0]) return fallback
        return {
            ...fallback,
            ...rows[0],
            // env wins over БД для shadow/runtime — это runtime truth.
            shadowMode:    isShadowModeEnabled(),
            runtimeEnabled: isRuntimeEnabled(),
        }
    } catch {
        return fallback
    }
}

export interface RetrievalPolicyPatch {
    minConfidenceForReply?:     number
    sensitiveConfidenceMargin?: number
    minSourceCountForReply?:    number
    verifiedScoreBoost?:        number
    excludeArchived?:           boolean
    excludeSuperseded?:         boolean
    excludeDraft?:              boolean
    conflictEscalates?:         boolean
    rerankEnabled?:             boolean
    rerankTopN?:                number
    prefilterTopN?:             number
}

/**
 * Patch thresholds policy. shadowMode/runtimeEnabled менять через UI
 * НЕЛЬЗЯ — они контролируются env.
 */
export async function saveRetrievalPolicy(patch: RetrievalPolicyPatch): Promise<void> {
    const actor = await requireAdminUserId()
    const result = await updateRetrievalPolicyV1({ contract: UPDATE_RETRIEVAL_POLICY_COMMAND_V1, actorId: actor, patch })
    if (!result.updated) return
    revalidatePath('/settings/ai')
}

/**
 * Recent retrieval traces для UI "Активность ответов". Берём
 * AiDecisionLog с retrievalMode != null.
 */
export async function listRecentRetrievalTraces(limit = 30): Promise<unknown[]> {
    try {
        return await prisma.$queryRaw<any[]>`
            SELECT
                id, "messageId", "chatId", channel,
                "retrievalMode", "retrievalDecision", "escalationReason",
                "knowledgeRuntimeVersion", "shadowRetrievalSummary",
                decision, "generatedReply",
                "createdAt"
            FROM "AiDecisionLog"
            WHERE "retrievalMode" IS NOT NULL
            ORDER BY "createdAt" DESC
            LIMIT ${limit}
        `
    } catch {
        return []
    }
}

/** Human-friendly runtime mode для UI шапки. */
export async function getKnowledgeRuntimeStateForUi(): Promise<{
    mode: 'legacy' | 'shadow' | 'runtime'
    shadowOn: boolean
    runtimeOn: boolean
}> {
    return {
        mode:     getKnowledgeRuntimeMode(),
        shadowOn:  isShadowModeEnabled(),
        runtimeOn: isRuntimeEnabled(),
    }
}

// ─── AI Knowledge Core explainability (PR4) ──────────────────────
//
// Read-only aggregator поверх traces из PR3. Permission filter:
// sources видны только Admin/Lead. Manager получает usages+items,
// но sources=[].

import {
    getKnowledgeDecisionExplainabilityV1,
    type KnowledgeExplainabilityBundleV1,
} from '@/modules/ai-knowledge/public/v1/knowledge-explainability-read-model'
import { previewKnowledgeRetrievalV1 } from '@/modules/ai-knowledge/public/v1/knowledge-retrieval'
export type {
    KnowledgeExplainabilityBundleV1 as ExplainabilityBundle,
    KnowledgeExplainDecisionRowV1 as ExplainDecisionRow,
    KnowledgeExplainMessageRowV1 as ExplainMessageRow,
    KnowledgeExplainUsageRowV1 as ExplainUsageRow,
    KnowledgeExplainSourceRowV1 as ExplainSourceRow,
    KnowledgeExplainAuditRowV1 as ExplainAuditRow,
} from '@/modules/ai-knowledge/public/v1/knowledge-explainability-read-model'

/**
 * Bundle для UI explainability модалки. Server-side фильтрует sources
 * для не-Admin ролей — PII не пересекает boundary. Manager видит
 * items без raw excerpts.
 */
export async function getDecisionExplainabilityForUi(
    decisionLogId: string,
): Promise<KnowledgeExplainabilityBundleV1> {
    const allowed = await canViewKnowledgeSources()
    return getKnowledgeDecisionExplainabilityV1(decisionLogId, {
        includeSourceExcerpts: allowed,
    })
}

export interface RetryPreviewResult {
    /** Что retriever нашёл сейчас (после возможных правок knowledge). */
    items: Array<{
        id:                 string
        title:              string
        canonicalStatement: string
        isVerified:         boolean
        sectionId:          string
    }>
    policyType:       'answer' | 'escalate' | 'no_knowledge'
    escalationReason: string | null
    /** Сгенерированный ответ (если policy='answer' и apiKey доступен). */
    generatedReply:   string | null
    /** Trace для UI compare с original + advanced/debug. */
    trace: {
        candidateCount:      number
        prefilterDurationMs: number
        rerankDurationMs:    number | null
        generatorDurationMs: number | null
        totalDurationMs:     number
        runtimeVersion:      string | null
        rerankUsedModel:     string | null
    }
    errorMessage: string | null
}

/**
 * Preview retry — Admin only. Прогоняет retrieve+generator на
 * оригинальном сообщении С ТЕКУЩИМИ знаниями, БЕЗ отправки клиенту
 * и БЕЗ записи в AiDecisionLog/UsageLog. Чисто диагностический вызов.
 *
 * Telemetry: console.log на start / phase / done — operational
 * visibility без persistence.
 */
export async function previewDecisionRetry(
    decisionLogId: string,
): Promise<RetryPreviewResult> {
    await requireAdminUserId()
    const startedAt = Date.now()
    console.log(`[retry-preview] started decisionLogId=${decisionLogId}`)

    const empty: RetryPreviewResult = {
        items: [],
        policyType: 'no_knowledge',
        escalationReason: 'no_relevant',
        generatedReply: null,
        trace: {
            candidateCount: 0, prefilterDurationMs: 0,
            rerankDurationMs: null, generatorDurationMs: null,
            totalDurationMs: 0, runtimeVersion: null, rerankUsedModel: null,
        },
        errorMessage: 'Decision не найден',
    }

    // 1. Original message
    const rows = await prisma.$queryRaw<any[]>`
        SELECT
            dl."messageId" AS "messageId",
            m.content      AS "userContent"
        FROM "AiDecisionLog" dl
        LEFT JOIN "Message" m ON m.id = dl."messageId"
        WHERE dl.id = ${decisionLogId} LIMIT 1
    `
    const row = rows[0]
    if (!row || !row.userContent) {
        console.warn(`[retry-preview] no user message for ${decisionLogId}`)
        return { ...empty, errorMessage: 'Не удалось загрузить вопрос клиента' }
    }

    // 2. Retrieve (force runtime semantics)
    let retrieveOut
    try {
        retrieveOut = await previewKnowledgeRetrievalV1({
            query: row.userContent,
        })
    } catch (e: any) {
        console.error(`[retry-preview] retrieve failed: ${e?.message}`)
        return { ...empty, errorMessage: 'Retrieve упал: ' + (e?.message ?? 'unknown') }
    }
    console.log(`[retry-preview] retrieve done in ${retrieveOut.trace.durationMs}ms · candidates=${retrieveOut.trace.candidates.length} · policy=${retrieveOut.trace.policy.type}`)

    const items = retrieveOut.items.map(i => ({
        id:                 i.id,
        title:              i.title,
        canonicalStatement: i.canonicalStatement,
        isVerified:         i.isVerified,
        sectionId:          i.sectionId,
    }))

    // 3. Если policy эскалировала — generator не вызываем
    if (retrieveOut.trace.policy.type !== 'answer') {
        const totalMs = Date.now() - startedAt
        console.log(`[retry-preview] escalated by policy: ${retrieveOut.trace.policy.escalationReason} · total ${totalMs}ms`)
        return {
            items,
            policyType:       retrieveOut.trace.policy.type,
            escalationReason: retrieveOut.trace.policy.escalationReason,
            generatedReply:   null,
            trace: {
                candidateCount:      retrieveOut.trace.candidates.length,
                prefilterDurationMs: retrieveOut.trace.prefilterDurationMs,
                rerankDurationMs:    retrieveOut.trace.rerankDurationMs,
                generatorDurationMs: null,
                totalDurationMs:     totalMs,
                runtimeVersion:      `rerank:${retrieveOut.trace.rerankPromptVersion} policy:${retrieveOut.trace.policyVersion}`,
                rerankUsedModel:     retrieveOut.trace.rerankUsedModel,
            },
            errorMessage:     null,
        }
    }

    // 4. Generator call
    const providerConfig = await getAiAgentProviderConfigV1()
    const cfg = providerConfig && {
        provider: providerConfig.provider,
        apiKey: providerConfig.apiKeyEncrypted,
        responseModel: providerConfig.responseModel,
        language: providerConfig.language,
        promptRole: providerConfig.promptRole,
        promptTone: providerConfig.promptTone,
        promptAllowed: providerConfig.promptAllowed,
        promptForbidden: providerConfig.promptForbidden,
        activeProfileId: providerConfig.activeProfileId,
    }
    if (!cfg?.apiKey) {
        const totalMs = Date.now() - startedAt
        console.warn(`[retry-preview] no API key configured · total ${totalMs}ms`)
        return {
            items, policyType: 'answer', escalationReason: null, generatedReply: null,
            trace: {
                candidateCount:      retrieveOut.trace.candidates.length,
                prefilterDurationMs: retrieveOut.trace.prefilterDurationMs,
                rerankDurationMs:    retrieveOut.trace.rerankDurationMs,
                generatorDurationMs: null,
                totalDurationMs:     totalMs,
                runtimeVersion:      `rerank:${retrieveOut.trace.rerankPromptVersion} policy:${retrieveOut.trace.policyVersion}`,
                rerankUsedModel:     retrieveOut.trace.rerankUsedModel,
            },
            errorMessage: 'AI provider не настроен (нет API key)',
        }
    }

    let role = cfg.promptRole, tone = cfg.promptTone,
        allowed = cfg.promptAllowed, forbidden = cfg.promptForbidden
    if (cfg.activeProfileId) {
        const p = await prisma.$queryRaw<any[]>`
            SELECT "promptRole", "promptTone", "promptAllowed", "promptForbidden"
            FROM "AiAgentProfile" WHERE id = ${cfg.activeProfileId} LIMIT 1
        `
        if (p[0]) {
            role     = p[0].promptRole     ?? role
            tone     = p[0].promptTone     ?? tone
            allowed  = p[0].promptAllowed  ?? allowed
            forbidden = p[0].promptForbidden ?? forbidden
        }
    }

    const parts: string[] = []
    parts.push(role || 'Ты — помощник службы поддержки водителей такси.')
    if (tone)      parts.push(`Тон общения: ${tone}.`)
    if (allowed)   parts.push(`Разрешено: ${allowed}.`)
    if (forbidden) parts.push(`Запрещено: ${forbidden}.`)
    parts.push(`Язык: ${cfg.language || 'ru'}. Отвечай кратко.`)
    parts.push(
        '\nИспользуй ТОЛЬКО следующие подтверждённые факты компании. ' +
        'Если фактов недостаточно — честно скажи, что передашь менеджеру.\n' +
        items.map((it, i) => `${i + 1}. ${it.title}${it.isVerified ? ' [подтверждено]' : ''}\n   ${it.canonicalStatement}`).join('\n'),
    )
    const systemPrompt = parts.join(' ')

    const generatorStart = Date.now()
    let generatorMs: number | null = null
    try {
        let reply: string | null = null
        if (cfg.provider === 'openai') {
            const res = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: cfg.responseModel || 'gpt-4o-mini',
                    max_tokens: 500, temperature: 0,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user',   content: row.userContent },
                    ],
                }),
            })
            generatorMs = Date.now() - generatorStart
            if (res.ok) {
                const data: any = await res.json()
                reply = data?.choices?.[0]?.message?.content ?? null
            }
        } else {
            const res = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
                body: JSON.stringify({
                    model: cfg.responseModel || 'claude-sonnet-4-5',
                    max_tokens: 500,
                    system: systemPrompt,
                    messages: [{ role: 'user', content: row.userContent }],
                }),
            })
            generatorMs = Date.now() - generatorStart
            if (res.ok) {
                const data: any = await res.json()
                reply = data?.content?.[0]?.text?.trim() ?? null
            }
        }
        const totalMs = Date.now() - startedAt
        console.log(`[retry-preview] generator ${generatorMs}ms · total ${totalMs}ms · reply=${reply ? 'yes' : 'no'}`)
        return {
            items,
            policyType: 'answer', escalationReason: null,
            generatedReply: reply,
            trace: {
                candidateCount:      retrieveOut.trace.candidates.length,
                prefilterDurationMs: retrieveOut.trace.prefilterDurationMs,
                rerankDurationMs:    retrieveOut.trace.rerankDurationMs,
                generatorDurationMs: generatorMs,
                totalDurationMs:     totalMs,
                runtimeVersion:      `rerank:${retrieveOut.trace.rerankPromptVersion} policy:${retrieveOut.trace.policyVersion}`,
                rerankUsedModel:     retrieveOut.trace.rerankUsedModel,
            },
            errorMessage: reply ? null : 'LLM не вернула текст',
        }
    } catch (e: any) {
        const totalMs = Date.now() - startedAt
        console.error(`[retry-preview] generator failed: ${e?.message} · total ${totalMs}ms`)
        return {
            items, policyType: 'answer', escalationReason: null, generatedReply: null,
            trace: {
                candidateCount:      retrieveOut.trace.candidates.length,
                prefilterDurationMs: retrieveOut.trace.prefilterDurationMs,
                rerankDurationMs:    retrieveOut.trace.rerankDurationMs,
                generatorDurationMs: generatorMs,
                totalDurationMs:     totalMs,
                runtimeVersion:      `rerank:${retrieveOut.trace.rerankPromptVersion} policy:${retrieveOut.trace.policyVersion}`,
                rerankUsedModel:     retrieveOut.trace.rerankUsedModel,
            },
            errorMessage: 'Generator упал: ' + (e?.message ?? 'unknown'),
        }
    }
}

// ─── AI Knowledge Core readiness (PR5) ──────────────────────────
//
// Operational state aggregator для readiness row + runtime warning
// модала. Read-only, без mutation, без PII. Доступно всем ролям —
// counts не несут чувствительных данных. Reuse logic в smoke.

import {
    getKnowledgeReadinessV1 as getKnowledgeReadiness,
} from '@/modules/ai-knowledge/public/v1/knowledge-operational-status'
export type {
    KnowledgeReadinessBundleV1 as KnowledgeReadinessBundle,
    KnowledgeReadinessCountsV1 as KnowledgeReadinessCounts,
    KnowledgeLastExtractionV1 as KnowledgeLastExtraction,
    KnowledgeActivity7dV1 as KnowledgeActivity7d,
    KnowledgeHealth7dV1 as KnowledgeHealth7d,
    KnowledgeReadinessCheckV1 as ReadinessCheck,
    KnowledgeReadinessCheckStatusV1 as ReadinessCheckStatus,
} from '@/modules/ai-knowledge/public/v1/knowledge-operational-status'

/** Bundle для readiness row в шапке и для runtime warning модала.
 *  Подтягивается на page.tsx загрузке + после операций governance
 *  (verify/archive/etc) для отражения нового состояния. */
export async function getKnowledgeReadinessForUi() {
    return getKnowledgeReadiness()
}

// ─── AI Knowledge Core legacy migration (PR5) ───────────────────
//
// Перенос ручной KnowledgeBaseEntry → AiKnowledgeItem. Legacy KB НЕ
// удаляется (reversible path). UI потом скрывает её под "Legacy".
// Controlled migration доступна только через узкую AI Knowledge capability;
// smoke может вызывать owner-controlled core без cookie-context.

import {
    previewKnowledgeLegacyMigrationV1 as getLegacyMigrationPreviewCore,
    executeKnowledgeLegacyMigrationV1 as migrateLegacyKnowledgeBaseCore,
} from '@/modules/ai-knowledge/public/v1/knowledge-legacy-migration'
export type {
    KnowledgeLegacyMigrationPreviewV1 as LegacyMigrationPreview,
    KnowledgeLegacyMigrationResultV1 as LegacyMigrationResult,
} from '@/modules/ai-knowledge/public/v1/knowledge-legacy-migration'

/** Preview без записи — для UI confirmation модала перед запуском. */
export async function getLegacyMigrationPreview() {
    await assertCanEditAi()
    return getLegacyMigrationPreviewCore()
}

// ─── AI Knowledge Core bulk governance (PR5) ────────────────────
//
// Массовые действия для админа: подтвердить все unverified в секции,
// архивировать все drafts. Каждое действие пишется в audit отдельной
// записью (через существующие single-item handlers), так что
// explainability остаётся точной — не "массовое" событие, а серия
// атомарных.

export interface BulkActionResult {
    processed: number
    skipped:   number
    failed:    number
    errors:    Array<{ itemId: string; message: string }>
}

/** Bulk verify — устанавливает isVerified=true для всех переданных
 *  itemId (если ещё не verified). Каждый item — отдельная audit-запись.
 *  Возвращает счётчики processed/skipped/failed. */
export async function bulkVerifyItems(itemIds: string[]): Promise<BulkActionResult> {
    await requireAdminUserId()
    const result: BulkActionResult = { processed: 0, skipped: 0, failed: 0, errors: [] }
    for (const id of itemIds) {
        try {
            const cur = await loadItemForEdit(id)
            if (!cur) { result.failed++; result.errors.push({ itemId: id, message: 'не найден' }); continue }
            if (cur.isVerified) { result.skipped++; continue }
            await verifyKnowledgeItem(id, true)
            result.processed++
        } catch (e: any) {
            result.failed++
            result.errors.push({ itemId: id, message: e?.message ?? 'unknown' })
        }
    }
    if (result.processed > 0) revalidatePath('/settings/ai')
    return result
}

/** Bulk archive — отправляет в архив все active items в секции со
 *  status='draft'. Используется для "вычистить черновики" в KnowledgeTab.
 *  Каждый item — отдельная audit-запись (action='archived'). */
export async function bulkArchiveDraftsInSection(sectionId: string): Promise<BulkActionResult> {
    await requireAdminUserId()
    const result: BulkActionResult = { processed: 0, skipped: 0, failed: 0, errors: [] }
    if (!sectionId) return result
    let drafts: any[] = []
    try {
        drafts = await prisma.$queryRaw<any[]>`
            SELECT id FROM "AiKnowledgeItem"
            WHERE "sectionId" = ${sectionId} AND status = 'draft' AND "isActive" = true
        `
    } catch (e: any) {
        result.errors.push({ itemId: '*', message: e?.message ?? 'load failed' })
        return result
    }
    for (const r of drafts) {
        try {
            await archiveKnowledgeItem(r.id)
            result.processed++
        } catch (e: any) {
            result.failed++
            result.errors.push({ itemId: r.id, message: e?.message ?? 'unknown' })
        }
    }
    if (result.processed > 0) revalidatePath('/settings/ai')
    return result
}

/**
 * Выполняет миграцию. Idempotent — повторный запуск пропускает уже
 * мигрированные. Legacy KB НЕ удаляется, остаётся active для
 * reversible-сценария.
 */
export async function migrateLegacyKnowledgeBase() {
    const actor = await requireAdminUserId()
    const result = await migrateLegacyKnowledgeBaseCore(actor)
    if (result.migrated > 0) revalidatePath('/settings/ai')
    return result
}

// ─── AI Knowledge Core channel connections (PR7) ────────────────
//
// Unified listing для UI source-selector в Extraction modal + для
// панели «Источники» с возможностью disable. Без cookie permission —
// counts/labels не несут PII (телефон маскируется).

// PR9.40: 'phone' добавлен в ChannelType — это виртуальный канал
// телефонных звонков (Call.transcript). Соответствует ChatChannel='phone'
// в Prisma enum. В UI label = «Звонки», AiKnowledgeSource.originType =
// 'voice_transcript'. Селектор источников и passport «Собрано из»
// рендерят его рядом с whatsapp/telegram/max.
export type ChannelType = 'whatsapp' | 'telegram' | 'max' | 'phone'

export interface ChannelConnection {
    channel:      ChannelType
    /** id из WhatsAppConnection / TelegramConnection / MaxConnection. */
    id:           string
    /** Человеко-читаемая подпись для UI: "WhatsApp +7922•••5750" или
     *  "Telegram Support" или "MAX Drivers". Падает обратно на
     *  "Безымянное подключение" если нет ни name, ни phone. */
    label:        string
    /** Mask'нутый телефон вида "+7922•••5750" или null если у канала
     *  нет phone-attribute (MAX). */
    phoneMasked:  string | null
    /** Сырое name из связанной таблицы (для admin tooltip). */
    name:         string | null
    /** Текущий live-status. Только 'ready' означает что импорт примет
     *  сообщения; для остальных импорт fail'нется или будет
     *  ограничен. */
    status:       'ready' | 'qr' | 'authenticating' | 'idle' | 'disconnected' | 'inactive' | 'unknown'
    /** Soft active flag — был ли connection помечен админом как
     *  активный в его настройках. !== status='ready'. */
    isActive:     boolean
    /** Готов ли принимать импорт прямо сейчас. */
    isReady:      boolean
}

function maskPhone(raw: string | null): string | null {
    if (!raw) return null
    const digits = raw.replace(/\D/g, '')
    if (digits.length < 7) return raw
    const head = digits.slice(0, 4)
    const tail = digits.slice(-4)
    return `+${head}•••${tail}`
}

/** Возвращает все известные channel-connections, unified shape.
 *  Read-only, без cookie checks — labels не несут PII. */
/** PR7.16.1: per-channel totals из РЕАЛЬНОЙ БД (Chat + Message).
 *  Используется в top-card на /settings/ai → Синхронизация чтобы
 *  показывать «что есть в системе сейчас», а не только агрегаты
 *  HistoryImportJob (которые не покрывают live-streamed каналы
 *  типа MAX-скрейпера).
 *
 *  Read-only, без cookie checks — counts не несут PII. */
export interface ChannelTotalsRow {
    // PR9.41: 'phone' добавлен — voice звонки как 4-й канал в counts.
    channel:        'whatsapp' | 'telegram' | 'max' | 'phone'
    messages:       number
    chats:          number
    contacts:       number
    lastMessageAt:  string | null
}
/** PR9.3: реальный диапазон данных в БД для отображения в extraction
 *  modal. Без этого пользователь не понимал, что выбор «Всю историю»
 *  не означает «качай новое» — а просто берёт что есть в БД. */
export interface ExtractionDataRange {
    earliestSentAt: string | null  // ISO, или null если нет сообщений
    latestSentAt:   string | null
    totalMessages:  number          // total в scope.channels + scope.connectionIds
    last30dMessages: number          // сколько попадёт под last_30d
    last90dMessages: number          // сколько попадёт под last_90d
}

/** Возвращает реальное состояние БД для предполагаемого scope.
 *  Если connectionIds null — берёт все каналы целиком. */
export async function getExtractionDataRange(
    connectionIds: string[] | null
): Promise<ExtractionDataRange> {
    const empty: ExtractionDataRange = {
        earliestSentAt: null, latestSentAt: null,
        totalMessages: 0, last30dMessages: 0, last90dMessages: 0,
    }
    try {
        if (connectionIds && connectionIds.length === 0) return empty
        const ids = connectionIds ?? []
        const useFilter = ids.length > 0
        const rows = await prisma.$queryRaw<Array<{
            earliestSentAt: Date | null
            latestSentAt:   Date | null
            totalMessages:  number
            last30dMessages: number
            last90dMessages: number
        }>>`
            WITH base AS (
                SELECT
                    m."sentAt",
                    COALESCE(wc."connectionId", c.metadata->>'connectionId') AS "resolvedConnId"
                FROM "Message" m
                LEFT JOIN "Chat" c           ON c.id = m."chatId"
                LEFT JOIN "WhatsAppChat" wc  ON wc.id = c."externalChatId"
                WHERE m.direction IN ('inbound', 'outbound')
                  AND m.type NOT IN ('system', 'call')
                  AND m.content IS NOT NULL
                  AND length(m.content) > 1
                  AND m.channel::text IN ('whatsapp', 'telegram', 'max')
            )
            SELECT
                MIN("sentAt")                                                  AS "earliestSentAt",
                MAX("sentAt")                                                  AS "latestSentAt",
                COUNT(*)::int                                                  AS "totalMessages",
                COUNT(*) FILTER (WHERE "sentAt" >= NOW() - INTERVAL '30 days')::int AS "last30dMessages",
                COUNT(*) FILTER (WHERE "sentAt" >= NOW() - INTERVAL '90 days')::int AS "last90dMessages"
            FROM base
            WHERE ${useFilter}::boolean = false
               OR "resolvedConnId" = ANY(${ids})
        `
        const r = rows[0]
        if (!r) return empty
        return {
            earliestSentAt: r.earliestSentAt ? new Date(r.earliestSentAt).toISOString() : null,
            latestSentAt:   r.latestSentAt   ? new Date(r.latestSentAt).toISOString()   : null,
            totalMessages:  Number(r.totalMessages ?? 0),
            last30dMessages: Number(r.last30dMessages ?? 0),
            last90dMessages: Number(r.last90dMessages ?? 0),
        }
    } catch (e: any) {
        if (process.env.NODE_ENV !== 'production') {
            console.error('[getExtractionDataRange] failed:', e?.message)
        }
        return empty
    }
}

/** PR8.D + PR9.9: per-connection message counts + период из реальной БД.
 *  Используется в passport empty-state и в Sync per-account dashboard.
 *  PR9.32: добавлено поле contacts — нужно чтобы top-card на странице
 *  «База сообщений» мог суммировать per-account contacts (раньше использовал
 *  channelTotals → не сходилось с суммой per-account карточек). */
export interface ConnectionMessageCount {
    connectionId:   string
    messages:       number
    chats:          number
    contacts:       number
    /** Самое раннее сообщение в БД для этой connection (по sentAt). */
    earliestSentAt: string | null
    /** Самое свежее сообщение в БД для этой connection. */
    latestSentAt:   string | null
}
export async function getMessageCountsByConnection(): Promise<ConnectionMessageCount[]> {
    try {
        const rows = await prisma.$queryRaw<Array<{
            connectionId: string | null
            messages: number
            chats: number
            contacts: number
            earliestSentAt: Date | null
            latestSentAt: Date | null
        }>>`
            SELECT
                COALESCE(wc."connectionId", c.metadata->>'connectionId') AS "connectionId",
                COUNT(*)::int                       AS messages,
                COUNT(DISTINCT m."chatId")::int     AS chats,
                COUNT(DISTINCT c."contactId")::int  AS contacts,
                MIN(m."sentAt")                     AS "earliestSentAt",
                MAX(m."sentAt")                     AS "latestSentAt"
            FROM "Message" m
            LEFT JOIN "Chat" c           ON c.id = m."chatId"
            LEFT JOIN "WhatsAppChat" wc  ON wc.id = c."externalChatId"
            WHERE m.channel::text IN ('whatsapp', 'telegram', 'max')
            GROUP BY COALESCE(wc."connectionId", c.metadata->>'connectionId')
        `
        const result: ConnectionMessageCount[] = rows
            .filter(r => r.connectionId !== null)
            .map(r => ({
                connectionId:   r.connectionId!,
                messages:       Number(r.messages ?? 0),
                chats:          Number(r.chats ?? 0),
                contacts:       Number(r.contacts ?? 0),
                earliestSentAt: r.earliestSentAt ? new Date(r.earliestSentAt).toISOString() : null,
                latestSentAt:   r.latestSentAt   ? new Date(r.latestSentAt).toISOString()   : null,
            }))

        // PR9.41: добавляем virtual voice_all entry из Call таблицы.
        // Звонки хранятся в Call, а не Message — отдельный COUNT.
        // messages = транскрипты звонков, chats = звонки же
        // (1 transcript = 1 conversation), contacts — distinct contactId.
        try {
            const voiceRows = await prisma.$queryRaw<Array<{
                messages:       number
                contacts:       number
                earliestSentAt: Date | null
                latestSentAt:   Date | null
            }>>`
                SELECT
                    COUNT(*)::int                              AS messages,
                    COUNT(DISTINCT "contactId")::int           AS contacts,
                    MIN("startedAt")                           AS "earliestSentAt",
                    MAX("startedAt")                           AS "latestSentAt"
                FROM "Call"
                WHERE "isSimulation" = false
                  AND transcript IS NOT NULL
                  AND length(transcript) > 50
            `
            const v = voiceRows[0]
            if (v && Number(v.messages ?? 0) > 0) {
                result.push({
                    connectionId:   'voice_all',
                    messages:       Number(v.messages ?? 0),
                    // chats = messages (1 transcript = 1 conversation),
                    // показывается на UI как «N разговоров».
                    chats:          Number(v.messages ?? 0),
                    contacts:       Number(v.contacts ?? 0),
                    earliestSentAt: v.earliestSentAt ? new Date(v.earliestSentAt).toISOString() : null,
                    latestSentAt:   v.latestSentAt   ? new Date(v.latestSentAt).toISOString()   : null,
                })
            }
        } catch (e: any) {
            if (process.env.NODE_ENV !== 'production') {
                console.error('[getMessageCountsByConnection] voice failed:', e?.message)
            }
        }

        return result
    } catch (e: any) {
        if (process.env.NODE_ENV !== 'production') {
            console.error('[getMessageCountsByConnection] failed:', e?.message)
        }
        return []
    }
}

export async function getChannelTotalsForUi(): Promise<ChannelTotalsRow[]> {
    try {
        const rows = await prisma.$queryRaw<Array<{
            channel: string; messages: number; chats: number;
            contacts: number; lastMessageAt: Date | null
        }>>`
            SELECT
                m.channel::text                              AS channel,
                COUNT(*)::int                                AS messages,
                COUNT(DISTINCT m."chatId")::int              AS chats,
                COUNT(DISTINCT c."contactId")::int           AS contacts,
                MAX(m."sentAt")                              AS "lastMessageAt"
            FROM "Message" m
            LEFT JOIN "Chat" c ON c.id = m."chatId"
            WHERE m.channel::text IN ('whatsapp', 'telegram', 'max')
            GROUP BY m.channel
        `
        const result: ChannelTotalsRow[] = rows.map(r => ({
            channel:       r.channel as ChannelTotalsRow['channel'],
            messages:      Number(r.messages ?? 0),
            chats:         Number(r.chats ?? 0),
            contacts:      Number(r.contacts ?? 0),
            lastMessageAt: r.lastMessageAt ? new Date(r.lastMessageAt).toISOString() : null,
        }))

        // PR9.41: добавляем phone channel из Call таблицы. Транскрипты
        // хранятся отдельно от Message, считаем напрямую: каждый Call
        // c transcript = «один разговор» (chats=messages), contacts —
        // distinct contactId.
        try {
            const voiceRows = await prisma.$queryRaw<Array<{
                messages: number; contacts: number; lastMessageAt: Date | null
            }>>`
                SELECT
                    COUNT(*)::int                              AS messages,
                    COUNT(DISTINCT "contactId")::int           AS contacts,
                    MAX("startedAt")                           AS "lastMessageAt"
                FROM "Call"
                WHERE "isSimulation" = false
                  AND transcript IS NOT NULL
                  AND length(transcript) > 50
            `
            const v = voiceRows[0]
            if (v && Number(v.messages ?? 0) > 0) {
                result.push({
                    channel:       'phone',
                    messages:      Number(v.messages ?? 0),
                    chats:         Number(v.messages ?? 0),
                    contacts:      Number(v.contacts ?? 0),
                    lastMessageAt: v.lastMessageAt ? new Date(v.lastMessageAt).toISOString() : null,
                })
            }
        } catch (e: any) {
            if (process.env.NODE_ENV !== 'production') {
                console.error('[getChannelTotalsForUi] voice failed:', e?.message)
            }
        }

        return result
    } catch (e: any) {
        if (process.env.NODE_ENV !== 'production') {
            console.error('[getChannelTotalsForUi] failed:', e?.message)
        }
        return []
    }
}

/** PR9.29: per-connection totals из РЕАЛЬНОЙ БД для конкретного аккаунта.
 *  Используется в ChannelSyncBlock на странице мессенджера, чтобы число
 *  «сообщений» совпадало с тем, что видит пользователь в AI → «База
 *  сообщений». Раньше WA-страница показывала lastJob.messagesImported
 *  (результат последней синхронизации, обычно меньше), а AI — реальный
 *  total из таблицы Message. Пользователь читал это как «кто-то обманывает».
 *  Источник правды один — Message COUNT, агрегированный по
 *  COALESCE(wc.connectionId, c.metadata->>'connectionId'). */
export async function getConnectionTotalsForUi(connectionId: string): Promise<ConnectionTotalsForUi> {
    return getOwnedConnectionTotalsForUi(connectionId)
}

export async function listChannelConnections(): Promise<ChannelConnection[]> {
    const result: ChannelConnection[] = []

    // WhatsApp
    try {
        const rows = await prisma.$queryRaw<any[]>`
            SELECT id, name, "phoneNumber", status::text AS status, "createdAt"
            FROM "WhatsAppConnection"
        `
        // PR7.14: literal legacy defaults считаем за «нет имени» —
        // они появлялись на старом createWhatsAppConnection до того,
        // как мы стали хранить NULL по умолчанию. Если все 2+ ватсапа
        // назывались «WhatsApp Account», в UI они выглядели одинаково.
        const LEGACY_DEFAULT_NAMES = new Set([
            'WhatsApp Account', 'WhatsApp Аккаунт', 'whatsapp account',
        ])
        for (const r of rows) {
            const phoneMasked = maskPhone(r.phoneNumber)
            const rawName = r.name?.trim() ?? ''
            const hasCustomName = rawName.length > 0 && !LEGACY_DEFAULT_NAMES.has(rawName)
            const label = hasCustomName
                ? `WhatsApp ${rawName}`
                : phoneMasked
                    ? `WhatsApp ${phoneMasked}`
                    : `WhatsApp · подключение от ${new Date(r.createdAt).toLocaleDateString('ru')}`
            const isReady = r.status === 'ready'
            result.push({
                channel: 'whatsapp', id: r.id, label,
                phoneMasked,
                // Возвращаем null если name — legacy default, чтобы
                // другие UI участки тоже видели «без имени».
                name: hasCustomName ? rawName : null,
                status: r.status as ChannelConnection['status'],
                isActive: isReady, isReady,
            })
        }
    } catch (e: any) {
        if (process.env.NODE_ENV !== 'production') {
            console.error('[listChannelConnections] WA failed:', e?.message)
        }
    }

    // Telegram — like MAX, also union with virtual entries from
    // Chat.metadata.connectionId (PR8.B4). Это покрывает кейсы
    // где chat metadata содержит connectionId, которого нет в
    // TelegramConnection (например legacy 'default' id).
    try {
        const knownTg = new Set<string>()
        const rows = await prisma.$queryRaw<any[]>`
            SELECT id, name, "phoneNumber", "isActive"
            FROM "TelegramConnection"
        `
        for (const r of rows) {
            knownTg.add(r.id)
            const phoneMasked = maskPhone(r.phoneNumber)
            const label = r.name?.trim()
                ? `Telegram ${r.name.trim()}`
                : phoneMasked
                    ? `Telegram ${phoneMasked}`
                    : 'Telegram · безымянное подключение'
            const status: ChannelConnection['status'] = r.isActive ? 'ready' : 'inactive'
            result.push({
                channel: 'telegram', id: r.id, label,
                phoneMasked, name: r.name ?? null,
                status, isActive: !!r.isActive, isReady: !!r.isActive,
            })
        }
        // PR8.B4: virtual TG entries из Chat.metadata.connectionId.
        // Покрывает кейсы где connection id есть в metadata, но
        // нет в TelegramConnection (legacy 'default' например).
        const virtualTgRows = await prisma.$queryRaw<any[]>`
            SELECT
                metadata->>'connectionId'             AS "connectionId",
                COUNT(*)::int                         AS "chatCount",
                MAX("updatedAt")                      AS "lastSeenAt"
            FROM "Chat"
            WHERE channel = 'telegram'
              AND metadata->>'connectionId' IS NOT NULL
            GROUP BY metadata->>'connectionId'
        `
        const sevenDaysAgoMs = Date.now() - 7 * 24 * 3600 * 1000
        for (const r of virtualTgRows) {
            const id = r.connectionId as string
            if (!id || knownTg.has(id)) continue
            const lastSeen = r.lastSeenAt ? new Date(r.lastSeenAt).getTime() : 0
            const isReadyHeuristic = lastSeen > sevenDaysAgoMs
            const label = `Telegram · ${id}`
            result.push({
                channel: 'telegram', id, label,
                phoneMasked: null, name: null,
                status: isReadyHeuristic ? 'ready' : 'inactive',
                isActive: isReadyHeuristic, isReady: isReadyHeuristic,
            })
        }
    } catch (e: any) {
        if (process.env.NODE_ENV !== 'production') {
            console.error('[listChannelConnections] TG failed:', e?.message)
        }
    }

    // MAX — две группы записей:
    //   (а) MaxConnection table — для корпоративных ботов webhook
    //   (б) virtual entries из Chat.metadata.connectionId — личные
    //       MAX-аккаунты через web-scraper. Они НЕ регистрируются как
    //       MaxConnection (scraper использует hardcoded 'max_scraper'),
    //       но физически сообщения хранятся в Chat + Message и могут
    //       быть включены в сбор ядра.
    //
    // PR7.15.3: до этого пользователь видел в селекторе только бот,
    // но реальные сообщения шли из max_scraper → бот не имел чатов
    // и пользователь думал «MAX недоступен». Теперь оба источника видны.
    try {
        const known = new Set<string>()
        const rows = await prisma.$queryRaw<any[]>`
            SELECT id, name, "isActive"
            FROM "MaxConnection"
        `
        for (const r of rows) {
            const label = r.name?.trim()
                ? `MAX ${r.name.trim()}`
                : 'MAX · безымянное подключение'
            const status: ChannelConnection['status'] = r.isActive ? 'ready' : 'inactive'
            result.push({
                channel: 'max', id: r.id, label,
                phoneMasked: null, name: r.name ?? null,
                status, isActive: !!r.isActive, isReady: !!r.isActive,
            })
            known.add(r.id)
        }

        // (б) Virtual entries из Chat.metadata.
        // Каждый distinct metadata->>'connectionId' WHERE channel='max'
        // — это отдельный источник сообщений (личный аккаунт через
        // скрейпер). Read-only — нельзя disable/rename, но в сбор
        // ядра включается через тот же selector.
        const virtualRows = await prisma.$queryRaw<any[]>`
            SELECT
                metadata->>'connectionId'             AS "connectionId",
                COUNT(*)::int                         AS "chatCount",
                MAX("updatedAt")                      AS "lastSeenAt"
            FROM "Chat"
            WHERE channel = 'max'
              AND metadata->>'connectionId' IS NOT NULL
            GROUP BY metadata->>'connectionId'
        `
        // Свежесть: если последний chat обновился за 7 дней → активен.
        // Это эвристика, не строгое определение — нам важно показать
        // что источник "живой" для UX, а не gating.
        const sevenDaysAgoMs = Date.now() - 7 * 24 * 3600 * 1000
        for (const r of virtualRows) {
            const id = r.connectionId as string
            if (!id || known.has(id)) continue
            const lastSeen = r.lastSeenAt ? new Date(r.lastSeenAt).getTime() : 0
            const isReadyHeuristic = lastSeen > sevenDaysAgoMs
            // Human-readable label. max_scraper — это известный hardcoded
            // virtual id из max-web-scraper.
            const label = id === 'max_scraper'
                ? 'MAX · личный аккаунт (через скрейпер)'
                : `MAX · ${id}`
            result.push({
                channel: 'max', id, label,
                phoneMasked: null,
                // name=null — UI трактует как «без custom-имени»
                name: null,
                status: isReadyHeuristic ? 'ready' : 'inactive',
                isActive: isReadyHeuristic,
                isReady: isReadyHeuristic,
            })
        }
    } catch (e: any) {
        if (process.env.NODE_ENV !== 'production') {
            console.error('[listChannelConnections] MAX failed:', e?.message)
        }
    }

    // PR9.40: Voice channel — один виртуальный entry для всех звонков.
    // Появляется только если в БД есть хотя бы один Call с transcript.
    // isReady = true если есть свежий transcript за последние 30 дней
    // (тоже эвристика как для MAX).
    try {
        const voiceRows = await prisma.$queryRaw<Array<{
            transcripts: number
            lastTranscriptAt: Date | null
        }>>`
            SELECT
                COUNT(*)::int        AS transcripts,
                MAX("startedAt")     AS "lastTranscriptAt"
            FROM "Call"
            WHERE "isSimulation" = false
              AND transcript IS NOT NULL
              AND length(transcript) > 50
        `
        const v = voiceRows[0]
        if (v && v.transcripts > 0) {
            const thirtyDaysAgoMs = Date.now() - 30 * 24 * 3600 * 1000
            const lastSeen = v.lastTranscriptAt ? new Date(v.lastTranscriptAt).getTime() : 0
            const isReadyHeuristic = lastSeen > thirtyDaysAgoMs
            result.push({
                channel: 'phone',
                id: 'voice_all',
                label: 'Звонки',
                phoneMasked: null,
                name: null,
                status: isReadyHeuristic ? 'ready' : 'inactive',
                isActive: true,  // voice всегда «active» — это просто наличие транскриптов в БД
                isReady: isReadyHeuristic,
            })
        }
    } catch (e: any) {
        if (process.env.NODE_ENV !== 'production') {
            console.error('[listChannelConnections] Voice failed:', e?.message)
        }
    }

    // Stable order: channel alphabetically → isReady DESC → label asc
    return result.sort((a, b) => {
        if (a.channel !== b.channel) return a.channel.localeCompare(b.channel)
        if (a.isReady !== b.isReady) return a.isReady ? -1 : 1
        return a.label.localeCompare(b.label)
    })
}

// ─── AI Knowledge Core source disable (PR7.7) ───────────────────
//
// Soft-disable знаний из конкретного источника. НЕ physical delete.
// Поведение зависит от trust-level item'а:
//   verified=true ИЛИ tags ⊇ {type:manual}  → keep active + warning
//   else                                    → auto-archive

export interface SourceStatsRow {
    channel:               string
    connectionId:          string | null
    sourcesTotal:          number
    sourcesActive:         number
    itemsTouched:          number
    itemsActive:           number
    itemsVerified:         number
    itemsManual:           number
}

/** Per-connection статистика для UI «Источники» (PR7.10). NULL
 *  connectionId группируется отдельно — это legacy TG/MAX sources
 *  где schema не хранит chat-level provenance. */
export async function getSourceStatsByConnection(): Promise<SourceStatsRow[]> {
    try {
        return await prisma.$queryRaw<SourceStatsRow[]>`
            SELECT
                s.channel::text                                  AS channel,
                s."connectionId"                                 AS "connectionId",
                COUNT(s.id)::int                                 AS "sourcesTotal",
                COUNT(s.id) FILTER (WHERE s."isActive" = true)::int AS "sourcesActive",
                COUNT(DISTINCT s."itemId")::int                  AS "itemsTouched",
                COUNT(DISTINCT s."itemId") FILTER (
                    WHERE EXISTS (
                        SELECT 1 FROM "AiKnowledgeItem" ki
                        WHERE ki.id = s."itemId"
                          AND ki.status = 'active' AND ki."isActive" = true
                    )
                )::int                                            AS "itemsActive",
                COUNT(DISTINCT s."itemId") FILTER (
                    WHERE EXISTS (
                        SELECT 1 FROM "AiKnowledgeItem" ki
                        WHERE ki.id = s."itemId" AND ki."isVerified" = true
                    )
                )::int                                            AS "itemsVerified",
                COUNT(DISTINCT s."itemId") FILTER (
                    WHERE EXISTS (
                        SELECT 1 FROM "AiKnowledgeItem" ki
                        WHERE ki.id = s."itemId" AND 'type:manual' = ANY(ki.tags)
                    )
                )::int                                            AS "itemsManual"
            FROM "AiKnowledgeSource" s
            GROUP BY s.channel, s."connectionId"
            ORDER BY s.channel, s."connectionId"
        `
    } catch (e: any) {
        if (process.env.NODE_ENV !== 'production') {
            console.error('[getSourceStatsByConnection] failed:', e?.message)
        }
        return []
    }
}

export interface DisableSourceResult {
    sourcesDisabled:        number
    itemsAutoArchived:      number
    itemsKeptWithWarning:   number
    itemsUnaffected:        number
}

/**
 * PR7.7: отключить знания, пришедшие из конкретного подключения.
 * WhatsApp работает напрямую через connectionId. TG/MAX items с
 * connectionId=NULL (legacy schema) не задеваются — UI объявит.
 */
export async function disableKnowledgeSource(input: {
    channel:      'whatsapp' | 'telegram' | 'max'
    connectionId: string
}): Promise<DisableSourceResult> {
    const actor = await requireAdminUserId()
    if (!input.channel || !input.connectionId) {
        throw new Error('channel и connectionId обязательны')
    }

    const affectedItemRows = await prisma.$queryRaw<Array<{ itemId: string }>>`
        SELECT DISTINCT "itemId"
        FROM "AiKnowledgeSource"
        WHERE channel::text = ${input.channel}
          AND "connectionId" = ${input.connectionId}
          AND "isActive" = true
    `
    const affectedItemIds = affectedItemRows.map(r => r.itemId)

    const disabled = await disableKnowledgeSourcesV1({ contract: DISABLE_KNOWLEDGE_SOURCES_COMMAND_V1, channel: input.channel, connectionId: input.connectionId })

    const result: DisableSourceResult = {
        sourcesDisabled:      disabled.disabledCount,
        itemsAutoArchived:    0,
        itemsKeptWithWarning: 0,
        itemsUnaffected:      0,
    }

    if (affectedItemIds.length === 0) return result

    for (const itemId of affectedItemIds) {
        const itemRows = await prisma.$queryRaw<any[]>`
            SELECT
                id, "sectionId", title, "canonicalStatement", tags,
                confidence, "sourceCount", "uniqueManagerCount",
                status::text AS status, "isActive",
                "safetyLevel"::text AS "safetyLevel",
                "supersededByItemId", "conflictGroupId",
                "isVerified", "verifiedBy", "verifiedAt"
            FROM "AiKnowledgeItem"
            WHERE id = ${itemId}
            LIMIT 1
        `
        const item = itemRows[0]
        if (!item) continue
        if (item.status !== 'active') {
            result.itemsUnaffected++
            continue
        }

        const activeSourcesRows = await prisma.$queryRaw<any[]>`
            SELECT COUNT(*)::int AS cnt
            FROM "AiKnowledgeSource"
            WHERE "itemId" = ${itemId} AND "isActive" = true
        `
        const activeSources = Number(activeSourcesRows[0]?.cnt ?? 0)

        if (activeSources > 0) {
            result.itemsUnaffected++
            continue
        }

        const isManual = Array.isArray(item.tags) && item.tags.includes('type:manual')
        const shouldKeepActive = item.isVerified === true || isManual

        if (shouldKeepActive) {
            const hasMarker = Array.isArray(item.tags) && item.tags.includes('sources_all_disabled')
            if (!hasMarker) {
                await markKnowledgeItemSourcesDisabledV1({
                    contract: MARK_KNOWLEDGE_ITEM_SOURCES_DISABLED_COMMAND_V1,
                    itemId,
                })
            }
            await writeAuditEntry({
                itemId, actor,
                action: 'source_disabled',
                before: snapshotItem(item),
                after:  snapshotItem({
                    ...item,
                    tags: hasMarker ? item.tags : [...item.tags, 'sources_all_disabled'],
                }),
                metadata: {
                    connectionId: input.connectionId,
                    channel:      input.channel,
                    outcome:      'kept_active_warning',
                    reason:       item.isVerified ? 'verified' : 'manual',
                },
            })
            result.itemsKeptWithWarning++
        } else {
            await archiveKnowledgeItemAfterSourceDisableV1({
                contract: ARCHIVE_KNOWLEDGE_ITEM_AFTER_SOURCE_DISABLE_COMMAND_V1,
                itemId,
            })
            await writeAuditEntry({
                itemId, actor,
                action: 'source_disabled',
                before: snapshotItem(item),
                after:  snapshotItem({ ...item, status: 'archived', isActive: false }),
                metadata: {
                    connectionId: input.connectionId,
                    channel:      input.channel,
                    outcome:      'auto_archived',
                    reason:       'no_active_sources',
                },
            })
            result.itemsAutoArchived++
        }
    }

    await writeAuditEntry({
        itemId: null, actor,
        action: 'source_disabled',
        before: null, after: null,
        metadata: {
            connectionId:         input.connectionId,
            channel:              input.channel,
            sourcesDisabled:      result.sourcesDisabled,
            itemsAutoArchived:    result.itemsAutoArchived,
            itemsKeptWithWarning: result.itemsKeptWithWarning,
            itemsUnaffected:      result.itemsUnaffected,
        },
    })

    revalidatePath('/settings/ai')
    return result
}

// ─── AI Knowledge Core full reset (PR7.8) ───────────────────────
//
// Массовый soft-archive ядра по 3 режимам. NO physical delete.
// Restore возможен через PR2.5 restoreKnowledgeItem per-item.
//
// Runtime safety: метод не блокирует full reset при runtime_enabled —
// env-flag это deployment decision, UI не должен flip-обратно. Но
// UI обязан показать warning перед typed confirmation.

export type ResetMode = 'auto_only' | 'unverified' | 'full'

export interface ResetResult {
    mode:              ResetMode
    archivedCount:     number
    keptCount:         number
    /** Сколько items уже было archived до этого reset — не трогаются. */
    alreadyArchived:   number
    /** Для UI verify сценария. */
    runtimeWasEnabled: boolean
}

/**
 * Описание режимов:
 *   auto_only  → archive items где !isVerified И !'type:manual' И !'source:legacy'
 *                Это extraction-only auto-сборка. Самый «безопасный».
 *   unverified → archive все !isVerified. Manual-created без verified
 *                тоже идут в архив (админ должен ручную подтвердить).
 *   full       → archive ВСЕ active items. Требует typedConfirm.
 */
export async function resetKnowledgeCore(
    mode: ResetMode,
    typedConfirm?: string,
): Promise<ResetResult> {
    const actor = await requireAdminUserId()
    if (!['auto_only', 'unverified', 'full'].includes(mode)) {
        throw new Error('Недопустимый mode')
    }
    if (mode === 'full' && typedConfirm !== 'ОЧИСТИТЬ') {
        throw new Error('Для полного reset введите подтверждение «ОЧИСТИТЬ»')
    }

    const runtimeWasEnabled = isRuntimeEnabled()

    // 1. Select target items per-mode.
    let rowsToArchive: any[] = []
    if (mode === 'auto_only') {
        rowsToArchive = await prisma.$queryRaw<any[]>`
            SELECT
                id, "sectionId", title, "canonicalStatement", tags,
                confidence, "sourceCount", "uniqueManagerCount",
                status::text AS status, "isActive",
                "safetyLevel"::text AS "safetyLevel",
                "supersededByItemId", "conflictGroupId",
                "isVerified", "verifiedBy", "verifiedAt"
            FROM "AiKnowledgeItem"
            WHERE status = 'active' AND "isActive" = true
              AND "isVerified" = false
              AND NOT ('type:manual'   = ANY(tags))
              AND NOT ('source:legacy' = ANY(tags))
        `
    } else if (mode === 'unverified') {
        rowsToArchive = await prisma.$queryRaw<any[]>`
            SELECT
                id, "sectionId", title, "canonicalStatement", tags,
                confidence, "sourceCount", "uniqueManagerCount",
                status::text AS status, "isActive",
                "safetyLevel"::text AS "safetyLevel",
                "supersededByItemId", "conflictGroupId",
                "isVerified", "verifiedBy", "verifiedAt"
            FROM "AiKnowledgeItem"
            WHERE status = 'active' AND "isActive" = true
              AND "isVerified" = false
        `
    } else {
        // full
        rowsToArchive = await prisma.$queryRaw<any[]>`
            SELECT
                id, "sectionId", title, "canonicalStatement", tags,
                confidence, "sourceCount", "uniqueManagerCount",
                status::text AS status, "isActive",
                "safetyLevel"::text AS "safetyLevel",
                "supersededByItemId", "conflictGroupId",
                "isVerified", "verifiedBy", "verifiedAt"
            FROM "AiKnowledgeItem"
            WHERE status = 'active' AND "isActive" = true
        `
    }

    // 2. Count kept / already-archived for telemetry.
    const totalActiveRows = await prisma.$queryRaw<any[]>`
        SELECT COUNT(*)::int AS cnt FROM "AiKnowledgeItem"
        WHERE status = 'active' AND "isActive" = true
    `
    const archivedRows = await prisma.$queryRaw<any[]>`
        SELECT COUNT(*)::int AS cnt FROM "AiKnowledgeItem"
        WHERE status = 'archived'
    `
    const totalActiveBefore = Number(totalActiveRows[0]?.cnt ?? 0)
    const alreadyArchived = Number(archivedRows[0]?.cnt ?? 0)
    const archivedCount = rowsToArchive.length
    const keptCount = totalActiveBefore - archivedCount

    // 3. Apply archive. Один statement per-id, чтобы writeAuditEntry
    //    видел per-item before/after — для UI explainability rollback.
    for (const item of rowsToArchive) {
        await archiveKnowledgeItemForCoreResetV1({
            contract: ARCHIVE_KNOWLEDGE_ITEM_FOR_CORE_RESET_COMMAND_V1,
            itemId: item.id,
        })
        await writeAuditEntry({
            itemId: item.id, actor,
            action: 'core_reset',
            before: snapshotItem(item),
            after:  snapshotItem({ ...item, status: 'archived', isActive: false }),
            metadata: { mode, runtimeWasEnabled },
        })
    }

    // 4. Top-level reset event (без itemId).
    await writeAuditEntry({
        itemId: null, actor,
        action: 'core_reset',
        before: null, after: null,
        metadata: {
            mode,
            archivedCount,
            keptCount,
            beforeCount:       totalActiveBefore,
            afterCount:        keptCount,
            runtimeWasEnabled,
        },
    })

    revalidatePath('/settings/ai')
    return { mode, archivedCount, keptCount, alreadyArchived, runtimeWasEnabled }
}
