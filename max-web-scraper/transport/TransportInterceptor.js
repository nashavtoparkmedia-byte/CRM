'use strict'

const { decode: msgpackDecode, decodeMulti: msgpackDecodeMulti } = require('@msgpack/msgpack')

// ─── WS Init Script — инжектируется ДО навигации ─────────────────────────────
// Перехватывает конструктор WebSocket, сохраняет ссылку на MAX WS,
// и добавляет window.__maxWsSend(rawString) для отправки фреймов из Node.js
const WS_INIT_SCRIPT = `(function () {
  // ── Patch Worker constructor to detect worker creation ───────────────────
  var _OrigWorker = window.Worker;
  if (_OrigWorker) {
    window.Worker = function(url, opts) {
      var w = (opts != null) ? new _OrigWorker(url, opts) : new _OrigWorker(url);
      try { if (window.__maxWsReceive) window.__maxWsReceive('{"__diag":"worker_created","url":"' + url + '"}'); } catch(e) {}
      return w;
    };
    window.Worker.prototype = _OrigWorker.prototype;
  }

  // ── Patch WebSocket in main thread ───────────────────────────────────────
  var _OrigWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    var ws = protocols != null ? new _OrigWS(url, protocols) : new _OrigWS(url);
    if (url && (url.indexOf('ws-api.oneme.ru') !== -1 || url.indexOf('api.oneme.ru') !== -1)) {
      window.__maxWs = ws;
      // Force ArrayBuffer mode so binary frames don't arrive as Blob (unreadable synchronously)
      ws.binaryType = 'arraybuffer';
      try { if (window.__maxWsReceive) window.__maxWsReceive('{"__diag":"ws_created","url":"' + url + '"}'); } catch(e) {}
      ws.addEventListener('message', function (event) {
        try {
          // Diagnostic: report that the message event fired (with data type)
          var dataType = typeof event.data;
          var isAB = event.data instanceof ArrayBuffer;
          try { if (window.__maxWsReceive) window.__maxWsReceive('{"__diag":"msg_arrived","type":"' + dataType + '","ab":' + isAB + '}'); } catch(e2) {}

          var d = event.data;
          if (d instanceof ArrayBuffer) {
            // MAX uses binary WS frames (new api.oneme.ru endpoint).
            // Pass raw bytes as base64 so Node.js can decode the binary protocol
            // without losing bytes to TextDecoder's UTF-8 replacement chars.
            try {
              var bytes = new Uint8Array(d);
              var binary = '';
              for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
              d = 'b64:' + btoa(binary);
            } catch(e2) { d = ''; }
          } else if (typeof d !== 'string') {
            d = '';
          }
          if (window.__maxWsReceive) window.__maxWsReceive(d);
        } catch (e) {}
      });
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
  MARK_READ:             180,  // outgoing: mark messages as read, payload {chatId, messageIds:[...]}
  // opcode 66: delete messages. payload {chatId, messageIds:[...], forMe:false=for_everyone, forMe:true=for_me_only}
  // Confirmed from web.max.ru bundle: U_=async function({forAll:n},{send:r}){yield*r(66,{chatId,messageIds,forMe:!n})}
  DELETE_MESSAGE:        66,
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

    // JS-level bridge: browser calls window.__maxWsReceive(data) for every incoming
    // WS message; Node.js receives it here.
    await page.exposeFunction('__maxWsReceive', (data) => {
      try { this._handleFrame(String(data)) } catch {}
    })

    await page.addInitScript(WS_INIT_SCRIPT)
    console.log('[Transport] WS-хук инжектирован')

    // Detect Web Workers — MAX may create WS inside a Dedicated Worker
    page.on('worker', (worker) => {
      console.log('[Transport] Worker создан:', worker.url())
    })
  }

  // ─── Шаг 2: Прикрепляем CDP ПОСЛЕ page.goto ─────────────────────────────

  async attachCdp(page, context) {
    this._page = page

    this._cdpClient = await context.newCDPSession(page)
    await this._cdpClient.send('Network.enable')

    this._cdpClient.on('Network.webSocketCreated', ({ url }) => {
      console.log('[Transport] WS создан:', url)
    })

    // WS frame reception is handled via window.__maxWsReceive (exposeFunction in injectHooks).
    // CDP.webSocketFrameReceived and Playwright ws.framereceived are disabled to avoid
    // duplicate processing — both failed for api.oneme.ru/websocket anyway.

    // Перехватываем ВСЕ исходящие WS-фреймы для диагностики + реакции
    this._cdpClient.on('Network.webSocketFrameSent', ({ response }) => {
      if (!response.payloadData) return
      try {
        const data = JSON.parse(response.payloadData)
        if (data.opcode === OP.SEND_REACTION || data.opcode === OP.REMOVE_REACTION) {
          for (const h of this._sentReactionHandlers) try { h(data) } catch {}
        }
        // Логируем ВСЕ исходящие опкоды кроме самых шумных
        const SKIP = new Set([OP.SEND_MESSAGE, OP.TYPING, OP.HANDSHAKE, OP.AUTH, 1])
        if (!SKIP.has(data.opcode)) {
          console.log('[WS→MAX] op:', data.opcode, 'seq:', data.seq,
            JSON.stringify(data.payload || {}).slice(0, 200))
        }
      } catch {}
    })

    // Перехватываем ВСЕ HTTP-запросы к MAX/oneme API — ищем реальный delete endpoint
    this._cdpClient.on('Network.requestWillBeSent', ({ requestId, request }) => {
      const url = request.url || ''
      const method = request.method || ''
      const isMaxApi = url.includes('oneme.ru') || url.includes('max.ru')
      if (!isMaxApi) return
      // Пропускаем мусор: картинки, статику, WS-апгрейд
      const SKIP_EXT = /\.(png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|css|map)(\?|$)/i
      if (SKIP_EXT.test(url)) return
      if (url.includes('ws-api.oneme.ru')) return  // WS — уже перехватываем отдельно
      const body = (request.postData || '').slice(0, 300)
      console.log(`[HTTP→MAX] ${method} ${url.split('?')[0]}${body ? ' | ' + body : ''}`)
      this._pendingHttpReqs = this._pendingHttpReqs || new Map()
      this._pendingHttpReqs.set(requestId, { method, url })
    })

    this._cdpClient.on('Network.responseReceived', ({ requestId, response }) => {
      if (!this._pendingHttpReqs) return
      const req = this._pendingHttpReqs.get(requestId)
      if (!req) return
      this._pendingHttpReqs.delete(requestId)
      const status = response.status
      if (status >= 400 || req.method === 'DELETE' || req.url.match(/delete|revoke|remove|recall/i)) {
        console.log(`[HTTP←MAX] ${status} ${req.method} ${req.url.split('?')[0]}`)
      }
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
    // Binary frames from new api.oneme.ru endpoint arrive base64-encoded
    if (raw.startsWith('b64:')) {
      this._handleBinaryFrame(Buffer.from(raw.slice(4), 'base64'))
      return
    }

    let data
    try { data = JSON.parse(raw) } catch {
      console.log('[Transport PARSE_FAIL] not base64 and not JSON, len:', raw.length)
      return
    }

    // Diagnostic frames from WS_INIT_SCRIPT
    if (data.__diag) {
      if (data.__diag === 'ws_created') {
        console.log('[Transport DIAG] WS создан:', data.url)
      } else if (data.__diag === 'msg_arrived') {
        console.log('[Transport DIAG] message event СРАБОТАЛ — тип:', data.type, 'ab:', data.ab)
      } else if (data.__diag === 'worker_created') {
        console.log('[Transport DIAG] Worker создан из JS:', data.url)
      } else {
        console.log('[Transport DIAG]', JSON.stringify(data))
      }
      return
    }

    this._processDecodedFrame(data)
  }

  _processDecodedFrame(data) {
    // DEBUG: log all non-presence frames
    if (data.opcode !== OP.PRESENCE) {
      const preview = data.payload ? JSON.stringify(data.payload).slice(0, 200) : ''
      console.log('[Transport DEBUG] opcode:', data.opcode, 'cmd:', data.cmd, 'seq:', data.seq, preview)
    }
    // DEBUG: log full attachment data for incoming messages
    if (data.opcode === OP.INCOMING_MSG && data.payload?.message?.attaches?.length > 0) {
      console.log('[Transport ATTACH]', JSON.stringify(data.payload.message.attaches))
    }
    // DEBUG: log full FORWARD payload so we can inspect link.message structure
    if (data.opcode === OP.INCOMING_MSG && data.payload?.message?.link?.type === 'FORWARD') {
      console.log('[Transport FORWARD]', JSON.stringify(data.payload.message.link.message).slice(0, 600))
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

  // ─── Декодирование бинарных WS фреймов (новый api.oneme.ru протокол) ────
  //
  // Frame layout (observed via hex dump, 9-byte fixed header):
  //   Byte 0:    0x0a = protocol magic (10)
  //   Byte 1:    0x01 = version
  //   Byte 2:    0x00 = flags
  //   Bytes 3-4: uint16 BE = frame sequence number
  //   Byte 5:    opcode (same numbers as JSON protocol)
  //   Byte 6:    cmd (meaning differs from JSON: 1=push, 4=success, etc.)
  //   Bytes 7-8: uint16 BE = request seq (for matching responses)
  //   Bytes 9+:  MessagePack-encoded payload object
  //
  _handleBinaryFrame(buf) {
    if (buf.length < 9) return

    if (buf[0] !== 0x0a) {
      console.log('[BIN] Unknown magic byte:', buf[0].toString(16))
      return
    }

    const opcode   = buf[5]
    const cmd      = buf[6]
    const reqSeq   = (buf[7] << 8) | buf[8]
    const frameSeq = (buf[3] << 8) | buf[4]

    let payload = {}
    if (buf.length > 9) {
      const payloadBuf = buf.slice(9)
      // Log first 20 bytes of payload as hex for format investigation
      const payloadHex = [...payloadBuf.slice(0, 20)].map(b => b.toString(16).padStart(2,'0')).join(' ')

      try {
        // Payload may contain multiple sequential msgpack values (not a single top-level object).
        // Use decodeMulti to collect all values, then pick the map/object from them.
        const values = [...msgpackDecodeMulti(payloadBuf)]
        if (values.length === 1) {
          payload = values[0] ?? {}
        } else if (values.length > 1) {
          // Find the first non-null object value — that's the actual payload
          payload = values.find(v => v !== null && typeof v === 'object' && !Array.isArray(v)) ?? values[values.length - 1] ?? {}
          console.log('[BIN] multi-value payload op:', opcode, 'count:', values.length,
            'types:', values.map(v => v === null ? 'null' : typeof v).join(','))
        }
      } catch (e) {
        console.log('[BIN] MsgPack decode fail op:', opcode, 'hex:', payloadHex, 'err:', e.message.slice(0, 80))
        return
      }
    }

    // Map binary frame to the same JSON-protocol data shape that _handleFrame uses
    // In binary protocol: cmd=1 means "server push" (no reqSeq), cmd=4 means "success response"
    // We normalise to old protocol: cmd=1 for success, cmd=0 for push
    const mappedCmd = (cmd === 4) ? 1 : (cmd === 1 ? 0 : cmd)

    const data = { opcode, cmd: mappedCmd, seq: reqSeq, payload, _frameSeq: frameSeq }

    if (opcode !== OP.PRESENCE) {
      console.log('[BIN] op:', opcode, 'cmd:', cmd, '→', mappedCmd, 'seq:', reqSeq,
        JSON.stringify(payload).slice(0, 200))
    }

    // Feed into the common handler (reuse all existing opcode processing)
    this._processDecodedFrame(data)
  }

  // ─── Нормализация входящего MAX сообщения ────────────────────────────────

  _normalizeMaxMsg(payload) {
    const m = payload.message
    if (!m) return null

    let text    = m.text || ''
    let attaches = m.attaches || []

    // Forwarded messages: content lives in m.link.message, not in m.text/m.attaches.
    // Without this, text='' + attaches=[] → webhook skips with 'empty_text'.
    if (m.link?.type === 'FORWARD' && m.link.message) {
      const fwd = m.link.message
      if (!text) text = fwd.text || ''
      if (!attaches.length && fwd.attaches?.length > 0) attaches = fwd.attaches
      if (!text && !attaches.length) text = '[Переслано]'
    }

    const hasAttaches = Array.isArray(attaches) && attaches.length > 0

    return {
      id:                m.id    || null,
      chatId:            payload.chatId || null,
      from:              String(m.sender || ''),
      text,
      timestamp:         m.time  || Date.now(),
      type:              hasAttaches ? this._detectMaxType(attaches) : 'text',
      attachments:       this._extractMaxAttachments(attaches),
      isOutgoing:        this._myUserId ? String(m.sender) === this._myUserId : false,
      replyToMessageId:  (m.link?.type === 'REPLY' && m.link?.messageId) ? String(m.link.messageId) : null,
      forwardedFromId:   (m.link?.type === 'FORWARD' && m.link.message?.sender) ? String(m.link.message.sender) : null,
      status:            m.status || null,
      raw:               payload,
    }
  }

  _detectMaxType(attaches) {
    if (!attaches || !attaches.length) return 'text'
    const t = (attaches[0]._type || '').toUpperCase()
    if (t === 'PHOTO')                     return 'image'
    if (t === 'VIDEO')                     return 'video'
    if (t === 'AUDIO' || t === 'VOICE')    return 'voice'
    if (t === 'STICKER' || t === 'SMILE')  return 'sticker'
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
