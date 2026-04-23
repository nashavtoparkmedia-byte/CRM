import { Client, LocalAuth, Message, MessageMedia } from 'whatsapp-web.js'
import { prisma } from '@/lib/prisma'
import path from 'path'
import fs from 'fs'
import { DriverMatchService } from '@/lib/DriverMatchService'
import { ContactService } from '@/lib/ContactService'
import { ConversationWorkflowService } from '@/lib/ConversationWorkflowService'
import { emitMessageReceived } from '@/lib/messageEvents'
import * as registry from '@/lib/TransportRegistry'
import { opsLog } from '@/lib/opsLog'

const MAX_MEDIA_SIZE_BYTES = 10 * 1024 * 1024 // 10MB per file
const HISTORY_MONTHS = 3

// Global singleton map: connectionId -> Client instance
const globalForWA = global as unknown as { waClients: Map<string, Client> }
const clients = globalForWA.waClients || new Map<string, Client>()
if (process.env.NODE_ENV !== 'production') globalForWA.waClients = clients

// instanceId per connection — links client to registry entry (survive hot reload)
const globalForWAIds = global as unknown as { _waInstanceIds?: Map<string, string> }
const instanceIds = globalForWAIds._waInstanceIds || new Map<string, string>()
if (process.env.NODE_ENV !== 'production') globalForWAIds._waInstanceIds = instanceIds

// Guard: track which connections already had auto-sync (prevent re-sync on reconnect)
const globalSyncDone = global as unknown as { _waSyncDone?: Set<string> }
const syncDoneSet = globalSyncDone._waSyncDone || new Set<string>()
if (process.env.NODE_ENV !== 'production') globalSyncDone._waSyncDone = syncDoneSet

// FIX 1: In-flight guard — prevent overlapping initializeClient for same connectionId.
// Parallel callers get the same Promise; resolved on finally.
const globalForInitPromises = global as unknown as { _waInitPromises?: Map<string, Promise<void>> }
const initPromises: Map<string, Promise<void>> = globalForInitPromises._waInitPromises || new Map()
if (process.env.NODE_ENV !== 'production') globalForInitPromises._waInitPromises = initPromises

// FIX 7: Serialize forceResetSession per connectionId.
const globalForResetLocks = global as unknown as { _waResetLocks?: Map<string, Promise<void>> }
const forceResetLocks: Map<string, Promise<void>> = globalForResetLocks._waResetLocks || new Map()
if (process.env.NODE_ENV !== 'production') globalForResetLocks._waResetLocks = forceResetLocks

/**
 * Stage 1 helper: retry a puppeteer-backed call when it fails with the
 * transient "Execution context was destroyed" error. This happens when
 * WA Web navigates internally (post-auth, post-sync) while our pupPage
 * evaluate is mid-flight. Waiting a few seconds and retrying almost
 * always works — the new context is ready by then.
 */
function isCdpContextDestroyed(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err)
    return /Execution context was destroyed|Protocol error \(Runtime\.|Target closed/i.test(msg)
}

async function retryOnCdpError<T>(
    fn: () => Promise<T>,
    opts: { retries: number; delayMs: number; op: string },
    connectionId: string,
): Promise<T> {
    let lastErr: unknown
    for (let attempt = 1; attempt <= opts.retries + 1; attempt++) {
        try {
            return await fn()
        } catch (err) {
            lastErr = err
            if (!isCdpContextDestroyed(err) || attempt > opts.retries) {
                throw err
            }
            opsLog('warn', 'wa_cdp_retry', {
                connectionId,
                op: opts.op,
                attempt,
                delayMs: opts.delayMs,
                errorMessage: err instanceof Error ? err.message : String(err),
            })
            await new Promise(resolve => setTimeout(resolve, opts.delayMs))
        }
    }
    throw lastErr
}

// Pause flag + message buffer (pause/resume with flush/drop)
const globalForPaused = global as unknown as { _waPaused?: Set<string> }
const pausedSet: Set<string> = globalForPaused._waPaused || new Set()
if (process.env.NODE_ENV !== 'production') globalForPaused._waPaused = pausedSet

const globalForBuffer = global as unknown as { _waBuffer?: Map<string, Message[]> }
const messageBuffers: Map<string, Message[]> = globalForBuffer._waBuffer || new Map()
if (process.env.NODE_ENV !== 'production') globalForBuffer._waBuffer = messageBuffers

// Per-connection cutoff for "last N days" mode — applied in message handler
const globalForCutoffs = global as unknown as { _waSyncCutoffs?: Map<string, Date> }
const connectionSyncCutoffs: Map<string, Date> = globalForCutoffs._waSyncCutoffs || new Map()
if (process.env.NODE_ENV !== 'production') globalForCutoffs._waSyncCutoffs = connectionSyncCutoffs

async function safeUpdateConnection(connectionId: string, data: any) {
    try {
        await prisma.whatsAppConnection.update({
            where: { id: connectionId },
            data
        })
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

async function saveSession(connectionId: string, client: Client) {
    try {
        const session = await (client as any).pupPage?.evaluate(() => {
            return JSON.stringify(window.localStorage)
        })
        if (!session || session === '{}') return
        // Validate it's real JSON before saving
        JSON.parse(session)
        await safeUpdateConnection(connectionId, { sessionData: session })
        console.log(`[WA-SERVICE] Session saved for connectionId: ${connectionId}`)
    } catch (err) {
        console.error(`[WA-SERVICE] Failed to save session for ${connectionId}:`, err)
    }
}

export async function forceSync(connectionId: string) {
    const client = clients.get(connectionId)
    if (!client) throw new Error(`Client not found for connection ${connectionId}`)
    await syncHistory(connectionId, client)
}

async function syncHistory(connectionId: string, client: Client) {
    console.log(`[WA-SERVICE] Starting 3-month history sync for ${connectionId}`)
    const cutoff = getHistoryCutoff()

    try {
        const chatsRaw = await client.getChats()
        for (const chatRaw of chatsRaw) {
            try {
                // Skip groups and status broadcasts — CRM is 1:1 focused
                const chatJid = chatRaw.id?._serialized || ''
                if (chatJid.endsWith('@g.us')) continue
                if (chatJid === 'status@broadcast') continue
                if ((chatRaw as any).isGroup) continue

                // Ensure chat exists in DB (legacy)
                await prisma.whatsAppChat.upsert({
                    where: { id: chatRaw.id._serialized },
                    update: { name: chatRaw.name },
                    create: {
                        id: chatRaw.id._serialized,
                        connectionId,
                        name: chatRaw.name,
                    }
                })

                // Create/Update Unified Chat
                const unifiedSyncChat = await prisma.chat.upsert({
                    where: { externalChatId: chatRaw.id._serialized },
                    update: { name: chatRaw.name },
                    create: {
                        externalChatId: chatRaw.id._serialized,
                        channel: 'whatsapp',
                        name: chatRaw.name,
                        metadata: { connectionId }
                    }
                })

                // Contact resolution: extract phone from WA chat ID (e.g. "79221853150@c.us")
                if (!unifiedSyncChat.contactId) {
                    try {
                        const rawPhone = chatRaw.id._serialized?.split('@')[0]
                        if (rawPhone && /^\d{10,15}$/.test(rawPhone)) {
                            const contactResult = await ContactService.resolveContact('whatsapp', rawPhone, rawPhone, chatRaw.name)
                            await ContactService.ensureChatLinked(unifiedSyncChat.id, contactResult.contact.id, contactResult.identity.id)
                        }
                    } catch (contactErr: any) {
                        // Non-blocking — don't break sync
                        console.warn(`[WA-SERVICE] syncHistory contact resolve failed for ${chatRaw.id._serialized}: ${contactErr.message}`)
                    }
                }

                // Fetch messages — try fetchMessages, fall back to Store for @lid chats
                let rawMsgs: { id: string; body: string; timestamp: number; fromMe: boolean; type: string }[] = []
                try {
                    const fetched = await chatRaw.fetchMessages({ limit: 1000 })
                    rawMsgs = fetched.map(m => ({ id: m.id._serialized, body: m.body || '', timestamp: m.timestamp, fromMe: m.fromMe, type: m.type }))
                } catch {
                    const page = (client as any).pupPage
                    if (page) {
                        try {
                            rawMsgs = await page.evaluate((cid: string) => {
                                const store = (window as any).Store
                                if (!store?.Chat) return []
                                const chat = store.Chat.get(cid)
                                if (!chat?.msgs) return []
                                const models = chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : Array.from(chat.msgs)
                                return models.map((m: any) => ({
                                    id: m.id?._serialized || '', body: m.body || '', timestamp: m.t || 0,
                                    fromMe: !!m.id?.fromMe, type: m.type || 'chat',
                                }))
                            }, chatRaw.id._serialized)
                        } catch {}
                    }
                }
                const filtered = rawMsgs.filter(m => new Date(m.timestamp * 1000) >= cutoff)

                let maxTimestamp: Date | null = null
                for (const msg of filtered) {
                    try {
                        const ts = new Date(msg.timestamp * 1000)
                        if (!maxTimestamp || ts > maxTimestamp) maxTimestamp = ts

                        const msgType = mapMsgType(msg.type)

                        // Legacy WhatsAppMessage
                        await prisma.whatsAppMessage.upsert({
                            where: { id_chatId: { id: msg.id, chatId: chatRaw.id._serialized } },
                            update: {},
                            create: {
                                id: msg.id,
                                chatId: chatRaw.id._serialized,
                                body: msg.body || '',
                                fromMe: msg.fromMe,
                                timestamp: ts,
                                type: msgType,
                            }
                        })

                        // Unified Message
                        const unifiedChat = await prisma.chat.findUnique({ where: { externalChatId: chatRaw.id._serialized } })
                        if (unifiedChat) {
                            const existing = await prisma.message.findFirst({
                                where: {
                                    OR: [
                                        { externalId: msg.id },
                                        {
                                            chatId: unifiedChat.id,
                                            content: waContentWithFallback(msg.body, msg.type),
                                            direction: msg.fromMe ? 'outbound' : 'inbound',
                                            sentAt: {
                                                gte: new Date(ts.getTime() - 2000),
                                                lte: new Date(ts.getTime() + 2000)
                                            }
                                        }
                                    ]
                                }
                            })

                            if (existing) {
                                if (!existing.externalId) {
                                    await prisma.message.update({
                                        where: { id: existing.id },
                                        data: { externalId: msg.id }
                                    })
                                }
                            } else {
                                await prisma.message.create({
                                    data: {
                                        chatId: unifiedChat.id,
                                        direction: msg.fromMe ? 'outbound' : 'inbound',
                                        type: mapToUnifiedMessageType(msg.type),
                                        content: waContentWithFallback(msg.body, msg.type),
                                        externalId: msg.id,
                                        channel: 'whatsapp',
                                        sentAt: ts
                                    }
                                })
                            }
                        }
                    } catch (msgErr) {
                        console.error(`[WA-SERVICE] Failed to save message ${msg.id}:`, msgErr)
                    }
                }

                // Update lastMessageAt (legacy & unified)
                if (maxTimestamp) {
                    await prisma.whatsAppChat.update({
                        where: { id: chatRaw.id._serialized },
                        data: { lastMessageAt: maxTimestamp }
                    })
                    await prisma.chat.update({
                        where: { externalChatId: chatRaw.id._serialized },
                        data: { lastMessageAt: maxTimestamp }
                    })
                }
            } catch (chatErr) {
                console.error(`[WA-SERVICE] Failed to sync chat ${chatRaw.id._serialized}:`, chatErr)
            }
        }
        console.log(`[WA-SERVICE] History sync complete for ${connectionId}`)
    } catch (err) {
        console.error(`[WA-SERVICE] History sync failed for ${connectionId}:`, err)
    }
}

function mapMsgType(type: string): 'chat' | 'image' | 'audio' | 'video' | 'sticker' | 'voice' | 'document' {
    const allowed = ['chat', 'image', 'audio', 'video', 'sticker', 'voice', 'document'] as const
    return allowed.includes(type as any) ? (type as typeof allowed[number]) : 'chat'
}

function mapToUnifiedMessageType(type: string): 'text' | 'image' | 'audio' | 'video' | 'sticker' | 'voice' | 'document' | 'system' {
    const map: Record<string, any> = {
        'chat': 'text',
        'image': 'image',
        'audio': 'audio',
        'video': 'video',
        'sticker': 'sticker',
        'voice': 'voice',
        'document': 'document'
    }
    return map[type] || 'text'
}

function waContentWithFallback(body: string | undefined, type: string): string {
    if (body) return body
    const fallbacks: Record<string, string> = {
        image: '[Фото]', video: '[Видео]', voice: '[Голосовое]',
        audio: '[Аудио]', document: '[Документ]', sticker: '[Стикер]',
        ptt: '[Голосовое]', vcard: '[Контакт]',
    }
    return fallbacks[type] || ''
}

export function getClient(connectionId: string): Client | undefined {
    return clients.get(connectionId)
}

/** Reset the auto-sync guard so next ready event will re-sync */
export function resetSyncGuard(connectionId: string) {
    syncDoneSet.delete(connectionId)
}

/** Get runtime status — delegates to TransportRegistry. */
export function getRuntimeStatus() {
    return registry.getAllEntries().filter(e => e.channel === 'whatsapp')
}

export async function initializeClient(connectionId: string): Promise<void> {
    // FIX 1: In-flight guard — if init already running for this id, return same Promise.
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
    // Always ensure registry entry exists
    registry.ensureEntry(connectionId, 'whatsapp')

    // FIX 2: Non-destructive smart-reuse. If healthy — just return.
    // DO NOT call beginNewInstance/setReady — those would invalidate live event handlers.
    const existingClient = clients.get(connectionId)
    const existingEntry = registry.getEntry(connectionId)
    if (existingClient?.info && existingEntry?.state === 'ready') {
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

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: connectionId,
            dataPath: path.join(process.cwd(), 'node_modules', '.wwebjs_auth')
        }),
        puppeteer: {
            headless: true,
            executablePath: process.env.WA_CHROMIUM_PATH || 'D:\\shared\\playwright-browsers\\chromium-1217\\chrome-win64\\chrome.exe',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-site-isolation-trials',
            ],
            ignoreDefaultArgs: ['--enable-automation'],
        },
        webVersionCache: {
            type: 'none',
        }
    })

    // FIX 3: ensure no zombie Chromium — fully destroy any stale client tied to this id
    // before inserting the new one. Best-effort, never throws.
    const stalePrev = clients.get(connectionId)
    if (stalePrev) {
        opsLog('warn', 'wa_init_prev_client_destroy', { connectionId })
        try { stalePrev.removeAllListeners() } catch { /* ignore */ }
        try { await stalePrev.destroy() } catch { /* ignore zombie */ }
    }

    clients.set(connectionId, client)

    // Visibility into WA Web internal lifecycle — helps diagnose "Execution context destroyed"
    client.on('loading_screen', (percent, message) => {
        if (!registry.isCurrentInstance(connectionId, instanceId)) return
        opsLog('info', 'wa_loading_screen', { connectionId, instanceId, percent, message })
    })

    client.on('change_state', (waState) => {
        if (!registry.isCurrentInstance(connectionId, instanceId)) return
        registry.touch(connectionId, instanceId)
        opsLog('info', 'wa_change_state', { connectionId, instanceId, waState: String(waState) })
    })

    client.on('qr', async (qr) => {
        if (!registry.isCurrentInstance(connectionId, instanceId)) return
        try {
            opsLog('info', 'wa_qr_received', { connectionId, instanceId })
            const QRCode = (await import('qrcode')).default
            const qrDataUrl = await QRCode.toDataURL(qr)
            await safeUpdateConnection(connectionId, { status: 'qr', sessionData: qrDataUrl })
        } catch (err) {
            console.error(`[WA-SERVICE] QR event error for ${connectionId}:`, err)
        }
    })

    client.on('authenticated', async () => {
        if (!registry.isCurrentInstance(connectionId, instanceId)) return
        try {
            opsLog('info', 'wa_authenticated', { connectionId, instanceId })
            await safeUpdateConnection(connectionId, { status: 'authenticated' })
            // saveSession moved to 'ready' handler — on 'authenticated', WA Web may still be
            // navigating internally and pupPage.evaluate can trigger "Execution context destroyed"
        } catch (err) {
            console.error(`[WA-SERVICE] Authenticated event error for ${connectionId}:`, err)
        }
    })

    client.on('ready', async () => {
        try {
            if (!registry.isCurrentInstance(connectionId, instanceId)) return
            registry.setReady(connectionId, instanceId)
            opsLog('info', 'wa_ready', { connectionId, instanceId, phone: client.info?.wid?.user })
            const info = client.info
            await safeUpdateConnection(connectionId, {
                status: 'ready',
                phoneNumber: info?.wid?.user || null
            })
            // saveSession moved here — WA Web is stabilized after 'ready'
            await saveSession(connectionId, client)
            // FIX 6: sync guard — set flag BEFORE starting syncHistory to block parallel
            // runs. Only rollback on failure so a subsequent ready can retry.
            if (!syncDoneSet.has(connectionId)) {
                syncDoneSet.add(connectionId)
                syncHistory(connectionId, client)
                    .then(() => {
                        opsLog('info', 'wa_sync_complete', { connectionId, instanceId })
                    })
                    .catch(err => {
                        syncDoneSet.delete(connectionId) // rollback to permit retry on next ready
                        opsLog('error', 'wa_sync_failed', {
                            connectionId, instanceId,
                            error: err?.message ?? String(err),
                        })
                    })
            } else {
                opsLog('info', 'wa_sync_skipped_already_done', { connectionId, instanceId })
            }
        } catch (err) {
            console.error(`[WA-SERVICE] Ready event error for ${connectionId}:`, err)
        }
    })

    client.on('message', async (msg: Message) => {
        if (!registry.isCurrentInstance(connectionId, instanceId)) return
        registry.touch(connectionId, instanceId)

        // Skip groups (@g.us) and status broadcasts — CRM is 1:1 focused.
        // Without this filter groups pollute the chat list with JID-looking
        // "phone numbers" and raw/empty content.
        const fromJid = msg.from || ''
        const toJid = msg.to || ''
        if (fromJid === 'status@broadcast' || toJid === 'status@broadcast') return
        if (fromJid.endsWith('@g.us') || toJid.endsWith('@g.us')) return

        // PAUSE: buffer for later flush, don't process now
        if (pausedSet.has(connectionId)) {
            const buf = messageBuffers.get(connectionId) ?? []
            buf.push(msg)
            messageBuffers.set(connectionId, buf)
            return
        }

        // CUTOFF: skip messages older than configured cutoff ("last N days" mode)
        const cutoff = connectionSyncCutoffs.get(connectionId)
        if (cutoff && msg.timestamp && new Date(msg.timestamp * 1000) < cutoff) {
            return
        }

        const isOutbound = msg.fromMe
        // For outbound messages (sent from manager's phone), the chat partner is `msg.to`, not `msg.from`.
        // For inbound, partner is `msg.from`. We use this as the chat key in either case.
        const partnerJid = isOutbound ? (msg.to || msg.from) : msg.from
        const direction = isOutbound ? 'outbound' : 'inbound'

        console.log(`[WA-SERVICE] ${direction.toUpperCase()} msgId=${msg.id._serialized} fromMe=${msg.fromMe} partner=${partnerJid} body="${(msg.body || '').substring(0, 30)}"`)
        const logLine = `[${new Date().toISOString()}] ${direction.toUpperCase()} MSG: id=${msg.id._serialized} fromMe=${msg.fromMe} partner=${partnerJid} body="${msg.body}"\n`;
        try { fs.appendFileSync(path.join(process.cwd(), 'wa-incoming.log'), logLine); } catch(e) {}
        try {
            let rawChatId = partnerJid  // e.g. '79221853150@c.us'
            const ts = new Date(msg.timestamp * 1000)

            // If the partner JID is a LID, attempt to get their real phone number.
            // For inbound: msg.getContact() = sender. For outbound: use chat.getContact() to get recipient.
            if (rawChatId.includes('@lid')) {
                try {
                    let contact
                    if (isOutbound) {
                        const chatObj = await msg.getChat()
                        contact = await chatObj.getContact()
                    } else {
                        contact = await msg.getContact()
                    }
                    if (contact && contact.number) {
                        console.log(`[WA-SERVICE] Translated LID ${rawChatId} to contact number ${contact.number}`)
                        rawChatId = `${contact.number}@c.us`
                    }
                } catch (e) {
                    console.error(`[WA-SERVICE] Failed to get contact for LID ${rawChatId}`, e)
                }
            }

            // Normalize to `whatsapp:7XXXXXXXXXX` format
            const phoneDigits = rawChatId.replace(/\D/g, '')
            const normalizedPhone = phoneDigits.length >= 10 ? '7' + phoneDigits.slice(-10) : phoneDigits
            const normalizedExternalId = `whatsapp:${normalizedPhone}`

            // Legacy WhatsApp (uses the raw @c.us format for its own table)
            await prisma.whatsAppChat.upsert({
                where: { id: rawChatId },
                update: { lastMessageAt: ts },
                create: {
                    id: rawChatId,
                    connectionId,
                    lastMessageAt: ts
                }
            })

            // Unified Chat - Try to find existing chat with any variant of this phone
            const searchSuffix = normalizedPhone.slice(-10)
            let unifiedChat = await (prisma.chat as any).findFirst({
                where: {
                    channel: 'whatsapp',
                    OR: [
                        { externalChatId: normalizedExternalId },
                        { externalChatId: rawChatId },
                        { externalChatId: phoneDigits },
                        { externalChatId: { endsWith: searchSuffix } }
                    ]
                },
                orderBy: { driverId: 'desc' } // Prefer chat linked to a driver
            })

            if (unifiedChat) {
                // Always update potential variant IDs to the standardized format
                await (prisma.chat as any).update({
                    where: { id: unifiedChat.id },
                    data: { 
                        externalChatId: normalizedExternalId, 
                        lastMessageAt: ts, 
                        metadata: { ...(unifiedChat.metadata as any || {}), connectionId } 
                    }
                })
            } else {
                unifiedChat = await (prisma.chat as any).create({
                    data: {
                        externalChatId: normalizedExternalId,
                        channel: 'whatsapp',
                        lastMessageAt: ts,
                        metadata: { connectionId }
                    }
                })
            }

            // Relink driver on every inbound if missing
            if (!unifiedChat.driverId) {
                let matched = await DriverMatchService.linkChatToDriver(unifiedChat.id, { phone: phoneDigits })
                if (!matched && unifiedChat.name && unifiedChat.name.includes('+')) {
                    matched = await DriverMatchService.linkChatToDriver(unifiedChat.id, { phone: unifiedChat.name })
                }
                if (matched) {
                    unifiedChat = await (prisma.chat as any).findUnique({ where: { id: unifiedChat.id } })
                }
                console.log(`[WA-SERVICE] RELINK chat=${unifiedChat.id} driver=${unifiedChat.driverId || 'none'} linked=${matched}`)
            }

            // ── Contact Model dual write ──────────────────────────────
            try {
                const contactResult = await ContactService.resolveContact(
                    'whatsapp',
                    normalizedPhone,
                    phoneDigits,
                    (msg as any).notifyName || unifiedChat.name || null,
                )
                await ContactService.ensureChatLinked(
                    unifiedChat.id,
                    contactResult.contact.id,
                    contactResult.identity.id,
                )
            } catch (contactErr: any) {
                console.error(`[WA-SERVICE] ContactService error (non-blocking): ${contactErr.message}`)
            }
            // ──────────────────────────────────────────────────────────

            // Legacy WhatsAppMessage
            await prisma.whatsAppMessage.upsert({
                where: { id_chatId: { id: msg.id._serialized, chatId: rawChatId } },
                update: {},
                create: {
                    id: msg.id._serialized,
                    chatId: rawChatId,
                    body: msg.body || '',
                    fromMe: isOutbound,
                    timestamp: ts,
                    type: mapMsgType(msg.type)
                }
            })

            // Unified Message — dedup by externalId OR by content+direction+time window.
            // For outbound messages, this also catches echoes from CRM-initiated sends
            // (which create the optimistic Message record before the WA library fires the event).
            const existingUnified = await prisma.message.findFirst({
                where: {
                    OR: [
                        { externalId: msg.id._serialized },
                        {
                            chatId: unifiedChat.id,
                            content: waContentWithFallback(msg.body, msg.type),
                            direction,
                            sentAt: {
                                gte: new Date(ts.getTime() - 10000),
                                lte: new Date(ts.getTime() + 10000)
                            }
                        }
                    ]
                }
            })

            if (existingUnified) {
                console.log(`[WA-SERVICE] DB-DEDUP: skipped duplicate ${direction} msgId=${msg.id._serialized} (existing=${existingUnified.id})`)
                if (!existingUnified.externalId) {
                    await prisma.message.update({
                        where: { id: existingUnified.id },
                        data: { externalId: msg.id._serialized }
                    })
                }
            } else {
                const msgType = mapToUnifiedMessageType(msg.type)
                const savedMsg = await prisma.message.create({
                    data: {
                        chatId: unifiedChat.id,
                        direction,
                        type: msgType,
                        content: waContentWithFallback(msg.body, msg.type),
                        externalId: msg.id._serialized,
                        sentAt: ts,
                        status: isOutbound ? 'delivered' : undefined,
                    }
                })

                // Download and save media attachment (image, voice, video, document, sticker)
                if (msg.hasMedia && msgType !== 'text') {
                    try {
                        const media = await msg.downloadMedia()
                        if (media && media.data) {
                            const dataUrl = `data:${media.mimetype};base64,${media.data}`
                            await prisma.messageAttachment.create({
                                data: {
                                    messageId: savedMsg.id,
                                    type: msgType,
                                    url: dataUrl,
                                    fileName: media.filename || null,
                                    fileSize: Math.round(media.data.length * 0.75), // approx decoded size
                                    mimeType: media.mimetype || null,
                                }
                            })
                            console.log(`[WA-SERVICE] MEDIA saved: ${msgType} ${media.mimetype} for msg=${savedMsg.id}`)
                        }
                    } catch (mediaErr: any) {
                        console.error(`[WA-SERVICE] Media download failed for msg=${savedMsg.id}:`, mediaErr.message)
                    }
                }

                // Workflow: route by direction
                if (isOutbound) {
                    await ConversationWorkflowService.onOutboundMessage(unifiedChat.id, ts)
                } else {
                    await ConversationWorkflowService.onInboundMessage(unifiedChat.id, ts)
                }

                console.log(`[WA-SERVICE] SAVED ${direction} msgId=${msg.id._serialized} to chat=${unifiedChat.id} driver=${unifiedChat.driverId || 'none'}`)
                if (!isOutbound) {
                    emitMessageReceived(savedMsg).catch(e =>
                        console.error(`[WA-SERVICE] emitMessageReceived error:`, e.message)
                    )
                }
            }
        } catch (err) {
            console.error(`[WA-SERVICE] Message event error for ${connectionId}:`, err)
        }
    })

    // Heartbeat from any outgoing/incoming ACK — proves channel is truly alive
    client.on('message_ack', () => {
        if (!registry.isCurrentInstance(connectionId, instanceId)) return
        registry.touch(connectionId, instanceId)
    })

    client.on('auth_failure', async (msg) => {
        try {
            if (!registry.isCurrentInstance(connectionId, instanceId)) return
            opsLog('error', 'wa_auth_failure', { connectionId, instanceId, reason: String(msg) })
            // Unrecoverable — no auto-reconnect
            registry.setFailed(connectionId, instanceId, `auth_failure: ${msg}`)
            await safeUpdateConnection(connectionId, { status: 'error' })
            clients.delete(connectionId)
            instanceIds.delete(connectionId) // FIX 5: drop stale instanceId
        } catch (err) {
            console.error(`[WA-SERVICE] Auth failure handler error:`, err)
        }
    })

    client.on('disconnected', async (reason) => {
        try {
            if (!registry.isCurrentInstance(connectionId, instanceId)) return
            await safeUpdateConnection(connectionId, { status: 'disconnected' })
            clients.delete(connectionId)
            instanceIds.delete(connectionId) // FIX 5: drop stale instanceId — next init creates a new one

            if (reason === 'LOGOUT') {
                // Intentional logout — no reconnect
                registry.setFailed(connectionId, instanceId, `disconnected: ${reason}`)
            } else {
                // Recoverable — schedule reconnect with backoff
                registry.setReconnecting(connectionId, instanceId)
                registry.scheduleReconnect(connectionId, instanceId, () => initializeClient(connectionId))
            }
        } catch (err) {
            console.error(`[WA-SERVICE] Disconnect handler error:`, err)
        }
    })

    const INIT_TIMEOUT_MS = 60_000
    const initStartedAt = Date.now()
    opsLog('info', 'wa_init_call', { connectionId, instanceId })

    try {
        await Promise.race([
            client.initialize(),
            new Promise<never>((_, reject) =>
                setTimeout(
                    () => reject(new Error(`initialize_timeout_${INIT_TIMEOUT_MS}ms`)),
                    INIT_TIMEOUT_MS,
                ),
            ),
        ])
        opsLog('info', 'wa_init_success', {
            connectionId, instanceId, elapsedMs: Date.now() - initStartedAt,
        })
    } catch (err: any) {
        const elapsedMs = Date.now() - initStartedAt
        const msg = err?.message ?? String(err)
        const errorClass =
            /Execution context was destroyed/i.test(msg) ? 'cdp_context_destroyed' :
            /Navigation timeout/i.test(msg) ? 'navigation_timeout' :
            /Target closed/i.test(msg) ? 'browser_closed' :
            /initialize_timeout/i.test(msg) ? 'our_init_timeout' :
            'other'
        opsLog('error', 'wa_init_failed', {
            connectionId, instanceId, elapsedMs, errorClass,
            errorMessage: msg,
            errorStack: err?.stack?.split('\n').slice(0, 5).join('\n'),
        })
        // Critical: write error status to DB so UI doesn't show stale "ready" from previous session
        await safeUpdateConnection(connectionId, { status: 'error' })
        registry.setFailed(connectionId, instanceId, `init_failed: ${errorClass}`)
        try { await client.destroy() } catch { /* zombie process may not respond */ }
        clients.delete(connectionId)
        instanceIds.delete(connectionId)
        // NO throw — warmup continues with other connections
    }
}

export async function destroyClient(connectionId: string): Promise<void> {
    const client = clients.get(connectionId)
    if (!client) return
    console.log(`[WA-TRANSPORT] client_destroying connId=${connectionId}`)
    registry.setStopped(connectionId)

    // FIX 4: drop listeners BEFORE destroy — prevents stale handlers from firing
    // during the teardown and causing DB writes/heartbeats against a dead instance.
    try { client.removeAllListeners() } catch { /* ignore */ }

    try {
        await Promise.race([
            client.destroy(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Destroy timeout')), 10000))
        ])
    } catch (err) {
        console.error(`[WA-SERVICE] Error/Timeout destroying client for ${connectionId}:`, err)
    }

    clients.delete(connectionId)
    instanceIds.delete(connectionId)
    await safeUpdateConnection(connectionId, { status: 'idle', sessionData: null, phoneNumber: null })
}

/**
 * Destroy all active WA clients. Used during graceful shutdown.
 */
export async function destroyAllClients(): Promise<void> {
    const ids = Array.from(clients.keys())
    for (const id of ids) {
        await destroyClient(id)
    }
}

/**
 * Watchdog: check all ready WA clients for health.
 * Only checks connections in 'ready' state. Cooldown: 60s per connection.
 *
 * When a client is found unhealthy, we schedule a HARD RESTART:
 *   1. Kill zombie chromes + remove stale locks for this session
 *   2. Re-run initializeClient()
 * Hard restart has its own cooldown (5 min) so a permanently dead
 * connection doesn't DDoS WhatsApp with reconnect attempts.
 */
const watchdogLastAction = new Map<string, number>()
const WATCHDOG_COOLDOWN_MS = 60000

const hardRestartLastAt = new Map<string, number>()
const HARD_RESTART_COOLDOWN_MS = 5 * 60 * 1000 // 5 min

/**
 * Fire-and-forget: after a short delay, clean up zombie state for this
 * session and try re-initializing. Called by watchdog when it detects
 * client_missing / client_info_null / similar conditions.
 */
async function scheduleHardRestart(connectionId: string, reason: string): Promise<void> {
    const { opsLog } = await import('@/lib/opsLog')

    const last = hardRestartLastAt.get(connectionId) || 0
    if (Date.now() - last < HARD_RESTART_COOLDOWN_MS) {
        opsLog('info', 'wa_hard_restart_skipped', {
            connectionId,
            reason: 'cooldown',
            sinceLastMs: Date.now() - last,
        })
        return
    }
    hardRestartLastAt.set(connectionId, Date.now())

    opsLog('warn', 'wa_hard_restart_scheduled', { connectionId, reason })

    // 5s delay: gives in-flight promises/listeners a moment to finish
    setTimeout(async () => {
        try {
            // Only restart if the user still wants this connection active.
            // If they disconnected it manually (status != ready/authenticated),
            // respect that.
            const { prisma } = await import('@/lib/prisma')
            const conn = await prisma.whatsAppConnection.findUnique({
                where: { id: connectionId },
                select: { status: true },
            })
            if (!conn || !['ready', 'authenticated'].includes(conn.status)) {
                opsLog('info', 'wa_hard_restart_abort', {
                    connectionId,
                    reason: 'conn_inactive',
                    status: conn?.status ?? 'missing',
                })
                return
            }

            // Clean up zombie state for this session specifically
            const { cleanupStaleWhatsAppSessions } = await import('./WhatsAppCleanup')
            const cleanup = await cleanupStaleWhatsAppSessions(connectionId)
            opsLog('info', 'wa_hard_restart_cleanup', {
                connectionId,
                killedChromeCount: cleanup.killedChromeCount,
                removedLockCount: cleanup.removedLockCount,
            })

            opsLog('info', 'wa_hard_restart_init_start', { connectionId })
            await initializeClient(connectionId)
            opsLog('info', 'wa_hard_restart_success', { connectionId })
        } catch (err: any) {
            opsLog('error', 'wa_hard_restart_failed', { connectionId, error: err.message })
        }
    }, 5000)
}

export async function checkAllClientsHealth(): Promise<{ checkedCount: number; unhealthyCount: number; details: Array<{ connectionId: string; healthy: boolean; reason?: string }> }> {
    const { opsLog } = await import('@/lib/opsLog')
    const entries = registry.getAllEntries().filter(e => e.channel === 'whatsapp' && e.state === 'ready')
    const details: Array<{ connectionId: string; healthy: boolean; reason?: string }> = []
    let unhealthyCount = 0

    for (const entry of entries) {
        const client = clients.get(entry.connectionId)

        if (!client) {
            // Client object missing but registry says ready — stale
            const lastAction = watchdogLastAction.get(entry.connectionId) || 0
            if (Date.now() - lastAction < WATCHDOG_COOLDOWN_MS) {
                details.push({ connectionId: entry.connectionId, healthy: false, reason: 'stale_cooldown' })
                continue
            }
            watchdogLastAction.set(entry.connectionId, Date.now())
            opsLog('warn', 'wa_watchdog_stale', { connectionId: entry.connectionId, reason: 'client_missing' })
            const curInstanceId = registry.getInstanceId(entry.connectionId)
            if (curInstanceId) {
                registry.setFailed(entry.connectionId, curInstanceId, 'watchdog: client missing from map')
            }
            instanceIds.delete(entry.connectionId) // FIX 5: drop stale instanceId
            // Stage 1 addition: attempt automatic recovery
            scheduleHardRestart(entry.connectionId, 'client_missing').catch(() => {})
            unhealthyCount++
            details.push({ connectionId: entry.connectionId, healthy: false, reason: 'client_missing' })
            continue
        }

        if (!client.info) {
            // Puppeteer dead — client.info is null
            const lastAction = watchdogLastAction.get(entry.connectionId) || 0
            if (Date.now() - lastAction < WATCHDOG_COOLDOWN_MS) {
                details.push({ connectionId: entry.connectionId, healthy: false, reason: 'stale_info_cooldown' })
                continue
            }
            watchdogLastAction.set(entry.connectionId, Date.now())
            opsLog('warn', 'wa_watchdog_stale', { connectionId: entry.connectionId, reason: 'client_info_null' })
            const curInstanceId = registry.getInstanceId(entry.connectionId)
            if (curInstanceId) {
                registry.setFailed(entry.connectionId, curInstanceId, 'watchdog: puppeteer dead (client.info null)')
            }
            try { client.removeAllListeners() } catch { /* ignore */ } // FIX 4 extension: drop listeners on dead client
            clients.delete(entry.connectionId)
            instanceIds.delete(entry.connectionId) // FIX 5: drop stale instanceId
            // Stage 1 addition: attempt automatic recovery
            scheduleHardRestart(entry.connectionId, 'client_info_null').catch(() => {})
            unhealthyCount++
            details.push({ connectionId: entry.connectionId, healthy: false, reason: 'client_info_null' })
            continue
        }

        // Healthy
        registry.touchLastSeen(entry.connectionId)
        details.push({ connectionId: entry.connectionId, healthy: true })
    }

    opsLog('info', 'wa_watchdog_check', { checkedCount: entries.length, unhealthyCount })
    return { checkedCount: entries.length, unhealthyCount, details }
}

export async function sendMessage(connectionId: string, chatId: string, text: string): Promise<{ externalId: string }> {
    let client = clients.get(connectionId)

    // Lightweight runtime validation: detect stale client (puppeteer dead but object in map)
    // Registry is source of truth for state, but this catches puppeteer crashes between health checks.
    if (client && !client.info) {
        console.warn(`[WA-TRANSPORT] stale_client_detected connId=${connectionId}`)
        const curInstanceId = instanceIds.get(connectionId)
        if (curInstanceId) {
            registry.setFailed(connectionId, curInstanceId, 'stale client detected in sendMessage')
        }
        clients.delete(connectionId)
        client = undefined
    }

    // Lazy-load client if missing (e.g. after Next.js hot reload)
    if (!client) {
        const conn = await prisma.whatsAppConnection.findUnique({ where: { id: connectionId } })
        if (conn && (conn.status === 'ready' || conn.status === 'authenticated')) {
            console.log(`[WA-SERVICE] Lazy restoring client for ${connectionId}`)
            
            let initError: Error | null = null;
            initializeClient(connectionId).catch(e => {
                console.error(`[WA-SERVICE] Lazy init failed for ${connectionId}:`, e);
                initError = e instanceof Error ? e : new Error(String(e));
            })
            
            // Wait up to 30 seconds for it to become ready
            await new Promise<void>((resolve, reject) => {
                let attempts = 0
                const checkInterval = setInterval(() => {
                    attempts++
                    if (initError) {
                        clearInterval(checkInterval)
                        reject(new Error(`Failed to restore WhatsApp session: ${initError.message}`))
                        return
                    }
                    const c = clients.get(connectionId)
                    if (c && c.info) {
                        clearInterval(checkInterval)
                        resolve()
                        return
                    }
                    if (attempts > 60) {
                        clearInterval(checkInterval)
                        reject(new Error('Timeout waiting for WhatsApp to restore session. Timeout 30s.'))
                    }
                }, 500)
            })
            client = clients.get(connectionId)
        }
    }

    if (!client) throw new Error('Client not connected')

    // Ensure chatId has the proper WhatsApp suffix
    const digits = chatId.replace(/\D/g, '')
    const defaultSuffix = digits.length >= 14 ? '@lid' : '@c.us'
    const targetChatId = chatId.includes('@') ? chatId : `${digits}${defaultSuffix}`

    let msg
    try {
        msg = await client.sendMessage(targetChatId, text)
    } catch (sendErr: any) {
        // Detect puppeteer crash: "detached Frame", "Protocol error", "Target closed"
        const errMsg = sendErr.message || ''
        const isPuppeteerDead = errMsg.includes('detached Frame') ||
            errMsg.includes('Protocol error') ||
            errMsg.includes('Target closed') ||
            errMsg.includes('Session closed')
        if (isPuppeteerDead) {
            console.warn(`[WA-TRANSPORT] puppeteer_crash_detected connId=${connectionId} error=${errMsg}`)
            const curInstanceId = instanceIds.get(connectionId)
            if (curInstanceId) {
                registry.setFailed(connectionId, curInstanceId, `puppeteer crash: ${errMsg}`)
            }
            clients.delete(connectionId)
        }
        throw sendErr
    }

    // Touch registry on successful send
    const sendInstanceId = instanceIds.get(connectionId)
    if (sendInstanceId) registry.touch(connectionId, sendInstanceId)

    const ts = new Date(msg.timestamp * 1000)
    
    // Ensure WhatsAppChat exists so Prisma does not throw validation/FK errors
    await prisma.whatsAppChat.upsert({
        where: { id: targetChatId },
        update: { lastMessageAt: ts },
        create: {
            id: targetChatId,
            connectionId,
            name: targetChatId.split('@')[0],
            lastMessageAt: ts
        }
    })

    // Legacy WhatsAppMessage
    await prisma.whatsAppMessage.create({
        data: {
            id: msg.id._serialized,
            chatId: targetChatId,
            body: text,
            fromMe: true,
            timestamp: ts,
            type: 'chat'
        }
    })
    
    // Unified Message
    // DE-DUPLICATION: Check if there is already a unified message with same content and recent timestamp
    // This prevents double creates if MessageService already created an optimistic record
    const normalizedPhone = digits.length >= 10 ? '7' + digits.slice(-10) : digits
    const normalizedTarget = `whatsapp:${normalizedPhone}`;
    const searchSuffix = normalizedPhone.slice(-10);
    
    let unifiedChat = await prisma.chat.findFirst({ 
        where: { 
            channel: 'whatsapp',
            OR: [
                { externalChatId: normalizedTarget },
                { externalChatId: targetChatId },
                { externalChatId: digits },
                { externalChatId: { endsWith: searchSuffix } }
            ]
        },
        orderBy: { driverId: 'desc' } // Prefer chat linked to a driver
    });
    
    if (unifiedChat) {
        if (unifiedChat.externalChatId !== normalizedTarget) {
             unifiedChat = await prisma.chat.update({
                 where: { id: unifiedChat.id },
                 data: { externalChatId: normalizedTarget }
             });
        }
        
        const existing = await prisma.message.findFirst({
            where: {
                chatId: unifiedChat.id,
                content: text,
                direction: 'outbound',
                sentAt: {
                    gte: new Date(ts.getTime() - 5000), // 5 second window
                    lte: new Date(ts.getTime() + 5000)
                }
            }
        })

        if (existing) {
            console.log(`[WA-SERVICE] Found existing optimistic message ${existing.id}, updating with externalId ${msg.id._serialized}`)
            await prisma.message.update({
                where: { id: existing.id },
                data: { 
                    externalId: msg.id._serialized,
                    status: 'delivered',
                    sentAt: ts // Update to actual sent time from WA
                }
            })
        } else {
            await prisma.message.create({
                data: {
                    chatId: unifiedChat.id,
                    direction: 'outbound',
                    type: 'text',
                    content: text,
                    externalId: msg.id._serialized,
                    sentAt: ts,
                    status: 'delivered'
                }
            })
        }

        await prisma.chat.update({
            where: { id: unifiedChat.id },
            data: { lastMessageAt: ts }
        })
    }

    return { externalId: msg.id._serialized }
}

/**
 * Send a media message (photo, document, video, voice, audio) via WhatsApp.
 * Accepts base64 data and wraps it as MessageMedia.
 */
export async function sendMedia(
    connectionId: string,
    chatId: string,
    base64: string,
    filename: string,
    mimeType: string,
    caption?: string,
    options?: { sendAsVoice?: boolean; sendAsDocument?: boolean }
): Promise<{ externalId: string }> {
    let client = clients.get(connectionId)

    // Lazy-load client if missing (same pattern as sendMessage)
    if (client && !client.info) {
        const curInstanceId = instanceIds.get(connectionId)
        if (curInstanceId) registry.setFailed(connectionId, curInstanceId, 'stale client detected in sendMedia')
        clients.delete(connectionId)
        client = undefined
    }

    if (!client) {
        const conn = await prisma.whatsAppConnection.findUnique({ where: { id: connectionId } })
        if (conn && (conn.status === 'ready' || conn.status === 'authenticated')) {
            console.log(`[WA-SERVICE] Lazy restoring client for sendMedia ${connectionId}`)
            initializeClient(connectionId).catch(e =>
                console.error(`[WA-SERVICE] Lazy init failed for ${connectionId}:`, e)
            )
            await new Promise<void>((resolve, reject) => {
                let attempts = 0
                const checkInterval = setInterval(() => {
                    attempts++
                    const c = clients.get(connectionId)
                    if (c && c.info) { clearInterval(checkInterval); resolve(); return }
                    if (attempts > 60) { clearInterval(checkInterval); reject(new Error('Timeout waiting for WhatsApp')) }
                }, 500)
            })
            client = clients.get(connectionId)
        }
    }

    if (!client) throw new Error('Client not connected')

    // Ensure chatId has proper WhatsApp suffix
    const digits = chatId.replace(/\D/g, '')
    const defaultSuffix = digits.length >= 14 ? '@lid' : '@c.us'
    const targetChatId = chatId.includes('@') ? chatId : `${digits}${defaultSuffix}`

    // Build MessageMedia from base64 (strip data: prefix if present)
    const cleanBase64 = base64.startsWith('data:') ? base64.split(',')[1] : base64
    const media = new MessageMedia(mimeType, cleanBase64, filename)

    const sendOptions: any = {}
    if (caption) sendOptions.caption = caption
    if (options?.sendAsVoice) sendOptions.sendAudioAsVoice = true
    if (options?.sendAsDocument) sendOptions.sendMediaAsDocument = true

    let msg
    try {
        msg = await client.sendMessage(targetChatId, media, sendOptions)
    } catch (sendErr: any) {
        const errMsg = sendErr.message || ''
        const isPuppeteerDead = errMsg.includes('detached Frame') || errMsg.includes('Protocol error') ||
            errMsg.includes('Target closed') || errMsg.includes('Session closed')
        if (isPuppeteerDead) {
            const curInstanceId = instanceIds.get(connectionId)
            if (curInstanceId) registry.setFailed(connectionId, curInstanceId, `puppeteer crash: ${errMsg}`)
            clients.delete(connectionId)
        }
        throw sendErr
    }

    const sendInstanceId = instanceIds.get(connectionId)
    if (sendInstanceId) registry.touch(connectionId, sendInstanceId)

    const ts = new Date(msg.timestamp * 1000)

    // Ensure WhatsAppChat exists
    await prisma.whatsAppChat.upsert({
        where: { id: targetChatId },
        update: { lastMessageAt: ts },
        create: { id: targetChatId, connectionId, name: targetChatId.split('@')[0], lastMessageAt: ts }
    })

    console.log(`[WA-SERVICE] SENT media type=${mimeType} filename=${filename} to=${targetChatId} msgId=${msg.id._serialized}`)

    return { externalId: msg.id._serialized }
}

export async function downloadMedia(messageId: string, chatId: string): Promise<string | null> {
    const msg = await prisma.whatsAppMessage.findUnique({
        where: { id_chatId: { id: messageId, chatId } }
    })
    if (!msg || msg.isMediaLoaded || !msg.chatId) return msg?.mediaPath || null

    const chat = await prisma.whatsAppChat.findUnique({ where: { id: chatId } })
    if (!chat) return null

    const client = clients.get(chat.connectionId)
    if (!client) throw new Error('Client not connected')

    // Need original WA message object to download
    // This is a limitation of the library; we'd need to fetch by ID
    // For now, return null as placeholder for lazy load endpoint
    return null
}

/**
 * Import WhatsApp history as a HistoryImportJob.
 * Reuses the existing syncHistory logic but respects mode/daysBack and tracks job metrics.
 */
export async function importWhatsAppHistory(
    jobId: string, mode: string, daysBack?: number, connectionId?: string
) {
    console.log(`[WA-IMPORT] Starting job=${jobId} mode=${mode} daysBack=${daysBack} conn=${connectionId}`)

    // 1. Resolve connection
    let connId = connectionId
    if (!connId) {
        const conns = await prisma.whatsAppConnection.findMany({ where: { status: 'ready' } })
        if (conns.length === 0) {
            console.error('[WA-IMPORT] No ready WhatsApp connections')
            await updateImportJob(jobId, { status: 'failed', resultType: 'failed', finishedAt: new Date() })
            return
        }
        connId = conns[0].id
    }

    const client = clients.get(connId)
    if (!client) {
        console.error(`[WA-IMPORT] Client not found for connection ${connId}`)
        await updateImportJob(jobId, { status: 'failed', resultType: 'failed', finishedAt: new Date() })
        return
    }

    // 2. Update job to running
    await updateImportJob(jobId, { status: 'running', startedAt: new Date() })

    // 3. Compute cutoff date based on mode + register for live filter in client.on('message')
    let cutoff: Date
    if (mode === 'last_n_days' && daysBack) {
        cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - daysBack)
        connectionSyncCutoffs.set(connId!, cutoff)
    } else if (mode === 'from_connection_time') {
        cutoff = new Date() // only new messages from now
        connectionSyncCutoffs.set(connId!, cutoff)
    } else {
        // available_history — no cutoff, allow everything the library delivers
        cutoff = getHistoryCutoff()
        connectionSyncCutoffs.delete(connId!)
    }
    opsLog('info', 'wa_sync_cutoff_set', {
        connectionId: connId, mode, cutoffISO: cutoff.toISOString(),
    })

    let totalMessages = 0
    let newMessages = 0
    let totalChats = 0
    let totalContacts = 0
    let minDate: Date | null = null
    let maxDate: Date | null = null

    try {
        // Retry getChats() on "Execution context was destroyed" — WA Web
        // occasionally navigates internally right after ready, invalidating
        // puppeteer's evaluate context. Give it a few seconds to stabilize.
        const chatsRaw = await retryOnCdpError(
            () => client.getChats(),
            { retries: 4, delayMs: 5000, op: 'getChats' },
            connId!,
        )

        for (const chatRaw of chatsRaw) {
            try {
                // Skip groups and status broadcasts — CRM is 1:1 focused
                const chatJid = chatRaw.id?._serialized || ''
                if (chatJid.endsWith('@g.us')) continue
                if (chatJid === 'status@broadcast') continue
                if ((chatRaw as any).isGroup) continue

                totalChats++

                // Upsert legacy WA chat
                await prisma.whatsAppChat.upsert({
                    where: { id: chatRaw.id._serialized },
                    update: { name: chatRaw.name },
                    create: { id: chatRaw.id._serialized, connectionId: connId!, name: chatRaw.name }
                })

                // Upsert unified Chat
                const unifiedChat = await prisma.chat.upsert({
                    where: { externalChatId: chatRaw.id._serialized },
                    update: { name: chatRaw.name },
                    create: {
                        externalChatId: chatRaw.id._serialized,
                        channel: 'whatsapp',
                        name: chatRaw.name,
                        metadata: { connectionId: connId }
                    }
                })

                // Contact resolution
                if (!unifiedChat.contactId) {
                    try {
                        const rawPhone = chatRaw.id._serialized?.split('@')[0]
                        if (rawPhone && /^\d{10,15}$/.test(rawPhone)) {
                            await ContactService.resolveContact('whatsapp', rawPhone, rawPhone, chatRaw.name)
                            totalContacts++
                        }
                    } catch {}
                }

                // Fetch messages — try fetchMessages first, fall back to Store.Chat.msgs for @lid chats
                let rawMessages: { id: string; body: string; timestamp: number; fromMe: boolean; type: string }[] = []
                try {
                    const fetched = await chatRaw.fetchMessages({ limit: 1000 })
                    rawMessages = fetched.map(m => ({
                        id: m.id._serialized,
                        body: m.body || '',
                        timestamp: m.timestamp,
                        fromMe: m.fromMe,
                        type: m.type,
                    }))
                } catch {
                    // fetchMessages fails for @lid chats — use Puppeteer Store directly
                    const page = (client as any).pupPage
                    if (page) {
                        try {
                            rawMessages = await page.evaluate((cid: string) => {
                                const store = (window as any).Store
                                if (!store?.Chat) return []
                                const chat = store.Chat.get(cid)
                                if (!chat?.msgs) return []
                                const models = chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : Array.from(chat.msgs)
                                return models.map((m: any) => ({
                                    id: m.id?._serialized || '',
                                    body: m.body || '',
                                    timestamp: m.t || 0,
                                    fromMe: !!m.id?.fromMe,
                                    type: m.type || 'chat',
                                }))
                            }, chatRaw.id._serialized)
                        } catch {}
                    }
                }
                const filtered = rawMessages.filter(m => new Date(m.timestamp * 1000) >= cutoff)

                let chatMaxTs: Date | null = null
                for (const msg of filtered) {
                    try {
                        const ts = new Date(msg.timestamp * 1000)
                        if (!chatMaxTs || ts > chatMaxTs) chatMaxTs = ts
                        if (!minDate || ts < minDate) minDate = ts
                        if (!maxDate || ts > maxDate) maxDate = ts

                        const msgType = mapMsgType(msg.type)
                        const msgId = msg.id // already a string from rawMessages

                        // Legacy
                        await prisma.whatsAppMessage.upsert({
                            where: { id_chatId: { id: msgId, chatId: chatRaw.id._serialized } },
                            update: {},
                            create: {
                                id: msgId,
                                chatId: chatRaw.id._serialized,
                                body: msg.body || '',
                                fromMe: msg.fromMe,
                                timestamp: ts,
                                type: msgType,
                            }
                        })

                        // Unified Message with dedup
                        const existing = await prisma.message.findFirst({
                            where: {
                                OR: [
                                    { externalId: msgId },
                                    {
                                        chatId: unifiedChat.id,
                                        content: waContentWithFallback(msg.body, msg.type),
                                        direction: msg.fromMe ? 'outbound' : 'inbound',
                                        sentAt: { gte: new Date(ts.getTime() - 2000), lte: new Date(ts.getTime() + 2000) }
                                    }
                                ]
                            }
                        })

                        totalMessages++
                        if (!existing) {
                            await prisma.message.create({
                                data: {
                                    chatId: unifiedChat.id,
                                    direction: msg.fromMe ? 'outbound' : 'inbound',
                                    type: mapToUnifiedMessageType(msg.type),
                                    content: waContentWithFallback(msg.body, msg.type),
                                    externalId: msgId,
                                    channel: 'whatsapp',
                                    sentAt: ts
                                }
                            })
                            newMessages++
                        }
                    } catch (msgErr: any) {
                        console.error(`[WA-IMPORT] Msg error ${msg.id}: ${msgErr.message}`)
                    }
                }

                // Update lastMessageAt
                if (chatMaxTs) {
                    await prisma.whatsAppChat.update({ where: { id: chatRaw.id._serialized }, data: { lastMessageAt: chatMaxTs } })
                    await prisma.chat.update({ where: { externalChatId: chatRaw.id._serialized }, data: { lastMessageAt: chatMaxTs } })
                }

                // Periodic job progress update (every 5 chats)
                if (totalChats % 5 === 0) {
                    await updateImportJob(jobId, {
                        status: 'running',
                        messagesImported: totalMessages,
                        chatsScanned: totalChats,
                        contactsFound: totalContacts,
                    })
                }
            } catch (chatErr: any) {
                console.error(`[WA-IMPORT] Chat error ${chatRaw.id._serialized}: ${chatErr.message}`)
            }
        }

        // 4. Query actual DB totals scoped to WA chats and cutoff period
        const dbTotals = await prisma.$queryRaw<{ msg_count: bigint; chat_count: bigint; contact_count: bigint; min_date: Date | null; max_date: Date | null }[]>`
            SELECT
                (SELECT COUNT(*) FROM "Message" m JOIN "Chat" c ON m."chatId" = c.id WHERE c.channel = 'whatsapp' AND m."sentAt" >= ${cutoff}) as msg_count,
                (SELECT COUNT(*) FROM "Chat" WHERE channel = 'whatsapp') as chat_count,
                (SELECT COUNT(DISTINCT "contactId") FROM "Chat" WHERE channel = 'whatsapp' AND "contactId" IS NOT NULL) as contact_count,
                (SELECT MIN(m."sentAt") FROM "Message" m JOIN "Chat" c ON m."chatId" = c.id WHERE c.channel = 'whatsapp' AND m."sentAt" >= ${cutoff}) as min_date,
                (SELECT MAX(m."sentAt") FROM "Message" m JOIN "Chat" c ON m."chatId" = c.id WHERE c.channel = 'whatsapp') as max_date
        `
        const db = dbTotals[0]
        const dbMsgCount = Number(db?.msg_count ?? 0)
        const dbChatCount = Number(db?.chat_count ?? 0)
        const dbContactCount = Number(db?.contact_count ?? 0)

        // Use DB totals if scan found nothing (auto-sync already loaded data)
        const finalMessages = totalMessages > 0 ? totalMessages : dbMsgCount
        const finalChats = totalChats > 0 ? totalChats : dbChatCount
        const finalContacts = totalContacts > 0 ? totalContacts : dbContactCount
        const finalMinDate = minDate ?? db?.min_date ?? null
        const finalMaxDate = maxDate ?? db?.max_date ?? null

        // 5. Complete
        const resultType = finalMessages > 0 ? 'full' : 'live_only'
        await updateImportJob(jobId, {
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
        console.log(`[WA-IMPORT] Completed job=${jobId}: ${finalMessages} msgs (${newMessages} new, ${finalMessages - newMessages} existing), ${finalChats} chats, ${finalContacts} contacts`)
    } catch (err: any) {
        console.error(`[WA-IMPORT] Fatal error job=${jobId}: ${err.message}`)
        await updateImportJob(jobId, {
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
async function updateImportJob(jobId: string, data: {
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
        const sets: string[] = []
        const vals: any[] = []
        let idx = 1

        if (data.status !== undefined)           { sets.push(`status = $${idx}::"AiImportStatus"`); vals.push(data.status); idx++ }
        if (data.resultType !== undefined)        { sets.push(`"resultType" = $${idx}`); vals.push(data.resultType); idx++ }
        if (data.messagesImported !== undefined)  { sets.push(`"messagesImported" = $${idx}`); vals.push(data.messagesImported); idx++ }
        if (data.chatsScanned !== undefined)      { sets.push(`"chatsScanned" = $${idx}`); vals.push(data.chatsScanned); idx++ }
        if (data.contactsFound !== undefined)     { sets.push(`"contactsFound" = $${idx}`); vals.push(data.contactsFound); idx++ }
        if (data.startedAt !== undefined)         { sets.push(`"startedAt" = $${idx}`); vals.push(data.startedAt); idx++ }
        if (data.finishedAt !== undefined)        { sets.push(`"finishedAt" = $${idx}`); vals.push(data.finishedAt); idx++ }
        if (data.coveredPeriodFrom !== undefined) { sets.push(`"coveredPeriodFrom" = $${idx}`); vals.push(data.coveredPeriodFrom); idx++ }
        if (data.coveredPeriodTo !== undefined)   { sets.push(`"coveredPeriodTo" = $${idx}`); vals.push(data.coveredPeriodTo); idx++ }
        if (data.detailsJson !== undefined)       { sets.push(`"detailsJson" = $${idx}::jsonb`); vals.push(JSON.stringify(data.detailsJson)); idx++ }

        if (sets.length === 0) return
        vals.push(jobId)
        await prisma.$executeRawUnsafe(
            `UPDATE "HistoryImportJob" SET ${sets.join(', ')} WHERE id = $${idx}`,
            ...vals
        )
    } catch (err: any) {
        console.error(`[WA-IMPORT] updateImportJob error: ${err.message}`)
    }
}

/**
 * Check if a phone number is registered on WhatsApp.
 * Uses client.isRegisteredUser() from whatsapp-web.js.
 *
 * On timeout, missing client, or internal error returns { reachable: true } as a soft fallback —
 * this means "don't show a warning", NOT "confirmed reachable".
 */
export async function checkReachability(
    phone: string,
    connectionId?: string
): Promise<{ reachable: boolean; error?: string }> {
    const TIMEOUT_MS = 8_000

    try {
        // Find a ready connection
        let connId = connectionId
        if (!connId) {
            const conn = await prisma.whatsAppConnection.findFirst({
                where: { status: 'ready' },
                select: { id: true },
            })
            if (!conn) return { reachable: true } // No ready connection — soft fallback
            connId = conn.id
        }

        const client = clients.get(connId)
        if (!client || !client.info) {
            // Client not initialized or stale — soft fallback, don't warn
            return { reachable: true }
        }

        // Normalize: strip '+' and non-digits
        const digits = phone.replace(/\D/g, '')
        if (digits.length < 10) {
            return { reachable: true } // Too short to check — soft fallback
        }

        const result = await Promise.race([
            client.isRegisteredUser(`${digits}@c.us`),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS)),
        ])

        // Timeout → soft fallback
        if (result === null) return { reachable: true }

        if (result) {
            return { reachable: true }
        } else {
            return { reachable: false, error: 'Номер не зарегистрирован в WhatsApp' }
        }
    } catch (err: any) {
        // Any error — soft fallback
        console.error(`[WA-CHECK] Error checking ${phone}: ${err.message}`)
        return { reachable: true }
    }
}

// ═══════════════════════════════════════════════════════════════════
// Derived status — single source of truth for UI
// Combines DB status + registry state + runtime liveness + heartbeat
// ═══════════════════════════════════════════════════════════════════

const HEARTBEAT_STALE_MS = 5 * 60 * 1000

// ─── Pause / Resume ──────────────────────────────────────────────────

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
    const client = clients.get(connectionId)
    const buf = messageBuffers.get(connectionId) ?? []
    messageBuffers.delete(connectionId)
    if (!client || buf.length === 0) {
        opsLog('info', 'wa_buffer_flush', { connectionId, count: 0 })
        return 0
    }
    opsLog('info', 'wa_buffer_flush_start', { connectionId, count: buf.length })
    // wa-web.js delivers messages through client.on('message') — there is no public
    // method to replay directly. We simulate: re-emit the message event.
    let processed = 0
    for (const m of buf) {
        try {
            ;(client as any).emit('message', m)
            processed++
        } catch (err: any) {
            console.error('[WA-SERVICE] Buffer flush error:', err?.message)
        }
    }
    opsLog('info', 'wa_buffer_flush_complete', { connectionId, processed })
    return processed
}

/**
 * Drop buffered messages without processing. Used on resume with catchUp=false.
 */
export function dropPausedBuffer(connectionId: string): number {
    const count = (messageBuffers.get(connectionId) ?? []).length
    messageBuffers.delete(connectionId)
    opsLog('info', 'wa_buffer_dropped', { connectionId, count })
    return count
}

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
    const client = clients.get(connectionId)

    let state: ActualWhatsAppState

    if (!db) {
        state = 'idle'
    } else if (entry?.state === 'failed') {
        const isAuth = (entry.lastError ?? '').toLowerCase().includes('auth_failure')
        state = isAuth ? 'auth_failed' : 'broken'
    } else if (entry?.state === 'reconnecting') {
        state = 'reconnecting'
    } else if (entry?.state === 'initializing') {
        state = db.status === 'qr' ? 'qr_required'
              : db.status === 'authenticated' ? 'authenticated'
              : 'initializing'
    } else if (entry?.state === 'ready') {
        const alive = !!client?.info
        const lastSeen = entry.lastSeen?.getTime() ?? 0
        const heartbeatFresh = Date.now() - lastSeen < HEARTBEAT_STALE_MS
        if (!alive) state = 'broken'
        else if (!heartbeatFresh) state = 'degraded'
        else state = 'ready'
    } else {
        // entry?.state === 'stopped' OR !entry
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

/**
 * Destroy client, wipe LocalAuth session folder, reset DB status,
 * then AUTO-RESTART init so user sees progress immediately (QR or broken again).
 * Wired to UI "Пересоздать сессию" button in broken/auth_failed/degraded states.
 *
 * FIX 7: serialized per connectionId via forceResetLocks map.
 * Concurrent callers all await the same Promise; lock cleared on completion.
 */
export async function forceResetSession(connectionId: string): Promise<void> {
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

    // Stage 1: kill zombie chromes + remove singleton locks for this session.
    // Without this, the wipe below hits EBUSY on first_party_sets.db because
    // puppeteer's Chrome is still flushing to disk even after client.destroy().
    try {
        const { cleanupStaleWhatsAppSessions } = await import('./WhatsAppCleanup')
        const result = await cleanupStaleWhatsAppSessions(connectionId)
        opsLog('info', 'wa_force_reset_cleanup', {
            connectionId,
            killedChromeCount: result.killedChromeCount,
            removedLockCount: result.removedLockCount,
        })
    } catch (err: any) {
        opsLog('warn', 'wa_force_reset_cleanup_error', {
            connectionId, error: err?.message ?? String(err),
        })
    }

    const sessionDir = path.join(
        process.cwd(), 'node_modules', '.wwebjs_auth', `session-${connectionId}`
    )

    // Retry wipe up to 3 times — Windows sometimes needs an extra moment
    // after Chrome process exits before it releases all DB/cache files.
    let wiped = false
    let lastErr: any
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await fs.promises.rm(sessionDir, { recursive: true, force: true })
            opsLog('info', 'wa_force_reset_session_wiped', { connectionId, path: sessionDir, attempt })
            wiped = true
            break
        } catch (err: any) {
            lastErr = err
            if (attempt < 3) {
                // EBUSY/EPERM on Windows: wait, then another cleanup pass, then retry
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
                try {
                    const { cleanupStaleWhatsAppSessions } = await import('./WhatsAppCleanup')
                    await cleanupStaleWhatsAppSessions(connectionId)
                } catch { /* ignore */ }
            }
        }
    }
    if (!wiped) {
        opsLog('warn', 'wa_force_reset_wipe_failed', {
            connectionId, error: lastErr?.message ?? String(lastErr),
        })
    }

    await safeUpdateConnection(connectionId, {
        status: 'idle', sessionData: null, phoneNumber: null,
    })

    // Auto-restart init in background so user sees live progress (QR or broken again).
    // Do NOT await — UI needs immediate response; init status flows through state store.
    // initializeClient has its own in-flight guard (FIX 1), safe to call here.
    opsLog('info', 'wa_force_reset_auto_init', { connectionId })
    initializeClient(connectionId).catch(err => {
        opsLog('error', 'wa_force_reset_auto_init_failed', {
            connectionId, error: err?.message ?? String(err),
        })
    })
}
