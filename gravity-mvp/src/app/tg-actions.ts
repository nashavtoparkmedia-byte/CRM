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
            console.error('[TG-IDENTITY] Failed to mark linked identity conflicted:', error)
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
    const storedProviderAccountId = concreteOpaqueId(storedMetadata.providerAccountId)
    const storedConnectionId = concreteOpaqueId(storedMetadata.connectionId)
    const storedPeerId = concreteOpaqueId(storedMetadata.peerId)
    const reason = chat.channel !== 'telegram'
        ? 'channel_mismatch'
        : chat.externalChatId !== externalChatId
            ? 'conversation_key_mismatch'
            : storedProviderAccountId === null
                ? 'provider_account_unproven'
                : storedProviderAccountId !== providerAccountId
                    ? 'provider_account_mismatch'
                    : storedConnectionId === null
                        ? 'transport_connection_unproven'
                        : storedConnectionId !== connectionId
                            ? 'transport_connection_mismatch'
                            : storedPeerId === null
                                ? 'peer_identity_unproven'
                                : storedPeerId !== peerId
                                    ? 'peer_identity_mismatch'
                                    : chat.chatType !== 'private' || storedMetadata.chatKind !== 'private'
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
) {
    if (message && !message.out) {
        // Only PeerUser denotes a private conversation. A group/channel update
        // may still have fromId.userId; treating that sender as the dialog peer
        // would manufacture a private Chat from a room message.
        const senderId = message.peerId?.userId?.toString()
        const mediaInfo = detectTgMediaType(message)
        const text = message.message || (mediaInfo ? mediaInfo.fallback : '')
        if (!senderId || !text) return

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

        // 3. DE-DUPLICATION: by externalId or content+time
        const existing = await (prisma.message as any).findFirst({
            where: {
                OR: [
                    ...(externalMsgId ? [{ externalId: externalMsgId }] : []),
                    {
                        chatId: unifiedChat.id,
                        content: text,
                        direction: 'inbound',
                        sentAt: {
                            gte: new Date(now.getTime() - 5000),
                            lte: new Date(now.getTime() + 5000)
                        }
                    }
                ]
            }
        })

        if (existing) {
            console.log(`[${loggerPrefix}] DB-DEDUP: skipped msgId=${externalMsgId} (existing=${existing.id})`)
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
        } else {
            const msgType = mediaInfo?.type || 'text'
            const savedMsgResult = await createChannelMessageV1({ contract: CREATE_CHANNEL_MESSAGE_COMMAND_V1, chatId: unifiedChat.id, direction: 'inbound', content: text, channel: 'telegram', type: msgType as any, sentAt: now, status: 'delivered', externalId: externalMsgId || `telegram:${providerAccountId}:${senderId}:local-${now.getTime()}`, metadata: rawExternalMsgId ? { providerMessageId: rawExternalMsgId, providerAccountId, peerId: senderId } : {} })
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
                            console.log(`[${loggerPrefix}] MEDIA saved: ${msgType} ${mimeType} for msg=${savedMsg.id}`)
                        }
                    }
                } catch (mediaErr: any) {
                    console.error(`[${loggerPrefix}] Media download failed for msg=${savedMsg.id}:`, mediaErr.message)
                }
            }

            console.log(`[${loggerPrefix}] SAVED inbound msgId=${externalMsgId} chat=${unifiedChat.id} driver=${unifiedChat.driverId || 'none'}`)
            ConversationWorkflowService.onInboundMessage(unifiedChat.id, now).catch(e =>
                console.error(`[${loggerPrefix}] onInboundMessage error:`, e.message)
            )
            emitMessageReceived(savedMsg).catch(e =>
                console.error(`[${loggerPrefix}] emitMessageReceived error:`, e.message)
            )
        }
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
    const contentForDedup = text

    // Dedup: by externalId OR by content+time (30s window handles send→event race)
    const existing = await (prisma.message as any).findFirst({
        where: {
            OR: [
                ...(externalMsgId ? [{ externalId: externalMsgId }] : []),
                {
                    chatId: chat.id,
                    content: contentForDedup,
                    direction: 'outbound',
                    sentAt: {
                        gte: new Date(sentAt.getTime() - 30000),
                        lte: new Date(sentAt.getTime() + 30000),
                    },
                },
            ],
        },
    })

    if (existing) {
        if (!existing.externalId && externalMsgId) {
            await patchMessageDeliveryV1({ contract: PATCH_MESSAGE_DELIVERY_COMMAND_V1, messageId: existing.id, externalId: externalMsgId, status: 'delivered' })
        }
        await ensureOutboundTelegramAttachment(message, existing.id, msgType, loggerPrefix)
        console.log(`[${loggerPrefix}] DEDUP: skipped msgId=${externalMsgId} (existing=${existing.id})`)
        return
    }

    // New outbound message sent from outside CRM — mirror it
    const savedResult = await createChannelMessageV1({ contract: CREATE_CHANNEL_MESSAGE_COMMAND_V1, chatId: chat.id, direction: 'outbound', content: text, channel: 'telegram', type: msgType as any, sentAt, status: 'delivered', externalId: externalMsgId || `telegram:${providerAccountId}:${recipientId}:local-${sentAt.getTime()}`, metadata: rawExternalMsgId ? { providerMessageId: rawExternalMsgId, providerAccountId, peerId: recipientId } : {} })
    const saved = savedResult.message as any

    await ensureOutboundTelegramAttachment(message, saved.id, msgType, loggerPrefix)

    // Update chat's lastMessageAt
    await patchChannelConversationV1({ contract: PATCH_CHANNEL_CONVERSATION_COMMAND_V1, selector: { chatId: chat.id }, patch: { lastMessageAt: sentAt } })

    console.log(`[${loggerPrefix}] MIRRORED outbound msgId=${externalMsgId} type=${msgType} chat=${chat.id}`)

    emitMessageReceived(saved).catch(e =>
        console.error(`[${loggerPrefix}] emitMessageReceived error:`, e.message)
    )
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
) {
    try {
        console.log(`[TG-CATCHUP] Fetching recent dialogs for connectionId=${connectionId}`)
        const dialogs = await client.getDialogs({ limit: 30 })
        let processedCount = 0
        for (const dialog of dialogs) {
            if (!dialog.isUser) continue
            // Telegram Web may mark a message read before CRM reconnects. Replay
            // a bounded recent window in both directions; processors dedupe by
            // stable provider message id.
            const total = Math.min(Math.max((dialog.unreadCount || 0) + 10, 20), 50)
            const messages = await client.getMessages(dialog.entity, { limit: total })
            for (const msg of messages.reverse()) {
                if (msg?.out) {
                    await processOutboundMirrorMessage(
                        msg,
                        connectionId,
                        providerAccountId,
                        'TG-CATCHUP-OUT',
                    )
                } else {
                    await processInboundTelegramMessage(
                        msg,
                        connectionId,
                        providerAccountId,
                        'TG-CATCHUP',
                        'import',
                    )
                }
                processedCount++
            }
        }
        console.log(`[TG-CATCHUP] Finished. Processed ${processedCount} messages.`)
    } catch (err: any) {
        console.error(`[TG-CATCHUP] Error: ${err.message}`)
    }
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
            const msg = event.message
            if (msg?.out) {
                await processOutboundMirrorMessage(msg, connectionId, providerAccountId, 'TG-MIRROR')
            } else {
                await processInboundTelegramMessage(msg, connectionId, providerAccountId, 'TG-LISTENER')
            }
        } catch (err: any) {
            console.error(`[TG-LISTENER] Error (conn=${connectionId}):`, err.message)
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

type ExactTelegramOutboundProof = {
    chatId: string
    providerAccountId: string
    identityTarget: string
}

async function resolveExactTelegramOutboundPeer(
    target: string,
    connectionId: string,
    proof: ExactTelegramOutboundProof,
) {
    if (
        !/^\d+$/.test(target)
        || target === '0'
        || concreteOpaqueId(connectionId) !== connectionId
        || concreteOpaqueId(proof.chatId) !== proof.chatId
        || concreteOpaqueId(proof.providerAccountId) !== proof.providerAccountId
        || proof.identityTarget !== target
    ) {
        throw new Error('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
    }
    const connection = await (prisma as any).telegramConnection.findUnique({
        where: { id: connectionId, isActive: true },
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
    const liveProviderAccountId = await attestTelegramProviderAccount(client, connection.id)
    if (
        prepared.channel !== 'telegram'
        || prepared.chatId !== proof.chatId
        || prepared.connectionId !== connection.id
        || prepared.providerAccountId !== proof.providerAccountId
        || prepared.providerAccountId !== liveProviderAccountId
        || prepared.identityTarget !== target
        || prepared.target !== target
    ) {
        throw new Error('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
    }

    const entity = await client.getEntity(BigInt(target) as any)
    if (entity?.id?.toString() !== target) {
        throw new Error('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
    }
    return { client, connection, entity }
}

export async function sendTelegramMessage(phoneNumber: string, message: string, connectionId?: string, metadata?: { messageId?: string, chatId?: string, driverId?: string, quotedMsgId?: string }) {
    if (!metadata?.chatId) {
        throw new Error('CONTACT_CONVERSATION_IDENTITY_REQUIRED')
    }
    console.log(`[TG-SEND] START: phone=${phoneNumber}, connectionId=${connectionId}, metadata=${JSON.stringify(metadata)}`)
    let connection
    
    if (connectionId) {
        connection = await (prisma as any).telegramConnection.findUnique({
            where: { id: connectionId, isActive: true }
        })
        console.log(`[TG-SEND] Using specific connection: ${connectionId} (found: ${!!connection})`)
    } else {
        connection = await (prisma as any).telegramConnection.findFirst({
            where: { isActive: true, isDefault: true }
        })
        console.log(`[TG-SEND] Using default connection (found: ${!!connection})`)
        
        // Fallback to any active connection if default is not available
        if (!connection) {
             connection = await (prisma as any).telegramConnection.findFirst({
                 where: { isActive: true }
             })
             console.log(`[TG-SEND] Fallback to any active connection (found: ${!!connection})`)
        }
    }

    if (!connection || !connection.sessionString) {
        console.error(`[TG-SEND] ERROR: Telegram not connected or inactive. connectionId=${connectionId}`)
        throw new Error('Telegram is not connected or selected account is inactive')
    }

    const client = await getTelegramClient(connection)
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
            if (
                prepared.channel !== 'telegram'
                || prepared.chatId !== chat.id
                || prepared.connectionId !== connection.id
                || prepared.providerAccountId !== liveProviderAccountId
                || prepared.identityTarget !== phoneNumber
                || prepared.target !== phoneNumber
            ) {
                throw new Error('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
            }
            exactPreparedTarget = prepared.target
            exactProviderAccountId = liveProviderAccountId
        }

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
                entity = await client.getEntity(BigInt(exactPreparedTarget) as any)
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
            if (exactPreparedTarget && entity?.id?.toString() !== exactPreparedTarget) {
                throw new Error('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
            }
        } catch (entityErr: any) {
            console.warn(`[TG-SEND] getEntity FAILED for ${target}: ${entityErr.message}. Attempting import...`)

            if (exactPreparedTarget) {
                throw new Error(`Cannot resolve exact Telegram peer ${exactPreparedTarget}`)
            }
            
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
        
        // Add a safety timeout for the actual sending
        const sendOpts: any = { message }
        if (metadata?.quotedMsgId) sendOpts.replyTo = Number(metadata.quotedMsgId)
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
        const rawExternalId = (result as any)?.id?.toString()
        return {
            success: true,
            externalId: rawExternalId && exactPreparedTarget && exactProviderAccountId
                ? telegramMessageExternalId(exactProviderAccountId, exactPreparedTarget, rawExternalId)
                : undefined,
        }
    } catch (err: any) {
        console.error('[TG-SEND] SEND ERROR:', err)
        throw new Error(`Telegram delivery failed: ${err.message}`)
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
    connectionId: string,
    proof: ExactTelegramOutboundProof,
): Promise<{ success: boolean; externalId?: string }> {
    console.log(`[TG-MEDIA] START: phone=${phoneNumber} filename=${filename} mime=${mimeType} connId=${connectionId}`)

    try {
        const { client, connection, entity } = await resolveExactTelegramOutboundPeer(
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
                ? telegramMessageExternalId(proof.providerAccountId, proof.identityTarget, rawExternalId)
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
    connectionId: string
    proof: ExactTelegramOutboundProof
}): Promise<void> {
    const rawMessageId = exactTelegramProviderMessageId(
        input.messageId,
        input.proof.providerAccountId,
        input.target,
    )
    const messageId = rawMessageId ? Number.parseInt(rawMessageId, 10) : Number.NaN
    if (!Number.isSafeInteger(messageId) || messageId <= 0 || String(messageId) !== rawMessageId) {
        throw new Error('TELEGRAM_MESSAGE_ID_INVALID')
    }
    const { client, entity } = await resolveExactTelegramOutboundPeer(
        input.target,
        input.connectionId,
        input.proof,
    )
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
            totalChats++

            const peerId = dialog.entity?.id?.toString()
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

                    // Dedup
                    const existing = await (prisma.message as any).findFirst({
                        where: {
                            OR: [
                                ...(externalMsgId ? [{ externalId: externalMsgId }] : []),
                                {
                                    chatId: unifiedChat.id,
                                    content: msgText,
                                    direction: isOutbound ? 'outbound' : 'inbound',
                                    sentAt: { gte: new Date(ts.getTime() - 5000), lte: new Date(ts.getTime() + 5000) }
                                }
                            ]
                        }
                    })

                    totalMessages++
                    if (!existing) {
                        const savedHistResult = await createChannelMessageV1({ contract: CREATE_CHANNEL_MESSAGE_COMMAND_V1, chatId: unifiedChat.id, direction: isOutbound ? 'outbound' : 'inbound', content: msgText, channel: 'telegram', type: histMsgType as any, sentAt: ts, status: 'delivered', externalId: externalMsgId || `telegram:${providerAccountId}:${peerId}:local-${ts.getTime()}`, metadata: rawExternalMsgId ? { providerMessageId: rawExternalMsgId, providerAccountId, peerId } : {} })
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
                console.error(`[TG-IMPORT] Dialog error peerId=${peerId}: ${chatErr.message}`)
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
            detailsJson: { newMessages, existingMessages: finalMessages - newMessages },
        })
        console.log(`[TG-IMPORT] Completed job=${jobId}: ${finalMessages} msgs (${newMessages} new), ${finalChats} chats, ${finalContacts} contacts`)
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
