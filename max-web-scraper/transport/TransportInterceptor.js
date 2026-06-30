'use strict'

// ─── Custom msgpack decoder for MAX binary protocol ───────────────────────────
// @msgpack/msgpack throws "key must be string or number" when Timestamp or
// binary-type values are used as map keys (MAX does this for some internal maps).
// This hand-rolled decoder is lenient about key types — it stringifies any key.
function maxMsgpackDecodeAll(buf) {
  const view  = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let   pos   = 0

  function readByte()    { return buf[pos++] }
  function readU8()      { const v = view.getUint8(pos);  pos += 1; return v }
  function readU16()     { const v = view.getUint16(pos); pos += 2; return v }
  function readU32()     { const v = view.getUint32(pos); pos += 4; return v }
  function readI8()      { const v = view.getInt8(pos);   pos += 1; return v }
  function readI16()     { const v = view.getInt16(pos);  pos += 2; return v }
  function readI32()     { const v = view.getInt32(pos);  pos += 4; return v }
  function readI64()     {
    const hi = view.getInt32(pos); const lo = view.getUint32(pos+4); pos += 8
    return hi * 0x100000000 + lo   // lose precision above 2^53, fine for our IDs
  }
  function readF32()     { const v = view.getFloat32(pos); pos += 4; return v }
  function readF64()     { const v = view.getFloat64(pos); pos += 8; return v }
  function readStr(len)  {
    const s = buf.slice(pos, pos + len)
    pos += len
    return Buffer.from(s).toString('utf8')
  }
  function readBin(len)  { const s = buf.slice(pos, pos + len); pos += len; return s }

  function decodeExt(len, type) {
    const data = buf.slice(pos, pos + len); pos += len
    if (type === -1) {  // Timestamp
      const sec  = (data[0]*0x1000000 + data[1]*0x10000 + data[2]*0x100 + data[3])
      return sec * 1000   // ms
    }
    if (type === 1) {   // MAX variable-length big-endian int
      let n = 0
      for (const b of data) n = n * 256 + b
      return n
    }
    return Buffer.from(data).toString('hex')
  }

  function decodeMap(n) {
    const obj = {}
    const extras = []  // entries where the key itself is a complex object
    for (let i = 0; i < n && pos < buf.length; i++) {
      const rawKey = decodeOne()
      const v = decodeOne()
      if (rawKey !== null && rawKey !== undefined && typeof rawKey === 'object') {
        extras.push({ key: rawKey, value: v })
      } else {
        obj[String(rawKey)] = v
      }
    }
    if (extras.length > 0) obj['__complexEntries'] = extras
    return obj
  }

  function decodeOne() {
    if (pos >= buf.length) return undefined
    const b = readByte()
    // positive fixint
    if (b <= 0x7f) return b
    // fixmap
    if ((b & 0xf0) === 0x80) {
      return decodeMap(b & 0x0f)
    }
    // fixarray
    if ((b & 0xf0) === 0x90) {
      const n = b & 0x0f; const arr = []
      for (let i = 0; i < n; i++) arr.push(decodeOne())
      return arr
    }
    // fixstr
    if ((b & 0xe0) === 0xa0) return readStr(b & 0x1f)
    // negative fixint
    if (b >= 0xe0) return b - 256

    switch (b) {
      case 0xc0: return null
      case 0xc2: return false
      case 0xc3: return true
      case 0xc4: { const l = readU8();  return readBin(l) }
      case 0xc5: { const l = readU16(); return readBin(l) }
      case 0xc6: { const l = readU32(); return readBin(l) }
      case 0xc7: { const l = readU8();  const t = readI8(); return decodeExt(l, t) }
      case 0xc8: { const l = readU16(); const t = readI8(); return decodeExt(l, t) }
      case 0xc9: { const l = readU32(); const t = readI8(); return decodeExt(l, t) }
      case 0xca: return readF32()
      case 0xcb: return readF64()
      case 0xcc: return readU8()
      case 0xcd: return readU16()
      case 0xce: return readU32()
      case 0xcf: { const v = readI64(); return v }
      case 0xd0: return readI8()
      case 0xd1: return readI16()
      case 0xd2: return readI32()
      case 0xd3: return readI64()
      case 0xd4: return decodeExt(1, readI8())
      case 0xd5: return decodeExt(2, readI8())
      case 0xd6: return decodeExt(4, readI8())
      case 0xd7: return decodeExt(8, readI8())
      case 0xd8: return decodeExt(16, readI8())
      case 0xd9: { const l = readU8();  return readStr(l) }
      case 0xda: { const l = readU16(); return readStr(l) }
      case 0xdb: { const l = readU32(); return readStr(l) }
      case 0xdc: {
        const n = readU16(); const arr = []
        for (let i = 0; i < n && pos < buf.length; i++) arr.push(decodeOne())
        return arr
      }
      case 0xdd: {
        const n = readU32(); const arr = []
        // guard: n > remaining bytes → garbage length from misaligned read
        if (n > buf.length - pos) return undefined
        for (let i = 0; i < n && pos < buf.length; i++) arr.push(decodeOne())
        return arr
      }
      case 0xde: return decodeMap(readU16())
      case 0xdf: {
        const n = readU32()
        if (n * 2 > buf.length - pos) return undefined
        return decodeMap(n)
      }
      default: return undefined
    }
  }

  const results = []
  while (pos < buf.length) {
    const v = decodeOne()
    if (v !== undefined) results.push(v)
  }
  return results
}

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

  window.__maxWsSendBinary = function (base64Data) {
    var ws = window.__maxWs;
    if (!ws || ws.readyState !== 1) {
      return { ok: false, error: 'WS not ready (state ' + (ws ? ws.readyState : 'null') + ')' };
    }
    try {
      var binStr = atob(base64Data);
      var bytes = new Uint8Array(binStr.length);
      for (var i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      ws.send(bytes.buffer);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
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
    this._outBinFrameSeq       = 0x8000     // наши frameSeq начинаются с 32768 (браузер использует 0–~100)
    this._myUserId             = null       // userId нашего аккаунта (из opcode 19)
    this._wsAuthHandlers       = []
    this._wsConnected          = false     // true когда WS авторизован и готов к отправке
    this._wsReadyCallbacks     = []
    this._lastSeenMsgId        = new Map() // chatId → last seen msgId (dedup for op:53 push)
    this._recentActiveChatIds  = new Map() // chatId → timestamp, обновляется из op:53
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
      } catch {
        // Binary frame: payloadData is base64-encoded binary (CDP spec for opcode=2 frames)
        try {
          const buf = Buffer.from(response.payloadData, 'base64')
          if (buf.length >= 9 && buf[0] === 0x0a) {
            const opcode  = buf[5]
            const cmd     = buf[6]
            const maxHex  = opcode === 71 ? buf.length : 20
            const hex     = [...buf.slice(0, maxHex)].map(b => b.toString(16).padStart(2,'0')).join(' ')
            console.log('[WS→MAX BIN] op:', opcode, 'cmd:', cmd, 'len:', buf.length, 'hex:', hex)
          } else if (buf.length > 0) {
            const hex = [...buf.slice(0, 20)].map(b => b.toString(16).padStart(2,'0')).join(' ')
            console.log('[WS→MAX BIN?] len:', buf.length, 'hex:', hex)
          }
        } catch {}
      }
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
      this._wsConnected = false
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
    // Диагностика: cmd:1/3 без соответствующего pending req — помогает поймать seq-mismatch
    if ((data.cmd === 1 || data.cmd === 3) && this._pendingReqs.size > 0) {
      console.log(`[Transport] cmd:${data.cmd} op:${data.opcode} seq:${data.seq} — NO pending match (pending seqs: ${[...this._pendingReqs.keys()].join(',')})`)
    }

    // op:6 HANDSHAKE — физическое WS-соединение установлено. НЕ достаточно для sends:
    // MAX может переподключиться (WS #2) и op:19 ещё не пришёл. Ждём op:19.
    if (data.opcode === OP.HANDSHAKE) {
      console.log('[Transport] WS handshake (op:6) received — waiting for op:19 before marking ready')
    }

    // Авторизация (opcode 19) — запоминаем свой userId.
    // op:19 = MAX подтвердил auth на этом WS. После него MAX обрабатывает sends (op:64).
    // Проверяем независимо от cmd (MAX слает cmd:0, cmd:2, cmd:3 в разных сценариях).
    if (data.opcode === OP.AUTH) {
      const id = data.payload?.profile?.contact?.id
      console.log(`[Auth] Opcode 19: cmd=${data.cmd}, has_profile=${!!data.payload?.profile}, userId=${id || 'none'}`)
      // Всегда помечаем WS как готовый после op:19 (auth confirmed, MAX примет op:64).
      this._wsConnected = true
      this._fireWsReady()
      if (id) {
        this._myUserId = String(id)
        console.log('[Transport] My userId:', this._myUserId)
        for (const h of this._wsAuthHandlers) try { h(this._myUserId) } catch {}
      }
    }

    // Fallback: для persistent sessions op:19 не содержит профиль,
    // но op:53 (push chats) содержит owner = наш userId.
    // Payload бывает двух видов: {"chats":[...]} или напрямую массив [...].
    // Если auth ещё не прошла — определяем userId из первого же op:53.
    if (data.opcode === 53 && !this._myUserId) {
      const chats = data.payload?.chats ?? (Array.isArray(data.payload) ? data.payload : null)
      if (Array.isArray(chats)) {
        for (const chat of chats) {
          if (chat && typeof chat === 'object' && chat.owner) {
            this._myUserId = String(chat.owner)
            console.log('[Transport] Auth via op:53 owner:', this._myUserId)
            this._wsConnected = true
            this._fireWsReady()
            for (const h of this._wsAuthHandlers) try { h(this._myUserId) } catch {}
            break
          }
        }
      }
    }

    // op:53 server push — extract new incoming messages via msgId dedup
    if (data.opcode === 53) {
      const chats = data.payload?.chats ?? (Array.isArray(data.payload) ? data.payload : null)
      if (Array.isArray(chats)) {
        for (const chat of chats) {
          if (!chat || typeof chat !== 'object') continue
          const chatId = String(chat.id || chat.chatId || '')

          // MAX msgpack encodes lastMessage using the message object as a MAP KEY.
          // Our decoder preserves these in __complexEntries: [{key: msgObj, value: ...}].
          // We look for a key that has both .id and .sender (message shape).
          let lastMsg = chat.lastMessage
          if (!lastMsg && Array.isArray(chat.__complexEntries)) {
            for (const { key } of chat.__complexEntries) {
              if (key && typeof key === 'object' && !Array.isArray(key) &&
                  key.id != null && key.sender != null) {
                lastMsg = key; break
              }
            }
          }
          // Fallback: scan plain object values for message-shaped object
          if (!lastMsg) {
            for (const val of Object.values(chat)) {
              if (val && typeof val === 'object' && !Array.isArray(val) &&
                  val.__complexEntries === undefined &&
                  val.id != null && val.sender != null) {
                lastMsg = val; break
              }
            }
          }

          if (!chatId) continue
          // Отмечаем чат как активный для запроса op:71 при следующем op:128
          this._recentActiveChatIds.set(chatId, Date.now())
          if (!lastMsg) {
            // Диагностика: показываем ключи чата чтобы понять где спрятан lastMessage
            const keys = Object.keys(chat).slice(0, 10).join(',')
            console.log(`[op53 DIAG] chat:${chatId} no lastMsg. keys: ${keys}`)
            continue
          }
          if (!lastMsg.id) continue
          const msgId = String(lastMsg.id)
          if (this._lastSeenMsgId.get(chatId) === msgId) continue
          this._lastSeenMsgId.set(chatId, msgId)
          const pseudo = { chatId, message: lastMsg }
          const msg = this._normalizeMaxMsg(pseudo)
          if (msg && !msg.isOutgoing && (msg.text || msg.attachments?.length > 0)) {
            console.log(`[Transport] op:53 new msg chat:${chatId} id:${msgId} from:${msg.from}`)
            this._emit(msg)
          }
        }
      }
    }

    // op:48 — начальный список чатов при старте браузера.
    // 1) Заполняем _recentActiveChatIds чтобы op:128 → binary op:71 знал куда запрашивать историю.
    // 2) Сразу запрашиваем binary op:71 для каждого чата — catch-up пропущенных сообщений.
    //    op:128 для старых сообщений MAX повторно НЕ шлёт, поэтому единственный путь — op:71.
    //    Браузер сам запрашивает историю только для открытого чата; мы делаем это для всех.
    if (data.opcode === 48) {
      const chats = data.payload?.chats ?? (Array.isArray(data.payload) ? data.payload : null)
      if (Array.isArray(chats)) {
        const chatIds = []
        for (const chat of chats) {
          if (!chat || typeof chat !== 'object') continue
          const chatId = String(chat.id || chat.chatId || '')
          if (!chatId || chatId === '0') continue
          this._recentActiveChatIds.set(chatId, Date.now())
          chatIds.push(chatId)
        }
        if (chatIds.length > 0) {
          console.log(`[op48] seeded _recentActiveChatIds: ${this._recentActiveChatIds.size} chats; catch-up op:71 for ${chatIds.length} chats`)
          // Небольшая задержка чтобы WS полностью инициализировался перед нашими запросами
          setTimeout(() => {
            for (const cid of chatIds) {
              this.sendBinaryOp71(cid).catch(e => console.warn(`[op48→op71] chatId:${cid}: ${e.message}`))
            }
          }, 3000)
        }
      }
    }

    // op:71 — ответ сервера на запрос истории чата.
    // Браузер шлёт op:71 cmd:1 {chatId} → MAX отвечает op:71 cmd:2/4 {chatId, messages:[]}.
    // Мы шлём op:71 при op:128-уведомлении чтобы получить контент входящего сообщения.
    // Обрабатываем ВНЕ зависимости от cmd — MAX использует cmd:2 и cmd:4 непоследовательно.
    if (data.opcode === 71 && data.payload?.chatId != null) {
      const messages = Array.isArray(data.payload.messages) ? data.payload.messages : []
      const chatIdRaw = data.payload.chatId
      console.log(`[op71] chatId:${chatIdRaw} msgs:${messages.length}`)
      for (const m of messages) {
        if (!m || typeof m !== 'object') continue
        const msg = this._normalizeMaxMsg({ chatId: chatIdRaw, message: m })
        if (msg && (msg.text || msg.attachments?.length > 0)) {
          console.log(`[op71] emit msgId:${msg.id} from:${msg.from} text:"${String(msg.text || '').slice(0, 50)}" out:${msg.isOutgoing}`)
          this._emit(msg)
        }
      }
    }

    // Raw-хэндлеры (contacts, chats, и т.д.)
    for (const h of this._rawHandlers) {
      try { h(data) } catch {}
    }

    // Presence updates — пропускаем
    if (data.opcode === OP.PRESENCE) return

    // Входящее сообщение — server push, opcode 128
    // payload может быть объектом {chatId, message} или массивом [-14, 38, {chatId, message}]
    // Новый формат [22, X, 114] — push-уведомление об unread, контент не вложен.
    if (data.opcode === OP.INCOMING_MSG) {
      const pl = Array.isArray(data.payload)
        ? data.payload.find(x => x && typeof x === 'object' && !Array.isArray(x) && x.message)
        : data.payload
      if (pl?.message) {
        const msg = this._normalizeMaxMsg(pl)
        if (msg) this._emit(msg)
      } else {
        const summary = Array.isArray(data.payload)
          ? `array[${data.payload.length}] types=${data.payload.map(x => typeof x).join(',')}`
          : typeof data.payload
        console.log(`[op128] no-message payload: ${summary} — requesting history via binary op:71`)

        // op:128 новый формат не содержит тело сообщения.
        // Запрашиваем историю бинарным op:71 для недавно-активных чатов (из op:53).
        // Бинарный op:71 работает (как браузер), JSON op:71 убивает WS.
        const recentIds = this.getRecentActiveChatIds(8_000)
        if (recentIds.length > 0) {
          console.log(`[op128] binary op:71 for ${recentIds.length} recent chats: ${recentIds.slice(0,3).join(',')}`)
          for (const cid of recentIds.slice(0, 5)) {
            this.sendBinaryOp71(cid).catch(e => console.warn(`[op128→op71bin] chatId:${cid}: ${e.message}`))
          }
        } else {
          console.log('[op128] no recent chatIds from op:53 — cannot request history')
        }
      }
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
      try {
        // Payload is a sequence of msgpack values: preamble fixints first, then the actual
        // payload object/array last. Always take the LAST value; fall back to last object.
        const values = maxMsgpackDecodeAll(payloadBuf)
        if (values.length > 0) {
          const last = values[values.length - 1]
          if (last !== null && last !== undefined && typeof last === 'object') {
            payload = last
          } else {
            // Last is a primitive — walk backwards for last non-null object
            for (let i = values.length - 2; i >= 0; i--) {
              if (values[i] !== null && typeof values[i] === 'object') {
                payload = values[i]
                break
              }
            }
          }
        }
      } catch (e) {
        const hex = [...payloadBuf.slice(0, 20)].map(b => b.toString(16).padStart(2,'0')).join(' ')
        console.log('[BIN] decode fail op:', opcode, 'hex:', hex, 'err:', e.message.slice(0, 80))
        // Retry with increasing byte offsets to handle new preamble formats (e.g. 0xdd prefix)
        let recovered = false
        for (let skip = 1; skip <= 5; skip++) {
          try {
            const alt = maxMsgpackDecodeAll(payloadBuf.slice(skip))
            if (!alt.length) continue
            const last = alt[alt.length - 1]
            if (last !== null && last !== undefined && typeof last === 'object' && !Array.isArray(last)) {
              payload = last
              console.log(`[BIN] op:${opcode} recovered with skip=${skip}`)
              recovered = true
              break
            }
          } catch {}
        }
        if (!recovered) return
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

  // ─── Бинарная отправка op:71 (GET_HISTORY) ──────────────────────────────────
  // JSON op:71 убивает WS. Браузер шлёт op:71 в бинарном формате — нам нужно то же самое.
  // Формат: [0x0a, ver=0x00, flags=0x00, frameSeqHi, frameSeqLo, 0x47=71, cmd=0x01, reqSeqHi, reqSeqLo, msgpack({chatId})]
  // ver=0x00 подтверждён: браузерный op:71 hex: 0a 00 00 16 00 47 01 00 00 ... (byte1=0x00)

  async sendBinaryOp71(chatId) {
    if (!this._page) throw new Error('No page')
    const { encode } = require('@msgpack/msgpack')
    const chatIdNum = Number(chatId)
    const payloadBytes = encode({ chatId: chatIdNum })

    const frameSeq = ++this._outBinFrameSeq
    const reqSeq   = ++this._localSeq

    const header = Buffer.alloc(9)
    header[0] = 0x0a                     // magic
    header[1] = 0x00                     // byte1=0 (browser sends 0 for op:71 requests)
    header[2] = 0x00                     // flags
    header[3] = (frameSeq >> 8) & 0xff
    header[4] = frameSeq & 0xff
    header[5] = 71                       // opcode
    header[6] = 0x01                     // cmd=1 (request)
    header[7] = (reqSeq >> 8) & 0xff
    header[8] = reqSeq & 0xff

    const frame = Buffer.concat([header, Buffer.from(payloadBytes)])
    const b64   = frame.toString('base64')

    const result = await this._page.evaluate(b => window.__maxWsSendBinary(b), b64)
    if (!result || !result.ok) throw new Error(`Binary op:71 send failed: ${result?.error}`)
    console.log(`[op71bin] sent chatId:${chatIdNum} frameSeq:${frameSeq} reqSeq:${reqSeq}`)
    return reqSeq
  }

  // ─── Отправка WS фрейма (JSON) ───────────────────────────────────────────

  /**
   * @param {number} opcode
   * @param {object} payload
   * @param {{ waitResponse?: boolean, timeoutMs?: number }} opts
   * @returns {Promise<object|void>}
   */
  async sendFrame(opcode, payload, { waitResponse = false, timeoutMs = 10_000 } = {}) {
    const seq  = ++this._localSeq
    const data = JSON.stringify({ ver: 11, cmd: 0, seq, opcode, payload })

    if (waitResponse) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this._pendingReqs.delete(seq)
          reject(new Error(`Timeout: opcode ${opcode} seq ${seq}`))
        }, timeoutMs)

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

  _fireWsReady() {
    const cbs = this._wsReadyCallbacks.splice(0)
    for (const cb of cbs) try { cb() } catch {}
  }

  /**
   * Ждёт пока WS будет авторизован и готов к отправке.
   * Если уже готов — резолвится немедленно.
   * @param {number} timeoutMs
   * @returns {Promise<boolean>} true = готов, false = timeout
   */
  waitForWsReady(timeoutMs = 15_000) {
    if (this._wsConnected) return Promise.resolve(true)
    return new Promise((resolve) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        const idx = this._wsReadyCallbacks.indexOf(cb)
        if (idx > -1) this._wsReadyCallbacks.splice(idx, 1)
        resolve(false)
      }, timeoutMs)
      const cb = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(true)
      }
      this._wsReadyCallbacks.push(cb)
    })
  }

  /**
   * Ждёт WS-подключение которое остаётся активным не менее stabilizeMs.
   * Пропускает кратковременные probe-соединения (WS #2 в тройном паттерне MAX).
   * @param {number} stabilizeMs — минимальное время стабильности (мс)
   * @param {number} timeoutMs   — общий timeout ожидания (мс)
   * @returns {Promise<boolean>}
   */
  async waitForStableWs(stabilizeMs = 400, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false

      if (!this._wsConnected) {
        const ok = await this.waitForWsReady(Math.min(remaining, 15_000))
        if (!ok) return false
      }

      // _wsConnected = true. Держим stabilizeMs, следим за обрывом.
      const stable = await new Promise(resolve => {
        let done = false
        const finish = (value) => {
          if (done) return
          done = true
          clearTimeout(stableTimer)
          clearInterval(pollId)
          resolve(value)
        }
        const stableTimer = setTimeout(() => finish(true), stabilizeMs)
        const pollId = setInterval(() => {
          if (!this._wsConnected) finish(false)
        }, 30)
      })

      if (stable) return true
      // WS оборвался во время стабилизации — ждём следующего op:19 (WS #3)
    }

    return false
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

  /**
   * Возвращает chatIds чатов из op:53 push.
   * Сначала пробует "свежие" (в пределах maxAgeMs). Если таких нет — возвращает
   * все известные, отсортированные по recency (fallback на случай если op:53
   * был давно, а op:128 пришёл спустя минуты после старта скрапера).
   */
  getRecentActiveChatIds(maxAgeMs = 10_000) {
    const now = Date.now()
    const recent = []
    for (const [chatId, ts] of this._recentActiveChatIds.entries()) {
      if (now - ts <= maxAgeMs) recent.push(chatId)
    }
    if (recent.length > 0) return recent
    // Fallback: op:53 был давно, но chatIds известны — возвращаем все по recency
    return [...this._recentActiveChatIds.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([chatId]) => chatId)
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
