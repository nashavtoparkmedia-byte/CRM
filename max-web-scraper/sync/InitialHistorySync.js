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
  constructor(transport, messageSync, forwardFn, mediaPipeline = null, chatCache = null) {
    this._transport    = transport
    this._sync         = messageSync
    this._forward      = forwardFn
    this._mediaPipeline = mediaPipeline
    this._chatCache    = chatCache  // Map of chatId → chat (из opcode 48 автозагрузки)
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
      // Catch-up: подтянуть пропущенные за время даунтайма
      const caught = await this._catchUpIfNeeded()
      this._markDone('from_connection_time')
      return { mode: 'from_connection_time', status: caught ? 'caught_up' : 'skipped' }
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

  // ─── Получить список всех чатов ─────────────────────────────────────────

  async _fetchAllChats() {
    // Сначала используем кэш из автоматических opcode 48 фреймов при старте
    if (this._chatCache && this._chatCache.size > 0) {
      const chats = Array.from(this._chatCache.values())
      console.log(`[InitialSync] Чаты из кэша: ${chats.length}`)
      return chats
    }

    // Фолбэк: перехватить чаты из page reload — сделать GET_CHATS с разными параметрами
    console.log('[InitialSync] Кэш пустой — запрашиваем чаты через WS (несколько попыток)...')
    const allChats = new Map()

    // Пробуем несколько разных payload-ов чтобы получить все чаты
    const payloads = [
      { chatIds: [] },
      {},
      { count: 100 },
      { count: 100, offset: 0 },
    ]
    for (const payload of payloads) {
      try {
        const result = await this._transport.sendFrame(OP.GET_CHATS, payload, { waitResponse: true })
        const chats = (result && result.chats) ? result.chats : []
        for (const c of chats) {
          const id = c.id ?? c.chatId
          if (id && id !== 0) allChats.set(String(id), c)
        }
        console.log(`[InitialSync] payload=${JSON.stringify(payload)} → ${chats.length} чатов`)
      } catch (e) {
        console.log(`[InitialSync] payload=${JSON.stringify(payload)} → ошибка: ${e.message}`)
      }
    }

    console.log(`[InitialSync] Итого уникальных чатов: ${allChats.size}`)
    return Array.from(allChats.values())
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
        try {
          const msg = MessageParser.normalizeHistoryMessage(raw)
          if (msg.isOutgoing) continue
          if (!this._sync.isDuplicate(msg)) {
            await this._forward(MessageParser.toCrmPayload(msg, chatId))
            this._sync.markSeen(msg)
            total++
          }
        } catch (e) {
          console.error(`[InitialSync] Пропускаем сообщение из-за ошибки:`, e.message,
            '| raw.id:', raw?.id, '| chatId:', chatId)
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

  // ─── Catch-up при рестарте ───────────────────────────────────────────────

  async _catchUpIfNeeded() {
    const LAST_ACTIVITY_PATH = path.join(__dirname, '..', 'last_activity.json')
    const CATCH_UP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000  // до 7 дней назад

    let sinceTs
    try {
      const data = JSON.parse(fs.readFileSync(LAST_ACTIVITY_PATH, 'utf8'))
      sinceTs = data.ts
    } catch {
      return false  // файла нет — первый запуск
    }

    const ago = Date.now() - sinceTs
    if (ago > CATCH_UP_WINDOW_MS) {
      console.log(`[InitialSync] Catch-up: последняя активность ${Math.round(ago / 60000)} мин назад — пропускаем`)
      return false
    }

    console.log(`[InitialSync] Catch-up: подтягиваем сообщения с ${new Date(sinceTs).toISOString()}`)

    let total = 0
    try {
      // Используем сохранённые chatId из реальных входящих сообщений
      const KNOWN_CHATS_PATH = path.join(__dirname, '..', 'known_chats.json')
      let chatIds = []
      try { chatIds = JSON.parse(fs.readFileSync(KNOWN_CHATS_PATH, 'utf8')) } catch {}
      console.log(`[InitialSync] Catch-up: scanning ${chatIds.length} known chats: ${chatIds.join(', ')}`)
      for (const chatId of chatIds) {
        if (!chatId || chatId === 0) continue
        total += await this._syncChatSince(chatId, sinceTs)
      }
    } catch (e) {
      console.error('[InitialSync] Catch-up error:', e.message)
    }

    console.log(`[InitialSync] Catch-up завершён: ${total} новых сообщений`)
    return true
  }

  async _syncChatSince(chatId, sinceTs) {
    let total = 0
    try {
      const result = await this._transport.sendFrame(
        OP.GET_HISTORY,
        { chatId, from: sinceTs, forward: 50, backward: 0, getMessages: true },
        { waitResponse: true }
      )
      const messages = (result && result.messages) ? result.messages : []
      console.log(`[InitialSync] Chat ${chatId}: got ${messages.length} msgs after sinceTs=${sinceTs}`)
      for (const raw of messages) {
        try {
          if ((raw.time || 0) < sinceTs) continue
          const msg = MessageParser.normalizeHistoryMessage(raw)
          if (msg.isOutgoing) continue
          if (!this._sync.isDuplicate(msg)) {
            let payload = MessageParser.toCrmPayload(msg, chatId)

            // Скачиваем вложения (фото, голосовые) если есть mediaPipeline
            if (this._mediaPipeline && msg.attachments && msg.attachments.length > 0) {
              const downloaded = []
              for (const att of msg.attachments) {
                if (!att.url) { downloaded.push(att); continue }
                try {
                  const file = await this._mediaPipeline.downloadAttachment(att.url, att.mimeType)
                  downloaded.push({ ...att, localPath: file.localPath, size: file.size })
                } catch (e) {
                  console.error(`[InitialSync] Ошибка скачивания вложения в catch-up:`, e.message)
                  downloaded.push(att)
                }
              }
              payload = { ...payload, attachments: downloaded }
            }

            await this._forward(payload)
            this._sync.markSeen(msg)
            total++
          }
        } catch (e) {
          console.error(`[InitialSync] Пропускаем catch-up сообщение:`, e.message,
            '| raw.id:', raw?.id, '| chatId:', chatId)
        }
      }
    } catch (e) {
      console.error(`[InitialSync] Catch-up chat ${chatId}:`, e.message)
    }
    return total
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
