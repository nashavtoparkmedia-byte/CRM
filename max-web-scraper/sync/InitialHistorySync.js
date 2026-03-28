'use strict'

const fs   = require('fs')
const path = require('path')

const { ENDPOINTS } = require('../transport/TransportInterceptor')
const { MessageParser } = require('../parser/MessageParser')

// Флаг-файл: если существует — initial sync уже был выполнен
const DONE_FLAG = path.join(__dirname, '..', '.initial_sync_done')

// Режимы истории (результат Фазы 0.1)
const HISTORY_MODE = {
  FULL_BACKFILL:     'full_backfill',
  PARTIAL_BACKFILL:  'partial_backfill',
  LIVE_ONLY:         'live_only',
}

// Максимум страниц пагинации — защита от бесконечного цикла
const MAX_PAGES = 500

class InitialHistorySync {
  /**
   * @param {object} page - Playwright page
   * @param {object} messageSync - MessageSync instance
   * @param {Function} forwardFn - async (payload) => void  — отправка в CRM webhook
   */
  constructor(page, messageSync, forwardFn) {
    this._page       = page
    this._sync       = messageSync
    this._forward    = forwardFn
  }

  // ─── Запуск ─────────────────────────────────────────────────────────────

  /**
   * Запускается после QR-логина.
   * historyImportMode — выбор пользователя из UI:
   *   'none'                — не импортировать
   *   'from_connection_time' — только новые с момента подключения (watermark = now)
   *   'available_history'   — загрузить доступную историю
   */
  async runIfNeeded(historyImportMode = 'from_connection_time') {
    if (historyImportMode === 'none') {
      console.log('[InitialSync] Режим: none — история не импортируется')
      this._markDone('none')
      return { mode: 'none', status: 'skipped' }
    }

    if (historyImportMode === 'from_connection_time') {
      console.log('[InitialSync] Режим: from_connection_time — стартуем с текущего момента')
      this._markDone('from_connection_time')
      return { mode: 'from_connection_time', status: 'skipped' }
    }

    if (fs.existsSync(DONE_FLAG)) {
      console.log('[InitialSync] Уже выполнен (флаг существует), пропускаем')
      return { mode: 'already_done', status: 'skipped' }
    }

    // available_history — определяем что реально может транспорт
    console.log('[InitialSync] Режим: available_history — определяем capability...')
    const capability = await this._detectCapability()
    console.log(`[InitialSync] Capability: ${capability.mode}`)

    let status = 'completed'

    try {
      if (capability.mode === HISTORY_MODE.FULL_BACKFILL) {
        await this._syncAllChatsFull()
      } else if (capability.mode === HISTORY_MODE.PARTIAL_BACKFILL) {
        await this._syncRecentHistoryForAllChats()
        status = 'partial'
      } else {
        console.log('[InitialSync] Mode C — live only, полная синхронизация недоступна')
        status = 'partial'
      }
    } catch (e) {
      console.error('[InitialSync] Ошибка синхронизации:', e.message)
      status = 'failed'
    }

    this._markDone(capability.mode)
    return { mode: capability.mode, status }
  }

  // ─── Определение capability ─────────────────────────────────────────────

  async _detectCapability() {
    // Если endpoints не заполнены — live only
    if (!ENDPOINTS.getChats || !ENDPOINTS.getHistory) {
      return { mode: HISTORY_MODE.LIVE_ONLY }
    }

    const result = await this._page.evaluate(
      async ({ chatsEndpoint }) => {
        try {
          const resp = await fetch(chatsEndpoint, { credentials: 'include' })
          if (!resp.ok) return { ok: false }

          const data = await resp.json()
          const chats = data.chats || data.dialogs || data.items || data || []
          const hasPagination = !!(data.cursor || data.next || data.next_cursor ||
                                   data.offset !== undefined || data.has_more)

          return {
            ok:             true,
            chatsCount:     Array.isArray(chats) ? chats.length : 0,
            hasPagination,
          }
        } catch (e) {
          return { ok: false, error: e.message }
        }
      },
      { chatsEndpoint: ENDPOINTS.getChats }
    )

    if (!result.ok) return { mode: HISTORY_MODE.LIVE_ONLY }
    if (result.hasPagination) return { mode: HISTORY_MODE.FULL_BACKFILL }
    return { mode: HISTORY_MODE.PARTIAL_BACKFILL }
  }

  // ─── Mode A: полный backfill ─────────────────────────────────────────────

  async _syncAllChatsFull() {
    const chats = await this._fetchAllChats()
    console.log(`[InitialSync] Чатов найдено: ${chats.length}`)

    for (const chat of chats) {
      const chatId = chat.id || chat.dialog_id || chat.chat_id || chat.peer_id
      if (!chatId) continue
      await this._syncChatHistory(chatId, { fullDepth: true })
    }
  }

  // ─── Mode B: недавняя история для всех чатов ────────────────────────────

  async _syncRecentHistoryForAllChats() {
    const chats = await this._fetchAllChats()
    console.log(`[InitialSync] Чатов найдено: ${chats.length}`)

    for (const chat of chats) {
      const chatId = chat.id || chat.dialog_id || chat.chat_id || chat.peer_id
      if (!chatId) continue
      await this._syncChatHistory(chatId, { fullDepth: false })
    }
  }

  // ─── Получить список всех чатов с пагинацией ────────────────────────────

  async _fetchAllChats() {
    if (!ENDPOINTS.getChats) return []

    const allChats = []
    let cursor     = null
    let pageNum    = 0

    do {
      const url    = cursor
        ? `${ENDPOINTS.getChats}?cursor=${encodeURIComponent(cursor)}`
        : ENDPOINTS.getChats

      const result = await this._page.evaluate(async ({ url }) => {
        try {
          const resp = await fetch(url, { credentials: 'include' })
          if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` }
          return { ok: true, data: await resp.json() }
        } catch (e) {
          return { ok: false, error: e.message }
        }
      }, { url })

      if (!result.ok) {
        console.error('[InitialSync] Ошибка получения чатов:', result.error)
        break
      }

      const data  = result.data
      const chats = data.chats || data.dialogs || data.items || (Array.isArray(data) ? data : [])
      allChats.push(...chats)

      cursor = data.cursor || data.next_cursor || data.next || null
      pageNum++

      if (pageNum > 100) {
        console.warn('[InitialSync] Превышен лимит страниц для списка чатов')
        break
      }
    } while (cursor)

    return allChats
  }

  // ─── Синхронизация истории конкретного чата ──────────────────────────────

  async _syncChatHistory(chatId, { fullDepth }) {
    if (!ENDPOINTS.getHistory) return

    let cursor  = null
    let pageNum = 0
    let total   = 0

    do {
      const params = new URLSearchParams({ chatId: String(chatId) })
      if (cursor) params.set('cursor', cursor)
      if (!fullDepth) params.set('limit', '50')

      const result = await this._page.evaluate(
        async ({ endpoint, params }) => {
          try {
            const resp = await fetch(`${endpoint}?${params}`, { credentials: 'include' })
            if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` }
            return { ok: true, data: await resp.json() }
          } catch (e) {
            return { ok: false, error: e.message }
          }
        },
        { endpoint: ENDPOINTS.getHistory, params: params.toString() }
      )

      if (!result.ok) {
        console.error(`[InitialSync] Ошибка истории чата ${chatId}:`, result.error)
        break
      }

      const data     = result.data
      const messages = data.messages || data.items || (Array.isArray(data) ? data : [])

      for (const raw of messages) {
        const msg = MessageParser.normalizeHistoryMessage(raw)

        // Пропускаем исходящие при импорте истории
        if (msg.isOutgoing) continue

        if (!this._sync.isDuplicate(msg)) {
          await this._forward(MessageParser.toCrmPayload(msg))
          this._sync.markSeen(msg)
          total++
        }
      }

      cursor = data.cursor || data.next_cursor || data.next || null
      pageNum++

      if (pageNum > MAX_PAGES) {
        console.warn(`[InitialSync] Лимит страниц для чата ${chatId}`)
        break
      }

      if (!fullDepth) break  // Mode B — только первая страница
    } while (cursor)

    if (total > 0) {
      console.log(`[InitialSync] Чат ${chatId}: импортировано ${total} сообщений`)
    }
  }

  // ─── Служебные ──────────────────────────────────────────────────────────

  _markDone(mode) {
    try {
      fs.writeFileSync(DONE_FLAG, JSON.stringify({
        completedAt: new Date().toISOString(),
        mode
      }))
    } catch {}
  }

  static resetDoneFlag() {
    try { fs.unlinkSync(DONE_FLAG) } catch {}
  }
}

module.exports = { InitialHistorySync, HISTORY_MODE }
