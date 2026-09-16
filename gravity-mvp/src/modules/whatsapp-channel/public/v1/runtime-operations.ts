import { cleanupStaleWhatsAppSessions } from '@/lib/whatsapp/WhatsAppCleanup'
import {
  checkAllClientsHealth,
  checkReachability,
  destroyAllClients,
  forceSync,
  getClient,
  getRuntimeStatus,
  importWhatsAppHistory,
  initializeClient,
} from '@/lib/whatsapp/WhatsAppService'

export type WhatsAppRuntimeCleanupResultV1 = {
  killedChromeCount: number
  removedLockCount: number
}

export type WhatsAppRuntimeHealthResultV1 = {
  checkedCount: number
  unhealthyCount: number
  details: Array<{ connectionId: string; healthy: boolean; reason?: string }>
}

export type WhatsAppReachabilityResultV1 = {
  reachable: boolean | null
  confirmed?: boolean
  retryable?: boolean
  error?: string
  reason?: string
  providerAccountId?: string
  providerTargetId?: string
}

export type WhatsAppRuntimeEntryV1 = {
  connectionId: string
  channel: 'whatsapp'
  instanceId: string | null
  state: 'initializing' | 'ready' | 'reconnecting' | 'failed' | 'stopped'
  lastSeen: Date | null
  lastError: string | null
  retryAttempt: number
  startedAt: Date
  readyAt: Date | null
  reconnectInFlight: boolean
  degradedAt: Date | null
}

export type WhatsAppRuntimeConnectionV1 = {
  present: boolean
  providerUserId: string | null
}

type StoreInfoV1 = {
  error?: string
  hasMsg?: boolean
  hasMsgFind?: boolean
  hasMsgGetMessages?: boolean
  hasChat?: boolean
  hasChatFind?: boolean
  hasChatGet?: boolean
  chatModelKeys?: string[]
  msgModelKeys?: string[]
}

type StoreSampleChatV1 = {
  id?: string
  name?: string
  isGroup?: boolean
  hasLid?: boolean
  msgCount: number
}

type StoreMessageSampleV1 = {
  id?: string
  body: string
  timestamp?: number
  fromMe?: boolean
}

type StoreMessageApproachV1 = {
  method: 'chat.msgs' | 'loadEarlierMsgs' | 'Msg.filter'
  count?: number
  sample?: StoreMessageSampleV1[]
  error?: string
}

type StoreMessagesV1 = {
  error?: string
  chatFound?: boolean
  chatId?: string
  approaches?: StoreMessageApproachV1[]
}

export type WhatsAppStoreInspectionV1 = {
  error?: string
  storeInfo?: StoreInfoV1
  sampleChats?: StoreSampleChatV1[]
  messages?: StoreMessagesV1
}

export function cleanupStaleWhatsAppRuntimeV1(): Promise<WhatsAppRuntimeCleanupResultV1> {
  return cleanupStaleWhatsAppSessions()
}

export function initializeWhatsAppRuntimeV1(connectionId: string): Promise<void> {
  return initializeClient(connectionId)
}

export function checkWhatsAppRuntimeHealthV1(): Promise<WhatsAppRuntimeHealthResultV1> {
  return checkAllClientsHealth()
}

export function destroyWhatsAppRuntimeV1(): Promise<void> {
  return destroyAllClients()
}

export function forceSyncWhatsAppRuntimeV1(connectionId: string): Promise<void> {
  return forceSync(connectionId)
}

export function checkWhatsAppReachabilityV1(
  phone: string,
  connectionId?: string,
): Promise<WhatsAppReachabilityResultV1> {
  return checkReachability(phone, connectionId)
}

export function importWhatsAppHistoryV1(
  jobId: string,
  mode: string,
  daysBack?: number,
  connectionId?: string,
): Promise<void> {
  return importWhatsAppHistory(jobId, mode, daysBack, connectionId)
}

export function listWhatsAppRuntimeEntriesV1(): WhatsAppRuntimeEntryV1[] {
  return getRuntimeStatus().map((entry) => ({
    connectionId: entry.connectionId,
    channel: 'whatsapp',
    instanceId: entry.instanceId,
    state: entry.state,
    lastSeen: entry.lastSeen,
    lastError: entry.lastError,
    retryAttempt: entry.retryAttempt,
    startedAt: entry.startedAt,
    readyAt: entry.readyAt,
    reconnectInFlight: entry.reconnectInFlight,
    degradedAt: entry.degradedAt,
  }))
}

export function readWhatsAppRuntimeConnectionV1(connectionId: string): WhatsAppRuntimeConnectionV1 {
  const client = getClient(connectionId)
  return {
    present: client !== undefined,
    providerUserId: (client as any)?.user?.id ?? null,
  }
}

/**
 * Owner-local provider diagnostic. The Puppeteer page and WhatsApp Store never
 * leave this capability; callers receive a fixed JSON projection only.
 */
export async function inspectWhatsAppStoreV1(
  connectionId: string,
  chatId?: string,
  limit = 10,
): Promise<WhatsAppStoreInspectionV1> {
  const client = getClient(connectionId)
  if (!client) return { error: 'Client not in memory' }

  const page = (client as any).pupPage
  if (!page) return { error: 'No Puppeteer page' }

  const storeInfo: StoreInfoV1 = await page.evaluate(() => {
    const store = (window as any).Store
    if (!store) return { error: 'Store not found' }
    return {
      hasMsg: !!store.Msg,
      hasMsgFind: typeof store.Msg?.find === 'function',
      hasMsgGetMessages: typeof store.Msg?.getMessages === 'function',
      hasChat: !!store.Chat,
      hasChatFind: typeof store.Chat?.find === 'function',
      hasChatGet: typeof store.Chat?.get === 'function',
      chatModelKeys: store.Chat
        ? Object.keys(store.Chat).filter((key) => typeof store.Chat[key] === 'function').slice(0, 20)
        : [],
      msgModelKeys: store.Msg
        ? Object.keys(store.Msg).filter((key) => typeof store.Msg[key] === 'function').slice(0, 20)
        : [],
    }
  })

  if (!chatId) {
    const sampleChats: StoreSampleChatV1[] = await page.evaluate(() => {
      const store = (window as any).Store
      if (!store?.Chat) return []
      const models = store.Chat.getModelsArray ? store.Chat.getModelsArray() : (store.Chat._models || [])
      return models.slice(0, 5).map((chat: any) => ({
        id: chat.id?._serialized || chat.id?.toString(),
        name: chat.name || chat.formattedTitle || chat.contact?.pushname,
        isGroup: chat.isGroup,
        hasLid: chat.id?._serialized?.includes('@lid'),
        msgCount: chat.msgs?.length || 0,
      }))
    })
    return { storeInfo, sampleChats }
  }

  const messages: StoreMessagesV1 = await page.evaluate(async (targetChatId: string, msgLimit: number) => {
    const store = (window as any).Store
    if (!store?.Chat || !store?.Msg) return { error: 'Store not ready' }

    const chat = store.Chat.get(targetChatId) || store.Chat.find(targetChatId)
    if (!chat) return { error: `Chat ${targetChatId} not found in Store` }

    const result: StoreMessagesV1 = { chatFound: true, chatId: targetChatId, approaches: [] }
    if (chat.msgs && chat.msgs.length > 0) {
      const chatMessages = chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : Array.from(chat.msgs)
      result.approaches!.push({
        method: 'chat.msgs',
        count: chatMessages.length,
        sample: chatMessages.slice(0, 3).map((message: any) => ({
          id: message.id?._serialized,
          body: (message.body || '').substring(0, 40),
          timestamp: message.t,
          fromMe: message.id?.fromMe,
        })),
      })
    }

    if (typeof chat.loadEarlierMsgs === 'function') {
      try {
        const earlier = await chat.loadEarlierMsgs()
        result.approaches!.push({
          method: 'loadEarlierMsgs',
          count: earlier?.length || 0,
          sample: (earlier || []).slice(0, 3).map((message: any) => ({
            id: message.id?._serialized,
            body: (message.body || '').substring(0, 40),
            timestamp: message.t,
          })),
        })
      } catch (error: any) {
        result.approaches!.push({ method: 'loadEarlierMsgs', error: error.message })
      }
    }

    try {
      const chatMessages = store.Msg.filter
        ? store.Msg.filter((message: any) => message.id?.remote?._serialized === targetChatId).slice(0, msgLimit)
        : []
      result.approaches!.push({
        method: 'Msg.filter',
        count: chatMessages.length,
        sample: chatMessages.slice(0, 3).map((message: any) => ({
          id: message.id?._serialized,
          body: (message.body || '').substring(0, 40),
          timestamp: message.t,
        })),
      })
    } catch (error: any) {
      result.approaches!.push({ method: 'Msg.filter', error: error.message })
    }

    return result
  }, chatId, limit)

  return { storeInfo, messages }
}
