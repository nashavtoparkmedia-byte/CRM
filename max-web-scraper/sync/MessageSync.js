'use strict'

const fs   = require('fs')
const path = require('path')

const { ENDPOINTS } = require('../transport/TransportInterceptor')
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
    return this.seen.has(this._key(msg))
  }

  markSeen(msg) {
    this.seen.set(this._key(msg), Date.now())
    this._prune()
    this._save()
  }

  _key(msg) {
    // Приоритет: стабильный внешний ID из протокола
    if (msg.id || msg.externalId) {
      return `id:${msg.id || msg.externalId}`
    }

    // ВРЕМЕННЫЙ FALLBACK — заменить после discovery когда известен stable ID
    // composite: from + text (первые 50 символов) + timestamp (с точностью до секунды)
    const text = (msg.text || '').slice(0, 50)
    const from = msg.from || msg.phone || ''
    const ts   = Math.floor(
      (typeof msg.timestamp === 'string'
        ? new Date(msg.timestamp).getTime()
        : (msg.timestamp || Date.now())
      ) / 1000
    )
    return `composite:${from}:${text}:${ts}`
  }

  // ─── Catch-up при рестарте ───────────────────────────────────────────────

  async fetchMissedMessages(page, sinceTimestamp) {
    if (!ENDPOINTS.getHistory) {
      console.log('[Sync] History endpoint не определён (FINDINGS.md), пропускаем catch-up')
      return []
    }

    const result = await page.evaluate(
      async ({ endpoint, since }) => {
        try {
          const url  = `${endpoint}?since=${since}`
          const resp = await fetch(url, { credentials: 'include' })
          if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` }
          return { ok: true, data: await resp.json() }
        } catch (e) {
          return { ok: false, error: e.message }
        }
      },
      { endpoint: ENDPOINTS.getHistory, since: sinceTimestamp }
    )

    if (!result.ok) {
      console.error('[Sync] Catch-up failed:', result.error)
      return []
    }

    const messages = result.data?.messages || result.data || []
    return messages.map(raw => MessageParser.normalizeHistoryMessage(raw))
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
}

module.exports = { MessageSync }
