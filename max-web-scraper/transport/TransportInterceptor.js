'use strict'

const fs   = require('fs')
const path = require('path')

// Persist last known message IDs across container restarts so catch-up op:71
// works even when op:48 doesn't include all chats in its startup push.
const LAST_MSG_IDS_PATH = path.join(__dirname, '..', 'user_data', 'last-msg-ids.json')

function cleanMaxString(value) {
  if (value == null) return null
  const text = String(value)
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u001F]/g, '')
    .replace(/\uFFFD/g, '')
    .trim()
  return text || null
}

function maxIdToString(value) {
  if (value == null) return null
  if (typeof value === 'string' || typeof value === 'number') return cleanMaxString(value)
  if (typeof value === 'object') {
    if (value.__maxId && value.hex) return String(value.hex)
    if (value.hex) return String(value.hex)
    if (value.id) return maxIdToString(value.id)
    if (value.fileId) return maxIdToString(value.fileId)
    if (value.videoId) return maxIdToString(value.videoId)
    if (value.mediaId) return maxIdToString(value.mediaId)
    if (value.attachmentId) return maxIdToString(value.attachmentId)
  }
  return null
}

function compareMaxIdHex(a, b) {
  const left = String(a || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase()
  const right = String(b || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase()
  if (!left || !right) return 0
  try {
    const leftInt = BigInt(`0x${left}`)
    const rightInt = BigInt(`0x${right}`)
    return leftInt === rightInt ? 0 : (leftInt > rightInt ? 1 : -1)
  } catch {
    const maxLen = Math.max(left.length, right.length)
    const lp = left.padStart(maxLen, '0')
    const rp = right.padStart(maxLen, '0')
    return lp === rp ? 0 : (lp > rp ? 1 : -1)
  }
}

function isUsableMaxMessageHex(hex) {
  const clean = String(hex || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase()
  return clean.length >= 18 && clean.startsWith('d301')
}

function selectPendingLiveDomCandidates(candidates, pendingCount) {
  const limit = Math.max(0, Math.floor(Number(pendingCount) || 0))
  if (!limit || !Array.isArray(candidates)) return []

  return candidates
    .filter(candidate => {
      if (!candidate?.text || candidate.attachments?.length) return false
      if (candidate.isOutgoing) return false
      if (candidate.viewportW && candidate.x > candidate.viewportW * 0.55) return false
      return Number.isFinite(candidate.displayMinute)
    })
    .slice(-limit)
}

function walkMaxValue(value, visit, seen = new Set(), depth = 0) {
  if (value == null || depth > 8) return
  if (typeof value !== 'object') {
    visit(null, value)
    return
  }
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach(item => walkMaxValue(item, visit, seen, depth + 1))
    return
  }
  for (const [key, item] of Object.entries(value)) {
    visit(key, item)
    if (key === '__complexEntries') {
      if (Array.isArray(item)) {
        for (const entry of item) {
          walkMaxValue(entry?.key, visit, seen, depth + 1)
          walkMaxValue(entry?.value, visit, seen, depth + 1)
        }
      }
      continue
    }
    walkMaxValue(item, visit, seen, depth + 1)
  }
}

function findUrlParamInString(value, names) {
  const raw = cleanMaxString(value)
  if (!raw) return null
  const candidates = [raw]
  try { candidates.push(decodeURIComponent(raw)) } catch {}
  for (const text of candidates) {
    for (const name of names) {
      const match = text.match(new RegExp(`(?:^|[?&=]|%3F|%26|%3D)${name}(?:=|%3D)([A-Za-z0-9._:-]+)`, 'i'))
      if (match?.[1]) return match[1]
    }
  }
  return null
}

function findNestedMediaId(value, names) {
  let found = null
  walkMaxValue(value, (key, item) => {
    if (found) return
    const keyText = String(key || '')
    if (names.some(name => keyText.toLowerCase().includes(name.toLowerCase()))) {
      const id = maxIdToString(item)
      if (id) found = id
    }
    if (typeof item === 'string') {
      const fromUrl = findUrlParamInString(item, names)
      if (fromUrl) found = fromUrl
    }
  })
  return found
}

function mediaMimeFromAttachment(raw, type) {
  const explicit = cleanMaxString(raw?.mimeType || raw?.type)
  if (explicit && explicit.includes('/')) return explicit
  const name = cleanMaxString(raw?.name || raw?.filename)
  if (/\.ogg\b/i.test(name || '')) return 'audio/ogg'
  if (/\.mp4\b/i.test(name || '')) return 'video/mp4'
  if (type === 'audio' || type === 'voice') return 'audio/ogg'
  if (type === 'video') return 'video/mp4'
  return explicit || null
}

function cleanMaxFilename(rawName, previewTitle, rawType = '') {
  const raw = cleanMaxString(rawName)
  const title = cleanMaxString(previewTitle)
  const type = String(rawType || '').toUpperCase()

  const extMatch = raw?.match(/[A-Za-z0-9._-]+\.(ogg|opus|mp3|mp4|mov|jpe?g|png|webp|gif|pdf)\b/i)
  let name = extMatch ? extMatch[0] : raw

  if (title && type === 'MUSIC' && (!name || /^[-_\d.]*ogg\b/i.test(name) || !/\.ogg\b/i.test(name))) {
    name = /\.ogg\b/i.test(title) ? title : `${title}.ogg`
  } else if (title && type === 'VIDEO' && (!name || !/\.(mp4|mov)\b/i.test(name))) {
    name = /\.(mp4|mov)\b/i.test(title) ? title : `${title}.mp4`
  }

  return name || null
}

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
      // 9-byte form: data[0] is a nested msgpack numeric type marker (0xcf=uint64, 0xd3=int64).
      // These are large message IDs (> 2^53) that lose precision as float64.
      // Return raw bytes so callers can reconstruct the exact ext8 for op:71 requests.
      if (data.length === 9 && (data[0] === 0xcf || data[0] === 0xd3)) {
        return { __maxId: true, hex: Buffer.from(data).toString('hex') }
      }
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

function findMsgpackFieldValue(buf, fieldName) {
  if (!Buffer.isBuffer(buf) || !fieldName) return null
  const key = Buffer.from(String(fieldName), 'utf8')
  if (key.length === 0 || key.length >= 32) return null
  const marker = Buffer.concat([Buffer.from([0xa0 | key.length]), key])
  const index = buf.indexOf(marker)
  if (index < 0) return null
  const values = maxMsgpackDecodeAll(buf.slice(index + marker.length))
  return values.length > 0 ? values[0] : null
}

function findMsgpackIdFieldValue(buf, fieldName) {
  if (!Buffer.isBuffer(buf) || !fieldName) return null
  const key = Buffer.from(String(fieldName), 'utf8')
  if (key.length === 0 || key.length >= 32) return null
  const fieldMarker = Buffer.concat([Buffer.from([0xa0 | key.length]), key])
  const fieldIndex = buf.indexOf(fieldMarker)
  if (fieldIndex < 0) return null
  const valueOffset = fieldIndex + fieldMarker.length
  if (valueOffset >= buf.length) return null

  const canonicalInt64 = dataOffset => {
    if (dataOffset < 0 || dataOffset + 8 > buf.length) return null
    return {
      __maxId: true,
      hex: Buffer.concat([Buffer.from([0xd3]), buf.slice(dataOffset, dataOffset + 8)]).toString('hex'),
    }
  }

  const marker = buf[valueOffset]
  if (marker === 0xd3 || marker === 0xcf) {
    return canonicalInt64(valueOffset + 1)
  }

  if (marker === 0xc7 && valueOffset + 3 <= buf.length) {
    const length = buf[valueOffset + 1]
    const type = buf.readInt8(valueOffset + 2)
    const dataOffset = valueOffset + 3
    if (type === 1 && length === 9 && (buf[dataOffset] === 0xd3 || buf[dataOffset] === 0xcf)) {
      return canonicalInt64(dataOffset + 1)
    }
    if (type === 1 && length === 8) {
      return canonicalInt64(dataOffset)
    }
  }

  if (marker === 0xd7 && valueOffset + 10 <= buf.length && buf.readInt8(valueOffset + 1) === 1) {
    return canonicalInt64(valueOffset + 2)
  }

  return findMsgpackFieldValue(buf, fieldName)
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
    this._browserLastBinFrameSeq = 0        // последний fseq из браузерных бинарных фреймов; наши op:71 используют +1
    this._op71Prefix           = null       // 3-байт префикс из браузерного op:71, захватывается динамически
    this._myUserId             = null       // userId нашего аккаунта (из opcode 19)
    this._wsAuthHandlers       = []
    this._wsConnected          = false     // true когда WS авторизован и готов к отправке
    this._wsReadyCallbacks     = []
    this._lastSeenMsgId        = new Map() // chatId → last seen msgId (dedup for op:53 push)
    this._emittedMsgIds        = new Map() // messageId -> timestamp, cross-source dedup for op:53/op:71/op:128
    this._recentActiveChatIds  = new Map() // chatId → timestamp, обновляется из op:53
    this._lastMsgRawHex        = new Map() // chatId → raw hex bytes of lastMessage ID ext8 data
    this._confirmedMessageAnchorAt = new Map() // chatId → runtime confirmation timestamp; persisted anchors are not live proof
    this._catchUpChatIds       = new Map() // chatId → retryCount; populated from op:48, cleared when op:71 responds
    this._pendingNewMsgIds     = []        // msgId hex values from bare op:128 before chatId is known
    this._pendingLiveMessageIds = new Map() // chatId -> [{pendingHex, ts}], not an op:71 anchor until confirmed
    this._pendingLiveDrainTimers = new Map() // chatId -> timer for draining remaining live pending ids
    this._recentOp128ChatIds   = new Map() // chatId -> timestamp for DOM fallback after empty op:71
    this._recentOp128EventsByChat = new Map() // chatId -> recent op:128 mark timestamps for live DOM recovery budgets
    this._lastDirectBackfillAt = new Map()
    this._pendingOp71ChatIds   = []
    this._pendingLooseMedia    = []
    this._activeUiChatId       = null

    // Load persisted message IDs from previous sessions.
    // This lets us catch up chats that op:48 doesn't include in its startup push.
    try {
      const saved = JSON.parse(fs.readFileSync(LAST_MSG_IDS_PATH, 'utf8'))
      let skippedInvalid = 0
      for (const [cid, hex] of Object.entries(saved)) {
        if (!this._rememberConfirmedMessageAnchor(cid, hex, { markSeen: true, confirmedAt: 0 })) {
          skippedInvalid += 1
        }
      }
      console.log(`[Transport] Loaded ${this._lastMsgRawHex.size} persisted msg IDs from disk for passive catch-up`)
      if (skippedInvalid > 0) {
        console.warn(`[Transport] Ignored ${skippedInvalid} invalid persisted message anchor(s)`)
      }
    } catch {
      // File doesn't exist yet — first run
    }
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
            const fseq    = (buf[2] << 8) | buf[3]
            // Отслеживаем последний fseq (browser + наши фреймы) — op:71 использует max+1
            if (fseq > this._browserLastBinFrameSeq) this._browserLastBinFrameSeq = fseq
            // Захватываем 3-байт префикс из первого op:71 (браузер шлёт его раньше нашего catch-up)
            if (opcode === 71 && buf.length > 11 && !this._op71Prefix) {
              this._op71Prefix = [buf[9], buf[10], buf[11]]
              console.log(`[op71prefix] captured: ${this._op71Prefix.map(b => b.toString(16).padStart(2,'0')).join(' ')} fseq:${fseq}`)
            }
            // op:128 cmd:1 (browser mark-as-received) contains chatId in payload.
            // MAX doesn't send op:130 unless the user has the chat open, so this
            // outgoing frame is the only reliable source of chatId after op:128 empty notification.
            if (opcode === 0x80 && cmd === 0x01 && buf.length > 12) {
              try {
                // Payload starts after 9-byte header + 3-byte prefix = byte 12
                const decoded = maxMsgpackDecodeAll(buf.slice(12))
                const rawChatId = decoded?.chatId ?? decoded?.[0]?.chatId
                if (rawChatId != null && rawChatId !== 0) {
                  // Browser encodes chatId as lower 32 bits only. Resolve full chatId
                  // via _recentActiveChatIds (populated from op:48 with full chatIds),
                  // then fall back to _lastMsgRawHex keys (populated from persistent storage).
                  const shortId = Number(rawChatId) >>> 0
                  let chatIdStr = String(rawChatId)
                  for (const [cid] of this._recentActiveChatIds) {
                    if ((Number(cid) >>> 0) === shortId) { chatIdStr = cid; break }
                  }
                  if (chatIdStr === String(rawChatId)) {
                    // Not found in _recentActiveChatIds — try _lastMsgRawHex (persisted IDs)
                    for (const cid of this._lastMsgRawHex.keys()) {
                      if ((Number(cid) >>> 0) === shortId) { chatIdStr = cid; break }
                    }
                  }
                  console.log(`[op128mark] browser marked shortId:0x${shortId.toString(16)} → chatId:${chatIdStr}`)
                  this._rememberRecentOp128Chat(chatIdStr)
                  // If one or more bare op:128 notifications arrived before the
                  // browser mark frame exposed chatId, move all queued provider ids
                  // into the chat-specific pending queue in original order.
                  const registrations = this._registerPreChatPendingForChat(chatIdStr)
                  if (registrations.length > 0) {
                    console.log(`[op128mark] registered ${registrations.length} pending live msg(s) for chatId:${chatIdStr} ids:${registrations.map(r => r.pendingHex.slice(0,16)).join(',')}`)
                  }
                  console.log(`[op128mark] active op71 disabled; guarded DOM recovery will handle gaps for chatId:${chatIdStr}`)
                }
              } catch (e) {
                console.warn('[op128mark→op71] decode error:', e.message)
              }
            }
            // A live video notification may not expose its d301 message id in
            // op:128/op:180. MAX Web immediately follows it with a binary
            // op:83 request containing {chatId, messageId, videoId}. Correlate
            // that browser-owned request only while fresh loose media exists.
            if (opcode === OP.RESOLVE_VIDEO && cmd === 0x01 && buf.length > 9) {
              try {
                const request = this._decodeBrowserVideoResolveRequest(buf)
                const correlation = this._handleBrowserVideoResolveRequest(request)
                if (correlation?.emitted) {
                  console.log(`[op83live] provider media emitted chatId:${correlation.chatId} id:${correlation.messageId}`)
                } else if (this.hasRecentLooseMediaForDomRecovery({ maxAgeMs: 5000 })) {
                  console.warn(`[op83live] live media not correlated reason:${correlation?.reason || 'unknown'}`)
                }
              } catch (e) {
                console.warn('[op83live] request correlation failed:', e.message)
              }
            }
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

  _isEmptyObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
  }

  _isMessageLike(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
      && (value.id != null || value.text != null || Array.isArray(value.attaches) || value.link?.message)
      && (value.sender != null || value.id != null)
  }

  _extractMessagesDeep(value, out = [], seen = new Set(), depth = 0) {
    if (value == null || depth > 10) return out
    if (this._isMessageLike(value)) {
      const key = value.id?.hex || value.id || `${value.sender || ''}:${value.text || ''}:${out.length}`
      if (!seen.has(String(key))) {
        seen.add(String(key))
        out.push(value)
      }
    }
    if (Array.isArray(value)) {
      for (const item of value) this._extractMessagesDeep(item, out, seen, depth + 1)
      return out
    }
    if (typeof value === 'object') {
      if (Array.isArray(value.__complexEntries)) {
        for (const entry of value.__complexEntries) {
          this._extractMessagesDeep(entry?.key, out, seen, depth + 1)
          this._extractMessagesDeep(entry?.value, out, seen, depth + 1)
        }
      }
      for (const [key, item] of Object.entries(value)) {
        if (key === '__complexEntries') continue
        this._extractMessagesDeep(item, out, seen, depth + 1)
      }
    }
    return out
  }

  _extractChatIdDeep(value, depth = 0) {
    if (value == null || depth > 8) return null
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this._extractChatIdDeep(item, depth + 1)
        if (found != null) return found
      }
      return null
    }
    if (typeof value !== 'object') return null
    if (value.chatId != null) return value.chatId
    if (Array.isArray(value.__complexEntries)) {
      for (const entry of value.__complexEntries) {
        const found = this._extractChatIdDeep(entry?.key, depth + 1) ?? this._extractChatIdDeep(entry?.value, depth + 1)
        if (found != null) return found
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === '__complexEntries') continue
      const found = this._extractChatIdDeep(item, depth + 1)
      if (found != null) return found
    }
    return null
  }

  _findProtocolPayloadDeep(value, requiredKeys, depth = 0) {
    if (value == null || depth > 10 || Buffer.isBuffer(value)) return null
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this._findProtocolPayloadDeep(item, requiredKeys, depth + 1)
        if (found) return found
      }
      return null
    }
    if (typeof value !== 'object') return null
    if (requiredKeys.every(key => Object.prototype.hasOwnProperty.call(value, key))) return value
    if (Array.isArray(value.__complexEntries)) {
      for (const entry of value.__complexEntries) {
        const found = this._findProtocolPayloadDeep(entry?.key, requiredKeys, depth + 1)
          || this._findProtocolPayloadDeep(entry?.value, requiredKeys, depth + 1)
        if (found) return found
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === '__complexEntries') continue
      const found = this._findProtocolPayloadDeep(item, requiredKeys, depth + 1)
      if (found) return found
    }
    return null
  }

  _decodeBrowserVideoResolveRequest(frame) {
    if (!Buffer.isBuffer(frame) || frame.length <= 9) return null
    const payload = frame.slice(9)
    return {
      videoId: findMsgpackFieldValue(payload, 'videoId'),
      chatId: findMsgpackFieldValue(payload, 'chatId'),
      messageId: findMsgpackIdFieldValue(payload, 'messageId'),
    }
  }

  _resolveKnownChatId(rawChatId) {
    const raw = maxIdToString(rawChatId)
    if (!raw) return null
    const shortId = Number(raw) >>> 0
    for (const source of [this._recentOp128ChatIds, this._recentActiveChatIds, this._lastMsgRawHex]) {
      for (const cid of source.keys()) {
        if (String(cid) === raw || (Number(cid) >>> 0) === shortId) return String(cid)
      }
    }
    return raw
  }

  _singleRecentOp128ChatId(maxAgeMs = 5000) {
    const now = Date.now()
    const recent = [...this._recentOp128ChatIds.entries()]
      .filter(([, seenAt]) => seenAt && now - seenAt <= maxAgeMs)
      .sort((a, b) => b[1] - a[1])
    return recent.length === 1 ? String(recent[0][0]) : null
  }

  _handleBrowserVideoResolveRequest(decodedPayload, { maxAgeMs = 5000 } = {}) {
    const request = this._findProtocolPayloadDeep(decodedPayload, ['videoId', 'messageId', 'chatId'])
    if (!request) return { emitted: false, reason: 'request_payload_not_found' }

    const messageId = maxIdToString(request.messageId)
    if (!isUsableMaxMessageHex(messageId)) return { emitted: false, reason: 'invalid_provider_message_id' }

    const now = Date.now()
    let chatId = this._resolveKnownChatId(request.chatId)
    const recentChatId = this._singleRecentOp128ChatId(maxAgeMs)
    const seenAt = chatId ? this._recentOp128ChatIds.get(chatId) : 0
    if ((!seenAt || now - seenAt > maxAgeMs) && recentChatId) chatId = recentChatId
    const correlatedAt = chatId ? this._recentOp128ChatIds.get(chatId) : 0
    if (!chatId || !correlatedAt || now - correlatedAt > maxAgeMs) {
      return { emitted: false, reason: 'no_recent_live_op128' }
    }
    if (!this.hasRecentLooseMediaForDomRecovery({ maxAgeMs })) {
      return { emitted: false, reason: 'no_recent_loose_media' }
    }

    const confirmedAnchor = this._lastMsgRawHex.get(chatId) || null
    const confirmedAt = this._confirmedMessageAnchorAt.get(chatId) || 0
    const matchesFreshConfirmedAnchor = isUsableMaxMessageHex(confirmedAnchor)
      && compareMaxIdHex(messageId, confirmedAnchor) === 0
      && confirmedAt >= correlatedAt
      && now - confirmedAt <= maxAgeMs

    const videoId = maxIdToString(request.videoId)
    const recentLooseVideoIds = new Set()
    for (const entry of this._pendingLooseMedia) {
      if (!entry?.ts || now - entry.ts > maxAgeMs) continue
      for (const item of entry.items || []) {
        const pendingVideoId = maxIdToString(item?.videoId)
        if (pendingVideoId) recentLooseVideoIds.add(pendingVideoId)
      }
    }
    if (videoId && recentLooseVideoIds.size > 0 && !recentLooseVideoIds.has(videoId) && !matchesFreshConfirmedAnchor) {
      return { emitted: false, reason: 'video_id_mismatch' }
    }

    return {
      ...this.emitPendingLooseMediaMessage(chatId, messageId, { maxAgeMs }),
      chatId,
      messageId,
      videoId,
    }
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
    if ([1, 2, 3, 4].includes(data.cmd) && this._pendingReqs.has(data.seq)) {
      const { resolve, reject, timeout } = this._pendingReqs.get(data.seq)
      clearTimeout(timeout)
      this._pendingReqs.delete(data.seq)
      if (data.cmd === 3 || data.payload?.error || data.payload?.localizedMessage) {
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
      } else {
        const chatIdRaw = this._extractChatIdDeep(data.payload) ?? this._activeUiChatId
        const messages = this._extractMessagesDeep(data.payload)
        if (chatIdRaw != null && messages.length > 0) {
          const chatId = String(chatIdRaw)
          this._recentActiveChatIds.set(chatId, Date.now())
          for (const candidate of messages) {
            if (!candidate?.id) continue
            const msgId = candidate.id.__maxId ? candidate.id.hex : String(candidate.id)
            if (this._lastSeenMsgId.get(chatId) === msgId) continue
            this._lastSeenMsgId.set(chatId, msgId)
            const pseudo = { chatId, message: candidate }
            this._consumeLooseMediaForMessage(pseudo)
            const msg = this._normalizeMaxMsg(pseudo)
            if (msg && (msg.text || msg.attachments?.length > 0)) {
              console.log(`[Transport] op:53 deep msg chat:${chatId} id:${msgId.slice(0,16)} from:${msg.from} out:${msg.isOutgoing}`)
              this._emit(msg)
            }
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

          const candidates = []
          const candidateKeys = new Set()
          const addCandidate = (m) => {
            if (!m || typeof m !== 'object' || !m.id) return
            const key = m.id.__maxId ? m.id.hex : String(m.id)
            if (candidateKeys.has(key)) return
            candidateKeys.add(key)
            candidates.push(m)
          }
          addCandidate(lastMsg)
          for (const m of this._extractMessagesDeep(chat)) addCandidate(m)
          if (!candidates.length) continue

          // _lastMsgRawHex is intentionally NOT updated from op:53 to avoid a race condition:
          // op:53 fires after a new message arrives (updating to the new msg's ID), but op:130
          // fires shortly after and needs the PREVIOUS ID to request messages newer than it.
          // _lastMsgRawHex is only updated from op:48 (startup) and op:71 responses (confirmed fetch).
          for (const candidate of candidates) {
            const msgId = candidate.id.__maxId ? candidate.id.hex : String(candidate.id)
            if (this._lastSeenMsgId.get(chatId) === msgId) continue
            this._lastSeenMsgId.set(chatId, msgId)
            const pseudo = { chatId, message: candidate }
            this._consumeLooseMediaForMessage(pseudo)
            const msg = this._normalizeMaxMsg(pseudo)
            if (msg && (msg.text || msg.attachments?.length > 0)) {
              console.log(`[Transport] op:53 new msg chat:${chatId} id:${msgId.slice(0,16)} from:${msg.from} out:${msg.isOutgoing}`)
              this._emit(msg)
            }
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
          // Extract lastMessage ID raw bytes so sendBinaryOp71 can use the real message ID
          let lastMsg = chat.lastMessage
          if (!lastMsg && Array.isArray(chat.__complexEntries)) {
            for (const { key } of chat.__complexEntries) {
              if (key && typeof key === 'object' && !Array.isArray(key) &&
                  key.id != null && key.sender != null) {
                lastMsg = key; break
              }
            }
          }
          if (!lastMsg && typeof chat === 'object') {
            for (const val of Object.values(chat)) {
              if (val && typeof val === 'object' && !Array.isArray(val) &&
                  val.__complexEntries === undefined &&
                  val.id != null && val.sender != null) {
                lastMsg = val; break
              }
            }
          }
          if (lastMsg?.id?.__maxId) {
            const newHex   = lastMsg.id.hex
            // Store the REAL lastMessage ID as anchor. Op:71 returns messages with ID >= anchor
            // (inclusive). The dedup in op:71 response skips the anchor itself via _lastSeenMsgId.
            if (this._rememberConfirmedMessageAnchor(chatId, newHex, { markSeen: true })) {
              console.log(`[op48] chatId:${chatId} anchor ${newHex.slice(0,16)} (lastMsg)`)
            }
          }
          // Also scan __complexEntries: MAX stores message IDs as MAP KEYs → {__maxId, hex} after decodeExt fix
          if (Array.isArray(chat.__complexEntries)) {
            let bestHex = null
            for (const { key } of chat.__complexEntries) {
              if (key?.__maxId && isUsableMaxMessageHex(key.hex)) {
                if (!bestHex || compareMaxIdHex(key.hex, bestHex) > 0) bestHex = key.hex
              }
            }
            if (bestHex) {
              if (this._rememberConfirmedMessageAnchor(chatId, bestHex, { markSeen: true })) {
                console.log(`[op48] chatId:${chatId} MAP KEY anchor ${bestHex.slice(0,16)}`)
              }
            }
          }
        }
        if (chatIds.length > 0) {
          console.log(`[op48] seeded _recentActiveChatIds: ${this._recentActiveChatIds.size} chats; catch-up op:71 for ${chatIds.length} chats`)
          // Persist any newly-learned msg IDs to disk right away
          if (this._lastMsgRawHex.size > 0) {
            try {
              fs.mkdirSync(path.dirname(LAST_MSG_IDS_PATH), { recursive: true })
              fs.writeFileSync(LAST_MSG_IDS_PATH, JSON.stringify(Object.fromEntries(this._lastMsgRawHex)))
              console.log(`[op48] persisted ${this._lastMsgRawHex.size} msg ID(s) to disk`)
            } catch (e) { console.warn('[Transport] Failed to persist msg IDs:', e.message) }
          }
          // Active op:71 injection is intentionally disabled. MAX closes the
          // browser socket for these synthetic frames; browser-driven op:49/op:71
          // responses and guarded DOM recovery remain the passive catch-up paths.
        }
      }
    }

    // op:71 — ответ сервера на запрос истории чата.
    // Браузер шлёт op:71 cmd:1 {chatId} → MAX отвечает op:71 cmd:2/4 {chatId, messages:[]}.
    // Мы шлём op:71 при op:128-уведомлении чтобы получить контент входящего сообщения.
    // Обрабатываем ВНЕ зависимости от cmd — MAX использует cmd:2 и cmd:4 непоследовательно.
    if (data.opcode === 71 && (data.payload?.chatId != null || Array.isArray(data.payload) || Array.isArray(data.payload?.__complexEntries) || this._isEmptyObject(data.payload))) {
      const arrayPayload = Array.isArray(data.payload)
      const arrayEnvelope = arrayPayload
        ? data.payload.find(x => x && typeof x === 'object' && !Array.isArray(x) && (x.chatId != null || Array.isArray(x.messages)))
        : null
      const complexPayload = !arrayPayload && Array.isArray(data.payload?.__complexEntries)
      const complexMessages = complexPayload
        ? data.payload.__complexEntries
            .map(entry => {
              const key = entry?.key
              const value = entry?.value
              if (key && typeof key === 'object' && (key.id != null || key.text != null || Array.isArray(key.attaches))) return key
              if (value && typeof value === 'object' && (value.id != null || value.text != null || Array.isArray(value.attaches))) return value
              return null
            })
            .filter(Boolean)
        : []
      let messages = arrayEnvelope
        ? (Array.isArray(arrayEnvelope.messages) ? arrayEnvelope.messages : [])
        : (arrayPayload
          ? data.payload.filter(x => x && typeof x === 'object' && !Array.isArray(x) && (x.id != null || x.text != null || Array.isArray(x.attaches)))
          : (Array.isArray(data.payload.messages) ? data.payload.messages : complexMessages))
      if ((!messages || messages.length === 0) && data.payload && !this._isEmptyObject(data.payload)) {
        messages = this._extractMessagesDeep(data.payload)
      }
      const chatIdRaw = arrayEnvelope?.chatId
        ?? (arrayPayload ? this._pendingOp71ChatIds.shift() : (data.payload.chatId ?? this._extractChatIdDeep(data.payload) ?? ((complexPayload || this._isEmptyObject(data.payload)) ? this._pendingOp71ChatIds.shift() : null)))
      if (chatIdRaw == null) {
        console.warn(`[op71] payload has messages but no chatId; msgs=${messages.length}`)
        return
      }
      const chatIdStr = String(chatIdRaw)
      if (this._isEmptyObject(data.payload)) {
        data.payload = { chatId: chatIdStr, messages: [] }
      }
      console.log(`[op71] chatId:${chatIdRaw} msgs:${messages.length}`)
      let bestMsgHex = null
      for (const m of messages) {
        if (!m || typeof m !== 'object') continue
        const pseudo = { chatId: chatIdRaw, message: m }
        this._consumeLooseMediaForMessage(pseudo)
        const msg = this._normalizeMaxMsg(pseudo)
        if (!msg) continue
        // Dedup against op:53: if op:53 already emitted this message, skip
        const msgIdStr = msg.id || null
        if (msgIdStr && this._lastSeenMsgId.get(chatIdStr) === msgIdStr) continue
        if (msgIdStr) this._lastSeenMsgId.set(chatIdStr, msgIdStr)
        // Track max ID seen in this response to advance the stored pointer
        if (m.id?.__maxId) {
          if (!bestMsgHex || m.id.hex.slice(2) > bestMsgHex.slice(2)) bestMsgHex = m.id.hex
        }
        if (msg.text || msg.attachments?.length > 0) {
          console.log(`[op71] emit msgId:${msg.id} from:${msg.from} text:"${String(msg.text || '').slice(0, 50)}" out:${msg.isOutgoing}`)
          this._emit(msg)
        }
      }
      // Advance stored pointer so the next op:71 request doesn't re-fetch the same messages
      if (bestMsgHex && this._advanceLastMsgAfterOp71(chatIdStr, bestMsgHex)) {
        console.log(`[op71] advanced stored msgId for chatId:${chatIdStr}: ${bestMsgHex.slice(0,16)}`)
      }
      const catchUpState = this._finalizeOp71CatchUpState(chatIdStr)
      if (catchUpState.pendingLiveCount > 0) {
        console.log(`[op71] pending live drain retained chatId:${chatIdStr} remaining:${catchUpState.pendingLiveCount}`)
      }
    }

    // Raw-хэндлеры (contacts, chats, и т.д.)
    // op:49 — browser-driven history load when the UI opens a chat route.
    // MAX often sends media/text history here while our active catch-up op:71
    // response stays empty. Use the currently opened UI chat as chatId fallback.
    if (data.opcode === OP.GET_HISTORY && (data.payload?.chatId != null || Array.isArray(data.payload) || Array.isArray(data.payload?.messages) || Array.isArray(data.payload?.__complexEntries))) {
      const arrayPayload = Array.isArray(data.payload)
      const arrayEnvelope = arrayPayload
        ? data.payload.find(x => x && typeof x === 'object' && !Array.isArray(x) && (x.chatId != null || Array.isArray(x.messages)))
        : null
      let messages = arrayEnvelope
        ? (Array.isArray(arrayEnvelope.messages) ? arrayEnvelope.messages : [])
        : (arrayPayload
          ? data.payload.filter(x => x && typeof x === 'object' && !Array.isArray(x) && (x.id != null || x.text != null || Array.isArray(x.attaches)))
          : (Array.isArray(data.payload.messages) ? data.payload.messages : []))
      if ((!messages || messages.length === 0) && data.payload) {
        messages = this._extractMessagesDeep(data.payload)
      }
      const chatIdRaw = arrayEnvelope?.chatId ?? data.payload?.chatId ?? this._extractChatIdDeep(data.payload) ?? this._activeUiChatId
      if (chatIdRaw != null && messages.length > 0) {
        const chatIdStr = String(chatIdRaw)
        console.log(`[op49] active history chatId:${chatIdStr} msgs:${messages.length}`)
        for (const m of messages) {
          if (!m || typeof m !== 'object') continue
          const pseudo = { chatId: chatIdStr, message: m }
          this._consumeLooseMediaForMessage(pseudo)
          const msg = this._normalizeMaxMsg(pseudo)
          if (!msg || (!msg.text && !msg.attachments?.length)) continue
          const msgIdStr = msg.id || null
          const storedHex = this._lastMsgRawHex.get(chatIdStr)
          if (msgIdStr && isUsableMaxMessageHex(storedHex) && compareMaxIdHex(msgIdStr, storedHex) <= 0) {
            console.log(`[op49] skip stale msgId:${String(msgIdStr).slice(0,16)} anchor:${String(storedHex).slice(0,16)} text:"${String(msg.text || '').slice(0, 50)}"`)
            continue
          }
          if (msgIdStr && this._lastSeenMsgId.get(chatIdStr) === msgIdStr) continue
          if (msgIdStr) this._lastSeenMsgId.set(chatIdStr, msgIdStr)
          console.log(`[op49] emit msgId:${msg.id} from:${msg.from} text:"${String(msg.text || '').slice(0, 50)}"`)
          this._emit(msg)
        }
      }
    }

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
        this._consumeLooseMediaForMessage(pl)
        if ((!Array.isArray(pl.message.attaches) || pl.message.attaches.length === 0) && this._looksLikeMediaPayload(pl)) {
          this._writeDebugJson('max_op128_message_media_no_attach.jsonl', pl)
        }
        const msg = this._normalizeMaxMsg(pl)
        // Advance stored pointer so next restart doesn't re-fetch this message via catch-up
        if (pl.message?.id?.__maxId && pl.chatId != null) {
          const cidStr = String(pl.chatId)
          const hex = pl.message.id.hex
          const stored = this._op71AnchorForLiveNotification(cidStr) || ''
          if (this._rememberConfirmedMessageAnchor(cidStr, hex, { markSeen: true })) {
            try {
              fs.writeFileSync(LAST_MSG_IDS_PATH, JSON.stringify(Object.fromEntries(this._lastMsgRawHex)))
            } catch {}
            if (stored) this._scheduleDirectBackfill(cidStr, stored, hex)
          }
        }
        if (msg) this._emit(msg)
      } else {
        // op:128 новый формат: только уведомление об unread, без тела сообщения.
        // Если payload содержит ext8 ID нового сообщения — сохраняем как near-anchor для op:71.
        const pendingHex = this._findMaxIdHex(data.payload)
        if (pendingHex) {
          const remembered = this._rememberPreChatPendingMessageId(pendingHex)
          if (remembered.registered) {
            console.log(`[op128] new msg ID queued: ${pendingHex.slice(0,16)} queue:${remembered.queueLength}`)
          } else {
            console.log(`[op128] ignored pending msg ID ${pendingHex.slice(0,16)}: ${remembered.reason}`)
          }
        } else {
          const payloadSnap = JSON.stringify(data.payload).slice(0, 200)
          console.log(`[op128] new msg notification — waiting for op:130 with chatId. payload:${payloadSnap}`)
        }
        if (this._looksLikeMediaPayload(data.payload)) {
          this._pushLooseMedia(data.payload)
          this._writeDebugJson('max_op128_loose_media.jsonl', data.payload)
        }
      }
    }

    // op:130 — сервер подтверждает mark-as-read; payload содержит chatId чата с новым сообщением.
    // Браузер автоматически шлёт op:128 (mark) → сервер отвечает op:130 с chatId.
    // Мы используем chatId для точечного binary op:71, который вернёт контент нового сообщения.
    if (data.opcode === 130) {
      const chatId = data.payload?.chatId != null ? String(data.payload.chatId) : null
      if (chatId && chatId !== '0') {
        console.log(`[op130] mark confirm chatId:${chatId}`)
        this._rememberRecentOp128Chat(chatId)
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
    let attaches = Array.isArray(m.attaches) ? m.attaches : []
    if (!attaches.length && Array.isArray(payload.attaches)) {
      const rootToken = payload.token || payload['110'] || null
      attaches = payload.attaches.map(att => ({
        ...att,
        token: att?.token || rootToken || null,
        _rootMediaToken: rootToken || null,
      }))
    }

    // Forwarded messages: content lives in m.link.message, not in m.text/m.attaches.
    // Without this, text='' + attaches=[] → webhook skips with 'empty_text'.
    if (m.link?.type === 'FORWARD' && m.link.message) {
      const fwd = m.link.message
      if (!text) text = fwd.text || ''
      if (!attaches.length && fwd.attaches?.length > 0) attaches = fwd.attaches
      if (!text && !attaches.length) text = '[Переслано]'
    }

    const hasAttaches = Array.isArray(attaches) && attaches.length > 0
    const direction = String(m.direction || m.dir || '').toUpperCase()
    const protocolOutgoing = (
      m.out === 1        || m.out === true       ||
      m.is_out === 1     || m.is_out === true    ||
      m.fromMe === true  || m.outgoing === true  ||
      m.isOutgoing === true ||
      direction === 'OUT' || direction === 'OUTGOING'
    )

    return {
      id:                m.id?.__maxId ? m.id.hex : (m.id || null),
      chatId:            payload.chatId || null,
      from:              String(m.sender || ''),
      text,
      timestamp:         m.time  || Date.now(),
      type:              hasAttaches ? this._detectMaxType(attaches) : 'text',
      attachments:       this._extractMaxAttachmentsV2(attaches),
      isOutgoing:        this._myUserId ? String(m.sender) === this._myUserId : protocolOutgoing,
      replyToMessageId:  (m.link?.type === 'REPLY' && m.link?.messageId) ? String(m.link.messageId) : null,
      forwardedFromId:   (m.link?.type === 'FORWARD' && m.link.message?.sender) ? String(m.link.message.sender) : null,
      status:            m.status || null,
      raw:               payload,
    }
  }

  _findMaxIdHex(value, depth = 0) {
    if (value == null || depth > 8) return null
    if (typeof value !== 'object') return null
    if (value.__maxId && typeof value.hex === 'string') return value.hex

    const items = Array.isArray(value) ? value : Object.values(value)
    for (const item of items) {
      const found = this._findMaxIdHex(item, depth + 1)
      if (found) return found
    }
    return null
  }

  _writeDebugJson(filename, payload) {
    try {
      fs.appendFileSync(path.join('/tmp', filename), JSON.stringify({
        ts: new Date().toISOString(),
        payload,
      }) + '\n')
    } catch {}
  }

  _looksLikeMediaPayload(value, depth = 0) {
    if (value == null || depth > 8) return false
    if (typeof value === 'string') {
      return /videoId|fileId|photoId|previewData|MP4_|\.mp4|\.ogg|audio|voice|token|okcdn|oneme/i.test(value)
        || /^[A-Za-z0-9_-]{48,}$/.test(value)
    }
    if (Buffer.isBuffer(value)) return value.length > 256
    if (Array.isArray(value)) return value.some(item => this._looksLikeMediaPayload(item, depth + 1))
    if (typeof value === 'object') {
      const keys = Object.keys(value).join('|')
      if (/videoId|fileId|photoId|previewData|baseUrl|mimeType|MP4_|audio|voice|token|(^|[|])110([|]|$)|(^|[|])476([|]|$)/i.test(keys)) return true
      return Object.values(value).some(item => this._looksLikeMediaPayload(item, depth + 1))
    }
    return false
  }

  _collectLooseMedia(value, out = [], depth = 0) {
    if (value == null || depth > 8) return out
    if (Array.isArray(value)) {
      for (const item of value) this._collectLooseMedia(item, out, depth + 1)
      return out
    }
    if (typeof value !== 'object') return out

    const token = typeof value.token === 'string' ? value.token : (typeof value['110'] === 'string' ? value['110'] : null)
    const markerHint = value['476'] === 'videoId' ? 'video' : ''
    const typeHint = String(value._type || value.preview?._type || value.type || markerHint || value['0'] || value['476'] || '').toLowerCase()
    const hasPreview = !!value.previewData
    const hasMediaId = value.videoId != null || value.fileId != null || value.photoId != null || value.mediaId != null || value.attachmentId != null
    const filename = cleanMaxString(value.name || value.filename)
    // Live VIDEO notifications can carry a ready signed CDN URL as MP4_1080
    // (and resolved payloads can expose lower-quality MP4_* variants). Keep it
    // instead of falling through to the legacy JSON op:83 request, which is
    // incompatible with MAX's current binary WebSocket transport.
    const directVideoUrl = cleanMaxString(
      value.MP4_480 ||
      value.MP4_720 ||
      value.MP4_360 ||
      value.MP4_240 ||
      value.MP4_1080
    )
    const directUrl = directVideoUrl || cleanMaxString(value.baseUrl || value.url)
    if (token || hasPreview || hasMediaId || directUrl || typeHint.includes('video') || typeHint.includes('file') || typeHint.includes('audio') || typeHint.includes('music') || /\.ogg\b|\.mp4\b/i.test(filename || '')) {
      out.push({
        _type: typeHint.includes('video') ? 'VIDEO' : (typeHint.includes('audio') || typeHint.includes('voice') || typeHint.includes('music') || /\.ogg\b/i.test(filename || '') ? 'AUDIO' : (typeHint.includes('photo') ? 'PHOTO' : 'FILE')),
        url: directUrl || null,
        baseUrl: directUrl || null,
        token,
        videoId: value.videoId || value.mediaId || findNestedMediaId(value, ['videoId', 'video_id']) || findUrlParamInString(value.thumbnail, ['id']) || null,
        fileId: value.fileId || value.mediaId || value.attachmentId || findNestedMediaId(value, ['fileId', 'file_id', 'mediaId', 'attachmentId']) || null,
        photoId: value.photoId || null,
        previewData: value.previewData || null,
        thumbnail: value.thumbnail || null,
        duration: value.duration || value.preview?.duration || null,
        name: filename || null,
        size: value.size || null,
        mimeType: value.mimeType || null,
        raw: value,
      })
    }
    for (const item of Object.values(value)) this._collectLooseMedia(item, out, depth + 1)
    return out
  }

  _pushLooseMedia(payload) {
    const items = this._collectLooseMedia(payload).filter(item => item.url || item.baseUrl || item.token || item.previewData || item.videoId || item.fileId || item.photoId)
    if (!items.length) return
    this._pendingLooseMedia.push({ ts: Date.now(), items })
    this._pendingLooseMedia = this._pendingLooseMedia.filter(entry => Date.now() - entry.ts < 15_000).slice(-8)
    console.log(`[Transport] buffered loose media hints: ${items.length}`)
  }

  hasRecentLooseMediaForDomRecovery({ maxAgeMs = 15_000 } = {}) {
    const now = Date.now()
    return this._pendingLooseMedia.some(entry => entry?.ts && now - entry.ts < maxAgeMs && Array.isArray(entry.items) && entry.items.length > 0)
  }

  emitPendingLooseMediaMessage(chatId, messageHex, { maxAgeMs = 15_000 } = {}) {
    const chatIdStr = String(chatId || '')
    const idHex = String(messageHex || '')
    if (!chatIdStr || !isUsableMaxMessageHex(idHex)) return { emitted: false, reason: 'invalid_identity' }
    if (!this.hasRecentLooseMediaForDomRecovery({ maxAgeMs })) return { emitted: false, reason: 'no_recent_loose_media' }

    const pseudo = {
      chatId: chatIdStr,
      message: {
        id: { __maxId: true, hex: idHex },
        sender: null,
        time: Date.now(),
        attaches: [],
      },
    }
    this._consumeLooseMediaForMessage(pseudo)
    const msg = this._normalizeMaxMsg(pseudo)
    if (!msg || !msg.attachments?.length) return { emitted: false, reason: 'normalize_failed' }

    this._rememberConfirmedMessageAnchor(chatIdStr, idHex, { markSeen: true })
    this._persistLastMsgRawHex()
    console.log(`[Transport] emitted loose media msg chat:${chatIdStr} id:${idHex.slice(0,16)} type:${msg.type}`)
    this._emit(msg)
    return { emitted: true, messageId: idHex, type: msg.type, attachmentCount: msg.attachments.length }
  }

  _consumeLooseMediaForMessage(pl) {
    if (!pl?.message || Array.isArray(pl.message.attaches) && pl.message.attaches.length > 0) return
    if (Array.isArray(pl.attaches) && pl.attaches.length > 0) {
      const rootToken = pl.token || pl['110'] || null
      pl.message.attaches = pl.attaches.map(att => ({
        ...att,
        token: att?.token || rootToken || null,
        _rootMediaToken: rootToken || null,
      }))
      console.log(`[Transport] attached root payload media to msg:${pl.message.id?.hex || pl.message.id || 'unknown'} count=${pl.message.attaches.length}`)
      return
    }
    const direct = this._collectLooseMedia(pl)
    const recent = []
    const now = Date.now()
    for (const entry of this._pendingLooseMedia) {
      if (now - entry.ts < 15_000) recent.push(...entry.items)
    }
    const merged = [...recent, ...direct].filter(item => item.url || item.baseUrl || item.token || item.previewData || item.videoId || item.fileId || item.photoId)
    if (!merged.length) return
    const combined = {}
    for (const item of merged) {
      if ((!combined._type || combined._type === 'FILE') && item._type && item._type !== 'FILE') {
        combined._type = item._type
      } else {
        combined._type = combined._type || item._type
      }
      combined.token = combined.token || item.token
      combined.url = combined.url || item.url
      combined.baseUrl = combined.baseUrl || item.baseUrl
      combined.videoId = combined.videoId || item.videoId
      combined.fileId = combined.fileId || item.fileId
      combined.photoId = combined.photoId || item.photoId
      combined.previewData = combined.previewData || item.previewData
      combined.thumbnail = combined.thumbnail || item.thumbnail
      combined.duration = combined.duration || item.duration
      combined.name = combined.name || item.name
      combined.size = combined.size || item.size
      combined.mimeType = combined.mimeType || item.mimeType
    }
    if (!combined.videoId && combined.thumbnail) combined.videoId = findUrlParamInString(combined.thumbnail, ['id'])
    if (!combined.token && combined.thumbnail) combined.token = findUrlParamInString(combined.thumbnail, ['tkn', 'token', 'signatureToken'])
    if (!combined.fileId && combined.token && (combined._type === 'AUDIO' || combined._type === 'MUSIC')) combined.fileId = combined.token
    if (!combined.url && !combined.baseUrl && !combined.videoId && !combined.fileId && !combined.photoId) {
      this._writeDebugJson('max_media_missing_ids.jsonl', { pl, merged })
      return
    }
    pl.message.attaches = [combined]
    this._pendingLooseMedia = []
    console.log(`[Transport] attached loose media to msg:${pl.message.id?.hex || pl.message.id || 'unknown'} type=${combined._type}`)
  }

  _persistLastMsgRawHex() {
    try {
      fs.mkdirSync(path.dirname(LAST_MSG_IDS_PATH), { recursive: true })
      fs.writeFileSync(LAST_MSG_IDS_PATH, JSON.stringify(Object.fromEntries(this._lastMsgRawHex)))
    } catch (e) {
      console.warn('[Transport] Failed to persist msg IDs:', e.message)
    }
  }

  _rememberConfirmedMessageAnchor(chatId, candidateHex, { markSeen = false, confirmedAt = Date.now() } = {}) {
    const chatIdStr = String(chatId || '')
    const confirmedHex = String(candidateHex || '')
      .replace(/[^a-fA-F0-9]/g, '')
      .toLowerCase()
    if (!chatIdStr || !isUsableMaxMessageHex(confirmedHex)) return false

    const previousHex = this._lastMsgRawHex.get(chatIdStr) || null
    if (markSeen) this._lastSeenMsgId.set(chatIdStr, confirmedHex)
    if (isUsableMaxMessageHex(previousHex) && compareMaxIdHex(confirmedHex, previousHex) < 0) {
      return false
    }

    this._lastMsgRawHex.set(chatIdStr, confirmedHex)
    if (Number.isFinite(confirmedAt) && confirmedAt > 0) {
      this._confirmedMessageAnchorAt.set(chatIdStr, confirmedAt)
    } else {
      this._confirmedMessageAnchorAt.delete(chatIdStr)
    }
    return true
  }

  _rememberPreChatPendingMessageId(pendingHex) {
    const pending = String(pendingHex || '')
    if (!isUsableMaxMessageHex(pending)) {
      return { registered: false, reason: 'unsafe_pending_id', pendingHex: pending, queueLength: this._pendingNewMsgIds.length }
    }
    const now = Date.now()
    this._pendingNewMsgIds = this._pendingNewMsgIds
      .filter(entry => entry?.ts && now - entry.ts <= 30_000)
    if (!this._pendingNewMsgIds.some(entry => entry.pendingHex === pending)) {
      this._pendingNewMsgIds.push({ pendingHex: pending, ts: now })
    }
    this._pendingNewMsgIds = this._pendingNewMsgIds.slice(-25)
    return { registered: true, pendingHex: pending, queueLength: this._pendingNewMsgIds.length }
  }

  _registerPreChatPendingForChat(chatId) {
    const chatIdStr = String(chatId || '')
    if (!chatIdStr || !this._pendingNewMsgIds.length) return []
    const pending = this._pendingNewMsgIds.slice()
    this._pendingNewMsgIds = []
    const registrations = []
    for (const entry of pending) {
      const registration = this._registerPendingLiveMessageId(chatIdStr, entry.pendingHex)
      if (registration.registered) registrations.push(registration)
    }
    return registrations
  }

  _pendingLiveList(chatIdStr, maxAgeMs = 30_000) {
    const now = Date.now()
    const list = (this._pendingLiveMessageIds.get(chatIdStr) || [])
      .filter(entry => entry?.ts && now - entry.ts <= maxAgeMs)
    if (list.length) this._pendingLiveMessageIds.set(chatIdStr, list)
    else this._pendingLiveMessageIds.delete(chatIdStr)
    return list
  }

  _registerPendingLiveMessageId(chatId, pendingHex) {
    const chatIdStr = String(chatId || '')
    const pending = String(pendingHex || '')
    const previousHex = this._lastMsgRawHex.get(chatIdStr) || null
    const anchorHex = isUsableMaxMessageHex(previousHex) ? previousHex : null

    if (!chatIdStr) return { registered: false, reason: 'missing_chat_id', pendingHex: pending, previousHex, anchorHex }
    if (!isUsableMaxMessageHex(pending)) return { registered: false, reason: 'unsafe_pending_id', pendingHex: pending, previousHex, anchorHex }
    if (isUsableMaxMessageHex(previousHex) && compareMaxIdHex(pending, previousHex) <= 0) {
      return { registered: false, reason: 'stale_pending_id', pendingHex: pending, previousHex, anchorHex }
    }

    const list = this._pendingLiveList(chatIdStr)
    if (!list.some(entry => entry.pendingHex === pending)) {
      list.push({ pendingHex: pending, ts: Date.now(), previousHex, anchorHex })
    }
    this._pendingLiveMessageIds.set(chatIdStr, list.slice(-25))
    this._lastSeenMsgId.delete(chatIdStr)
    return { registered: true, pendingHex: pending, previousHex, anchorHex }
  }

  _op71AnchorForLiveNotification(chatId) {
    const anchorHex = this._lastMsgRawHex.get(String(chatId || '')) || null
    return isUsableMaxMessageHex(anchorHex) ? anchorHex : null
  }

  _advanceLastMsgAfterOp71(chatId, bestMsgHex) {
    const chatIdStr = String(chatId || '')
    const confirmedHex = String(bestMsgHex || '')
    if (!chatIdStr || !isUsableMaxMessageHex(confirmedHex)) return false

    if (!this._rememberConfirmedMessageAnchor(chatIdStr, confirmedHex)) return false
    const remaining = this._pendingLiveList(chatIdStr)
      .filter(entry => compareMaxIdHex(entry.pendingHex, confirmedHex) > 0)
    if (remaining.length) this._pendingLiveMessageIds.set(chatIdStr, remaining)
    else this._pendingLiveMessageIds.delete(chatIdStr)
    this._persistLastMsgRawHex()
    return true
  }

  _schedulePendingLiveDrain(chatId, delayMs = 350) {
    const chatIdStr = String(chatId || '')
    if (!chatIdStr || !this._pendingLiveList(chatIdStr).length) return false
    console.log(`[pendingLiveDrain] active op71 disabled chatId:${chatIdStr} pending:${this._pendingLiveList(chatIdStr).length}; guarded DOM recovery retained`)
    return false
  }

  _finalizeOp71CatchUpState(chatId, delayMs = 350) {
    const chatIdStr = String(chatId || '')
    const pendingLiveCount = this._pendingLiveList(chatIdStr).length
    if (pendingLiveCount > 0) {
      if (!this._catchUpChatIds.has(chatIdStr)) this._catchUpChatIds.set(chatIdStr, 0)
      return {
        pendingLiveCount,
        scheduledDrain: this._schedulePendingLiveDrain(chatIdStr, delayMs),
        catchUpRetained: true,
      }
    }

    this._catchUpChatIds.delete(chatIdStr)
    const shortId32str = ((Number(chatIdStr) >>> 0)).toString()
    if (shortId32str !== chatIdStr) this._catchUpChatIds.delete(shortId32str)
    return { pendingLiveCount: 0, scheduledDrain: false, catchUpRetained: false }
  }

  registerPendingLiveTextIdForDomRecovery(chatId, pendingHex) {
    return this._registerPendingLiveMessageId(chatId, pendingHex)
  }

  pendingLiveTextCountForDomRecovery(chatId, { maxAgeMs = 15_000 } = {}) {
    return this._pendingLiveList(String(chatId || ''), maxAgeMs).length
  }

  peekPendingLiveTextIdForDomRecovery(chatId, { maxAgeMs = 15_000 } = {}) {
    const list = this._pendingLiveList(String(chatId || ''), maxAgeMs)
    return list[0]?.pendingHex || null
  }

  confirmPendingLiveTextIdForDomRecovery(chatId, pendingHex) {
    const chatIdStr = String(chatId || '')
    const pending = String(pendingHex || '')
    const remaining = this._pendingLiveList(chatIdStr)
      .filter(entry => entry.pendingHex !== pending)
    if (remaining.length) this._pendingLiveMessageIds.set(chatIdStr, remaining)
    else this._pendingLiveMessageIds.delete(chatIdStr)
  }

  async forceHistoryCatchup(chatId, anchorHex) {
    const chatIdStr = String(chatId)
    if (anchorHex) {
      const previous = this._lastMsgRawHex.get(chatIdStr)
      this._lastMsgRawHex.set(chatIdStr, String(anchorHex))
      this._lastSeenMsgId.delete(chatIdStr)
      try {
        fs.writeFileSync(LAST_MSG_IDS_PATH, JSON.stringify(Object.fromEntries(this._lastMsgRawHex)))
      } catch {}
      console.log(`[debug→op71] forced anchor ${String(anchorHex).slice(0,16)} for chatId:${chatIdStr} prev:${previous ? previous.slice(0,16) : 'none'}`)
    }
    return this.sendBinaryOp71(chatIdStr)
  }

  _scheduleDirectBackfill(chatId, anchorHex, newHex) {
    const chatIdStr = String(chatId || '')
    if (!chatIdStr || !anchorHex || !newHex) return
    if (!isUsableMaxMessageHex(anchorHex) || !isUsableMaxMessageHex(newHex)) {
      console.log(`[op128direct->op71] skipped unsafe anchor chatId:${chatIdStr} anchor:${String(anchorHex).slice(0,16)} new:${String(newHex).slice(0,16)}`)
      return
    }
    if (compareMaxIdHex(newHex, anchorHex) <= 0) return
    const now = Date.now()
    const last = this._lastDirectBackfillAt.get(chatIdStr) || 0
    if (now - last < 250) return
    this._lastDirectBackfillAt.set(chatIdStr, now)
    console.log(`[op128direct] gap detected chatId:${chatIdStr} anchor:${String(anchorHex).slice(0,16)} new:${String(newHex).slice(0,16)}; using guarded DOM recovery`)
  }

  _detectMaxType(attaches) {
    if (!attaches || !attaches.length) return 'text'
    const first = attaches[0] || {}
    const t = (first._type || first.preview?._type || first.type || '').toUpperCase()
    const name = cleanMaxString(first.name || first.filename || '')
    const mime = cleanMaxString(first.mimeType || first.type || '')
    if (t === 'PHOTO')                     return 'image'
    if (t === 'VIDEO' || first.videoId || first.thumbnail || /\.mp4\b/i.test(name || '') || /^video\//i.test(mime || '')) return 'video'
    if (t === 'MUSIC')                     return 'audio'
    if (t === 'AUDIO' || t === 'VOICE')    return 'voice'
    if (/\.ogg\b/i.test(name || '') || /^audio\//i.test(mime || '')) return 'audio'
    if (t === 'STICKER' || t === 'SMILE')  return 'sticker'
    return 'document'
  }

  _extractMaxAttachments(attaches) {
    return attaches.map(a => ({
      type:        (a._type || 'file').toLowerCase(),
      url:         a.baseUrl || a.url || null,  // MAX uses baseUrl for photos, url for audio
      name:        a.name || a.filename || null,
      size:        a.size || null,
      mimeType:    a.mimeType || a.type || null,
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

  _extractMaxAttachmentsV2(attaches) {
    return attaches.map(a => {
      const rawType = String(a._type || a.preview?._type || a.type || '').toUpperCase()
      const name = cleanMaxFilename(a.name || a.filename, a.preview?.title, rawType)
      const videoId = maxIdToString(a.videoId) || findNestedMediaId(a, ['videoId', 'video_id']) || findUrlParamInString(a.thumbnail, ['id'])
      const fileId = maxIdToString(a.fileId) ||
        findNestedMediaId(a, ['fileId', 'file_id', 'mediaId', 'attachmentId']) ||
        (a.token && (rawType === 'AUDIO' || rawType === 'MUSIC') ? cleanMaxString(a.token) : null)
      const token = cleanMaxString(a.token || a._rootMediaToken || a['110']) ||
        findUrlParamInString(a.thumbnail, ['tkn', 'token', 'signatureToken'])
      const photoId = maxIdToString(a.photoId) || findNestedMediaId(a, ['photoId', 'photo_id'])

      let type = (a._type || 'file').toLowerCase()
      if (rawType === 'MUSIC') type = 'audio'
      if (rawType === 'PHOTO' || photoId || (a.baseUrl && rawType !== 'VIDEO' && !videoId)) type = 'photo'
      if (rawType === 'VIDEO' || videoId || a.thumbnail || /\.mp4\b/i.test(name || '')) type = 'video'
      if ((rawType === 'AUDIO' || rawType === 'VOICE') && type === 'file') type = rawType.toLowerCase()
      if (/\.ogg\b/i.test(name || '') && type === 'file') type = 'audio'

      return {
        type,
        url:         a.baseUrl || a.url || null,
        name,
        size:        a.size || null,
        mimeType:    mediaMimeFromAttachment(a, type),
        previewData: a.previewData || null,
        thumbnail:   cleanMaxString(a.thumbnail) || null,
        duration:    a.duration || a.preview?.duration || null,
        photoId,
        videoId,
        fileId,
        token,
      }
    })
  }

  async sendBinaryOp71(chatId, anchorHexOverride = null) {
    if (!this._page) throw new Error('No page')

    const chatIdNum = Number(chatId)

    // MAX кодирует ID как ext8(type=1, uint64(нижние 32 бита chatId))
    // Браузерный op:71 hex: c7 09 01 cf 00 00 00 00 [4 байта lower32]
    const shortId = chatIdNum >>> 0  // unsigned lower 32 bits
    const chatIdValue = Buffer.from([
      0xc7, 0x09, 0x01,               // ext8, 9 data bytes, type=1
      0xcf,                            // uint64 marker
      0x00, 0x00, 0x00, 0x00,          // high 4 bytes = 0
      (shortId >>> 24) & 0xff,
      (shortId >>> 16) & 0xff,
      (shortId >>> 8) & 0xff,
      shortId & 0xff,
    ])
    // fixmap-2: {chatId: ext8, messageIds: [lastMsgId]}
    // "chatId" = fixstr-6 (a6) + "chatId"
    const chatIdKey    = Buffer.from([0xa6, 0x63, 0x68, 0x61, 0x74, 0x49, 0x64])
    // "messageIds" = fixstr-10 (aa) + "messageIds", value = fixarray-1 (91) with last known msg ID
    // Browser sends the real last message ID so server returns messages newer than that.
    // We store the raw ext8 data hex from op:48/op:53 and reconstruct it exactly here.
    const msgIdsKey  = Buffer.from([0xaa, 0x6d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x49, 0x64, 0x73])
    const storedCandidate = anchorHexOverride ? String(anchorHexOverride) : this._lastMsgRawHex.get(String(chatId))
    if (storedCandidate && !isUsableMaxMessageHex(storedCandidate)) {
      throw new Error(`Refusing op:71 with invalid provider anchor: ${String(storedCandidate).slice(0, 16)}`)
    }
    const storedHex = storedCandidate
    let msgIdEncoded
    if (storedHex) {
      // Reconstruct ext8(type=1, data=rawBytes): c7 [len] 01 [rawBytes]
      const rawBytes = Buffer.from(storedHex, 'hex')
      // MAX server stores IDs with int64 marker (0xd3) but expects uint64 (0xcf) in op:71 requests.
      // Browser always re-encodes as uint64 when building op:71. Normalize to match browser behavior.
      if (rawBytes[0] === 0xd3) rawBytes[0] = 0xcf
      msgIdEncoded = Buffer.concat([Buffer.from([0xc7, rawBytes.length, 0x01]), rawBytes])
    } else {
      // Fallback: ext8(type=1, uint64(1)) — anchor ID for chats with no stored msgId
      msgIdEncoded = Buffer.from([0xc7, 0x09, 0x01, 0xcf, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01])
    }
    const msgIdsValue  = Buffer.concat([Buffer.from([0x91]), msgIdEncoded])  // fixarray-1
    const map          = Buffer.concat([Buffer.from([0x82]), chatIdKey, chatIdValue, msgIdsKey, msgIdsValue])

    // Префикс 3 байта захватывается из браузерного op:71 при старте
    const prefix       = this._op71Prefix ? Buffer.from(this._op71Prefix) : Buffer.alloc(0)
    const payloadBytes = Buffer.concat([prefix, map])

    // Используем следующий fseq после браузерного — избегаем скачка в последовательности
    // Браузер использует reqSeq=0 для op:71; мы повторяем это поведение
    const frameSeq = (++this._browserLastBinFrameSeq) & 0xffff
    const header = Buffer.alloc(9)
    header[0] = 0x0a  // magic
    header[1] = 0x00  // byte1=0
    header[2] = (frameSeq >> 8) & 0xff
    header[3] = frameSeq & 0xff
    header[4] = 0x00  // flags
    header[5] = 71    // opcode
    header[6] = 0x01  // cmd=1 (request)
    header[7] = 0x00  // reqSeq=0 (браузер всегда шлёт op:71 с reqSeq=0)
    header[8] = 0x00

    const frame = Buffer.concat([header, payloadBytes])
    const b64   = frame.toString('base64')

    const result = await this._page.evaluate(b => window.__maxWsSendBinary(b), b64)
    if (!result || !result.ok) throw new Error(`Binary op:71 send failed: ${result?.error}`)
    this._pendingOp71ChatIds.push(String(chatId))
    if (this._pendingOp71ChatIds.length > 20) this._pendingOp71ChatIds.splice(0, this._pendingOp71ChatIds.length - 20)
    const prefixHex  = (this._op71Prefix || []).map(b => b.toString(16).padStart(2,'0')).join(' ')
    const msgIdLabel = storedHex ? `${storedHex.slice(0,16)}${anchorHexOverride ? '(override)' : ''}` : 'anchor=1(fallback)'
    console.log(`[op71bin] sent chatId:${chatIdNum} shortId:0x${shortId.toString(16)} msgId:${msgIdLabel} fseq:${frameSeq} prefix:[${prefixHex}]`)
    return 0
  }

  // ─── Отправка WS фрейма (JSON) ───────────────────────────────────────────

  _mpStr(value) {
    const buf = Buffer.from(String(value), 'utf8')
    if (buf.length < 32) return Buffer.concat([Buffer.from([0xa0 | buf.length]), buf])
    if (buf.length < 256) return Buffer.concat([Buffer.from([0xd9, buf.length]), buf])
    if (buf.length < 65536) return Buffer.concat([Buffer.from([0xda, (buf.length >> 8) & 0xff, buf.length & 0xff]), buf])
    throw new Error(`String too long for msgpack: ${buf.length}`)
  }

  _mpUInt(value) {
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid msgpack uint: ${value}`)
    if (n < 128) return Buffer.from([n])
    if (n < 256) return Buffer.from([0xcc, n])
    if (n < 65536) return Buffer.from([0xcd, (n >> 8) & 0xff, n & 0xff])
    return Buffer.from([0xce, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
  }

  _mpInt(value) {
    const n = Number(value)
    if (!Number.isSafeInteger(n) || n < -0x80000000 || n > 0xffffffff) {
      throw new Error(`Invalid msgpack int: ${value}`)
    }
    if (n >= 0) return this._mpUInt(n)
    if (n >= -32) return Buffer.from([0x100 + n])
    if (n >= -128) return Buffer.from([0xd0, 0x100 + n])
    if (n >= -32768) return Buffer.from([0xd1, (n >> 8) & 0xff, n & 0xff])
    return Buffer.from([0xd2, (n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])
  }

  _maxExtFromLower32(value) {
    const shortId = Number(value) >>> 0
    return Buffer.from([
      0xc7, 0x09, 0x01, 0xcf,
      0x00, 0x00, 0x00, 0x00,
      (shortId >>> 24) & 0xff,
      (shortId >>> 16) & 0xff,
      (shortId >>> 8) & 0xff,
      shortId & 0xff,
    ])
  }

  _maxExtFromIdHex(hex, preferUnsigned = true) {
    const clean = String(hex || '').replace(/[^a-fA-F0-9]/g, '')
    if (!clean || clean.length % 2 !== 0) throw new Error(`Invalid MAX id hex: ${hex}`)
    const raw = Buffer.from(clean, 'hex')
    if (preferUnsigned && raw[0] === 0xd3) raw[0] = 0xcf
    return Buffer.concat([Buffer.from([0xc7, raw.length, 0x01]), raw])
  }

  _buildBinaryReplyFrame(chatId, text, replyToMessageId, cid) {
    const replyId = String(replyToMessageId || '')
    if (!isUsableMaxMessageHex(replyId)) {
      throw new Error('Reply requires real MAX provider message id')
    }

    const linkMap = Buffer.concat([
      Buffer.from([0x82]),
      this._mpStr('type'), this._mpStr('REPLY'),
      this._mpStr('messageId'), this._maxExtFromIdHex(replyId, true),
    ])
    const messageMap = Buffer.concat([
      Buffer.from([0x85]),
      this._mpStr('text'), this._mpStr(text),
      this._mpStr('cid'), this._mpInt(cid),
      this._mpStr('elements'), Buffer.from([0x90]),
      this._mpStr('link'), linkMap,
      this._mpStr('attaches'), Buffer.from([0x90]),
    ])
    const payloadMap = Buffer.concat([
      Buffer.from([0x83]),
      this._mpStr('chatId'), this._maxExtFromLower32(chatId),
      this._mpStr('message'), messageMap,
      this._mpStr('notify'), Buffer.from([0xc3]),
    ])

    const frameSeq = (++this._browserLastBinFrameSeq) & 0xffff
    const header = Buffer.alloc(9)
    header[0] = 0x0a
    header[1] = 0x00
    header[2] = (frameSeq >> 8) & 0xff
    header[3] = frameSeq & 0xff
    header[4] = 0x00
    header[5] = OP.SEND_MESSAGE
    header[6] = 0x01
    header[7] = 0x00
    header[8] = 0x00

    // Browser frames carry the low payload-length byte before the msgpack map.
    return Buffer.concat([header, Buffer.from([payloadMap.length & 0xff]), payloadMap])
  }

  async sendBinaryReply(chatId, text, replyToMessageId, cid) {
    if (!this._page) throw new Error('No page')
    const frame = this._buildBinaryReplyFrame(chatId, text, replyToMessageId, cid)
    const result = await this._page.evaluate(b => window.__maxWsSendBinary(b), frame.toString('base64'))
    if (!result || !result.ok) throw new Error(`Binary op:64 send failed: ${result?.error}`)
    console.log(`[replybin] sent op:64 chatId:${chatId} replyTo:${String(replyToMessageId).slice(0,18)} fseq:${(frame[2] << 8) | frame[3]}`)
    return true
  }

  async sendBinaryReaction(chatId, messageId, reactionId, remove = false, preferUnsignedMessageId = true) {
    if (!this._page) throw new Error('No page')
    const fields = [
      this._mpStr('chatId'), this._maxExtFromLower32(chatId),
      this._mpStr('messageId'), this._maxExtFromIdHex(messageId, preferUnsignedMessageId),
    ]
    if (!remove) {
      const reactionMap = Buffer.concat([
        Buffer.from([0x82]),
        this._mpStr('reactionType'), this._mpStr('EMOJI'),
        this._mpStr('id'), typeof reactionId === 'number' || /^\d+$/.test(String(reactionId)) ? this._mpUInt(reactionId) : this._mpStr(reactionId),
      ])
      fields.push(this._mpStr('reaction'), reactionMap)
    }

    const map = Buffer.concat([Buffer.from([0x80 | (fields.length / 2)]), ...fields])
    const prefix = this._op71Prefix ? Buffer.from(this._op71Prefix) : Buffer.alloc(0)
    const payloadBytes = Buffer.concat([prefix, map])
    const frameSeq = (++this._browserLastBinFrameSeq) & 0xffff
    const opcode = remove ? OP.REMOVE_REACTION : OP.SEND_REACTION
    const header = Buffer.alloc(9)
    header[0] = 0x0a
    header[1] = 0x00
    header[2] = (frameSeq >> 8) & 0xff
    header[3] = frameSeq & 0xff
    header[4] = 0x00
    header[5] = opcode & 0xff
    header[6] = 0x01
    header[7] = 0x00
    header[8] = 0x00

    const frame = Buffer.concat([header, payloadBytes])
    const result = await this._page.evaluate(b => window.__maxWsSendBinary(b), frame.toString('base64'))
    if (!result || !result.ok) throw new Error(`Binary op:${opcode} send failed: ${result?.error}`)
    console.log(`[reactionbin] sent op:${opcode} chatId:${chatId} msgId:${String(messageId).slice(0,18)} reaction=${reactionId || ''} fseq:${frameSeq} unsigned=${preferUnsignedMessageId}`)
    return 0
  }

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

  _rememberRecentOp128Chat(chatId, now = Date.now()) {
    const chatIdStr = String(chatId || '')
    if (!chatIdStr) return 0
    this._recentOp128ChatIds.set(chatIdStr, now)
    const cutoff = now - 15_000
    const events = (this._recentOp128EventsByChat.get(chatIdStr) || [])
      .filter(ts => Number.isFinite(ts) && ts >= cutoff)
    events.push(now)
    this._recentOp128EventsByChat.set(chatIdStr, events.slice(-20))
    return events.length
  }

  recentOp128CountForChat(chatId, maxAgeMs = 15_000) {
    const chatIdStr = String(chatId || '')
    if (!chatIdStr) return 0
    const now = Date.now()
    const events = (this._recentOp128EventsByChat.get(chatIdStr) || [])
      .filter(ts => Number.isFinite(ts) && now - ts <= maxAgeMs)
    if (events.length) this._recentOp128EventsByChat.set(chatIdStr, events)
    else this._recentOp128EventsByChat.delete(chatIdStr)
    return events.length
  }

  recentOp128SeriesKeyForChat(chatId, maxAgeMs = 15_000) {
    const chatIdStr = String(chatId || '')
    if (!chatIdStr) return null
    const now = Date.now()
    const events = (this._recentOp128EventsByChat.get(chatIdStr) || [])
      .filter(ts => Number.isFinite(ts) && now - ts <= maxAgeMs)
      .sort((a, b) => a - b)
    if (events.length) this._recentOp128EventsByChat.set(chatIdStr, events)
    else {
      this._recentOp128EventsByChat.delete(chatIdStr)
      return null
    }
    return `op128-series:${Math.floor(events[0] / 1000)}`
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
    if (msg) {
      const now = Date.now()
      for (const [id, ts] of this._emittedMsgIds.entries()) {
        if (now - ts > 10 * 60 * 1000) this._emittedMsgIds.delete(id)
      }
      const attachmentSig = Array.isArray(msg.attachments)
        ? msg.attachments.map(a => [a.type, a.url, a.name, a.size, a.videoId, a.fileId, a.photoId].join(':')).join('|')
        : ''
      const dedupKey = msg.id
        ? `id:${msg.id}`
        : `sig:${msg.chatId || ''}:${msg.from || ''}:${msg.timestamp || ''}:${msg.text || ''}:${attachmentSig}`
      if (this._emittedMsgIds.has(dedupKey)) {
        console.log(`[Transport] skip duplicate emit ${dedupKey.slice(0, 80)}`)
        return
      }
      this._emittedMsgIds.set(dedupKey, now)
    }
    for (const h of this._messageHandlers) {
      try { h(msg) } catch (e) {
        console.error('[Transport] Handler error:', e.message)
      }
    }
  }
}

module.exports = { TransportInterceptor, OP, selectPendingLiveDomCandidates }
