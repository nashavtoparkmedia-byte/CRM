'use strict'

// ─── WS Init Script — инжектируется ДО навигации ─────────────────────────────
// Перехватывает конструктор WebSocket, сохраняет ссылку на MAX WS,
// и добавляет window.__maxWsSend(rawString) для отправки фреймов из Node.js
const WS_INIT_SCRIPT = `(function () {
  var _OrigWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    var ws = protocols != null ? new _OrigWS(url, protocols) : new _OrigWS(url);
    if (url && url.indexOf('ws-api.oneme.ru') !== -1) {
      window.__maxWs = ws;
    }
    return ws;
  }
  PatchedWS.prototype  = _OrigWS.prototype;
  PatchedWS.CONNECTING = _OrigWS.CONNECTING;
  PatchedWS.OPEN       = _OrigWS.OPEN;
  PatchedWS.CLOSING    = _OrigWS.CLOSING;
  PatchedWS.CLOSED     = _OrigWS.CLOSED;
  window.WebSocket = PatchedWS;

  window.__maxWsSend = function (data) {
    var ws = window.__maxWs;
    if (!ws || ws.readyState !== 1) {
      return { ok: false, error: 'WS not ready (state ' + (ws ? ws.readyState : 'null') + ')' };
    }
    ws.send(data);
    return { ok: true };
  };
})();`

// ─── Опкоды MAX протокола ────────────────────────────────────────────────────
const OP = {
  HANDSHAKE:       6,
  AUTH:            19,
  SEND_MESSAGE:    64,
  TYPING:          65,
  GET_UPLOAD_URL:  80,
  GET_CHATS:       48,
  GET_HISTORY:     49,
  SUBSCRIBE_CHAT:  75,
  INCOMING_MSG:    128,
  PRESENCE:        132,
  CONTACTS:        32,
}

class TransportInterceptor {
  constructor() {
    this._messageHandlers = []
    this._rawHandlers     = []  // для перехвата опкодов (32, 48 и т.д.)
    this._page            = null
    this._cdpClient       = null
    this._pendingReqs     = new Map()  // seq → {resolve, reject, timeout}
    this._localSeq        = 500        // наши seq начинаются с 500 (браузер использует 0–499)
  }

  // ─── Шаг 1: Инжектируем хук ДО навигации ────────────────────────────────

  async injectHooks(page) {
    this._page = page
    await page.addInitScript(WS_INIT_SCRIPT)
    console.log('[Transport] WS-хук инжектирован')
  }

  // ─── Шаг 2: Прикрепляем CDP ПОСЛЕ page.goto ─────────────────────────────

  async attachCdp(page, context) {
    this._page = page

    this._cdpClient = await context.newCDPSession(page)
    await this._cdpClient.send('Network.enable')

    this._cdpClient.on('Network.webSocketCreated', ({ url }) => {
      console.log('[Transport] WS создан:', url)
    })

    this._cdpClient.on('Network.webSocketFrameReceived', ({ response }) => {
      if (!response.payloadData) return
      if (response.opcode === 2) return  // binary frame — пропускаем
      this._handleFrame(response.payloadData)
    })

    this._cdpClient.on('Network.webSocketClosed', () => {
      console.log('[Transport] WS закрыт')
    })

    // Дополнительно — page.on('websocket') для fallback
    page.on('websocket', (ws) => {
      ws.on('framereceived', ({ payload }) => {
        if (Buffer.isBuffer(payload)) return
        this._handleFrame(String(payload))
      })
    })

    console.log('[Transport] CDP активен')
  }

  // ─── Обработка входящих WS фреймов ──────────────────────────────────────

  _handleFrame(raw) {
    let data
    try { data = JSON.parse(raw) } catch { return }

    // Ответы на наши запросы (cmd:1, seq наш)
    if (data.cmd === 1 && this._pendingReqs.has(data.seq)) {
      const { resolve, timeout } = this._pendingReqs.get(data.seq)
      clearTimeout(timeout)
      this._pendingReqs.delete(data.seq)
      resolve(data.payload)
      return
    }

    // Raw-хэндлеры (contacts, chats, и т.д.)
    for (const h of this._rawHandlers) {
      try { h(data) } catch {}
    }

    // Presence updates — пропускаем
    if (data.opcode === OP.PRESENCE) return

    // Входящее сообщение — server push, opcode 128
    if (data.opcode === OP.INCOMING_MSG && data.payload?.message) {
      const msg = this._normalizeMaxMsg(data.payload)
      if (msg) this._emit(msg)
    }
  }

  // ─── Нормализация входящего MAX сообщения ────────────────────────────────

  _normalizeMaxMsg(payload) {
    const m = payload.message
    if (!m) return null

    const hasAttaches = Array.isArray(m.attaches) && m.attaches.length > 0

    return {
      id:          m.id    || null,
      chatId:      payload.chatId || null,
      from:        String(m.sender || ''),
      text:        m.text  || '',
      timestamp:   m.time  || Date.now(),
      type:        hasAttaches ? this._detectMaxType(m.attaches) : 'text',
      attachments: this._extractMaxAttachments(m.attaches || []),
      isOutgoing:  false,
      raw:         payload,
    }
  }

  _detectMaxType(attaches) {
    if (!attaches || !attaches.length) return 'text'
    const t = (attaches[0]._type || '').toUpperCase()
    if (t === 'PHOTO')                  return 'image'
    if (t === 'VIDEO')                  return 'video'
    if (t === 'AUDIO' || t === 'VOICE') return 'voice'
    return 'document'
  }

  _extractMaxAttachments(attaches) {
    return attaches.map(a => ({
      type: (a._type || 'file').toLowerCase(),
      url:  a.url    || null,
      name: a.filename || null,
      size: a.size   || null,
    }))
  }

  // ─── Отправка WS фрейма ──────────────────────────────────────────────────

  /**
   * @param {number} opcode
   * @param {object} payload
   * @param {{ waitResponse?: boolean }} opts
   * @returns {Promise<object|void>}
   */
  async sendFrame(opcode, payload, { waitResponse = false } = {}) {
    const seq  = ++this._localSeq
    const data = JSON.stringify({ ver: 11, cmd: 0, seq, opcode, payload })

    if (waitResponse) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this._pendingReqs.delete(seq)
          reject(new Error(`Timeout: opcode ${opcode} seq ${seq}`))
        }, 10_000)

        this._pendingReqs.set(seq, { resolve, reject, timeout })

        this._page.evaluate(d => window.__maxWsSend(d), data)
          .then(r => {
            if (!r || !r.ok) {
              clearTimeout(timeout)
              this._pendingReqs.delete(seq)
              reject(new Error(`WS send failed: ${r?.error}`))
            }
          })
          .catch(e => {
            clearTimeout(timeout)
            this._pendingReqs.delete(seq)
            reject(e)
          })
      })
    } else {
      const r = await this._page.evaluate(d => window.__maxWsSend(d), data)
      if (!r || !r.ok) throw new Error(`WS send failed: ${r?.error}`)
    }
  }

  // ─── Публичный API ───────────────────────────────────────────────────────

  onMessage(handler) {
    this._messageHandlers.push(handler)
  }

  /** Перехват любых входящих фреймов (contacts, chats, etc.) */
  onRawFrame(handler) {
    this._rawHandlers.push(handler)
  }

  detach() {
    this._messageHandlers = []
    this._rawHandlers     = []
    for (const { timeout } of this._pendingReqs.values()) clearTimeout(timeout)
    this._pendingReqs.clear()
    if (this._cdpClient) {
      this._cdpClient.detach().catch(() => {})
      this._cdpClient = null
    }
    console.log('[Transport] Перехват отключён')
  }

  // ─── Внутренние ─────────────────────────────────────────────────────────

  _emit(msg) {
    for (const h of this._messageHandlers) {
      try { h(msg) } catch (e) {
        console.error('[Transport] Handler error:', e.message)
      }
    }
  }
}

module.exports = { TransportInterceptor, OP }
