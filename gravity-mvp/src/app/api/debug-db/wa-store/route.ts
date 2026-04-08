import { NextRequest, NextResponse } from 'next/server'
import { getClient } from '@/lib/whatsapp/WhatsAppService'

export async function GET(req: NextRequest) {
    const connId = req.nextUrl.searchParams.get('connId')
    const chatId = req.nextUrl.searchParams.get('chatId')
    const limit = parseInt(req.nextUrl.searchParams.get('limit') || '10')

    if (!connId) return NextResponse.json({ error: 'connId required' })

    const client = getClient(connId)
    if (!client) return NextResponse.json({ error: 'Client not in memory' })

    const page = (client as any).pupPage
    if (!page) return NextResponse.json({ error: 'No Puppeteer page' })

    try {
        // Test 1: Check what Store modules are available
        const storeInfo = await page.evaluate(() => {
            const store = (window as any).Store
            if (!store) return { error: 'Store not found' }
            return {
                hasMsg: !!store.Msg,
                hasMsgFind: typeof store.Msg?.find === 'function',
                hasMsgGetMessages: typeof store.Msg?.getMessages === 'function',
                hasChat: !!store.Chat,
                hasChatFind: typeof store.Chat?.find === 'function',
                hasChatGet: typeof store.Chat?.get === 'function',
                chatModelKeys: store.Chat ? Object.keys(store.Chat).filter((k: string) => typeof store.Chat[k] === 'function').slice(0, 20) : [],
                msgModelKeys: store.Msg ? Object.keys(store.Msg).filter((k: string) => typeof store.Msg[k] === 'function').slice(0, 20) : [],
            }
        })

        if (!chatId) {
            // Test 2: List a few chats from Store directly
            const chats = await page.evaluate(() => {
                const store = (window as any).Store
                if (!store?.Chat) return []
                const models = store.Chat.getModelsArray ? store.Chat.getModelsArray() : (store.Chat._models || [])
                return models.slice(0, 5).map((c: any) => ({
                    id: c.id?._serialized || c.id?.toString(),
                    name: c.name || c.formattedTitle || c.contact?.pushname,
                    isGroup: c.isGroup,
                    hasLid: c.id?._serialized?.includes('@lid'),
                    msgCount: c.msgs?.length || 0,
                }))
            })
            return NextResponse.json({ storeInfo, sampleChats: chats })
        }

        // Test 3: Try to load messages for a specific @lid chat via Store directly
        const messages = await page.evaluate(async (targetChatId: string, msgLimit: number) => {
            const store = (window as any).Store
            if (!store?.Chat || !store?.Msg) return { error: 'Store not ready' }

            // Find the chat
            const chat = store.Chat.get(targetChatId) || store.Chat.find(targetChatId)
            if (!chat) return { error: `Chat ${targetChatId} not found in Store` }

            // Try multiple approaches to load messages
            const results: any = { chatFound: true, chatId: targetChatId, approaches: [] }

            // Approach 1: chat.msgs (already loaded)
            if (chat.msgs && chat.msgs.length > 0) {
                const msgs = chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : Array.from(chat.msgs)
                results.approaches.push({
                    method: 'chat.msgs',
                    count: msgs.length,
                    sample: msgs.slice(0, 3).map((m: any) => ({
                        id: m.id?._serialized,
                        body: (m.body || '').substring(0, 40),
                        timestamp: m.t,
                        fromMe: m.id?.fromMe,
                    }))
                })
            }

            // Approach 2: loadEarlierMsgs
            if (typeof chat.loadEarlierMsgs === 'function') {
                try {
                    const earlier = await chat.loadEarlierMsgs()
                    results.approaches.push({
                        method: 'loadEarlierMsgs',
                        count: earlier?.length || 0,
                        sample: (earlier || []).slice(0, 3).map((m: any) => ({
                            id: m.id?._serialized,
                            body: (m.body || '').substring(0, 40),
                            timestamp: m.t,
                        }))
                    })
                } catch (e: any) {
                    results.approaches.push({ method: 'loadEarlierMsgs', error: e.message })
                }
            }

            // Approach 3: Msg.find with chat wid
            try {
                const chatMsgs = store.Msg.filter ?
                    store.Msg.filter((m: any) => m.id?.remote?._serialized === targetChatId).slice(0, msgLimit) :
                    []
                results.approaches.push({
                    method: 'Msg.filter',
                    count: chatMsgs.length,
                    sample: chatMsgs.slice(0, 3).map((m: any) => ({
                        id: m.id?._serialized,
                        body: (m.body || '').substring(0, 40),
                        timestamp: m.t,
                    }))
                })
            } catch (e: any) {
                results.approaches.push({ method: 'Msg.filter', error: e.message })
            }

            return results
        }, chatId, limit)

        return NextResponse.json({ storeInfo, messages })
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 })
    }
}
