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

  attach(page, context) {
    this.page    = page
    this.context = context
  }

  // ─── Запуск после навигации ──────────────────────────────────────────────

  async checkAndWaitForLogin() {
    this.page.on('pageerror', (err) => {
      console.error('[Session] Page error:', err.message)
    })

    const loggedIn = await this._checkLoginState()

    if (loggedIn) {
      console.log('[Session] Сессия активна, авторизация не требуется')
      this.isLoggedIn = true
      this._notifyAuth()
    } else {
      await this._waitForQrLogin()
    }

    this._startKeepalive()
  }

  // Обратная совместимость — не используется в новом index.js
  async start() {
    return this.checkAndWaitForLogin()
  }

  // ─── Проверка состояния сессии ──────────────────────────────────────────

  async _checkLoginState() {
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
    console.log('[Session] Ожидание QR-авторизации...')

    // Ищем QR-код на странице
    const qrEl = await this.page.waitForSelector('canvas, svg:has(image)', {
      timeout: 30000
    }).catch(() => null)

    if (qrEl) {
      const qrPath = path.join(__dirname, '..', 'last_qr.png')
      await this.page.screenshot({ path: qrPath })
      console.log('[Session] QR сохранён:', qrPath)
    } else {
      console.log('[Session] QR элемент не найден, делаем скриншот страницы...')
      await this.page.screenshot({ path: path.join(__dirname, '..', 'last_qr.png') })
    }

    // Ждём успешного входа (до 5 минут)
    await this.page.waitForSelector(
      '.chat-list, .chat-item, [aria-label*="Написать"]',
      { timeout: 300000 }
    )

    this.isLoggedIn = true

    // Сохраняем состояние сессии
    try {
      await this.context.storageState({
        path: path.join(this.userDataDir, 'state.json')
      })
    } catch {}

    console.log('[Session] QR-авторизация выполнена')
    this._notifyAuth()
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
