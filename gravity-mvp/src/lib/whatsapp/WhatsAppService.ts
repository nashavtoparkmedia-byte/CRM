/**
 * WhatsAppService — Baileys implementation.
 *
 * Replaces whatsapp-web.js + Puppeteer/Chromium with direct WebSocket
 * (Noise protocol) via @whiskeysockets/baileys. No browser runtime needed.
 *
 * Public API surface is preserved so whatsapp-actions.ts and UI do not change:
 *   - initializeClient(connectionId)
 *   - destroyClient(connectionId)
 *   - destroyAllClients()
 *   - forceResetSession(connectionId)
 *   - getClient(connectionId)
 *   - getRuntimeStatus()
 *   - resetSyncGuard(connectionId)
 *   - forceSync(connectionId)
 *   - sendMessage(connectionId, chatId, text)
 *   - sendMedia(connectionId, chatId, dataUrl, opts)  [stub in Phase 1]
 *   - downloadMedia(messageId, chatId)                [stub in Phase 1]
 *   - importWhatsAppHistory(...)                      [stub in Phase 1]
 *   - checkReachability(phone)
 *   - checkAllClientsHealth()
 *   - getActualStatus(connectionId)
 *   - ActualWhatsAppState (type export)
 *
 * Lifecycle fixes carried over from previous fix(whatsapp) commits:
 *   FIX 1: initPromises in-flight guard
 *   FIX 2: non-destructive smart reuse
 *   FIX 3: destroy stale client before clients.set
 *   FIX 4: removeAllListeners in destroy path
 *   FIX 5: instanceIds.delete on terminal transitions
 *   FIX 6: sync guard order (set before, rollback on failure)
 *   FIX 7: forceResetLocks serialization
 *   FIX 8: sequential warmup (in instrumentation.ts)
 */

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    WASocket,
    proto,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage,
    Browsers,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import path from 'path'
import fs from 'fs'
import { DriverMatchService } from '@/lib/DriverMatchService'
import { ContactService } from '@/lib/ContactService'
import { ConversationWorkflowService } from '@/lib/ConversationWorkflowService'
import { emitMessageReceived } from '@/lib/messageEvents'
import * as registry from '@/lib/TransportRegistry'
import { opsLog } from '@/lib/opsLog'

const MAX_MEDIA_SIZE_BYTES = 10 * 1024 * 1024 // 10MB per file (kept for Phase 2)
const HISTORY_MONTHS = 3
const AUTH_BASE = path.join(process.cwd(), 'node_modules', '.baileys_auth')

// Silent pino logger — Baileys is verbose by default
const logger = pino({ level: 'warn' })

// ─── Global singletons (hot-reload safe) ─────────────────────────────
const globalForWA = global as unknown as { waBaileysClients?: Map<string, WASocket> }
const clients: Map<string, WASocket> = globalForWA.waBaileysClients || new Map()
if (process.env.NODE_ENV !== 'production') globalForWA.waBaileysClients = clients

const globalForWAIds = global as unknown as { _waInstanceIds?: Map<string, string> }
const instanceIds: Map<string, string> = globalForWAIds._waInstanceIds || new Map()
if (process.env.NODE_ENV !== 'production') globalForWAIds._waInstanceIds = instanceIds

const globalSyncDone = global as unknown as { _waSyncDone?: Set<string> }
const syncDoneSet: Set<string> = globalSyncDone._waSyncDone || new Set()
if (process.env.NODE_ENV !== 'production') globalSyncDone._waSyncDone = syncDoneSet

// FIX 1: In-flight init guard
const globalForInitPromises = global as unknown as { _waInitPromises?: Map<string, Promise<void>> }
const initPromises: Map<string, Promise<void>> = globalForInitPromises._waInitPromises || new Map()
if (process.env.NODE_ENV !== 'production') globalForInitPromises._waInitPromises = initPromises

// FIX 7: forceReset serialization
const globalForResetLocks = global as unknown as { _waResetLocks?: Map<string, Promise<void>> }
const forceResetLocks: Map<string, Promise<void>> = globalForResetLocks._waResetLocks || new Map()
if (process.env.NODE_ENV !== 'production') globalForResetLocks._waResetLocks = forceResetLocks

// Pause flag per connection — when paused, incoming messages go to buffer
const globalForPaused = global as unknown as { _waPaused?: Set<string> }
const pausedSet: Set<string> = globalForPaused._waPaused || new Set()
if (process.env.NODE_ENV !== 'production') globalForPaused._waPaused = pausedSet

// Per-connection message buffer (while paused). In-memory only — lost on restart.
const globalForBuffer = global as unknown as { _waBuffer?: Map<string, proto.IWebMessageInfo[]> }
const messageBuffers: Map<string, proto.IWebMessageInfo[]> = globalForBuffer._waBuffer || new Map()
if (process.env.NODE_ENV !== 'production') globalForBuffer._waBuffer = messageBuffers

// Per-connection time cutoff for selective history ingest ("last N days" mode).
// Messages older than cutoff are skipped in handleIncomingMessage.
const globalForCutoffs = global as unknown as { _waSyncCutoffs?: Map<string, Date> }
const connectionSyncCutoffs: Map<string, Date> = globalForCutoffs._waSyncCutoffs || new Map()
if (process.env.NODE_ENV !== 'production') globalForCutoffs._waSyncCutoffs = connectionSyncCutoffs

// Cached phone numbers per client (for "outbound" detection in message handler)
const clientPhones: Map<string, string> = new Map()

// ─── DB helpers ──────────────────────────────────────────────────────

async function safeUpdateConnection(connectionId: string, data: any) {
    try {
        await prisma.whatsAppConnection.update({ where: { id: connectionId }, data })
    } catch (err: any) {
        if (err?.code === 'P2025') {
            console.log(`[WA-SERVICE] Connection ${connectionId} not found, destroying client.`)
            destroyClient(connectionId).catch(() => {})
        } else {
            console.error(`[WA-SERVICE] Failed to update connection ${connectionId}:`, err)
        }
    }
}

function getHistoryCutoff(): Date {
    const d = new Date()
    d.setMonth(d.getMonth() - HISTORY_MONTHS)
    return d
}

// ─── JID helpers ─────────────────────────────────────────────────────
// Baileys user JID: "79221853150@s.whatsapp.net"
// Legacy wa-web.js: "79221853150@c.us"
// We store legacy format in DB for backward compat with existing records.

function toLegacyJid(jid: string): string {
    if (!jid) return jid
    return jid.replace('@s.whatsapp.net', '@c.us').replace(':0', '')
}

function toBaileysJid(jid: string): string {
    if (!jid) return jid
    if (jid.includes('@g.us')) return jid // group
    return jid.replace('@c.us', '@s.whatsapp.net')
}

function extractPhoneDigits(jid: string): string {
    return String(jid).split('@')[0].split(':')[0].replace(/\D/g, '')
}

// ─── Message type mapping ────────────────────────────────────────────

function baileysMessageType(m: proto.IWebMessageInfo): string {
    const msg = m.message
    if (!msg) return 'unknown'
    if (msg.conversation || msg.extendedTextMessage) return 'chat'
    if (msg.imageMessage) return 'image'
    if (msg.videoMessage) return 'video'
    if (msg.audioMessage) return msg.audioMessage.ptt ? 'ptt' : 'audio'
    if (msg.documentMessage) return 'document'
    if (msg.stickerMessage) return 'sticker'
    if (msg.locationMessage) return 'location'
    if (msg.contactMessage) return 'vcard'
    return 'unknown'
}

// Legacy WhatsAppMessage enum: chat, image, audio, video, sticker, voice, document
function mapMsgType(waType: string): string {
    const map: Record<string, string> = {
        chat: 'chat',           // plain text → 'chat' in legacy enum
        image: 'image',
        video: 'video',
        ptt: 'voice',           // push-to-talk → voice
        audio: 'audio',
        document: 'document',
        sticker: 'sticker',
        // location / vcard / unknown — not in enum, fallback to chat
    }
    return map[waType] || 'chat'
}

// Unified MessageType enum: text, image, audio, video, sticker, voice, document, system, call
function mapToUnifiedMessageType(waType: string): 'text' | 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker' {
    const map: Record<string, 'text' | 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker'> = {
        chat: 'text',
        image: 'image',
        video: 'video',
        ptt: 'voice',
        audio: 'audio',
        document: 'document',
        sticker: 'sticker',
        // location / vcard / unknown — fallback to text
    }
    return map[waType] || 'text'
}

function waContentWithFallback(body: string | null | undefined, type: string): string {
    if (body) return body
    const fallbacks: Record<string, string> = {
        image: '[Изображение]', video: '[Видео]', audio: '[Голосовое сообщение]',
        ptt: '[Голосовое сообщение]', document: '[Документ]', sticker: '[Стикер]',
        location: '[Геолокация]', vcard: '[Контакт]',
    }
    return fallbacks[type] || '[Сообщение]'
}

function extractMessageBody(m: proto.IWebMessageInfo): string {
    const msg = m.message
    if (!msg) return ''
    return msg.conversation
        || msg.extendedTextMessage?.text
        || msg.imageMessage?.caption
        || msg.videoMessage?.caption
        || msg.documentMessage?.caption
        || ''
}

// ─── Core init ───────────────────────────────────────────────────────

export async function initializeClient(connectionId: string): Promise<void> {
    // FIX 1: In-flight guard — parallel callers share the same Promise
    const inFlight = initPromises.get(connectionId)
    if (inFlight) {
        opsLog('info', 'wa_init_joined_in_flight', { connectionId })
        return inFlight
    }

    const promise = doInitializeClient(connectionId)
    initPromises.set(connectionId, promise)
    try {
        await promise
    } finally {
        initPromises.delete(connectionId)
    }
}

async function doInitializeClient(connectionId: string): Promise<void> {
    registry.ensureEntry(connectionId, 'whatsapp')

    // FIX 2: Non-destructive smart-reuse
    const existingSock = clients.get(connectionId)
    const existingEntry = registry.getEntry(connectionId)
    if (existingSock && existingEntry?.state === 'ready') {
        const lastSeen = existingEntry.lastSeen?.getTime() ?? 0
        const heartbeatAgeMs = Date.now() - lastSeen
        if (heartbeatAgeMs < 5 * 60 * 1000) {
            opsLog('info', 'wa_init_skipped_healthy', { connectionId, heartbeatAgeMs })
            return
        }
        opsLog('warn', 'wa_init_existing_stale_destroying', { connectionId, heartbeatAgeMs })
        await destroyClient(connectionId).catch(() => {})
    }

    const instanceId = registry.beginNewInstance(connectionId)
    instanceIds.set(connectionId, instanceId)

    const authDir = path.join(AUTH_BASE, `session-${connectionId}`)
    await fs.promises.mkdir(authDir, { recursive: true }).catch(() => {})

    const initStartedAt = Date.now()
    opsLog('info', 'wa_init_call', { connectionId, instanceId })

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir)
        const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 0] as [number, number, number] }))

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger as any),
            },
            logger: logger as any,
            // Desktop browser identity is REQUIRED for recent-history sync via
            // messaging-history.set event. Mobile/Chrome identities get far fewer messages.
            browser: Browsers.macOS('Desktop'),
            markOnlineOnConnect: false,
            syncFullHistory: true,
            generateHighQualityLinkPreview: false,
        })

        // FIX 3: drop any stale socket for this id before overwriting the map
        const stalePrev = clients.get(connectionId)
        if (stalePrev) {
            opsLog('warn', 'wa_init_prev_client_destroy', { connectionId })
            try { (stalePrev as any).end?.(undefined) } catch { /* ignore */ }
            try { (stalePrev as any).ws?.close?.() } catch { /* ignore */ }
        }

        clients.set(connectionId, sock)

        // Auth creds persistence
        sock.ev.on('creds.update', saveCreds)

        // Connection lifecycle
        sock.ev.on('connection.update', async (update) => {
            if (!registry.isCurrentInstance(connectionId, instanceId)) return

            const { connection, lastDisconnect, qr } = update

            if (qr) {
                opsLog('info', 'wa_qr_received', { connectionId, instanceId })
                try {
                    const QRCode = (await import('qrcode')).default
                    const qrDataUrl = await QRCode.toDataURL(qr)
                    await safeUpdateConnection(connectionId, { status: 'qr', sessionData: qrDataUrl })
                } catch (err) {
                    console.error(`[WA-SERVICE] QR encode error for ${connectionId}:`, err)
                }
            }

            if (connection === 'connecting') {
                opsLog('info', 'wa_connecting', { connectionId, instanceId })
            }

            if (connection === 'open') {
                registry.setReady(connectionId, instanceId)
                const phone = extractPhoneDigits(sock.user?.id || '')
                clientPhones.set(connectionId, phone)
                opsLog('info', 'wa_ready', { connectionId, instanceId, phone })
                await safeUpdateConnection(connectionId, {
                    status: 'ready',
                    phoneNumber: phone || null,
                })
                // FIX 6: set flag BEFORE sync, rollback on failure
                if (!syncDoneSet.has(connectionId)) {
                    syncDoneSet.add(connectionId)
                    syncHistory(connectionId, sock)
                        .then(() => opsLog('info', 'wa_sync_complete', { connectionId, instanceId }))
                        .catch(err => {
                            syncDoneSet.delete(connectionId)
                            opsLog('error', 'wa_sync_failed', {
                                connectionId, instanceId, error: err?.message ?? String(err),
                            })
                        })
                } else {
                    opsLog('info', 'wa_sync_skipped_already_done', { connectionId, instanceId })
                }
            }

            if (connection === 'close') {
                const code = (lastDisconnect?.error as any)?.output?.statusCode
                const isLogout = code === DisconnectReason.loggedOut
                opsLog('warn', 'wa_disconnected', {
                    connectionId, instanceId,
                    code, reason: isLogout ? 'LOGOUT' : 'CONNECTION_LOST',
                    error: lastDisconnect?.error?.message,
                })

                if (isLogout) {
                    registry.setFailed(connectionId, instanceId, `logout`)
                    await safeUpdateConnection(connectionId, { status: 'error' })
                } else {
                    await safeUpdateConnection(connectionId, { status: 'disconnected' })
                }
                clients.delete(connectionId)
                clientPhones.delete(connectionId)
                instanceIds.delete(connectionId) // FIX 5

                if (!isLogout) {
                    registry.setReconnecting(connectionId, instanceId)
                    registry.scheduleReconnect(connectionId, instanceId, () => initializeClient(connectionId))
                }
            }
        })

        // Incoming / outgoing messages
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (!registry.isCurrentInstance(connectionId, instanceId)) return
            registry.touch(connectionId, instanceId)
            // 'notify' = live, 'append' = historical — process both for CRM inbox
            if (type !== 'notify' && type !== 'append') return

            for (const m of messages) {
                try {
                    await handleIncomingMessage(connectionId, sock, m)
                } catch (err) {
                    console.error(`[WA-SERVICE] Message handler error ${connectionId}:`, err)
                }
            }
        })

        // Historical messages batch — Baileys delivers this after connection.open for recent history
        sock.ev.on('messaging-history.set', async ({ messages, isLatest }) => {
            if (!registry.isCurrentInstance(connectionId, instanceId)) return
            opsLog('info', 'wa_history_batch', {
                connectionId, instanceId,
                messageCount: messages.length, isLatest,
            })
            for (const m of messages) {
                try {
                    await handleIncomingMessage(connectionId, sock, m)
                } catch (err) {
                    console.error(`[WA-SERVICE] History message error ${connectionId}:`, err)
                }
            }
        })

        // ACK events prove channel is alive
        sock.ev.on('messages.update', () => {
            if (!registry.isCurrentInstance(connectionId, instanceId)) return
            registry.touch(connectionId, instanceId)
        })

        opsLog('info', 'wa_init_success', {
            connectionId, instanceId, elapsedMs: Date.now() - initStartedAt,
        })
    } catch (err: any) {
        const elapsedMs = Date.now() - initStartedAt
        const msg = err?.message ?? String(err)
        const errorClass =
            /auth/i.test(msg) ? 'auth_failure' :
            /connect|network|timeout/i.test(msg) ? 'network_error' :
            'other'
        opsLog('error', 'wa_init_failed', {
            connectionId, instanceId, elapsedMs, errorClass,
            errorMessage: msg,
            errorStack: err?.stack?.split('\n').slice(0, 5).join('\n'),
        })
        await safeUpdateConnection(connectionId, { status: 'error' })
        registry.setFailed(connectionId, instanceId, `init_failed: ${errorClass}`)
        clients.delete(connectionId)
        clientPhones.delete(connectionId)
        instanceIds.delete(connectionId)
        // No throw — warmup continues
    }
}

// ─── Incoming message handler ────────────────────────────────────────

async function handleIncomingMessage(
    connectionId: string,
    sock: WASocket,
    m: proto.IWebMessageInfo,
): Promise<void> {
    const remoteJid = m.key?.remoteJid
    if (!remoteJid) return

    // Skip system / status messages
    if (remoteJid === 'status@broadcast') return
    // Skip group messages for now (CRM is 1:1 focused)
    if (remoteJid.endsWith('@g.us')) return

    const isOutbound = !!m.key?.fromMe
    const waMsgId = m.key?.id
    if (!waMsgId) return

    const rawChatId = toLegacyJid(remoteJid) // 79221853150@c.us
    const waType = baileysMessageType(m)
    const body = extractMessageBody(m)
    const ts = new Date((Number(m.messageTimestamp) || 0) * 1000)

    // ROSTER: persist chat as anchor for future backfill (fetchMessageHistory).
    // Update oldestMsgKey/oldestMsgTs only when this message is older than stored.
    // Survives DB message wipe — key data for re-sync without QR rescan.
    try {
        const existing = await prisma.whatsAppChatRoster.findUnique({
            where: { connectionId_jid: { connectionId, jid: remoteJid } },
        })
        const shouldUpdateAnchor = !existing?.oldestMsgTs || ts < existing.oldestMsgTs
        await prisma.whatsAppChatRoster.upsert({
            where: { connectionId_jid: { connectionId, jid: remoteJid } },
            update: {
                name: (m as any).pushName || existing?.name || null,
                lastSeen: new Date(),
                ...(shouldUpdateAnchor ? {
                    oldestMsgKey: m.key as any,
                    oldestMsgTs: ts,
                } : {}),
            },
            create: {
                connectionId,
                jid: remoteJid,
                name: (m as any).pushName || null,
                oldestMsgKey: m.key as any,
                oldestMsgTs: ts,
                lastSeen: new Date(),
            },
        })
    } catch (err: any) {
        // Non-critical — roster is a helper, don't break message flow
        console.warn(`[WA-ROSTER] upsert failed:`, err.message)
    }

    // PAUSE: buffer message for later flush, don't process now
    if (pausedSet.has(connectionId)) {
        const buf = messageBuffers.get(connectionId) ?? []
        buf.push(m)
        messageBuffers.set(connectionId, buf)
        return
    }

    // SYNC CUTOFF: skip messages older than configured cutoff ("last N days" mode)
    const cutoff = connectionSyncCutoffs.get(connectionId)
    if (cutoff && ts < cutoff) {
        return
    }
    const direction = isOutbound ? 'outbound' : 'inbound'

    const phoneDigits = extractPhoneDigits(remoteJid)
    const normalizedPhone = phoneDigits.length >= 10 ? '7' + phoneDigits.slice(-10) : phoneDigits
    const normalizedExternalId = `whatsapp:${normalizedPhone}`

    console.log(`[WA-SERVICE] ${direction.toUpperCase()} msgId=${waMsgId} partner=${rawChatId} body="${body.substring(0, 30)}"`)

    try {
        // Legacy WhatsAppChat upsert
        await prisma.whatsAppChat.upsert({
            where: { id: rawChatId },
            update: { lastMessageAt: ts },
            create: { id: rawChatId, connectionId, lastMessageAt: ts },
        })

        // Unified Chat
        const searchSuffix = normalizedPhone.slice(-10)
        let unifiedChat = await (prisma.chat as any).findFirst({
            where: {
                channel: 'whatsapp',
                OR: [
                    { externalChatId: normalizedExternalId },
                    { externalChatId: rawChatId },
                    { externalChatId: phoneDigits },
                    { externalChatId: { endsWith: searchSuffix } },
                ],
            },
            orderBy: { driverId: 'desc' },
        })

        if (unifiedChat) {
            await (prisma.chat as any).update({
                where: { id: unifiedChat.id },
                data: {
                    externalChatId: normalizedExternalId,
                    lastMessageAt: ts,
                    metadata: { ...(unifiedChat.metadata as any || {}), connectionId },
                },
            })
        } else {
            unifiedChat = await (prisma.chat as any).create({
                data: {
                    externalChatId: normalizedExternalId,
                    channel: 'whatsapp',
                    lastMessageAt: ts,
                    metadata: { connectionId },
                },
            })
        }

        // Driver relinking (best effort)
        if (!unifiedChat.driverId) {
            try {
                const matched = await DriverMatchService.linkChatToDriver(unifiedChat.id, { phone: phoneDigits })
                if (matched) {
                    unifiedChat = await (prisma.chat as any).findUnique({ where: { id: unifiedChat.id } })
                }
            } catch { /* non-blocking */ }
        }

        // Contact resolution
        try {
            const contactResult = await ContactService.resolveContact(
                'whatsapp', normalizedPhone, phoneDigits,
                (m as any).pushName || unifiedChat.name || null,
            )
            await ContactService.ensureChatLinked(
                unifiedChat.id, contactResult.contact.id, contactResult.identity.id,
            )
        } catch (err: any) {
            console.error(`[WA-SERVICE] ContactService error (non-blocking):`, err.message)
        }

        // Legacy WhatsAppMessage upsert
        await prisma.whatsAppMessage.upsert({
            where: { id_chatId: { id: waMsgId, chatId: rawChatId } },
            update: {},
            create: {
                id: waMsgId, chatId: rawChatId,
                body: body || '', fromMe: isOutbound, timestamp: ts,
                type: mapMsgType(waType) as any,
            },
        })

        // Unified Message — dedup by externalId OR content+time
        const existingUnified = await prisma.message.findFirst({
            where: {
                OR: [
                    { externalId: waMsgId },
                    {
                        chatId: unifiedChat.id,
                        content: waContentWithFallback(body, waType),
                        direction,
                        sentAt: {
                            gte: new Date(ts.getTime() - 10000),
                            lte: new Date(ts.getTime() + 10000),
                        },
                    },
                ],
            },
        })

        if (existingUnified) {
            if (!existingUnified.externalId) {
                await prisma.message.update({
                    where: { id: existingUnified.id },
                    data: { externalId: waMsgId },
                })
            }
        } else {
            const savedMsg = await prisma.message.create({
                data: {
                    chatId: unifiedChat.id, direction,
                    type: mapToUnifiedMessageType(waType) as any,
                    content: waContentWithFallback(body, waType),
                    externalId: waMsgId, sentAt: ts,
                    status: isOutbound ? 'delivered' : undefined,
                },
            })

            // Workflow routing
            if (isOutbound) {
                await ConversationWorkflowService.onOutboundMessage(unifiedChat.id, ts).catch(() => {})
            } else {
                await ConversationWorkflowService.onInboundMessage(unifiedChat.id, ts).catch(() => {})
            }

            if (!isOutbound) {
                emitMessageReceived(savedMsg).catch(e =>
                    console.error(`[WA-SERVICE] emitMessageReceived error:`, e.message)
                )
            }
            console.log(`[WA-SERVICE] SAVED ${direction} msgId=${waMsgId} chat=${unifiedChat.id} driver=${unifiedChat.driverId || 'none'}`)
        }
    } catch (err: any) {
        console.error(`[WA-SERVICE] Message processing error:`, err.message)
    }
}

// ─── History sync (Phase 1: stub, relies on Baileys chat events) ─────

async function syncHistory(connectionId: string, sock: WASocket): Promise<void> {
    // Baileys streams historical messages via messages.upsert type='append' after login.
    // The handleIncomingMessage flow above already persists those. So explicit batched
    // sync is not required for Phase 1 — just log and let events roll in.
    opsLog('info', 'wa_sync_start', {
        connectionId, cutoff: getHistoryCutoff().toISOString(), mode: 'event_driven',
    })
}

export async function forceSync(connectionId: string) {
    const sock = clients.get(connectionId)
    if (!sock) throw new Error(`Client not found for connection ${connectionId}`)
    await syncHistory(connectionId, sock)
}

// ─── Public lifecycle API ────────────────────────────────────────────

export function getClient(connectionId: string): WASocket | undefined {
    return clients.get(connectionId)
}

export function resetSyncGuard(connectionId: string): void {
    syncDoneSet.delete(connectionId)
}

export function getRuntimeStatus() {
    return {
        clientCount: clients.size,
        instanceIdCount: instanceIds.size,
        syncDoneCount: syncDoneSet.size,
        initInFlight: initPromises.size,
    }
}

export async function destroyClient(connectionId: string): Promise<void> {
    const sock = clients.get(connectionId)
    if (!sock) return
    console.log(`[WA-TRANSPORT] client_destroying connId=${connectionId}`)
    registry.setStopped(connectionId)

    // FIX 4: drop listeners before ending socket
    try { sock.ev.removeAllListeners('connection.update') } catch { /* ignore */ }
    try { sock.ev.removeAllListeners('creds.update') } catch { /* ignore */ }
    try { sock.ev.removeAllListeners('messages.upsert') } catch { /* ignore */ }
    try { sock.ev.removeAllListeners('messages.update') } catch { /* ignore */ }

    try {
        await Promise.race([
            (async () => {
                try { sock.end(undefined) } catch { /* ignore */ }
                try { (sock as any).ws?.close?.() } catch { /* ignore */ }
            })(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Destroy timeout')), 10000)),
        ])
    } catch (err) {
        console.error(`[WA-SERVICE] Error destroying client for ${connectionId}:`, err)
    }

    clients.delete(connectionId)
    clientPhones.delete(connectionId)
    instanceIds.delete(connectionId)
    await safeUpdateConnection(connectionId, { status: 'idle', sessionData: null, phoneNumber: null })
}

export async function destroyAllClients(): Promise<void> {
    const ids = Array.from(clients.keys())
    for (const id of ids) {
        await destroyClient(id)
    }
}

// ─── Watchdog ────────────────────────────────────────────────────────

const watchdogLastAction = new Map<string, number>()
const WATCHDOG_COOLDOWN_MS = 60000

export async function checkAllClientsHealth(): Promise<{
    checkedCount: number; unhealthyCount: number;
    details: Array<{ connectionId: string; healthy: boolean; reason?: string }>
}> {
    const { opsLog } = await import('@/lib/opsLog')
    const entries = registry.getAllEntries().filter(e => e.channel === 'whatsapp' && e.state === 'ready')
    const details: Array<{ connectionId: string; healthy: boolean; reason?: string }> = []
    let unhealthyCount = 0

    for (const entry of entries) {
        const sock = clients.get(entry.connectionId)

        if (!sock) {
            const last = watchdogLastAction.get(entry.connectionId) || 0
            if (Date.now() - last < WATCHDOG_COOLDOWN_MS) {
                details.push({ connectionId: entry.connectionId, healthy: false, reason: 'stale_cooldown' })
                continue
            }
            watchdogLastAction.set(entry.connectionId, Date.now())
            opsLog('warn', 'wa_watchdog_stale', { connectionId: entry.connectionId, reason: 'client_missing' })
            const iid = registry.getInstanceId(entry.connectionId)
            if (iid) registry.setFailed(entry.connectionId, iid, 'watchdog: client missing from map')
            instanceIds.delete(entry.connectionId) // FIX 5
            unhealthyCount++
            details.push({ connectionId: entry.connectionId, healthy: false, reason: 'client_missing' })
            continue
        }

        // Baileys v7: we trust connection.update events to tell us when ws is dead.
        // Any WebSocket API check (sock.ws.readyState / sock.ws.isOpen) is fragile
        // across Baileys minor versions. If client is in the map and registry says
        // ready, we treat it as healthy — actual disconnects come via event handler.
        registry.touchLastSeen(entry.connectionId)
        details.push({ connectionId: entry.connectionId, healthy: true })
    }

    opsLog('info', 'wa_watchdog_check', { checkedCount: entries.length, unhealthyCount })
    return { checkedCount: entries.length, unhealthyCount, details }
}

// ─── Send ────────────────────────────────────────────────────────────

export async function sendMessage(
    connectionId: string, chatId: string, text: string,
): Promise<{ externalId: string }> {
    const sock = clients.get(connectionId)
    if (!sock) throw new Error(`WhatsApp client not available for connection ${connectionId}`)
    const jid = toBaileysJid(chatId)
    const sent = await sock.sendMessage(jid, { text })
    const externalId = sent?.key?.id || `local-${Date.now()}`
    console.log(`[WA-SERVICE] SENT msgId=${externalId} to=${jid}`)
    return { externalId }
}

export async function sendMedia(
    connectionId: string,
    chatId: string,
    dataUrl: string,
    opts?: { fileName?: string; caption?: string; mimeType?: string },
): Promise<{ externalId: string }> {
    const sock = clients.get(connectionId)
    if (!sock) throw new Error(`WhatsApp client not available for connection ${connectionId}`)
    const jid = toBaileysJid(chatId)

    // Parse data URL
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) throw new Error('Invalid data URL')
    const mimeType = opts?.mimeType || match[1]
    const buffer = Buffer.from(match[2], 'base64')

    let messageContent: any
    if (mimeType.startsWith('image/')) {
        messageContent = { image: buffer, caption: opts?.caption, mimetype: mimeType }
    } else if (mimeType.startsWith('video/')) {
        messageContent = { video: buffer, caption: opts?.caption, mimetype: mimeType }
    } else if (mimeType.startsWith('audio/')) {
        messageContent = { audio: buffer, mimetype: mimeType, ptt: mimeType === 'audio/ogg; codecs=opus' }
    } else {
        messageContent = {
            document: buffer, mimetype: mimeType,
            fileName: opts?.fileName || 'file',
            caption: opts?.caption,
        }
    }

    const sent = await sock.sendMessage(jid, messageContent)
    const externalId = sent?.key?.id || `local-${Date.now()}`
    return { externalId }
}

export async function downloadMedia(messageId: string, chatId: string): Promise<string | null> {
    // Phase 1 stub — Baileys requires keeping Message objects in memory or store.
    // Full media re-download needs the stored IWebMessageInfo or signed URL retention.
    opsLog('warn', 'wa_download_media_not_implemented', { messageId, chatId })
    return null
}

// ─── Pause / Resume ─────────────────────────────────────────────────

export function setPaused(connectionId: string, paused: boolean): void {
    if (paused) {
        pausedSet.add(connectionId)
        opsLog('info', 'wa_paused', { connectionId })
    } else {
        pausedSet.delete(connectionId)
        opsLog('info', 'wa_resumed', { connectionId })
    }
}

export function isPaused(connectionId: string): boolean {
    return pausedSet.has(connectionId)
}

/**
 * Flush buffered messages (collected while paused) through normal message handler.
 * Used on resume with catchUp=true ("Пробросить в CRM").
 */
export async function flushPausedBuffer(connectionId: string): Promise<number> {
    const sock = clients.get(connectionId)
    const buf = messageBuffers.get(connectionId) ?? []
    messageBuffers.delete(connectionId)
    if (!sock || buf.length === 0) {
        opsLog('info', 'wa_buffer_flush', { connectionId, count: 0 })
        return 0
    }
    opsLog('info', 'wa_buffer_flush_start', { connectionId, count: buf.length })
    let processed = 0
    for (const m of buf) {
        try {
            await handleIncomingMessage(connectionId, sock, m)
            processed++
        } catch (err: any) {
            console.error(`[WA-SERVICE] Buffer flush error:`, err.message)
        }
    }
    opsLog('info', 'wa_buffer_flush_complete', { connectionId, processed })
    return processed
}

/**
 * Drop buffered messages without processing. Used on resume with catchUp=false
 * ("Начать с этого места").
 */
export function dropPausedBuffer(connectionId: string): number {
    const count = (messageBuffers.get(connectionId) ?? []).length
    messageBuffers.delete(connectionId)
    opsLog('info', 'wa_buffer_dropped', { connectionId, count })
    return count
}

// ─── History import ─────────────────────────────────────────────────
// Three modes:
//   'live_only'    — no historical import, just start listening live
//   'full'         — pull all available history
//   'partial'      — pull history from last N days (daysBack)
//
// Since Baileys only delivers 'messaging-history.set' on FIRST auth, a running
// session cannot re-request a fresh batch. For full/partial we rely on:
//   (a) events already delivered (messages counted in DB)
//   (b) for 'partial': server-side cutoff that filters incoming in handleIncomingMessage
//
// If user wipes DB and wants to re-sync, they must "Пересоздать сессию" — that
// re-triggers first-auth history delivery.

export async function importWhatsAppHistory(
    jobId: string,
    mode: 'from_connection_time' | 'available_history' | 'last_n_days' | string,
    daysBack: number | null | undefined,
    connectionId: string | null | undefined,
): Promise<{ imported: number; errors: number }> {
    opsLog('info', 'wa_import_history_start', {
        jobId, mode,
        daysBack: daysBack ?? undefined,
        connectionId: connectionId ?? undefined,
    })

    try {
        await prisma.historyImportJob.update({
            where: { id: jobId },
            data: { status: 'running', startedAt: new Date() },
        })
    } catch (err: any) {
        console.error(`[WA-IMPORT] Failed to mark job running:`, err.message)
    }

    if (!connectionId) {
        await finalizeImportJob(jobId, 'failed', { reason: 'no_connection_id' })
        return { imported: 0, errors: 1 }
    }

    // Clean up stale failed jobs from previous attempts for this connection —
    // otherwise ChannelSyncBlock shows baseline "Ошибка" from months-old failures.
    try {
        await prisma.$executeRaw`
            DELETE FROM "HistoryImportJob"
            WHERE 'whatsapp' = ANY(channels)
              AND "connectionId" = ${connectionId}
              AND status = 'failed'::"AiImportStatus"
              AND id != ${jobId}
        `
    } catch (err: any) {
        console.warn(`[WA-IMPORT] Failed-job cleanup error:`, err.message)
    }

    // Configure cutoff per mode — applied to ALL incoming messages via handleIncomingMessage.
    if (mode === 'from_connection_time') {
        // "Only new messages" — skip everything older than this moment.
        // Baileys still delivers messaging-history.set on reconnect; without this cutoff
        // the entire history would be saved (which was the bug Cowork found: 25938 msgs).
        connectionSyncCutoffs.set(connectionId, new Date())
        opsLog('info', 'wa_sync_cutoff_set', {
            connectionId, mode, cutoffISO: new Date().toISOString(),
        })
    } else if (mode === 'last_n_days' && daysBack && daysBack > 0) {
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - daysBack)
        connectionSyncCutoffs.set(connectionId, cutoff)
        opsLog('info', 'wa_sync_cutoff_set', {
            connectionId, mode, daysBack, cutoffISO: cutoff.toISOString(),
        })
    } else {
        // 'available_history' OR unknown — no cutoff, ingest everything Baileys delivers
        connectionSyncCutoffs.delete(connectionId)
        opsLog('info', 'wa_sync_cutoff_cleared', { connectionId, mode })
    }

    // Ensure connection is initialized
    try {
        await initializeClient(connectionId)
    } catch (err: any) {
        console.error(`[WA-IMPORT] Failed to initialize client:`, err.message)
    }

    const startCount = await prisma.whatsAppMessage.count({
        where: { chat: { connectionId } },
    })

    // ALL modes need past data from Baileys to fill empty DB. Baileys only
    // delivers history via messaging-history.set on first-auth after QR scan.
    // HOWEVER: we persist a chat roster (WhatsAppChatRoster) with anchor
    // msgKey+timestamp. If roster has entries, we can backfill per-chat via
    // sock.fetchMessageHistory — avoiding QR rescan.
    if (startCount === 0 && clients.has(connectionId)) {
        const sock = clients.get(connectionId)
        // SAFEGUARD: only run backfill when connection is fully authenticated.
        // In 'qr' / 'initializing' states sock exists but fetchMessageHistory would
        // crash (no user, no session key). Instead — fail with a clear reason.
        const entry = registry.getEntry(connectionId)
        if (entry?.state !== 'ready') {
            opsLog('warn', 'wa_import_backfill_not_ready', {
                jobId, connectionId, mode,
                registryState: entry?.state ?? 'unknown',
            })
            await finalizeImportJob(jobId, 'failed', {
                reason: 'session_locked_needs_rescan',
            })
            return { imported: 0, errors: 1 }
        }

        const roster = await prisma.whatsAppChatRoster.findMany({
            where: {
                connectionId,
                oldestMsgKey: { not: Prisma.AnyNull },
                oldestMsgTs: { not: null },
            },
        })

        if (!sock || roster.length === 0) {
            // No anchors available — must re-scan QR
            opsLog('warn', 'wa_import_history_requires_reset', {
                jobId, connectionId, mode,
                reason: 'DB empty + no roster — re-scan QR required',
            })
            await finalizeImportJob(jobId, 'failed', {
                reason: 'session_locked_needs_rescan',
            })
            return { imported: 0, errors: 1 }
        }

        opsLog('info', 'wa_backfill_start', {
            jobId, connectionId, mode, rosterSize: roster.length,
        })

        const BATCH_PER_CHAT = 50
        const MAX_PAGES_PER_CHAT = 20 // hard stop: up to 1000 msgs per chat
        const RATE_LIMIT_MS = 600 // pause between chats (WA anti-abuse)
        let totalFetched = 0
        let chatsProcessed = 0
        let errors = 0

        for (const entry of roster) {
            chatsProcessed++
            try {
                const anchorKey = entry.oldestMsgKey as any
                const anchorTs = entry.oldestMsgTs!.getTime() / 1000
                let oldestKey = anchorKey
                let oldestTs: number | any = anchorTs

                for (let page = 0; page < MAX_PAGES_PER_CHAT; page++) {
                    try {
                        // fetchMessageHistory returns nothing directly — incoming batch
                        // arrives via messages.upsert event and goes through our handler
                        // (cutoff filter applies there too).
                        await (sock as any).fetchMessageHistory(BATCH_PER_CHAT, oldestKey, oldestTs)
                        totalFetched += BATCH_PER_CHAT
                        await new Promise(r => setTimeout(r, RATE_LIMIT_MS))

                        // Re-read roster anchor to see if it moved backwards (new older
                        // messages arrived via handler and updated the anchor).
                        const refreshed = await prisma.whatsAppChatRoster.findUnique({
                            where: { connectionId_jid: { connectionId, jid: entry.jid } },
                        })
                        if (!refreshed?.oldestMsgTs) break
                        const newTs = refreshed.oldestMsgTs.getTime() / 1000
                        if (typeof oldestTs === 'number' && newTs >= oldestTs) break
                        oldestKey = refreshed.oldestMsgKey as any
                        oldestTs = newTs

                        // Stop if cutoff reached (user wants only last N days)
                        const activeCutoff = connectionSyncCutoffs.get(connectionId)
                        if (activeCutoff && refreshed.oldestMsgTs < activeCutoff) break
                    } catch (pageErr: any) {
                        opsLog('warn', 'wa_backfill_page_error', {
                            jobId, jid: entry.jid, page, err: pageErr?.message,
                        })
                        break
                    }
                }
            } catch (err: any) {
                errors++
                opsLog('warn', 'wa_backfill_chat_error', {
                    jobId, jid: entry.jid, err: err?.message,
                })
            }
        }

        // Allow a few seconds for last messages.upsert batches to finalize DB writes
        await new Promise(r => setTimeout(r, 3000))

        const finalMsgs = await prisma.whatsAppMessage.count({ where: { chat: { connectionId } } })
        const finalChats = await prisma.whatsAppChat.count({ where: { connectionId } })

        opsLog('info', 'wa_backfill_complete', {
            jobId, connectionId, chatsProcessed, totalFetched,
            finalMsgs, finalChats, errors,
        })

        await finalizeImportJob(jobId, 'completed', {
            messagesImported: finalMsgs,
            chatsScanned: finalChats,
            contactsFound: finalChats,
        })
        return { imported: finalMsgs, errors }
    }

    // Poll DB to detect when history batches stop flowing. Quick exit if stable.
    const MAX_WAIT_MS = 20_000
    const POLL_INTERVAL = 3_000
    const STABLE_TICKS_TO_EXIT = 2 // 6s of no growth — assume done
    const startedAt = Date.now()
    let lastCount = startCount
    let stableTicks = 0

    while (Date.now() - startedAt < MAX_WAIT_MS) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL))
        const cur = await prisma.whatsAppMessage.count({
            where: { chat: { connectionId } },
        })
        if (cur === lastCount) {
            stableTicks++
            if (stableTicks >= STABLE_TICKS_TO_EXIT) break
        } else {
            stableTicks = 0
            lastCount = cur
        }
    }

    // Report TOTAL counts in DB for this connection — more useful than delta.
    // If user had 11000 messages from previous sync and 0 new arrived, UI still
    // sees "11000 messages" not "0" — reflects reality.
    const totalMessages = await prisma.whatsAppMessage.count({ where: { chat: { connectionId } } })
    const totalChats = await prisma.whatsAppChat.count({ where: { connectionId } })

    // Unique contacts = unique chats that have a contactId linked
    const contactsFound = await prisma.chat.count({
        where: {
            channel: 'whatsapp',
            contactId: { not: null },
            metadata: { path: ['connectionId'], equals: connectionId },
        },
    }).catch(() => totalChats) // fallback to chat count on schema/jsonb issues

    const delta = totalMessages - startCount
    await finalizeImportJob(jobId, 'completed', {
        messagesImported: totalMessages,
        chatsScanned: totalChats,
        contactsFound,
    })

    opsLog('info', 'wa_import_history_complete', {
        jobId, connectionId,
        totalMessages, totalChats, contactsFound,
        newDelta: delta,
    })
    return { imported: totalMessages, errors: 0 }
}

async function finalizeImportJob(
    jobId: string,
    status: 'completed' | 'failed',
    extras: { messagesImported?: number; chatsScanned?: number; contactsFound?: number; reason?: string } = {},
) {
    try {
        await prisma.historyImportJob.update({
            where: { id: jobId },
            data: {
                status: status as any,
                resultType: status === 'completed' ? 'full' : 'failed',
                finishedAt: new Date(),
                messagesImported: extras.messagesImported ?? 0,
                chatsScanned: extras.chatsScanned ?? 0,
                contactsFound: extras.contactsFound ?? 0,
                detailsJson: extras.reason ? { reason: extras.reason } : undefined,
            },
        })
    } catch (err: any) {
        console.error(`[WA-IMPORT] Failed to finalize job ${jobId}:`, err.message)
    }
}

// ─── Reachability check ──────────────────────────────────────────────

export async function checkReachability(phone: string): Promise<{ reachable: boolean; error?: string }> {
    const TIMEOUT_MS = 5000
    try {
        const digits = String(phone).replace(/\D/g, '')
        if (digits.length < 10) return { reachable: false, error: 'Invalid phone' }

        // Use any active client for reachability probe
        const sock = Array.from(clients.values())[0]
        if (!sock) return { reachable: true } // soft fallback — no active client

        const jid = `${digits}@s.whatsapp.net`
        const result = await Promise.race([
            sock.onWhatsApp(jid),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS)),
        ])

        if (result === null) return { reachable: true } // soft fallback on timeout
        const exists = Array.isArray(result) && result[0]?.exists === true
        return exists
            ? { reachable: true }
            : { reachable: false, error: 'Номер не зарегистрирован в WhatsApp' }
    } catch (err: any) {
        console.error(`[WA-CHECK] Error checking ${phone}:`, err.message)
        return { reachable: true } // soft fallback
    }
}

// ═══════════════════════════════════════════════════════════════════
// Derived status — single source of truth for UI
// ═══════════════════════════════════════════════════════════════════

const HEARTBEAT_STALE_MS = 5 * 60 * 1000

export type ActualWhatsAppState =
    | 'idle' | 'initializing' | 'qr_required' | 'authenticated'
    | 'ready' | 'degraded' | 'reconnecting' | 'disconnected'
    | 'auth_failed' | 'broken'

const HUMAN_LABELS: Record<ActualWhatsAppState, string> = {
    idle: 'Не подключён',
    initializing: 'Подключение…',
    qr_required: 'Отсканируйте QR-код',
    authenticated: 'Авторизация…',
    ready: 'Подключён и готов к работе',
    degraded: 'Связь нестабильна',
    reconnecting: 'Переподключаемся…',
    disconnected: 'Отключено',
    auth_failed: 'Требуется новая авторизация',
    broken: 'Ошибка запуска — пересоздайте сессию',
}

export async function getActualStatus(connectionId: string): Promise<{
    state: ActualWhatsAppState
    humanReadable: string
    canRetry: boolean
    canForceQR: boolean
    canForceReset: boolean
    lastReadyAt: Date | null
    lastError: string | null
}> {
    const db = await prisma.whatsAppConnection.findUnique({ where: { id: connectionId } })
    const entry = registry.getEntry(connectionId)
    const sock = clients.get(connectionId)

    let state: ActualWhatsAppState

    if (!db) {
        state = 'idle'
    } else if (entry?.state === 'failed') {
        const isAuth = (entry.lastError ?? '').toLowerCase().includes('auth') ||
                       (entry.lastError ?? '').toLowerCase().includes('logout')
        state = isAuth ? 'auth_failed' : 'broken'
    } else if (entry?.state === 'reconnecting') {
        state = 'reconnecting'
    } else if (entry?.state === 'initializing') {
        state = db.status === 'qr' ? 'qr_required'
              : db.status === 'authenticated' ? 'authenticated'
              : 'initializing'
    } else if (entry?.state === 'ready') {
        // Trust registry + client map presence. Dead ws is reported via Baileys
        // connection.update — which flips registry state to reconnecting/failed.
        const lastSeen = entry.lastSeen?.getTime() ?? 0
        const heartbeatFresh = Date.now() - lastSeen < HEARTBEAT_STALE_MS
        if (!sock) state = 'broken'
        else if (!heartbeatFresh) state = 'degraded'
        else state = 'ready'
    } else {
        state = db.status === 'qr' ? 'qr_required' : 'idle'
    }

    return {
        state,
        humanReadable: HUMAN_LABELS[state],
        canRetry: ['broken', 'disconnected', 'degraded', 'reconnecting'].includes(state),
        canForceQR: ['idle', 'broken', 'auth_failed'].includes(state),
        canForceReset: ['broken', 'auth_failed', 'degraded'].includes(state),
        lastReadyAt: entry?.readyAt ?? null,
        lastError: entry?.lastError ?? null,
    }
}

// ─── Force reset ─────────────────────────────────────────────────────

export async function forceResetSession(connectionId: string): Promise<void> {
    // FIX 7: serialize per connectionId
    const inFlight = forceResetLocks.get(connectionId)
    if (inFlight) {
        opsLog('info', 'wa_force_reset_joined_in_flight', { connectionId })
        return inFlight
    }

    const promise = doForceResetSession(connectionId)
    forceResetLocks.set(connectionId, promise)
    try {
        await promise
    } finally {
        forceResetLocks.delete(connectionId)
    }
}

async function doForceResetSession(connectionId: string): Promise<void> {
    opsLog('info', 'wa_force_reset_start', { connectionId })
    await destroyClient(connectionId)
    syncDoneSet.delete(connectionId)

    const sessionDir = path.join(AUTH_BASE, `session-${connectionId}`)
    try {
        await fs.promises.rm(sessionDir, { recursive: true, force: true })
        opsLog('info', 'wa_force_reset_session_wiped', { connectionId, path: sessionDir })
    } catch (err: any) {
        opsLog('warn', 'wa_force_reset_wipe_failed', {
            connectionId, error: err?.message ?? String(err),
        })
    }

    await safeUpdateConnection(connectionId, {
        status: 'idle', sessionData: null, phoneNumber: null,
    })

    opsLog('info', 'wa_force_reset_auto_init', { connectionId })
    initializeClient(connectionId).catch(err => {
        opsLog('error', 'wa_force_reset_auto_init_failed', {
            connectionId, error: err?.message ?? String(err),
        })
    })
}
