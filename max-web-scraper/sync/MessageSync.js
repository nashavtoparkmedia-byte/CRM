'use strict'

const fs   = require('fs')
const path = require('path')

const { OP }           = require('../transport/TransportInterceptor')
const { MessageParser } = require('../parser/MessageParser')

const DEDUP_PATH         = path.join(__dirname, '..', 'last_seen_dedupe.json')
const DEDUP_TTL_MS       = 5 * 60 * 1000   // 5 минут
const MAX_DEDUP_ENTRIES  = 5000

class MessageSync {
  constructor() {
    this.seen = new Map()
    this._load()
  }

  // ─── Дедупликация ────────────────────────────────────────────────────────

  isDuplicate(msg) {
    // Primary: exact key match
    if (this.seen.has(this._key(msg))) return true
    // Secondary: fuzzy match by content+chatId within 30s window (catches cross-source duplicates)
    return this._isFuzzyDuplicate(msg)
  }

  markSeen(msg) {
    this.seen.set(this._key(msg), Date.now())
    // Also store fuzzy key for cross-source dedup
    const fuzzyKey = this._fuzzyKey(msg)
    if (fuzzyKey) this.seen.set(fuzzyKey, Date.now())
    this._prune()
    this._save()
  }

  _key(msg) {
    // Приоритет: стабильный внешний ID из протокола
    if (msg.id || msg.externalId) {
      return `id:${msg.id || msg.externalId}`
    }

    // Composite fallback: chatId + text + timestamp (до секунды)
    const text   = (msg.text || '').slice(0, 50)
    const chatId = msg.chatId || msg.from || ''
    const ts     = Math.floor(
      (typeof msg.timestamp === 'string'
        ? new Date(msg.timestamp).getTime()
        : (msg.timestamp || Date.now())
      ) / 1000
    )
    return `composite:${chatId}:${text}:${ts}`
  }

  // Fuzzy key: content + chatId + timestamp rounded to 30s window
  // This catches the same message arriving from DOM scraper and TransportInterceptor
  // with slightly different timestamps and different IDs
  _fuzzyKey(msg) {
    const text = (msg.text || '').slice(0, 50)
    if (!text) return null
    const chatId = msg.chatId || msg.from || ''
    const rawTs = typeof msg.timestamp === 'string'
      ? new Date(msg.timestamp).getTime()
      : (msg.timestamp || Date.now())
    const ts30s = Math.floor(rawTs / 30000) // 30-second window
    return `fuzzy:${chatId}:${text}:${ts30s}`
  }

  _isFuzzyDuplicate(msg) {
    const text = (msg.text || '').slice(0, 50)
    if (!text) return false
    const chatId = msg.chatId || msg.from || ''
    const rawTs = typeof msg.timestamp === 'string'
      ? new Date(msg.timestamp).getTime()
      : (msg.timestamp || Date.now())
    // Check current and adjacent 30s windows (covers boundary cases)
    const ts30s = Math.floor(rawTs / 30000)
    for (const offset of [0, -1, 1]) {
      const key = `fuzzy:${chatId}:${text}:${ts30s + offset}`
      if (this.seen.has(key)) return true
    }
    return false
  }

  // ─── Catch-up при рестарте ───────────────────────────────────────────────

  /**
   * Запрашивает пропущенные сообщения через WS opcode 49.
   * Для MAX нужен chatId — без него catch-up невозможен.
   * Используется для конкретного чата при реконнекте.
   *
   * @param {object} transport - TransportInterceptor
   * @param {number} chatId
   * @param {number} sinceTimestamp - мс
   */
  async fetchMissedForChat(transport, chatId, sinceTimestamp) {
    if (!chatId) return []

    try {
      const result = await transport.sendFrame(
        OP.GET_HISTORY,
        {
          chatId,
          from:        Date.now(),
          forward:     0,
          backward:    50,
          getMessages: true,
        },
        { waitResponse: true }
      )

      const messages = result?.messages || []

      return messages
        .filter(m => (m.time || 0) >= sinceTimestamp)
        .map(raw => MessageParser.normalizeHistoryMessage(raw))
    } catch (e) {
      console.error('[Sync] Catch-up failed for chat', chatId, e.message)
      return []
    }
  }

  // ─── Персистентность ────────────────────────────────────────────────────

  _prune() {
    const now = Date.now()
    for (const [key, ts] of this.seen) {
      if (now - ts > DEDUP_TTL_MS) this.seen.delete(key)
    }
    if (this.seen.size > MAX_DEDUP_ENTRIES) {
      const sorted = [...this.seen.entries()].sort((a, b) => b[1] - a[1])
      this.seen = new Map(sorted.slice(0, MAX_DEDUP_ENTRIES))
    }
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(DEDUP_PATH, 'utf8'))
      const now = Date.now()
      for (const [k, ts] of Object.entries(raw)) {
        if (now - ts < DEDUP_TTL_MS) this.seen.set(k, ts)
      }
      console.log(`[Sync] Загружен dedup cache: ${this.seen.size} записей`)
    } catch {
      // Файла нет — начинаем чистый
    }
  }

  _save() {
    try {
      fs.writeFileSync(DEDUP_PATH, JSON.stringify(Object.fromEntries(this.seen)))
    } catch (e) {
      console.error('[Sync] Ошибка сохранения dedup cache:', e.message)
    }
  }

  // Полный сброс кэша (используется перед full-history reimport)
  clear() {
    this.seen.clear()
    try { fs.unlinkSync(DEDUP_PATH) } catch {}
    console.log('[Sync] Dedup cache сброшен')
  }
}

module.exports = { MessageSync }
