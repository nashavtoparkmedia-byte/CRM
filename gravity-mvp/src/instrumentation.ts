/**
 * Next.js Instrumentation Hook
 * 
 * This file is automatically loaded by Next.js on server startup.
 * Used to initialize Telegram GramJS listeners so inbound messages
 * are received even before any outbound message is sent.
 * 
 * See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
    // Only run on the server (not edge runtime)
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        console.log('[INSTRUMENTATION] Server starting, scheduling transport init...')

        // Delay initialization slightly to let the DB connection pool warm up
        setTimeout(async () => {
            // Telegram init
            try {
                const { initTelegramListeners } = await import('@/app/tg-actions')
                await initTelegramListeners()
                console.log('[INSTRUMENTATION] Telegram listeners initialized successfully')
            } catch (err: any) {
                console.error('[INSTRUMENTATION] Failed to init Telegram listeners:', err.message)
            }

            // WhatsApp warmup: initialize clients for all 'ready' connections
            try {
                const { prisma } = await import('@/lib/prisma')
                const { initializeClient } = await import('@/lib/whatsapp/WhatsAppService')
                const readyConns = await prisma.whatsAppConnection.findMany({
                    where: { status: { in: ['ready', 'authenticated'] } },
                    select: { id: true, name: true },
                })
                console.log(`[INSTRUMENTATION] WhatsApp warmup: ${readyConns.length} ready connections`)
                for (const conn of readyConns) {
                    initializeClient(conn.id).then(() => {
                        console.log(`[WA-TRANSPORT] warmup_success connId=${conn.id} name=${conn.name}`)
                    }).catch((err: any) => {
                        console.error(`[WA-TRANSPORT] warmup_failed connId=${conn.id} error=${err.message}`)
                    })
                }
            } catch (err: any) {
                console.error('[INSTRUMENTATION] Failed to warmup WhatsApp:', err.message)
            }
            // Message pipeline: recover stuck messages from previous lifecycle
            try {
                const { MessageService } = await import('@/lib/MessageService')
                const recovered = await MessageService.recoverStuckMessages(5)
                if (recovered > 0) {
                    console.log(`[INSTRUMENTATION] Recovered ${recovered} stuck messages`)
                }
            } catch (err: any) {
                console.error('[INSTRUMENTATION] Failed to recover stuck messages:', err.message)
            }
        }, 5000) // 5 second delay after server start
    }
}
