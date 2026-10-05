'use strict'

const fs   = require('fs')
const path = require('path')

// Persist last known message IDs across container restarts so catch-up op:71
// works even when op:48 doesn't include all chats in its startup push.
const DEFAULT_STATE_DIR = path.join(__dirname, '..', 'user_data')
const LAST_MSG_IDS_FILE = 'last-msg-ids.json'
// Chats whose history has a hole the catch-up still has to fill: chatId -> the
// newest message before the hole. On the volume, so a restart keeps it.
const CATCH_UP_GAPS_FILE = 'catch-up-gaps.json'

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

// ─── MAX binary frame codec ──────────────────────────────────────────────────
// Taken from the MAX Web client the page itself runs (web.max.ru bundle
// _app/immutable/chunks/CGK0xiLg.js, read 2026-10-02: frame decoder `$ne`,
// encoder `ere`, LZ4 block decoder `Gne`), and confirmed against all 3,644
// outgoing frame headers in the preserved production log of 2026-10-02:
//
//   byte  0     protocol version, 10
//   byte  1     cmd: 0 request or server push, 1 response, 2 request re-sent
//               after login, 3 error
//   bytes 2-3   seq, int16 big-endian, per socket
//   bytes 4-5   opcode, int16 big-endian (272 and 302 exist)
//   byte  6     compression: 0 = plain msgpack; n > 0 = one LZ4 block whose
//               decoded size is at most length * n
//   bytes 7-9   payload length, uint24 big-endian
//   bytes 10..  payload: exactly one msgpack value
//
// The reader this replaces took byte 6 for cmd and bytes 7-8 for seq, and
// decoded msgpack from byte 9 without decompressing. A frame whose LZ4 block
// held a back-reference therefore decoded to garbage: long inbound text full
// of U+FFFD, op:19 without its profile, and op:128 pushes reduced to a stray
// id that was then dropped as unsafe_pending_id - the lost burst message.
const MAX_FRAME_HEADER_BYTES = 10
const MAX_FRAME_PROTOCOL_VERSION = 10
const LZ4_MIN_MATCH = 4
const LZ4_LAST_LITERALS = 5

function lz4CorruptBlock(offset) {
  return new Error(`lz4: corrupt block at offset ${offset}`)
}

// A faithful port of the page's own LZ4 block decoder (`Gne`), bounds checks
// included, so the scraper accepts exactly the blocks MAX Web accepts.
function lz4BlockDecompress(input, maxOutputLength) {
  const src = input instanceof Uint8Array ? input : Uint8Array.from(input || [])
  const capacity = Math.max(0, Math.floor(Number(maxOutputLength) || 0))
  const out = new Uint8Array(capacity)
  const srcLength = src.length
  let ip = 0
  let op = 0
  while (ip < srcLength) {
    const token = src[ip++]
    let literalLength = token >>> 4
    if (literalLength === 15) {
      let extra
      do {
        if (ip >= srcLength) throw lz4CorruptBlock(ip)
        extra = src[ip++]
        literalLength += extra
      } while (extra === 255)
    }
    if (ip + literalLength > srcLength || op + literalLength > capacity) throw lz4CorruptBlock(ip)
    if (ip + literalLength === srcLength) {
      out.set(src.subarray(ip, ip + literalLength), op)
      op += literalLength
      break
    }
    if (ip + literalLength + 2 + 1 + LZ4_LAST_LITERALS > srcLength) throw lz4CorruptBlock(ip)
    out.set(src.subarray(ip, ip + literalLength), op)
    ip += literalLength
    op += literalLength
    if (ip + 2 > srcLength) throw lz4CorruptBlock(ip)
    const offset = src[ip++] | (src[ip++] << 8)
    if (offset === 0 || offset > op) throw lz4CorruptBlock(ip)
    let matchLength = (token & 15) + LZ4_MIN_MATCH
    if ((token & 15) === 15) {
      let extra
      do {
        if (ip >= srcLength) throw lz4CorruptBlock(ip)
        extra = src[ip++]
        matchLength += extra
      } while (extra === 255)
    }
    if (op + matchLength > capacity) throw lz4CorruptBlock(ip)
    const matchStart = op - offset
    if (offset >= matchLength) {
      out.set(out.subarray(matchStart, matchStart + matchLength), op)
      op += matchLength
    } else {
      const end = op + matchLength
      let from = matchStart
      while (op < end) out[op++] = out[from++]
    }
  }
  return out.subarray(0, op)
}

/**
 * Decodes one MAX Web socket frame. A frame that cannot be decoded exactly is
 * reported as such and never guessed at: a partial decode is how a stray value
 * used to pass for a message id.
 */
function decodeMaxBinaryFrame(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || [])
  if (buf.length < MAX_FRAME_HEADER_BYTES) return { ok: false, reason: 'short_frame', byteLength: buf.length }
  const header = {
    version: buf[0],
    cmd: buf[1],
    seq: buf.readInt16BE(2),
    opcode: buf.readInt16BE(4),
    compression: buf[6],
    length: (buf[7] << 16) | (buf[8] << 8) | buf[9],
  }
  if (header.version !== MAX_FRAME_PROTOCOL_VERSION) return { ok: false, reason: 'unknown_version', ...header }
  if (header.length === 0) return { ok: true, ...header, payload: undefined }
  if (buf.length < MAX_FRAME_HEADER_BYTES + header.length) return { ok: false, reason: 'truncated_payload', ...header }
  let body = buf.subarray(MAX_FRAME_HEADER_BYTES, MAX_FRAME_HEADER_BYTES + header.length)
  if (header.compression > 0) {
    try {
      body = Buffer.from(lz4BlockDecompress(body, header.length * header.compression))
    } catch (error) {
      return { ok: false, reason: 'lz4_corrupt', error: error.message, ...header }
    }
  }
  let values
  try {
    values = maxMsgpackDecodeAll(body)
  } catch (error) {
    return { ok: false, reason: 'msgpack_error', error: error.message, ...header }
  }
  if (!values.length) return { ok: false, reason: 'msgpack_empty', ...header }
  return { ok: true, ...header, payload: values[0], trailingValues: values.length - 1 }
}

// MAX ids travel as msgpack ext type 1 wrapping an int64 (0xd3) or, when the
// page re-encodes a positive BigInt, a uint64 (0xcf). The scraper's canonical
// message id is 'd3' + the 16 hex digits of the 64-bit value either way.
function canonicalMaxMessageIdHex(value) {
  if (value == null) return null
  let digits = null
  if (typeof value === 'object' && typeof value.hex === 'string') {
    digits = value.hex.toLowerCase()
  } else if (typeof value === 'string') {
    digits = value.trim().toLowerCase()
  } else {
    return null
  }
  if (/^(?:d3|cf)[0-9a-f]{16}$/.test(digits)) return `d3${digits.slice(2)}`
  return null
}

function maxIdValueToBigInt(value) {
  try {
    if (typeof value === 'bigint') return value
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
    if (typeof value === 'string' && /^-?\d{1,20}$/.test(value.trim())) return BigInt(value.trim())
    if (value && typeof value === 'object' && typeof value.hex === 'string') {
      const hex = value.hex.toLowerCase()
      if (/^d3[0-9a-f]{16}$/.test(hex)) return BigInt.asIntN(64, BigInt(`0x${hex.slice(2)}`))
      if (/^cf[0-9a-f]{16}$/.test(hex)) return BigInt(`0x${hex.slice(2)}`)
    }
  } catch {}
  return null
}

function maxChatIdString(value) {
  const numeric = maxIdValueToBigInt(value)
  return numeric === null ? null : numeric.toString()
}

// ─── MAX id spaces ───────────────────────────────────────────────────────────
// MAX sends user and chat ids as msgpack ext type 1 wrapping an int32: 0xd2 and
// four bytes. maxMsgpackDecodeAll keeps that marker byte in the number it
// builds, so the id the scraper - and the CRM, which stores it - calls a chat's
// protocol id is (0xd2 << 32) | uint32(id): 902454841098 for chat 511708938.
// That protocol id is the scraper's stable key and is never rewritten here.
// The page decodes the ext properly: its URL is /<real id> (MAX Web's
// _buildUrl returns `/${chat.id}`), and every request it sends carries the
// real id, as a BigInt, which its codec writes as a uint64 (cf) ext. A
// dialog's real id is the XOR of its two users' real ids, and the static web
// routes are exactly these real ids - the "low 32 bits" rule. Correlating a
// page request with a protocol id therefore compares REAL ids, and every
// request the scraper builds itself carries the real id.
const MAX_INT32_EXT_PROTOCOL_PREFIX = 0xd2n
const MAX_UINT32_EXT_PROTOCOL_PREFIX = 0xcen

/** The id MAX itself uses for a value the scraper decoded or stored, as a BigInt; null if it is not an id. */
function maxRealIdFromProtocolId(value) {
  const numeric = maxIdValueToBigInt(value)
  if (numeric === null) return null
  // A 9-byte ext (int64 or uint64) is decoded exactly already.
  if (value && typeof value === 'object' && typeof value.hex === 'string') return numeric
  const prefix = numeric >> 32n
  if (prefix === MAX_INT32_EXT_PROTOCOL_PREFIX) return BigInt.asIntN(32, numeric & 0xffffffffn)
  if (prefix === MAX_UINT32_EXT_PROTOCOL_PREFIX) return numeric & 0xffffffffn
  return numeric
}

/**
 * Whether two id values - protocol ids, page ids or decoded exts - name the same
 * MAX chat: equal as real ids, or equal as decoded (two protocol ids).
 */
function sameMaxChatId(left, right) {
  const rawA = maxIdValueToBigInt(left)
  const rawB = maxIdValueToBigInt(right)
  if (rawA === null || rawB === null) return false
  if (rawA === rawB) return true
  return maxRealIdFromProtocolId(left) === maxRealIdFromProtocolId(right)
}

/**
 * The real id in the form the page sends back an id it received: MAX Web's
 * codec decodes a safe integer to a Number and writes a Number as a plain
 * msgpack integer; only an id it resolved itself is a BigInt.
 */
function maxRealIdAsPlainNumber(value) {
  const real = maxRealIdFromProtocolId(value)
  if (real === null) return null
  return real >= BigInt(Number.MIN_SAFE_INTEGER) && real <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(real) : real
}

/** A MAX message id's server time in ms: the id is (ms << 16) | a 16-bit suffix. */
function maxMessageIdTimeMs(hex) {
  const id = maxIdValueToBigInt({ hex: canonicalMaxMessageIdHex(hex) || '' })
  if (id === null || id <= 0n) return null
  return Number(id >> 16n)
}

// ─── MAX binary frame encoder ────────────────────────────────────────────────
// The page's own encoder (`ere` in the bundle cited above) with the msgpack
// settings it passes (@msgpack/msgpack, extension codec `ai`, ignoreUndefined):
//   - a BigInt goes out as ext type 1 wrapping a uint64 (cf), or an int64 (d3)
//     when negative;
//   - a {__maxId, hex} value read by maxMsgpackDecodeAll goes back out as the
//     exact ext it arrived as;
//   - every other value is plain msgpack in its smallest form, map keys in
//     insertion order, undefined map values left out;
//   - a payload over 32 bytes is one LZ4 block, byte 6 the size ratio.
// The JSON frames the scraper used to inject were not this format at all, and
// MAX closed the socket on every one of them (D-02).
function maxMsgpackEncode(value) {
  const chunks = []
  const push = buffer => chunks.push(buffer)
  const bytes = (...values) => push(Buffer.from(values))
  const sized = (marker, size, write) => {
    const buffer = Buffer.alloc(1 + size)
    buffer[0] = marker
    write(buffer)
    push(buffer)
  }
  const header = (length, fix, fixMax, m8, m16, m32) => {
    if (fix !== null && length < fixMax) bytes(fix | length)
    else if (m8 !== null && length < 0x100) bytes(m8, length)
    else if (length < 0x10000) sized(m16, 2, b => b.writeUInt16BE(length, 1))
    else sized(m32, 4, b => b.writeUInt32BE(length, 1))
  }
  const encodeExt = (type, data) => {
    const size = data.length
    if (size === 1) bytes(0xd4, type & 0xff)
    else if (size === 2) bytes(0xd5, type & 0xff)
    else if (size === 4) bytes(0xd6, type & 0xff)
    else if (size === 8) bytes(0xd7, type & 0xff)
    else if (size === 16) bytes(0xd8, type & 0xff)
    else if (size < 0x100) bytes(0xc7, size, type & 0xff)
    else if (size < 0x10000) sized(0xc8, 3, b => { b.writeUInt16BE(size, 1); b.writeInt8(type, 3) })
    else sized(0xc9, 5, b => { b.writeUInt32BE(size, 1); b.writeInt8(type, 5) })
    push(Buffer.from(data))
  }
  const encodeInteger = n => {
    if (n >= 0) {
      if (n < 0x80) bytes(n)
      else if (n < 0x100) bytes(0xcc, n)
      else if (n < 0x10000) sized(0xcd, 2, b => b.writeUInt16BE(n, 1))
      else if (n < 0x100000000) sized(0xce, 4, b => b.writeUInt32BE(n, 1))
      else sized(0xcf, 8, b => b.writeBigUInt64BE(BigInt(n), 1))
    } else if (n >= -0x20) {
      bytes(0xe0 | (n + 0x20))
    } else if (n >= -0x80) {
      sized(0xd0, 1, b => b.writeInt8(n, 1))
    } else if (n >= -0x8000) {
      sized(0xd1, 2, b => b.writeInt16BE(n, 1))
    } else if (n >= -0x80000000) {
      sized(0xd2, 4, b => b.writeInt32BE(n, 1))
    } else {
      sized(0xd3, 8, b => b.writeBigInt64BE(BigInt(n), 1))
    }
  }
  const encodeBigIntExt = n => {
    const data = Buffer.alloc(9)
    if (n >= 0n) {
      data[0] = 0xcf
      data.writeBigUInt64BE(BigInt.asUintN(64, n), 1)
    } else {
      data[0] = 0xd3
      data.writeBigInt64BE(BigInt.asIntN(64, n), 1)
    }
    encodeExt(1, data)
  }
  const encode = (item, depth) => {
    if (depth > 100) throw new Error('maxMsgpackEncode: too deeply nested')
    if (item === null || item === undefined) return bytes(0xc0)
    if (item === false) return bytes(0xc2)
    if (item === true) return bytes(0xc3)
    if (typeof item === 'number') {
      if (Number.isSafeInteger(item)) return encodeInteger(item)
      return sized(0xcb, 8, b => b.writeDoubleBE(item, 1))
    }
    if (typeof item === 'bigint') return encodeBigIntExt(item)
    if (typeof item === 'string') {
      const utf8 = Buffer.from(item, 'utf8')
      header(utf8.length, 0xa0, 32, 0xd9, 0xda, 0xdb)
      return push(utf8)
    }
    if (item instanceof Uint8Array) {
      header(item.length, null, 0, 0xc4, 0xc5, 0xc6)
      return push(Buffer.from(item))
    }
    if (Array.isArray(item)) {
      header(item.length, 0x90, 16, null, 0xdc, 0xdd)
      for (const element of item) encode(element, depth + 1)
      return
    }
    if (typeof item === 'object') {
      if (item.__maxId === true && typeof item.hex === 'string' && /^(?:[0-9a-f]{2})+$/i.test(item.hex)) {
        return encodeExt(1, Buffer.from(item.hex, 'hex'))
      }
      const entries = Object.entries(item).filter(([, entryValue]) => entryValue !== undefined)
      header(entries.length, 0x80, 16, null, 0xde, 0xdf)
      for (const [key, entryValue] of entries) {
        encode(key, depth + 1)
        encode(entryValue, depth + 1)
      }
      return
    }
    throw new Error(`maxMsgpackEncode: unsupported value of type ${typeof item}`)
  }
  encode(value, 0)
  return Buffer.concat(chunks)
}

// A port of the page's LZ4 block encoder (`Kne`), so a frame the scraper
// writes is byte-for-byte the frame MAX Web would write for the same payload.
function lz4BlockCompress(input) {
  const MIN_MATCH = 4, LAST_LITERALS = 5, MF_LIMIT = 12, MIN_LENGTH = 13, MAX_DISTANCE = 65535
  const HASH_LOG = 13, HASH_SIZE = 1 << HASH_LOG, SKIP_STRENGTH = 6
  const read32 = (b, i) => (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0
  const hashAt = (b, i) => Math.imul(read32(b, i), 2654435761) >>> (32 - HASH_LOG) & (HASH_SIZE - 1)
  const src = Uint8Array.from(input)
  const end = src.length
  const out = new Uint8Array(end + Math.floor(end / 255) + 16)
  const writeLiterals = (op, anchor) => {
    const length = end - anchor
    if (length >= 15) {
      out[op++] = 15 << 4
      let rest = length - 15
      for (; rest >= 255; rest -= 255) out[op++] = 255
      out[op++] = rest
    } else {
      out[op++] = length << 4
    }
    for (let i = 0; i < length; i++) out[op++] = src[anchor + i]
    return op
  }
  if (end === 0) return new Uint8Array()
  if (end < MIN_LENGTH) return out.subarray(0, writeLiterals(0, 0))
  const table = new Int32Array(HASH_SIZE).fill(0)
  const mfLimit = end - MF_LIMIT
  const matchLimit = end - LAST_LITERALS
  let ip = 0, anchor = 0, op = 0
  table[hashAt(src, ip)] = ip
  ip++
  let forwardHash = hashAt(src, ip)
  for (;;) {
    let ref
    let forwardIp = ip, step = 1, attempts = 1 << SKIP_STRENGTH
    do {
      const h = forwardHash
      ip = forwardIp
      forwardIp += step
      step = attempts++ >>> SKIP_STRENGTH
      if (forwardIp > mfLimit) return out.subarray(0, writeLiterals(op, anchor))
      ref = table[h]
      table[h] = ip
      forwardHash = hashAt(src, forwardIp)
    } while (ref + MAX_DISTANCE < ip || read32(src, ref) !== read32(src, ip))
    while (ip > anchor && ref > 0 && src[ip - 1] === src[ref - 1]) { ip--; ref-- }
    const literalLength = ip - anchor
    let token = op++
    if (literalLength >= 15) {
      out[token] = 15 << 4
      let rest = literalLength - 15
      for (; rest >= 255; rest -= 255) out[op++] = 255
      out[op++] = rest
    } else {
      out[token] = literalLength << 4
    }
    for (let i = 0; i < literalLength; i++) out[op++] = src[anchor + i]
    for (;;) {
      const distance = ip - ref
      out[op++] = distance & 255
      out[op++] = (distance >>> 8) & 255
      let matchLength = 0
      while (ip + MIN_MATCH + matchLength < matchLimit && src[ip + MIN_MATCH + matchLength] === src[ref + MIN_MATCH + matchLength]) matchLength++
      ip += MIN_MATCH + matchLength
      if (matchLength >= 15) {
        out[token] |= 15
        matchLength -= 15
        for (; matchLength >= 510; matchLength -= 510) { out[op++] = 255; out[op++] = 255 }
        if (matchLength >= 255) { matchLength -= 255; out[op++] = 255 }
        out[op++] = matchLength
      } else {
        out[token] |= matchLength
      }
      anchor = ip
      if (ip > mfLimit) return out.subarray(0, writeLiterals(op, anchor))
      table[hashAt(src, ip - 2)] = ip - 2
      ref = table[hashAt(src, ip)]
      table[hashAt(src, ip)] = ip
      if (ref + MAX_DISTANCE >= ip && read32(src, ref) === read32(src, ip)) { token = op++; out[token] = 0; continue }
      forwardHash = hashAt(src, ++ip)
      break
    }
  }
}

const MAX_FRAME_COMPRESSION_THRESHOLD = 32

// The seq range of the scraper's own requests, and how close the page's own
// counter may come to it before the scraper stops sending.
const OWN_REQUEST_SEQ_BASE = 30000
const OWN_REQUEST_SEQ_SPAN = 2700
const OWN_REQUEST_SEQ_GUARD = 5000
// A socket closed within this window of a scraper wire action counts against
// it; this many such closes switch the actions off for the process.
const WIRE_INTERVENTION_CLOSE_WINDOW_MS = 3_000
const WIRE_INTERVENTION_CLOSE_LIMIT = 2
const CATCH_UP_DEBOUNCE_MS = 3_000
const CATCH_UP_RETRY_MS = 15_000
const CATCH_UP_PAGE_SIZE = 40
const CATCH_UP_MAX_PAGES = 5
const CATCH_UP_REQUEST_TIMEOUT_MS = 10_000
// The op:19 refusals on which MAX Web itself logs out (bundle, socket client).
const MAX_SESSION_ENDING_LOGIN_ERRORS = new Set(['login.token', 'login.blocked', 'login.flood', 'user.not.found'])

/** One MAX Web socket frame, exactly as the page's `ere` builds it. */
function encodeMaxBinaryFrame({ cmd = 0, seq, opcode, payload } = {}) {
  if (!Number.isInteger(seq) || seq < -0x8000 || seq > 0x7fff) throw new Error(`encodeMaxBinaryFrame: invalid seq ${seq}`)
  if (!Number.isInteger(opcode) || opcode < 0 || opcode > 0x7fff) throw new Error(`encodeMaxBinaryFrame: invalid opcode ${opcode}`)
  let body = payload === undefined || payload === null ? Buffer.alloc(0) : maxMsgpackEncode(payload)
  let compression = 0
  if (body.length > MAX_FRAME_COMPRESSION_THRESHOLD) {
    const compressed = Buffer.from(lz4BlockCompress(body))
    compression = Math.min(Math.ceil(body.length / compressed.length), 255)
    if (compression > 0) body = compressed
  }
  if (body.length > 0xffffff) throw new Error('encodeMaxBinaryFrame: payload too large')
  const frame = Buffer.alloc(MAX_FRAME_HEADER_BYTES + body.length)
  frame[0] = MAX_FRAME_PROTOCOL_VERSION
  frame[1] = cmd
  frame.writeInt16BE(seq, 2)
  frame.writeInt16BE(opcode, 4)
  frame[6] = compression
  frame[7] = (body.length >>> 16) & 0xff
  frame[8] = (body.length >>> 8) & 0xff
  frame[9] = body.length & 0xff
  body.copy(frame, MAX_FRAME_HEADER_BYTES)
  return frame
}

// A provider timestamp (ms) carried as an ext int64, or null.
function maxExtTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const numeric = maxIdValueToBigInt(value)
  if (numeric === null || numeric <= 0n || numeric > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(numeric)
}

// ─── WS Init Script — инжектируется ДО навигации ─────────────────────────────
// Перехватывает конструктор WebSocket, сохраняет ссылку на MAX WS,
// и добавляет window.__maxWsSendBinary(base64) для отправки бинарных фреймов из Node.js
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
      // The scraper's page is a relay, never a reader: a read mark (op:50) it
      // sent would tell the driver a message was read that no person has read
      // (D-19). The frame header is plain, so the opcode is read from bytes 4-5.
      var _origSend = ws.send;
      ws.send = function (data) {
        try {
          if (window.__maxSuppressReadMarks !== false) {
            var u8 = data instanceof ArrayBuffer ? new Uint8Array(data)
              : (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null);
            if (u8 && u8.length >= 10 && u8[0] === 10 && ((u8[4] << 8) | u8[5]) === 50) {
              try { if (window.__maxWsReceive) window.__maxWsReceive('{"__diag":"read_mark_withheld","seq":' + ((u8[2] << 8) | u8[3]) + ',"cmd":' + u8[1] + '}'); } catch (e3) {}
              return;
            }
          }
        } catch (e2) {}
        return _origSend.apply(ws, arguments);
      };
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

function normalizeUiText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n')
}

function isUiTextSubmitObserved(beforeText, afterText, expectedText) {
  const expected = normalizeUiText(expectedText)
  if (!expected) return false
  return normalizeUiText(beforeText) === expected && normalizeUiText(afterText).trim() === ''
}

/**
 * A first send from a phone-resolved profile currently exposes only compose
 * state and background/own-text frames. None of those signals carries the
 * CRM operation identity or an independently known expected chat id, so they
 * cannot prove that this operation delivered to this target.
 *
 * Keep the attempted action terminal for the current HTTP request, but leave
 * delivery pending until MAX exposes an operation- and target-bound proof.
 */
function evaluatePhoneResolutionUiSend({
  beforeText,
  afterText,
  expectedText,
  postActionFrames,
} = {}) {
  const submitObserved = isUiTextSubmitObserved(beforeText, afterText, expectedText)
  const observedFrameCount = Array.isArray(postActionFrames) ? postActionFrames.length : 0

  return {
    chatId: null,
    uiSendAttempted: true,
    deliveryConfirmed: false,
    confirmationSource: submitObserved
      ? 'send_requested_no_authoritative_proof'
      : 'ui_action_unconfirmed',
    submitObserved,
    observedFrameCount,
  }
}

// ─── One text send: correlation and outcome ─────────────────────────────────
// MAX pushes no op:128 echo to the session that sent a message (none of the
// seven CRM sends of 2026-10-02 19:25-19:32 got one). Its answer to a send is
// the op:64 RESPONSE (cmd 1) carrying the seq of the page's own op:64 request,
// and that request is visible here as an outgoing frame. So a send is proven
// only by:
//   request:  an outgoing op:64 (cmd 0, or 2 when re-sent after login) whose
//             chatId and text are this send's;
//   response: an incoming op:64 cmd 1 with that request's seq, the same chat,
//             the same text and - when both carry one - the same cid.
// No other frame can supply the id. A reactions snapshot, a chat update or a
// page reload replay is exactly how "7" was given the id of "6".

function normalizeSentMaxText(value) {
  return String(value ?? '')
    .replace(/ /g, ' ')
    .replace(/\r\n/g, '\n')
    .trim()
}

class MaxTextSendObservation {
  constructor({ chatId, text, now = () => Date.now() } = {}) {
    this.chatId = maxChatIdString(chatId) ?? String(chatId ?? '')
    this.text = normalizeSentMaxText(text)
    this.request = null
    this.extraRequests = []
    this.response = null
    this.rejection = null
    this.conflictingResponse = null
    this.ignoredResponses = 0
    this.closed = false
    this._now = now
    this._waiters = new Set()
  }

  // The page's request names the chat by its real id, MAX's answer by the id
  // the scraper decodes to its protocol id: both are compared as real ids.
  _sameChat(value) {
    return sameMaxChatId(value, this.chatId)
  }

  _targets(payload) {
    return this._sameChat(payload?.chatId)
      && normalizeSentMaxText(payload?.message?.text) === this.text
  }

  _requestSeqs() {
    return [this.request, ...this.extraRequests].filter(Boolean).map(entry => entry.seq)
  }

  onOutgoingFrame(frame) {
    if (this.closed || frame?.opcode !== OP.SEND_MESSAGE || ![0, 2].includes(frame.cmd)) return
    if (!this._targets(frame.payload)) return
    const entry = {
      seq: frame.seq,
      cmd: frame.cmd,
      cid: maxChatIdString(frame.payload?.message?.cid),
      socket: frame.socket ?? null,
      at: this._now(),
    }
    if (!this.request) {
      this.request = entry
    } else if (entry.seq !== this.request.seq || entry.socket !== this.request.socket) {
      // The page itself sent this text again. Never a second action of ours,
      // but it is recorded, because it is a second copy on the wire.
      this.extraRequests.push(entry)
    }
    this._notify()
  }

  onIncomingFrame(frame) {
    if (this.closed || frame?.opcode !== OP.SEND_MESSAGE || !this.request) return
    if (!this._requestSeqs().includes(frame.seq)) return
    if (frame.cmd === 3) {
      if (!this.response && !this.rejection) {
        this.rejection = {
          seq: frame.seq,
          error: typeof frame.payload?.error === 'string' ? frame.payload.error : null,
          at: this._now(),
        }
      }
      this._notify()
      return
    }
    if (frame.cmd !== 1) return
    const payload = frame.payload || {}
    const message = payload.message || {}
    const providerMessageId = canonicalMaxMessageIdHex(message.id)
    const requestCid = this.request.cid
    const responseCid = maxChatIdString(message.cid)
    const sameChat = this._sameChat(payload.chatId ?? message.chatId)
    const sameText = message.text == null || normalizeSentMaxText(message.text) === this.text
    const sameCid = !requestCid || !responseCid || requestCid === responseCid
    if (!providerMessageId || !/^d301/.test(providerMessageId) || !sameChat || !sameText || !sameCid) {
      this.ignoredResponses += 1
      return
    }
    if (!this.response) {
      this.response = { seq: frame.seq, providerMessageId, at: this._now() }
    } else if (this.response.providerMessageId !== providerMessageId) {
      this.conflictingResponse = { seq: frame.seq, providerMessageId, at: this._now() }
    }
    this._notify()
  }

  _notify() {
    for (const waiter of [...this._waiters]) waiter()
  }

  _waitFor(predicate, timeoutMs) {
    if (predicate()) return Promise.resolve(true)
    return new Promise(resolve => {
      let timer = null
      const waiter = () => {
        if (!predicate()) return
        clearTimeout(timer)
        this._waiters.delete(waiter)
        resolve(true)
      }
      timer = setTimeout(() => {
        this._waiters.delete(waiter)
        resolve(predicate())
      }, Math.max(0, timeoutMs))
      this._waiters.add(waiter)
    })
  }

  waitForRequest(timeoutMs) {
    return this._waitFor(() => Boolean(this.request), timeoutMs)
  }

  waitForAnswer(timeoutMs) {
    return this._waitFor(() => Boolean(this.response || this.rejection), timeoutMs)
  }

  close() {
    this.closed = true
    this._notify()
  }

  snapshot() {
    return {
      request: this.request,
      extraRequests: this.extraRequests.slice(),
      response: this.response,
      rejection: this.rejection,
      conflictingResponse: this.conflictingResponse,
      ignoredResponses: this.ignoredResponses,
    }
  }
}

/**
 * The outcome of ONE send call, from what the call did and what the wire
 * showed. Outcomes:
 *   accepted        a correlated provider id: MAX has this message
 *   requested       the page put this send on the wire; MAX's answer was not
 *                   seen. Reported without an id, never as delivered
 *   rejected        MAX answered the request with an error
 *   not_dispatched  nothing reached the wire and nothing can: safe to send again
 *   unknown         an action was taken and nothing proves either way; the
 *                   caller must never send this text again on its own
 */
function decideMaxTextSendOutcome({ action = {}, evidence = {} } = {}) {
  const requestSeq = evidence.request?.seq ?? null
  const wire = {
    requestSeq,
    extraRequestFrames: Array.isArray(evidence.extraRequests) ? evidence.extraRequests.length : 0,
  }
  if (evidence.response?.providerMessageId) {
    const storeId = action.storeConfirmedId || null
    if (evidence.conflictingResponse || (storeId && storeId !== evidence.response.providerMessageId)) {
      return { outcome: 'unknown', reason: 'provider_id_conflict', ...wire }
    }
    return {
      outcome: 'accepted',
      providerMessageId: evidence.response.providerMessageId,
      proofKind: 'provider_ack',
      ...wire,
    }
  }
  if (evidence.rejection) {
    return { outcome: 'rejected', reason: evidence.rejection.error || 'provider_error', ...wire }
  }
  if (action.storeConfirmedId && /^d301[0-9a-f]{14}$/.test(action.storeConfirmedId)) {
    // A reply read back from the page's provider store: a NEW server-assigned
    // id on an outgoing message carrying exactly this text and reply link.
    return {
      outcome: 'accepted',
      providerMessageId: action.storeConfirmedId,
      proofKind: 'provider_store_readback',
      ...wire,
    }
  }
  if (evidence.request) {
    return { outcome: 'requested', proofKind: 'client_frame', ...wire }
  }
  if (!action.performed) {
    return { outcome: 'not_dispatched', reason: action.notDispatchedReason || 'no_action_taken', ...wire }
  }
  if (action.kind === 'compose' && action.composeRetainedText === true) {
    // The compose box still holds the exact text, so the page never took the
    // submit and has nothing queued.
    return { outcome: 'not_dispatched', reason: 'compose_not_submitted', ...wire }
  }
  return { outcome: 'unknown', reason: action.unknownReason || 'submitted_without_send_frame', ...wire }
}

/**
 * Runs exactly one physical send action and returns its decided outcome. There
 * is no fallback and no retry inside a call: once `performAction` has run, the
 * only answers are the ones the wire supports.
 */
async function runSingleMaxTextSend({
  transport,
  chatId,
  text,
  ensureReady,
  performAction,
  requestTimeoutMs = 4000,
  answerTimeoutMs = 10_000,
} = {}) {
  const readiness = await ensureReady()
  if (!readiness?.ready) {
    // MAX refused the route itself (an error answer to the page opening the
    // chat): nothing was typed, and sending again would meet the same refusal.
    if (readiness?.refusedCode) {
      return { outcome: 'refused', code: readiness.refusedCode, reason: readiness.reason || null, requestSeq: null, extraRequestFrames: 0 }
    }
    return decideMaxTextSendOutcome({
      action: { performed: false, notDispatchedReason: readiness?.reason || 'transport_not_ready' },
    })
  }
  const observation = transport.beginTextSendObservation({ chatId, text })
  let action
  try {
    action = await performAction()
  } catch (error) {
    action = { performed: true, unknownReason: `action_failed:${String(error?.message || error).slice(0, 120)}` }
  }
  try {
    if (action?.performed) {
      const requestSeen = await observation.waitForRequest(requestTimeoutMs)
      if (requestSeen) {
        await observation.waitForAnswer(answerTimeoutMs)
      } else if (typeof action.inspectWithoutRequest === 'function') {
        // Only now, after the wire stayed silent, is the page's own state read.
        try {
          Object.assign(action, await action.inspectWithoutRequest())
        } catch {}
      }
    }
    return decideMaxTextSendOutcome({ action: action || {}, evidence: observation.snapshot() })
  } finally {
    transport.endTextSendObservation(observation)
  }
}

class TransportInterceptor {
  /** `stateDir`: where the per-chat anchors and open gaps live (default: the user_data volume). */
  constructor({ stateDir = DEFAULT_STATE_DIR } = {}) {
    this._lastMsgIdsPath       = path.join(stateDir, LAST_MSG_IDS_FILE)
    this._catchUpGapsPath      = path.join(stateDir, CATCH_UP_GAPS_FILE)
    this._messageHandlers      = []
    this._rawHandlers          = []  // для перехвата опкодов (32, 48 и т.д.)
    this._sentReactionHandlers = []  // срабатывают когда пользователь ставит реакцию в MAX веб
    this._page                 = null
    this._cdpClient            = null
    this._pendingReqs          = new Map()  // own request seq → {resolve, reject, timeout, opcode, purpose}
    this._ownRequestCounter    = 0          // position in the own-request seq range
    this._pageOutSeqHigh       = -1         // highest seq the page itself used on the current socket
    this._wireIntervention     = { disabled: false, reason: null, lastAt: 0, closesAfter: 0 }
    this._readMarksWithheld    = 0          // page read marks (op:50) the in-page hook did not send
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
    this._sendObservations     = new Set() // MaxTextSendObservation per in-flight send call
    this._browserAckHandlers   = []        // page acknowledged a push: {chatId, messageId}
    this._sessionLoss          = null      // { reason, at } once MAX ended the session
    this._sessionLossHandlers  = []
    this._readMarkHandlers     = []        // a peer read mark advanced: {chatId, readerId, mark, source}
    this._peerReadMarks        = new Map() // `${chatId}:${readerId}` -> newest mark forwarded
    this._routeAttestations    = new Map() // real chat id -> MAX's answer to the page opening it
    this._pageRouteRequests    = new Map() // page seq -> { opcode, realChatId } of op:75 / op:49
    this._gapFloors            = new Map() // chatId -> newest confirmed message before a possible hole
    this._catchUp              = { running: false, timer: null, lastRunAt: 0, lastResult: null, isBusy: () => false }

    // Load persisted message IDs from previous sessions.
    // This lets us catch up chats that op:48 doesn't include in its startup push.
    try {
      const saved = JSON.parse(fs.readFileSync(this._lastMsgIdsPath, 'utf8'))
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
    this._loadGapFloors()
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
    this._cdpClient.on('Network.webSocketFrameSent', ({ requestId, response }) => {
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
          if (buf.length >= MAX_FRAME_HEADER_BYTES && buf[0] === MAX_FRAME_PROTOCOL_VERSION) {
            const opcode  = buf.readInt16BE(4)
            const outgoing = decodeMaxBinaryFrame(buf)
            if (outgoing.ok) {
              this._handleOutgoingFrame({ ...outgoing, socket: requestId ?? null })
            } else {
              console.warn(`[WS→MAX BIN] undecodable outgoing frame reason:${outgoing.reason} op:${outgoing.opcode ?? 'n/a'} seq:${outgoing.seq ?? 'n/a'}`)
            }
            // A live video notification may not expose its d301 message id in
            // op:128/op:180. MAX Web immediately follows it with a binary
            // op:83 request containing {chatId, messageId, videoId}. Correlate
            // that browser-owned request only while fresh loose media exists.
            if (outgoing.ok && outgoing.opcode === OP.RESOLVE_VIDEO && outgoing.cmd === 0 && !this._isOwnRequestSeq(outgoing.seq)) {
              try {
                const correlation = this._handleBrowserVideoResolveRequest(outgoing.payload)
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
            console.log('[WS→MAX BIN] op:', outgoing.opcode ?? opcode, 'cmd:', outgoing.cmd ?? 'n/a', 'seq:', outgoing.seq ?? 'n/a',
              'compression:', outgoing.compression ?? 'n/a', 'len:', buf.length, 'hex:', hex)
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
      // The next socket's page counts its seqs from 0 again.
      this._pageOutSeqHigh = -1
      this._pageRouteRequests.clear()
      this._noteSocketClosedForIntervention()
      this._rejectOwnRequestsOnSocketLoss()
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

  // ─── Исходящие фреймы страницы (декодированные) ─────────────────────────

  _handleOutgoingFrame(frame) {
    // A frame in the scraper's own seq range is the scraper's, whether or not
    // its answer has already come back: never the page's request or seq.
    if (this._isOwnRequestSeq(frame.seq)) return
    if ((frame.cmd === 0 || frame.cmd === 2) && Number.isInteger(frame.seq)) {
      if (frame.cmd === 0 && frame.seq > this._pageOutSeqHigh) this._pageOutSeqHigh = frame.seq
      this._notePageRouteRequest(frame)
    }
    for (const observation of this._sendObservations) {
      try { observation.onOutgoingFrame(frame) } catch {}
    }
    // The page acknowledges every op:128 push it received with
    // {chatId, messageId} (cmd 1, the push's own seq). That acknowledgement is
    // the page's record that a message EXISTS, independent of whether the
    // scraper managed to decode or persist the push itself.
    if (frame.opcode === OP.INCOMING_MSG && frame.cmd === 1) {
      const rawChatId = frame.payload?.chatId
      const messageId = canonicalMaxMessageIdHex(frame.payload?.messageId)
      const chatIdStr = this._resolveBrowserAckChatId(rawChatId)
      if (!chatIdStr) return
      console.log(`[op128ack] page acknowledged chatId:${chatIdStr} msgId:${messageId || 'n/a'}`)
      this._rememberRecentOp128Chat(chatIdStr)
      const registrations = this._registerPreChatPendingForChat(chatIdStr)
      if (registrations.length > 0) {
        console.log(`[op128ack] registered ${registrations.length} pending live msg(s) for chatId:${chatIdStr} ids:${registrations.map(r => r.pendingHex.slice(0,16)).join(',')}`)
      }
      if (messageId && /^d301/.test(messageId)) {
        for (const handler of this._browserAckHandlers) {
          try { handler({ chatId: chatIdStr, rawChatId: maxChatIdString(rawChatId), messageId }) } catch {}
        }
      }
    }
  }

  // The page acknowledges a push with the chat id as it holds it, which can be
  // the 32-bit web route rather than the 64-bit provider chat id.
  _resolveBrowserAckChatId(rawChatId) {
    const raw = maxChatIdString(rawChatId)
    if (!raw || raw === '0') return null
    const known = [...this._recentActiveChatIds.keys(), ...this._lastMsgRawHex.keys()]
    if (known.includes(raw)) return raw
    let shortId
    try { shortId = BigInt.asUintN(32, BigInt(raw)) } catch { return raw }
    for (const candidate of known) {
      try {
        if (BigInt.asUintN(32, BigInt(candidate)) === shortId) return candidate
      } catch {}
    }
    return raw
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
      } else if (data.__diag === 'read_mark_withheld') {
        // The page tried to mark messages read (op:50); the in-page hook did not
        // send it. Counts as a wire action for the close guard.
        this._readMarksWithheld += 1
        this._wireIntervention.lastAt = Date.now()
        console.log(`[readMark] page read mark withheld seq:${data.seq} cmd:${data.cmd} total:${this._readMarksWithheld}`)
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

  // A chat-list page or a history load carries messages that are not new. One
  // is new for this process only if it is newer than the newest message
  // confirmed for its chat; a chat seen for the first time is only anchored.
  // Read whole, these frames would otherwise replay every conversation's last
  // message into the CRM.
  _emitIfNewerThanAnchor(chatId, message, source) {
    const chatIdStr = String(chatId || '')
    const msgHex = message?.id?.__maxId ? canonicalMaxMessageIdHex(message.id) : null
    if (!chatIdStr || !isUsableMaxMessageHex(msgHex)) return { emitted: false, reason: 'no_provider_id' }
    const anchorHex = this._lastMsgRawHex.get(chatIdStr)
    if (!isUsableMaxMessageHex(anchorHex)) {
      this._rememberConfirmedMessageAnchor(chatIdStr, msgHex, { markSeen: true })
      this._persistLastMsgRawHex()
      return { emitted: false, reason: 'anchor_seeded' }
    }
    if (compareMaxIdHex(msgHex, anchorHex) <= 0) return { emitted: false, reason: 'not_newer' }
    // A snapshot's lastMessage newer than the anchor may hide earlier messages
    // that never arrived; the old anchor is where the catch-up starts.
    if (source === 'op:48' || source === 'op:53') this.noteGapFloor(chatIdStr, anchorHex, source)
    this._rememberConfirmedMessageAnchor(chatIdStr, msgHex, { markSeen: true })
    this._persistLastMsgRawHex()
    const pseudo = { chatId: chatIdStr, message }
    this._consumeLooseMediaForMessage(pseudo)
    const msg = this._normalizeMaxMsg(pseudo)
    if (!msg || (!msg.text && !msg.attachments?.length)) return { emitted: false, reason: 'no_content' }
    console.log(`[Transport] ${source} message newer than anchor chat:${chatIdStr} id:${msgHex.slice(0,16)} from:${msg.from} out:${msg.isOutgoing}`)
    this._emit(msg)
    return { emitted: true, reason: 'newer_than_anchor' }
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
        // A linked (forwarded or replied-to) message is content of its parent,
        // never a message of this chat.
        if (key === '__complexEntries' || key === 'link') continue
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

  // A page request names a chat by its real id; the scraper keys chats by
  // protocol id (see maxRealIdFromProtocolId).
  _resolveKnownChatId(rawChatId) {
    const real = maxRealIdFromProtocolId(rawChatId)
    if (real === null) return maxIdToString(rawChatId)
    for (const source of [this._recentOp128ChatIds, this._recentActiveChatIds, this._lastMsgRawHex]) {
      for (const cid of source.keys()) {
        if (sameMaxChatId(cid, real)) return String(cid)
      }
    }
    return real.toString()
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

    // Answers to the scraper's own requests (cmd 1 response, cmd 3 error):
    // matched by seq AND opcode, and never shown to the generic handlers below,
    // so an answer to a catch-up request is not mistaken for the page's own.
    const ownRequest = (data.cmd === 1 || data.cmd === 3) ? this._pendingReqs.get(data.seq) : null
    if (ownRequest && ownRequest.opcode === data.opcode) {
      clearTimeout(ownRequest.timeout)
      this._pendingReqs.delete(data.seq)
      if (data.cmd === 3 || data.payload?.error) {
        const maxError = typeof data.payload?.error === 'string' ? data.payload.error : 'error'
        ownRequest.reject(Object.assign(
          new Error(data.payload?.localizedMessage || data.payload?.message || maxError),
          { opcode: data.opcode, purpose: ownRequest.purpose, reason: `refused:${maxError}`, dispatched: true, refused: true, maxError, maxPayload: data.payload, seq: data.seq },
        ))
      } else {
        ownRequest.resolve(data.payload)
      }
      return
    }
    this._notePageRouteAnswer(data)
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
      // Now that op:19 decodes whole, every login carries the profile; its id is
      // normalized so an ext-encoded value can never become "[object Object]".
      const id = maxChatIdString(data.payload?.profile?.contact?.id)
      console.log(`[Auth] Opcode 19: cmd=${data.cmd}, has_profile=${!!data.payload?.profile}, userId=${id || 'none'}`)
      if (data.cmd === 3) {
        // MAX refused the login on this socket (login.token, login.blocked, ...).
        // Nothing sent on it would be accepted, so it is not a send-ready socket.
        const loginError = typeof data.payload?.error === 'string' ? data.payload.error : null
        console.warn(`[Auth] Opcode 19 refused: ${loginError || 'unknown error'}`)
        this._wsConnected = false
        if (loginError && MAX_SESSION_ENDING_LOGIN_ERRORS.has(loginError)) this._handleSessionLoss(`login_refused:${loginError}`)
      } else {
        // op:19 answered: MAX accepts op:64 on this socket from here on.
        this._wsConnected = true
        if (id && this._sessionLoss) {
          console.log(`[Session] MAX session proven again after ${this._sessionLoss.reason}`)
          this._sessionLoss = null
        }
        this._fireWsReady()
        if (id) {
          this._myUserId = String(id)
          console.log('[Transport] My userId:', this._myUserId)
          for (const h of this._wsAuthHandlers) try { h(this._myUserId) } catch {}
        }
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
          this._notePeerReadMarksFromChat(chat, 'op53')

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
          if (!candidates.length) continue

          // op:53 answers the page's own chat-list request: each chat with its
          // lastMessage, not a stream of new messages. Only a lastMessage newer
          // than the newest message this process confirmed for the chat is
          // emitted (a message missed while the socket was down); an unseen chat
          // is only anchored. Nested link messages are never this chat's own.
          for (const candidate of candidates) {
            const msgId = candidate.id.__maxId ? candidate.id.hex : String(candidate.id)
            if (this._lastSeenMsgId.get(chatId) === msgId) continue
            this._emitIfNewerThanAnchor(chatId, candidate, 'op:53')
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
          this._notePeerReadMarksFromChat(chat, 'op48')
          chatIds.push(chatId)
          // The lastMessage id is the chat's anchor (and, past a gap, the catch-up's target)
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
            // A chat's lastMessage newer than its anchor arrived while this
            // process was not receiving pushes (a socket gap, a restart): it is
            // emitted, never silently confirmed. An unseen chat is anchored.
            const anchorResult = this._emitIfNewerThanAnchor(chatId, lastMsg, 'op:48')
            if (anchorResult.reason === 'anchor_seeded') {
              console.log(`[op48] chatId:${chatId} anchor ${String(lastMsg.id.hex).slice(0,16)} (lastMsg)`)
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
              // Moving the anchor past messages never received opens a hole; it is
              // recorded so the catch-up fills it.
              const previousAnchor = this._lastMsgRawHex.get(chatId)
              if (isUsableMaxMessageHex(previousAnchor) && compareMaxIdHex(bestHex, previousAnchor) > 0) {
                this.noteGapFloor(chatId, previousAnchor, 'op48_map_key')
              }
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
              fs.mkdirSync(path.dirname(this._lastMsgIdsPath), { recursive: true })
              fs.writeFileSync(this._lastMsgIdsPath, JSON.stringify(Object.fromEntries(this._lastMsgRawHex)))
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
        if (!isUsableMaxMessageHex(this._lastMsgRawHex.get(chatIdStr))) {
          // History of a chat with no confirmed anchor is old history: anchor at
          // its newest message and emit nothing, instead of replaying it all.
          const newest = messages
            .map(m => canonicalMaxMessageIdHex(m?.id))
            .filter(isUsableMaxMessageHex)
            .sort(compareMaxIdHex)
            .pop()
          if (newest && this._rememberConfirmedMessageAnchor(chatIdStr, newest, { markSeen: true })) {
            this._persistLastMsgRawHex()
            console.log(`[op49] chatId:${chatIdStr} anchor ${newest.slice(0,16)} (history of an unanchored chat; nothing emitted)`)
          }
          messages = []
        }
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
              fs.writeFileSync(this._lastMsgIdsPath, JSON.stringify(Object.fromEntries(this._lastMsgRawHex)))
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

    // op:130 — a participant's read mark moved: {chatId, userId, mark, unread}.
    // Another participant's mark is a read receipt for every message at or
    // before it (see _notePeerReadMark); a mark of our own is only our state.
    if (data.opcode === 130) {
      const chatId = data.payload?.chatId != null ? maxChatIdString(data.payload.chatId) : null
      if (chatId && chatId !== '0') {
        console.log(`[op130] mark chatId:${chatId} userId:${maxChatIdString(data.payload?.userId) || 'n/a'}`)
        this._rememberRecentOp128Chat(chatId)
        if (data.cmd === 0 && !data.payload?.setAsUnread) {
          this._notePeerReadMark(chatId, data.payload?.userId, data.payload?.mark, 'op130')
        }
      }
    }

    // op:20 — logout: the page drops its auth.
    if (data.opcode === 20 && (data.cmd === 0 || data.cmd === 1)) {
      this._handleSessionLoss('logout')
    }
  }

  // ─── Декодирование бинарных WS фреймов (api.oneme.ru) ───────────────────
  //
  // Layout and compression: see decodeMaxBinaryFrame. The cmd values are the
  // protocol's own (0 push, 1 response, 3 error) - the same meaning the JSON
  // protocol handling below was written for - so nothing is remapped.
  _handleBinaryFrame(buf) {
    const frame = decodeMaxBinaryFrame(buf)
    if (!frame.ok) {
      // Never guess at a partial decode. The page still acknowledges a push it
      // received (op:128 cmd 1), and that acknowledgement is what recovers it.
      console.warn(`[BIN] undecodable frame reason:${frame.reason} op:${frame.opcode ?? 'n/a'} cmd:${frame.cmd ?? 'n/a'} seq:${frame.seq ?? 'n/a'} compression:${frame.compression ?? 'n/a'}${frame.error ? ` error:${frame.error}` : ''}`)
      return
    }

    const payload = frame.payload === undefined ? {} : frame.payload
    const data = { opcode: frame.opcode, cmd: frame.cmd, seq: frame.seq, payload, _compression: frame.compression }

    if (frame.opcode !== OP.PRESENCE) {
      console.log('[BIN] op:', frame.opcode, 'cmd:', frame.cmd, 'seq:', frame.seq, 'compression:', frame.compression,
        JSON.stringify(payload).slice(0, 200))
    }

    for (const observation of this._sendObservations) {
      try { observation.onIncomingFrame(data) } catch {}
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

    // Ids and times are ext-encoded 64-bit values on the wire; read whole,
    // they must keep the forms the rest of the scraper and the CRM already use
    // (d3… message ids, ms times). A chat or sender id that arrives ext-encoded
    // becomes its decimal string; a plain number is left as it always was.
    const extOrValue = value => (value && typeof value === 'object') ? maxChatIdString(value) : value
    const sender = String(extOrValue(m.sender) || '')
    return {
      id:                m.id?.__maxId ? (canonicalMaxMessageIdHex(m.id) || m.id.hex) : (m.id || null),
      chatId:            extOrValue(payload.chatId) || null,
      from:              sender,
      text,
      timestamp:         maxExtTimestampMs(m.time) || Date.now(),
      type:              hasAttaches ? this._detectMaxType(attaches) : 'text',
      attachments:       this._extractMaxAttachmentsV2(attaches),
      isOutgoing:        this._myUserId ? sender === this._myUserId : protocolOutgoing,
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
      fs.mkdirSync(path.dirname(this._lastMsgIdsPath), { recursive: true })
      fs.writeFileSync(this._lastMsgIdsPath, JSON.stringify(Object.fromEntries(this._lastMsgRawHex)))
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

  /** Operator diagnostic: catch a chat up from `anchorHex` (or its confirmed anchor). */
  async forceHistoryCatchup(chatId, anchorHex) {
    const chatIdStr = String(chatId)
    const floor = canonicalMaxMessageIdHex(anchorHex) || this._lastMsgRawHex.get(chatIdStr) || null
    if (!isUsableMaxMessageHex(floor)) throw new Error('No provider message id to catch up from')
    this._gapFloors.delete(chatIdStr)
    this.noteGapFloor(chatIdStr, floor, 'operator')
    return this.runCatchUp({ reason: 'operator' })
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

  // ─── The scraper's own requests on the page's socket ────────────────────
  // Every request the scraper sends is a binary frame in the page's own format
  // (encodeMaxBinaryFrame) carrying the real ids the page itself would send.
  // Its seq comes from a range the page never reaches on one socket (the page
  // counts from 0 per socket, and the guard stops requests long before the
  // page could get near), so the page's dispatcher - which resolves a response
  // only through its own map of pending seqs - ignores the answer, and the
  // answer is this request's alone.
  //
  // A request that never reached the socket is reported dispatched:false (safe
  // to repeat). After it reached the socket, a timeout or a lost socket is
  // dispatched:true with no answer (outcome unknown), and an error frame is a
  // refusal carrying MAX's own error code.
  _isOwnRequestSeq(seq) {
    return Number.isInteger(seq) && seq >= OWN_REQUEST_SEQ_BASE && seq < OWN_REQUEST_SEQ_BASE + OWN_REQUEST_SEQ_SPAN
  }

  _allocateOwnRequestSeq() {
    for (let attempt = 0; attempt < OWN_REQUEST_SEQ_SPAN; attempt++) {
      const seq = OWN_REQUEST_SEQ_BASE + (this._ownRequestCounter++ % OWN_REQUEST_SEQ_SPAN)
      if (!this._pendingReqs.has(seq)) return seq
    }
    return null
  }

  /** Why the scraper may not put a frame of its own on the page's socket now, or null. */
  ownRequestBlocker() {
    if (!this._page) return 'no_page'
    if (this._wireIntervention.disabled) return `wire_intervention_disabled:${this._wireIntervention.reason}`
    if (!this._wsConnected || !this.isAuthenticated()) return 'socket_not_authenticated'
    if (this._pageOutSeqHigh >= OWN_REQUEST_SEQ_BASE - OWN_REQUEST_SEQ_GUARD) return 'page_seq_near_reserved_range'
    return null
  }

  /**
   * Sends one request in the page's binary format and answers with MAX's
   * response payload. Rejects with an Error carrying `dispatched`, `reason`
   * and, for an error frame, `maxError`/`maxPayload`.
   */
  requestBinary(opcode, payload, { timeoutMs = 10_000, purpose = 'request' } = {}) {
    const fail = (reason, dispatched, extra = {}) =>
      Object.assign(new Error(`MAX op:${opcode} ${purpose} ${dispatched ? 'unanswered' : 'not dispatched'}: ${reason}`), { opcode, purpose, reason, dispatched, ...extra })
    const blocker = this.ownRequestBlocker()
    if (blocker) return Promise.reject(fail(blocker, false))
    const seq = this._allocateOwnRequestSeq()
    if (seq === null) return Promise.reject(fail('no_free_request_seq', false))
    let frame
    try {
      frame = encodeMaxBinaryFrame({ cmd: 0, seq, opcode, payload })
    } catch (error) {
      return Promise.reject(fail(`encode_failed:${error.message}`, false))
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pendingReqs.delete(seq)
        reject(fail('timeout', true, { seq }))
      }, timeoutMs)
      this._pendingReqs.set(seq, { resolve, reject, timeout, opcode, purpose, own: true, sentAt: 0 })
      this._page.evaluate(b => window.__maxWsSendBinary(b), frame.toString('base64'))
        .then(result => {
          const pending = this._pendingReqs.get(seq)
          if (result && result.ok) {
            this._wireIntervention.lastAt = Date.now()
            if (pending) pending.sentAt = Date.now()
            console.log(`[ownRequest] sent op:${opcode} seq:${seq} ${purpose} bytes:${frame.length} compression:${frame[6]}`)
            return
          }
          clearTimeout(timeout)
          this._pendingReqs.delete(seq)
          reject(fail(`page_send_refused:${result?.error || 'unknown'}`, false, { seq }))
        })
        .catch(error => {
          // The page could have run the send before the evaluation failed.
          clearTimeout(timeout)
          this._pendingReqs.delete(seq)
          reject(fail(`page_evaluate_failed:${error.message}`, true, { seq }))
        })
    })
  }

  /**
   * The old call shape, now always the binary format. A caller that does not
   * wait for the answer still never sees a JSON frame on the socket.
   */
  async sendFrame(opcode, payload, { waitResponse = false, timeoutMs = 10_000 } = {}) {
    const request = this.requestBinary(opcode, payload, { timeoutMs, purpose: 'frame' })
    if (waitResponse) return request
    request.catch(error => console.warn(`[ownRequest] op:${opcode} without a waiting caller: ${error.message}`))
  }

  _rejectOwnRequestsOnSocketLoss() {
    for (const [seq, pending] of [...this._pendingReqs.entries()]) {
      if (!pending.own) continue
      clearTimeout(pending.timeout)
      this._pendingReqs.delete(seq)
      pending.reject(Object.assign(new Error(`MAX op:${pending.opcode} ${pending.purpose} unanswered: socket_closed`), {
        opcode: pending.opcode,
        purpose: pending.purpose,
        reason: 'socket_closed',
        dispatched: pending.sentAt > 0,
        seq,
      }))
    }
  }

  // A socket MAX closes right after one of the scraper's own wire actions (a
  // frame it sent, a page read mark it withheld) is counted. Twice is taken
  // as MAX refusing that kind of intervention: the scraper then stops sending
  // frames of its own and stops withholding read marks for this process.
  _noteSocketClosedForIntervention(now = Date.now()) {
    const state = this._wireIntervention
    if (state.disabled || !state.lastAt || now - state.lastAt > WIRE_INTERVENTION_CLOSE_WINDOW_MS) return
    state.closesAfter += 1
    console.warn(`[wire] socket closed ${now - state.lastAt} ms after a scraper wire action (${state.closesAfter}/${WIRE_INTERVENTION_CLOSE_LIMIT})`)
    if (state.closesAfter >= WIRE_INTERVENTION_CLOSE_LIMIT) {
      state.disabled = true
      state.reason = 'socket_closed_after_intervention'
      console.error('[wire] scraper wire actions disabled for this process: MAX closed the socket after them twice')
      this._page?.evaluate(() => { window.__maxSuppressReadMarks = false }).catch(() => {})
    }
  }

  wireInterventionState() {
    return { ...this._wireIntervention, readMarksWithheld: this._readMarksWithheld }
  }

  // ─── Catch-up ───────────────────────────────────────────────────────────
  // A chat-list or chat-info snapshot (op:48, op:53) whose lastMessage is newer
  // than the newest message this process confirmed means messages may have
  // arrived while no push could reach the scraper: a socket gap, a restart.
  // The snapshot only carries the last one, so the newest confirmed message
  // before it is kept as the chat's gap floor - on the volume - and the
  // catch-up asks MAX for the history after it with the page's own op:49
  // request. A gap is closed only when the answer proves it covered it: the
  // answer starts at or before the floor, and reaches the chat's newest
  // message or the end of the history. An answer that proves neither keeps
  // the floor, so a hole is never silently declared filled.
  _loadGapFloors() {
    try {
      const saved = JSON.parse(fs.readFileSync(this._catchUpGapsPath, 'utf8'))
      for (const [chatId, hex] of Object.entries(saved || {})) {
        const floor = canonicalMaxMessageIdHex(hex)
        if (chatId && isUsableMaxMessageHex(floor)) this._gapFloors.set(String(chatId), floor)
      }
      if (this._gapFloors.size) console.log(`[catchUp] loaded ${this._gapFloors.size} open gap(s) from disk`)
    } catch {}
  }

  _persistGapFloors() {
    try {
      fs.mkdirSync(path.dirname(this._catchUpGapsPath), { recursive: true })
      fs.writeFileSync(this._catchUpGapsPath, JSON.stringify(Object.fromEntries(this._gapFloors)))
    } catch (error) {
      console.warn('[catchUp] failed to persist gaps:', error.message)
    }
  }

  /** Records that the history after `floorHex` may be incomplete. An older floor already recorded is kept. */
  noteGapFloor(chatId, floorHex, source = 'snapshot') {
    const chatIdStr = String(chatId || '')
    const floor = canonicalMaxMessageIdHex(floorHex)
    if (!chatIdStr || !isUsableMaxMessageHex(floor)) return false
    const existing = this._gapFloors.get(chatIdStr)
    if (existing && compareMaxIdHex(existing, floor) <= 0) return false
    this._gapFloors.set(chatIdStr, floor)
    this._persistGapFloors()
    console.log(`[catchUp] gap noted chatId:${chatIdStr} after:${floor.slice(0, 16)} source:${source}`)
    this.scheduleCatchUp(CATCH_UP_DEBOUNCE_MS, 'gap_noted')
    return true
  }

  gapFloors() {
    return Object.fromEntries(this._gapFloors)
  }

  /** `isBusy()` answers true while the page must not be disturbed (a send, a DOM recovery). */
  configureCatchUp({ isBusy } = {}) {
    if (typeof isBusy === 'function') this._catchUp.isBusy = isBusy
  }

  scheduleCatchUp(delayMs = CATCH_UP_DEBOUNCE_MS, reason = 'scheduled') {
    if (!this._gapFloors.size) return
    if (this._catchUp.timer) clearTimeout(this._catchUp.timer)
    this._catchUp.timer = setTimeout(() => {
      this._catchUp.timer = null
      this.runCatchUp({ reason }).catch(error => console.error('[catchUp] run failed:', error.message))
    }, Math.max(0, delayMs))
    if (typeof this._catchUp.timer.unref === 'function') this._catchUp.timer.unref()
  }

  async runCatchUp({ reason = 'scheduled', maxPagesPerChat = CATCH_UP_MAX_PAGES, pageSize = CATCH_UP_PAGE_SIZE } = {}) {
    if (this._catchUp.running) return { skipped: 'already_running' }
    if (!this._gapFloors.size) return { skipped: 'no_gaps' }
    const summary = { reason, chats: [], deferred: false }
    this._catchUp.running = true
    try {
      for (const [chatId, floor] of [...this._gapFloors.entries()]) {
        if (this._catchUp.isBusy()) {
          summary.deferred = true
          break
        }
        const blocker = this.ownRequestBlocker()
        if (blocker) {
          summary.deferred = true
          summary.blocker = blocker
          break
        }
        const result = await this._catchUpChat(chatId, floor, { maxPagesPerChat, pageSize })
        summary.chats.push(result)
        if (result.stop) break
      }
    } finally {
      this._catchUp.running = false
      this._catchUp.lastRunAt = Date.now()
      this._catchUp.lastResult = summary
    }
    console.log(`[catchUp] ${reason}: ${JSON.stringify(summary).slice(0, 600)}`)
    if (summary.deferred) this.scheduleCatchUp(CATCH_UP_RETRY_MS, 'deferred')
    return summary
  }

  async _catchUpChat(chatId, startFloor, { maxPagesPerChat, pageSize }) {
    const realChatId = maxRealIdFromProtocolId(chatId)
    const result = { chatId, emitted: 0, pages: 0, closed: false }
    if (realChatId === null) {
      this._gapFloors.delete(chatId)
      this._persistGapFloors()
      return { ...result, reason: 'not_a_chat_id' }
    }
    let floor = startFloor
    for (let page = 0; page < maxPagesPerChat; page++) {
      const fromMs = maxMessageIdTimeMs(floor)
      let answer
      try {
        answer = await this.requestBinary(OP.GET_HISTORY, {
          chatId: realChatId,
          from: fromMs,
          forward: pageSize,
          backward: 0,
          getMessages: true,
        }, { timeoutMs: CATCH_UP_REQUEST_TIMEOUT_MS, purpose: 'catch_up' })
      } catch (error) {
        // A refusal for this chat moves on to the next; a socket problem stops the run.
        return { ...result, reason: error.maxError ? `refused:${error.maxError}` : error.reason, stop: !error.maxError }
      }
      result.pages += 1
      const raw = (Array.isArray(answer?.messages) ? answer.messages : this._extractMessagesDeep(answer?.messages ?? []))
        .map(message => ({ message, id: canonicalMaxMessageIdHex(message?.id) }))
        .filter(entry => isUsableMaxMessageHex(entry.id))
        .sort((a, b) => compareMaxIdHex(a.id, b.id))
      const startsAtFloor = raw.some(entry => compareMaxIdHex(entry.id, floor) <= 0)
      const fresh = raw.filter(entry => compareMaxIdHex(entry.id, floor) > 0)
      for (const { message } of fresh) {
        const pseudo = { chatId, message }
        this._consumeLooseMediaForMessage(pseudo)
        const msg = this._normalizeMaxMsg(pseudo)
        if (!msg || (!msg.text && !msg.attachments?.length)) continue
        // A missed peer message is delivered as a live one; a missed message of
        // our own account is a history read-back of it.
        if (this._emit(msg.isOutgoing ? { ...msg, source: 'catchup' } : msg)) result.emitted += 1
      }
      if (!startsAtFloor) {
        result.reason = 'answer_does_not_cover_floor'
        return result
      }
      const newest = raw.length ? raw[raw.length - 1].id : floor
      const anchor = this._lastMsgRawHex.get(chatId)
      if (raw.length < pageSize || (isUsableMaxMessageHex(anchor) && compareMaxIdHex(newest, anchor) >= 0)) {
        if (isUsableMaxMessageHex(newest) && (!isUsableMaxMessageHex(anchor) || compareMaxIdHex(newest, anchor) > 0)) {
          this._rememberConfirmedMessageAnchor(chatId, newest, { markSeen: true })
          this._persistLastMsgRawHex()
        }
        this._gapFloors.delete(chatId)
        this._persistGapFloors()
        result.closed = true
        return result
      }
      floor = newest
      this._gapFloors.set(chatId, floor)
      this._persistGapFloors()
    }
    result.reason = 'page_budget_spent'
    return result
  }

  // ─── Session loss ───────────────────────────────────────────────────────
  // MAX Web logs itself out - drops its saved auth and closes the session - on
  // exactly these op:19 refusals (bundle: login.token, login.blocked,
  // login.flood, user.not.found), and on an op:20 logout. The account is then
  // no longer proven, whatever an earlier op:19 said.
  _handleSessionLoss(reason) {
    if (this._sessionLoss && this._sessionLoss.reason === reason) return
    const previous = this._myUserId
    this._sessionLoss = { reason, at: new Date().toISOString(), previousAccountId: previous || null }
    this._myUserId = null
    this._wsConnected = false
    console.error(`[Session] MAX ended the session (${reason}); the provider account is no longer proven`)
    for (const handler of this._sessionLossHandlers) {
      try { handler(this._sessionLoss) } catch {}
    }
  }

  onSessionLoss(handler) {
    this._sessionLossHandlers.push(handler)
  }

  sessionLoss() {
    return this._sessionLoss
  }

  // ─── Route attestation ──────────────────────────────────────────────────
  // When the page opens a chat it subscribes to it (op:75) and loads its
  // history (op:49), each with the chat's real id. MAX answering one of those
  // with a response proves the route the page is on is that chat and that this
  // session may use it; an error answer proves it may not.
  _notePageRouteRequest(frame) {
    if (frame.opcode !== OP.SUBSCRIBE_CHAT && frame.opcode !== OP.GET_HISTORY) return
    if (frame.opcode === OP.SUBSCRIBE_CHAT && frame.payload?.subscribe === false) return
    const realChatId = maxRealIdFromProtocolId(frame.payload?.chatId)
    if (realChatId === null) return
    this._pageRouteRequests.set(frame.seq, { opcode: frame.opcode, realChatId: realChatId.toString(), at: Date.now() })
    if (this._pageRouteRequests.size > 64) {
      const oldest = this._pageRouteRequests.keys().next().value
      this._pageRouteRequests.delete(oldest)
    }
  }

  _notePageRouteAnswer(frame) {
    if (frame.cmd !== 1 && frame.cmd !== 3) return
    const request = this._pageRouteRequests.get(frame.seq)
    if (!request || request.opcode !== frame.opcode) return
    this._pageRouteRequests.delete(frame.seq)
    const accepted = frame.cmd === 1
    const error = accepted ? null : (typeof frame.payload?.error === 'string' ? frame.payload.error : 'error')
    // The newest answer for the chat stands.
    this._routeAttestations.set(request.realChatId, { accepted, error, opcode: frame.opcode, at: Date.now() })
    console.log(`[route] page ${frame.opcode === OP.SUBSCRIBE_CHAT ? 'subscribe' : 'history'} for chat ${request.realChatId}: ${accepted ? 'accepted' : `refused (${error})`}`)
  }

  /** What MAX answered to the page opening this chat since `sinceMs`: { accepted, error } or null. */
  routeAttestation(chatId, { sinceMs = 0 } = {}) {
    const realChatId = maxRealIdFromProtocolId(chatId)
    if (realChatId === null) return null
    const entry = this._routeAttestations.get(realChatId.toString())
    if (!entry || entry.at < sinceMs) return null
    return entry
  }

  async waitForRouteAttestation(chatId, { sinceMs = 0, timeoutMs = 4_000, pollMs = 100 } = {}) {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    for (;;) {
      const entry = this.routeAttestation(chatId, { sinceMs })
      if (entry) return entry
      if (Date.now() >= deadline) return null
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
  }

  clearRouteAttestations() {
    this._routeAttestations.clear()
    this._pageRouteRequests.clear()
  }

  // ─── Peer read marks ────────────────────────────────────────────────────
  // MAX Web shows a message as read by a participant when its time is at or
  // before that participant's read mark (bundle: isReadBy(e){return
  // this.time<=this.chat.readMark(e)}). A mark arrives live as an op:130 push
  // {chatId, userId, mark} and in every chat snapshot's participants map. A
  // peer's mark is forwarded once per advance; the scraper's own mark is not a
  // receipt and is never forwarded.
  _notePeerReadMark(chatId, userId, markValue, source) {
    const chatIdStr = maxChatIdString(chatId)
    const readerId = maxChatIdString(userId)
    const mark = maxExtTimestampMs(markValue)
    if (!chatIdStr || !readerId || !mark || mark <= 0) return false
    if (!this._myUserId || sameMaxChatId(readerId, this._myUserId)) return false
    const key = `${chatIdStr}:${readerId}`
    const previous = this._peerReadMarks.get(key) || 0
    if (mark <= previous) return false
    this._peerReadMarks.set(key, mark)
    const event = { chatId: chatIdStr, readerId, mark, source }
    for (const handler of this._readMarkHandlers) {
      try { handler(event) } catch {}
    }
    return true
  }

  _notePeerReadMarksFromChat(chat, source) {
    const chatId = chat?.id ?? chat?.chatId
    const participants = chat?.participants
    if (chatId == null || !participants || typeof participants !== 'object' || Array.isArray(participants)) return
    for (const [userId, mark] of Object.entries(participants)) {
      if (userId === '__complexEntries') continue
      this._notePeerReadMark(chatId, userId, mark, source)
    }
  }

  onReadMark(handler) {
    this._readMarkHandlers.push(handler)
  }

  /** The CRM did not take a forwarded mark: forget it, so the next snapshot forwards it again. */
  forgetPeerReadMark(chatId, readerId, mark) {
    const key = `${maxChatIdString(chatId)}:${maxChatIdString(readerId)}`
    if (this._peerReadMarks.get(key) === mark) this._peerReadMarks.delete(key)
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

  /**
   * Waits until the page has an authenticated socket that has stayed up for
   * `stableMs`, with the provider account proven and the page's own socket
   * OPEN. A send may only start after this answers ready: text typed into a
   * page without one (the second "6" of 2026-10-02 19:25:58) cleared the
   * compose box and never reached the wire.
   */
  async waitForSendReadySocket({ stableMs = 1200, timeoutMs = 20_000, pollMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const stable = await this.waitForStableWs(stableMs, Math.max(0, deadline - Date.now()))
      if (!stable) break
      if (!this.isAuthenticated()) return { ready: false, reason: 'provider_account_unproven' }
      let pageSocketOpen = true
      if (this._page) {
        pageSocketOpen = await this._page.evaluate(() => Boolean(window.__maxWs && window.__maxWs.readyState === 1))
          .catch(() => false)
      }
      if (pageSocketOpen && this._wsConnected) return { ready: true }
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
    return { ready: false, reason: 'socket_not_authenticated' }
  }

  /** Starts correlating the page's op:64 traffic for one send call. */
  beginTextSendObservation({ chatId, text } = {}) {
    const observation = new MaxTextSendObservation({ chatId, text })
    this._sendObservations.add(observation)
    return observation
  }

  endTextSendObservation(observation) {
    if (!observation) return
    observation.close()
    this._sendObservations.delete(observation)
  }

  /** The page acknowledged a received push: `{ chatId, rawChatId, messageId }`. */
  onBrowserMessageAck(handler) {
    this._browserAckHandlers.push(handler)
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
        return false
      }
      this._emittedMsgIds.set(dedupKey, now)
    }
    for (const h of this._messageHandlers) {
      try { h(msg) } catch (e) {
        console.error('[Transport] Handler error:', e.message)
      }
    }
    return true
  }
}

module.exports = {
  TransportInterceptor,
  OP,
  WS_INIT_SCRIPT,
  MaxTextSendObservation,
  OWN_REQUEST_SEQ_BASE,
  OWN_REQUEST_SEQ_SPAN,
  canonicalMaxMessageIdHex,
  decideMaxTextSendOutcome,
  decodeMaxBinaryFrame,
  encodeMaxBinaryFrame,
  evaluatePhoneResolutionUiSend,
  isUiTextSubmitObserved,
  lz4BlockCompress,
  lz4BlockDecompress,
  maxChatIdString,
  maxMessageIdTimeMs,
  maxMsgpackDecodeAll,
  maxMsgpackEncode,
  maxRealIdAsPlainNumber,
  maxRealIdFromProtocolId,
  runSingleMaxTextSend,
  sameMaxChatId,
  selectPendingLiveDomCandidates,
}
