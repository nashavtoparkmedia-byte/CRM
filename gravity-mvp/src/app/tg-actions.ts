'use server'

import { prisma } from '@/lib/prisma'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { CustomFile } from 'telegram/client/uploads'
import QRCode from 'qrcode'
import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { NewMessage, Raw } from 'telegram/events'
import { transportRegistryLifecycleV1 as registry } from '@/modules/messaging/public/v1/transport-registry-lifecycle'
import { appendConversationIdentityCollisionV1, attachBinaryMessageMediaV1, attachMessageMediaV1, createChannelMessageV1, deleteConversationsByIdV1, deleteHistoryImportJobsForChannelV1, deleteHistoryImportJobsForConnectionV1, applyMessageDeliveryEvidenceV1, ensureConversationContactLinkV1, patchChannelConversationV1, patchHistoryImportJobV1, patchMessageMetadataV1, prepareOutboundConversationV1, upsertChannelConversationV1 } from '@/modules/messaging/public/v1'
import { ATTACH_BINARY_MESSAGE_MEDIA_COMMAND_V1, ATTACH_MESSAGE_MEDIA_COMMAND_V1, CREATE_CHANNEL_MESSAGE_COMMAND_V1, DELETE_CONVERSATIONS_BY_ID_COMMAND_V1, DELETE_HISTORY_IMPORT_JOBS_FOR_CHANNEL_COMMAND_V1, DELETE_HISTORY_IMPORT_JOBS_FOR_CONNECTION_COMMAND_V1, ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1, PATCH_CHANNEL_CONVERSATION_COMMAND_V1, PATCH_HISTORY_IMPORT_JOB_COMMAND_V1, PATCH_MESSAGE_DELIVERY_COMMAND_V2, PATCH_MESSAGE_METADATA_COMMAND_V1, UPSERT_CHANNEL_CONVERSATION_COMMAND_V1 } from '@/contracts/messaging/v1'
import { projectTelegramConnectionMetadata } from '@/modules/telegram-channel/public/v1/telegram-connection-public-metadata'
import { getTelegramTransportOptionsV1 } from '@/modules/telegram-channel/public/v1'
import { requireIntegrationAdminAccess } from '@/modules/identity-access/public/v1'
import { cleanupDanglingContactIdentitiesV1, isResolvedChannelContactResultV1, resolveChannelContactOperationV1 } from '@/modules/contacts/public/v1'
import { contactReachabilityV1 } from '@/modules/contacts/public/v1/contact-reachability'

// Global map to keep track of active login clients for QR
// Note: In a production serverless environment, this would need a different approach (like a separate service or Redis)
// But for local MVP development, this works.
type ActiveTelegramLogin = {
    client: TelegramClient,
    qrUrl: string,
    status: string,
    apiId: number,
    apiHash: string,
    expiresAt: number,
    expiryTimer?: ReturnType<typeof setTimeout>,
    resolvePassword?: (password: string) => void
}

const TELEGRAM_LOGIN_TTL_MS = 10 * 60 * 1000
const TELEGRAM_TERMINAL_STATUS_TTL_MS = 30 * 1000
const activeLogins = new Map<string, ActiveTelegramLogin>()
const terminalLogins = new Map<string, { status: 'expired' | 'error'; expiresAt: number }>()

function pruneTerminalLogins(now = Date.now()): void {
    for (const [loginId, terminal] of terminalLogins) {
        if (terminal.expiresAt <= now) terminalLogins.delete(loginId)
    }
}

async function disposeActiveLogin(
    loginId: string,
    terminalStatus?: 'expired' | 'error',
): Promise<void> {
    const current = activeLogins.get(loginId)
    if (!current) return
    activeLogins.delete(loginId)
    if (current.expiryTimer) clearTimeout(current.expiryTimer)
    const pendingPasswordResolver = current.resolvePassword
    current.resolvePassword = undefined
    // Release signInUserWithQrCode if it is awaiting our 2FA callback. The
    // disconnected client will reject the empty value, allowing the promise
    // closure (including temporary apiHash) to be collected.
    if (pendingPasswordResolver) pendingPasswordResolver('')
    if (terminalStatus) {
        const expiresAt = Date.now() + TELEGRAM_TERMINAL_STATUS_TTL_MS
        terminalLogins.set(loginId, {
            status: terminalStatus,
            expiresAt,
        })
        const terminalTimer = setTimeout(() => {
            if (terminalLogins.get(loginId)?.expiresAt === expiresAt) {
                terminalLogins.delete(loginId)
            }
        }, TELEGRAM_TERMINAL_STATUS_TTL_MS)
        terminalTimer.unref?.()
    }
    try {
        await current.client.disconnect()
    } catch (error) {
        console.warn(`[TG-AUTH] Client teardown failed for loginId ${loginId}:`, error)
    }
}

function scheduleLoginExpiry(loginId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
        void disposeActiveLogin(loginId, 'expired')
    }, TELEGRAM_LOGIN_TTL_MS)
    timer.unref?.()
    return timer
}

export async function getTelegramAuthQR(apiId: number, apiHash: string) {
    await requireIntegrationAdminAccess()
    console.log(`[TG-AUTH] Starting QR generation for API ID: ${apiId}`)
    const stringSession = new StringSession('')
    const transport = getTelegramTransportOptionsV1()
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
        ...transport.options,
    })

    try {
        await client.connect()
    } catch {
        try { await client.disconnect() } catch { /* best-effort teardown */ }
        throw new Error('Unable to start Telegram authentication')
    }
    console.log(`[TG-AUTH] Client connected to Telegram`)

    const loginId = randomUUID()
    activeLogins.set(loginId, {
        client,
        qrUrl: '',
        status: 'starting',
        apiId,
        apiHash,
        expiresAt: Date.now() + TELEGRAM_LOGIN_TTL_MS,
        expiryTimer: scheduleLoginExpiry(loginId),
    })

    // We start the login process in the background
    // Promise.resolve().then also turns a synchronous library failure into the
    // same rejection path, so every login failure reaches client teardown.
    const loginPromise = Promise.resolve().then(() => client.signInUserWithQrCode(
        { apiId, apiHash },
        {
            qrCode: async (code) => {
                console.log(`[TG-AUTH] QR Code received, expires in ${code.expires}s`)
                const qrUrl = await QRCode.toDataURL(`tg://login?token=${code.token.toString('base64url')}`)
                // API credentials stay server-side for the bounded login
                // ceremony. Status polling needs only the opaque loginId.
                const current = activeLogins.get(loginId)
                if (!current || current.client !== client) return
                activeLogins.set(loginId, { ...current, qrUrl, status: 'awaiting_scan' })
                console.log(`[TG-AUTH] QR URL set for loginId: ${loginId}`)
            },
            password: async () => {
                // Telegram's 2FA hint can contain user-chosen sensitive text;
                // record only that the ceremony reached this state.
                console.log('[TG-AUTH] Password requested by Telegram')
                const current = activeLogins.get(loginId)
                if (current) {
                    activeLogins.set(loginId, { ...current, status: '2fa_required' })
                }

                return new Promise((resolve) => {
                    const data = activeLogins.get(loginId)
                    if (data) {
                        activeLogins.set(loginId, { ...data, resolvePassword: resolve })
                        console.log(`[TG-AUTH] Waiting for password input from frontend for loginId: ${loginId}`)
                    } else {
                        resolve('') // Should not happen if map is intact
                    }
                })
            },
            onError: (err: any) => {
                console.error(`[TG-AUTH] QR Login Error for loginId ${loginId}:`, err)
                void disposeActiveLogin(loginId, 'error')
            }
        },
    ))

    // Background promise handling
    loginPromise.then(async (user) => {
        console.log(`[TG-AUTH] Auth confirmed! User ID: ${user.id.toString()}`)
        const current = activeLogins.get(loginId)
        if (current) {
            activeLogins.set(loginId, { ...current, status: 'success' })
            console.log(`[TG-AUTH] Status updated to success for loginId: ${loginId}`)
        }
    }).catch(err => {
        const errorMsg = err.message || ''
        const current = activeLogins.get(loginId)

        if (errorMsg.includes('TIMEOUT')) {
            console.log(`[TG-AUTH] QR Login timed out for loginId: ${loginId}`)
            if (current) void disposeActiveLogin(loginId, 'expired')
        } else {
            console.error(`[TG-AUTH] Auth confirmation error for loginId ${loginId}:`, err)
            if (current) void disposeActiveLogin(loginId, 'error')
        }
    })

    // Wait a bit for the QR code to be generated
    let retries = 0
    while (!activeLogins.get(loginId)?.qrUrl && !terminalLogins.has(loginId) && retries < 20) {
        await new Promise(resolve => setTimeout(resolve, 500))
        retries++
    }

    const loginData = activeLogins.get(loginId)
    if (!loginData?.qrUrl) {
        console.error(`[TG-AUTH] Failed to generate QR code after ${retries} retries`)
        await disposeActiveLogin(loginId, 'error')
        throw new Error('Failed to generate QR code')
    }

    return { loginId, qrUrl: loginData.qrUrl }
}

/** Reuse an existing connection's Telegram application credentials without
 * serializing apiHash to the browser. */
export async function getTelegramAuthQRFromSavedConnection(connectionId: string) {
    await requireIntegrationAdminAccess()
    const connection = await prisma.telegramConnection.findUnique({
        where: { id: connectionId },
        select: { apiId: true, apiHash: true },
    })
    if (!connection?.apiId || !connection?.apiHash) {
        throw new Error('Saved Telegram application credentials are unavailable')
    }
    return getTelegramAuthQR(connection.apiId, connection.apiHash)
}

export async function submitTelegram2FAPassword(loginId: string, password: string) {
    await requireIntegrationAdminAccess()
    console.log(`[TG-AUTH] Received 2FA password for loginId: ${loginId}`)
    const data = activeLogins.get(loginId)
    if (data && data.expiresAt <= Date.now()) {
        await disposeActiveLogin(loginId, 'expired')
        return { success: false, error: 'Session expired' }
    }
    if (!data || !data.resolvePassword) {
        console.error(`[TG-AUTH] Login data or resolver not found for 2FA submission: ${loginId}`)
        return { success: false, error: 'Session expired or not waiting for password' }
    }

    try {
        console.log(`[TG-AUTH] Resolving password promise...`)
        data.resolvePassword(password)
        activeLogins.set(loginId, {
            ...data,
            status: 'awaiting_scan',
            resolvePassword: undefined,
        })
        // Note: The status will be updated to 'success' by the background loginPromise.then()
        return { success: true }
    } catch (err: any) {
        console.error(`[TG-AUTH] Error resolving password:`, err)
        return { success: false, error: err.message || 'Internal error' }
    }
}

export async function checkTelegramAuthStatus(loginId: string) {
    await requireIntegrationAdminAccess()
    pruneTerminalLogins()
    const terminal = terminalLogins.get(loginId)
    if (terminal) return { status: terminal.status }

    const data = activeLogins.get(loginId)
    console.log(`[TG-AUTH] Checking status for loginId: ${loginId}, Current status: ${data?.status}`)

    if (!data) return { status: 'expired' }
    if (data.expiresAt <= Date.now()) {
        await disposeActiveLogin(loginId, 'expired')
        return { status: 'expired' }
    }

    if (data.status === 'success') {
        activeLogins.set(loginId, { ...data, status: 'persisting' })
        console.log(`[TG-AUTH] Login success detected for loginId: ${loginId}. Saving session...`)

        try {
            const sessionString = (data.client.session as StringSession).save()
            // Fetch user info to get the telegram ID
            const me = await data.client.getMe()
            const telegramId = me.id.toString()
            const phoneNumber = me.phone || null
            let isDefault = false

            // Check if this is the first connection
            const existingCount = await (prisma as any).telegramConnection.count({
                where: { isActive: true }
            })
            if (existingCount === 0) {
                isDefault = true
            }

            // Save to DB
            await (prisma as any).telegramConnection.upsert({
                where: { id: telegramId },
                create: {
                    id: telegramId,
                    apiId: data.apiId,
                    apiHash: data.apiHash,
                    sessionString,
                    isActive: true,
                    phoneNumber,
                    isDefault,
                    name: me.firstName ? `${me.firstName} ${me.lastName || ''}`.trim() : `Account ${telegramId}`
                },
                update: {
                    apiId: data.apiId,
                    apiHash: data.apiHash,
                    sessionString,
                    isActive: true,
                    phoneNumber
                    // Default and Name are not updated here intentionally so user preferences aren't overwritten
                }
            })
            console.log(`[TG-AUTH] Session saved to database successfully`)
            await disposeActiveLogin(loginId)
            revalidatePath('/telegram')
            return { status: 'success' }
        } catch {
            // The failed Prisma invocation carried apiHash and sessionString;
            // its diagnostic object is intentionally not emitted.
            console.error('[TG-AUTH] Database error saving session')
            await disposeActiveLogin(loginId, 'error')
            return { status: 'error' }
        }
    }

    // Double check if client somehow authorized but status didn't update
    try {
        if (data.client.connected && await data.client.isUserAuthorized()) {
            console.log(`[TG-AUTH] Client is authorized, but status was still: ${data.status}. Updating to success manually.`)
            activeLogins.set(loginId, { ...data, status: 'success' })
            // Next poll will pick it up and save to DB
        }
    } catch (error) {
        console.error(`[TG-AUTH] Authorization status failed for loginId ${loginId}:`, error)
        await disposeActiveLogin(loginId, 'error')
        return { status: 'error' }
    }

    return { status: data.status, qrUrl: data.qrUrl }
}

export async function getTelegramConnections() {
    await requireIntegrationAdminAccess()
    const conns = await prisma.telegramConnection.findMany({
        where: { sessionString: { not: null } },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
        select: {
            id: true,
            apiId: true,
            isActive: true,
            phoneNumber: true,
            createdAt: true,
            updatedAt: true,
            isDefault: true,
            name: true,
        },
    })
    return conns.map(connection => projectTelegramConnectionMetadata({
        ...connection,
        apiHashConfigured: true,
        sessionConfigured: true,
    }))
}

export async function updateTelegramConnectionSettings(id: string, name: string, isDefault: boolean) {
    await requireIntegrationAdminAccess()
    if (isDefault) {
        // Unset any existing default
        await (prisma as any).telegramConnection.updateMany({
            where: { isDefault: true, id: { not: id } },
            data: { isDefault: false }
        })
    }

    await (prisma as any).telegramConnection.update({
        where: { id },
        data: { name, isDefault }
    })
    revalidatePath('/telegram')
}

export async function disconnectTelegram(id: string) {
    await requireIntegrationAdminAccess()
    const connection = await (prisma as any).telegramConnection.findUnique({ where: { id } })
    
    await (prisma as any).telegramConnection.update({
        where: { id },
        data: { isActive: false, sessionString: null, isDefault: false }
    })

    await evictTelegramClient(id)

    // If we disconnected the default, try to make another active one the default
    if (connection?.isDefault) {
        const nextActive = await (prisma as any).telegramConnection.findFirst({
            where: { isActive: true }
        })
        if (nextActive) {
            await (prisma as any).telegramConnection.update({
                where: { id: nextActive.id },
                data: { isDefault: true }
            })
        }
    }

    revalidatePath('/telegram')
}
type TelegramCatchUpMode = 'startup' | 'reconnect' | 'periodic' | 'manual'

type TelegramCatchUpSummary = {
    connectionId: string
    mode: TelegramCatchUpMode
    dialogs: number
    skippedDialogs: number
    failedDialogs: number
    messages: number
    saved: number
    duplicates: number
    skipped: number
    enrichmentBlocked: number
    failed: number
    readReceipts: number
    durationMs: number
    error: string | null
}

type TelegramMtprotoRuntime = {
    clients: Map<string, TelegramClient>
    connecting: Map<string, Promise<TelegramClient>>
    providerAccountIds: Map<string, string>
    instanceIds: Map<string, string>
    listeners: Set<string>
    hardRestartLastAt: Map<string, number>
    catchUps: Map<string, Promise<TelegramCatchUpSummary>>
    lastCatchUpAt: Map<string, number>
    // The entity cache a sweep warms belongs to one GramJS client, so sweep
    // state is only ever reused for the very client that produced it.
    peerSweeps: Map<string, { client: TelegramClient, sweep: Promise<boolean> }>
    lastPeerSweep: Map<string, { client: TelegramClient, at: number, ok: boolean }>
    initPromise: Promise<void> | null
    healthInterval: ReturnType<typeof setInterval> | null
}

/**
 * Next.js loads this module more than once in one server process, one copy per
 * chunk (instrumentation, the conversations route, server actions). Module-scoped
 * state gave every copy its own GramJS client on the same auth key, and every
 * single-flight guard held only per copy. A Symbol.for key resolves to the same
 * symbol in every copy, so all of them share one client, one listener and one
 * catch-up per connection.
 */
const TELEGRAM_MTPROTO_RUNTIME_SLOT = Symbol.for('yoko.telegram.mtproto-runtime.v1')

function telegramMtprotoRuntime(): TelegramMtprotoRuntime {
    const host = globalThis as typeof globalThis & {
        [TELEGRAM_MTPROTO_RUNTIME_SLOT]?: TelegramMtprotoRuntime
    }
    if (!host[TELEGRAM_MTPROTO_RUNTIME_SLOT]) {
        host[TELEGRAM_MTPROTO_RUNTIME_SLOT] = {
            clients: new Map(),
            connecting: new Map(),
            providerAccountIds: new Map(),
            instanceIds: new Map(),
            listeners: new Set(),
            hardRestartLastAt: new Map(),
            catchUps: new Map(),
            lastCatchUpAt: new Map(),
            peerSweeps: new Map(),
            lastPeerSweep: new Map(),
            initPromise: null,
            healthInterval: null,
        }
    }
    const runtime = host[TELEGRAM_MTPROTO_RUNTIME_SLOT]
    // A slot created by an older copy of this module (development reload) gains
    // the state it did not have instead of failing on it.
    runtime.peerSweeps ??= new Map()
    runtime.lastPeerSweep ??= new Map()
    return runtime
}

const tgRuntime = telegramMtprotoRuntime()
// Process-wide cache for Telegram clients to prevent constant reconnects
const clientCache = tgRuntime.clients
// Authenticated provider account observed from client.getMe(), keyed by the
// transport connection row. A connection label/id is not itself account proof.
const tgProviderAccountIds = tgRuntime.providerAccountIds
// instanceId per connection — links client to registry entry
const tgInstanceIds = tgRuntime.instanceIds
// Idempotency guard: track which connections already have listeners attached
const initializedListeners = tgRuntime.listeners

async function evictTelegramClient(connectionId: string): Promise<void> {
    const cached = clientCache.get(connectionId)
    try {
        await cached?.disconnect()
    } catch (error: unknown) {
        console.warn(`[TG-CACHE] Failed to disconnect client ${connectionId}:`, error)
    } finally {
        clientCache.delete(connectionId)
        initializedListeners.delete(connectionId)
        tgInstanceIds.delete(connectionId)
        tgProviderAccountIds.delete(connectionId)
    }
}
// Validate a Telegram message timestamp (epoch seconds).
// Telegram MTProto has had corrupted-date edge cases (mostly around
// service / forwarded messages); guard matches the WA clampMessageTs
// philosophy: a message without a sane date isn't worth keeping,
// skip it rather than clamping to now and polluting the timeline.
// Telegram launched in 2013, so anything before that is clearly bad.
const TG_MIN_TS_MS = Date.UTC(2013, 0, 1)
const TG_FUTURE_TOLERANCE_MS = 60 * 60 * 1000
function validateTgDate(epochSec: unknown): Date | null {
    const nowMs = Date.now()
    const maxMs = nowMs + TG_FUTURE_TOLERANCE_MS
    const n = typeof epochSec === 'number' ? epochSec : Number(epochSec)
    if (!Number.isFinite(n) || n <= 0) return null
    const tsMs = n * 1000
    if (tsMs < TG_MIN_TS_MS || tsMs > maxMs) return null
    return new Date(tsMs)
}

/** Get runtime status — delegates to TransportRegistry. */
export async function getTelegramRuntimeStatus() {
    await requireIntegrationAdminAccess()
    return registry.getAllEntries().filter(e => e.channel === 'telegram')
}

import { publishPersistedMessageV1 as emitMessageReceived } from '@/modules/messaging/public/v1/persisted-message-ingress'
import { channelConversationWorkflowV1 as ConversationWorkflowService } from '@/modules/messaging/public/v1/channel-conversation-workflow'

/**
 * Скачивание медиа из Telegram падает transient-ошибкой, если соединение
 * GramJS рвётся в момент скачивания (например, контейнер пересоздаётся
 * при деплое ровно когда пришло сообщение с вложением). Без retry такое
 * сообщение навсегда остаётся без attachment — DEDUP блокирует повторную
 * попытку при следующей обработке того же msgId. 3 попытки с backoff
 * закрывают почти все короткие обрывы за 1.5-6 секунд.
 */
async function downloadTgMediaWithRetry(downloadFn: () => Promise<any>, maxAttempts = 3): Promise<Buffer | null> {
    let lastErr: any
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const buffer = await downloadFn()
            if (buffer && Buffer.isBuffer(buffer)) return buffer
            lastErr = new Error('downloadMedia returned empty/non-buffer result')
        } catch (e) {
            lastErr = e
        }
        if (attempt < maxAttempts) await new Promise(r => setTimeout(r, attempt * 1500))
    }
    throw lastErr || new Error('downloadMedia failed after retries')
}

function detectTgMediaType(message: any): { type: string; fallback: string } | null {
    if (!message.media) return null
    const mediaClass = message.media.className || ''
    if (mediaClass.includes('Photo') || message.photo) return { type: 'image', fallback: '[Фото]' }
    if (mediaClass.includes('Document')) {
        const attrs = message.media.document?.attributes || []
        for (const attr of attrs) {
            const cn = attr.className || ''
            if (cn.includes('Audio') || cn.includes('Voice')) return { type: 'voice', fallback: '[Голосовое]' }
            if (cn.includes('Video')) return { type: 'video', fallback: '[Видео]' }
            if (cn.includes('Sticker')) return { type: 'sticker', fallback: '[Стикер]' }
        }
        return { type: 'document', fallback: '[Документ]' }
    }
    if (mediaClass.includes('Geo')) return { type: 'text', fallback: '[Геолокация]' }
    if (mediaClass.includes('Contact')) return { type: 'text', fallback: '[Контакт]' }
    return { type: 'text', fallback: '[Медиа]' }
}

type TelegramPrivateIngressPhase = 'inbound' | 'mirror' | 'import'

type TelegramPrivateConversation = {
    id: string
    channel: string
    externalChatId: string
    chatType: string
    contactId: string | null
    contactIdentityId: string | null
    driverId: string | null
    metadata: unknown
}

function metadataRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
}

function concreteOpaqueId(value: unknown): string | null {
    if (typeof value !== 'string') return null
    return value !== '' && value === value.trim() && value !== 'legacy' ? value : null
}

function telegramMessageExternalId(
    providerAccountId: string,
    peerId: string,
    providerMessageId: string,
): string {
    if (
        !/^\d+$/.test(providerAccountId)
        || !/^\d+$/.test(peerId)
        || !/^\d+$/.test(providerMessageId)
        || providerAccountId === '0'
        || peerId === '0'
        || providerMessageId === '0'
    ) {
        throw new Error('TELEGRAM_MESSAGE_IDENTITY_UNPROVEN')
    }
    return `telegram:${providerAccountId}:${peerId}:${providerMessageId}`
}

function exactTelegramProviderMessageId(
    externalId: string,
    providerAccountId: string,
    peerId: string,
): string | null {
    const prefix = `telegram:${providerAccountId}:${peerId}:`
    if (!externalId.startsWith(prefix)) return null
    const raw = externalId.slice(prefix.length)
    return /^\d+$/.test(raw) && raw !== '0' ? raw : null
}

type TelegramReplyTarget = {
    messageId: number
    // A bare id from the pre-namespace lane carries no account or peer.
    legacy: boolean
}

/**
 * Parses a requested quote with this channel's own id forms: the current
 * `telegram:<account>:<peer>:<id>` for the live account and this peer, or a
 * legacy bare MTProto id. Anything else (a Bot-lane key, another account's or
 * peer's id, zero, an unsafe integer, garbage) is not addressable, and the send
 * is refused rather than silently sent without the quote.
 */
function telegramReplyTarget(
    quotedMsgId: string,
    providerAccountId: string | null,
    peerId: string | null,
): TelegramReplyTarget {
    const current = providerAccountId && peerId
        ? exactTelegramProviderMessageId(quotedMsgId, providerAccountId, peerId)
        : null
    const raw = current ?? (/^\d+$/.test(quotedMsgId) ? quotedMsgId : null)
    const messageId = raw ? Number.parseInt(raw, 10) : Number.NaN
    if (!Number.isSafeInteger(messageId) || messageId <= 0 || String(messageId) !== raw) {
        throw telegramSendError('REPLY_TARGET_NOT_ADDRESSABLE', TELEGRAM_MTPROTO_REFUSED, 'цитату нельзя адресовать в Telegram')
    }
    return { messageId, legacy: current === null }
}

/**
 * Proves, on the live client and before dispatch, that the quoted message is a
 * live message of this very dialog: GramJS answers nothing for a deleted id or
 * an id of another peer. A legacy bare id must also be the same message the
 * conversation stored under it (same provider timestamp), because the bare
 * form cannot show which account numbered it.
 */
async function proveTelegramReplyTarget(
    client: TelegramClient,
    entity: any,
    target: TelegramReplyTarget,
    chatId: string,
    quotedMsgId: string,
): Promise<number> {
    let providerMessage: any
    try {
        [providerMessage] = await client.getMessages(entity, { ids: [target.messageId] })
    } catch (error: unknown) {
        console.warn(`[TG-SEND] reply target lookup failed msgId=${target.messageId}: ${error instanceof Error ? error.message : String(error)}`)
        throw telegramSendError('REPLY_TARGET_UNVERIFIED', TELEGRAM_MTPROTO_NOT_DISPATCHED, 'цитата не проверена')
    }
    const refused = () => telegramSendError('REPLY_TARGET_NOT_ADDRESSABLE', TELEGRAM_MTPROTO_REFUSED, 'цитату нельзя адресовать в Telegram')
    if (!providerMessage || providerMessage.id !== target.messageId) throw refused()
    if (target.legacy) {
        const stored = await (prisma.message as any).findFirst({
            where: { chatId, externalId: quotedMsgId },
            select: { sentAt: true },
        })
        const providerDate = validateTgDate(providerMessage.date)
        if (!stored || !providerDate || !(stored.sentAt instanceof Date) || stored.sentAt.getTime() !== providerDate.getTime()) {
            throw refused()
        }
    }
    return target.messageId
}

async function rejectTelegramConversationCollision(
    chat: TelegramPrivateConversation,
    input: {
        phase: TelegramPrivateIngressPhase
        externalChatId: string
        peerId: string
        providerAccountId: string
        connectionId: string
    },
    reason: string,
): Promise<never> {
    const storedMetadata = metadataRecord(chat.metadata)
    const existingProviderAccountId = concreteOpaqueId(storedMetadata.providerAccountId)
    const existingConnectionId = concreteOpaqueId(storedMetadata.connectionId)
    const existingPeerId = concreteOpaqueId(storedMetadata.peerId)
    const evidence = {
        channel: 'telegram' as const,
        reason,
        phase: input.phase,
        externalChatId: input.externalChatId,
        existingExternalChatId: chat.externalChatId,
        incomingPeerId: input.peerId,
        existingPeerId,
        incomingProviderAccountId: input.providerAccountId,
        existingProviderAccountId,
        incomingConnectionId: input.connectionId,
        existingConnectionId,
    }
    // A structural contradiction is a fact about this Chat row, so it is audited
    // on the Chat only. It is never written onto the Contact as a person
    // conflict: no code closes such an entry, and an open one blocks sending,
    // reachability, driver linking and merge for that person.
    await appendConversationIdentityCollisionV1({ chatId: chat.id, evidence })
    throw new Error(`TELEGRAM_CONVERSATION_IDENTITY_COLLISION:${reason}`)
}

type TelegramPrivateConversationInput = {
    phase: TelegramPrivateIngressPhase
    peerId: string
    providerAccountId: string
    connectionId: string
    displayName: string | null
    lastMessageAt?: Date
}

/**
 * Structural Messaging admission of one private GramJS conversation: exact ids,
 * the Chat row and the contradiction ladder. It does no person work, so it is
 * the only step a provider message waits for before it is persisted.
 */
async function upsertTelegramPrivateConversation(
    input: TelegramPrivateConversationInput,
): Promise<TelegramPrivateConversation> {
    const peerId = concreteOpaqueId(input.peerId)
    const providerAccountId = concreteOpaqueId(input.providerAccountId)
    const connectionId = concreteOpaqueId(input.connectionId)
    if (!peerId || !/^\d+$/.test(peerId) || peerId === '0') {
        throw new Error('TELEGRAM_PEER_ID_UNPROVEN')
    }
    if (!providerAccountId || providerAccountId !== input.providerAccountId) {
        throw new Error('TELEGRAM_PROVIDER_ACCOUNT_ID_UNPROVEN')
    }
    if (!connectionId || connectionId !== input.connectionId) {
        throw new Error('TELEGRAM_CONNECTION_ID_UNPROVEN')
    }

    const externalChatId = `telegram:${peerId}`
    const admitted = await upsertChannelConversationV1({
        contract: UPSERT_CHANNEL_CONVERSATION_COMMAND_V1,
        externalChatId,
        channel: 'telegram',
        name: input.displayName ?? `TG ${peerId}`,
        chatType: 'private',
        metadata: {
            chatKind: 'private',
            peerId,
            providerAccountId,
            connectionId,
        },
    })
    const chat = admitted.conversation as TelegramPrivateConversation
    const storedMetadata = metadataRecord(chat.metadata)
    const storedPeerId = concreteOpaqueId(storedMetadata.peerId)
    // Each arm rejects only on a CONTRADICTION that production rows can actually
    // express. A stored value that is simply absent is a legacy compatibility
    // state: those rows predate transport/peer stamping, and the conversation
    // adapter never writes metadata onto an existing row, so an "unproven" arm
    // would fire forever on every one of them and could never self-heal.
    // Measured 2026-09-12 over 167 production telegram Chat rows: 0 carry
    // providerAccountId, 0 carry peerId, 0 carry chatKind, 109 carry
    // connectionId, and all 167 carry chatType='private'.
    // Provider-account comparison is gone entirely: see
    // docs/design/provider-account-identity-v1.md.
    // The transport-connection arm is gone as well, as it already is on the Bot
    // lane: a Chat is the peer conversation shared by both Telegram transports,
    // so a stored connection naming another transport or a replaced personal
    // account is not a contradiction about whose conversation this is.
    const reason = chat.channel !== 'telegram'
        ? 'channel_mismatch'
        : chat.externalChatId !== externalChatId
            ? 'conversation_key_mismatch'
            // A stored peer that disagrees means this conversation belongs to
            // somebody else. This is the cross-peer guard and it stays exact.
            : storedPeerId !== null && storedPeerId !== peerId
                ? 'peer_identity_mismatch'
                // chatType is carried by every production row; chatKind is
                // only compared when the row actually has one.
                : chat.chatType !== 'private'
                    || (storedMetadata.chatKind !== undefined && storedMetadata.chatKind !== 'private')
                    ? 'chat_kind_mismatch'
                    : null
    if (reason) {
        await rejectTelegramConversationCollision(chat, {
            phase: input.phase,
            externalChatId,
            peerId,
            providerAccountId,
            connectionId,
        }, reason)
    }

    const patched = await patchChannelConversationV1({
        contract: PATCH_CHANNEL_CONVERSATION_COMMAND_V1,
        selector: { chatId: chat.id },
        patch: {
            name: input.displayName ?? `TG ${peerId}`,
            ...(input.lastMessageAt ? { lastMessageAt: input.lastMessageAt } : {}),
        },
    })
    return patched.conversation as TelegramPrivateConversation
}

/**
 * Person enrichment of an already persisted provider event: Contact
 * resolution, the conversation link and, for live inbound only, reachability.
 * Every caller runs it after the Message is stored, so a contradiction here
 * (a driver-bound Chat, an ambiguous or locked Contact) is an enrichment
 * outcome reported by the caller and never makes the message disappear.
 * Contact Identity owns the outcome; Messaging neither repairs nor records it
 * as a person conflict.
 */
async function admitTelegramPrivateConversation(
    input: TelegramPrivateConversationInput,
): Promise<TelegramPrivateConversation> {
    // Re-admits the exact Chat (idempotent): the structural ladder holds for
    // the enrichment step too, and the peer id is proven before it is used.
    const chat = await upsertTelegramPrivateConversation(input)
    const contactResult = await resolveChannelContactOperationV1(
        'telegram',
        input.peerId,
        null,
        input.displayName,
        { chatKind: 'private', providerAccountId: input.providerAccountId },
    )
    if (
        !isResolvedChannelContactResultV1(contactResult)
        || !contactResult.identity
        || contactResult.identity.channel !== 'telegram'
        || contactResult.identity.externalId !== input.peerId
    ) {
        throw new Error(`CONTACT_RESOLUTION_BLOCKED:${contactResult.status}`)
    }
    await ensureConversationContactLinkV1({
        contract: ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1,
        chatId: chat.id,
        contactId: contactResult.contact.id,
        contactIdentityId: contactResult.identity.id,
    })
    if (input.phase === 'inbound') {
        await contactReachabilityV1.recordExactProviderReachability({
            identityId: contactResult.identity.id,
            contactId: contactResult.contact.id,
            channel: 'telegram',
            providerAccountId: input.providerAccountId,
            providerTargetId: input.peerId,
            status: 'confirmed',
        })
    }
    return chat
}

// Telegram's own service account: login codes and security notices.
const TELEGRAM_SERVICE_NOTIFICATIONS_PEER_ID = '777000'

/**
 * A private dialog that is not a person: the account's own Saved Messages,
 * Telegram's service account, or a bot. None of them is a contact, and a login
 * code from 777000 must never reach an operator. The bot flag is read only
 * from an entity GramJS already holds; no lookup is made to classify a peer.
 */
function telegramNonPersonPeerReason(
    peerId: string,
    providerAccountId: string,
    entity: unknown,
): 'self' | 'service' | 'bot' | null {
    if (peerId === providerAccountId) return 'self'
    if (peerId === TELEGRAM_SERVICE_NOTIFICATIONS_PEER_ID) return 'service'
    if (entity && typeof entity === 'object' && (entity as { bot?: unknown }).bot === true) return 'bot'
    return null
}

/**
 * Inbound dedupe is by provider key only: the exact current id, or the exact
 * legacy bare id (the raw MTProto id the pre-namespace lane stored) in this
 * same conversation. Message ids in one account's private dialog are unique
 * across both directions, so the legacy arm cannot match another message. A
 * content/time window is never a key: it dropped genuine repeats (the same
 * word twice, two uncaptioned photos) and missed reworded duplicates.
 */
function telegramInboundKeyArms(
    conversationId: string,
    storedExternalId: string,
    rawProviderMessageId: string | undefined,
): Array<Record<string, string>> {
    return [
        { externalId: storedExternalId },
        ...(rawProviderMessageId ? [{ chatId: conversationId, externalId: rawProviderMessageId }] : []),
    ]
}

function isUniqueConstraintViolation(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && (error as { code?: unknown }).code === 'P2002'
}

/**
 * Inserts one provider message. A unique violation on its exact provider key
 * means another path (the listener, a catch-up run or an import) stored this
 * very event first, so it is a duplicate, not a failure. It is accepted as one
 * only when the exact key is then found; any other violation is rethrown.
 */
async function createTelegramProviderMessage(input: {
    chatId: string
    direction: 'inbound' | 'outbound'
    content: string
    type: string
    sentAt: Date
    externalId: string
    metadata: Record<string, string>
}): Promise<any | null> {
    try {
        const created = await createChannelMessageV1({
            contract: CREATE_CHANNEL_MESSAGE_COMMAND_V1,
            chatId: input.chatId,
            direction: input.direction,
            content: input.content,
            channel: 'telegram',
            type: input.type as any,
            sentAt: input.sentAt,
            // An inbound row is the peer's message and is stored as delivered,
            // as always. An outbound row is written as sent: only delivery
            // evidence applied through Messaging may claim more for it.
            ...(input.direction === 'inbound' ? { status: 'delivered' as const } : {}),
            externalId: input.externalId,
            metadata: input.metadata,
        })
        return created.message
    } catch (error: unknown) {
        if (!isUniqueConstraintViolation(error)) throw error
        const stored = await (prisma.message as any).findFirst({
            where: { externalId: input.externalId },
            select: { id: true },
        })
        if (!stored) throw error
        return null
    }
}

type TelegramOutboundObservationEvidence = 'provider_echo' | 'history_readback'

type TelegramOutboundObservation = {
    outcome: 'existing' | 'created' | 'refused'
    messageId: string | null
    row: any | null
}

/**
 * Records an outbound message the provider showed us: a live echo of a message
 * this account sent (from the CRM or from any other Telegram client), or a
 * history read-back of one. Delivery evidence goes only through Messaging's
 * evidence command (S2), which matches the exact provider id first, then the
 * oldest unsettled CRM send of this text in this conversation, and only ever
 * strengthens a row. A legacy row stored under the bare MTProto id in this
 * conversation is the same message and is never written again.
 *
 * A message the CRM has no row for is created as `sent` and then given the
 * same evidence: the provider holds it, and a Telegram user account receives
 * no proof that it reached the recipient's device.
 */
async function observeTelegramOutboundMessage(input: {
    chatId: string
    providerMessageId: string | null
    rawProviderMessageId: string | undefined
    fallbackExternalId: string
    content: string
    type: string
    sentAt: Date
    metadata: Record<string, string>
    evidence: TelegramOutboundObservationEvidence
    loggerPrefix: string
}): Promise<TelegramOutboundObservation> {
    if (input.rawProviderMessageId) {
        const legacy = await (prisma.message as any).findFirst({
            where: { chatId: input.chatId, externalId: input.rawProviderMessageId },
            select: { id: true },
        })
        if (legacy) return { outcome: 'existing', messageId: legacy.id, row: null }
    }

    const applyEvidence = (withContent: boolean) => applyMessageDeliveryEvidenceV1({
        contract: PATCH_MESSAGE_DELIVERY_COMMAND_V2,
        chatId: input.chatId,
        channel: 'telegram',
        providerMessageId: input.providerMessageId!,
        evidence: input.evidence,
        // Only text can be matched to an unsettled CRM send by its content.
        ...(withContent && input.type === 'text' ? { content: input.content } : {}),
        providerSentAt: input.sentAt,
    })

    if (input.providerMessageId) {
        const matched = await applyEvidence(true)
        if (matched.outcome === 'applied' || matched.outcome === 'unchanged') {
            return { outcome: 'existing', messageId: matched.messageId, row: null }
        }
        if (matched.outcome === 'refused') {
            if (matched.reason !== 'provider_id_collision') {
                throw new Error(`TELEGRAM_DELIVERY_EVIDENCE_REFUSED:${matched.reason}`)
            }
            // Another conversation, direction or channel already holds this
            // provider id: recording it here would claim a second message.
            console.warn(`[${input.loggerPrefix}] echo refused: provider id ${input.providerMessageId} belongs to another message`)
            const opsLog = await loadTelegramOpsLog()
            opsLog('warn', 'telegram_mtproto_echo_refused', {
                channel: 'telegram',
                chatId: input.chatId,
                reason: matched.reason,
            })
            return { outcome: 'refused', messageId: null, row: null }
        }
    }

    const row = await createTelegramProviderMessage({
        chatId: input.chatId,
        direction: 'outbound',
        content: input.content,
        type: input.type,
        sentAt: input.sentAt,
        externalId: input.providerMessageId ?? input.fallbackExternalId,
        metadata: input.metadata,
    })
    if (!row) return { outcome: 'existing', messageId: null, row: null }
    if (input.providerMessageId) {
        const recorded = await applyEvidence(false)
        if (recorded.outcome !== 'applied') {
            // The row stays `sent` without evidence (it claims less, never
            // more); the next observation of this id applies it.
            console.warn(`[${input.loggerPrefix}] evidence not yet recorded for ${input.providerMessageId}: ${recorded.outcome}`)
        }
    }
    return { outcome: 'created', messageId: row.id, row }
}

// Bounds one read marker's work to the most recent unread outbound rows.
const TG_READ_RECEIPT_SCAN_LIMIT = 200

/**
 * Applies the peer's read marker: Telegram reports that the recipient read
 * every message this account sent in the dialog up to `maxId`. Each such row
 * gets a `read_receipt` through Messaging's evidence command, which applies it
 * only when stronger. Only rows carrying this account's exact current id for
 * this peer are addressed; a legacy bare id cannot show which account numbered
 * it. Returns how many rows the receipt promoted.
 */
async function applyTelegramReadReceipts(input: {
    providerAccountId: string
    peerId: string
    maxId: number
}): Promise<number> {
    const chat = await (prisma.chat as any).findUnique({
        where: { externalChatId: `telegram:${input.peerId}` },
        select: { id: true, channel: true },
    })
    if (!chat || chat.channel !== 'telegram') return 0
    const rows = await (prisma.message as any).findMany({
        where: {
            chatId: chat.id,
            direction: 'outbound',
            channel: 'telegram',
            status: { not: 'read' },
            externalId: { startsWith: `telegram:${input.providerAccountId}:${input.peerId}:` },
        },
        select: { externalId: true },
        orderBy: { sentAt: 'desc' },
        take: TG_READ_RECEIPT_SCAN_LIMIT,
    })
    let promoted = 0
    for (const row of rows) {
        const raw = exactTelegramProviderMessageId(row.externalId, input.providerAccountId, input.peerId)
        const messageId = raw ? Number.parseInt(raw, 10) : Number.NaN
        if (!Number.isSafeInteger(messageId) || messageId > input.maxId) continue
        const applied = await applyMessageDeliveryEvidenceV1({
            contract: PATCH_MESSAGE_DELIVERY_COMMAND_V2,
            chatId: chat.id,
            channel: 'telegram',
            providerMessageId: row.externalId,
            evidence: 'read_receipt',
        })
        if (applied.outcome === 'applied') promoted++
    }
    return promoted
}

/** Telegram's read marker for messages this account sent: UpdateReadHistoryOutbox. */
async function processReadHistoryOutbox(
    event: any,
    connectionId: string,
    providerAccountId: string,
) {
    try {
        const peerId = event?.peer?.userId?.toString()
        const maxId = Number(event?.maxId)
        if (!peerId || !/^\d+$/.test(peerId) || !Number.isSafeInteger(maxId) || maxId <= 0) return
        if (telegramNonPersonPeerReason(peerId, providerAccountId, null)) return
        const promoted = await applyTelegramReadReceipts({ providerAccountId, peerId, maxId })
        if (promoted > 0) console.log(`[TG-READ] conn=${connectionId} peer=${peerId} maxId=${maxId} read=${promoted}`)
    } catch (err: any) {
        console.error(`[TG-READ] Error (conn=${connectionId}):`, err.message)
    }
}

type TelegramIngressReceipt = {
    outcome: 'saved' | 'duplicate' | 'skipped'
    chatId: string | null
    messageId: string | null
    // Side effects of a newly stored message (workflow, live stream, AI
    // pipeline). They run after enrichment, or after it is blocked.
    publish: (() => void) | null
}

function telegramIngressReceipt(): TelegramIngressReceipt {
    return { outcome: 'skipped', chatId: null, messageId: null, publish: null }
}

function publishTelegramIngress(receipt: TelegramIngressReceipt): void {
    const publish = receipt.publish
    receipt.publish = null
    publish?.()
}

// One lazy load of the operational log, shared by the structured events below.
async function loadTelegramOpsLog() {
    const { operationalLogV1 } = await import('@/infrastructure/operations/operational-log')
    return operationalLogV1
}

async function reportTelegramEnrichmentBlocked(input: {
    phase: TelegramPrivateIngressPhase
    connectionId: string
    chatId: string | null
    messageId: string | null
    error: unknown
}): Promise<void> {
    const error = input.error instanceof Error ? input.error.message : String(input.error)
    console.warn(`[TG-ENRICH] enrichment_blocked phase=${input.phase} conn=${input.connectionId} chat=${input.chatId} message=${input.messageId}: ${error}`)
    const opsLog = await loadTelegramOpsLog()
    opsLog('warn', 'telegram_mtproto_enrichment_blocked', {
        channel: 'telegram',
        phase: input.phase,
        connectionId: input.connectionId,
        chatId: input.chatId ?? undefined,
        messageId: input.messageId ?? undefined,
        error,
    })
}

type TelegramIngestResult = {
    outcome: TelegramIngressReceipt['outcome']
    enrichment: 'linked' | 'blocked' | 'not_run'
}

/**
 * The one entry for a GramJS message event, live or replayed by catch-up.
 * A throw before the message is stored is a real failure and propagates. A
 * throw after it is stored can only come from person enrichment: the message
 * stays, the outcome is reported, and its side effects still run.
 */
async function ingestTelegramProviderMessage(
    message: any,
    connectionId: string,
    providerAccountId: string,
    source: 'live' | 'catchup',
): Promise<TelegramIngestResult> {
    const receipt = telegramIngressReceipt()
    const phase: TelegramPrivateIngressPhase = message?.out
        ? 'mirror'
        : source === 'live' ? 'inbound' : 'import'
    try {
        if (message?.out) {
            await processOutboundMirrorMessage(
                message,
                connectionId,
                providerAccountId,
                source === 'live' ? 'TG-MIRROR' : 'TG-CATCHUP-OUT',
                receipt,
                source === 'live' ? 'provider_echo' : 'history_readback',
            )
        } else {
            await processInboundTelegramMessage(
                message,
                connectionId,
                providerAccountId,
                source === 'live' ? 'TG-LISTENER' : 'TG-CATCHUP',
                phase === 'inbound' ? 'inbound' : 'import',
                receipt,
            )
        }
        return {
            outcome: receipt.outcome,
            enrichment: receipt.outcome === 'saved' ? 'linked' : 'not_run',
        }
    } catch (error: unknown) {
        if (receipt.outcome !== 'saved') throw error
        await reportTelegramEnrichmentBlocked({
            phase,
            connectionId,
            chatId: receipt.chatId,
            messageId: receipt.messageId,
            error,
        })
        publishTelegramIngress(receipt)
        return { outcome: 'saved', enrichment: 'blocked' }
    }
}

async function processInboundTelegramMessage(
    message: any,
    connectionId: string,
    providerAccountId: string,
    loggerPrefix = 'TG-LISTENER',
    phase: 'inbound' | 'import' = 'inbound',
    receipt: TelegramIngressReceipt = telegramIngressReceipt(),
) {
    if (message && !message.out) {
        // Only PeerUser denotes a private conversation. A group/channel update
        // may still have fromId.userId; treating that sender as the dialog peer
        // would manufacture a private Chat from a room message.
        const senderId = message.peerId?.userId?.toString()
        const mediaInfo = detectTgMediaType(message)
        const text = message.message || (mediaInfo ? mediaInfo.fallback : '')
        if (!senderId || !text) return

        const nonPerson = telegramNonPersonPeerReason(
            senderId,
            providerAccountId,
            message.sender ?? message.chat,
        )
        if (nonPerson) {
            console.log(`[${loggerPrefix}] SKIP non-person peer=${senderId} reason=${nonPerson}`)
            return
        }

        const rawExternalMsgId = message.id?.toString()
        const externalMsgId = rawExternalMsgId
            ? telegramMessageExternalId(providerAccountId, senderId, rawExternalMsgId)
            : null
        // Validate message.date — corrupted timestamps (Y2038 overflow,
        // pre-2013) would wreck chronology. If we can't trust the date,
        // drop the message rather than file it under "now".
        const validated = validateTgDate(message.date)
        if (!validated) {
            console.warn(`[${loggerPrefix}] skip bad-ts msgId=${externalMsgId} date=${message.date}`)
            return
        }
        const now = validated

        console.log(`[${loggerPrefix}] INBOUND connId=${connectionId} senderId=${senderId} msgId=${externalMsgId} text="${text.substring(0, 30)}"`)

        // Derive display name from GramJS sender entity
        const senderName = (() => {
            const fn = (message.sender?.firstName ?? '').trim()
            const ln = (message.sender?.lastName  ?? '').trim()
            const full = [fn, ln].filter(Boolean).join(' ').trim()
            if (/[А-Яа-яA-Za-z]/.test(full) && !/^[.\s\-_$]+$/.test(full)) return full
            if (message.sender?.username) return `@${message.sender.username}`
            return null
        })()

        // PERSIST FIRST. Structural admission of the exact provider account,
        // connection and peer is the only step before the Message is stored;
        // no Contact or Driver outcome can make a valid provider event vanish.
        const conversation = await upsertTelegramPrivateConversation({
            phase,
            peerId: senderId,
            providerAccountId,
            connectionId,
            displayName: senderName,
            lastMessageAt: now,
        })
        receipt.chatId = conversation.id
        const storedExternalId = externalMsgId || `telegram:${providerAccountId}:${senderId}:local-${now.getTime()}`

        // 3. DE-DUPLICATION: by the exact provider key only
        const existing = await (prisma.message as any).findFirst({
            where: { OR: telegramInboundKeyArms(conversation.id, storedExternalId, rawExternalMsgId) },
        })

        if (existing) {
            console.log(`[${loggerPrefix}] DB-DEDUP: skipped msgId=${externalMsgId} (existing=${existing.id})`)
            receipt.outcome = 'duplicate'
            receipt.messageId = existing.id
            // Self-heal: if a prior attempt created the message but the media
            // download failed (e.g. connection dropped mid-deploy), retry it
            // here — this path re-runs on every catchup/restart, so a message
            // stuck without an attachment gets another chance each time.
            if (mediaInfo && message.downloadMedia) {
                try {
                    const attCount = await (prisma.messageAttachment as any).count({ where: { messageId: existing.id } })
                    if (attCount === 0) {
                        const client = clientCache.get(connectionId)
                        if (client) {
                            const buffer = await downloadTgMediaWithRetry(() => client.downloadMedia(message, {}))
                            if (buffer) {
                                const mimeType = message.media?.document?.mimeType ||
                                    (mediaInfo.type === 'image' ? 'image/jpeg' : 'application/octet-stream')
                                const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`
                                const fileName = message.media?.document?.attributes?.find((a: any) => a.fileName)?.fileName || null
                                await attachMessageMediaV1({ contract: ATTACH_MESSAGE_MEDIA_COMMAND_V1, messageId: existing.id, mediaType: mediaInfo.type, url: dataUrl, fileName, fileSize: buffer.length, mimeType })
                                console.log(`[${loggerPrefix}] MEDIA retry-saved for existing msg=${existing.id}`)
                            }
                        }
                    }
                } catch (retryErr: any) {
                    console.error(`[${loggerPrefix}] MEDIA retry failed for existing msg=${existing.id}:`, retryErr.message)
                }
            }
            return
        }

        const msgType = mediaInfo?.type || 'text'
        const savedMsg = await createTelegramProviderMessage({ chatId: conversation.id, direction: 'inbound', content: text, type: msgType, sentAt: now, externalId: storedExternalId, metadata: rawExternalMsgId ? { providerMessageId: rawExternalMsgId, providerAccountId, peerId: senderId } : {} })
        if (!savedMsg) {
            console.log(`[${loggerPrefix}] DB-DEDUP: insert race on msgId=${externalMsgId}`)
            receipt.outcome = 'duplicate'
            return
        }
        // Durable from here on. Anything that throws below is enrichment.
        receipt.outcome = 'saved'
        receipt.messageId = savedMsg.id
        receipt.publish = () => {
            ConversationWorkflowService.onInboundMessage(conversation.id, now).catch(e =>
                console.error(`[${loggerPrefix}] onInboundMessage error:`, e.message)
            )
            emitMessageReceived(savedMsg).catch(e =>
                console.error(`[${loggerPrefix}] emitMessageReceived error:`, e.message)
            )
        }

        // Download and save media attachment (photo, voice, video, document, sticker)
        if (mediaInfo && msgType !== 'text' && message.downloadMedia) {
            try {
                const client = clientCache.get(connectionId)
                if (client) {
                    const buffer = await downloadTgMediaWithRetry(() => client.downloadMedia(message, {}))
                    if (buffer) {
                        const mimeType = message.media?.document?.mimeType ||
                            (msgType === 'image' ? 'image/jpeg' : 'application/octet-stream')
                        const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`
                        const fileName = message.media?.document?.attributes?.find((a: any) => a.fileName)?.fileName || null
                        await attachMessageMediaV1({ contract: ATTACH_MESSAGE_MEDIA_COMMAND_V1, messageId: savedMsg.id, mediaType: msgType, url: dataUrl, fileName, fileSize: buffer.length, mimeType })
                        console.log(`[${loggerPrefix}] MEDIA saved: ${msgType} ${mimeType} for msg=${savedMsg.id}`)
                    }
                }
            } catch (mediaErr: any) {
                console.error(`[${loggerPrefix}] Media download failed for msg=${savedMsg.id}:`, mediaErr.message)
            }
        }

        // ENRICH. Contact, conversation link and live reachability, after the
        // message is already durable. A throw here is reported by the caller
        // as enrichment_blocked and the stored message stays.
        const unifiedChat = await admitTelegramPrivateConversation({
            phase,
            peerId: senderId,
            providerAccountId,
            connectionId,
            displayName: senderName,
            lastMessageAt: now,
        })

        console.log(`[${loggerPrefix}] SAVED inbound msgId=${externalMsgId} chat=${unifiedChat.id} driver=${unifiedChat.driverId || 'none'}`)
        publishTelegramIngress(receipt)
    }
}

/**
 * Mirrors outbound messages sent from any Telegram client (not via CRM).
 * Called when GramJS fires NewMessage with message.out === true.
 *
 * Dedup strategy:
 *   1. Check externalId (set by sendTelegramMessage if CRM sent it)
 *   2. Check content+time within 30s (handles race: GramJS fires before DB update)
 *   3. If found → update externalId if missing, skip create
 *   4. If not found → external send, create new outbound message
 */
async function processOutboundMirrorMessage(
    message: any,
    connectionId: string,
    providerAccountId: string,
    loggerPrefix = 'TG-MIRROR',
    receipt: TelegramIngressReceipt = telegramIngressReceipt(),
    // A live echo, or a history read-back during catch-up.
    evidence: TelegramOutboundObservationEvidence = 'provider_echo',
) {
    if (!message?.out) return

    // Recipient = the person we're writing TO (only private chats)
    const recipientId = message.peerId?.userId?.toString()
    if (!recipientId) return  // group/channel — skip

    const mediaInfo = detectTgMediaType(message)
    const text = message.message || (mediaInfo ? mediaInfo.fallback : '')
    // Skip only if there's truly nothing to save (no text, no media)
    if (!text && !mediaInfo) return

    const rawExternalMsgId = message.id?.toString()
    const externalMsgId = rawExternalMsgId
        ? telegramMessageExternalId(providerAccountId, recipientId, rawExternalMsgId)
        : null
    const validated = validateTgDate(message.date)
    if (!validated) return
    const sentAt = validated

    let recipient: any = message.chat ?? null
    if (!recipient && typeof message.getChat === 'function') {
        try { recipient = await message.getChat() } catch { /* display name remains optional */ }
    }
    const nonPerson = telegramNonPersonPeerReason(recipientId, providerAccountId, recipient)
    if (nonPerson) {
        console.log(`[${loggerPrefix}] SKIP non-person peer=${recipientId} reason=${nonPerson}`)
        return
    }
    const recipientName = (() => {
        const firstName = (recipient?.firstName ?? '').trim()
        const lastName = (recipient?.lastName ?? '').trim()
        const fullName = [firstName, lastName].filter(Boolean).join(' ').trim()
        if (fullName) return fullName
        if (recipient?.username) return `@${recipient.username}`
        return null
    })()

    // Mirrored messages are provider observations too, and they are persisted
    // first. Only structural admission precedes the write; the person link is
    // re-proven on every new event, after it.
    const conversation = await upsertTelegramPrivateConversation({
        phase: 'mirror',
        peerId: recipientId,
        providerAccountId,
        connectionId,
        displayName: recipientName,
        lastMessageAt: sentAt,
    })
    receipt.chatId = conversation.id

    const msgType = mediaInfo?.type || 'text'

    // Echo matching is Messaging's: the exact provider id, then the oldest
    // unsettled CRM send of this text here. A message the CRM never sent is
    // written once, as sent, with this evidence.
    const observed = await observeTelegramOutboundMessage({
        chatId: conversation.id,
        providerMessageId: externalMsgId,
        rawProviderMessageId: rawExternalMsgId,
        fallbackExternalId: `telegram:${providerAccountId}:${recipientId}:local-${sentAt.getTime()}`,
        content: text,
        type: msgType,
        sentAt,
        metadata: rawExternalMsgId ? { providerMessageId: rawExternalMsgId, providerAccountId, peerId: recipientId } : {},
        evidence,
        loggerPrefix,
    })

    if (observed.outcome !== 'created') {
        if (observed.messageId) await ensureOutboundTelegramAttachment(message, observed.messageId, msgType, loggerPrefix)
        console.log(`[${loggerPrefix}] DEDUP: msgId=${externalMsgId} ${observed.outcome} (existing=${observed.messageId})`)
        receipt.outcome = observed.outcome === 'refused' ? 'skipped' : 'duplicate'
        receipt.messageId = observed.messageId
        return
    }
    const saved = observed.row
    // Durable from here on. Anything that throws below is enrichment.
    receipt.outcome = 'saved'
    receipt.messageId = saved.id
    receipt.publish = () => {
        emitMessageReceived(saved).catch(e =>
            console.error(`[${loggerPrefix}] emitMessageReceived error:`, e.message)
        )
    }

    await ensureOutboundTelegramAttachment(message, saved.id, msgType, loggerPrefix)

    const chat = await admitTelegramPrivateConversation({
        phase: 'mirror',
        peerId: recipientId,
        providerAccountId,
        connectionId,
        displayName: recipientName,
        lastMessageAt: sentAt,
    })

    console.log(`[${loggerPrefix}] MIRRORED outbound msgId=${externalMsgId} type=${msgType} chat=${chat.id}`)
    publishTelegramIngress(receipt)
}

async function ensureOutboundTelegramAttachment(
    message: any,
    messageId: string,
    msgType: string,
    loggerPrefix: string,
): Promise<void> {
    if (msgType === 'text' || !message.downloadMedia) return

    try {
        const existingAttachment = await (prisma.messageAttachment as any).findFirst({
            where: { messageId },
            select: { id: true },
        })
        if (existingAttachment) return

        const buffer = await downloadTgMediaWithRetry(() =>
            message.downloadMedia({ progressCallback: null }),
        )
        if (!buffer) return

        const mimeType = message.media?.document?.mimeType
            || (msgType === 'image' ? 'image/jpeg' : 'application/octet-stream')
        const fileName = message.media?.document?.attributes
            ?.find((attribute: any) => attribute.fileName)?.fileName || null
        await attachBinaryMessageMediaV1({
            contract: ATTACH_BINARY_MESSAGE_MEDIA_COMMAND_V1,
            messageId,
            mediaType: msgType,
            mimeType,
            fileName,
            data: buffer,
        })
    } catch (mediaErr: any) {
        console.error(`[${loggerPrefix}] Media download failed:`, mediaErr.message)
    }
}

async function catchUpMissedMessages(
    client: TelegramClient,
    connectionId: string,
    providerAccountId: string,
    mode: TelegramCatchUpMode = 'manual',
): Promise<TelegramCatchUpSummary> {
    const startedAt = Date.now()
    const summary: TelegramCatchUpSummary = {
        connectionId,
        mode,
        dialogs: 0,
        skippedDialogs: 0,
        failedDialogs: 0,
        messages: 0,
        saved: 0,
        duplicates: 0,
        skipped: 0,
        enrichmentBlocked: 0,
        failed: 0,
        readReceipts: 0,
        durationMs: 0,
        error: null,
    }
    try {
        console.log(`[TG-CATCHUP] Fetching recent dialogs for connectionId=${connectionId} mode=${mode}`)
        const dialogs = await client.getDialogs({ limit: TG_CATCHUP_DIALOG_LIMITS[mode] })
        for (const dialog of dialogs) {
            if (!dialog.isUser) continue
            const peerId = dialog.entity?.id?.toString()
            if (peerId && telegramNonPersonPeerReason(peerId, providerAccountId, dialog.entity)) {
                summary.skippedDialogs++
                continue
            }
            summary.dialogs++
            // Each dialog and each message is isolated: one failure is counted
            // and the run continues, so a single contradiction can no longer
            // abort recovery of every dialog after it.
            let messages: any[]
            try {
                // Telegram Web may mark a message read before CRM reconnects. Replay
                // a bounded recent window in both directions; processors dedupe by
                // stable provider message id.
                const total = Math.min(Math.max((dialog.unreadCount || 0) + 10, 20), 50)
                messages = await client.getMessages(dialog.entity, { limit: total })
            } catch (dialogErr: unknown) {
                summary.failedDialogs++
                console.error(`[TG-CATCHUP] Dialog failed conn=${connectionId} peer=${peerId}: ${dialogErr instanceof Error ? dialogErr.message : String(dialogErr)}`)
                continue
            }
            for (const msg of messages.reverse()) {
                summary.messages++
                try {
                    const result = await ingestTelegramProviderMessage(msg, connectionId, providerAccountId, 'catchup')
                    if (result.outcome === 'saved') summary.saved++
                    else if (result.outcome === 'duplicate') summary.duplicates++
                    else summary.skipped++
                    if (result.enrichment === 'blocked') summary.enrichmentBlocked++
                } catch (messageErr: unknown) {
                    summary.failed++
                    console.error(`[TG-CATCHUP] Message failed conn=${connectionId} peer=${peerId} msgId=${msg?.id}: ${messageErr instanceof Error ? messageErr.message : String(messageErr)}`)
                }
            }
            // The dialog's read marker recovers read receipts missed while
            // the client was down (UpdateReadHistoryOutbox is not replayed).
            const readOutboxMaxId = Number(dialog.dialog?.readOutboxMaxId)
            if (peerId && Number.isSafeInteger(readOutboxMaxId) && readOutboxMaxId > 0) {
                try {
                    summary.readReceipts += await applyTelegramReadReceipts({ providerAccountId, peerId, maxId: readOutboxMaxId })
                } catch (readErr: unknown) {
                    console.warn(`[TG-CATCHUP] Read marker not applied conn=${connectionId} peer=${peerId}: ${readErr instanceof Error ? readErr.message : String(readErr)}`)
                }
            }
        }
    } catch (err: unknown) {
        summary.error = err instanceof Error ? err.message : String(err)
    }
    summary.durationMs = Date.now() - startedAt
    const clean = !summary.error && summary.failed === 0 && summary.failedDialogs === 0
    console[clean ? 'log' : 'warn'](`[TG-CATCHUP] Summary ${JSON.stringify(summary)}`)
    const opsLog = await loadTelegramOpsLog()
    opsLog(clean ? 'info' : 'warn', 'telegram_mtproto_catchup_summary', {
        channel: 'telegram',
        ...summary,
        error: summary.error ?? undefined,
    })
    return summary
}

// Startup and an explicit resume replay deep enough to cover a restart and to
// warm GramJS's peer cache; a reconnect and the periodic run replay the
// recently active dialogs only.
const TG_CATCHUP_DIALOG_LIMITS: Record<TelegramCatchUpMode, number> = {
    startup: 100,
    manual: 100,
    reconnect: 30,
    periodic: 30,
}
const TG_CATCHUP_PERIOD_MS = 10 * 60 * 1000

/**
 * Single-flight catch-up per connection: a concurrent request joins the run in
 * progress instead of starting another getDialogs. Never rejects.
 */
function runTelegramCatchUp(
    client: TelegramClient,
    connectionId: string,
    providerAccountId: string,
    mode: TelegramCatchUpMode,
): Promise<TelegramCatchUpSummary> {
    const inFlight = tgRuntime.catchUps.get(connectionId)
    if (inFlight) return inFlight
    tgRuntime.lastCatchUpAt.set(connectionId, Date.now())
    const run: Promise<TelegramCatchUpSummary> = catchUpMissedMessages(client, connectionId, providerAccountId, mode)
        .finally(() => {
            if (tgRuntime.catchUps.get(connectionId) === run) tgRuntime.catchUps.delete(connectionId)
        })
    tgRuntime.catchUps.set(connectionId, run)
    return run
}

/** Periodic recovery while connected: covers updates GramJS dropped silently. */
function runPeriodicTelegramCatchUp(client: TelegramClient, connectionId: string): void {
    const providerAccountId = tgProviderAccountIds.get(connectionId)
    if (!providerAccountId) return
    const lastAt = tgRuntime.lastCatchUpAt.get(connectionId) ?? 0
    if (Date.now() - lastAt < TG_CATCHUP_PERIOD_MS) return
    void runTelegramCatchUp(client, connectionId, providerAccountId, 'periodic')
}

/**
 * Attaches the NewMessage listener to a client. Idempotent per connectionId.
 */
/**
 * Водитель ставит реакцию на сообщение в Telegram → сервер шлёт
 * UpdateMessageReactions (НЕ обычный NewMessage). Без этого обработчика
 * реакции от собеседника были видны в самом Telegram, но не в CRM.
 * Формат хранения — тот же {emoji: count} в Message.metadata.reactions,
 * что уже использует /api/messages/reaction для НАШИХ исходящих реакций.
 */
async function processReactionUpdate(
    event: any,
    connectionId: string,
    providerAccountId: string,
) {
    try {
        const msgId = event.msgId
        const peerId = event.peer?.userId?.toString()
            ?? event.peerId?.userId?.toString()
        if (msgId == null || !peerId) return
        const rawMessageId = String(msgId)
        const externalId = telegramMessageExternalId(providerAccountId, peerId, rawMessageId)

        const message = await (prisma.message as any).findUnique({
            where: { externalId },
            select: {
                id: true,
                chatId: true,
                metadata: true,
                chat: { select: { channel: true, externalChatId: true, metadata: true } },
            },
        })
        if (!message) return // не наше сообщение (другой чат/история) — пропускаем
        const chatMetadata = metadataRecord(message.chat?.metadata)
        if (
            message.chat?.channel !== 'telegram'
            || message.chat.externalChatId !== `telegram:${peerId}`
            || chatMetadata.providerAccountId !== providerAccountId
            || chatMetadata.connectionId !== connectionId
            || chatMetadata.peerId !== peerId
        ) return

        const results = event.reactions?.results || []
        const reactionsMap: Record<string, number> = {}
        for (const r of results) {
            const emoji = r.reaction?.emoticon
            if (emoji) reactionsMap[emoji] = r.count
        }

        const updatedMetadata = { ...((message.metadata as Record<string, any>) || {}), reactions: reactionsMap }
        await patchMessageMetadataV1({ contract: PATCH_MESSAGE_METADATA_COMMAND_V1, messageId: message.id, metadata: updatedMetadata })

        const { broadcastChatMessageV1: broadcastChatMessage } = await import('@/modules/messaging/public/v1/message-stream')
        broadcastChatMessage(message.chatId, { id: message.id, metadata: updatedMetadata })

        console.log(`[TG-REACTION] msg=${message.id} reactions=${JSON.stringify(reactionsMap)}`)
    } catch (err: any) {
        console.error(`[TG-REACTION] Error:`, err.message)
    }
}

function attachInboundListener(
    client: TelegramClient,
    connectionId: string,
    providerAccountId: string,
) {
    if (initializedListeners.has(connectionId)) {
        console.log(`[TG-LISTENER] Listener already attached for ${connectionId}, skipping.`)
        return
    }

    client.addEventHandler(async (event: any) => {
        try {
            await ingestTelegramProviderMessage(event.message, connectionId, providerAccountId, 'live')
        } catch (err: any) {
            // Nothing was stored. The next catch-up run replays this dialog and
            // dedupes by the exact provider key, so the event is not lost.
            console.error(`[TG-LISTENER] Error (conn=${connectionId}):`, err.message)
        }
    }, new NewMessage({ incoming: true, outgoing: true }))

    client.addEventHandler(
        (event: any) => processReactionUpdate(event, connectionId, providerAccountId),
        new Raw({ types: [Api.UpdateMessageReactions] })
    )

    client.addEventHandler(
        (event: any) => processReadHistoryOutbox(event, connectionId, providerAccountId),
        new Raw({ types: [Api.UpdateReadHistoryOutbox] })
    )

    initializedListeners.add(connectionId)
    console.log(`[TG-LISTENER] Listener attached for connectionId=${connectionId}`)
}

/**
 * Initialize GramJS listeners for ALL active Telegram connections.
 * Idempotent — safe to call multiple times (e.g. from startup + API route).
 */
export async function initTelegramListeners() {
    if (tgRuntime.initPromise) {
        console.log(`[TG-INIT] Already initializing, waiting for existing promise...`)
        return tgRuntime.initPromise
    }

    tgRuntime.initPromise = (async () => {
        try {
            const connections = await (prisma as any).telegramConnection.findMany({
                where: { isActive: true, sessionString: { not: null } }
            })

            console.log(`[TG-INIT] Found ${connections.length} active Telegram connections`)

            for (const conn of connections) {
                if (initializedListeners.has(conn.id)) {
                    console.log(`[TG-INIT] Connection ${conn.id} already initialized, skipping.`)
                    continue
                }

                try {
                    const client = await getTelegramClient(conn)
                    console.log(`[TG-INIT] Connection ${conn.id} (${conn.name || conn.phoneNumber}) initialized successfully`)
                } catch (err: any) {
                    console.error(`[TG-INIT] Failed to init connection ${conn.id}: ${err.message}`)
                }
            }

            console.log(`[TG-INIT] Initialization complete. Active listeners: ${initializedListeners.size}`)

            // Start periodic health check (every 60s)
            startTelegramHealthCheck(connections)
        } catch (err: any) {
            console.error(`[TG-INIT] Fatal error during initialization: ${err.message}`)
        } finally {
            tgRuntime.initPromise = null
        }
    })()

    return tgRuntime.initPromise
}

// TG hard-restart — tears down the cached client and re-inits from scratch.
// Triggered by the health check when a connection sits in 'degraded' state
// past the threshold. 5-min cooldown per connection so we don't DDoS
// Telegram's MTProto if something upstream is broken.
const tgHardRestartLastAt = tgRuntime.hardRestartLastAt
const TG_HARD_RESTART_COOLDOWN_MS = 5 * 60 * 1000

async function scheduleTgHardRestart(connection: any, reason: string): Promise<void> {
    const opsLog = await loadTelegramOpsLog()

    const last = tgHardRestartLastAt.get(connection.id) || 0
    if (Date.now() - last < TG_HARD_RESTART_COOLDOWN_MS) {
        opsLog('info', 'tg_hard_restart_skipped', {
            connectionId: connection.id,
            reason: 'cooldown',
            sinceLastMs: Date.now() - last,
        })
        return
    }
    tgHardRestartLastAt.set(connection.id, Date.now())

    opsLog('warn', 'tg_hard_restart_scheduled', { connectionId: connection.id, reason })

    // Don't resurrect a connection the user has explicitly disconnected.
    try {
        const fresh = await (prisma as any).telegramConnection.findUnique({
            where: { id: connection.id },
            select: { isActive: true, sessionString: true },
        })
        if (!fresh || !fresh.isActive || !fresh.sessionString) {
            opsLog('info', 'tg_hard_restart_abort', {
                connectionId: connection.id,
                reason: 'conn_inactive',
                isActive: fresh?.isActive ?? null,
            })
            return
        }
    } catch { /* best effort */ }

    // Tear down the cached client so a fresh one can take over.
    const cached = clientCache.get(connection.id)
    if (cached) {
        try {
            await Promise.race([
                (cached as any).disconnect?.() ?? Promise.resolve(),
                new Promise(resolve => setTimeout(resolve, 3000)),
            ])
        } catch { /* dead client may throw on disconnect */ }
    }
    clientCache.delete(connection.id)
    initializedListeners.delete(connection.id)
    tgInstanceIds.delete(connection.id)
    tgProviderAccountIds.delete(connection.id)

    try {
        opsLog('info', 'tg_hard_restart_init_start', { connectionId: connection.id })
        await getTelegramClient(connection)
        opsLog('info', 'tg_hard_restart_success', { connectionId: connection.id })
    } catch (err: any) {
        opsLog('error', 'tg_hard_restart_failed', {
            connectionId: connection.id,
            error: err?.message ?? String(err),
        })
    }
}

function startTelegramHealthCheck(connections: any[]) {
    if (tgRuntime.healthInterval) return // Already running

    tgRuntime.healthInterval = setInterval(async () => {
        for (const conn of connections) {
            const client = clientCache.get(conn.id)
            const curInstanceId = tgInstanceIds.get(conn.id)

            if (!client || !curInstanceId) continue

            if (client.connected) {
                registry.touch(conn.id, curInstanceId)
                runPeriodicTelegramCatchUp(client, conn.id)
            } else {
                // Connection lost — use registry reconnect policy. The dropped
                // client is disconnected too, so GramJS cannot revive it next to
                // its replacement as a second client on the same auth key.
                void Promise.resolve()
                    .then(() => client.disconnect())
                    .catch(() => { /* a dead client may throw on disconnect */ })
                clientCache.delete(conn.id)
                initializedListeners.delete(conn.id)
                tgProviderAccountIds.delete(conn.id)
                registry.setReconnecting(conn.id, curInstanceId)
                registry.scheduleReconnect(conn.id, curInstanceId, async () => { await getTelegramClient(conn) })
            }

            // Check for prolonged degradation (>5 min not ready)
            const degradedMs = registry.getDegradedDuration(conn.id)
            if (degradedMs && degradedMs > 5 * 60 * 1000) {
                const { operationalLogV1: opsLog } = await import('@/infrastructure/operations/operational-log')
                const entry = registry.getEntry(conn.id)
                opsLog('warn', 'tg_prolonged_degradation', {
                    connectionId: conn.id,
                    channel: 'telegram',
                    degradedSinceMs: degradedMs,
                    retryAttempt: entry?.retryAttempt,
                    error: entry?.lastError || undefined,
                })
                // Before this commit we only logged — connection would sit
                // degraded indefinitely. Now trigger a hard restart (own
                // cooldown, won't DDoS Telegram if the issue is upstream).
                scheduleTgHardRestart(conn, 'prolonged_degradation').catch(() => {})
            }
        }
    }, 60_000)
}

/** Stop TG health check interval. Called during graceful shutdown. */
export async function stopTelegramHealthCheck(): Promise<void> {
    if (tgRuntime.healthInterval) {
        clearInterval(tgRuntime.healthInterval)
        tgRuntime.healthInterval = null
    }
}

async function attestTelegramProviderAccount(
    client: TelegramClient,
    connectionId: string,
): Promise<string> {
    const me = await client.getMe()
    const providerAccountId = concreteOpaqueId(me?.id?.toString())
    if (!providerAccountId || !/^\d+$/.test(providerAccountId) || providerAccountId === '0') {
        throw new Error('TELEGRAM_PROVIDER_ACCOUNT_ID_UNPROVEN')
    }
    const cached = tgProviderAccountIds.get(connectionId)
    if (cached && cached !== providerAccountId) {
        throw new Error('TELEGRAM_PROVIDER_ACCOUNT_ID_CHANGED')
    }
    tgProviderAccountIds.set(connectionId, providerAccountId)
    return providerAccountId
}

async function getTelegramClient(connection: any) {
    if (clientCache.has(connection.id)) {
        const cached = clientCache.get(connection.id)!
        if (cached.connected) {
            // The hot path of every send: it re-attests the account and keeps the
            // listener attached, and it never starts a catch-up run.
            const providerAccountId = await attestTelegramProviderAccount(cached, connection.id)
            attachInboundListener(cached, connection.id, providerAccountId)
            return cached
        }
        try {
            await cached.connect()
            const providerAccountId = await attestTelegramProviderAccount(cached, connection.id)
            attachInboundListener(cached, connection.id, providerAccountId)
            // Updates may have been missed while the socket was down.
            void runTelegramCatchUp(cached, connection.id, providerAccountId, 'reconnect')
            return cached
        } catch (e) {
            console.warn(`[TG-CACHE] Failed to reconnect cached client ${connection.id}, creating new one.`)
            clientCache.delete(connection.id)
            initializedListeners.delete(connection.id)
            tgProviderAccountIds.delete(connection.id)
        }
    }

    // One client per connection per process: a concurrent caller joins the
    // client being built instead of opening a second session on the same key.
    const pending = tgRuntime.connecting.get(connection.id)
    if (pending) return pending
    const creation: Promise<TelegramClient> = createTelegramClient(connection).finally(() => {
        if (tgRuntime.connecting.get(connection.id) === creation) tgRuntime.connecting.delete(connection.id)
    })
    tgRuntime.connecting.set(connection.id, creation)
    return creation
}

async function createTelegramClient(connection: any): Promise<TelegramClient> {
    // Register in TransportRegistry
    registry.ensureEntry(connection.id, 'telegram')
    const instanceId = registry.beginNewInstance(connection.id)
    tgInstanceIds.set(connection.id, instanceId)

    const transport = getTelegramTransportOptionsV1()

    const client = new TelegramClient(
        new StringSession(connection.sessionString),
        connection.apiId,
        connection.apiHash,
        {
            connectionRetries: 5,
            ...transport.options,
        }
    )

    if (transport.label) {
        console.log(`[TG-CLIENT] Using ${transport.label}`)
    }

    await client.connect()
    const providerAccountId = await attestTelegramProviderAccount(client, connection.id)
    registry.setReady(connection.id, instanceId)

    attachInboundListener(client, connection.id, providerAccountId)
    clientCache.set(connection.id, client)
    // A fresh client (process start, hard restart, replaced client) replays
    // the deep startup window once; it also warms GramJS's peer cache.
    void runTelegramCatchUp(client, connection.id, providerAccountId, 'startup')
    return client
}

// Adapter outcome codes from the Messaging send contract (S1): a refused send
// is terminal, a send that never left is safe to redeliver. An untyped error
// would be treated as an unknown outcome. Each code is followed by a short
// operator-facing reason; the failed row shows the first 120 characters.
const TELEGRAM_MTPROTO_REFUSED = 'TELEGRAM_MTPROTO_REFUSED'
const TELEGRAM_MTPROTO_NOT_DISPATCHED = 'TELEGRAM_MTPROTO_NOT_DISPATCHED'

function telegramSendError(reason: string, outcome: string, operatorText: string): Error {
    return new Error(`${reason} (${outcome}): ${operatorText}`)
}

// Gates before the provider call whose refusal a retry cannot change.
const TELEGRAM_SEND_GATE_REFUSAL = /\b(?:CONTACT_CONVERSATION_[A-Z_]+|TELEGRAM_PROVIDER_ACCOUNT_ID_[A-Z_]+)\b/

/**
 * What a failed text send proves, as the outcome token Messaging reads. Before
 * the provider call nothing carrying the message left: a gate refusal is
 * terminal and any other failure is safe to deliver again. Once the call began,
 * only Telegram's own RPC answer is proof: FLOOD_WAIT (420) means the request
 * was not executed, a 4xx refusal cannot change on retry. Anything else after
 * the call began (a timeout, a dropped socket) is an unknown outcome and carries
 * no token, so it is never sent again blindly.
 */
function telegramSendFailure(error: unknown, dispatchStarted: boolean): Error {
    const detail = error instanceof Error ? error.message : String(error)
    let outcome: string | null = null
    if (!detail.includes(TELEGRAM_MTPROTO_REFUSED) && !detail.includes(TELEGRAM_MTPROTO_NOT_DISPATCHED)) {
        if (!dispatchStarted) {
            outcome = TELEGRAM_SEND_GATE_REFUSAL.test(detail) ? TELEGRAM_MTPROTO_REFUSED : TELEGRAM_MTPROTO_NOT_DISPATCHED
        } else {
            const rpc = error as { code?: unknown, errorMessage?: unknown } | null
            if (rpc && typeof rpc.code === 'number' && typeof rpc.errorMessage === 'string') {
                if (rpc.code === 420) outcome = TELEGRAM_MTPROTO_NOT_DISPATCHED
                else if ([400, 401, 403, 406].includes(rpc.code)) outcome = TELEGRAM_MTPROTO_REFUSED
            }
        }
    }
    return new Error(`Telegram delivery failed: ${detail}${outcome ? ` (${outcome})` : ''}`)
}

const TG_PEER_SWEEP_DIALOG_LIMIT = 200
const TG_PEER_SWEEP_INTERVAL_MS = 10 * 60 * 1000

/**
 * One dialog sweep per client. Loading the account's dialogs puts their peers
 * into this client's in-memory entity cache, which is all an exact numeric
 * peer can be resolved from after a restart (StringSession persists none).
 * Single-flight, and at most one per 10 minutes: inside that window the last
 * result is reused. A replaced client starts with a cold cache, so it never
 * inherits a sweep it did not run. Resolves true when the account answered.
 */
function sweepTelegramPeers(client: TelegramClient, connectionId: string): Promise<boolean> {
    const inFlight = tgRuntime.peerSweeps.get(connectionId)
    if (inFlight?.client === client) return inFlight.sweep
    const last = tgRuntime.lastPeerSweep.get(connectionId)
    if (last?.client === client && Date.now() - last.at < TG_PEER_SWEEP_INTERVAL_MS) return Promise.resolve(last.ok)
    const startedAt = Date.now()
    const sweep: Promise<boolean> = Promise.resolve()
        .then(() => client.getDialogs({ limit: TG_PEER_SWEEP_DIALOG_LIMIT }))
        .then(
            (dialogs) => ({ ok: true, dialogs: dialogs.length, error: undefined as string | undefined }),
            (error: unknown) => ({ ok: false, dialogs: 0, error: error instanceof Error ? error.message : String(error) }),
        )
        .then(async (result) => {
            tgRuntime.lastPeerSweep.set(connectionId, { client, at: startedAt, ok: result.ok })
            console[result.ok ? 'log' : 'warn'](`[TG-PEER] sweep conn=${connectionId} ok=${result.ok} dialogs=${result.dialogs}${result.error ? ` error=${result.error}` : ''}`)
            const opsLog = await loadTelegramOpsLog()
            opsLog(result.ok ? 'info' : 'warn', 'telegram_mtproto_peer_sweep', {
                channel: 'telegram',
                connectionId,
                ok: result.ok,
                dialogs: result.dialogs,
                durationMs: Date.now() - startedAt,
                error: result.error,
            })
            return result.ok
        })
        .finally(() => {
            if (tgRuntime.peerSweeps.get(connectionId)?.sweep === sweep) tgRuntime.peerSweeps.delete(connectionId)
        })
    tgRuntime.peerSweeps.set(connectionId, { client, sweep })
    return sweep
}

/**
 * Resolves the exact numeric peer of an identity-preflighted conversation on
 * the live client. A cache miss gets one dialog sweep and one retry. Still
 * unresolved after a sweep that answered, the peer is not addressable from
 * this account (for example a Bot-only peer): the send is refused before
 * anything is dispatched. If the sweep itself did not answer, nothing was
 * dispatched either and the send may be delivered again later.
 */
async function resolveExactTelegramPeerEntity(
    client: TelegramClient,
    connectionId: string,
    peerId: string,
): Promise<any> {
    const lookup = async () => {
        const entity = await client.getEntity(BigInt(peerId) as any)
        if (entity?.id?.toString() !== peerId) {
            throw new Error('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
        }
        return entity
    }
    const bindingMismatch = (error: unknown) => error instanceof Error
        && error.message === 'CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH'
    try {
        return await lookup()
    } catch (firstError: unknown) {
        if (bindingMismatch(firstError)) throw firstError
        console.warn(`[TG-PEER] cache miss conn=${connectionId} peer=${peerId}: ${firstError instanceof Error ? firstError.message : String(firstError)}`)
    }
    const swept = await sweepTelegramPeers(client, connectionId)
    try {
        return await lookup()
    } catch (retryError: unknown) {
        if (bindingMismatch(retryError)) throw retryError
        console.warn(`[TG-PEER] unresolved conn=${connectionId} peer=${peerId} swept=${swept}: ${retryError instanceof Error ? retryError.message : String(retryError)}`)
        throw swept
            ? telegramSendError('TELEGRAM_PEER_UNRESOLVED', TELEGRAM_MTPROTO_REFUSED, 'собеседник недоступен в личном Telegram')
            : telegramSendError('TELEGRAM_PEER_UNRESOLVED', TELEGRAM_MTPROTO_NOT_DISPATCHED, 'поиск диалогов не удался')
    }
}

type ExactTelegramOutboundProof = {
    chatId: string
    providerAccountId?: string
    identityTarget: string
}

/**
 * The transport a legacy unbound conversation routes through. Routing
 * compatibility only: it persists nothing and resolves ONLY when exactly one
 * active transport exists, so there is no second account to cross into and no
 * choice to make. Zero or several fail closed.
 */
async function resolveLegacyTelegramCarrierV1(): Promise<string> {
    const active = await (prisma as any).telegramConnection.findMany({
        where: { isActive: true }, take: 2, select: { id: true },
    })
    if (active.length === 0) throw new Error('CONTACT_CONVERSATION_TRANSPORT_UNBOUND')
    if (active.length > 1) throw new Error('CONTACT_CONVERSATION_TRANSPORT_AMBIGUOUS')
    return active[0].id
}

async function resolveExactTelegramOutboundPeer(
    target: string,
    connectionId: string | undefined,
    proof: ExactTelegramOutboundProof,
) {
    // A legacy conversation carries no transport; the single active carrier
    // routes it. Provider-account provenance is deferred and asserts nothing.
    const routedConnectionId = concreteOpaqueId(connectionId) === connectionId && connectionId
        ? connectionId
        : await resolveLegacyTelegramCarrierV1()
    if (
        !/^\d+$/.test(target)
        || target === '0'
        || concreteOpaqueId(proof.chatId) !== proof.chatId
        || proof.identityTarget !== target
    ) {
        throw new Error('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
    }
    const connection = await (prisma as any).telegramConnection.findUnique({
        where: { id: routedConnectionId, isActive: true },
    })
    if (!connection?.sessionString) {
        throw new Error('CONTACT_CONVERSATION_TRANSPORT_UNAVAILABLE')
    }
    const chat = await (prisma.chat as any).findUnique({
        where: { id: proof.chatId },
        select: {
            id: true,
            contactId: true,
            contactIdentityId: true,
            channel: true,
            externalChatId: true,
            chatType: true,
            metadata: true,
        },
    })
    if (!chat) throw new Error('CONTACT_CONVERSATION_IDENTITY_REQUIRED')

    const client = await getTelegramClient(connection)
    const prepared = await prepareOutboundConversationV1(chat, connection.id)
    // The account comes from the LIVE session, not from a stored stamp: getMe on
    // the very socket this send will leave through. It is a transport fact
    // available at send time, it is never persisted as identity provenance, and
    // it carries no authority over whose conversation or contact this is.
    const liveProviderAccountId = await attestTelegramProviderAccount(client, connection.id)
    // A legacy conversation carries no transport, and the carrier was resolved
    // above only because exactly one active transport exists. A conversation that
    // IS bound must still match the transport this send leaves through.
    const transportAgrees = prepared.connectionId === null
        || prepared.connectionId === connection.id
    if (
        prepared.channel !== 'telegram'
        || prepared.chatId !== proof.chatId
        || !transportAgrees
        || prepared.identityTarget !== target
        || prepared.target !== target
    ) {
        throw new Error('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
    }

    const entity = await resolveExactTelegramPeerEntity(client, connection.id, target)
    return { client, connection, entity, providerAccountId: liveProviderAccountId }
}

export async function sendTelegramMessage(phoneNumber: string, message: string, connectionId?: string, metadata?: { messageId?: string, chatId?: string, driverId?: string, quotedMsgId?: string }) {
    // Every failure leaves with what it proves (S2 C2, through S1's tokens).
    let dispatchStarted = false
    if (!metadata?.chatId) {
        throw telegramSendFailure(new Error('CONTACT_CONVERSATION_IDENTITY_REQUIRED'), dispatchStarted)
    }
    console.log(`[TG-SEND] START: phone=${phoneNumber}, connectionId=${connectionId}, metadata=${JSON.stringify(metadata)}`)
    let connection
    
    if (connectionId) {
        connection = await (prisma as any).telegramConnection.findUnique({
            where: { id: connectionId, isActive: true }
        })
        console.log(`[TG-SEND] Using specific connection: ${connectionId} (found: ${!!connection})`)
    } else {
        // ROUTING COMPATIBILITY for a legacy conversation that carries no
        // transport binding and that no code path can ever add one to. It
        // answers only "which socket carries this send": nothing is persisted,
        // no binding is created, no provider account is invented, and no
        // contact, identity or peer ownership changes. Every ownership guard in
        // the outbound preparer has already run.
        //
        // It resolves ONLY when exactly one active transport exists, so there is
        // no second account to cross into and no choice to make. Activating a
        // second transport immediately makes these conversations ambiguous and
        // they fail closed again, with no data change and no code change.
        const carrierId = await resolveLegacyTelegramCarrierV1()
            .catch((error: unknown) => { throw telegramSendFailure(error, dispatchStarted) })
        connection = await (prisma as any).telegramConnection.findUnique({
            where: { id: carrierId, isActive: true },
        })
        console.log('[TG-SEND] Legacy unbound conversation routed through the single active carrier')
    }

    if (!connection || !connection.sessionString) {
        console.error(`[TG-SEND] ERROR: Telegram not connected or inactive. connectionId=${connectionId}`)
        throw telegramSendFailure(new Error('Telegram is not connected or selected account is inactive'), dispatchStarted)
    }

    const client = await getTelegramClient(connection)
        .catch((error: unknown) => { throw telegramSendFailure(error, dispatchStarted) })
    console.log(`[TG-SEND] Client connected state: ${client.connected}`)

    try {
        // A Messaging-owned Chat id means this is an identity-preflighted send.
        // Re-run that proof at the transport boundary, bind it to the live
        // authenticated client, and preserve the exact numeric Telegram peer.
        let exactPreparedTarget: string | null = null
        let exactProviderAccountId: string | null = null
        if (metadata?.chatId) {
            const chat = await (prisma.chat as any).findUnique({
                where: { id: metadata.chatId },
                select: {
                    id: true,
                    contactId: true,
                    contactIdentityId: true,
                    channel: true,
                    externalChatId: true,
                    chatType: true,
                    metadata: true,
                },
            })
            if (!chat) throw new Error('CONTACT_CONVERSATION_IDENTITY_REQUIRED')
            const prepared = await prepareOutboundConversationV1(chat, connection.id)
            const liveProviderAccountId = await attestTelegramProviderAccount(client, connection.id)
            // A legacy conversation carries no transport, and the carrier was
            // resolved above only because exactly one active transport exists.
            // A conversation that IS bound must still match the socket this send
            // leaves through. Provider-account provenance is deferred and is not
            // compared: the account below comes from the live session instead.
            const transportAgrees = prepared.connectionId === null
                || prepared.connectionId === connection.id
            if (
                prepared.channel !== 'telegram'
                || prepared.chatId !== chat.id
                || !transportAgrees
                || prepared.identityTarget !== phoneNumber
                || prepared.target !== phoneNumber
            ) {
                throw new Error('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
            }
            exactPreparedTarget = prepared.target
            exactProviderAccountId = liveProviderAccountId
        }

        // A requested reply is a provider semantic, never a hint. It is resolved
        // before anything leaves, and a quote this exact live account and peer
        // cannot address refuses the send instead of delivering it unquoted.
        const replyTarget = metadata?.quotedMsgId
            ? telegramReplyTarget(metadata.quotedMsgId, exactProviderAccountId, exactPreparedTarget)
            : null

        // Normalize target: if it's a mobile number, ensure it has '+'
        let target: any = exactPreparedTarget ?? phoneNumber
        // Only prefix with '+' if it's a long digit string (phone number)
        if (!exactPreparedTarget && typeof target === 'string' && target.match(/^\d+$/) && target.length >= 10 && !target.startsWith('+')) {
            target = '+' + target
        }
        
        console.log(`[TG-SEND] Target normalized to: ${target}`)

        // Telethon/GramJS: Best to resolve entity first if it's not in cache
        let entity;
        try {
            console.log(`[TG-SEND] Resolving entity for ${target}...`)
            // If it's a numeric ID (no plus, just digits), try resolving as number
            if (exactPreparedTarget) {
                entity = await resolveExactTelegramPeerEntity(client, connection.id, exactPreparedTarget)
            } else if (typeof target === 'string' && target.match(/^\d+$/) && !target.startsWith('+')) {
                try {
                    entity = await client.getEntity(BigInt(target) as any)
                } catch (e) {
                     entity = await client.getEntity(target)
                }
            } else {
                entity = await client.getEntity(target)
            }
            console.log(`[TG-SEND] Entity resolved: ${entity.id.toString()}`)
        } catch (entityErr: any) {
            // The exact resolver has already swept and classified its answer.
            if (exactPreparedTarget) throw entityErr
            console.warn(`[TG-SEND] getEntity FAILED for ${target}: ${entityErr.message}. Attempting import...`)
            
            try {
                // Try importing contact if it's a phone number
                if (target.startsWith('+')) {
                    console.log(`[TG-SEND] Invoking contacts.ImportContacts for ${target}...`)
                    const result = await client.invoke(new Api.contacts.ImportContacts({
                        contacts: [new Api.InputPhoneContact({
                            clientId: BigInt(Math.floor(Math.random() * 1000000)) as any,
                            phone: target,
                            firstName: 'Driver',
                            lastName: ''
                        })]
                    }))
                    
                    if (result && 'users' in result && result.users.length > 0) {
                        entity = result.users[0]
                        console.log(`[TG-SEND] Success! Contact imported: ${entity.id.toString()}`)
                    } else {
                         console.error(`[TG-SEND] ImportContacts returned empty users for ${target}`)
                         throw new Error(`Contact import returned empty result for ${target}`)
                    }
                } else {
                     console.error(`[TG-SEND] Target ${target} is not a phone number, cannot import.`)
                     throw new Error(`Target ${target} is not a valid phone number format`)
                }
            } catch (importErr: any) {
                console.error(`[TG-SEND] FATAL: Failed to import contact ${target}:`, importErr.message)
                throw new Error(`Cannot find or import user with number ${target}. They might not have a Telegram account linked to this number.`)
            }
        }

        console.log(`[TG-SEND] Sending message to entity...`)
        
        const replyToMessageId = replyTarget && metadata?.chatId && metadata.quotedMsgId
            ? await proveTelegramReplyTarget(client, entity, replyTarget, metadata.chatId, metadata.quotedMsgId)
            : null

        // Add a safety timeout for the actual sending
        const sendOpts: any = { message }
        if (replyToMessageId !== null) sendOpts.replyTo = replyToMessageId
        // From here the message may reach Telegram: a failure is no longer
        // proof that nothing was dispatched.
        dispatchStarted = true
        const result = await Promise.race([
            client.sendMessage(entity || target, sendOpts),
            new Promise<any>((_, reject) => setTimeout(() => reject(new Error('Telegram sendMessage timeout (25s)')), 25000))
        ])
        
        console.log(`[TG-SEND] Message delivery SUCCESS`)
        const sendInstanceId = tgInstanceIds.get(connection?.id)
        if (connection && sendInstanceId) registry.touch(connection.id, sendInstanceId)

        // Messaging owns the already-created optimistic row and applies this
        // exact provider result. The transport must not migrate/create Chats
        // or grant DriverTelegram authority as a side effect of delivery.
        // The RPC result's id is Telegram's answer for THIS message
        // (provider_ack); without one the send is only a client action. Telegram
        // gives a user account no proof of delivery to the recipient's device.
        const rawExternalId = (result as any)?.id?.toString()
        const providerMessageId = rawExternalId && exactPreparedTarget && exactProviderAccountId
            ? telegramMessageExternalId(exactProviderAccountId, exactPreparedTarget, rawExternalId)
            : null
        return {
            evidence: providerMessageId ? 'provider_ack' as const : 'client_action' as const,
            providerMessageId,
        }
    } catch (err: any) {
        console.error('[TG-SEND] SEND ERROR:', err)
        throw telegramSendFailure(err, dispatchStarted)
    } finally {
        // We no longer disconnect here to keep the session alive in cache
        console.log(`[TG-SEND] End of call (client left active in cache)`)
    }
}

/**
 * Send media (photo, document, video, voice, audio) via Telegram personal account.
 * @param phoneNumber - target phone number or entity ID
 * @param base64 - file data as base64 (with or without data: prefix)
 * @param filename - original filename
 * @param mimeType - MIME type (e.g. 'image/jpeg', 'application/pdf', 'audio/ogg')
 * @param caption - optional caption text
 * @param connectionId - which TG connection to use
 */
export async function sendTelegramMedia(
    phoneNumber: string,
    base64: string,
    filename: string,
    mimeType: string,
    caption: string | undefined,
    connectionId: string | undefined,
    proof: ExactTelegramOutboundProof,
): Promise<{ success: boolean; externalId?: string }> {
    console.log(`[TG-MEDIA] START: phone=${phoneNumber} filename=${filename} mime=${mimeType} connId=${connectionId}`)

    try {
        const { client, connection, entity, providerAccountId: liveAccountId } = await resolveExactTelegramOutboundPeer(
            phoneNumber,
            connectionId,
            proof,
        )

        // Decode base64 → Buffer
        const cleanBase64 = base64.startsWith('data:') ? base64.split(',')[1] : base64
        const buffer = Buffer.from(cleanBase64, 'base64')

        // Wrap as CustomFile for GramJS
        const file = new CustomFile(filename, buffer.length, '', buffer)

        // Determine send options based on mime type
        const isImage  = mimeType.startsWith('image/')
        const isVideo  = mimeType.startsWith('video/')
        const isVoice  = mimeType === 'audio/ogg' || mimeType === 'audio/opus' || mimeType === 'audio/ogg; codecs=opus'
        const isAudio  = mimeType.startsWith('audio/') && !isVoice

        const sendOpts: any = { file, caption }
        if (isVoice) {
            sendOpts.voiceNote = true
        } else if (isImage || isVideo || isAudio) {
            // let GramJS auto-detect from MIME
        } else {
            // Document/other — force as document
            sendOpts.forceDocument = true
        }

        console.log(`[TG-MEDIA] Sending: image=${isImage} video=${isVideo} voice=${isVoice} audio=${isAudio} doc=${sendOpts.forceDocument || false}`)

        const result = await Promise.race([
            client.sendFile(entity, sendOpts),
            new Promise<any>((_, reject) => setTimeout(() => reject(new Error('Telegram sendFile timeout (60s)')), 60000))
        ])

        console.log(`[TG-MEDIA] SUCCESS: externalId=${result?.id?.toString()}`)

        const sendInstanceId = tgInstanceIds.get(connection?.id)
        if (connection && sendInstanceId) registry.touch(connection.id, sendInstanceId)

        const rawExternalId = result?.id?.toString()
        return {
            success: true,
            externalId: rawExternalId
                ? telegramMessageExternalId(liveAccountId, proof.identityTarget, rawExternalId)
                : undefined,
        }
    } catch (err: any) {
        console.error('[TG-MEDIA] SEND ERROR:', err)
        throw new Error(`Telegram media delivery failed: ${err.message}`)
    }
}

export async function sendTelegramReaction(input: {
    target: string
    messageId: string
    emoji: string
    remove: boolean
    connectionId?: string
    proof: ExactTelegramOutboundProof
}): Promise<void> {
    // Resolve the peer first: the provider message id is keyed by the account of
    // the session the reaction leaves through, and that account is a live
    // transport fact rather than stored provenance.
    const { client, entity, providerAccountId: liveAccountId } = await resolveExactTelegramOutboundPeer(
        input.target,
        input.connectionId,
        input.proof,
    )
    const rawMessageId = exactTelegramProviderMessageId(
        input.messageId,
        liveAccountId,
        input.target,
    )
    const messageId = rawMessageId ? Number.parseInt(rawMessageId, 10) : Number.NaN
    if (!Number.isSafeInteger(messageId) || messageId <= 0 || String(messageId) !== rawMessageId) {
        throw new Error('TELEGRAM_MESSAGE_ID_INVALID')
    }
    await client.invoke(new Api.messages.SendReaction({
        peer: entity,
        msgId: messageId,
        reaction: input.remove ? [] : [new Api.ReactionEmoji({ emoticon: input.emoji })],
    }))
}

/**
 * Import Telegram history as a HistoryImportJob.
 * Uses GramJS getDialogs/getMessages to fetch history, processes through the standard pipeline.
 */
export async function importTelegramHistory(
    jobId: string, mode: string, daysBack?: number, connectionId?: string
) {
    console.log(`[TG-IMPORT] Starting job=${jobId} mode=${mode} daysBack=${daysBack} conn=${connectionId}`)

    // 1. Resolve only the caller-selected import job connection. History from
    // an arbitrary default/first account must never be admitted under another
    // provider account's ContactIdentity.
    const exactConnectionId = concreteOpaqueId(connectionId)
    const connection: any = exactConnectionId && exactConnectionId === connectionId
        ? await (prisma as any).telegramConnection.findUnique({ where: { id: exactConnectionId } })
        : null

    if (!connection || !connection.isActive || !connection.sessionString) {
        console.error('[TG-IMPORT] Exact active Telegram connection is required')
        await updateTgImportJob(jobId, { status: 'failed', resultType: 'failed', finishedAt: new Date() })
        return
    }

    // 2. Get or create client
    let client: TelegramClient
    let providerAccountId: string
    try {
        client = await getTelegramClient(connection)
        providerAccountId = await attestTelegramProviderAccount(client, connection.id)
    } catch (err: any) {
        console.error(`[TG-IMPORT] Failed to get client: ${err.message}`)
        await updateTgImportJob(jobId, { status: 'failed', resultType: 'failed', finishedAt: new Date() })
        return
    }

    // 3. Update job to running
    await updateTgImportJob(jobId, { status: 'running', startedAt: new Date() })

    // 4. Compute cutoff date
    let cutoff: Date
    if (mode === 'last_n_days' && daysBack) {
        cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - daysBack)
    } else if (mode === 'from_connection_time') {
        cutoff = new Date()
    } else {
        // available_history — 3 months
        cutoff = new Date()
        cutoff.setMonth(cutoff.getMonth() - 3)
    }

    let totalMessages = 0
    let newMessages = 0
    let failedMessages = 0
    let enrichmentBlockedChats = 0
    let totalChats = 0
    let totalContacts = 0
    let minDate: Date | null = null
    let maxDate: Date | null = null

    try {
        // 5. Fetch dialogs (up to 100)
        const dialogs = await client.getDialogs({ limit: 100 })
        console.log(`[TG-IMPORT] Found ${dialogs.length} dialogs`)

        for (const dialog of dialogs) {
            if (!dialog.isUser) continue // skip groups/channels for now

            const peerId = dialog.entity?.id?.toString()
            if (!peerId) continue
            const nonPerson = telegramNonPersonPeerReason(peerId, providerAccountId, dialog.entity)
            if (nonPerson) {
                console.log(`[TG-IMPORT] SKIP non-person peer=${peerId} reason=${nonPerson}`)
                continue
            }
            totalChats++

            const providerDisplayName = (dialog.entity as any)?.firstName
                || (dialog.entity as any)?.username
                || null

            // Set once this dialog's messages are stored: a later throw can only
            // come from person enrichment and never undoes the import.
            let dialogPersisted = false
            let conversationId: string | null = null
            try {
                const conversation = await upsertTelegramPrivateConversation({
                    phase: 'import',
                    peerId,
                    providerAccountId,
                    connectionId: connection.id,
                    displayName: providerDisplayName,
                })
                conversationId = conversation.id

                // Fetch messages — determine limit based on mode
                const msgLimit = mode === 'from_connection_time' ? 20 : 200
                const messages = await client.getMessages(dialog.entity!, { limit: msgLimit })

                let chatMaxTs: Date | null = null
                for (const msg of messages) {
                    const histMediaInfo = detectTgMediaType(msg)
                    const msgText = msg.message || (histMediaInfo ? histMediaInfo.fallback : '')
                    if (!msgText) continue // skip empty service messages
                    const ts = validateTgDate(msg.date)
                    if (!ts) continue // skip corrupted timestamps
                    if (ts < cutoff) continue

                    if (!minDate || ts < minDate) minDate = ts
                    if (!maxDate || ts > maxDate) maxDate = ts
                    if (!chatMaxTs || ts > chatMaxTs) chatMaxTs = ts

                    const rawExternalMsgId = msg.id?.toString()
                    const externalMsgId = rawExternalMsgId
                        ? telegramMessageExternalId(providerAccountId, peerId, rawExternalMsgId)
                        : null
                    const isOutbound = !!msg.out
                    const histMsgType = histMediaInfo?.type || 'text'

                    totalMessages++
                    // One message that cannot be stored is counted and the rest of
                    // the dialog is still imported.
                    try {
                        // Dedup. Inbound by the exact provider key only. This
                        // account's own outbound history is a provider read-back:
                        // Messaging's evidence command matches and records it.
                        const storedExternalId = externalMsgId || `telegram:${providerAccountId}:${peerId}:local-${ts.getTime()}`
                        const histMetadata: Record<string, string> = rawExternalMsgId ? { providerMessageId: rawExternalMsgId, providerAccountId, peerId } : {}
                        let savedHistMsg: any = null
                        if (isOutbound) {
                            const observed = await observeTelegramOutboundMessage({
                                chatId: conversation.id,
                                providerMessageId: externalMsgId,
                                rawProviderMessageId: rawExternalMsgId,
                                fallbackExternalId: storedExternalId,
                                content: msgText,
                                type: histMsgType,
                                sentAt: ts,
                                metadata: histMetadata,
                                evidence: 'history_readback',
                                loggerPrefix: 'TG-IMPORT',
                            })
                            if (observed.outcome !== 'created') continue
                            savedHistMsg = observed.row
                        } else {
                            const existing = await (prisma.message as any).findFirst({
                                where: { OR: telegramInboundKeyArms(conversation.id, storedExternalId, rawExternalMsgId) },
                            })
                            if (existing) continue
                            savedHistMsg = await createTelegramProviderMessage({ chatId: conversation.id, direction: 'inbound', content: msgText, type: histMsgType, sentAt: ts, externalId: storedExternalId, metadata: histMetadata })
                            if (!savedHistMsg) continue
                        }

                        // Download media for history import
                        if (histMediaInfo && histMsgType !== 'text' && client) {
                            try {
                                const buffer = await client.downloadMedia(msg, {})
                                if (buffer && Buffer.isBuffer(buffer)) {
                                    const documentMedia = msg.media && 'document' in msg.media
                                        ? msg.media.document
                                        : undefined
                                    const documentMimeType = documentMedia && 'mimeType' in documentMedia
                                        ? documentMedia.mimeType
                                        : undefined
                                    const documentAttributes = documentMedia && 'attributes' in documentMedia
                                        ? documentMedia.attributes
                                        : undefined
                                    const mimeType = documentMimeType ||
                                        (histMsgType === 'image' ? 'image/jpeg' : 'application/octet-stream')
                                    const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`
                                    const fileNameAttribute = documentAttributes?.find(attribute => 'fileName' in attribute)
                                    const fileName = fileNameAttribute && 'fileName' in fileNameAttribute
                                        ? fileNameAttribute.fileName
                                        : null
                                    await attachMessageMediaV1({ contract: ATTACH_MESSAGE_MEDIA_COMMAND_V1, messageId: savedHistMsg.id, mediaType: histMsgType, url: dataUrl, fileName, fileSize: buffer.length, mimeType })
                                }
                            } catch (mediaErr: any) {
                                // Non-blocking — message saved, media skipped
                            }
                        }

                        newMessages++
                    } catch (messageErr: any) {
                        failedMessages++
                        console.error(`[TG-IMPORT] Message failed peerId=${peerId} msgId=${rawExternalMsgId}: ${messageErr.message}`)
                    }
                }

                // Update lastMessageAt
                if (chatMaxTs) {
                    await patchChannelConversationV1({ contract: PATCH_CHANNEL_CONVERSATION_COMMAND_V1, selector: { chatId: conversation.id }, patch: { lastMessageAt: chatMaxTs } })
                }

                // Periodic progress update (every 5 chats)
                if (totalChats % 5 === 0) {
                    await updateTgImportJob(jobId, {
                        status: 'running',
                        messagesImported: totalMessages,
                        chatsScanned: totalChats,
                        contactsFound: totalContacts,
                    })
                }

                // ENRICH last: the dialog's messages are already durable.
                dialogPersisted = true
                const unifiedChat = await admitTelegramPrivateConversation({
                    phase: 'import',
                    peerId,
                    providerAccountId,
                    connectionId: connection.id,
                    displayName: providerDisplayName,
                })
                totalContacts++
                console.log(`[TG-IMPORT] Linked chat=${unifiedChat.id} peerId=${peerId}`)
            } catch (chatErr: any) {
                if (dialogPersisted) {
                    enrichmentBlockedChats++
                    await reportTelegramEnrichmentBlocked({
                        phase: 'import',
                        connectionId: connection.id,
                        chatId: conversationId,
                        messageId: null,
                        error: chatErr,
                    })
                } else {
                    console.error(`[TG-IMPORT] Dialog error peerId=${peerId}: ${chatErr.message}`)
                }
            }
        }

        // 6. Query actual DB totals scoped to cutoff period
        const dbTotals = await prisma.$queryRaw<{ msg_count: bigint; chat_count: bigint; contact_count: bigint; min_date: Date | null; max_date: Date | null }[]>`
            SELECT
                (SELECT COUNT(*) FROM "Message" WHERE channel = 'telegram' AND "sentAt" >= ${cutoff}) as msg_count,
                (SELECT COUNT(*) FROM "Chat" WHERE channel = 'telegram') as chat_count,
                (SELECT COUNT(DISTINCT "contactId") FROM "Chat" WHERE channel = 'telegram' AND "contactId" IS NOT NULL) as contact_count,
                (SELECT MIN("sentAt") FROM "Message" WHERE channel = 'telegram' AND "sentAt" >= ${cutoff}) as min_date,
                (SELECT MAX("sentAt") FROM "Message" WHERE channel = 'telegram') as max_date
        `
        const db = dbTotals[0]
        const dbMsgCount = Number(db?.msg_count ?? 0)
        const dbChatCount = Number(db?.chat_count ?? 0)
        const dbContactCount = Number(db?.contact_count ?? 0)

        const finalMessages = totalMessages > 0 ? totalMessages : dbMsgCount
        const finalChats = totalChats > 0 ? totalChats : dbChatCount
        const finalContacts = totalContacts > 0 ? totalContacts : dbContactCount
        const finalMinDate = minDate ?? db?.min_date ?? null
        const finalMaxDate = maxDate ?? db?.max_date ?? null

        // 7. Complete
        const resultType = finalMessages > 0 ? 'full' : 'live_only'
        await updateTgImportJob(jobId, {
            status: 'completed',
            resultType,
            messagesImported: finalMessages,
            chatsScanned: finalChats,
            contactsFound: finalContacts,
            finishedAt: new Date(),
            coveredPeriodFrom: finalMinDate,
            coveredPeriodTo: finalMaxDate,
            detailsJson: { newMessages, existingMessages: finalMessages - newMessages - failedMessages, failedMessages, enrichmentBlockedChats },
        })
        console.log(`[TG-IMPORT] Completed job=${jobId}: ${finalMessages} msgs (${newMessages} new, ${failedMessages} failed), ${finalChats} chats, ${finalContacts} contacts, ${enrichmentBlockedChats} enrichment-blocked`)
    } catch (err: any) {
        console.error(`[TG-IMPORT] Fatal error job=${jobId}: ${err.message}`)
        await updateTgImportJob(jobId, {
            status: 'failed',
            resultType: 'failed',
            messagesImported: totalMessages,
            chatsScanned: totalChats,
            contactsFound: totalContacts,
            finishedAt: new Date(),
        })
    }
}

/** Update HistoryImportJob fields directly via Prisma */
async function updateTgImportJob(jobId: string, data: {
    status?: string
    resultType?: string
    messagesImported?: number
    chatsScanned?: number
    contactsFound?: number
    startedAt?: Date | null
    finishedAt?: Date | null
    coveredPeriodFrom?: Date | null
    coveredPeriodTo?: Date | null
    detailsJson?: any
}) {
    try {
        await patchHistoryImportJobV1({ contract: PATCH_HISTORY_IMPORT_JOB_COMMAND_V1, jobId, patch: data })
    } catch (err: any) {
        console.error(`[TG-IMPORT] updateTgImportJob error: ${err.message}`)
    }
}

export async function pauseTelegramConnection(id: string, deleteMessages?: boolean) {
    await requireIntegrationAdminAccess()
    console.log(`[TG] pauseTelegramConnection id=${id} deleteMessages=${deleteMessages}`)

    // Mark as paused (isActive=false → isPaused=true in UI)
    await (prisma as any).telegramConnection.update({
        where: { id },
        data: { isActive: false }
    })

    // Disconnect and evict the client as well as the account attestation. An
    // event handler on a cached live client would otherwise outlive the pause.
    await evictTelegramClient(id)
    console.log(`[TG] Listener removed for paused connection ${id}`)

    // Optionally delete messages
    if (deleteMessages) {
        await deleteConnectionMessages(id)
    }

    revalidatePath('/settings/integrations/telegram')
}

export async function resumeTelegramConnection(id: string, catchUp?: boolean) {
    await requireIntegrationAdminAccess()
    console.log(`[TG] resumeTelegramConnection id=${id} catchUp=${catchUp}`)

    // Mark as active (isPaused=false in UI)
    await (prisma as any).telegramConnection.update({
        where: { id },
        data: { isActive: true }
    })

    // Re-initialize listener
    const conn = await (prisma as any).telegramConnection.findUnique({ where: { id } })
    if (conn?.sessionString) {
        try {
            const client = await getTelegramClient(conn)
            if (catchUp) {
                const providerAccountId = await attestTelegramProviderAccount(client, id)
                await runTelegramCatchUp(client, id, providerAccountId, 'manual')
            }
        } catch (err: any) {
            console.error(`[TG] Failed to resume connection ${id}: ${err.message}`)
        }
    }

    revalidatePath('/settings/integrations/telegram')
}

export async function deleteConnectionMessages(connectionId: string) {
    await requireIntegrationAdminAccess()
    // Find telegram chats scoped to this connection (via metadata.connectionId)
    // If connectionId is not in metadata, fall back to all telegram chats
    const allTgChats = await (prisma.chat as any).findMany({
        where: { channel: 'telegram' },
        select: { id: true, contactId: true, metadata: true },
    })

    // Filter to chats belonging to this specific connection
    const tgChats = allTgChats.filter((c: any) => {
        const meta = c.metadata as any
        return !meta?.connectionId || meta.connectionId === connectionId
    })

    if (tgChats.length === 0) {
        console.log(`[TG] No chats found for connection ${connectionId}`)
        // Still clean up import jobs
        await cleanupImportJobs('telegram', connectionId)
        return
    }

    const chatIds = tgChats.map((c: any) => c.id)
    const contactIds = [...new Set(tgChats.map((c: any) => c.contactId).filter(Boolean))] as string[]

    // Delete messages then chats
    await deleteConversationsByIdV1({ contract: DELETE_CONVERSATIONS_BY_ID_COMMAND_V1, conversationIds: chatIds })

    // Cleanup dangling identities
    if (contactIds.length > 0) {
        await cleanupDanglingContactIdentitiesV1(contactIds)
    }

    // Clean up HistoryImportJob records so ChannelSyncBlock resets to "Не загружена"
    await cleanupImportJobs('telegram', connectionId)

    console.log(`[TG] Deleted ${chatIds.length} chats and messages for connection ${connectionId}`)
}

/** Remove HistoryImportJob records for a channel+connection so the sync block resets */
async function cleanupImportJobs(channel: string, connectionId?: string) {
    try {
        if (connectionId) {
            await deleteHistoryImportJobsForConnectionV1({ contract: DELETE_HISTORY_IMPORT_JOBS_FOR_CONNECTION_COMMAND_V1, channel: 'telegram', connectionId })
        } else {
            await deleteHistoryImportJobsForChannelV1({ contract: DELETE_HISTORY_IMPORT_JOBS_FOR_CHANNEL_COMMAND_V1, channel: 'telegram' })
        }
        console.log(`[TG] Cleaned up import jobs for channel=${channel} conn=${connectionId}`)
    } catch (err: any) {
        console.error(`[TG] cleanupImportJobs error: ${err.message}`)
    }
}

/**
 * Check if a phone number is reachable on Telegram.
 * Uses getEntity + ImportContacts (same as sendTelegramMessage) but without sending.
 *
 * On timeout or internal error returns { reachable: true } as a soft fallback —
 * this means "don't show a warning", NOT "confirmed reachable".
 */
export async function checkTelegramReachability(
    phone: string,
    requestedProviderAccountId?: string
): Promise<{ reachable: boolean; telegramId?: string; providerAccountId?: string; error?: string }> {
    const TIMEOUT_MS = 10_000

    // Wrap EVERYTHING (including getTelegramClient which can hang on connect())
    // in a single timeout. On timeout returns { reachable: true } — soft fallback,
    // meaning "don't show a warning", NOT "confirmed reachable".
    const result = await Promise.race([
        doCheck(phone, requestedProviderAccountId),
        new Promise<{ reachable: true }>((resolve) =>
            setTimeout(() => {
                console.warn(`[TG-CHECK] Timeout (${TIMEOUT_MS}ms) for ${phone} — soft fallback`)
                resolve({ reachable: true })
            }, TIMEOUT_MS)
        ),
    ])

    return result
}

async function doCheck(
    phone: string,
    requestedProviderAccountId?: string
): Promise<{ reachable: boolean; telegramId?: string; providerAccountId?: string; error?: string }> {
    try {
        const requestedAccount = requestedProviderAccountId === undefined
            ? null
            : concreteOpaqueId(requestedProviderAccountId)
        if (requestedProviderAccountId !== undefined && !requestedAccount) {
            return { reachable: true, error: 'Telegram provider account binding is invalid' }
        }

        // A provider account id is the authenticated Telegram user id, never a
        // local TelegramConnection primary key. Enumerate active transports and
        // accept one only after live getMe() attestation proves that account.
        const connections = await (prisma as any).telegramConnection.findMany({
            where: { isActive: true },
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        })
        let exactBinding: {
            client: TelegramClient
            providerAccountId: string
        } | null = null
        for (const connection of connections) {
            if (!connection?.sessionString) continue
            try {
                const client = await getTelegramClient(connection)
                const providerAccountId = await attestTelegramProviderAccount(client, connection.id)
                if (requestedAccount && providerAccountId !== requestedAccount) continue
                exactBinding = { client, providerAccountId }
                break
            } catch (error: unknown) {
                console.warn(`[TG-CHECK] Account attestation failed for ${connection?.id}: ${error instanceof Error ? error.message : String(error)}`)
            }
        }
        if (!exactBinding) return { reachable: true, error: 'Telegram provider account is not live' }

        // Normalize: prefix '+' for digit strings >= 10 chars
        let target: string = phone
        if (target.match(/^\d+$/) && target.length >= 10) {
            target = '+' + target
        }

        return await resolveEntity(
            exactBinding.client,
            target,
            exactBinding.providerAccountId,
        )
    } catch (err: any) {
        console.error(`[TG-CHECK] Error for ${phone}: ${err.message}`)
        return { reachable: true }
    }
}

/** Resolve phone to Telegram entity without sending a message. */
async function resolveEntity(
    client: TelegramClient,
    target: string,
    providerAccountId: string,
): Promise<{ reachable: boolean; telegramId?: string; providerAccountId: string; error?: string }> {
    // Step 1: Try getEntity
    try {
        const entity = await client.getEntity(target)
        const telegramId = concreteOpaqueId(entity?.id?.toString())
        if (telegramId) return { reachable: true, telegramId, providerAccountId }
    } catch {
        // Fall through to ImportContacts
    }

    // Step 2: Try ImportContacts (only for phone numbers starting with '+')
    if (!target.startsWith('+')) {
        return { reachable: false, providerAccountId, error: 'Номер не найден в Telegram' }
    }

    try {
        const result = await client.invoke(new Api.contacts.ImportContacts({
            contacts: [new Api.InputPhoneContact({
                clientId: BigInt(Math.floor(Math.random() * 1000000)) as any,
                phone: target,
                firstName: 'Check',
                lastName: ''
            })]
        }))

        if (result && 'users' in result && result.users.length > 0) {
            const telegramId = concreteOpaqueId(result.users[0]?.id?.toString())
            if (telegramId) return { reachable: true, telegramId, providerAccountId }
        }
    } catch {
        // Import failed — number not on Telegram
    }

    return { reachable: false, providerAccountId, error: 'Номер не найден в Telegram' }
}
