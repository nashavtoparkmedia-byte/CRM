'use strict'

const fs   = require('fs')
const path = require('path')

const { OP }           = require('../transport/TransportInterceptor')
const { MessageParser } = require('../parser/MessageParser')

// Флаг-файл: если существует — initial sync уже был выполнён
const DONE_FLAG = path.join(__dirname, '..', '.initial_sync_done')

// Максимум страниц пагинации — защита от бесконечного цикла
const MAX_PAGES = 500

// Сколько сообщений запрашивать за один WS-вызов
const HISTORY_BATCH = 30

class InitialHistorySync {
  /**
   * @param {object} transport - TransportInterceptor instance
   * @param {object} messageSync - MessageSync instance
   * @param {Function} forwardFn - async (payload) => void
   */
  constructor(transport, messageSync, forwardFn) {
    this._transport = transport
    this._sync      = messageSync
    this._forward   = forwardFn
  }

  // ─── Запуск ─────────────────────────────────────────────────────────────

  async runIfNeeded(historyImportMode = 'from_connection_time') {
    if (historyImportMode === 'none') {
      console.log('[InitialSync] Режим: none — история не импортируется')
      this._markDone('none')
      return { mode: 'none', status: 'skipped' }
    }

    if (historyImportMode === 'from_connection_time') {
      console.log('[InitialSync] Режим: from_connection_time — только новые сообщения')
      this._markDone('from_connection_time')
      return { mode: 'from_connection_time', status: 'skipped' }
    }

    if (fs.existsSync(DONE_FLAG)) {
      console.log('[InitialSync] Уже выполнен (флаг существует), пропускаем')
      return { mode: 'already_done', status: 'skipped' }
    }

    // available_history — запускаем полный backfill
    console.log('[InitialSync] Режим: available_history — запускаем backfill...')

    let status = 'completed'

    try {
      const chats = await this._fetchAllChats()
      console.log(`[InitialSync] Чатов найдено: ${chats.length}`)

      for (const chat of chats) {
        const chatId = chat.id
        if (!chatId || chatId === 0) continue
        await this._syncChatHistory(chatId)
      }
    } catch (e) {
      console.error('[InitialSync] Ошибка синхронизации:', e.message)
      status = 'failed'
    }

    this._markDone('available_history')
    return { mode: 'available_history', status }
  }

  // ─── Получить список всех чатов через WS opcode 48 ──────────────────────

  async _fetchAllChats() {
    try {
      // chatIds: [0] = вернуть все чаты
      const result = await this._transport.sendFrame(
        OP.GET_CHATS,
        { chatIds: [0] },
        { waitResponse: true }
      )
      return (result && result.chats) ? result.chats : []
    } catch (e) {
      console.error('[InitialSync] Ошибка получения чатов:', e.message)
      return []
    }
  }

  // ─── Синхронизация истории чата через WS opcode 49 ──────────────────────

  async _syncChatHistory(chatId) {
    let from    = Date.now()
    let pageNum = 0
    let total   = 0

    do {
      let result
      try {
        result = await this._transport.sendFrame(
          OP.GET_HISTORY,
          { chatId, from, forward: 0, backward: HISTORY_BATCH, getMessages: true },
          { waitResponse: true }
        )
      } catch (e) {
        console.error(`[InitialSync] Ошибка истории чата ${chatId}:`, e.message)
        break
      }

      const messages = (result && result.messages) ? result.messages : []
      if (messages.length === 0) break

      for (const raw of messages) {
        const msg = MessageParser.normalizeHistoryMessage(raw)

        if (msg.isOutgoing) continue

        if (!this._sync.isDuplicate(msg)) {
          await this._forward(MessageParser.toCrmPayload(msg, chatId))
          this._sync.markSeen(msg)
          total++
        }
      }

      // Самое старое сообщение → новый from для следующей страницы
      from = Math.min(...messages.map(m => m.time || m.timestamp || from))
      pageNum++

      if (pageNum > MAX_PAGES) {
        console.warn(`[InitialSync] Лимит страниц для чата ${chatId}`)
        break
      }

      // Если пришло меньше чем batch — история закончилась
      if (messages.length < HISTORY_BATCH) break

    } while (true)

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

module.exports = { InitialHistorySync }
