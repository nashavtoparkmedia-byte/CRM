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
    if (this._hasProviderIdentity(msg)) {
      return this.seen.has(this._key(msg))
    }
    if (this._isTextOnly(msg)) return false
    return this._isFuzzyDuplicate(msg)
  }

  markSeen(msg) {
    if (this._isTextOnly(msg) && !this._hasProviderIdentity(msg)) return
    this.seen.set(this._key(msg), Date.now())
    if (!this._isTextOnly(msg)) {
      const fuzzyKey = this._fuzzyKey(msg)
      if (fuzzyKey) this.seen.set(fuzzyKey, Date.now())
    }
    this._prune()
    this._save()
  }

  _hasProviderIdentity(msg) {
    return Boolean(msg?.id || msg?.externalId)
  }

  _isTextOnly(msg) {
    const type = String(msg?.type || msg?.messageType || 'text').toLowerCase()
    const hasAttachments = Array.isArray(msg?.attachments) && msg.attachments.length > 0
    return type === 'text' && !hasAttachments
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

// ─── Inbound delivery ledger ───────────────────────────────────────────────
// Per provider message id: what MAX delivered to the page versus what the CRM
// has stored. It answers the question the live socket path and DOM recovery
// used to settle with time windows - "is this message persisted?":
//
// - forwards for one chat run one at a time in arrival order (`enqueue`), so
//   the CRM stores a burst in the order the page received it;
// - an id is in flight from `beginForward` until the CRM answers, and a second
//   delivery of it meanwhile is not forwarded twice;
// - only a 2xx from the CRM settles it (`markPersisted`); a failure releases
//   it, so a later delivery or the recovery path can forward it again;
// - the page acknowledges every push it receives (op:128 cmd 1). An
//   acknowledged id that is still unsettled `graceMs` later goes to
//   `onUnpersisted` - the recovery trigger - instead of being forgotten.
class InboundDeliveryLedger {
  constructor({
    graceMs = 4000,
    retentionMs = 30 * 60 * 1000,
    onUnpersisted = null,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = () => Date.now(),
  } = {}) {
    this._graceMs = graceMs
    this._retentionMs = retentionMs
    this._onUnpersisted = onUnpersisted
    this._setTimer = setTimer
    this._clearTimer = clearTimer
    this._now = now
    this._persisted = new Map() // id -> { chatId, at, outcome }
    this._inFlight = new Map()  // id -> startedAt
    this._acked = new Map()     // id -> { chatId, at, timer }
    this._chains = new Map()    // chat key -> tail promise
  }

  enqueue(chatKey, task) {
    const key = String(chatKey ?? '')
    const previous = this._chains.get(key) || Promise.resolve()
    const result = previous.then(() => task())
    const tail = result.catch(() => {})
    this._chains.set(key, tail)
    tail.then(() => {
      if (this._chains.get(key) === tail) this._chains.delete(key)
    })
    return result
  }

  isPersisted(id) {
    this._prune()
    return id != null && this._persisted.has(String(id))
  }

  isInFlight(id) {
    return id != null && this._inFlight.has(String(id))
  }

  /** False when this id is already settled or being forwarded right now. */
  beginForward(id) {
    if (id == null || id === '') return true
    const key = String(id)
    if (this.isPersisted(key) || this._inFlight.has(key)) return false
    this._inFlight.set(key, this._now())
    return true
  }

  markPersisted(id, chatId = null, outcome = 'stored') {
    if (id == null || id === '') return
    const key = String(id)
    this._inFlight.delete(key)
    this._persisted.set(key, { chatId: chatId == null ? null : String(chatId), at: this._now(), outcome })
    const acked = this._acked.get(key)
    if (acked?.timer) this._clearTimer(acked.timer)
    this._acked.delete(key)
  }

  releaseForward(id) {
    if (id == null || id === '') return
    this._inFlight.delete(String(id))
  }

  noteBrowserAck(chatId, id) {
    if (id == null || id === '') return
    const key = String(id)
    if (this.isPersisted(key) || this._acked.has(key)) return
    const entry = { chatId: chatId == null ? null : String(chatId), at: this._now(), timer: null }
    entry.timer = this._setTimer(() => this._checkAcknowledged(key), this._graceMs)
    this._acked.set(key, entry)
  }

  _checkAcknowledged(key) {
    const entry = this._acked.get(key)
    if (!entry) return
    if (this._persisted.has(key)) {
      this._acked.delete(key)
      return
    }
    if (this._inFlight.has(key)) {
      // Still being forwarded: decide on what the CRM answers, not on a clock.
      entry.timer = this._setTimer(() => this._checkAcknowledged(key), this._graceMs)
      return
    }
    this._acked.delete(key)
    if (typeof this._onUnpersisted === 'function') {
      try {
        this._onUnpersisted({ chatId: entry.chatId, messageId: key, ackedAt: entry.at })
      } catch {}
    }
  }

  _prune() {
    const cutoff = this._now() - this._retentionMs
    for (const [key, value] of this._persisted) {
      if (value.at < cutoff) this._persisted.delete(key)
    }
  }
}

/**
 * Forwards one inbound payload to the CRM, retrying a bounded number of times
 * on a network error or a 5xx/429. The CRM stores MAX messages with an atomic
 * upsert by provider id, so a retry cannot duplicate. A 4xx is a decision and
 * is returned as is.
 */
async function forwardWithBoundedRetry(forward, payload, {
  delaysMs = [500, 1500, 4000],
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  let last = null
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      last = await forward(payload)
      const status = Number(last?.status) || 0
      if ((status >= 200 && status < 300) || (status >= 400 && status < 500 && status !== 429)) {
        return { ...last, attempts: attempt + 1 }
      }
    } catch (error) {
      last = { status: 0, error }
    }
    if (attempt < delaysMs.length) await sleep(delaysMs[attempt])
  }
  return { ...last, attempts: delaysMs.length + 1 }
}

module.exports = { MessageSync, InboundDeliveryLedger, forwardWithBoundedRetry }
