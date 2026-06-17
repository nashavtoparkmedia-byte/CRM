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
  HANDSHAKE:             6,
  AUTH:                  19,
  SEND_MESSAGE:          64,
  TYPING:                65,
  GET_UPLOAD_IMAGE_URL:  80,   // opcode 80: upload image → {url: "iu.oneme.ru/uploadImage?..."}
  GET_UPLOAD_VIDEO_URL:  82,   // opcode 82: upload video → {info:[{videoId,url,token}]}
  RESOLVE_VIDEO:         83,
  GET_UPLOAD_FILE_URL:   87,   // opcode 87: upload file/audio → {info:[{fileId,url}]}
  RESOLVE_FILE:          88,
  GET_CHATS:             48,
  GET_HISTORY:           49,
  SUBSCRIBE_CHAT:        75,
  INCOMING_MSG:          128,
  PRESENCE:              132,
  CONTACTS:              32,
  SEND_REACTION:         178,
  REMOVE_REACTION:       179,
  DELETE_MESSAGE:        180,
  // Legacy alias (keep for compat with old references)
  GET_UPLOAD_URL:        80,
}

class TransportInterceptor {
  constructor() {
    this._messageHandlers      = []
    this._rawHandlers          = []  // для перехвата опкодов (32, 48 и т.д.)
    this._sentReactionHandlers = []  // срабатывают когда пользователь ставит реакцию в MAX веб
    this._page                 = null
    this._cdpClient            = null
    this._pendingReqs          = new Map()  // seq → {resolve, reject, timeout}
    this._localSeq             = 500        // наши seq начинаются с 500 (браузер использует 0–499)
    this._myUserId             = null       // userId нашего аккаунта (из opcode 19)
    this._wsAuthHandlers       = []
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

    // Перехватываем исходящие фреймы: реакции + логирование неизвестных опкодов
    const NOISY_SENT = new Set([OP.SEND_MESSAGE, OP.TYPING, OP.GET_UPLOAD_IMAGE_URL,
      OP.GET_UPLOAD_VIDEO_URL, OP.GET_UPLOAD_FILE_URL, OP.RESOLVE_VIDEO, OP.RESOLVE_FILE,
      OP.SUBSCRIBE_CHAT, OP.SEND_REACTION, OP.REMOVE_REACTION, OP.DELETE_MESSAGE,
      OP.HANDSHAKE, OP.AUTH, OP.GET_CHATS, OP.GET_HISTORY,
      1, 32, 53, 128])
    this._cdpClient.on('Network.webSocketFrameSent', ({ response }) => {
      if (!response.payloadData) return
      try {
        const data = JSON.parse(response.payloadData)
        if (data.opcode === OP.SEND_REACTION || data.opcode === OP.REMOVE_REACTION) {
          for (const h of this._sentReactionHandlers) try { h(data) } catch {}
        }
        // Логируем неизвестные исходящие опкоды для разведки протокола
        if (!NOISY_SENT.has(data.opcode)) {
          console.log('[Transport SENT] opcode:', data.opcode, 'seq:', data.seq,
            JSON.stringify(data.payload || {}).slice(0, 300))
        }
      } catch {}
    })

    this._cdpClient.on('Network.webSocketClosed', () => {
      console.log('[Transport] WS закрыт')
    })

    // page.on('websocket') — fallback только если CDP не перехватывает
    // (CDP уже активен выше, поэтому этот блок не нужен — закомментирован во избежание дублей)
    // page.on('websocket', (ws) => {
    //   ws.on('framereceived', ({ payload }) => {
    //     if (Buffer.isBuffer(payload)) return
    //     this._handleFrame(String(payload))
    //   })
    // })

    console.log('[Transport] CDP активен')
  }

  // ─── Обработка входящих WS фреймов ──────────────────────────────────────

  _handleFrame(raw) {
    let data
    try { data = JSON.parse(raw) } catch { return }

    // DEBUG: log all non-presence frames
    if (data.opcode !== OP.PRESENCE) {
      const preview = data.payload ? JSON.stringify(data.payload).slice(0, 200) : ''
      console.log('[Transport DEBUG] opcode:', data.opcode, 'cmd:', data.cmd, 'seq:', data.seq, preview)
    }
    // DEBUG: log full attachment data for incoming messages
    if (data.opcode === OP.INCOMING_MSG && data.payload?.message?.attaches?.length > 0) {
      console.log('[Transport ATTACH]', JSON.stringify(data.payload.message.attaches))
    }

    // Ответы на наши запросы (cmd:1 = success, cmd:3 = error)
    if ((data.cmd === 1 || data.cmd === 3) && this._pendingReqs.has(data.seq)) {
      const { resolve, reject, timeout } = this._pendingReqs.get(data.seq)
      clearTimeout(timeout)
      this._pendingReqs.delete(data.seq)
      if (data.cmd === 3) {
        const err = Object.assign(
          new Error(data.payload?.localizedMessage || data.payload?.error || 'MAX error cmd=3'),
          { maxError: data.payload?.error, maxPayload: data.payload }
        )
        reject(err)
      } else {
        resolve(data.payload)
      }
      return
    }

    // Авторизация (opcode 19) — запоминаем свой userId
    // Проверяем opcode 19 независимо от cmd (MAX может слать как cmd:0, так и cmd:1)
    if (data.opcode === OP.AUTH) {
      const id = data.payload?.profile?.contact?.id
      console.log(`[Auth] Opcode 19: cmd=${data.cmd}, has_profile=${!!data.payload?.profile}, userId=${id || 'none'}`)
      if (id) {
        this._myUserId = String(id)
        console.log('[Transport] My userId:', this._myUserId)
        for (const h of this._wsAuthHandlers) try { h(this._myUserId) } catch {}
      }
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
      id:                m.id    || null,
      chatId:            payload.chatId || null,
      from:              String(m.sender || ''),
      text:              m.text  || '',
      timestamp:         m.time  || Date.now(),
      type:              hasAttaches ? this._detectMaxType(m.attaches) : 'text',
      attachments:       this._extractMaxAttachments(m.attaches || []),
      isOutgoing:        this._myUserId ? String(m.sender) === this._myUserId : false,
      replyToMessageId:  (m.link?.type === 'REPLY' && m.link?.messageId) ? String(m.link.messageId) : null,
      raw:               payload,
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
      type:        (a._type || 'file').toLowerCase(),
      url:         a.baseUrl || a.url || null,  // MAX uses baseUrl for photos, url for audio
      name:        a.name || a.filename || null,
      size:        a.size || null,
      previewData: a.previewData || null,       // base64 webp thumbnail, ready to use
      photoId:     a.photoId || null,
      // VIDEO/FILE carry no direct url — only an opaque token that must be
      // resolved via OP.RESOLVE_VIDEO/RESOLVE_FILE before downloading.
      videoId:     a.videoId || null,
      fileId:      a.fileId || null,
      token:       a.token || null,
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

  /** Срабатывает когда WS-авторизация прошла (opcode 19) */
  onWsAuth(handler) {
    this._wsAuthHandlers.push(handler)
  }

  isAuthenticated() {
    return !!this._myUserId
  }

  onMessage(handler) {
    this._messageHandlers.push(handler)
  }

  /** Перехват любых входящих фреймов (contacts, chats, etc.) */
  onRawFrame(handler) {
    this._rawHandlers.push(handler)
  }

  /** Срабатывает когда пользователь ставит/убирает реакцию через MAX веб-интерфейс */
  onSentReaction(handler) {
    this._sentReactionHandlers.push(handler)
  }

  detach() {
    this._messageHandlers      = []
    this._rawHandlers          = []
    this._sentReactionHandlers = []
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
