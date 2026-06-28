'use strict'

const path = require('path')
const fs   = require('fs')

class SessionController {
  constructor() {
    this.context     = null
    this.page        = null
    this.isLoggedIn  = false

    this._onAuthCallbacks   = []
    this._onLogoutCallbacks = []
    this._keepaliveTimer    = null
  }

  // ─── Привязка к внешней странице (создаётся в index.js) ─────────────────

  attach(page, context, transport = null) {
    this.page       = page
    this.context    = context
    this._transport = transport
  }

  // ─── Запуск после навигации ──────────────────────────────────────────────

  async checkAndWaitForLogin() {
    this.page.on('pageerror', (err) => {
      console.error('[Session] Page error:', err.message)
    })

    await this._waitForWsAuth(12_000)

    const loggedIn = await this._checkLoginState()

    if (loggedIn) {
      console.log('[Session] Сессия активна, авторизация не требуется')
      this.isLoggedIn = true
      this._notifyAuth()
    } else if (!this.isLoggedIn) {
      // isLoggedIn может быть уже true если onWsAuth сработал раньше
      await this._waitForQrLogin()
    }

    this._startKeepalive()
  }

  // Ждём WS-авторизацию максимум msLimit мс
  async _waitForWsAuth(msLimit) {
    if (!this._transport) return
    const deadline = Date.now() + msLimit
    while (Date.now() < deadline) {
      if (this._transport.isAuthenticated()) return
      await new Promise(r => setTimeout(r, 200))
    }
  }

  // Обратная совместимость — не используется в новом index.js
  async start() {
    return this.checkAndWaitForLogin()
  }

  // ─── Проверка состояния сессии ──────────────────────────────────────────

  async _checkLoginState() {
    // Приоритет 0: WS-авторизация уже прошла (opcode 19 получен)
    if (this._transport && this._transport.isAuthenticated()) {
      return true
    }

    // Приоритет 1: cookie / localStorage token
    try {
      const hasToken = await this.page.evaluate(() => {
        // Ключи могут быть уточнены после discovery (FINDINGS.md)
        return document.cookie.length > 50 ||
               !!localStorage.getItem('auth_token') ||
               !!localStorage.getItem('session') ||
               !!localStorage.getItem('token') ||
               !!sessionStorage.getItem('auth')
      })
      if (hasToken) {
        // Дополнительно проверяем что UI реально загружен
        const uiReady = await this.page.evaluate(() => {
          return !!document.querySelector('.chat-list, .chat-item, [data-testid="chat-list"]')
        })
        if (uiReady) return true
      }
    } catch {}

    // Приоритет 2: auth-guarded network call
    // Заполнить после Фазы 0 (FINDINGS.md → Auth token)
    // try {
    //   const ok = await this.page.evaluate(async () => {
    //     const r = await fetch('/api/v1/me', { credentials: 'include' })
    //     return r.ok
    //   })
    //   if (ok) return true
    // } catch {}

    // Приоритет 3: DOM — только fallback
    try {
      await this.page.waitForSelector(
        '.chat-list, .chat-item, [aria-label*="Написать"]',
        { timeout: 3000 }
      )
      return true
    } catch {
      return false
    }
  }

  // ─── Ожидание QR-авторизации ────────────────────────────────────────────

  async _waitForQrLogin() {
    // Если onWsAuth уже сработал раньше — ничего не делаем
    if (this.isLoggedIn) return

    console.log('[Session] Ожидание QR-авторизации...')

    // QR генерируется из opcode 288 (qrLink) в index.js — здесь скриншот не нужен
    console.log('[Session] Ожидание QR-авторизации (QR генерируется из WS opcode 288)...')

    // MAX выдаёт QR с TTL ~2 мин и НЕ присылает новый сам по истечении. Раньше
    // мы просто ждали — QR протухал, висел мёртвым, и после таймаута скрейпер
    // залипал со стухшим кодом (UI показывал «офлайн»/дохлый QR днями). Теперь
    // перезагружаем страницу каждые QR_REFRESH_MS (< TTL), пока не залогинен:
    // reload → web.max.ru заново → новый WS → свежий opcode 288 → свежий QR.
    const QR_REFRESH_MS = 90 * 1000          // < 120с TTL, чтобы показанный QR всегда был валиден
    const deadline = Date.now() + 30 * 60 * 1000  // широкое окно на скан
    let lastRefresh = Date.now()
    while (Date.now() < deadline) {
      if (this.isLoggedIn) {
        console.log('[Session] QR-авторизация выполнена (WS auth detected)')
        return
      }
      if (Date.now() - lastRefresh >= QR_REFRESH_MS) {
        lastRefresh = Date.now()
        console.log('[Session] QR скоро истечёт — перезагружаю страницу для нового QR')
        try {
          await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
        } catch (e) {
          console.warn('[Session] reload для нового QR не удался:', e.message)
        }
      }
      await new Promise(r => setTimeout(r, 1000))
    }

    console.log('[Session] Таймаут QR-авторизации (30 мин без скана)')
  }

  // ─── Keepalive ──────────────────────────────────────────────────────────

  _startKeepalive() {
    this._keepaliveTimer = setInterval(async () => {
      try {
        const alive = await this._checkLoginState()

        if (!alive && this.isLoggedIn) {
          console.log('[Session] Сессия потеряна, восстанавливаем...')
          this.isLoggedIn = false
          this._notifyLogout()

          await this.page.reload({ waitUntil: 'networkidle', timeout: 30000 })

          const loggedIn = await this._checkLoginState()
          if (loggedIn) {
            console.log('[Session] Сессия восстановлена')
            this.isLoggedIn = true
            this._notifyAuth()
          } else {
            console.log('[Session] Требуется повторная QR-авторизация')
            await this._waitForQrLogin()
          }
        }
      } catch (e) {
        console.error('[Session] Keepalive error:', e.message)
      }
    }, 5 * 60 * 1000)
  }

  // ─── Публичный API ──────────────────────────────────────────────────────

  onAuth(cb)   { this._onAuthCallbacks.push(cb) }
  onLogout(cb) { this._onLogoutCallbacks.push(cb) }
  getPage()    { return this.page }
  getContext() { return this.context }

  async stop() {
    if (this._keepaliveTimer) clearInterval(this._keepaliveTimer)
    if (this.context) await this.context.close().catch(() => {})
  }

  // ─── Внутренние ─────────────────────────────────────────────────────────

  _notifyAuth() {
    for (const cb of this._onAuthCallbacks) {
      try { cb() } catch (e) { console.error('[Session] onAuth callback error:', e.message) }
    }
  }

  _notifyLogout() {
    for (const cb of this._onLogoutCallbacks) {
      try { cb() } catch (e) { console.error('[Session] onLogout callback error:', e.message) }
    }
  }
}

module.exports = { SessionController }
