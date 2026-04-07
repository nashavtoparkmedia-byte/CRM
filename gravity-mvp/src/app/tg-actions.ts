'use server'

import { prisma } from '@/lib/prisma'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions'
import QRCode from 'qrcode'
import { revalidatePath } from 'next/cache'
import { NewMessage } from 'telegram/events'
import * as registry from '@/lib/TransportRegistry'

// Global map to keep track of active login clients for QR
// Note: In a production serverless environment, this would need a different approach (like a separate service or Redis)
// But for local MVP development, this works.
const activeLogins = new Map<string, {
    client: TelegramClient,
    qrUrl: string,
    status: string,
    resolvePassword?: (password: string) => void
}>()

export async function getTelegramAuthQR(apiId: number, apiHash: string) {
    console.log(`[TG-AUTH] Starting QR generation for API ID: ${apiId}`)
    const stringSession = new StringSession('')
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    })

    await client.connect()
    console.log(`[TG-AUTH] Client connected to Telegram`)

    const loginId = Math.random().toString(36).substring(7)

    // We start the login process in the background
    const loginPromise = client.signInUserWithQrCode(
        { apiId, apiHash },
        {
            qrCode: async (code) => {
                console.log(`[TG-AUTH] QR Code received, expires in ${code.expires}s`)
                const qrUrl = await QRCode.toDataURL(`tg://login?token=${code.token.toString('base64url')}`)
                activeLogins.set(loginId, { client, qrUrl, status: 'awaiting_scan' })
                console.log(`[TG-AUTH] QR URL set for loginId: ${loginId}`)
            },
            password: async (hint) => {
                console.log(`[TG-AUTH] Password requested by Telegram (hint: ${hint})`)
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
                const current = activeLogins.get(loginId)
                if (current) activeLogins.set(loginId, { ...current, status: 'error' })
            }
        }
    )

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
            if (current) activeLogins.set(loginId, { ...current, status: 'expired' })
        } else {
            console.error(`[TG-AUTH] Auth confirmation error for loginId ${loginId}:`, err)
            if (current) activeLogins.set(loginId, { ...current, status: 'error' })
        }
    })

    // Wait a bit for the QR code to be generated
    let retries = 0
    while (!activeLogins.has(loginId) && retries < 20) {
        await new Promise(resolve => setTimeout(resolve, 500))
        retries++
    }

    const loginData = activeLogins.get(loginId)
    if (!loginData) {
        console.error(`[TG-AUTH] Failed to generate QR code after ${retries} retries`)
        throw new Error('Failed to generate QR code')
    }

    return { loginId, qrUrl: loginData.qrUrl }
}

export async function submitTelegram2FAPassword(loginId: string, password: string) {
    console.log(`[TG-AUTH] Received 2FA password for loginId: ${loginId}`)
    const data = activeLogins.get(loginId)
    if (!data || !data.resolvePassword) {
        console.error(`[TG-AUTH] Login data or resolver not found for 2FA submission: ${loginId}`)
        return { success: false, error: 'Session expired or not waiting for password' }
    }

    try {
        console.log(`[TG-AUTH] Resolving password promise...`)
        data.resolvePassword(password)
        // Note: The status will be updated to 'success' by the background loginPromise.then()
        return { success: true }
    } catch (err: any) {
        console.error(`[TG-AUTH] Error resolving password:`, err)
        return { success: false, error: err.message || 'Internal error' }
    }
}

export async function checkTelegramAuthStatus(loginId: string, apiId: number, apiHash: string) {
    const data = activeLogins.get(loginId)
    console.log(`[TG-AUTH] Checking status for loginId: ${loginId}, Current status: ${data?.status}`)

    if (!data) return { status: 'expired' }

    if (data.status === 'success') {
        console.log(`[TG-AUTH] Login success detected for loginId: ${loginId}. Saving session...`)
        const sessionString = (data.client.session as StringSession).save()

        try {
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
                    apiId,
                    apiHash,
                    sessionString,
                    isActive: true,
                    phoneNumber,
                    isDefault,
                    name: me.firstName ? `${me.firstName} ${me.lastName || ''}`.trim() : `Account ${telegramId}`
                },
                update: {
                    apiId,
                    apiHash,
                    sessionString,
                    isActive: true,
                    phoneNumber
                    // Default and Name are not updated here intentionally so user preferences aren't overwritten
                }
            })
            console.log(`[TG-AUTH] Session saved to database successfully`)
            activeLogins.delete(loginId)
            revalidatePath('/telegram')
            return { status: 'success' }
        } catch (dbErr) {
            console.error(`[TG-AUTH] Database error saving session:`, dbErr)
            return { status: 'error' }
        }
    }

    // Double check if client somehow authorized but status didn't update
    if (data.client.connected && await data.client.isUserAuthorized()) {
        console.log(`[TG-AUTH] Client is authorized, but status was still: ${data.status}. Updating to success manually.`)
        activeLogins.set(loginId, { ...data, status: 'success' })
        // Next poll will pick it up and save to DB
    }

    return { status: data.status, qrUrl: data.qrUrl }
}

export async function getTelegramConnections() {
    return await (prisma as any).telegramConnection.findMany({
        where: { isActive: true },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }]
    })
}

export async function updateTelegramConnectionSettings(id: string, name: string, isDefault: boolean) {
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
    const connection = await (prisma as any).telegramConnection.findUnique({ where: { id } })
    
    await (prisma as any).telegramConnection.update({
        where: { id },
        data: { isActive: false, sessionString: null, isDefault: false }
    })

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
// instanceId per connection — links client to registry entry
const tgInstanceIds = new Map<string, string>()
// Idempotency guard: track which connections already have listeners attached
const initializedListeners = new Set<string>()
// Guard against concurrent initTelegramListeners calls
let _initPromise: Promise<void> | null = null

/** Get runtime status — delegates to TransportRegistry. */
export async function getTelegramRuntimeStatus() {
    return registry.getAllEntries().filter(e => e.channel === 'telegram')
}

import { DriverMatchService } from '@/lib/DriverMatchService'
import { ContactService } from '@/lib/ContactService'
import { emitMessageReceived } from '@/lib/messageEvents'

async function processInboundTelegramMessage(message: any, connectionId: string, loggerPrefix = 'TG-LISTENER') {
    if (message && !message.out) {
        const senderId = message.peerId?.userId?.toString() || message.fromId?.userId?.toString();
        const text = message.message
        if (!senderId || !text) return

        const externalChatId = `telegram:${senderId}`
        const externalMsgId = message.id?.toString()
        const now = message.date ? new Date(message.date * 1000) : new Date()

        console.log(`[${loggerPrefix}] INBOUND connId=${connectionId} senderId=${senderId} msgId=${externalMsgId} text="${text.substring(0, 30)}"`)

        // 1. Resolve or CREATE unified chat
        let unifiedChat = await (prisma.chat as any).findUnique({ where: { externalChatId } })
        let chatCreated = false

        if (!unifiedChat) {
            unifiedChat = await (prisma.chat as any).create({
                data: {
                    externalChatId,
                    channel: 'telegram',
                    name: `TG ${senderId}`,
                    lastMessageAt: now,
                    status: 'active'
                }
            })
            chatCreated = true
            console.log(`[${loggerPrefix}] AUTO-CREATED chat=${unifiedChat.id} for externalChatId=${externalChatId}`)
        } else {
            await (prisma.chat as any).update({
                where: { id: unifiedChat.id },
                data: { lastMessageAt: now }
            })
        }

        // 2. Relink driver if missing (on every inbound)
        if (!unifiedChat.driverId) {
            const linked = await DriverMatchService.linkChatToDriver(unifiedChat.id, { telegramId: senderId })
            if (linked) {
                unifiedChat = await (prisma.chat as any).findUnique({ where: { id: unifiedChat.id } })
                console.log(`[${loggerPrefix}] RELINKED chat=${unifiedChat.id} to driver=${unifiedChat.driverId}`)
            } else {
                console.log(`[${loggerPrefix}] chat=${unifiedChat.id} remains UNLINKED (no driver match)`)
            }
        }

        // ── Contact Model dual write ──────────────────────────────
        try {
            const contactResult = await ContactService.resolveContact(
                'telegram',
                senderId,
                null,  // TG GramJS не передаёт номер телефона
                message.sender?.firstName || message.sender?.username || null,
            )
            await ContactService.ensureChatLinked(
                unifiedChat.id,
                contactResult.contact.id,
                contactResult.identity.id,
            )
        } catch (contactErr: any) {
            console.error(`[${loggerPrefix}] ContactService error (non-blocking): ${contactErr.message}`)
        }
        // ──────────────────────────────────────────────────────────

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
        } else {
            const savedMsg = await (prisma.message as any).create({
                data: {
                    chatId: unifiedChat.id,
                    direction: 'inbound',
                    content: text,
                    channel: 'telegram',
                    type: 'text',
                    sentAt: now,
                    status: 'delivered',
                    externalId: externalMsgId
                }
            })
            console.log(`[${loggerPrefix}] SAVED inbound msgId=${externalMsgId} chat=${unifiedChat.id} driver=${unifiedChat.driverId || 'none'} newChat=${chatCreated}`)
            emitMessageReceived(savedMsg).catch(e =>
                console.error(`[${loggerPrefix}] emitMessageReceived error:`, e.message)
            )
        }
    }
}

async function catchUpMissedMessages(client: TelegramClient, connectionId: string) {
    try {
        console.log(`[TG-CATCHUP] Fetching recent dialogs for connectionId=${connectionId}`)
        const dialogs = await client.getDialogs({ limit: 15 })
        let processedCount = 0
        for (const dialog of dialogs) {
            if (dialog.unreadCount > 0 && dialog.isUser) {
                const messages = await client.getMessages(dialog.entity, { limit: Math.min(dialog.unreadCount, 15) })
                for (const msg of messages.reverse()) { // chronological order
                    await processInboundTelegramMessage(msg, connectionId, 'TG-CATCHUP')
                    processedCount++
                }
            }
        }
        console.log(`[TG-CATCHUP] Finished. Processed ${processedCount} unread messages.`)
    } catch (err: any) {
        console.error(`[TG-CATCHUP] Error: ${err.message}`)
    }
}

/**
 * Attaches the NewMessage listener to a client. Idempotent per connectionId.
 */
function attachInboundListener(client: TelegramClient, connectionId: string) {
    if (initializedListeners.has(connectionId)) {
        console.log(`[TG-LISTENER] Listener already attached for ${connectionId}, skipping.`)
        return
    }

    client.addEventHandler(async (event: any) => {
        try {
            await processInboundTelegramMessage(event.message, connectionId, 'TG-LISTENER')
        } catch (err: any) {
            console.error(`[TG-LISTENER] Error (conn=${connectionId}):`, err.message)
        }
    }, new NewMessage({}))

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
                registry.setReconnecting(conn.id, curInstanceId)
                registry.scheduleReconnect(conn.id, curInstanceId, async () => { await getTelegramClient(conn) })
            }
        }
    }, 60_000)
}

async function getTelegramClient(connection: any) {
    if (clientCache.has(connection.id)) {
        const cached = clientCache.get(connection.id)!
        if (cached.connected) {
            attachInboundListener(cached, connection.id)
            catchUpMissedMessages(cached, connection.id).catch(() => {})
            return cached
        }
        try {
            await cached.connect()
            attachInboundListener(cached, connection.id)
            catchUpMissedMessages(cached, connection.id).catch(() => {})
            return cached
        } catch (e) {
            console.warn(`[TG-CACHE] Failed to reconnect cached client ${connection.id}, creating new one.`)
            clientCache.delete(connection.id)
            initializedListeners.delete(connection.id)
        }
    }

    // Register in TransportRegistry
    registry.ensureEntry(connection.id, 'telegram')
    const instanceId = registry.beginNewInstance(connection.id)
    tgInstanceIds.set(connection.id, instanceId)

    const proxyHost = process.env.TG_PROXY_HOST
    const proxyPort = process.env.TG_PROXY_PORT ? parseInt(process.env.TG_PROXY_PORT, 10) : undefined
    const proxyConfig = proxyHost && proxyPort
        ? { ip: proxyHost, port: proxyPort, socksType: 5 as const }
        : undefined

    const client = new TelegramClient(
        new StringSession(connection.sessionString),
        connection.apiId,
        connection.apiHash,
        {
            connectionRetries: 5,
            ...(proxyConfig ? { proxy: proxyConfig } : {}),
        }
    )

    if (proxyConfig) {
        console.log(`[TG-CLIENT] Using SOCKS5 proxy ${proxyHost}:${proxyPort}`)
    }

    await client.connect()
    registry.setReady(connection.id, instanceId)

    attachInboundListener(client, connection.id)
    catchUpMissedMessages(client, connection.id).catch(() => {})

    clientCache.set(connection.id, client)
    return client
}

export async function sendTelegramMessage(phoneNumber: string, message: string, connectionId?: string, metadata?: { messageId?: string, chatId?: string, driverId?: string }) {
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
        // Normalize target: if it's a mobile number, ensure it has '+'
        let target: any = phoneNumber
        // Only prefix with '+' if it's a long digit string (phone number)
        if (typeof target === 'string' && target.match(/^\d+$/) && target.length >= 10 && !target.startsWith('+')) {
            target = '+' + target
        }
        
        console.log(`[TG-SEND] Target normalized to: ${target}`)

        // Telethon/GramJS: Best to resolve entity first if it's not in cache
        let entity;
        try {
            console.log(`[TG-SEND] Resolving entity for ${target}...`)
            // If it's a numeric ID (no plus, just digits), try resolving as number
            if (typeof target === 'string' && target.match(/^\d+$/) && !target.startsWith('+')) {
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
        
        // Add a safety timeout for the actual sending
        const result = await Promise.race([
            client.sendMessage(entity || target, { message }),
            new Promise<any>((_, reject) => setTimeout(() => reject(new Error('Telegram sendMessage timeout (25s)')), 25000))
        ])
        
        console.log(`[TG-SEND] Message delivery SUCCESS`)
        const sendInstanceId = tgInstanceIds.get(connection?.id)
        if (connection && sendInstanceId) registry.touch(connection.id, sendInstanceId)

        // SYNC TO UNIFIED MESSAGE TABLE
        try {
            const tgId = entity?.id?.toString() || (typeof entity === 'string' ? entity : null)
            if (tgId) {
                const externalChatId = `telegram:${tgId}`
                
                // 1. Check if we already have this chat via its ID
                let unifiedChat = await (prisma.chat as any).findUnique({ where: { externalChatId } })
                
                // 2. If not found, check if we were passed an original chatId (migrating from phone -> ID)
                if (!unifiedChat && metadata?.chatId) {
                     unifiedChat = await (prisma.chat as any).findUnique({ where: { id: metadata.chatId } })
                     if (unifiedChat) {
                         console.log(`[TG-SEND] Migrating chat ${unifiedChat.id} from ${unifiedChat.externalChatId} to ${externalChatId}`)
                         unifiedChat = await (prisma.chat as any).update({
                             where: { id: unifiedChat.id },
                             data: { externalChatId, lastMessageAt: new Date() }
                         })
                     }
                }

                // 3. Create if still not found
                if (!unifiedChat) {
                    unifiedChat = await (prisma.chat as any).create({
                        data: {
                            id: `chat_tg_${tgId}`,
                            externalChatId,
                            channel: 'telegram',
                            name: `TG ${tgId}`,
                            driverId: metadata?.driverId || null,
                            lastMessageAt: new Date()
                        }
                    })
                } else {
                    await (prisma.chat as any).update({
                        where: { id: unifiedChat.id },
                        data: { lastMessageAt: new Date(), driverId: unifiedChat.driverId || metadata?.driverId }
                    })
                }

                // 4. Update DriverTelegram link if possible
                if (metadata?.driverId) {
                    await (prisma as any).driverTelegram.upsert({
                        where: { telegramId: BigInt(tgId) },
                        create: { telegramId: BigInt(tgId), driverId: metadata.driverId, phoneVerified: true },
                        update: { driverId: metadata.driverId }
                    })
                }

                // DE-DUPLICATION: Check for existing optimistic message
                const externalId = result?.id?.toString()
                console.log(`[TG-SEND] Attempting de-duplication for messageId=${metadata?.messageId}, content_len=${message.length}`)
                
                let existing = null;
                if (metadata?.messageId) {
                    console.log(`[TG-SEND] Searching by explicit messageId: ${metadata.messageId}`)
                    existing = await (prisma.message as any).findUnique({ where: { id: metadata.messageId } })
                }
                
                if (!existing) {
                    console.log(`[TG-SEND] Not found by ID, searching by content/chat/time...`)
                    existing = await (prisma.message as any).findFirst({
                        where: {
                            chatId: metadata?.chatId || unifiedChat.id,
                            content: message,
                            direction: 'outbound',
                            sentAt: {
                                gte: new Date(Date.now() - 30000),
                                lte: new Date(Date.now() + 30000)
                            }
                        }
                    })
                }

                if (existing) {
                    console.log(`[TG-SEND] Found existing message ${existing.id}, updating status to delivered...`)
                    await (prisma.message as any).update({
                        where: { id: existing.id },
                        data: { 
                            externalId,
                            status: 'delivered',
                            sentAt: existing.sentAt
                        }
                    })
                    console.log(`[TG-SEND] Update SUCCESS`)
                } else {
                    console.log(`[TG-SEND] No existing message found, creating new record...`)
                    await (prisma.message as any).create({
                        data: {
                            chatId: unifiedChat.id,
                            direction: 'outbound',
                            content: message,
                            channel: 'telegram',
                            type: 'text',
                            sentAt: new Date(),
                            status: 'delivered',
                            externalId
                        }
                    })
                    console.log(`[TG-SEND] Create SUCCESS`)
                }
                return { success: true, externalId: result?.id?.toString() }
            }
        } catch (syncErr: any) {
            console.error(`[TG-SEND] Failed to sync message to unified table:`, syncErr.message)
        }

        return { success: true, externalId: (result as any)?.id?.toString() }
    } catch (err: any) {
        console.error('[TG-SEND] SEND ERROR:', err)
        throw new Error(`Telegram delivery failed: ${err.message}`)
    } finally {
        // We no longer disconnect here to keep the session alive in cache
        console.log(`[TG-SEND] End of call (client left active in cache)`)
    }
}

// Stubs: functions removed but still imported in settings/ai/actions.ts and TelegramLoginClient.tsx
export async function importTelegramHistory(
    jobId: string, mode: string, daysBack?: number, connectionId?: string
) {
    console.warn('[TG] importTelegramHistory is not implemented')
}

export async function pauseTelegramConnection(id: string, _deleteMessages?: boolean) {
    console.warn('[TG] pauseTelegramConnection is not implemented')
}

export async function resumeTelegramConnection(id: string, _catchUp?: boolean) {
    console.warn('[TG] resumeTelegramConnection is not implemented')
}

export async function deleteConnectionMessages(id: string) {
    console.warn('[TG] deleteConnectionMessages is not implemented')
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
    connectionId?: string
): Promise<{ reachable: boolean; telegramId?: string; error?: string }> {
    const TIMEOUT_MS = 10_000

    // Wrap EVERYTHING (including getTelegramClient which can hang on connect())
    // in a single timeout. On timeout returns { reachable: true } — soft fallback,
    // meaning "don't show a warning", NOT "confirmed reachable".
    const result = await Promise.race([
        doCheck(phone, connectionId),
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
    connectionId?: string
): Promise<{ reachable: boolean; telegramId?: string; error?: string }> {
    try {
        // Find connection (same logic as sendTelegramMessage)
        let connection
        if (connectionId) {
            connection = await (prisma as any).telegramConnection.findUnique({
                where: { id: connectionId, isActive: true }
            })
        } else {
            connection = await (prisma as any).telegramConnection.findFirst({
                where: { isActive: true, isDefault: true }
            })
            if (!connection) {
                connection = await (prisma as any).telegramConnection.findFirst({
                    where: { isActive: true }
                })
            }
        }

        if (!connection || !connection.sessionString) {
            return { reachable: true }
        }

        const client = await getTelegramClient(connection)

        // Normalize: prefix '+' for digit strings >= 10 chars
        let target: string = phone
        if (target.match(/^\d+$/) && target.length >= 10) {
            target = '+' + target
        }

        return await resolveEntity(client, target)
    } catch (err: any) {
        console.error(`[TG-CHECK] Error for ${phone}: ${err.message}`)
        return { reachable: true }
    }
}

/** Resolve phone to Telegram entity without sending a message. */
async function resolveEntity(
    client: TelegramClient,
    target: string
): Promise<{ reachable: boolean; telegramId?: string; error?: string }> {
    // Step 1: Try getEntity
    try {
        const entity = await client.getEntity(target)
        return { reachable: true, telegramId: entity.id.toString() }
    } catch {
        // Fall through to ImportContacts
    }

    // Step 2: Try ImportContacts (only for phone numbers starting with '+')
    if (!target.startsWith('+')) {
        return { reachable: false, error: 'Номер не найден в Telegram' }
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
            return { reachable: true, telegramId: result.users[0].id.toString() }
        }
    } catch {
        // Import failed — number not on Telegram
    }

    return { reachable: false, error: 'Номер не найден в Telegram' }
}
