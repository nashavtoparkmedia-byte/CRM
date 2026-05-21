/**
 * AI Knowledge Core — pair builder.
 *
 * Группирует Message в пары "inbound клиент → outbound менеджер" с
 * 60-минутным окном. Окно 60 минут — компромисс: больше захватит
 * хвосты долгих диалогов, меньше — потеряет ответы через 10-20 минут.
 *
 * Что отфильтровывается:
 *   - direction='system' (служебные)
 *   - type='system' / 'call' (звонки не дают текстового знания)
 *   - aiStatus='done' на outbound — это голос AI, не менеджера
 *   - пустой/обрезанный content
 *
 * Возвращает плоский массив пар — Extractor разбивает их на батчи
 * независимо от структуры чатов.
 */

import { prisma } from '@/lib/prisma'

export type ExtractionScopeMode = 'last_30d' | 'last_90d' | 'all' | 'custom'

export interface ExtractionScope {
    mode:      ExtractionScopeMode
    dateFrom?: string | Date | null
    dateTo?:   string | Date | null
    channels?: string[] | null
    /** PR7.3: source-selector. Когда передан — UI выбрал конкретные
     *  WhatsApp / Telegram / MAX connection'ы для сбора. Filter на
     *  message-level выполняется через channel-specific join'ы
     *  (Message.chatId → channel-table → connectionId). Если массив
     *  пуст или undefined — выборка из всех ready connections данного
     *  channel'а (existing behaviour). Сохраняется в AiExtractionJob
     *  .scope для transparency (PR4 explainability покажет
     *  "из каких аккаунтов собирали"). */
    connectionIds?:    string[] | null
    /** PR7.3: если true — pairBuilder/scope ограничивает выборку
     *  только теми connection'ами, status которых сейчас 'ready'
     *  (WhatsApp) или isActive=true (TG/MAX). Использовать когда
     *  тестовые/отключённые аккаунты не должны влиять на ядро. */
    onlyConnectedNow?: boolean
    /** Защитный потолок числа пар. Default 5000. */
    maxPairs?: number
}

export interface PromptPair {
    chatId:           string
    channel:          string | null
    clientMessageId:  string
    managerMessageId: string
    clientText:       string
    managerText:      string
    clientAt:         Date
    managerAt:        Date
    managerUserId:    string | null
}

interface RawMessage {
    id:        string
    chatId:    string
    channel:   string | null
    direction: string
    type:      string | null
    content:   string | null
    sentAt:    Date
    aiStatus:  string | null
}

const DEFAULT_MAX_PAIRS = 5000
const PAIR_WINDOW_MS = 60 * 60 * 1000

function resolveDateRange(scope: ExtractionScope): { from: Date | null; to: Date | null } {
    const now = new Date()
    if (scope.mode === 'last_30d') {
        return { from: new Date(now.getTime() - 30 * 24 * 3600 * 1000), to: null }
    }
    if (scope.mode === 'last_90d') {
        return { from: new Date(now.getTime() - 90 * 24 * 3600 * 1000), to: null }
    }
    if (scope.mode === 'all') {
        return { from: null, to: null }
    }
    const f = scope.dateFrom ? new Date(scope.dateFrom) : null
    const t = scope.dateTo ? new Date(scope.dateTo) : null
    return { from: f, to: t }
}

async function loadCandidateMessages(scope: ExtractionScope): Promise<RawMessage[]> {
    const { from, to } = resolveDateRange(scope)
    const channels = scope.channels && scope.channels.length > 0
        ? scope.channels
        : ['max', 'telegram', 'whatsapp']

    // PR7.3b: source-selector filter execution.
    //
    // Когда scope.connectionIds непустой — UI выбрал конкретные
    // WhatsApp/Telegram/MAX подключения. Filter работает asymmetрично
    // в рамках existing schema:
    //
    //   - WhatsApp: REAL filter через JOIN Chat → WhatsAppChat.connectionId.
    //     Message только из чатов выбранных WA-подключений попадают
    //     в выборку.
    //
    //   - Telegram / MAX: на текущей schema НЕТ chat-уровневого
    //     mapping'а message → connection (только WhatsAppChat имеет
    //     connectionId). Поэтому filter best-effort:
    //     если в scope.connectionIds есть TG/MAX id — включаем ВСЕ
    //     TG/MAX messages выбранного channel'а целиком. Транспарентно
    //     для пользователя через UI footnote.
    //
    // Без connectionIds (null или []) — existing behaviour: выборка
    // только по channels filter, как было до PR7.
    const hasConnectionFilter = !!scope.connectionIds && scope.connectionIds.length > 0
    const connectionIds = scope.connectionIds ?? []

    if (!hasConnectionFilter) {
        // Fast path: no extra JOIN.
        return await prisma.$queryRaw<RawMessage[]>`
            SELECT
                id,
                "chatId",
                channel::text                 AS channel,
                direction::text               AS direction,
                type::text                    AS type,
                content,
                "sentAt",
                "aiStatus"::text              AS "aiStatus"
            FROM "Message"
            WHERE direction IN ('inbound', 'outbound')
              AND type NOT IN ('system', 'call')
              AND content IS NOT NULL
              AND length(content) > 1
              AND channel::text = ANY(${channels})
              AND (${from}::timestamp IS NULL OR "sentAt" >= ${from})
              AND (${to}::timestamp   IS NULL OR "sentAt" <= ${to})
            ORDER BY "chatId" ASC, "sentAt" ASC
        `
    }

    // Connection-filtered path: WA real-filter via JOIN, TG/MAX include-all.
    return await prisma.$queryRaw<RawMessage[]>`
        SELECT
            m.id,
            m."chatId",
            m.channel::text                 AS channel,
            m.direction::text               AS direction,
            m.type::text                    AS type,
            m.content,
            m."sentAt",
            m."aiStatus"::text              AS "aiStatus"
        FROM "Message" m
        LEFT JOIN "Chat" c           ON c.id = m."chatId"
        LEFT JOIN "WhatsAppChat" wc  ON wc.id = c."externalChatId"
        WHERE m.direction IN ('inbound', 'outbound')
          AND m.type NOT IN ('system', 'call')
          AND m.content IS NOT NULL
          AND length(m.content) > 1
          AND m.channel::text = ANY(${channels})
          AND (${from}::timestamp IS NULL OR m."sentAt" >= ${from})
          AND (${to}::timestamp   IS NULL OR m."sentAt" <= ${to})
          AND (
              -- WA: only messages from chats of selected WA-connections.
              (m.channel::text = 'whatsapp' AND wc."connectionId" = ANY(${connectionIds}))
              -- TG/MAX: schema doesn't store connection at chat level,
              -- so include all messages of these channels when channel
              -- is in scope.channels. UI must communicate this caveat.
              OR m.channel::text IN ('telegram', 'max')
          )
        ORDER BY m."chatId" ASC, m."sentAt" ASC
    `
}

/**
 * Собирает пары для одного чата. Стратегия "nearest forward outbound":
 * для каждого inbound берём ближайший по времени outbound в окне
 * 60 минут, который не от AI (aiStatus != 'done') и не системный.
 */
function buildPairsForChat(chatMsgs: RawMessage[]): PromptPair[] {
    const pairs: PromptPair[] = []
    for (let i = 0; i < chatMsgs.length; i++) {
        const m = chatMsgs[i]
        if (m.direction !== 'inbound') continue
        if (!m.content || m.content.trim().length < 2) continue

        const windowEnd = m.sentAt.getTime() + PAIR_WINDOW_MS
        let mgr: RawMessage | null = null
        for (let j = i + 1; j < chatMsgs.length; j++) {
            const n = chatMsgs[j]
            if (n.sentAt.getTime() > windowEnd) break
            if (n.direction !== 'outbound') continue
            if (n.aiStatus === 'done') continue
            if (!n.content || n.content.trim().length < 2) continue
            mgr = n
            break
        }
        if (!mgr) continue

        pairs.push({
            chatId:           m.chatId,
            channel:          m.channel,
            clientMessageId:  m.id,
            managerMessageId: mgr.id,
            clientText:       m.content!,
            managerText:      mgr.content!,
            clientAt:         m.sentAt,
            managerAt:        mgr.sentAt,
            managerUserId:    null,
        })
    }
    return pairs
}

/**
 * Главный entry: возвращает все пары inbound→outbound по scope, плоско.
 */
export async function buildPairs(scope: ExtractionScope): Promise<{
    pairs: PromptPair[]
    messagesScanned: number
    chatsScanned: number
}> {
    const messages = await loadCandidateMessages(scope)
    if (messages.length === 0) {
        return { pairs: [], messagesScanned: 0, chatsScanned: 0 }
    }

    const byChat = new Map<string, RawMessage[]>()
    for (const m of messages) {
        let arr = byChat.get(m.chatId)
        if (!arr) { arr = []; byChat.set(m.chatId, arr) }
        arr.push(m)
    }

    const allPairs: PromptPair[] = []
    const limit = scope.maxPairs ?? DEFAULT_MAX_PAIRS
    for (const chatMsgs of byChat.values()) {
        for (const p of buildPairsForChat(chatMsgs)) {
            allPairs.push(p)
            if (allPairs.length >= limit) {
                return {
                    pairs: allPairs,
                    messagesScanned: messages.length,
                    chatsScanned: byChat.size,
                }
            }
        }
    }
    return {
        pairs: allPairs,
        messagesScanned: messages.length,
        chatsScanned: byChat.size,
    }
}
