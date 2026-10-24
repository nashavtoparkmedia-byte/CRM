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
import { appendConversationIdentityCollisionV1, attachBinaryMessageMediaV1, attachMessageMediaV1, createChannelMessageV1, deleteConversationsByIdV1, deleteHistoryImportJobsForChannelV1, deleteHistoryImportJobsForConnectionV1, ensureConversationContactLinkV1, patchChannelConversationV1, patchHistoryImportJobV1, patchMessageDeliveryV1, patchMessageMetadataV1, prepareOutboundConversationV1, upsertChannelConversationV1 } from '@/modules/messaging/public/v1'
import { ATTACH_BINARY_MESSAGE_MEDIA_COMMAND_V1, ATTACH_MESSAGE_MEDIA_COMMAND_V1, CREATE_CHANNEL_MESSAGE_COMMAND_V1, DELETE_CONVERSATIONS_BY_ID_COMMAND_V1, DELETE_HISTORY_IMPORT_JOBS_FOR_CHANNEL_COMMAND_V1, DELETE_HISTORY_IMPORT_JOBS_FOR_CONNECTION_COMMAND_V1, ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1, PATCH_CHANNEL_CONVERSATION_COMMAND_V1, PATCH_HISTORY_IMPORT_JOB_COMMAND_V1, PATCH_MESSAGE_DELIVERY_COMMAND_V1, PATCH_MESSAGE_METADATA_COMMAND_V1, UPSERT_CHANNEL_CONVERSATION_COMMAND_V1 } from '@/contracts/messaging/v1'
import { projectTelegramConnectionMetadata } from '@/modules/telegram-channel/public/v1/telegram-connection-public-metadata'
import { getTelegramTransportOptionsV1 } from '@/modules/telegram-channel/public/v1'
import { requireIntegrationAdminAccess } from '@/modules/identity-access/public/v1'
import { cleanupDanglingContactIdentitiesV1, isResolvedChannelContactResultV1, markChannelIdentityConflictV1, resolveChannelContactOperationV1 } from '@/modules/contacts/public/v1'
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
// Global cache for Telegram clients to prevent constant reconnects
const clientCache = new Map<string, TelegramClient>()
// Authenticated provider account observed from client.getMe(), keyed by the
// transport connection row. A connection label/id is not itself account proof.
const tgProviderAccountIds = new Map<string, string>()
// instanceId per connection — links client to registry entry
const tgInstanceIds = new Map<string, string>()
// Idempotency guard: track which connections already have listeners attached
const initializedListeners = new Set<string>()

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

// Guard against concurrent initTelegramListeners calls
let _initPromise: Promise<void> | null = null

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

// Telegram's service-notifications account delivers login codes to the
// personal account as an ordinary private message. The exact peer is dropped
// before any persistence, publication or text-bearing log on every MTProto
// ingress path; no other peer is filtered.
const TELEGRAM_SERVICE_PEER_ID = '777000'

function isTelegramServicePeer(peerId: unknown): boolean {
    return peerId !== null && peerId !== undefined && String(peerId) === TELEGRAM_SERVICE_PEER_ID
}

type TelegramIngressLogPhase = TelegramPrivateIngressPhase | 'live' | 'catch-up'

function logTelegramServicePeerSkipped(phase: TelegramIngressLogPhase, connectionId: string): void {
    console.log(`[TG-INGRESS] telegram_mtproto_service_peer_skipped phase=${phase} conn=${connectionId}`)
}

// Ingress logs carry one bounded code, never error text: Prisma, GramJS and
// validation errors can echo message text, media data URLs, file names, names
// or provider ids. Only the closed sets below are emitted; everything else,
// including any provider-controlled or numeric token, is UNCLASSIFIED.
const TELEGRAM_INGRESS_ERROR_CODES = new Set([
    'TELEGRAM_PEER_ID_UNPROVEN',
    'TELEGRAM_PROVIDER_ACCOUNT_ID_UNPROVEN',
    'TELEGRAM_CONNECTION_ID_UNPROVEN',
    'TELEGRAM_PROVIDER_ACCOUNT_ID_CHANGED',
    'TELEGRAM_MESSAGE_IDENTITY_UNPROVEN',
    'TELEGRAM_CONVERSATION_IDENTITY_COLLISION',
    'CONTACT_CONVERSATION_DRIVER_MISMATCH',
    'CONTACT_CONVERSATION_OWNERSHIP_MISMATCH',
    'CONTACT_RESOLUTION_BLOCKED',
    'CONTACT_IDENTITY_LINK_MISMATCH',
    'CONTACT_IDENTITY_LINK_STALE',
    'CONTACT_CONVERSATION_LINK_STALE',
    'CONVERSATION_IDENTITY_COLLISION_CHAT_NOT_FOUND',
])
const TELEGRAM_INGRESS_ERROR_DETAILS = new Set([
    'channel_mismatch',
    'conversation_key_mismatch',
    'transport_connection_mismatch',
    'peer_identity_mismatch',
    'chat_kind_mismatch',
    'ambiguous',
    'archived',
    'error',
    'group_skipped',
    'identity_phone_conflict',
    'merge_cycle',
    'phone_evidence_blocked',
    'unknown_kind_limited',
])
const PRISMA_INGRESS_ERROR_CODES = new Set([
    'P1001', 'P1002', 'P1008', 'P1017', 'P2002', 'P2003', 'P2010', 'P2024', 'P2025', 'P2028', 'P2034',
])
const POSTGRES_INGRESS_ERROR_CODES = new Map([
    ['55P03', 'PG_LOCK_TIMEOUT'],
    ['40001', 'PG_SERIALIZATION_FAILURE'],
    ['40P01', 'PG_DEADLOCK'],
    ['57014', 'PG_QUERY_CANCELED'],
])
const TELEGRAM_RPC_INGRESS_ERROR_CODES = new Set([
    'FILE_REFERENCE_EXPIRED',
    'FILE_ID_INVALID',
    'FILE_MIGRATE',
    'FLOOD_WAIT',
    'LOCATION_INVALID',
    'MEDIA_EMPTY',
    'MSG_ID_INVALID',
    'NETWORK_MIGRATE',
    'PEER_ID_INVALID',
    'RPC_CALL_FAIL',
    'TIMEOUT',
    'AUTH_KEY_UNREGISTERED',
    'SESSION_REVOKED',
])
const ERROR_NAME_INGRESS_CODES = new Map([
    ['TypeError', 'JS_TYPE_ERROR'],
    ['RangeError', 'JS_RANGE_ERROR'],
    ['TimeoutError', 'TIMEOUT'],
    ['AbortError', 'ABORTED'],
    ['PrismaClientValidationError', 'PRISMA_VALIDATION'],
    ['PrismaClientInitializationError', 'PRISMA_INITIALIZATION'],
    ['PrismaClientUnknownRequestError', 'PRISMA_UNKNOWN_REQUEST'],
    ['PrismaClientRustPanicError', 'PRISMA_PANIC'],
])

function telegramIngressErrorCode(error: unknown): string {
    if (!error || typeof error !== 'object') return 'UNCLASSIFIED'
    const record = error as { code?: unknown; meta?: unknown; errorMessage?: unknown; message?: unknown; name?: unknown }
    if (typeof record.code === 'string') {
        if (PRISMA_INGRESS_ERROR_CODES.has(record.code)) {
            const databaseCode = metadataRecord(record.meta).code
            return (typeof databaseCode === 'string' && POSTGRES_INGRESS_ERROR_CODES.get(databaseCode)) || record.code
        }
        const databaseCode = POSTGRES_INGRESS_ERROR_CODES.get(record.code)
        if (databaseCode) return databaseCode
    }
    if (typeof record.errorMessage === 'string') {
        const rpcCode = record.errorMessage.replace(/_\d+$/u, '')
        if (TELEGRAM_RPC_INGRESS_ERROR_CODES.has(rpcCode)) return `TG_${rpcCode}`
    }
    if (typeof record.message === 'string') {
        const head = /^([A-Z][A-Z_]*[A-Z])(?::([a-z][a-z_]*[a-z]))?(?![A-Za-z0-9_])/u.exec(record.message)
        if (head && TELEGRAM_INGRESS_ERROR_CODES.has(head[1])) {
            return head[2] && TELEGRAM_INGRESS_ERROR_DETAILS.has(head[2]) ? `${head[1]}:${head[2]}` : head[1]
        }
    }
    return (typeof record.name === 'string' && ERROR_NAME_INGRESS_CODES.get(record.name)) || 'UNCLASSIFIED'
}

type TelegramIngressOutcome =
    | 'saved'
    | 'duplicate'
    | 'reconciled_send'
    | 'held_legacy'
    | 'key_conflict'
    | 'held'
    | 'held_transient'
    | 'rejected'
    | 'failed'
    | 'service_skipped'
    | 'skipped'

type TelegramIngressFailure = 'rejected' | 'held' | 'held_transient' | 'failed'

const TELEGRAM_REJECTED_CODES = new Set([
    'TELEGRAM_PEER_ID_UNPROVEN',
    'TELEGRAM_PROVIDER_ACCOUNT_ID_UNPROVEN',
    'TELEGRAM_CONNECTION_ID_UNPROVEN',
    'TELEGRAM_CONVERSATION_IDENTITY_COLLISION',
])
const TELEGRAM_HELD_CODES = new Set([
    'CONTACT_CONVERSATION_DRIVER_MISMATCH',
    'CONTACT_CONVERSATION_OWNERSHIP_MISMATCH',
    'CONTACT_RESOLUTION_BLOCKED',
    'CONTACT_IDENTITY_LINK_MISMATCH',
])
const TELEGRAM_HELD_TRANSIENT_CODES = new Set([
    'CONTACT_IDENTITY_LINK_STALE',
    'CONTACT_CONVERSATION_LINK_STALE',
    'PG_LOCK_TIMEOUT',
    'PG_SERIALIZATION_FAILURE',
    'PG_DEADLOCK',
    'PG_QUERY_CANCELED',
    'P1001',
    'P1002',
    'P1008',
    'P1017',
    'P2024',
    'P2028',
    'P2034',
])

/**
 * HOLD: an event whose attribution this admission could not prove. Nothing of
 * it is persisted, published, queued for AI or fed to workflow; admission's own
 * pre-link writes (Chat upsert, contact resolution) stay as they are. HOLD is
 * not message persistence and not loss prevention: the content stays only with
 * the provider and is recovered only if it is fetched again.
 */
function classifyTelegramIngressFailure(code: string): TelegramIngressFailure {
    const base = code.split(':')[0]
    if (TELEGRAM_REJECTED_CODES.has(base)) return 'rejected'
    if (TELEGRAM_HELD_CODES.has(base)) return 'held'
    if (TELEGRAM_HELD_TRANSIENT_CODES.has(base)) return 'held_transient'
    return 'failed'
}

type TelegramStoredMessageMatch =
    | { kind: 'none' }
    | { kind: 'duplicate'; messageId: string }
    | { kind: 'held_legacy' }
    | { kind: 'key_conflict' }
    | { kind: 'reconcile_send'; messageId: string }

type TelegramMessageOwner = { chatId: string; direction: 'inbound' | 'outbound' }

// A row found by an external key is this event's only if it lives in the
// admitted Chat, in the same direction, on the Telegram channel.
function isOwnTelegramMessageRow(
    row: { chatId: string; direction: string; channel: string | null },
    owner: TelegramMessageOwner,
): boolean {
    return row.chatId === owner.chatId && row.direction === owner.direction && row.channel === 'telegram'
}

// KEY-CONFLICT: a row already holds this event's external key but is not this
// event's. Nothing is written, attached, stamped, published or fed to
// workflow; the event is counted and stays with the provider.
function logTelegramMessageKeyConflict(loggerPrefix: string, chatId: string): void {
    console.warn(`[${loggerPrefix}] KEY-CONFLICT chat=${chatId} code=TELEGRAM_MESSAGE_KEY_CONFLICT`)
}

/**
 * Exact-key-first dedupe. An event with a valid provider message id is a
 * duplicate only of the row carrying its exact account+peer+message key in the
 * admitted Chat, direction and channel; the same key anywhere else is a
 * key_conflict. Two different provider messages are never collapsed by content
 * or time.
 * - A pre-2026-09-02 row keyed by the bare provider id records no provider
 *   account, so it is never treated as this event's duplicate. When it is in
 *   the same chat, direction and content the event is held instead of written
 *   twice (held_legacy); different content proves a different message.
 * - Outbound only: a CRM send row that does not carry a provider id yet is
 *   reconciled by content and the existing window and then stamped with the
 *   exact key, so it cannot absorb a second event. The claim is not
 *   compare-and-set; concurrent identical sends remain an open dependency.
 * An event without a provider id keeps the content+time window, restricted to
 * this account's local keys (and, outbound, to CRM send rows); that path is not
 * exact.
 */
async function findStoredTelegramMessage(input: {
    chatId: string
    exactExternalId: string | null
    providerMessageId: string | null
    providerAccountId: string
    peerId: string
    direction: 'inbound' | 'outbound'
    content: string
    sentAt: Date
    windowMs: number
}): Promise<TelegramStoredMessageMatch> {
    const sentAt = {
        gte: new Date(input.sentAt.getTime() - input.windowMs),
        lte: new Date(input.sentAt.getTime() + input.windowMs),
    }
    if (input.exactExternalId && input.providerMessageId) {
        const exact = await prisma.message.findUnique({
            where: { externalId: input.exactExternalId },
            select: { id: true, chatId: true, direction: true, channel: true },
        })
        if (exact) {
            return isOwnTelegramMessageRow(exact, input)
                ? { kind: 'duplicate', messageId: exact.id }
                : { kind: 'key_conflict' }
        }
        const legacy = await prisma.message.findUnique({
            where: { externalId: input.providerMessageId },
            select: { chatId: true, direction: true, channel: true, content: true },
        })
        if (
            legacy
            && legacy.chatId === input.chatId
            && legacy.direction === input.direction
            && legacy.channel === 'telegram'
            && legacy.content === input.content
        ) {
            return { kind: 'held_legacy' }
        }
        if (input.direction === 'outbound') {
            const pendingSend = await prisma.message.findFirst({
                where: {
                    chatId: input.chatId,
                    direction: 'outbound',
                    content: input.content,
                    externalId: null,
                    sentAt,
                },
                orderBy: { createdAt: 'asc' },
                select: { id: true },
            })
            if (pendingSend) return { kind: 'reconcile_send', messageId: pendingSend.id }
        }
        return { kind: 'none' }
    }
    const fallback = await prisma.message.findFirst({
        where: {
            chatId: input.chatId,
            direction: input.direction,
            content: input.content,
            sentAt,
            OR: [
                { externalId: { startsWith: `telegram:${input.providerAccountId}:${input.peerId}:local-` } },
                ...(input.direction === 'outbound' ? [{ externalId: null }] : []),
            ],
        },
        select: { id: true },
    })
    return fallback ? { kind: 'duplicate', messageId: fallback.id } : { kind: 'none' }
}

type TelegramMessageCreateResult =
    | { kind: 'created'; message: any }
    | { kind: 'duplicate'; messageId: string }
    | { kind: 'key_conflict' }

/**
 * Inserts under the unique external key. A concurrent writer of the same key
 * (P2002) is a benign duplicate only when the winning row is found and is this
 * event's: same Chat, direction and channel and, for a synthetic local key
 * (second resolution, no provider id), the same content. Any other winner is a
 * key_conflict; the insert wrote nothing and nothing is overwritten.
 */
async function createTelegramMessageOrFindWinner(input: {
    chatId: string
    direction: 'inbound' | 'outbound'
    content: string
    type: string
    sentAt: Date
    externalId: string
    syntheticKey: boolean
    metadata: Record<string, unknown>
}): Promise<TelegramMessageCreateResult> {
    try {
        const result = await createChannelMessageV1({ contract: CREATE_CHANNEL_MESSAGE_COMMAND_V1, chatId: input.chatId, direction: input.direction, content: input.content, channel: 'telegram', type: input.type as any, sentAt: input.sentAt, status: 'delivered', externalId: input.externalId, metadata: input.metadata })
        return { kind: 'created', message: result.message }
    } catch (error: unknown) {
        if ((error as { code?: unknown } | null)?.code !== 'P2002') throw error
        const winner = await prisma.message.findUnique({
            where: { externalId: input.externalId },
            select: { id: true, chatId: true, direction: true, channel: true, content: true },
        })
        if (!winner) throw error
        if (!isOwnTelegramMessageRow(winner, input)) return { kind: 'key_conflict' }
        if (input.syntheticKey && winner.content !== input.content) return { kind: 'key_conflict' }
        return { kind: 'duplicate', messageId: winner.id }
    }
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
    await appendConversationIdentityCollisionV1({ chatId: chat.id, evidence })
    if (chat.contactId && chat.contactIdentityId) {
        try {
            await markChannelIdentityConflictV1({
                contactId: chat.contactId,
                identityId: chat.contactIdentityId,
                channel: 'telegram',
                reason,
                evidenceRoot: `channel-collision:telegram:${chat.externalChatId}:${input.providerAccountId}:${input.connectionId}:${input.peerId}:${reason}`,
                details: {
                    phase: input.phase,
                    incomingPeerId: input.peerId,
                    existingPeerId,
                    incomingProviderAccountId: input.providerAccountId,
                    existingProviderAccountId,
                    incomingConnectionId: input.connectionId,
                    existingConnectionId,
                },
            })
        } catch (error: unknown) {
            console.error(`[TG-IDENTITY] Failed to mark linked identity conflicted: code=${telegramIngressErrorCode(error)}`)
        }
    }
    throw new Error(`TELEGRAM_CONVERSATION_IDENTITY_COLLISION:${reason}`)
}

/**
 * Admits one private GramJS conversation before any person/link/message write.
 * Telegram user ids are global-looking, but a CRM conversation is owned by the
 * exact authenticated account and transport that observed it. Legacy/unbound
 * rows are evidence gaps, not permission to claim the peer for this account.
 */
async function admitTelegramPrivateConversation(input: {
    phase: TelegramPrivateIngressPhase
    peerId: string
    providerAccountId: string
    connectionId: string
    displayName: string | null
    lastMessageAt?: Date
}): Promise<TelegramPrivateConversation> {
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
    const storedConnectionId = concreteOpaqueId(storedMetadata.connectionId)
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
    const reason = chat.channel !== 'telegram'
        ? 'channel_mismatch'
        : chat.externalChatId !== externalChatId
            ? 'conversation_key_mismatch'
            // A stored transport that disagrees is a real cross-transport claim.
            : storedConnectionId !== null && storedConnectionId !== connectionId
                ? 'transport_connection_mismatch'
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

    const contactResult = await resolveChannelContactOperationV1(
        'telegram',
        peerId,
        null,
        input.displayName,
        { chatKind: 'private', providerAccountId },
    )
    if (
        !isResolvedChannelContactResultV1(contactResult)
        || !contactResult.identity
        || contactResult.identity.channel !== 'telegram'
        || contactResult.identity.externalId !== peerId
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
            providerAccountId,
            providerTargetId: peerId,
            status: 'confirmed',
        })
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

async function processInboundTelegramMessage(
    message: any,
    connectionId: string,
    providerAccountId: string,
    loggerPrefix = 'TG-LISTENER',
    phase: 'inbound' | 'import' = 'inbound',
): Promise<TelegramIngressOutcome> {
    if (message && !message.out) {
        // Only PeerUser denotes a private conversation. A group/channel update
        // may still have fromId.userId; treating that sender as the dialog peer
        // would manufacture a private Chat from a room message.
        const senderId = message.peerId?.userId?.toString()
        if (isTelegramServicePeer(senderId)) {
            logTelegramServicePeerSkipped(phase, connectionId)
            return 'service_skipped'
        }
        const mediaInfo = detectTgMediaType(message)
        const text = message.message || (mediaInfo ? mediaInfo.fallback : '')
        if (!senderId || !text) return 'skipped'

        const rawExternalMsgId = message.id?.toString()
        const externalMsgId = rawExternalMsgId
            ? telegramMessageExternalId(providerAccountId, senderId, rawExternalMsgId)
            : null
        // Validate message.date — corrupted timestamps (Y2038 overflow,
        // pre-2013) would wreck chronology. If we can't trust the date,
        // drop the message rather than file it under "now".
        const validated = validateTgDate(message.date)
        if (!validated) {
            console.warn(`[${loggerPrefix}] skip bad-ts conn=${connectionId}`)
            return 'skipped'
        }
        const now = validated

        // Derive display name from GramJS sender entity
        const senderName = (() => {
            const fn = (message.sender?.firstName ?? '').trim()
            const ln = (message.sender?.lastName  ?? '').trim()
            const full = [fn, ln].filter(Boolean).join(' ').trim()
            if (/[А-Яа-яA-Za-z]/.test(full) && !/^[.\s\-_$]+$/.test(full)) return full
            if (message.sender?.username) return `@${message.sender.username}`
            return null
        })()

        // Admit the exact provider account + connection + peer and complete
        // Contacts ownership before any message or workflow side effect.
        const unifiedChat = await admitTelegramPrivateConversation({
            phase,
            peerId: senderId,
            providerAccountId,
            connectionId,
            displayName: senderName,
            lastMessageAt: now,
        })
        console.log(`[${loggerPrefix}] INBOUND conn=${connectionId} chat=${unifiedChat.id}`)

        // 3. DE-DUPLICATION: exact provider key first (see findStoredTelegramMessage)
        const stored = await findStoredTelegramMessage({
            chatId: unifiedChat.id,
            exactExternalId: externalMsgId,
            providerMessageId: externalMsgId ? rawExternalMsgId : null,
            providerAccountId,
            peerId: senderId,
            direction: 'inbound',
            content: text,
            sentAt: now,
            windowMs: 5000,
        })
        if (stored.kind === 'held_legacy') {
            console.log(`[${loggerPrefix}] LEGACY-HOLD chat=${unifiedChat.id}`)
            return 'held_legacy'
        }
        if (stored.kind === 'key_conflict') {
            logTelegramMessageKeyConflict(loggerPrefix, unifiedChat.id)
            return 'key_conflict'
        }
        const existing = stored.kind === 'duplicate' ? { id: stored.messageId } : null

        if (existing) {
            console.log(`[${loggerPrefix}] DB-DEDUP: skipped existing=${existing.id}`)
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
                    console.error(`[${loggerPrefix}] MEDIA retry failed for existing msg=${existing.id}: code=${telegramIngressErrorCode(retryErr)}`)
                }
            }
            return 'duplicate'
        } else {
            const msgType = mediaInfo?.type || 'text'
            const savedMsgResult = await createTelegramMessageOrFindWinner({ chatId: unifiedChat.id, direction: 'inbound', content: text, type: msgType, sentAt: now, externalId: externalMsgId || `telegram:${providerAccountId}:${senderId}:local-${now.getTime()}`, syntheticKey: !externalMsgId, metadata: rawExternalMsgId ? { providerMessageId: rawExternalMsgId, providerAccountId, peerId: senderId } : {} })
            if (savedMsgResult.kind === 'key_conflict') {
                logTelegramMessageKeyConflict(loggerPrefix, unifiedChat.id)
                return 'key_conflict'
            }
            if (savedMsgResult.kind === 'duplicate') {
                console.log(`[${loggerPrefix}] DB-DEDUP: concurrent writer existing=${savedMsgResult.messageId}`)
                return 'duplicate'
            }
            const savedMsg = savedMsgResult.message as any

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
                            console.log(`[${loggerPrefix}] MEDIA saved: ${msgType} for msg=${savedMsg.id}`)
                        }
                    }
                } catch (mediaErr: any) {
                    console.error(`[${loggerPrefix}] Media download failed for msg=${savedMsg.id}: code=${telegramIngressErrorCode(mediaErr)}`)
                }
            }

            console.log(`[${loggerPrefix}] SAVED inbound message=${savedMsg.id} chat=${unifiedChat.id} driver=${unifiedChat.driverId || 'none'}`)
            ConversationWorkflowService.onInboundMessage(unifiedChat.id, now).catch(e =>
                console.error(`[${loggerPrefix}] onInboundMessage error: code=${telegramIngressErrorCode(e)}`)
            )
            emitMessageReceived(savedMsg).catch(e =>
                console.error(`[${loggerPrefix}] emitMessageReceived error: code=${telegramIngressErrorCode(e)}`)
            )
            return 'saved'
        }
    }
    return 'skipped'
}

/**
 * Mirrors outbound messages sent from any Telegram client (not via CRM).
 * Called when GramJS fires NewMessage with message.out === true.
 *
 * Dedup strategy (findStoredTelegramMessage):
 *   1. Exact externalId (set by sendTelegramMessage if CRM sent it)
 *   2. A CRM send row that has no provider id yet, by content+time within 30s
 *      (handles race: GramJS fires before DB update); it is stamped with the
 *      exact id so it cannot absorb another event
 *   3. If not found → external send, create new outbound message
 */
async function processOutboundMirrorMessage(
    message: any,
    connectionId: string,
    providerAccountId: string,
    loggerPrefix = 'TG-MIRROR',
): Promise<TelegramIngressOutcome> {
    if (!message?.out) return 'skipped'

    // Recipient = the person we're writing TO (only private chats)
    const recipientId = message.peerId?.userId?.toString()
    if (isTelegramServicePeer(recipientId)) {
        logTelegramServicePeerSkipped('mirror', connectionId)
        return 'service_skipped'
    }
    if (!recipientId) return 'skipped'  // group/channel — skip

    const mediaInfo = detectTgMediaType(message)
    const text = message.message || (mediaInfo ? mediaInfo.fallback : '')
    // Skip only if there's truly nothing to save (no text, no media)
    if (!text && !mediaInfo) return 'skipped'

    const rawExternalMsgId = message.id?.toString()
    const externalMsgId = rawExternalMsgId
        ? telegramMessageExternalId(providerAccountId, recipientId, rawExternalMsgId)
        : null
    const validated = validateTgDate(message.date)
    if (!validated) return 'skipped'
    const sentAt = validated

    let recipient: any = message.chat ?? null
    if (!recipient && typeof message.getChat === 'function') {
        try { recipient = await message.getChat() } catch { /* display name remains optional */ }
    }
    const recipientName = (() => {
        const firstName = (recipient?.firstName ?? '').trim()
        const lastName = (recipient?.lastName ?? '').trim()
        const fullName = [firstName, lastName].filter(Boolean).join(' ').trim()
        if (fullName) return fullName
        if (recipient?.username) return `@${recipient.username}`
        return null
    })()

    // Mirrored messages are provider observations too. Re-admit and re-link
    // every event; an existing global peer key is never enough authority.
    const chat = await admitTelegramPrivateConversation({
        phase: 'mirror',
        peerId: recipientId,
        providerAccountId,
        connectionId,
        displayName: recipientName,
        lastMessageAt: sentAt,
    })

    const msgType = mediaInfo?.type || 'text'

    // Dedup: exact provider key first; content+time only for a CRM send row
    // that has no provider id yet (30s window handles send→event race)
    const stored = await findStoredTelegramMessage({
        chatId: chat.id,
        exactExternalId: externalMsgId,
        providerMessageId: externalMsgId ? rawExternalMsgId : null,
        providerAccountId,
        peerId: recipientId,
        direction: 'outbound',
        content: text,
        sentAt,
        windowMs: 30000,
    })
    if (stored.kind === 'held_legacy') {
        console.log(`[${loggerPrefix}] LEGACY-HOLD chat=${chat.id}`)
        return 'held_legacy'
    }
    if (stored.kind === 'key_conflict') {
        logTelegramMessageKeyConflict(loggerPrefix, chat.id)
        return 'key_conflict'
    }
    if (stored.kind === 'reconcile_send' || stored.kind === 'duplicate') {
        if (stored.kind === 'reconcile_send' && externalMsgId) {
            await patchMessageDeliveryV1({ contract: PATCH_MESSAGE_DELIVERY_COMMAND_V1, messageId: stored.messageId, externalId: externalMsgId, status: 'delivered' })
        }
        await ensureOutboundTelegramAttachment(message, stored.messageId, msgType, loggerPrefix)
        console.log(`[${loggerPrefix}] DEDUP: skipped existing=${stored.messageId}`)
        return stored.kind === 'reconcile_send' ? 'reconciled_send' : 'duplicate'
    }

    // New outbound message sent from outside CRM — mirror it
    const savedResult = await createTelegramMessageOrFindWinner({ chatId: chat.id, direction: 'outbound', content: text, type: msgType, sentAt, externalId: externalMsgId || `telegram:${providerAccountId}:${recipientId}:local-${sentAt.getTime()}`, syntheticKey: !externalMsgId, metadata: rawExternalMsgId ? { providerMessageId: rawExternalMsgId, providerAccountId, peerId: recipientId } : {} })
    if (savedResult.kind === 'key_conflict') {
        logTelegramMessageKeyConflict(loggerPrefix, chat.id)
        return 'key_conflict'
    }
    if (savedResult.kind === 'duplicate') {
        console.log(`[${loggerPrefix}] DEDUP: concurrent writer existing=${savedResult.messageId}`)
        return 'duplicate'
    }
    const saved = savedResult.message as any

    await ensureOutboundTelegramAttachment(message, saved.id, msgType, loggerPrefix)

    // Update chat's lastMessageAt
    await patchChannelConversationV1({ contract: PATCH_CHANNEL_CONVERSATION_COMMAND_V1, selector: { chatId: chat.id }, patch: { lastMessageAt: sentAt } })

    console.log(`[${loggerPrefix}] MIRRORED outbound message=${saved.id} type=${msgType} chat=${chat.id}`)

    emitMessageReceived(saved).catch(e =>
        console.error(`[${loggerPrefix}] emitMessageReceived error: code=${telegramIngressErrorCode(e)}`)
    )
    return 'saved'
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
        console.error(`[${loggerPrefix}] Media download failed: code=${telegramIngressErrorCode(mediaErr)} msg=${messageId}`)
    }
}

async function catchUpMissedMessages(
    client: TelegramClient,
    connectionId: string,
    providerAccountId: string,
) {
    const counts: Record<TelegramIngressOutcome, number> = {
        saved: 0,
        duplicate: 0,
        reconciled_send: 0,
        held_legacy: 0,
        key_conflict: 0,
        held: 0,
        held_transient: 0,
        rejected: 0,
        failed: 0,
        service_skipped: 0,
        skipped: 0,
    }
    let dialogCount = 0
    let failedDialogs = 0
    let serviceDialogs = 0
    let fetched = 0
    let runError: string | null = null
    try {
        console.log(`[TG-CATCHUP] Fetching recent dialogs for connectionId=${connectionId}`)
        const dialogs = await client.getDialogs({ limit: 30 })
        for (const dialog of dialogs) {
            if (!dialog.isUser) continue
            // F9: the service peer's dialog is never fetched.
            if (isTelegramServicePeer(dialog.entity?.id)) {
                serviceDialogs++
                logTelegramServicePeerSkipped('catch-up', connectionId)
                continue
            }
            dialogCount++
            try {
                // Telegram Web may mark a message read before CRM reconnects. Replay
                // a bounded recent window in both directions; processors dedupe by
                // stable provider message id.
                const total = Math.min(Math.max((dialog.unreadCount || 0) + 10, 20), 50)
                const messages = await client.getMessages(dialog.entity, { limit: total })
                const ordered = [...messages].reverse()
                for (let index = 0; index < ordered.length; index++) {
                    const msg = ordered[index]
                    fetched++
                    let outcome: TelegramIngressOutcome
                    try {
                        outcome = msg?.out
                            ? await processOutboundMirrorMessage(
                                msg,
                                connectionId,
                                providerAccountId,
                                'TG-CATCHUP-OUT',
                            )
                            : await processInboundTelegramMessage(
                                msg,
                                connectionId,
                                providerAccountId,
                                'TG-CATCHUP',
                                'import',
                            )
                    } catch (messageError: unknown) {
                        const code = telegramIngressErrorCode(messageError)
                        outcome = classifyTelegramIngressFailure(code)
                        console.warn(`[TG-CATCHUP] message ${outcome} conn=${connectionId} code=${code}`)
                    }
                    counts[outcome]++
                    if (outcome === 'held' || outcome === 'held_transient' || outcome === 'rejected') {
                        // The same admission fails the same way for the rest of
                        // this dialog; do not repeat its pre-link writes.
                        const remaining = ordered.length - index - 1
                        fetched += remaining
                        counts[outcome] += remaining
                        break
                    }
                }
            } catch (dialogError: unknown) {
                failedDialogs++
                console.warn(`[TG-CATCHUP] dialog failed conn=${connectionId} code=${telegramIngressErrorCode(dialogError)}`)
            }
        }
    } catch (err: unknown) {
        runError = telegramIngressErrorCode(err)
        console.error(`[TG-CATCHUP] Error: code=${runError}`)
    }
    console.log(`[TG-CATCHUP] summary conn=${connectionId} dialogs=${dialogCount} fetched=${fetched} saved=${counts.saved} duplicates=${counts.duplicate} reconciledSend=${counts.reconciled_send} heldLegacy=${counts.held_legacy} keyConflicts=${counts.key_conflict} held=${counts.held} heldTransient=${counts.held_transient} rejected=${counts.rejected} failed=${counts.failed} skipped=${counts.skipped} serviceSkipped=${counts.service_skipped + serviceDialogs} failedDialogs=${failedDialogs}${runError ? ` error=${runError}` : ''}`)
    if (!runError) console.log(`[TG-CATCHUP] Finished. Processed ${fetched} messages.`)
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

        console.log(`[TG-REACTION] msg=${message.id} reactions=${Object.keys(reactionsMap).length}`)
    } catch (err: any) {
        console.error(`[TG-REACTION] Error: code=${telegramIngressErrorCode(err)}`)
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
        const msg = event.message
        // F9: the exact service peer never reaches either processor.
        if (isTelegramServicePeer(msg?.peerId?.userId)) {
            logTelegramServicePeerSkipped('live', connectionId)
            return
        }
        try {
            if (msg?.out) {
                await processOutboundMirrorMessage(msg, connectionId, providerAccountId, 'TG-MIRROR')
            } else {
                await processInboundTelegramMessage(msg, connectionId, providerAccountId, 'TG-LISTENER')
            }
        } catch (err: unknown) {
            const code = telegramIngressErrorCode(err)
            console.error(`[TG-LISTENER] Error (conn=${connectionId}): ${classifyTelegramIngressFailure(code)} code=${code}`)
        }
    }, new NewMessage({ incoming: true, outgoing: true }))

    client.addEventHandler(
        (event: any) => processReactionUpdate(event, connectionId, providerAccountId),
        new Raw({ types: [Api.UpdateMessageReactions] })
    )

    initializedListeners.add(connectionId)
    console.log(`[TG-LISTENER] Listener attached for connectionId=${connectionId}`)
}

/**
 * Initialize GramJS listeners for ALL active Telegram connections.
 * Idempotent — safe to call multiple times (e.g. from startup + API route).
 */
export async function initTelegramListeners() {
    if (_initPromise) {
        console.log(`[TG-INIT] Already initializing, waiting for existing promise...`)
        return _initPromise
    }

    _initPromise = (async () => {
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
            _initPromise = null
        }
    })()

    return _initPromise
}

let _healthInterval: ReturnType<typeof setInterval> | null = null

// TG hard-restart — tears down the cached client and re-inits from scratch.
// Triggered by the health check when a connection sits in 'degraded' state
// past the threshold. 5-min cooldown per connection so we don't DDoS
// Telegram's MTProto if something upstream is broken.
const tgHardRestartLastAt = new Map<string, number>()
const TG_HARD_RESTART_COOLDOWN_MS = 5 * 60 * 1000

async function scheduleTgHardRestart(connection: any, reason: string): Promise<void> {
    const { operationalLogV1: opsLog } = await import('@/infrastructure/operations/operational-log')

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
    if (_healthInterval) return // Already running

    _healthInterval = setInterval(async () => {
        for (const conn of connections) {
            const client = clientCache.get(conn.id)
            const curInstanceId = tgInstanceIds.get(conn.id)

            if (!client || !curInstanceId) continue

            if (client.connected) {
                registry.touch(conn.id, curInstanceId)
            } else {
                // Connection lost — use registry reconnect policy
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
    if (_healthInterval) {
        clearInterval(_healthInterval)
        _healthInterval = null
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
            const providerAccountId = await attestTelegramProviderAccount(cached, connection.id)
            attachInboundListener(cached, connection.id, providerAccountId)
            catchUpMissedMessages(cached, connection.id, providerAccountId).catch(() => {})
            return cached
        }
        try {
            await cached.connect()
            const providerAccountId = await attestTelegramProviderAccount(cached, connection.id)
            attachInboundListener(cached, connection.id, providerAccountId)
            catchUpMissedMessages(cached, connection.id, providerAccountId).catch(() => {})
            return cached
        } catch (e) {
            console.warn(`[TG-CACHE] Failed to reconnect cached client ${connection.id}, creating new one.`)
            clientCache.delete(connection.id)
            initializedListeners.delete(connection.id)
            tgProviderAccountIds.delete(connection.id)
        }
    }

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
    catchUpMissedMessages(client, connection.id, providerAccountId).catch(() => {})

    clientCache.set(connection.id, client)
    return client
}

// ── Exact outbound person, reply proof and pre-dispatch outcome ──────────────
//
// GramJS addresses a user only with the access hash this process has learned
// from an RPC result: a StringSession persists no entities and a short incoming
// message carries no user, so a cold cache misses people the account talks to
// every day. On a miss the client sweeps its recent dialogs once and looks the
// exact numeric id up again. Nothing else is ever tried: no phone, username or
// contact import, and never a group or channel that shares the number.

const TELEGRAM_MTPROTO_REFUSED = 'TELEGRAM_MTPROTO_REFUSED'
const TELEGRAM_MTPROTO_NOT_DISPATCHED = 'TELEGRAM_MTPROTO_NOT_DISPATCHED'
// The published S1 adapter outcome grammar (MessageService): an error that
// already states its outcome keeps it.
const S1_ADAPTER_OUTCOME_CODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:SEND_OUTCOME_UNKNOWN|NOT_DISPATCHED|REFUSED)\b/
// Deterministic answers before dispatch: the conversation gate, the live
// account proof, a person a fresh sweep could not find, or an unprovable quote.
const TELEGRAM_SEND_REFUSAL_CODE = /\b(?:CONTACT_CONVERSATION_[A-Z_]+|TELEGRAM_PROVIDER_ACCOUNT_ID_[A-Z_]+|TELEGRAM_PEER_UNRESOLVED|TELEGRAM_REPLY_TARGET_NOT_ADDRESSABLE|TELEGRAM_REPLY_TARGET_UNPROVEN)\b/
const TELEGRAM_PEER_SWEEP_DIALOGS = 200
const TELEGRAM_PEER_SWEEP_WAIT_MS = 15_000
const TELEGRAM_PEER_SWEEP_MAX_AGE_MS = 60_000
const TELEGRAM_PEER_SWEEP_INTERVAL_MS = 60_000
const TELEGRAM_MAX_MESSAGE_ID = 2_147_483_647

function telegramRpcErrorCode(error: unknown): number | null {
    const code = (error as { code?: unknown } | null)?.code
    return typeof code === 'number' ? code : null
}

function withTelegramRpcErrorCode(message: string, error: unknown): Error {
    const code = telegramRpcErrorCode(error)
    return Object.assign(new Error(message), code === null ? {} : { code })
}

/**
 * The S1 outcome of a failed text send. Before the provider call nothing that
 * carries the message has left: a deterministic refusal, or a dead session
 * (RPC 401), is REFUSED; anything else is NOT_DISPATCHED. Once the call began
 * the error goes on exactly as before.
 */
function telegramSendFailure(error: unknown, dispatchStarted: boolean): Error {
    if (dispatchStarted) return new Error(`Telegram delivery failed: ${(error as { message?: unknown } | null)?.message}`)
    const detail = error instanceof Error ? error.message : String(error)
    if (S1_ADAPTER_OUTCOME_CODE.test(detail)) return new Error(`Telegram delivery failed: ${detail}`)
    const refused = TELEGRAM_SEND_REFUSAL_CODE.test(detail) || telegramRpcErrorCode(error) === 401
    return new Error(`Telegram delivery failed: ${detail} (${refused ? TELEGRAM_MTPROTO_REFUSED : TELEGRAM_MTPROTO_NOT_DISPATCHED})`)
}

type TelegramPeerSweep = { startedAt: number, settled: boolean, answered: Promise<boolean> }

// Single-flight per client object, so a replaced client never joins or
// inherits another client's sweep. The FLOOD_WAIT back-off is per connection:
// Telegram's flood window belongs to the account, not to the socket.
const telegramPeerSweeps = new WeakMap<TelegramClient, TelegramPeerSweep>()
const telegramPeerSweepNotBefore = new Map<string, number>()

/** Joins this client's sweep in flight or starts one; null when none may start yet. */
function telegramPeerSweep(
    client: TelegramClient,
    connectionId: string,
): { started: boolean, answered: Promise<boolean> } | null {
    const now = Date.now()
    const current = telegramPeerSweeps.get(client)
    // A sweep that never settles is released at a fixed age and counts as failed.
    if (current && !current.settled && now - current.startedAt < TELEGRAM_PEER_SWEEP_MAX_AGE_MS) {
        return { started: false, answered: current.answered }
    }
    if (now < (telegramPeerSweepNotBefore.get(connectionId) ?? 0)) return null
    telegramPeerSweepNotBefore.set(connectionId, now + TELEGRAM_PEER_SWEEP_INTERVAL_MS)
    const sweep: TelegramPeerSweep = { startedAt: now, settled: false, answered: Promise.resolve(false) }
    // getDialogs caches every user it returns; it fetches no message history,
    // admits nothing and writes nothing.
    sweep.answered = client.getDialogs({ limit: TELEGRAM_PEER_SWEEP_DIALOGS }).then(
        () => {
            console.log(`[TG-SEND] telegram_mtproto_peer_sweep outcome=ok conn=${connectionId}`)
            return true
        },
        (error: unknown) => {
            const seconds = Number((error as { seconds?: unknown } | null)?.seconds)
            if (telegramRpcErrorCode(error) === 420 && Number.isFinite(seconds) && seconds > 0) {
                const notBefore = Date.now() + Math.max(TELEGRAM_PEER_SWEEP_INTERVAL_MS, seconds * 1000)
                telegramPeerSweepNotBefore.set(connectionId, Math.max(notBefore, telegramPeerSweepNotBefore.get(connectionId) ?? 0))
            }
            console.warn(`[TG-SEND] telegram_mtproto_peer_sweep outcome=failed code=${telegramIngressErrorCode(error)} conn=${connectionId}`)
            return false
        },
    ).finally(() => { sweep.settled = true })
    telegramPeerSweeps.set(client, sweep)
    return { started: true, answered: sweep.answered }
}

async function waitForTelegramPeerSweep(answered: Promise<boolean>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), TELEGRAM_PEER_SWEEP_WAIT_MS)
    })
    try {
        return await Promise.race([answered, timedOut])
    } finally {
        clearTimeout(timer)
    }
}

/** The proofs were made on this exact client and account; a replaced one proves nothing. */
function assertTelegramSendClientCurrent(client: TelegramClient, connectionId: string, providerAccountId: string): void {
    const liveAccountId = tgProviderAccountIds.get(connectionId)
    if (clientCache.get(connectionId) !== client || !client.connected || liveAccountId === undefined) {
        throw new Error('TELEGRAM_SEND_CLIENT_REPLACED')
    }
    if (liveAccountId !== providerAccountId) throw new Error('TELEGRAM_PROVIDER_ACCOUNT_ID_CHANGED')
}

async function lookupExactTelegramUser(client: TelegramClient, target: string): Promise<Api.User | null> {
    let entity: unknown
    try {
        entity = await client.getEntity(BigInt(target) as any)
    } catch (error: unknown) {
        // GramJS's own miss: this process holds no access hash for the id.
        if (error instanceof Error && error.message.startsWith('Could not find the input entity')) return null
        throw withTelegramRpcErrorCode(`TELEGRAM_PEER_RESOLUTION_UNAVAILABLE:${telegramIngressErrorCode(error)}`, error)
    }
    // GramJS looks a positive id up as a user, then as a basic group or channel
    // with the same number; only that exact user is ever addressed.
    return entity instanceof Api.User && entity.id?.toString() === target ? entity : null
}

async function resolveExactTelegramUserEntity(
    client: TelegramClient,
    connectionId: string,
    providerAccountId: string,
    target: string,
): Promise<Api.User> {
    const cached = await lookupExactTelegramUser(client, target)
    if (cached) return cached
    const sweep = telegramPeerSweep(client, connectionId)
    if (!sweep || !(await waitForTelegramPeerSweep(sweep.answered))) {
        throw new Error('TELEGRAM_PEER_RESOLUTION_UNAVAILABLE:sweep')
    }
    assertTelegramSendClientCurrent(client, connectionId, providerAccountId)
    const swept = await lookupExactTelegramUser(client, target)
    if (swept) return swept
    // Only the call that started the sweep after its own miss may conclude the
    // person is absent: a joined sweep may have started before this call missed.
    throw new Error(sweep.started ? 'TELEGRAM_PEER_UNRESOLVED' : 'TELEGRAM_PEER_RESOLUTION_UNAVAILABLE:joined')
}

type TelegramReplyTarget = { id: number, legacy: boolean }

/** The quote, parsed with this channel's own forms: never Number() of a composite id. */
function telegramReplyTarget(quotedMsgId: string, providerAccountId: string, peerId: string): TelegramReplyTarget {
    const current = exactTelegramProviderMessageId(quotedMsgId, providerAccountId, peerId)
    const raw = current ?? (/^[1-9]\d*$/.test(quotedMsgId) ? quotedMsgId : null)
    const id = raw === null ? 0 : Number(raw)
    if (!Number.isSafeInteger(id) || id < 1 || id > TELEGRAM_MAX_MESSAGE_ID) {
        throw new Error('TELEGRAM_REPLY_TARGET_NOT_ADDRESSABLE')
    }
    return { id, legacy: current === null }
}

/** A requested quote is a live message of this dialog, or the send is refused. */
async function proveTelegramReplyTarget(
    client: TelegramClient,
    entity: Api.User,
    quotedMsgId: string,
    target: TelegramReplyTarget,
    chatId: string,
    peerId: string,
): Promise<number> {
    let found: unknown
    try {
        const [message] = await client.getMessages(entity, { ids: [target.id] })
        found = message
    } catch (error: unknown) {
        throw withTelegramRpcErrorCode(`TELEGRAM_REPLY_TARGET_PROOF_UNAVAILABLE:${telegramIngressErrorCode(error)}`, error)
    }
    // GramJS answers nothing for an empty or foreign id; a service message
    // cannot be quoted.
    const peer = found instanceof Api.Message ? found.peerId : null
    if (
        !(found instanceof Api.Message)
        || found.id !== target.id
        || !(peer instanceof Api.PeerUser)
        || peer.userId?.toString() !== peerId
    ) {
        throw new Error('TELEGRAM_REPLY_TARGET_UNPROVEN')
    }
    if (target.legacy) {
        // A bare id names no account: it is this conversation's message only if the
        // row this Chat stored under it carries the provider's own timestamp.
        const stored = await (prisma.message as any).findUnique({
            where: { externalId: quotedMsgId },
            select: { chatId: true, sentAt: true },
        })
        const storedSeconds = stored?.sentAt instanceof Date ? Math.floor(stored.sentAt.getTime() / 1000) : null
        if (!stored || stored.chatId !== chatId || storedSeconds !== found.date) {
            throw new Error('TELEGRAM_REPLY_TARGET_UNPROVEN')
        }
    }
    return target.id
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

    const entity = await resolveExactTelegramUserEntity(client, connection.id, liveProviderAccountId, target)
    return { client, connection, entity, providerAccountId: liveProviderAccountId }
}

export async function sendTelegramMessage(phoneNumber: string, message: string, connectionId?: string, metadata?: { messageId?: string, chatId?: string, driverId?: string, quotedMsgId?: string }) {
    if (!metadata?.chatId) {
        throw telegramSendFailure(new Error('CONTACT_CONVERSATION_IDENTITY_REQUIRED'), false)
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
            .catch((error: unknown) => { throw telegramSendFailure(error, false) })
        connection = await (prisma as any).telegramConnection.findUnique({
            where: { id: carrierId, isActive: true },
        })
        console.log('[TG-SEND] Legacy unbound conversation routed through the single active carrier')
    }

    if (!connection || !connection.sessionString) {
        console.error(`[TG-SEND] ERROR: Telegram not connected or inactive. connectionId=${connectionId}`)
        throw telegramSendFailure(new Error('Telegram is not connected or selected account is inactive'), false)
    }

    const client = await getTelegramClient(connection)
        .catch((error: unknown) => { throw telegramSendFailure(error, false) })
    console.log(`[TG-SEND] Client connected state: ${client.connected}`)

    let dispatchStarted = false
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

        if (!exactPreparedTarget || !exactProviderAccountId) {
            throw new Error('CONTACT_CONVERSATION_IDENTITY_REQUIRED')
        }
        const entity = await resolveExactTelegramUserEntity(client, connection.id, exactProviderAccountId, exactPreparedTarget)
        const replyTo = metadata?.quotedMsgId
            ? await proveTelegramReplyTarget(
                client,
                entity,
                metadata.quotedMsgId,
                telegramReplyTarget(metadata.quotedMsgId, exactProviderAccountId, exactPreparedTarget),
                metadata.chatId,
                exactPreparedTarget,
            )
            : undefined
        assertTelegramSendClientCurrent(client, connection.id, exactProviderAccountId)

        console.log(`[TG-SEND] Sending message to entity...`)
        
        // Add a safety timeout for the actual sending
        const sendOpts: any = { message }
        if (replyTo !== undefined) sendOpts.replyTo = replyTo
        dispatchStarted = true
        const result = await Promise.race([
            client.sendMessage(entity, sendOpts),
            new Promise<any>((_, reject) => setTimeout(() => reject(new Error('Telegram sendMessage timeout (25s)')), 25000))
        ])
        
        console.log(`[TG-SEND] Message delivery SUCCESS`)
        const sendInstanceId = tgInstanceIds.get(connection?.id)
        if (connection && sendInstanceId) registry.touch(connection.id, sendInstanceId)

        // Messaging owns the already-created optimistic row and applies this
        // exact provider result. The transport must not migrate/create Chats
        // or grant DriverTelegram authority as a side effect of delivery.
        const rawExternalId = (result as any)?.id?.toString()
        return {
            success: true,
            externalId: rawExternalId && exactPreparedTarget && exactProviderAccountId
                ? telegramMessageExternalId(exactProviderAccountId, exactPreparedTarget, rawExternalId)
                : undefined,
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
        console.error(`[TG-IMPORT] Failed to get client: code=${telegramIngressErrorCode(err)}`)
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
    let totalChats = 0
    let totalContacts = 0
    let minDate: Date | null = null
    let maxDate: Date | null = null
    // Completeness evidence for a bounded fetch (B3-a strict).
    const dialogLimit = 100
    const msgLimit = mode === 'from_connection_time' ? 20 : 200
    let existingMessages = 0
    let heldLegacyMessages = 0
    let keyConflictMessages = 0
    let reconciledSendMessages = 0
    let failedMessages = 0
    let heldDialogs = 0
    let rejectedDialogs = 0
    let failedDialogs = 0
    let serviceSkipped = 0
    let dialogsWithMessageCapHit = 0

    try {
        // 5. Fetch dialogs (up to 100)
        const dialogs = await client.getDialogs({ limit: dialogLimit })
        console.log(`[TG-IMPORT] Found ${dialogs.length} dialogs`)
        const unpinnedDialogs = dialogs.filter((dialog: any) => !dialog.pinned)
        const oldestDialogAt = unpinnedDialogs.length > 0
            ? validateTgDate((unpinnedDialogs[unpinnedDialogs.length - 1] as any).message?.date ?? (unpinnedDialogs[unpinnedDialogs.length - 1] as any).date)
            : null
        const dialogsCapHit = dialogs.length >= dialogLimit && (!oldestDialogAt || oldestDialogAt >= cutoff)

        for (const dialog of dialogs) {
            if (!dialog.isUser) continue // skip groups/channels for now

            const peerId = dialog.entity?.id?.toString()
            // F9: the service peer's dialog is neither admitted nor fetched.
            if (isTelegramServicePeer(peerId)) {
                serviceSkipped++
                logTelegramServicePeerSkipped('import', connection.id)
                continue
            }
            totalChats++
            if (!peerId) continue

            const providerDisplayName = (dialog.entity as any)?.firstName
                || (dialog.entity as any)?.username
                || null

            try {
                const unifiedChat = await admitTelegramPrivateConversation({
                    phase: 'import',
                    peerId,
                    providerAccountId,
                    connectionId: connection.id,
                    displayName: providerDisplayName,
                })
                totalContacts++

                // Fetch messages — limit determined by mode (msgLimit)
                const messages = await client.getMessages(dialog.entity!, { limit: msgLimit })
                if (messages.length >= msgLimit) {
                    // Newest-first page: if its oldest message is still inside the
                    // window, older messages of the window were not fetched.
                    const fetchedDates = messages
                        .map((msg: any) => validateTgDate(msg.date))
                        .filter((date): date is Date => date !== null)
                    const oldestFetched = fetchedDates.length > 0
                        ? new Date(Math.min(...fetchedDates.map(date => date.getTime())))
                        : null
                    if (!oldestFetched || oldestFetched >= cutoff) dialogsWithMessageCapHit++
                }

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
                    totalMessages++

                    // One failing message never costs the rest of the dialog.
                    try {
                        const rawExternalMsgId = msg.id?.toString()
                        const externalMsgId = rawExternalMsgId
                            ? telegramMessageExternalId(providerAccountId, peerId, rawExternalMsgId)
                            : null
                        const isOutbound = !!msg.out
                        const histMsgType = histMediaInfo?.type || 'text'

                        // Dedup: exact provider key first (see findStoredTelegramMessage)
                        const stored = await findStoredTelegramMessage({
                            chatId: unifiedChat.id,
                            exactExternalId: externalMsgId,
                            providerMessageId: externalMsgId ? rawExternalMsgId : null,
                            providerAccountId,
                            peerId,
                            direction: isOutbound ? 'outbound' : 'inbound',
                            content: msgText,
                            sentAt: ts,
                            windowMs: 5000,
                        })
                        if (stored.kind === 'held_legacy') {
                            heldLegacyMessages++
                            continue
                        }
                        if (stored.kind === 'key_conflict') {
                            keyConflictMessages++
                            logTelegramMessageKeyConflict('TG-IMPORT', unifiedChat.id)
                            continue
                        }
                        if (stored.kind === 'reconcile_send') {
                            if (externalMsgId) {
                                await patchMessageDeliveryV1({ contract: PATCH_MESSAGE_DELIVERY_COMMAND_V1, messageId: stored.messageId, externalId: externalMsgId, status: 'delivered' })
                            }
                            reconciledSendMessages++
                            continue
                        }
                        if (stored.kind === 'duplicate') {
                            existingMessages++
                            continue
                        }

                        const savedHistResult = await createTelegramMessageOrFindWinner({ chatId: unifiedChat.id, direction: isOutbound ? 'outbound' : 'inbound', content: msgText, type: histMsgType, sentAt: ts, externalId: externalMsgId || `telegram:${providerAccountId}:${peerId}:local-${ts.getTime()}`, syntheticKey: !externalMsgId, metadata: rawExternalMsgId ? { providerMessageId: rawExternalMsgId, providerAccountId, peerId } : {} })
                        if (savedHistResult.kind === 'key_conflict') {
                            keyConflictMessages++
                            logTelegramMessageKeyConflict('TG-IMPORT', unifiedChat.id)
                            continue
                        }
                        if (savedHistResult.kind === 'duplicate') {
                            existingMessages++
                            continue
                        }
                        const savedHistMsg = savedHistResult.message as any

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
                    } catch (messageError: unknown) {
                        failedMessages++
                        console.warn(`[TG-IMPORT] message failed job=${jobId} code=${telegramIngressErrorCode(messageError)}`)
                    }
                }

                // Update lastMessageAt
                if (chatMaxTs) {
                    await patchChannelConversationV1({ contract: PATCH_CHANNEL_CONVERSATION_COMMAND_V1, selector: { chatId: unifiedChat.id }, patch: { lastMessageAt: chatMaxTs } })
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
            } catch (chatErr: any) {
                const code = telegramIngressErrorCode(chatErr)
                const outcome = classifyTelegramIngressFailure(code)
                if (outcome === 'held' || outcome === 'held_transient') heldDialogs++
                else if (outcome === 'rejected') rejectedDialogs++
                else failedDialogs++
                console.error(`[TG-IMPORT] Dialog ${outcome} job=${jobId} code=${code}`)
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

        // 7. Complete. A bounded fetch never proves the whole period, so this
        // job is never 'full' (B3-a strict): it is 'partial' whenever it saw any
        // in-window message or any cap, hold, key conflict or failure, else
        // 'live_only'.
        // Counts are this run's own; database totals are context only.
        const incomplete = dialogsCapHit
            || dialogsWithMessageCapHit > 0
            || heldDialogs > 0
            || rejectedDialogs > 0
            || failedDialogs > 0
            || failedMessages > 0
            || heldLegacyMessages > 0
            || keyConflictMessages > 0
        const resultType = totalMessages > 0 || incomplete ? 'partial' : 'live_only'
        await updateTgImportJob(jobId, {
            status: 'completed',
            resultType,
            messagesImported: totalMessages,
            chatsScanned: totalChats,
            contactsFound: totalContacts,
            finishedAt: new Date(),
            coveredPeriodFrom: minDate,
            coveredPeriodTo: maxDate,
            detailsJson: {
                newMessages,
                existingMessages,
                completeness: {
                    basis: 'bounded-fetch',
                    requestedFrom: cutoff.toISOString(),
                    dialogsReturned: dialogs.length,
                    dialogsCap: dialogLimit,
                    dialogsCapHit,
                    messagesCap: msgLimit,
                    dialogsWithMessageCapHit,
                    heldDialogs,
                    rejectedDialogs,
                    failedDialogs,
                    failedMessages,
                    heldLegacyMessages,
                    keyConflictMessages,
                    reconciledSendMessages,
                    serviceSkipped,
                    archivedFolderCoverage: 'unverified',
                    providerDeletionCoverage: 'none',
                    proof: 'none',
                },
                databaseContext: {
                    telegramMessagesSinceCutoff: dbMsgCount,
                    telegramChats: dbChatCount,
                    telegramContacts: dbContactCount,
                },
            },
        })
        console.log(`[TG-IMPORT] Completed job=${jobId}: result=${resultType} ${totalMessages} msgs (${newMessages} new), ${totalChats} chats, ${totalContacts} contacts`)
    } catch (err: any) {
        console.error(`[TG-IMPORT] Fatal error job=${jobId}: code=${telegramIngressErrorCode(err)}`)
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
        console.error(`[TG-IMPORT] updateTgImportJob error: code=${telegramIngressErrorCode(err)}`)
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
                await catchUpMissedMessages(client, id, providerAccountId)
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
