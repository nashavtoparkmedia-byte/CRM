'use strict'

/**
 * PR-П (Вариант Б): NameSync — модуль для подтягивания имён placeholder-чатов
 * из MAX UI в CRM.
 *
 * Контекст: для outbound-only MAX-чатов (мы написали клиенту первыми, клиент
 * не ответил) chat.name остаётся placeholder ". .". В sidebar/header MAX-веб
 * имя контакта есть. Этот модуль раз в час:
 *   1. Спрашивает CRM: какие MAX-чаты placeholder?
 *   2. Для каждого: page.goto('/<chatId>') → читает header text
 *   3. POST CRM с парами (chatId, name) → обновление в БД
 *
 * Использует ту же страницу что и live ingest. На время sync переключает URL,
 * затем возвращается на стартовый (обычно главная).
 *
 * Подключение в index.js:
 *   const { NameSync } = require('./sync/NameSync')
 *   const nameSync = new NameSync({ page, crmBaseUrl, intervalMs })
 *   session.onAuth(() => nameSync.start())
 */

const http  = require('http')
const https = require('https')
const { URL } = require('url')

class NameSync {
    /**
     * @param {object} opts
     * @param {import('playwright').Page} opts.page
     * @param {string} opts.crmBaseUrl   — например "http://127.0.0.1:3002"
     * @param {number} [opts.intervalMs] — default 1 час
     * @param {number} [opts.firstDelayMs] — default 60 сек (чтоб ingest стабилизировался)
     * @param {function} [opts.onPause]    — call'back чтоб приостановить ingest (опционально)
     * @param {function} [opts.onResume]
     */
    constructor({ page, crmBaseUrl, intervalMs, firstDelayMs, onPause, onResume }) {
        this.page         = page
        this.crmBaseUrl   = (crmBaseUrl || 'http://127.0.0.1:3002').replace(/\/$/, '')
        // ВАЖНО: Number(undefined) = NaN, и `??` его не отлавливает.
        // Используем `||` чтобы NaN/0 fallthrough'нуло на default.
        const envInterval = Number(process.env.MAX_NAME_SYNC_INTERVAL_MS)
        this.intervalMs   = (Number.isFinite(intervalMs) && intervalMs > 0) ? intervalMs
                          : (Number.isFinite(envInterval) && envInterval > 0) ? envInterval
                          : (60 * 60 * 1000)
        this.firstDelayMs = (Number.isFinite(firstDelayMs) && firstDelayMs > 0) ? firstDelayMs : 60 * 1000
        this.onPause      = typeof onPause === 'function' ? onPause : () => {}
        this.onResume     = typeof onResume === 'function' ? onResume : () => {}
        this._timer       = null
        this._running     = false
        this._started     = false
    }

    start() {
        if (this._started) return
        this._started = true
        console.log(`[NameSync] enabled (firstRun=${this.firstDelayMs}ms, interval=${this.intervalMs}ms)`)
        setTimeout(() => this.runOnce().catch(e => console.error('[NameSync] first run error:', e.message)), this.firstDelayMs)
        this._timer = setInterval(() => this.runOnce().catch(e => console.error('[NameSync] tick error:', e.message)), this.intervalMs)
    }

    stop() {
        if (this._timer) clearInterval(this._timer)
        this._timer = null
        this._started = false
    }

    async runOnce() {
        if (this._running) return  // silent skip — interval может тикнуть пока предыдущий ещё идёт
        if (!this.page) return
        this._running = true
        const startedAt = Date.now()
        try {
            const placeholderIds = await this._fetchPlaceholderChatIds()
            if (!placeholderIds.length) {
                console.log('[NameSync] no placeholder chats, nothing to do')
                return
            }
            console.log(`[NameSync] resolving ${placeholderIds.length} placeholder chats from MAX UI`)

            this.onPause()
            const startUrl = this.page.url()
            const pairs = []
            try {
                for (const chatId of placeholderIds) {
                    try {
                        // SPA-friendly навигация: меняем location.href через evaluate
                        // (page.goto в MAX-веб SPA может зависнуть, ждать reload который не происходит).
                        // Затем ждём фиксированное время чтобы SPA-роутер прорисовал header.
                        await this.page.evaluate((id) => { window.location.href = '/' + id }, String(chatId))
                        await this.page.waitForTimeout(2000)
                        const name = await this.page.evaluate(() => {
                            const mainArea = document.querySelector('main')
                            if (!mainArea) return null
                            const header   = mainArea.querySelector('.chat-header, .top-bar, .user-name, header')
                            const headerEl = header?.querySelector('.title, .header-title, h2, .name')
                                          || mainArea.querySelector('.title, .header-title, h2, .name')
                            const text = headerEl ? headerEl.innerText.trim() : null
                            // фильтруем заведомый мусор
                            if (!text || text.length > 100) return null
                            if (/^[.\s\-]+$/.test(text)) return null
                            return text
                        })
                        if (name) {
                            pairs.push({ chatId: String(chatId), name })
                            console.log(`[NameSync] ${chatId} → "${name}"`)
                        } else {
                            console.log(`[NameSync] ${chatId}: header not found or placeholder`)
                        }
                    } catch (e) {
                        console.log(`[NameSync] ${chatId}: nav error ${e.message}`)
                    }
                    await this.page.waitForTimeout(500)
                }
            } finally {
                try {
                    // Восстанавливаем начальный URL — обычно главная страница MAX.
                    await this.page.evaluate((u) => { window.location.href = u }, startUrl || 'https://web.max.ru/')
                    await this.page.waitForTimeout(1500)
                } catch {}
                this.onResume()
            }

            if (pairs.length > 0) {
                const result = await this._postPairs(pairs)
                console.log(`[NameSync] POST result: ${JSON.stringify(result)}`)
            }
            console.log(`[NameSync] run done in ${Math.round((Date.now() - startedAt) / 1000)}s, ${pairs.length} pairs`)
        } catch (e) {
            console.error('[NameSync] runOnce error:', e.message)
        } finally {
            this._running = false
        }
    }

    async _fetchPlaceholderChatIds() {
        const r = await this._httpJson('GET', `${this.crmBaseUrl}/api/webhook/max/unlinked-chats`)
        if (!r || !Array.isArray(r.chatIds)) return []
        return r.chatIds
    }

    async _postPairs(pairs) {
        return this._httpJson('POST', `${this.crmBaseUrl}/api/webhook/max/sync-names`, { pairs })
    }

    _httpJson(method, urlStr, body) {
        return new Promise((resolve, reject) => {
            try {
                const url     = new URL(urlStr)
                const mod     = url.protocol === 'https:' ? https : http
                const payload = body ? JSON.stringify(body) : null
                const opts    = {
                    hostname: url.hostname,
                    port:     url.port || (url.protocol === 'https:' ? 443 : 80),
                    path:     url.pathname + url.search,
                    method,
                    headers:  payload
                        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                        : {},
                }
                const req = mod.request(opts, res => {
                    let data = ''
                    res.on('data', c => { data += c })
                    res.on('end',  () => {
                        try   { resolve(data ? JSON.parse(data) : {}) }
                        catch { resolve({ raw: data, status: res.statusCode }) }
                    })
                })
                req.on('error', reject)
                if (payload) req.write(payload)
                req.end()
            } catch (e) { reject(e) }
        })
    }
}

module.exports = { NameSync }
