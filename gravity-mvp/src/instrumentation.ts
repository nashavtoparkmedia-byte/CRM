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
        console.log('[INSTRUMENTATION] Server starting, scheduling Telegram listener init...')
        
        // Delay initialization slightly to let the DB connection pool warm up
        setTimeout(async () => {
            try {
                const { initTelegramListeners } = await import('@/app/tg-actions')
                await initTelegramListeners()
                console.log('[INSTRUMENTATION] Telegram listeners initialized successfully')
            } catch (err: any) {
                console.error('[INSTRUMENTATION] Failed to init Telegram listeners:', err.message)
            }
        }, 5000) // 5 second delay after server start
    }
}
