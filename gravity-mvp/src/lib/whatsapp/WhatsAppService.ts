import { Client, LocalAuth, Message } from 'whatsapp-web.js'
import { prisma } from '@/lib/prisma'
import path from 'path'
import fs from 'fs'
import fetch from 'node-fetch'
import { DriverMatchService } from '@/lib/DriverMatchService'
import { ContactService } from '@/lib/ContactService'
import { ConversationWorkflowService } from '@/lib/ConversationWorkflowService'
import { emitMessageReceived } from '@/lib/messageEvents'
import * as registry from '@/lib/TransportRegistry'

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

if (typeof global.fetch === 'undefined') {
    // @ts-ignore
    global.fetch = fetch as any
}

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

                const messages = await chatRaw.fetchMessages({ limit: 1000 })
                const filtered = messages.filter(m => {
                    const ts = new Date(m.timestamp * 1000)
                    return ts >= cutoff
                })

                let maxTimestamp: Date | null = null
                for (const msg of filtered) {
                    try {
                        const ts = new Date(msg.timestamp * 1000)
                        if (!maxTimestamp || ts > maxTimestamp) maxTimestamp = ts

                        const msgType = mapMsgType(msg.type)
                        
                        // Legacy WhatsAppMessage
                        await prisma.whatsAppMessage.upsert({
                            where: { id_chatId: { id: msg.id._serialized, chatId: chatRaw.id._serialized } },
                            update: {},
                            create: {
                                id: msg.id._serialized,
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
                            // DE-DUPLICATION: check if we already have this message (by externalId OR content+time)
                            const existing = await prisma.message.findFirst({
                                where: {
                                    OR: [
                                        { externalId: msg.id._serialized },
                                        {
                                            chatId: unifiedChat.id,
                                            content: msg.body || '',
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
                                // Update existing message with provider ID if it was missing
                                if (!existing.externalId) {
                                    await prisma.message.update({
                                        where: { id: existing.id },
                                        data: { externalId: msg.id._serialized }
                                    })
                                }
                            } else {
                                await prisma.message.create({
                                    data: {
                                        chatId: unifiedChat.id,
                                        direction: msg.fromMe ? 'outbound' : 'inbound',
                                        type: mapToUnifiedMessageType(msg.type),
                                        content: msg.body || '',
                                        externalId: msg.id._serialized,
                                        sentAt: ts
                                    }
                                })
                            }
                        }
                    } catch (msgErr) {
                        console.error(`[WA-SERVICE] Failed to save message ${msg.id._serialized}:`, msgErr)
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

export function getClient(connectionId: string): Client | undefined {
    return clients.get(connectionId)
}

/** Get runtime status — delegates to TransportRegistry. */
export function getRuntimeStatus() {
    return registry.getAllEntries().filter(e => e.channel === 'whatsapp')
}

export async function initializeClient(connectionId: string): Promise<void> {
    // Always ensure registry entry exists
    registry.ensureEntry(connectionId, 'whatsapp')

    if (clients.has(connectionId) && clients.get(connectionId)!.info) {
        // Client already alive — just ensure registry reflects ready state
        if (!instanceIds.has(connectionId)) {
            const iid = registry.beginNewInstance(connectionId)
            instanceIds.set(connectionId, iid)
            registry.setReady(connectionId, iid)
        }
        return
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
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1018280665-alpha.html',
        }
    })

    clients.set(connectionId, client)

    client.on('qr', async (qr) => {
        try {
            console.log(`[WA-SERVICE] QR received for ${connectionId}`)
            const QRCode = (await import('qrcode')).default
            const qrDataUrl = await QRCode.toDataURL(qr)
            await safeUpdateConnection(connectionId, { status: 'qr', sessionData: qrDataUrl })
        } catch (err) {
            console.error(`[WA-SERVICE] QR event error for ${connectionId}:`, err)
        }
    })

    client.on('authenticated', async () => {
        try {
            console.log(`[WA-SERVICE] Authenticated for ${connectionId}`)
            await safeUpdateConnection(connectionId, { status: 'authenticated' })
            await saveSession(connectionId, client)
        } catch (err) {
            console.error(`[WA-SERVICE] Authenticated event error for ${connectionId}:`, err)
        }
    })

    client.on('ready', async () => {
        try {
            if (!registry.isCurrentInstance(connectionId, instanceId)) return
            registry.setReady(connectionId, instanceId)
            const info = client.info
            await safeUpdateConnection(connectionId, {
                status: 'ready',
                phoneNumber: info?.wid?.user || null
            })
            syncHistory(connectionId, client).catch(err =>
                console.error(`[WA-SERVICE] Background sync error:`, err)
            )
        } catch (err) {
            console.error(`[WA-SERVICE] Ready event error for ${connectionId}:`, err)
        }
    })

    client.on('message', async (msg: Message) => {
        // ECHO GUARD: Skip our own outbound messages that WA library fires as events
        if (msg.fromMe) {
            console.log(`[WA-SERVICE] SKIP fromMe=true msgId=${msg.id._serialized} from=${msg.from} body="${(msg.body || '').substring(0, 30)}"`)
            return
        }

        console.log(`[WA-SERVICE] INBOUND msgId=${msg.id._serialized} fromMe=${msg.fromMe} from=${msg.from} body="${(msg.body || '').substring(0, 30)}"`)
        const logLine = `[${new Date().toISOString()}] INBOUND MSG: id=${msg.id._serialized} fromMe=${msg.fromMe} from=${msg.from} body="${msg.body}"\n`;
        try { fs.appendFileSync(path.join(process.cwd(), 'wa-incoming.log'), logLine); } catch(e) {}
        try {
            let rawChatId = msg.from  // e.g. '79221853150@c.us'
            const ts = new Date(msg.timestamp * 1000)

            // If the sender is a LID, attempt to get their real phone number
            if (rawChatId.includes('@lid')) {
                try {
                    const contact = await msg.getContact();
                    if (contact && contact.number) {
                        console.log(`[WA-SERVICE] Translated LID ${rawChatId} to contact number ${contact.number}`);
                        rawChatId = `${contact.number}@c.us`;
                    }
                } catch (e) {
                    console.error(`[WA-SERVICE] Failed to get contact for LID ${rawChatId}`, e);
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
                    fromMe: false,
                    timestamp: ts,
                    type: mapMsgType(msg.type)
                }
            })

            // Unified Message — with DB-level dedup logging
            const existingUnified = await prisma.message.findFirst({
                where: {
                    OR: [
                        { externalId: msg.id._serialized },
                        {
                            chatId: unifiedChat.id,
                            content: msg.body || '',
                            direction: 'inbound',
                            sentAt: {
                                gte: new Date(ts.getTime() - 2000),
                                lte: new Date(ts.getTime() + 2000)
                            }
                        }
                    ]
                }
            })

            if (existingUnified) {
                console.log(`[WA-SERVICE] DB-DEDUP: skipped duplicate msgId=${msg.id._serialized} (existing=${existingUnified.id})`)
                if (!existingUnified.externalId) {
                    await prisma.message.update({
                        where: { id: existingUnified.id },
                        data: { externalId: msg.id._serialized }
                    })
                }
            } else {
                const savedMsg = await prisma.message.create({
                    data: {
                        chatId: unifiedChat.id,
                        direction: 'inbound',
                        type: mapToUnifiedMessageType(msg.type),
                        content: msg.body || '',
                        externalId: msg.id._serialized,
                        sentAt: ts
                    }
                })

                // Workflow: inbound message state update
                await ConversationWorkflowService.onInboundMessage(unifiedChat.id, ts)

                console.log(`[WA-SERVICE] SAVED inbound msgId=${msg.id._serialized} to chat=${unifiedChat.id} driver=${unifiedChat.driverId || 'none'}`)
                emitMessageReceived(savedMsg).catch(e =>
                    console.error(`[WA-SERVICE] emitMessageReceived error:`, e.message)
                )
            }
        } catch (err) {
            console.error(`[WA-SERVICE] Message event error for ${connectionId}:`, err)
        }
    })

    client.on('auth_failure', async (msg) => {
        try {
            if (!registry.isCurrentInstance(connectionId, instanceId)) return
            // Unrecoverable — no auto-reconnect
            registry.setFailed(connectionId, instanceId, `auth_failure: ${msg}`)
            await safeUpdateConnection(connectionId, { status: 'error' })
            clients.delete(connectionId)
        } catch (err) {
            console.error(`[WA-SERVICE] Auth failure handler error:`, err)
        }
    })

    client.on('disconnected', async (reason) => {
        try {
            if (!registry.isCurrentInstance(connectionId, instanceId)) return
            await safeUpdateConnection(connectionId, { status: 'disconnected' })
            clients.delete(connectionId)

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

    try {
        await client.initialize()
    } catch (err) {
        console.error(`[WA-SERVICE] Initialization failed for ${connectionId}:`, err)
        clients.delete(connectionId)
        throw err
    }
}

export async function destroyClient(connectionId: string): Promise<void> {
    const client = clients.get(connectionId)
    if (!client) return
    console.log(`[WA-TRANSPORT] client_destroying connId=${connectionId}`)
    registry.setStopped(connectionId)

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
 */
const watchdogLastAction = new Map<string, number>()
const WATCHDOG_COOLDOWN_MS = 60000

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
            clients.delete(entry.connectionId)
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

    // 3. Compute cutoff date based on mode
    let cutoff: Date
    if (mode === 'last_n_days' && daysBack) {
        cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - daysBack)
    } else if (mode === 'from_connection_time') {
        cutoff = new Date() // only new messages from now
    } else {
        // available_history — use the standard 3-month window
        cutoff = getHistoryCutoff()
    }

    let totalMessages = 0
    let totalChats = 0
    let totalContacts = 0
    let minDate: Date | null = null
    let maxDate: Date | null = null

    try {
        const chatsRaw = await client.getChats()

        for (const chatRaw of chatsRaw) {
            try {
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

                // Fetch and filter messages
                const messages = await chatRaw.fetchMessages({ limit: 1000 })
                const filtered = messages.filter(m => new Date(m.timestamp * 1000) >= cutoff)

                let chatMaxTs: Date | null = null
                for (const msg of filtered) {
                    try {
                        const ts = new Date(msg.timestamp * 1000)
                        if (!chatMaxTs || ts > chatMaxTs) chatMaxTs = ts
                        if (!minDate || ts < minDate) minDate = ts
                        if (!maxDate || ts > maxDate) maxDate = ts

                        const msgType = mapMsgType(msg.type)

                        // Legacy
                        await prisma.whatsAppMessage.upsert({
                            where: { id_chatId: { id: msg.id._serialized, chatId: chatRaw.id._serialized } },
                            update: {},
                            create: {
                                id: msg.id._serialized,
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
                                    { externalId: msg.id._serialized },
                                    {
                                        chatId: unifiedChat.id,
                                        content: msg.body || '',
                                        direction: msg.fromMe ? 'outbound' : 'inbound',
                                        sentAt: { gte: new Date(ts.getTime() - 2000), lte: new Date(ts.getTime() + 2000) }
                                    }
                                ]
                            }
                        })

                        if (!existing) {
                            await prisma.message.create({
                                data: {
                                    chatId: unifiedChat.id,
                                    direction: msg.fromMe ? 'outbound' : 'inbound',
                                    type: mapToUnifiedMessageType(msg.type),
                                    content: msg.body || '',
                                    externalId: msg.id._serialized,
                                    channel: 'whatsapp',
                                    sentAt: ts
                                }
                            })
                            totalMessages++
                        }
                    } catch (msgErr: any) {
                        console.error(`[WA-IMPORT] Msg error ${msg.id._serialized}: ${msgErr.message}`)
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

        // 4. Complete
        const resultType = totalMessages > 0 ? 'full' : 'live_only'
        await updateImportJob(jobId, {
            status: 'completed',
            resultType,
            messagesImported: totalMessages,
            chatsScanned: totalChats,
            contactsFound: totalContacts,
            finishedAt: new Date(),
            coveredPeriodFrom: minDate,
            coveredPeriodTo: maxDate,
        })
        console.log(`[WA-IMPORT] Completed job=${jobId}: ${totalMessages} msgs, ${totalChats} chats, ${totalContacts} contacts`)
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
